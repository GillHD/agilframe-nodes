import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac, randomBytes, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { connect as connectTls } from 'node:tls';
import { promisify } from 'node:util';

import {
  freePort,
  request,
  runAgent,
  startAgent,
  startFakeCore,
  waitFor,
} from './helpers.mjs';

const SECRET = 's'.repeat(32);
const TOKEN = 'agil_enr_agent_e2e_token_0123456789';

function oneShotEnv(fake, stateDir, overrides = {}) {
  return {
    AGIL_CORE_URL: fake.url,
    AGIL_NODE_TOKEN: TOKEN,
    NODE_ONCE: 'true',
    NODE_ID: 'agent-once',
    NODE_STATE_DIR: stateDir,
    NODE_FEATURES: 'sfu',
    NODE_MEDIA_ENABLED: 'false',
    NODE_MODULES: 'off',
    LIVEKIT_API_KEY: 'agil_sfu',
    LIVEKIT_API_SECRET: SECRET,
    NODE_LOG_LEVEL: 'info',
    ...overrides,
  };
}

test('one-shot: enrolls, heartbeats, persists the key and exits 0', async () => {
  const fake = await startFakeCore({ nodeId: 'agent-once' });
  const stateDir = await mkdtemp(path.join(tmpdir(), 'agil-node-once-'));
  try {
    const result = await runAgent(oneShotEnv(fake, stateDir));
    assert.equal(result.signal, null, `agent was killed: ${result.stderr}`);
    assert.equal(result.code, 0, `expected exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /node registered/);
    assert.match(result.stdout, /single heartbeat accepted/);
    assert.ok(!/Assertion failed|UV_HANDLE_CLOSING|0xC0000409/i.test(result.stderr), result.stderr);

    assert.ok(!result.stdout.includes(TOKEN), 'the enrollment token must not be logged');
    assert.ok(!result.stderr.includes(TOKEN), 'the enrollment token must not be logged');
    assert.ok(!result.stdout.includes(SECRET), 'the LiveKit secret must not be logged');

    const paths = fake.requests.map((entry) => `${entry.method} ${entry.url}`);
    assert.ok(paths.includes('POST /v1/nodes/register'), paths.join(', '));
    assert.ok(paths.includes('POST /v1/nodes/agent-once/heartbeat'), paths.join(', '));

    // The heartbeat carries a real local snapshot under `metrics`; fields that
    // cannot be measured on this host (or fake room counters) are absent.
    const heartbeat = fake.requests.find((entry) => entry.url.endsWith('/heartbeat'));
    assert.equal(heartbeat.body.sfuReady, false, 'one-shot agent does not run LiveKit');
    assert.equal(heartbeat.body.turnReady, undefined, 'a node without bundled TURN omits its readiness');
    assert.ok(heartbeat.body.metrics, 'heartbeat must carry node metrics');
    assert.equal(heartbeat.body.moduleAvailability, 'disabled');
    assert.ok(!('modules' in heartbeat.body));
    assert.equal(heartbeat.body.metrics.version, '0.1.0');
    assert.equal(typeof heartbeat.body.metrics.reportedAt, 'number');
    assert.equal(typeof heartbeat.body.metrics.uptimeSec, 'number');
    assert.ok(!('activeRooms' in heartbeat.body.metrics), 'room stats must not be faked');
    assert.ok(!('participants' in heartbeat.body.metrics));
    if (heartbeat.body.metrics.cpuPercent !== undefined) {
      assert.ok(heartbeat.body.metrics.cpuPercent >= 0 && heartbeat.body.metrics.cpuPercent <= 100);
    }

    const state = JSON.parse(await readFile(path.join(stateDir, 'node.json'), 'utf8'));
    assert.equal(state.nodeId, 'agent-once');
    assert.equal(state.nodeKey, fake.state.nodeKey);
    assert.equal(state.coreUrl, fake.url);
  } finally {
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('one-shot: rejected enrollment exits 1 with the Core error envelope', async () => {
  const fake = await startFakeCore({ rejectRegister: true });
  const stateDir = await mkdtemp(path.join(tmpdir(), 'agil-node-reject-'));
  try {
    const result = await runAgent(oneShotEnv(fake, stateDir));
    assert.equal(result.signal, null);
    assert.equal(result.code, 1, `expected exit 1\nstderr:\n${result.stderr}`);
    assert.ok(!/Assertion failed|UV_HANDLE_CLOSING/i.test(result.stderr), result.stderr);
    assert.ok(!result.stderr.includes('[object Object]'), result.stderr);
    assert.match(
      result.stderr,
      /enrollment rejected \(HTTP 401\): unauthorized: enrollment token rejected/,
      result.stderr,
    );
  } finally {
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('one-shot: an imported node key skips registration', async () => {
  const fake = await startFakeCore({
    nodeId: 'imported-node',
    nodeKey: 'nk_imported_key_0123456789',
  });
  const stateDir = await mkdtemp(path.join(tmpdir(), 'agil-node-import-'));
  try {
    await writeFile(
      path.join(stateDir, 'node.json'),
      `${JSON.stringify({
        nodeId: 'imported-node',
        nodeKey: fake.state.nodeKey,
        keyExpiresAt: null,
        registeredAt: new Date().toISOString(),
        coreUrl: fake.url,
      })}\n`,
      'utf8',
    );
    const result = await runAgent(oneShotEnv(fake, stateDir, {
      AGIL_NODE_TOKEN: '',
      NODE_ID: 'imported-node',
    }));
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!fake.requests.some((entry) => entry.url === '/v1/nodes/register'), 'state key must skip enrollment');
    assert.ok(fake.requests.some((entry) => entry.url === '/v1/nodes/imported-node/heartbeat'));
  } finally {
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('long-running: core drain makes /readyz 503 while the node keeps running', async () => {
  const port = await freePort();
  const fake = await startFakeCore({ nodeId: 'agent-drain', drain: true, heartbeatIntervalSec: 5 });
  const stateDir = await mkdtemp(path.join(tmpdir(), 'agil-node-run-'));
  const agent = await startAgent({
    AGIL_CORE_URL: fake.url,
    AGIL_NODE_TOKEN: TOKEN,
    NODE_ID: 'agent-drain',
    NODE_STATE_DIR: stateDir,
    NODE_FEATURES: 'sfu',
    NODE_MEDIA_ENABLED: 'false',
    NODE_MODULES: 'off',
    NODE_HTTP_HOST: '127.0.0.1',
    NODE_HTTP_PORT: String(port),
    NODE_HEARTBEAT_SEC: '5',
    NODE_CONTROL_TOKEN: 'control-token-123',
    LIVEKIT_API_KEY: 'agil_sfu',
    LIVEKIT_API_SECRET: SECRET,
    NODE_LOG_LEVEL: 'info',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await request(`${base}/healthz`)).status === 200, {
      label: 'healthz',
      timeoutMs: 15_000,
    });
    const ready = await waitFor(async () => {
      const response = await request(`${base}/readyz`);
      return response.status === 503 && response.json?.reason === 'draining' ? response : null;
    }, { label: 'readyz draining', timeoutMs: 15_000 });
    assert.equal(ready.json.ok, false);
    assert.equal(ready.json.coreDrain, true);
    assert.equal(ready.json.localDrain, false);

    const metrics = await request(`${base}/metrics`);
    assert.match(metrics.text, /^agil_node_draining 1$/m);
    assert.match(metrics.text, /^agil_node_ready 0$/m);
  } finally {
    agent.kill();
    await agent.exit.catch(() => {});
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('long-running: local drain control endpoint takes the node out of readiness', async () => {
  const port = await freePort();
  const fake = await startFakeCore({ nodeId: 'agent-local-drain', drain: false, heartbeatIntervalSec: 5 });
  const stateDir = await mkdtemp(path.join(tmpdir(), 'agil-node-local-drain-'));
  const agent = await startAgent({
    AGIL_CORE_URL: fake.url,
    AGIL_NODE_TOKEN: TOKEN,
    NODE_ID: 'agent-local-drain',
    NODE_STATE_DIR: stateDir,
    NODE_FEATURES: 'sfu',
    NODE_MEDIA_ENABLED: 'false',
    NODE_MODULES: 'off',
    NODE_HTTP_HOST: '127.0.0.1',
    NODE_HTTP_PORT: String(port),
    NODE_HEARTBEAT_SEC: '5',
    NODE_CONTROL_TOKEN: 'control-token-123',
    LIVEKIT_API_KEY: 'agil_sfu',
    LIVEKIT_API_SECRET: SECRET,
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await request(`${base}/readyz`)).status === 200, {
      label: 'readyz ok',
      timeoutMs: 15_000,
    });
    const drain = await request(`${base}/v1/control/drain`, {
      method: 'POST',
      headers: { 'x-control-token': 'control-token-123' },
      body: { drain: true },
    });
    assert.equal(drain.status, 200);
    assert.equal(drain.json.drain.local, true);
    const ready = await request(`${base}/readyz`);
    assert.equal(ready.status, 503);
    assert.equal(ready.json.reason, 'draining');
  } finally {
    agent.kill();
    await agent.exit.catch(() => {});
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('long-running: AGIL_NODE_HTTP_PORT alias moves the health listener', async () => {
  const port = await freePort();
  const fake = await startFakeCore({ nodeId: 'agent-alias-port', drain: false, heartbeatIntervalSec: 5 });
  const stateDir = await mkdtemp(path.join(tmpdir(), 'agil-node-alias-port-'));
  const agent = await startAgent({
    AGIL_CORE_URL: fake.url,
    AGIL_NODE_TOKEN: TOKEN,
    NODE_ID: 'agent-alias-port',
    NODE_STATE_DIR: stateDir,
    NODE_FEATURES: 'sfu',
    NODE_MEDIA_ENABLED: 'false',
    NODE_MODULES: 'off',
    NODE_HTTP_HOST: '127.0.0.1',
    // Alias only: the agent must listen on it (and the container healthcheck
    // resolves the same precedence, see artifacts.test.mjs).
    AGIL_NODE_HTTP_PORT: String(port),
    NODE_HEARTBEAT_SEC: '5',
    LIVEKIT_API_KEY: 'agil_sfu',
    LIVEKIT_API_SECRET: SECRET,
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await request(`${base}/readyz`)).status === 200, {
      label: 'readyz on the aliased port',
      timeoutMs: 15_000,
    });
    const health = await request(`${base}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    agent.kill();
    await agent.exit.catch(() => {});
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('bundled coturn reports readiness without Docker management', {
  skip: !process.env.AGIL_QA_TURNSERVER,
}, async () => {
  const { main } = await import('../agent/index.mjs');
  const { detectHostIpv4 } = await import('../agent/config.mjs');
  const turnClient = process.env.AGIL_QA_TURNCLIENT;
  const cert = process.env.AGIL_QA_TURN_TLS_CERT;
  const privateKey = process.env.AGIL_QA_TURN_TLS_KEY;
  const tlsHostname = process.env.AGIL_QA_TURN_TLS_HOSTNAME;
  assert.equal(Boolean(cert), Boolean(privateKey), 'Set both TLS fixture paths');
  const relayIp = turnClient ? detectHostIpv4() : '192.168.40.2';
  assert.ok(relayIp, 'TURN client test requires a non-loopback network interface');
  const port = await freePort();
  let turnPort;
  do { turnPort = await freePort(); } while (turnPort === port);
  let tlsPort;
  if (cert) {
    do { tlsPort = await freePort(); } while (tlsPort === port || tlsPort === turnPort);
  }
  const fake = await startFakeCore({ nodeId: 'agent-turn-probe', heartbeatIntervalSec: 5 });
  const stateDir = await mkdtemp(path.join(tmpdir(), 'agil-node-turn-probe-'));
  const turnLog = path.join(stateDir, 'coturn.log');
  let turnServer = process.env.AGIL_QA_TURNSERVER;
  let handle;
  const startWithSecret = (secret) => main({
    installSignalHandlers: false,
    env: {
      AGIL_CORE_URL: fake.url, AGIL_NODE_TOKEN: TOKEN,
      NODE_ID: 'agent-turn-probe', NODE_STATE_DIR: stateDir, NODE_FEATURES: 'turn',
      NODE_RUNTIME_DIR: path.join(stateDir, 'runtime'),
      NODE_MODULES: 'off', NODE_HTTP_HOST: '127.0.0.1', NODE_HTTP_PORT: String(port),
      TURN_ALLOW_PRIVATE_IP: '1', TURN_EXTERNAL_IP: relayIp, TURN_LISTEN_IP: turnClient ? relayIp : '127.0.0.1',
      TURN_PORT: String(turnPort), TURN_STATIC_AUTH_SECRET: secret, TURN_AUTO_REGISTER: '1', NODE_TURN_BIN: turnServer,
      ...(tlsPort ? { TURN_TLS: '1', TURN_TLS_PORT: String(tlsPort), TURN_CERT: cert, TURN_PKEY: privateKey } : {}),
      ...(tlsHostname ? { TURN_TLS_HOSTNAME: tlsHostname } : {}),
      NODE_LOG_LEVEL: 'error',
    },
  });
  try {
    if (turnClient && process.platform !== 'win32') {
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      const wrapper = path.join(stateDir, 'turnserver-qa.sh');
      await writeFile(wrapper, `#!/bin/sh\nexec ${quote(turnServer)} "$@" >> ${quote(turnLog)} 2>&1\n`, { mode: 0o700 });
      turnServer = wrapper;
    }
    handle = await startWithSecret(SECRET);
    const online = await waitFor(() => fake.requests.find((entry) =>
      entry.url.endsWith('/heartbeat') && entry.body.turnReady === true), { label: 'ready coturn heartbeat' });
    assert.equal(online.body.status, 'online');
    assert.equal(online.body.moduleAvailability, 'disabled');
    assert.deepEqual(online.body.turnEndpoint, {
      ip: relayIp, port: turnPort, credentialMode: 'rest', ...(tlsPort ? { tlsPort } : {}),
      ...(tlsHostname ? { tlsHostname } : {}),
    });
    const { ip, port: relayPort, tlsHostname: reportedName } = online.body.turnEndpoint;
    assert.equal(online.body.turnEndpointProof, createHmac('sha256', SECRET).update(JSON.stringify([
      'agil-turn-auto-v1', 'agent-turn-probe', fake.state.nodeKey, ip, relayPort, tlsPort, reportedName,
    ])).digest('hex'));
    await waitFor(async () => (await request(`http://127.0.0.1:${port}/readyz`)).status === 200, { label: 'bundled coturn readyz' });
    assert.equal(online.body.modules, undefined);
    assert.equal(online.body.sfuReady, undefined);
    assert.ok(!JSON.stringify(online.body).includes(SECRET));
    if (tlsPort) {
      const ca = await readFile(cert);
      const hostname = new X509Certificate(ca).subject.split('\n').find((value) => value.startsWith('CN='))?.slice(3);
      assert.ok(hostname, 'The test certificate must include a common name');
      const socket = connectTls({ host: relayIp, port: tlsPort, servername: hostname, ca });
      try {
        await Promise.race([
          new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Trusted TURN/TLS handshake timed out')), 3000).unref()),
        ]);
        assert.equal(socket.authorized, true);
      } finally {
        socket.destroy();
      }
    }
    if (turnClient) {
      const username = `${Math.floor(Date.now() / 1000) + 120}:node-qa`;
      const run = promisify(execFile);
      const allocate = (secret, args, timeout = 15000) => {
        const password = createHmac('sha1', secret).update(username).digest('base64');
        return run(turnClient, [...args, '-y', '-c', '-n', '2', '-m', '2', '-z', '200',
          '-u', username, '-w', password, '-p', String(turnPort), relayIp], { timeout });
      };
      const transports = [{ name: 'TURN/UDP', args: [] }, { name: 'TURN/TCP', args: ['-t'] }];
      for (const transport of transports) {
        const { stdout } = await allocate(SECRET, transport.args).catch(() => { throw new Error(`${transport.name} allocation failed`); });
        assert.ok(/tot_send_msgs=4, tot_recv_msgs=4\b/.test(stdout), transport.name);
      }
      const nextSecret = randomBytes(32).toString('hex');
      await handle.shutdown('TEST');
      handle = undefined;
      const offset = fake.requests.length;
      handle = await startWithSecret(nextSecret);
      const rotated = await waitFor(() => fake.requests.slice(offset).find((entry) =>
        entry.url.endsWith('/heartbeat') && entry.body.turnReady === true),
      { timeoutMs: 30_000, label: 'coturn with rotated secret' });
      assert.equal(rotated.body.turnEndpointProof, createHmac('sha256', nextSecret).update(JSON.stringify([
        'agil-turn-auto-v1', 'agent-turn-probe', fake.state.nodeKey, ip, relayPort, tlsPort, reportedName,
      ])).digest('hex'));
      const beforeRevocation = await readFile(turnLog, 'utf8').catch(() => '');
      const revoked = await allocate(SECRET, [], 5000).catch((error) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
      const authLog = (await readFile(turnLog, 'utf8').catch(() => '')).slice(beforeRevocation.length);
      assert.ok(authLog.includes(`Cannot find credentials of user <${username}>`) ||
        /401|unauthorized/i.test(`${revoked.stdout}\n${revoked.stderr}`), 'the rotated relay rejects old signed credentials');
      assert.ok(!/tot_recv_msgs=[1-9]/.test(revoked.stdout), 'old credentials did not relay media');
      const accepted = await allocate(nextSecret, []).catch(() => { throw new Error('Allocation with the new TURN secret failed'); });
      assert.ok(/tot_send_msgs=4, tot_recv_msgs=4\b/.test(accepted.stdout), 'new credentials relay all test datagrams');
      assert.ok(!JSON.stringify(rotated.body).includes(nextSecret));
      assert.equal(fake.requests.filter(({ url }) => url === '/v1/nodes/register').length, 1);
    }
    await handle.shutdown('TEST');
    handle = undefined;
    const offline = fake.requests.filter((entry) => entry.url.endsWith('/heartbeat')).at(-1);
    assert.equal(offline?.body.status, 'offline');
    assert.equal(offline?.body.turnEndpoint, undefined);
  } finally {
    await handle?.shutdown('TEST');
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('image media process selection matches node features', {
  skip: process.platform !== 'linux' || !process.env.AGIL_QA_LIVEKIT_BIN || !process.env.AGIL_QA_TURNSERVER,
}, async (t) => {
  const { main } = await import('../agent/index.mjs');
  const { detectHostIpv4 } = await import('../agent/config.mjs');
  const mediaIp = detectHostIpv4();
  assert.ok(mediaIp, 'The image test requires a private Docker network interface');
  for (const features of [['sfu'], ['turn'], ['sfu', 'turn']]) {
    await t.test(features.join('+'), async () => {
      const nodeId = `qa-image-${features.join('-')}`;
      const port = await freePort();
      const stateDir = await mkdtemp(path.join(tmpdir(), `${nodeId}-`));
      const fake = await startFakeCore({ nodeId, heartbeatIntervalSec: 5 });
      let handle;
      try {
        handle = await main({ installSignalHandlers: false, env: {
          AGIL_CORE_URL: fake.url, AGIL_NODE_TOKEN: TOKEN, NODE_ID: nodeId, NODE_FEATURES: features.join(','),
          NODE_STATE_DIR: stateDir, NODE_RUNTIME_DIR: path.join(stateDir, 'run'), NODE_MODULES: 'off',
          NODE_HTTP_HOST: '127.0.0.1', NODE_HTTP_PORT: String(port), NODE_LOG_LEVEL: 'error',
          NODE_ALLOW_PRIVATE_IP: '1', SFU_NODE_IP: mediaIp, SFU_USE_EXTERNAL_IP: '0', SFU_LOG_LEVEL: 'error',
          LIVEKIT_API_KEY: 'agil_image_qa', LIVEKIT_API_SECRET: SECRET, NODE_LIVEKIT_BIN: process.env.AGIL_QA_LIVEKIT_BIN,
          TURN_EXTERNAL_IP: mediaIp, TURN_LISTEN_IP: mediaIp, TURN_STATIC_AUTH_SECRET: SECRET,
          NODE_TURN_BIN: process.env.AGIL_QA_TURNSERVER,
        } });
        const heartbeat = await waitFor(() => fake.requests.find((entry) => entry.url.endsWith('/heartbeat') &&
          entry.body.sfuReady === (features.includes('sfu') ? true : undefined) &&
          entry.body.turnReady === (features.includes('turn') ? true : undefined)), { label: `${nodeId} readiness heartbeat` });
        assert.equal(heartbeat.body.status, 'online');
        const base = `http://127.0.0.1:${port}`;
        await waitFor(async () => (await request(`${base}/readyz`)).status === 200, { label: `${nodeId} readyz` });
        const { json } = await request(`${base}/healthz`);
        assert.deepEqual(json.media.map(({ kind }) => kind), features);
        for (const media of json.media) {
          assert.equal(media.running && media.ready, true);
          const binary = media.kind === 'sfu' ? 'livekit-server' : 'turnserver';
          assert.equal(path.basename(await readlink(`/proc/${media.pid}/exe`)), binary);
        }
        await handle.shutdown('TEST');
        handle = undefined;
        assert.equal(fake.requests.filter((entry) => entry.url.endsWith('/heartbeat')).at(-1)?.body.status, 'offline');
      } finally {
        await handle?.shutdown('TEST');
        await fake.close();
        await rm(stateDir, { recursive: true, force: true });
      }
    });
  }
});

test('external LiveKit controls heartbeat readiness without a bundled process', async () => {
  const { main } = await import('../agent/index.mjs');
  const nodeId = 'qa-external-sfu';
  const fake = await startFakeCore({ nodeId, heartbeatIntervalSec: 5 });
  const stateDir = await mkdtemp(path.join(tmpdir(), 'agil-node-external-'));
  const probes = [];
  let responseStatus = 307;
  const livekit = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    probes.push({ path: req.url, method: req.method, authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(body).toString() || '{}') });
    if (responseStatus === 307) res.setHeader('location', '/redirect-target');
    res.writeHead(responseStatus, { 'content-type': 'application/json' });
    res.end(responseStatus === 200 ? '{"rooms":[]}' : '{}');
  });
  livekit.listen(0, '127.0.0.1');
  await once(livekit, 'listening');
  const externalOrigin = `http://127.0.0.1:${livekit.address().port}`;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let handle;
  const latest = () => fake.requests.filter(({ url }) => url.endsWith('/heartbeat')).at(-1)?.body;
  try {
    handle = await main({ installSignalHandlers: false, env: oneShotEnv(fake, stateDir, {
      NODE_ONCE: 'false',
      NODE_ID: nodeId,
      NODE_HTTP_HOST: '127.0.0.1',
      NODE_HTTP_PORT: String(port),
      NODE_LOG_LEVEL: 'error',
      SFU_EXTERNAL_URL: externalOrigin,
    }) });
    assert.equal(latest().sfuReady, false);
    assert.deepEqual(probes.map(({ path }) => path), ['/twirp/livekit.RoomService/ListRooms']);
    assert.equal((await request(`${base}/readyz`)).json.reason, 'media_down');

    responseStatus = 200;
    await waitFor(() => latest()?.sfuReady, { label: 'external LiveKit ready', timeoutMs: 15_000 });
    const ready = await request(`${base}/readyz`);
    assert.equal(ready.status, 200);
    const healthy = await request(`${base}/healthz`);
    assert.deepEqual(healthy.json.media, [
      { name: 'livekit-external', kind: 'sfu', managed: false, running: true, ready: true },
    ]);
    assert.doesNotMatch(healthy.text, new RegExp(externalOrigin));
    const metrics = await request(`${base}/metrics`);
    assert.match(metrics.text, /^agil_node_media_ready\{process="livekit-external",kind="sfu"\} 1$/m);
    assert.doesNotMatch(metrics.text, /^agil_node_media_restarts_total\{process="livekit-external"/m);

    const probe = probes.at(-1);
    assert.equal(probe.method, 'POST');
    assert.match(probe.body.names[0], /^agil-probe-[a-f0-9]{24}$/);
    assert.equal(probe.body.names.length, 1);
    const [header, payload, signature] = probe.authorization.slice('Bearer '.length).split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(signature, createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url'));
    assert.equal(claims.iss, 'agil_sfu');
    assert.deepEqual(claims.video, { roomList: true });
    assert.equal(claims.exp - claims.nbf, 20);

    responseStatus = 503;
    await waitFor(() => latest()?.sfuReady === false, { label: 'external LiveKit degraded', timeoutMs: 15_000 });
    assert.equal(latest().status, 'online');
    assert.equal((await request(`${base}/healthz`)).status, 200);
    assert.deepEqual((await request(`${base}/readyz`)).json.mediaDown, ['livekit-external']);

    responseStatus = 200;
    await waitFor(() => latest()?.sfuReady, { label: 'external LiveKit recovery', timeoutMs: 15_000 });
    assert.equal((await request(`${base}/readyz`)).status, 200);
    await handle.shutdown('TEST');
    handle = undefined;
    assert.equal(latest().status, 'offline');
    assert.equal((await request(`${externalOrigin}/`, { method: 'POST' })).status, 200, 'the agent does not stop LiveKit');
  } finally {
    await handle?.shutdown('TEST');
    await new Promise((resolve) => livekit.close(resolve));
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('in-process main(): graceful shutdown reports offline and closes the health server', async () => {
  const { main } = await import('../agent/index.mjs');
  const port = await freePort();
  const fake = await startFakeCore({ nodeId: 'agent-inproc', drain: false, heartbeatIntervalSec: 30 });
  const stateDir = await mkdtemp(path.join(tmpdir(), 'agil-node-inproc-'));
  try {
    const handle = await main({
      installSignalHandlers: false,
      env: {
        AGIL_CORE_URL: fake.url,
        AGIL_NODE_TOKEN: TOKEN,
        NODE_ID: 'agent-inproc',
        NODE_STATE_DIR: stateDir,
        NODE_FEATURES: 'sfu',
        NODE_MEDIA_ENABLED: 'false',
        NODE_MODULES: 'off',
        NODE_HTTP_HOST: '127.0.0.1',
        NODE_HTTP_PORT: String(port),
        LIVEKIT_API_KEY: 'agil_sfu',
        LIVEKIT_API_SECRET: SECRET,
        NODE_LOG_LEVEL: 'error',
      },
    });
    assert.equal(typeof handle.shutdown, 'function');
    await waitFor(async () => (await request(`http://127.0.0.1:${port}/readyz`)).status === 200, {
      label: 'readyz ok',
      timeoutMs: 15_000,
    });

    const result = await handle.shutdown('TEST');
    assert.equal(result.exitCode, 0);
    const heartbeats = fake.requests.filter((entry) => entry.url.endsWith('/heartbeat'));
    assert.equal(heartbeats[0].body.status, 'online');
    assert.equal(heartbeats.at(-1).body.status, 'offline');

    // The health server is closed: a new connection is refused.
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
  } finally {
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('graceful shutdown reports offline to Core', { skip: process.platform === 'win32' ? 'POSIX signals are not delivered on Windows' : false }, async () => {
  const port = await freePort();
  const fake = await startFakeCore({ nodeId: 'agent-offline', drain: false, heartbeatIntervalSec: 30 });
  const stateDir = await mkdtemp(path.join(tmpdir(), 'agil-node-offline-'));
  const agent = await startAgent({
    AGIL_CORE_URL: fake.url,
    AGIL_NODE_TOKEN: TOKEN,
    NODE_ID: 'agent-offline',
    NODE_STATE_DIR: stateDir,
    NODE_FEATURES: 'sfu',
    NODE_MEDIA_ENABLED: 'false',
    NODE_MODULES: 'off',
    NODE_HTTP_HOST: '127.0.0.1',
    NODE_HTTP_PORT: String(port),
    LIVEKIT_API_KEY: 'agil_sfu',
    LIVEKIT_API_SECRET: SECRET,
    NODE_LOG_LEVEL: 'info',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await request(`${base}/readyz`)).status === 200, {
      label: 'readyz ok',
      timeoutMs: 15_000,
    });
    const stopped = await agent.stop();
    assert.equal(stopped.code, 0, `stdout:\n${stopped.stdout}\nstderr:\n${stopped.stderr}`);
    assert.match(stopped.stdout, /offline heartbeat sent/);
    const heartbeats = fake.requests.filter((entry) => entry.url.endsWith('/heartbeat'));
    assert.ok(heartbeats.length >= 2, 'expected an online and an offline heartbeat');
    assert.equal(heartbeats[0].body.status, 'online');
    assert.equal(heartbeats.at(-1).body.status, 'offline');
    assert.ok(!/Assertion failed|UV_HANDLE_CLOSING/i.test(stopped.stderr), stopped.stderr);
  } finally {
    if (agent.child.exitCode === null) {
      agent.kill();
      await agent.exit.catch(() => {});
    }
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
