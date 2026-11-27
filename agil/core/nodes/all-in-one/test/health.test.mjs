import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../agent/config.mjs';
import {
  controlAuthorized,
  evaluateReadiness,
  isLoopbackAddress,
  renderMetrics,
  startHealthServer,
} from '../agent/health.mjs';
import { freePort, request } from './helpers.mjs';

const SECRET = 's'.repeat(32);
const NOW = 1_800_000_000_000;

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function makeConfig(overrides = {}) {
  return loadConfig({
    NODE_FEATURES: 'sfu',
    NODE_ID: 'health-node',
    LIVEKIT_API_KEY: 'agil_sfu',
    LIVEKIT_API_SECRET: SECRET,
    ...overrides,
  });
}

function makeRuntime(overrides = {}) {
  return {
    startedAt: NOW - 60_000,
    nodeId: 'health-node',
    registered: true,
    lastHeartbeatAt: NOW - 1_000,
    lastHeartbeatErrorAt: 0,
    lastHeartbeatError: '',
    heartbeats: 1,
    failures: 0,
    coreDrain: false,
    localDrain: false,
    shuttingDown: false,
    rotating: false,
    lastRotationAt: 0,
    keyExpiresAt: null,
    heartbeatIntervalSec: 30,
    ...overrides,
  };
}

const RUNNING_MEDIA = [
  { name: 'livekit', kind: 'sfu', running: true, restarts: 0 },
  { name: 'turnserver', kind: 'turn', running: true, restarts: 2 },
];

test('readiness: matrix of normal and degraded states', () => {
  const config = makeConfig();
  const ready = (runtime, media = RUNNING_MEDIA) =>
    evaluateReadiness({ config, runtime, media, now: NOW });

  assert.equal(ready(makeRuntime()).ready, true);
  assert.equal(ready(makeRuntime()).reason, 'ok');
  assert.equal(ready(makeRuntime({ shuttingDown: true })).reason, 'shutting_down');
  assert.equal(ready(makeRuntime({ registered: false })).reason, 'not_registered');
  assert.equal(ready(makeRuntime({ lastHeartbeatAt: 0 })).reason, 'no_heartbeat');
  assert.equal(
    ready(makeRuntime({ lastHeartbeatAt: NOW - 5_000, lastHeartbeatErrorAt: NOW - 1_000 })).reason,
    'heartbeat_failing',
  );
  assert.equal(ready(makeRuntime({ lastHeartbeatAt: NOW - 91_000 })).reason, 'heartbeat_stale');
  assert.equal(ready(makeRuntime({ coreDrain: true })).reason, 'draining');
  assert.equal(ready(makeRuntime({ localDrain: true })).reason, 'draining');
  const mediaDown = ready(makeRuntime(), [{ name: 'livekit', kind: 'sfu', running: false, restarts: 1 }]);
  assert.equal(mediaDown.ready, false);
  assert.equal(mediaDown.reason, 'media_down');
  assert.deepEqual(mediaDown.mediaDown, ['livekit']);
  assert.deepEqual(ready(makeRuntime(), [{ name: 'livekit', running: true, ready: false }]),
    { ready: false, reason: 'media_down', mediaDown: ['livekit'] });
});

test('readiness: media is not required when NODE_MEDIA_ENABLED=false', () => {
  const config = makeConfig({ NODE_MEDIA_ENABLED: 'false' });
  const readiness = evaluateReadiness({
    config,
    runtime: makeRuntime(),
    media: [{ name: 'livekit', kind: 'sfu', running: false, restarts: 0 }],
    now: NOW,
  });
  assert.equal(readiness.ready, true);
});

test('metrics: valid exposition, one HELP/TYPE per name, no secrets', () => {
  const config = loadConfig({
    NODE_FEATURES: 'sfu,turn',
    NODE_ID: 'metrics-node',
    LIVEKIT_API_KEY: 'agil_sfu',
    LIVEKIT_API_SECRET: SECRET,
    TURN_EXTERNAL_IP: '203.0.113.10',
    TURN_PASSWORD: 'turn-password-123',
  });
  const runtime = makeRuntime({ nodeId: 'metrics-node', localDrain: true, lastRotationAt: NOW - 1_000 });
  const metrics = renderMetrics({ config, runtime, media: RUNNING_MEDIA, now: NOW });

  const help = metrics.split('\n').filter((line) => line.startsWith('# HELP '));
  assert.equal(new Set(help).size, help.length, 'duplicate HELP lines break strict Prometheus parsers');
  assert.equal(help.filter((line) => line.includes('agil_node_feature')).length, 1);
  assert.equal(help.filter((line) => line.includes('agil_node_media_up')).length, 1);
  assert.equal(help.filter((line) => line.includes('agil_node_media_restarts_total')).length, 1);

  assert.match(metrics, /^agil_node_up 1$/m);
  assert.match(metrics, /^agil_node_ready 0$/m);
  assert.match(metrics, /^agil_node_readiness_state\{reason="draining"\} 1$/m);
  assert.match(metrics, /^agil_node_draining 1$/m);
  assert.match(metrics, /^agil_node_heartbeats_total 1$/m);
  assert.match(metrics, /^agil_node_feature\{feature="sfu"\} 1$/m);
  assert.match(metrics, /^agil_node_feature\{feature="turn"\} 1$/m);
  assert.match(metrics, /^agil_node_media_up\{process="livekit",kind="sfu"\} 1$/m);
  assert.match(metrics, /^agil_node_media_ready\{process="livekit",kind="sfu"\} 1$/m);
  assert.match(metrics, /^agil_node_media_restarts_total\{process="turnserver",kind="turn"\} 2$/m);
  assert.match(metrics, /^agil_node_info\{node_id="metrics-node"/m);
  assert.ok(!metrics.includes('turn-password-123'), 'metrics must not contain the TURN password');
  assert.ok(!metrics.includes(SECRET), 'metrics must not contain the LiveKit secret');

  for (const line of metrics.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    assert.match(
      line,
      /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?[0-9]+(\.[0-9]+)?$/,
      `invalid Prometheus sample line: ${line}`,
    );
  }
});

test('metrics distinguish a running process with a failed media probe from a failed Core heartbeat', () => {
  const config = makeConfig();
  const media = [{ name: 'livekit', kind: 'sfu', running: true, ready: false }];
  const mediaMetrics = renderMetrics({ config, runtime: makeRuntime(), media, now: NOW });
  assert.match(mediaMetrics, /^agil_node_readiness_state\{reason="media_down"\} 1$/m);
  assert.match(mediaMetrics, /^agil_node_media_up\{process="livekit",kind="sfu"\} 1$/m);
  assert.match(mediaMetrics, /^agil_node_media_ready\{process="livekit",kind="sfu"\} 0$/m);

  const runtime = makeRuntime({ lastHeartbeatAt: NOW - 10_000, lastHeartbeatErrorAt: NOW - 1_000 });
  const heartbeatMetrics = renderMetrics({ config, runtime, media: RUNNING_MEDIA, now: NOW });
  assert.match(heartbeatMetrics, /^agil_node_readiness_state\{reason="heartbeat_failing"\} 1$/m);
  assert.match(heartbeatMetrics, /^agil_node_media_ready\{process="livekit",kind="sfu"\} 1$/m);
});

test('metrics: URL userinfo is redacted from the core label', () => {
  // loadConfig rejects credential-bearing URLs; this test covers a config object
  // that bypassed validation (an old caller or a restored/test config) because
  // /metrics binds 0.0.0.0 by default.
  const config = makeConfig();
  const bypassed = { ...config, core: { ...config.core, url: 'https://user:topsecret@core.example.test:8787' } };
  const metrics = renderMetrics({ config: bypassed, runtime: makeRuntime(), media: RUNNING_MEDIA, now: NOW });
  assert.ok(!metrics.includes('topsecret'), 'metrics must not expose URL credentials');
  assert.match(metrics, /core="https:\/\/core\.example\.test:8787"/);
});

test('control auth: token comparison or loopback fallback', () => {
  const req = (remoteAddress, headers = {}) => ({ headers, socket: { remoteAddress } });
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('10.0.0.5'), false);
  assert.equal(isLoopbackAddress(undefined), false);

  assert.equal(controlAuthorized(req('127.0.0.1'), ''), true);
  assert.equal(controlAuthorized(req('10.0.0.5'), ''), false);
  assert.equal(controlAuthorized(req('10.0.0.5', { 'x-control-token': 'right-token' }), 'right-token'), true);
  assert.equal(controlAuthorized(req('10.0.0.5', { 'x-control-token': 'wrong-token' }), 'right-token'), false);
  assert.equal(
    controlAuthorized(req('10.0.0.5', { authorization: 'Bearer right-token' }), 'right-token'),
    true,
  );
  assert.equal(controlAuthorized(req('127.0.0.1', { 'x-control-token': 'wrong-token' }), 'right-token'), false);
});

test('HTTP server: health, readyz, metrics, summary, 404/405', async () => {
  const port = await freePort();
  const config = makeConfig({
    NODE_HTTP_PORT: String(port),
    NODE_HTTP_HOST: '127.0.0.1',
    NODE_MEDIA_ENABLED: 'false',
    NODE_CONTROL_TOKEN: 'control-token-123',
  });
  const runtime = makeRuntime();
  const server = await startHealthServer({ config, runtime, log: silentLog, getMedia: () => [] });
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await request(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.role, 'node-agent');
    assert.deepEqual(health.json.features, ['sfu']);
    assert.equal(health.json.mediaEnabled, false);

    const head = await request(`${base}/healthz`, { method: 'HEAD' });
    assert.equal(head.status, 200);

    const ready = await request(`${base}/readyz`);
    assert.equal(ready.status, 200);
    assert.equal(ready.json.ok, true);
    assert.equal(ready.json.reason, 'ok');

    const metrics = await request(`${base}/metrics`);
    assert.equal(metrics.status, 200);
    assert.match(metrics.headers.get('content-type') ?? '', /text\/plain/);
    assert.match(metrics.text, /agil_node_up 1/);

    const summary = await request(`${base}/`);
    assert.equal(summary.status, 200);
    assert.equal(summary.json.name, 'agil-node');
    assert.deepEqual(summary.json.features, ['sfu']);
    assert.ok(!summary.text.includes(SECRET));
    assert.ok(!summary.text.includes('control-token-123'));

    assert.equal((await request(`${base}/nope`)).status, 404);
    assert.equal((await request(`${base}/healthz`, { method: 'PUT' })).status, 405);
    assert.equal((await request(`${base}/v1/control/drain`, { method: 'POST', body: {} })).status, 401);
  } finally {
    await server.close();
  }
});

test('HTTP control: drain changes readiness and clears; invalid bodies/unknown routes', async () => {
  const port = await freePort();
  const config = makeConfig({
    NODE_HTTP_PORT: String(port),
    NODE_HTTP_HOST: '127.0.0.1',
    NODE_MEDIA_ENABLED: 'false',
    NODE_CONTROL_TOKEN: 'control-token-123',
  });
  const runtime = makeRuntime();
  const server = await startHealthServer({ config, runtime, log: silentLog, getMedia: () => [] });
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'x-control-token': 'control-token-123' };
  try {
    const badToken = await request(`${base}/v1/control/drain`, {
      method: 'POST',
      headers: { 'x-control-token': 'nope' },
      body: { drain: true },
    });
    assert.equal(badToken.status, 401);

    const drain = await request(`${base}/v1/control/drain`, { method: 'POST', headers, body: { drain: true } });
    assert.equal(drain.status, 200);
    assert.equal(drain.json.drain.local, true);
    assert.equal(runtime.localDrain, true);

    const notReady = await request(`${base}/readyz`);
    assert.equal(notReady.status, 503);
    assert.equal(notReady.json.reason, 'draining');

    const undrain = await request(`${base}/v1/control/drain`, { method: 'POST', headers, body: { drain: false } });
    assert.equal(undrain.status, 200);
    assert.equal((await request(`${base}/readyz`)).status, 200);

    const invalidType = await request(`${base}/v1/control/drain`, {
      method: 'POST',
      headers,
      body: { drain: 'yes' },
    });
    assert.equal(invalidType.status, 400);
    assert.equal(invalidType.json.error, 'invalid_body');

    const invalidJson = await fetch(`${base}/v1/control/drain`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(invalidJson.status, 400);

    const unknown = await request(`${base}/v1/control/unknown`, { method: 'POST', headers, body: {} });
    assert.equal(unknown.status, 404);

    const rotate = await request(`${base}/v1/control/rotate-key`, { method: 'POST', headers, body: {} });
    assert.equal(rotate.status, 501);
    assert.equal(rotate.json.error, 'rotation_requires_admin_key');
  } finally {
    await server.close();
  }
});

test('HTTP control: rotate-key calls the injected rotation and reports the expiry', async () => {
  const port = await freePort();
  const config = makeConfig({
    NODE_HTTP_PORT: String(port),
    NODE_HTTP_HOST: '127.0.0.1',
    NODE_MEDIA_ENABLED: 'false',
    NODE_CONTROL_TOKEN: 'control-token-123',
    AGIL_API_KEY: 'admin-key',
  });
  const runtime = makeRuntime({ nodeId: 'health-node' });
  let seen = null;
  const rotateKey = async (input) => {
    seen = input;
    runtime.lastRotationAt = NOW;
    return { ok: true, keyExpiresAt: NOW + 1_000_000 };
  };
  const server = await startHealthServer({ config, runtime, log: silentLog, getMedia: () => [], rotateKey });
  const base = `http://127.0.0.1:${port}`;
  try {
    const rotated = await request(`${base}/v1/control/rotate-key`, {
      method: 'POST',
      headers: { authorization: 'Bearer control-token-123' },
      body: { keyTtlSec: 3600 },
    });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.json.ok, true);
    assert.equal(rotated.json.keyExpiresAt, NOW + 1_000_000);
    assert.deepEqual(seen, { keyTtlSec: 3600 });
  } finally {
    await server.close();
  }
});

test('HTTP control: a rejected rotation reports 502 and clears the busy flag', async () => {
  const port = await freePort();
  const config = makeConfig({
    NODE_HTTP_PORT: String(port),
    NODE_HTTP_HOST: '127.0.0.1',
    NODE_MEDIA_ENABLED: 'false',
    NODE_CONTROL_TOKEN: 'control-token-123',
    AGIL_API_KEY: 'admin-key',
  });
  const runtime = makeRuntime();
  const server = await startHealthServer({
    config,
    runtime,
    log: silentLog,
    getMedia: () => [],
    rotateKey: async () => ({ ok: false, error: 'core said no' }),
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const response = await request(`${base}/v1/control/rotate-key`, {
      method: 'POST',
      headers: { 'x-control-token': 'control-token-123' },
      body: {},
    });
    assert.equal(response.status, 502);
    assert.equal(response.json.error, 'rotation_failed');
    assert.equal(response.json.message, 'core said no');
    assert.equal(runtime.rotating, false);
  } finally {
    await server.close();
  }
});
