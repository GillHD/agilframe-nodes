import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../agent/config.mjs';
import { CoreClient, FatalCoreError, NodeStateStore, apiErrorMessage } from '../agent/core.mjs';
import { startFakeCore } from './helpers.mjs';

const SECRET = 's'.repeat(32);
const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

function makeConfig(overrides = {}) {
  return loadConfig({
    NODE_FEATURES: 'sfu',
    NODE_ID: 'core-node',
    LIVEKIT_API_KEY: 'agil_sfu',
    LIVEKIT_API_SECRET: SECRET,
    AGIL_NODE_TOKEN: 'agil_enr_test_token_0123456789',
    ...overrides,
  });
}

test('state store: atomic 0600 file round-trip and corrupt/missing handling', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agil-node-state-'));
  try {
    const store = new NodeStateStore({ stateDir: dir });
    assert.equal(await store.load(), null, 'missing file is not an error');

    const saved = await store.save({
      nodeId: 'core-node',
      nodeKey: 'nk_state_key_0123456789',
      keyExpiresAt: 123,
      coreUrl: 'http://127.0.0.1:8787',
    });
    assert.equal(saved.nodeKey, 'nk_state_key_0123456789');
    assert.match(saved.registeredAt, /^\d{4}-\d{2}-\d{2}T/);

    const loaded = await store.load();
    assert.equal(loaded.nodeKey, 'nk_state_key_0123456789');
    assert.equal(loaded.nodeId, 'core-node');
    assert.equal(loaded.keyExpiresAt, 123);

    if (process.platform !== 'win32') {
      const info = await stat(store.file);
      assert.equal(info.mode & 0o777, 0o600, 'the node key file must not be group/world readable');
    }
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['node.json'], 'no temporary file is left behind');
    assert.match(await readFile(store.file, 'utf8'), /"nodeKey": "nk_state_key_0123456789"/);

    await writeFile(store.file, '{not json', 'utf8');
    const corrupt = await store.load();
    assert.equal(corrupt.corrupt, true);
    assert.match(corrupt.error, /JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('state store: re-asserts 0600 on an existing (restored) node.json', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agil-node-mode-'));
  try {
    const store = new NodeStateStore({ stateDir: dir });
    await store.save({
      nodeId: 'core-node',
      nodeKey: 'nk_mode_key_0123456789',
      keyExpiresAt: null,
      coreUrl: 'http://127.0.0.1:8787',
    });

    if (process.platform === 'win32') {
      // Windows has no owner/mode bits: the check is a no-op, never a crash.
      assert.deepEqual(await store.assertPrivateMode(), {});
      assert.equal((await store.load()).permissionsRepaired, undefined);
    } else {
      await chmod(store.file, 0o644);
      const loaded = await store.load();
      assert.equal(loaded.nodeKey, 'nk_mode_key_0123456789', 'the key still loads');
      assert.equal(loaded.permissionsRepaired, true, 'the loose mode is reported');
      assert.equal((await stat(store.file)).mode & 0o777, 0o600, 'the restored file is tightened to 0600');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('apiErrorMessage renders the Core envelope instead of [object Object]', () => {
  assert.equal(
    apiErrorMessage({ status: 401, json: { error: { code: 'unauthorized', message: 'bad token' } } }),
    'unauthorized: bad token',
  );
  assert.equal(apiErrorMessage({ status: 400, json: { error: 'plain detail' } }), 'plain detail');
  assert.equal(apiErrorMessage({ status: 500, json: null, text: 'upstream boom' }), 'upstream boom');
  assert.equal(apiErrorMessage({ status: 503, json: null, text: '' }), 'HTTP 503');
});

test('register: sends the contract payload, persists the key and includes capacity when set', async () => {
  const fake = await startFakeCore();
  const config = makeConfig({
    AGIL_CORE_URL: fake.url,
    NODE_CAPACITY: '{"maxRooms":5,"maxParticipants":100}',
    NODE_REGION: 'ru-msk',
    NODE_ENDPOINT: 'https://sfu-1.example.net:7880',
  });
  const client = new CoreClient(config, silentLog);
  try {
    const registration = await client.register({ attempts: 1 });
    assert.equal(registration.nodeKey, fake.state.nodeKey);
    assert.equal(registration.nodeId, 'core-node');
    assert.equal(registration.heartbeatIntervalSec, 5);
    assert.equal(registration.clusterId, 'cl_test');

    const register = fake.requests.find((request) => request.url === '/v1/nodes/register');
    assert.ok(register);
    assert.equal(register.body.token, config.core.token);
    assert.equal(register.body.nodeId, 'core-node');
    assert.equal(register.body.role, 'sfu');
    assert.deepEqual(register.body.features, ['sfu']);
    assert.deepEqual(register.body.capacity, { maxRooms: 5, maxParticipants: 100, bandwidthMbps: 0 });
    assert.equal(register.body.region, 'ru-msk');
    assert.equal(register.body.endpoint, 'https://sfu-1.example.net:7880');
    assert.equal(register.body.healthPath, '/healthz');
  } finally {
    await fake.close();
  }
});

test('register: invalid/unusable credentials are fatal, not retried', async () => {
  const fake = await startFakeCore();
  const config = makeConfig({ AGIL_CORE_URL: fake.url });
  const client = new CoreClient(config, silentLog);
  try {
    fake.state.rejectRegister = true;
    await assert.rejects(
      client.register({ attempts: 3 }),
      (error) => {
        assert.ok(error instanceof FatalCoreError);
        assert.equal(error.status, 401);
        assert.match(error.message, /enrollment rejected \(HTTP 401\): unauthorized: enrollment token rejected/);
        return true;
      },
    );
    assert.equal(fake.requests.filter((request) => request.url === '/v1/nodes/register').length, 1);

    fake.state.rejectRegister = false;
    fake.state.registerStatus = 409;
    await assert.rejects(client.register({ attempts: 1 }), /already registered/);
  } finally {
    await fake.close();
  }
});

test('register: a missing token explains how to enroll', async () => {
  const client = new CoreClient(makeConfig({ AGIL_NODE_TOKEN: '' }), silentLog);
  await assert.rejects(client.register({ attempts: 1 }), /AGIL_NODE_TOKEN is empty/);
});

test('heartbeat: key header, drain flag, status and no zero-capacity overwrite', async () => {
  const fake = await startFakeCore({ nodeId: 'core-node' });
  const config = makeConfig({ AGIL_CORE_URL: fake.url });
  const client = new CoreClient(config, silentLog);
  try {
    const online = await client.heartbeat({ nodeId: 'core-node', nodeKey: fake.state.nodeKey });
    assert.equal(online.ok, true);
    assert.equal(online.drain, false);
    assert.equal(online.heartbeatIntervalSec, 5);

    const beat = fake.requests.find((request) => request.url.endsWith('/heartbeat'));
    assert.equal(beat.headers['x-node-token'], fake.state.nodeKey);
    assert.equal(beat.body.status, 'online');
    assert.ok(!('capacity' in beat.body), '0 = not reported; do not overwrite admin capacity with zeros');
    assert.ok(!('features' in beat.body), 'the Core heartbeat schema has no features field');

    fake.state.drain = true;
    const draining = await client.heartbeat({ nodeId: 'core-node', nodeKey: fake.state.nodeKey });
    assert.equal(draining.drain, true);

    const offline = await client.heartbeat({ nodeId: 'core-node', nodeKey: fake.state.nodeKey, status: 'offline' });
    assert.equal(offline.ok, true);
    const last = fake.requests.filter((request) => request.url.endsWith('/heartbeat')).at(-1);
    assert.equal(last.body.status, 'offline');
  } finally {
    await fake.close();
  }
});

test('heartbeat: capacity is included only when the operator reported it', async () => {
  const fake = await startFakeCore({ nodeId: 'core-node' });
  const config = makeConfig({
    AGIL_CORE_URL: fake.url,
    NODE_CAPACITY: '{"maxRooms":7}',
  });
  const client = new CoreClient(config, silentLog);
  try {
    await client.heartbeat({ nodeId: 'core-node', nodeKey: fake.state.nodeKey });
    const beat = fake.requests.find((request) => request.url.endsWith('/heartbeat'));
    assert.deepEqual(beat.body.capacity, { maxRooms: 7, maxParticipants: 0, bandwidthMbps: 0 });
  } finally {
    await fake.close();
  }
});

test('heartbeat: node metrics are validated and forwarded under `metrics`', async () => {
  const fake = await startFakeCore({ nodeId: 'core-node' });
  const config = makeConfig({ AGIL_CORE_URL: fake.url });
  const client = new CoreClient(config, silentLog);
  try {
    await client.heartbeat({
      nodeId: 'core-node',
      nodeKey: fake.state.nodeKey,
      metrics: {
        cpuPercent: 12.5,
        memoryPercent: 43,
        load1: 0.42,
        activeRooms: 3,
        participants: 17,
        bandwidthMbps: 12.5,
        uptimeSec: 86400,
        version: '  0.1.0  ',
        reportedAt: 1_732_230_000_000,
        // Not part of the contract: must not be forwarded.
        secretLooking: 'nk_must_not_leak',
      },
    });
    const beat = fake.requests.find((request) => request.url.endsWith('/heartbeat'));
    assert.deepEqual(beat.body.metrics, {
      cpuPercent: 12.5,
      memoryPercent: 43,
      load1: 0.42,
      bandwidthMbps: 12.5,
      activeRooms: 3,
      participants: 17,
      uptimeSec: 86400,
      version: '0.1.0',
      reportedAt: 1_732_230_000_000,
    });
    assert.ok(!('secretLooking' in beat.body.metrics));

    // Nothing measurable / no metrics argument: omit the object entirely so the
    // body stays byte-compatible with an old agent.
    await client.heartbeat({ nodeId: 'core-node', nodeKey: fake.state.nodeKey, metrics: {} });
    const empty = fake.requests.filter((request) => request.url.endsWith('/heartbeat')).at(-1);
    assert.ok(!('metrics' in empty.body));
    await client.heartbeat({ nodeId: 'core-node', nodeKey: fake.state.nodeKey });
    const omitted = fake.requests.filter((request) => request.url.endsWith('/heartbeat')).at(-1);
    assert.ok(!('metrics' in omitted.body));

    // Invalid values are dropped instead of producing a 400 from the server.
    await client.heartbeat({
      nodeId: 'core-node',
      nodeKey: fake.state.nodeKey,
      metrics: { cpuPercent: Number.NaN, uptimeSec: -1 },
    });
    const invalid = fake.requests.filter((request) => request.url.endsWith('/heartbeat')).at(-1);
    assert.ok(!('metrics' in invalid.body));
  } finally {
    await fake.close();
  }
});

test('heartbeat: expired/disabled/network failures are reported, never thrown', async () => {
  const fake = await startFakeCore({ nodeId: 'core-node' });
  const config = makeConfig({ AGIL_CORE_URL: fake.url });
  const client = new CoreClient(config, silentLog);
  try {
    fake.state.rejectHeartbeatStatus = 401;
    fake.state.rejectHeartbeatMessage = 'node key expired';
    const expired = await client.heartbeat({ nodeId: 'core-node', nodeKey: 'nk_old' });
    assert.equal(expired.ok, false);
    assert.equal(expired.expired, true);
    assert.equal(expired.status, 401);

    fake.state.rejectHeartbeatStatus = 403;
    fake.state.rejectHeartbeatMessage = 'node disabled';
    const disabled = await client.heartbeat({ nodeId: 'core-node', nodeKey: fake.state.nodeKey });
    assert.equal(disabled.disabled, true);
    assert.equal(disabled.expired, false);

    fake.state.rejectHeartbeatStatus = 0;
    const wrongKey = await client.heartbeat({ nodeId: 'core-node', nodeKey: 'nk_wrong' });
    assert.equal(wrongKey.ok, false);
    assert.equal(wrongKey.status, 401);
    assert.equal(wrongKey.expired, false);
  } finally {
    await fake.close();
  }

  const unreachable = new CoreClient(makeConfig({ AGIL_CORE_URL: 'http://127.0.0.1:1' }), silentLog);
  const network = await unreachable.heartbeat({ nodeId: 'core-node', nodeKey: 'nk_x' });
  assert.equal(network.ok, false);
  assert.equal(network.status, 0);
});

test('rotateKey: admin key, new key returned once, failure surfaces', async () => {
  const fake = await startFakeCore({ apiKey: 'admin-key' });
  const config = makeConfig({ AGIL_CORE_URL: fake.url, AGIL_API_KEY: 'admin-key' });
  const client = new CoreClient(config, silentLog);
  try {
    const rotated = await client.rotateKey({ nodeId: 'core-node', keyTtlSec: 3600 });
    assert.equal(rotated.ok, true);
    assert.match(rotated.nodeKey, /^nk_rotated_1_/);
    assert.equal(rotated.keyExpiresAt, fake.state.keyExpiresAt);
    const request = fake.requests.find((entry) => entry.url.endsWith('/rotate-key'));
    assert.equal(request.headers['x-api-key'], 'admin-key');
    assert.deepEqual(request.body, { keyTtlSec: 3600 });

    const noAdmin = new CoreClient(makeConfig({ AGIL_CORE_URL: fake.url, AGIL_API_KEY: '' }), silentLog);
    const refused = await noAdmin.rotateKey({ nodeId: 'core-node' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /AGIL_API_KEY/);
  } finally {
    await fake.close();
  }
});
