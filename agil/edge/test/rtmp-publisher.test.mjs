import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect as tcpConnect, createServer as reserve } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createServer as tlsServer } from 'node:tls';
import { promisify } from 'node:util';
import { runRtmpPublisher } from '../agent/rtmp-publisher.mjs';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const exec = promisify(execFile);
const loopback = '127.0.0.1';
const roomId = 'edge-qa-room';
const apiKey = randomBytes(18).toString('hex');
const streamKey = randomBytes(18).toString('hex');

async function listen(server) {
  server.listen(0, loopback);
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const socket = reserve();
  const port = await listen(socket);
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function fixture(t, videoOnly = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agil-edge-publisher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'source clip.mp4');
  await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=12',
    ...(!videoOnly ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []),
    '-t', '2', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p',
    ...(!videoOnly ? ['-c:a', 'aac'] : []), input], { timeout: 12000, windowsHide: true });
  return { directory, input };
}

async function fakeCore(t, ingress, options = {}) {
  const requests = [];
  let id;
  const server = createServer(async (request, response) => {
    const { method, url } = request;
    const parts = [];
    for await (const part of request) parts.push(part);
    const raw = Buffer.concat(parts).toString();
    requests.push({ method, url, body: raw ? JSON.parse(raw) : undefined, authorized: request.headers['x-api-key'] === apiKey });
    if (method === 'POST' && url === '/v1/admin/flows') id = JSON.parse(raw).id;
    let reply = {};
    if (method === 'POST' && url.endsWith('/rtmp-ingress')) reply = { url: options.issued ?? `${ingress}/live`, streamKey };
    if (method === 'GET' && url.endsWith('/rtmp-ingress')) reply = { roomId, status: await options.status?.() ?? 'waiting' };
    const status = method === 'DELETE' ? options.revokeStatuses?.shift() ?? 200 : 200;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { core: `http://${loopback}:${port}`, get id() { return id; }, requests };
}

async function eventually(condition, timeout = 12000) {
  const deadline = Date.now() + timeout;
  do {
    if (await condition()) return;
    await delay(125);
  } while (Date.now() < deadline);
  assert.fail('Timed out waiting for component readiness');
}

async function startMediaMtx(t, directory) {
  const [controlPort, rtmpPort] = await Promise.all([freePort(), freePort()]);
  const ingress = `rtmp://${loopback}:${rtmpPort}`;
  const config = path.join(directory, 'mediamtx.yml');
  await writeFile(config, [
    'logLevel: warn', 'api: yes', `apiAddress: ${loopback}:${controlPort}`, 'rtsp: no', 'hls: no', 'webrtc: no', 'srt: no', 'moq: no',
    'rtmp: yes', `rtmpAddress: ${loopback}:${rtmpPort}`, 'paths:', '  all_others:', '    source: publisher', '',
  ].join('\n'));
  const server = spawn(process.env.AGIL_QA_MEDIAMTX_BIN, [config], { windowsHide: true, stdio: 'ignore' });
  server.on('error', () => {});
  const closed = new Promise((resolve) => server.once('close', resolve));
  t.after(async () => { server.kill(); await closed; });
  const controller = `http://${loopback}:${controlPort}/v3/paths`;
  await eventually(() => fetch(`${controller}/list`).then((reply) => reply.ok).catch(() => false));
  async function ready() {
    const response = await fetch(`${controller}/get/live/${streamKey}`);
    return response.ok && (await response.json()).ready;
  }
  return { ingress, ready };
}

/** Build a fresh self-signed QA certificate without touching the OS trust store. */
function testCertificate(validName) {
  function der(tag, ...fields) {
    const bytes = Buffer.concat(fields);
    const size = bytes.length;
    const length = size <= 127 ? [size] : size <= 255 ? [0x81, size] : [0x82, size >> 8, size & 255];
    return Buffer.concat([Buffer.from([tag, ...length]), bytes]);
  }
  const hex = (value) => Buffer.from(value, 'hex');
  const seq = (...fields) => der(0x30, ...fields);
  const text = (tag, value) => der(tag, Buffer.from(value));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const algorithm = seq(hex('06082a8648ce3d040302')); // ecdsa-with-SHA256
  const name = seq(der(0x31, seq(hex('0603550403'), text(0x0c, 'AGIL Edge QA'))));
  const time = (offsetDays) => text(0x17, new Date(Date.now() + offsetDays * 86_400_000)
    .toISOString().slice(2, 19).replace(/\D/g, '') + 'Z');
  const alternativeName = validName ? der(0x87, Buffer.from([127, 0, 0, 1])) : text(0x82, 'wrong.example');
  const extensions = der(0xa3, seq(
    seq(hex('0603551d13'), hex('0101ff'), der(0x04, hex('30030101ff'))), // BasicConstraints CA
    seq(hex('0603551d11'), der(0x04, seq(alternativeName))), // Subject Alternative Name
  ));
  const unsigned = seq(hex('a003020102'), der(0x02, Buffer.from([1]), randomBytes(8)), algorithm,
    name, seq(time(-1), time(1)), name, publicKey.export({ type: 'spki', format: 'der' }), extensions);
  const certificate = seq(unsigned, algorithm, der(0x03, Buffer.from([0]), sign('sha256', unsigned, privateKey)));
  const base64 = certificate.toString('base64').match(/.{1,64}/g).join('\n');
  return { cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

test('an incompatible input is rejected before Core receives a credential', async (t) => {
  const { input } = await fixture(t, true);
  const ingress = 'rtmp://127.0.0.1:1935';
  const core = await fakeCore(t, ingress);
  await assert.rejects(runRtmpPublisher({ core: core.core, ingress, roomId, input, apiKey, ffprobe }), /one H.264/);
  assert.deepEqual(core.requests, []);
});

test('reject an unexpected Ingress origin and remove only the owned flow', async (t) => {
  const { input } = await fixture(t);
  const ingress = 'rtmp://127.0.0.1:1935';
  const core = await fakeCore(t, ingress, { issued: 'rtmp://127.0.0.1:1936/live', revokeStatuses: [409, 503, 404] });
  const events = [];
  await assert.rejects(runRtmpPublisher({ core: core.core, ingress, roomId, input, apiKey, ffprobe,
    onState: (value) => events.push(value) }), /different Ingress origin/);
  assert.deepEqual(core.requests.map(({ method, url }) => [method, url]), [
    ['POST', '/v1/admin/flows'], ['POST', `/v1/admin/flows/${core.id}/rtmp-ingress`],
    ...Array.from({ length: 3 }, () => ['DELETE', `/v1/admin/flows/${core.id}`]),
  ]);
  assert.deepEqual(events.map(({ state }) => state), ['creating', 'failed']);
  assert.ok(!JSON.stringify(events).includes(streamKey));
});

test('real FFmpeg media publication reaches readiness and is released on stop', {
  skip: !process.env.AGIL_QA_MEDIAMTX_BIN && 'Set AGIL_QA_MEDIAMTX_BIN to run media QA',
}, async (t) => {
  const { directory, input } = await fixture(t);
  const { ingress, ready } = await startMediaMtx(t, directory);
  const core = await fakeCore(t, ingress, { status: async () => (await ready()) ? 'publishing' : 'waiting' });
  const abort = new AbortController();
  const events = [];
  const outcome = runRtmpPublisher({ core: core.core, ingress, roomId, input, apiKey, ffmpeg, ffprobe,
    signal: abort.signal, pollIntervalMs: 150, onState: ({ state }) => events.push(state) });
  let failure;
  outcome.catch((error) => { failure = error; });
  try {
    await eventually(() => { if (failure) throw failure; return events.includes('ready'); });
    const { stdout } = await exec(ffprobe, ['-v', 'error', '-rw_timeout', '5000000', '-analyzeduration', '1000000',
      '-show_entries', 'stream=codec_name', '-of', 'json', `${ingress}/live/${streamKey}`], { timeout: 10000, windowsHide: true });
    assert.deepEqual(JSON.parse(stdout).streams.map(({ codec_name }) => codec_name).sort(), ['aac', 'h264']);
  } finally {
    abort.abort();
    await outcome;
  }
  await eventually(async () => !await ready());
  assert.deepEqual(events, ['creating', 'connecting', 'ready', 'stopped']);
  assert.ok(core.requests.every(({ authorized }) => authorized));
  const create = core.requests[0].body;
  assert.deepEqual(create.sources, [{ kind: 'rtmp_ingest', mode: 'push', roomId }]);
  assert.deepEqual(create.sinks, [{ kind: 'room', roomId }]);
  assert.equal(core.requests.filter(({ method }) => method === 'POST').length, 2);
  assert.deepEqual(core.requests.filter(({ method }) => method === 'DELETE').map(({ url }) => url), [`/v1/admin/flows/${create.id}`]);
});

for (const validName of [true, false]) {
  test(`RTMPS ${validName ? 'forwards media with the matching' : 'rejects a trusted certificate with another'} endpoint name`, {
    skip: !process.env.AGIL_QA_MEDIAMTX_BIN && 'Set MediaMTX for TLS media QA',
  }, async (t) => {
    const { directory, input } = await fixture(t);
    const cert = path.join(directory, 'server.pem');
    const tlsIdentity = testCertificate(validName);
    await writeFile(cert, tlsIdentity.cert);
    const media = await startMediaMtx(t, directory);
    const bridge = tlsServer(tlsIdentity, (source) => {
      const backend = tcpConnect({ host: loopback, port: Number(new URL(media.ingress).port) });
      const close = () => { source.destroy(); backend.destroy(); };
      source.on('error', close).once('close', close);
      backend.on('error', close).once('close', close);
      source.pipe(backend).pipe(source);
    });
    const ingress = `rtmps://${loopback}:${await listen(bridge)}`;
    t.after(() => new Promise((resolve) => bridge.close(resolve)));
    const { ready } = media;
    const core = await fakeCore(t, ingress, { status: async () => (await ready()) ? 'publishing' : 'waiting' });
    const config = { core: core.core, ingress, roomId, input, apiKey, ffmpeg, ffprobe };
    const snippet = `import { runRtmpPublisher } from ${JSON.stringify(new URL('../agent/rtmp-publisher.mjs', import.meta.url).href)};
      const abort = new AbortController();
      try {
        await runRtmpPublisher({ ...JSON.parse(process.env.AGIL_EDGE_TLS_QA), signal: abort.signal, pollIntervalMs: 150,
          startupTimeoutMs: 8000, onState({ state }) { console.log(state); if (state === 'ready') abort.abort(); } });
      } catch (error) { console.log(error.message); process.exitCode = 1; }`;
    const result = await exec(process.execPath, ['--input-type=module', '-e', snippet], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: cert, AGIL_EDGE_TLS_QA: JSON.stringify(config) },
      timeout: 20000, windowsHide: true,
    }).catch((error) => error);
    if (validName) {
      assert.equal(result.code, undefined, result.stdout);
      assert.match(result.stdout, /\bready\b/);
    } else {
      assert.equal(result.code, 1, result.stdout);
      assert.doesNotMatch(result.stdout, /\bready\b/);
    }
    assert.deepEqual(core.requests.filter(({ method }) => method === 'DELETE').map(({ url }) => url), [`/v1/admin/flows/${core.id}`]);
    assert.ok(!result.stdout.includes(streamKey) && !result.stdout.includes(apiKey));
  });
}
