import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { MediaError, MediaProcess, Supervisor, childEnv, probeExternalSfu } from '../agent/media.mjs';
import { freePort, waitFor } from './helpers.mjs';

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

async function tempDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** A child that stays alive until it is terminated. */
function longRunningSpec(overrides = {}) {
  return {
    name: 'fake-livekit',
    kind: 'sfu',
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    env: {},
    files: [],
    port: 7880,
    ...overrides,
  };
}

test('childEnv: media children never see AGIL/NODE/LIVEKIT/TURN secrets', () => {
  const env = childEnv(
    { LIVEKIT_KEYS: 'key: secret', LIVEKIT_CONFIG: 'port: 7880' },
    {
      PATH: '/usr/bin',
      HOME: '/home/node',
      LANG: 'C.UTF-8',
      AGIL_NODE_TOKEN: 'agil_enr_secret',
      AGIL_NODE_KEY: 'nk_secret',
      AGIL_API_KEY: 'admin_secret',
      TURN_PASSWORD: 'turn_secret',
      NODE_STATE_DIR: '/var/lib/agil-node',
    },
  );
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/node');
  assert.equal(env.LANG, 'C.UTF-8');
  assert.equal(env.LIVEKIT_KEYS, 'key: secret', 'explicit child env is allowed');
  for (const leaked of ['AGIL_NODE_TOKEN', 'AGIL_NODE_KEY', 'AGIL_API_KEY', 'TURN_PASSWORD', 'NODE_STATE_DIR']) {
    assert.ok(!(leaked in env), `${leaked} leaked into the media child`);
  }
});

test('external SFU probe expects a small empty response to the named room query', async () => {
  let body = '{}';
  const endpoint = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(body.slice(0, 100));
    response.end(body.slice(100));
  });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  const externalOrigin = `http://127.0.0.1:${endpoint.address().port}`;
  const probe = () => probeExternalSfu({ externalOrigin, apiKey: 'qa-key', apiSecret: 'x'.repeat(32) });
  try {
    assert.equal(await probe(), true);
    body = '{"rooms":[]}';
    assert.equal(await probe(), true);
    body = '{"rooms":[{"name":"other-room"}]}';
    assert.equal(await probe(), false);
    body = '{"rooms":[],"padding":"' + 'x'.repeat(8192) + '"}';
    assert.equal(await probe(), false);
  } finally {
    await new Promise((resolve) => endpoint.close(resolve));
  }
});

test('MediaProcess.prepare writes runtime files with 0600', async () => {
  const dir = await tempDir('agil-media-files-');
  try {
    const file = path.join(dir, 'nested', 'turnserver.conf');
    const process_ = new MediaProcess({
      spec: longRunningSpec({ files: [{ path: file, mode: 0o600, content: 'user=agil:pass\n' }] }),
      log: silentLog,
      stdio: 'ignore',
    });
    await process_.prepare();
    assert.equal(await readFile(file, 'utf8'), 'user=agil:pass\n');
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a running media process becomes ready only after an HTTP response and loses readiness when it fails', async () => {
  const port = await freePort();
  let healthy = false;
  const endpoint = createServer((req, res) => res.end(healthy ? 'OK' : 'Starting'));
  endpoint.listen(port, '127.0.0.1');
  await once(endpoint, 'listening');
  const process_ = new MediaProcess({
    spec: longRunningSpec({ port, probe: { protocol: 'http', host: '127.0.0.1', port } }),
    log: silentLog,
    stdio: 'ignore',
  });
  try {
    await process_.start();
    assert.equal(process_.status().running, true);
    assert.equal(process_.status().ready, false);
    healthy = true;
    await waitFor(() => process_.status().ready, { label: 'LiveKit responds OK' });
    healthy = false;
    await waitFor(() => !process_.status().ready, { label: 'LiveKit stops responding OK' });
    assert.equal(process_.status().running, true);
  } finally {
    await process_.stop();
    await new Promise((resolve) => endpoint.close(resolve));
  }
});

test('a TURN node with TLS enabled is not ready when only STUN and a plain TCP listener respond', async () => {
  const udp = createSocket('udp4');
  let bindings = 0;
  udp.on('message', (message, remote) => {
    bindings++;
    const response = Buffer.from(message);
    response.writeUInt16BE(0x0101);
    udp.send(response, remote.port, remote.address);
  });
  udp.bind(0, '127.0.0.1');
  await once(udp, 'listening');
  const tcp = createTcpServer((socket) => socket.destroy());
  tcp.listen(0, '127.0.0.1');
  await once(tcp, 'listening');
  const probe = { protocol: 'stun', host: '127.0.0.1', port: udp.address().port, tlsPort: tcp.address().port };
  const process_ = new MediaProcess({
    spec: longRunningSpec({ name: 'turnserver', kind: 'turn', probe }),
    log: silentLog,
    stdio: 'ignore',
  });
  try {
    await process_.start();
    await waitFor(() => bindings >= 2, { label: 'two successful UDP Binding probes' });
    assert.equal(process_.status().running, true);
    assert.equal(process_.status().ready, false);
  } finally {
    await process_.stop();
    await Promise.all([new Promise((resolve) => udp.close(resolve)), new Promise((resolve) => tcp.close(resolve))]);
  }
});

test('Supervisor: starts both processes, reports status, stops them', async () => {
  const dir = await tempDir('agil-media-run-');
  const supervisor = new Supervisor({
    specs: [
      longRunningSpec({ name: 'livekit', kind: 'sfu', port: 7880 }),
      longRunningSpec({ name: 'turnserver', kind: 'turn', port: 3478 }),
    ],
    log: silentLog,
    stdio: 'ignore',
    stopGraceMs: 2_000,
  });
  try {
    await supervisor.startAll();
    const status = supervisor.status();
    assert.equal(status.length, 2);
    assert.deepEqual(status.map((entry) => entry.name), ['livekit', 'turnserver']);
    assert.ok(status.every((entry) => entry.running));
    assert.equal(supervisor.allRunning(), true);
    supervisor.noteHealthy();
  } finally {
    await supervisor.stopAll();
    assert.ok(supervisor.status().every((entry) => !entry.running));
    await rm(dir, { recursive: true, force: true });
  }
});

test('Supervisor: a missing binary fails startup and stops the already-started child', async () => {
  const supervisor = new Supervisor({
    specs: [
      longRunningSpec({ name: 'livekit' }),
      longRunningSpec({ name: 'turnserver', command: path.join(tmpdir(), 'agil-no-such-turnserver') }),
    ],
    log: silentLog,
    stdio: 'ignore',
    stopGraceMs: 2_000,
  });
  try {
    await assert.rejects(supervisor.startAll(), (error) => {
      assert.ok(error instanceof MediaError);
      assert.match(error.message, /could not start|failed to start/);
      return true;
    });
    assert.ok(supervisor.status().every((entry) => !entry.running), 'half-started media must be stopped');
  } finally {
    await supervisor.stopAll();
  }
});

test('MediaProcess: an unexpected exit triggers a bounded restart', async () => {
  const process_ = new MediaProcess({
    spec: longRunningSpec({ name: 'crasher', args: ['-e', 'process.exit(7)'] }),
    log: silentLog,
    stdio: 'ignore',
    restartBaseMs: 10,
    restartMaxMs: 20,
    stopGraceMs: 1_000,
  });
  try {
    await process_.start();
    const deadline = Date.now() + 5_000;
    while (process_.status().restarts < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const status = process_.status();
    assert.ok(status.restarts >= 1, 'a crashing media child is restarted');
    assert.equal(status.lastExit.code, 7, 'the supervisor keeps the last exit code for diagnostics');
  } finally {
    await process_.stop();
    assert.equal(process_.status().running, false);
  }
});

test('MediaProcess: a failed restart does not disable later restarts after recovery', async () => {
  // Regression for the P2 finding: a transient spawn failure (ENOENT) while
  // restarting set `fatal` permanently, and the next successful start did not
  // clear it, so a later crash was never restarted.
  const missing = path.join(tmpdir(), `agil-media-missing-${process.pid}-${Date.now()}`);
  const process_ = new MediaProcess({
    spec: longRunningSpec({ name: 'recovering' }),
    log: silentLog,
    stdio: 'ignore',
    restartBaseMs: 10,
    restartMaxMs: 20,
    stopGraceMs: 2_000,
  });
  try {
    await process_.start();
    assert.equal(process_.status().running, true);

    // The binary disappears, the child crashes and the first retry cannot spawn.
    process_.spec.command = missing;
    process_.child.kill();
    await waitFor(() => process_.status().fatal !== null, {
      label: 'fatal spawn error after the failed restart',
      timeoutMs: 5_000,
    });
    assert.equal(process_.status().running, false);

    // The binary is back: the scheduled retry must start it and clear `fatal`.
    process_.spec.command = process.execPath;
    await waitFor(() => process_.status().running && process_.status().fatal === null, {
      label: 'recovered media child with a cleared fatal flag',
      timeoutMs: 5_000,
    });

    // And a later crash must still be restarted (this is what the bug broke).
    const restartsBefore = process_.status().restarts;
    process_.child.kill();
    await waitFor(() => process_.status().restarts > restartsBefore && process_.status().running, {
      label: 'restart after the recovered child crashed again',
      timeoutMs: 5_000,
    });
    assert.equal(process_.status().fatal, null);
  } finally {
    await process_.stop();
    assert.equal(process_.status().running, false);
  }
});
