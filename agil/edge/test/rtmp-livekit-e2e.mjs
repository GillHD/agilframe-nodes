/** Local Linux QA only. Starts temporary Redis, LiveKit and Ingress containers. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';
import { signLiveKitToken } from '../../core/apps/server/src/sfu.ts';
import { startTestServer } from '../../core/apps/server/test/helpers.ts';
import { runRtmpPublisher } from '../agent/rtmp-publisher.mjs';

assert.equal(process.platform, 'linux');
const exec = promisify(execFile);
const dockerEnv = { ...process.env };
delete dockerEnv.DOCKER_HOST;
delete dockerEnv.DOCKER_CONTEXT;
const docker = (args, env = {}) => exec('docker', ['--host', 'unix:///var/run/docker.sock', ...args],
  { env: { ...dockerEnv, ...env }, timeout: 45_000 });
const prefix = 'agil-edge-qa-' + randomBytes(5).toString('hex');
const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
const apiKey = prefix;
const apiSecret = randomBytes(32).toString('hex');
const nodeIp = Object.values(os.networkInterfaces()).flat().find((nic) => nic?.family === 'IPv4' && !nic.internal)?.address;
const loopback = '127.0.0.1';
const lf = `http://${loopback}:39542`;
const ingress = `rtmp://${loopback}:39545`;
const headers = { 'x-api-key': 'dev-key' };
const containers = [];
let browser;
let core;
let running;
const stop = new AbortController();

async function run(name, image, options, args = [], env = {}) {
  const fullName = `${prefix}-${name}`;
  await docker(['run', '-d', '--pull=never', '--network=host', '--name', fullName, ...options, image, ...args], env);
  containers.push(fullName);
}

async function up(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    await response?.body?.cancel();
    if (response?.ok) return;
    await delay(250);
  }
  assert.fail('Timed out waiting for a lab service');
}

try {
  assert.ok(nodeIp, 'The VM needs a private IPv4 for the SFU');
  const sfuConfig = path.join(root, 'sfu.yaml');
  await writeFile(sfuConfig, JSON.stringify({ port: 39542, bind_addresses: [loopback, nodeIp],
    rtc: { node_ip: nodeIp, tcp_port: 39543, udp_port: 39544, use_external_ip: false },
    redis: { address: `${loopback}:39541` }, keys: { [apiKey]: apiSecret }, ingress: { rtmp_base_url: `${ingress}/live` },
  }), { mode: 0o444 });
  await run('redis', 'redis:7-alpine', [], ['redis-server', '--bind', loopback, '--port', '39541', '--save', '', '--appendonly', 'no']);
  await run('livekit', 'livekit/livekit-server:v1.13.11', ['--mount', `type=bind,source=${sfuConfig},target=/etc/livekit.yaml,readonly`],
    ['--config', '/etc/livekit.yaml']);
  await up(lf);
  await run('ingress', 'livekit/ingress:v1.6.0', ['-e', 'INGRESS_CONFIG_BODY'], [], {
    INGRESS_CONFIG_BODY: JSON.stringify({ api_key: apiKey, api_secret: apiSecret, ws_url: lf.replace('http:', 'ws:'),
      redis: { address: `${loopback}:39541` }, health_port: 39546, rtmp_port: 39545, whip_port: -1, http_relay_port: 39547 }),
  });
  await up(`http://${loopback}:39546/availability`);
  console.log('PASS temporary Redis, LiveKit and Ingress are available');
  core = await startTestServer({ redisUrl: `redis://${loopback}:39541`, clusterId: prefix, clusterNodeId: prefix,
    flowStore: 'redis', sfuEnabled: true, sfuUrl: lf.replace('http:', 'ws:'), sfuControlUrl: lf,
    sfuApiKey: apiKey, sfuApiSecret: apiSecret, publicOrigin: '' });
  assert.equal((await core.api('PATCH', '/v1/tenants/demo/config', { headers, body: {
    scale: { mediaMode: 'sfu' }, session: { joinWithCamOff: true, joinWithMicOff: true, joinWithoutPreview: true },
    integrations: { allowedOrigins: [core.base] },
  } })).status, 200);
  const room = await core.api('POST', '/v1/admin/rooms', { headers, body: { name: 'Edge FFmpeg QA', roomMode: 'group' } });
  assert.equal(room.status, 200);
  const roomId = room.body.room.id;
  const viewer = await core.api('POST', '/v1/tokens', { headers, body: { tenantId: 'demo', roomId, participant: { name: 'Edge QA viewer', role: 'guest' } } });
  assert.equal(viewer.status, 200);

  const sample = path.join(root, 'source.mp4');
  await exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=green:s=320x180:r=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-threads', '1',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', sample], { timeout: 15000 });
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    args: ['--autoplay-policy=no-user-gesture-required', ...(process.env.AGIL_QA_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    window.edgeTestConnections = [];
    window.RTCPeerConnection = class extends window.RTCPeerConnection {
      constructor(...args) { super(...args); window.edgeTestConnections.push(this); }
    };
  });
  await page.goto(`${core.base}/robots.txt`);
  await page.evaluate(async ({ roomId, token }) => {
    const stage = document.createElement('main');
    document.body.replaceChildren(stage);
    const { mountWidget } = await import('/widget/agil-calls-widget.js');
    window.edgeTestCall = await mountWidget(stage, { serverUrl: location.origin, room: roomId, tenantId: 'demo', token });
    if (window.edgeTestCall.getState().phase !== 'joined') await window.edgeTestCall.join();
  }, { roomId, token: viewer.body.token });
  await page.waitForFunction(() => window.edgeTestCall.getState().settings.sfuStatus === 'connected', { timeout: 30000 });

  let ready;
  let flowId;
  const published = new Promise((resolve) => { ready = resolve; });
  running = runRtmpPublisher({ core: core.base, ingress, roomId, input: sample, apiKey: 'dev-key',
    ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH, signal: stop.signal,
    onState: (state) => { flowId = state.flowId; console.log(JSON.stringify(state)); if (state.state === 'ready') ready(); } });
  await Promise.race([published, running.then(() => assert.fail('Publisher exited before readiness'))]);
  await page.waitForFunction(async () => {
    const reports = await Promise.all(window.edgeTestConnections.map((peer) => peer.getStats()));
    const inbound = reports.flatMap((report) => [...report.values()]).filter((stats) => stats.type === 'inbound-rtp');
    return inbound.some((stats) => stats.kind === 'audio' && stats.totalAudioEnergy > 0) &&
      inbound.some((stats) => stats.kind === 'video' && stats.framesDecoded >= 8);
  }, { timeout: 30000 });
  console.log('PASS real Core Flow, FFmpeg, LiveKit Ingress and SFU delivered decoded audio and video to Chromium');
  stop.abort();
  await running;
  assert.equal((await core.api('GET', `/v1/admin/flows/${flowId}`, { headers })).status, 404);
  const now = Math.floor(Date.now() / 1000);
  const token = signLiveKitToken(apiSecret, { iss: apiKey, nbf: now - 5, exp: now + 30, video: { ingressAdmin: true } });
  const list = await fetch(`${lf}/twirp/livekit.Ingress/ListIngress`, { method: 'POST', body: JSON.stringify({ room_name: `demo__${roomId}` }),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).items ?? [], []);
  console.log('PASS stopping the publisher deleted its Core flow and revoked the LiveKit receiver');
} finally {
  stop.abort();
  await running?.catch(() => {});
  await browser?.close();
  await core?.close();
  for (const container of containers.reverse()) await docker(['rm', '-f', container]);
  await rm(root, { recursive: true, force: true });
}
