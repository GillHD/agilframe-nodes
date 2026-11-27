/**
 * Reference node agent smoke test (P2-2).
 *
 * Runs `agent.mjs` with `AGIL_NODE_ONCE=true` against a tiny fake Core and
 * asserts a clean exit code. On Windows/Node 23 the old
 * `process.exit()` implementation aborted inside libuv while undici keep-alive
 * handles were closing (0xC0000409); this test would fail with a non-zero code
 * or an "Assertion failed" line on stderr.
 *
 * The Docker module integration tests use a fake Docker Engine API over loopback
 * TCP (`AGIL_NODE_DOCKER_HOST=tcp://…`); no real Docker socket/container is
 * involved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { moduleCommand, startFakeDocker, STT_TEST_ENV } from './fake-docker.mjs';

const AGENT = path.resolve(fileURLToPath(new URL('../agent.mjs', import.meta.url)));
const TOKEN = 'agil_enr_agent_smoke_token_1234567890';
const NODE_KEY = 'nk_agent_smoke_node_key_1234567890';
const NODE_ID = 'agent-once-smoke';

function startFakeCore({
  rejectRegister = false, moduleCommands = [], heartbeatIntervalSec = 30,
  registrationIntervalSec = heartbeatIntervalSec, retrySecondBeatAfterSec = 0,
} = {}) {
  const requests = [];
  const state = {
    // Delivered at most once, like the real Core (delivery is recorded).
    moduleCommands: [...moduleCommands],
  };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, at: Date.now() });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/nodes/register') {
        if (rejectRegister) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'enrollment token rejected' } }));
          return;
        }
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            node: { id: NODE_ID, role: body.role, tenantId: 'demo', status: 'online' },
            nodeKey: NODE_KEY,
            keyExpiresAt: null,
            heartbeatIntervalSec: registrationIntervalSec,
            cluster: { id: 'cl_smoke', role: 'leader', version: '0.1.0' },
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === `/v1/nodes/${NODE_ID}/heartbeat`) {
        if (req.headers['x-node-token'] !== NODE_KEY) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'bad key' } }));
          return;
        }
        if (retrySecondBeatAfterSec && requests.filter((request) => request.url === req.url).length === 2) {
          res.statusCode = 429;
          res.setHeader('retry-after', retrySecondBeatAfterSec);
          res.end(JSON.stringify({ error: { code: 'rate_limited', message: 'wait before trying another heartbeat' } }));
          return;
        }
        const commands = state.moduleCommands;
        state.moduleCommands = [];
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            node: { id: NODE_ID, status: 'online' },
            drain: false,
            heartbeatIntervalSec,
            serverTime: Date.now(),
            moduleCommands: commands,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'no route' } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, state, port: server.address().port });
    });
  });
}

function runAgent(env, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AGENT], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`agent did not exit within ${timeoutMs} ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    timer.unref?.();
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function startAgentProcess(env) {
  const child = spawn(process.execPath, [AGENT], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    child,
    output: () => ({ stdout, stderr }),
    exit: exited,
    async stop() {
      child.kill();
      return exited;
    },
  };
}

async function waitFor(fn, { timeoutMs = 20_000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('AGIL_NODE_ONCE registers + heartbeats and exits 0 without a libuv assertion', async () => {
  const fake = await startFakeCore();
  const stateDir = mkdtempSync(path.join(tmpdir(), 'agil-node-agent-'));
  try {
    const result = await runAgent({
      AGIL_CORE_URL: `http://127.0.0.1:${fake.port}`,
      AGIL_NODE_ONCE: 'true',
      AGIL_NODE_STATE_DIR: stateDir,
      AGIL_NODE_TOKEN: TOKEN,
      AGIL_NODE_KEY: '',
      AGIL_NODE_ID: NODE_ID,
      AGIL_NODE_ROLE: 'sfu',
      AGIL_NODE_LOG_LEVEL: 'info',
      // Keep the test independent of a Docker socket on the host.
      AGIL_NODE_MODULES: 'off',
    });

    assert.equal(result.signal, null, `agent was killed: ${result.stderr}`);
    assert.equal(
      result.code,
      0,
      `expected exit 0, got ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.ok(!/Assertion failed|UV_HANDLE_CLOSING|0xC0000409/i.test(result.stderr), result.stderr);
    assert.match(result.stdout, /node registered/);
    assert.match(result.stdout, /single heartbeat finished/);

    const paths = fake.requests.map((request) => `${request.method} ${request.url}`);
    assert.ok(paths.includes('POST /v1/nodes/register'), paths.join(', '));
    assert.ok(paths.includes(`POST /v1/nodes/${NODE_ID}/heartbeat`), paths.join(', '));

    // The heartbeat carries best-effort host stats under `metrics`; unavailable
    // fields are omitted (this test may run on Windows, where /proc is absent)
    // rather than filled with fake zeros. Nothing secret may enter the object.
    const heartbeat = fake.requests.find((request) => request.url.endsWith('/heartbeat'));
    assert.ok(heartbeat.body.metrics, 'heartbeat must carry node metrics');
    assert.equal(heartbeat.body.moduleAvailability, 'disabled');
    assert.ok(!('modules' in heartbeat.body));
    assert.equal(heartbeat.body.metrics.version, '0.1.0');
    assert.equal(typeof heartbeat.body.metrics.reportedAt, 'number');
    assert.equal(typeof heartbeat.body.metrics.uptimeSec, 'number');
    assert.ok(!('activeRooms' in heartbeat.body.metrics), 'room stats must not be faked');
    assert.ok(!JSON.stringify(heartbeat.body.metrics).includes(NODE_KEY), 'node key must not leak into metrics');
    if (heartbeat.body.metrics.cpuPercent !== undefined) {
      assert.ok(
        heartbeat.body.metrics.cpuPercent >= 0 && heartbeat.body.metrics.cpuPercent <= 100,
        'cpuPercent must be a 0..100 percentage',
      );
    }

    // Secrets are only in the state file (0600), never in the agent's logs.
    assert.ok(!result.stdout.includes(TOKEN), 'enrollment token must not be logged');
    assert.ok(!result.stderr.includes(TOKEN), 'enrollment token must not be logged');
    const state = JSON.parse(readFileSync(path.join(stateDir, 'node.json'), 'utf8'));
    assert.equal(state.nodeId, NODE_ID);
    assert.equal(state.nodeKey, NODE_KEY);
  } finally {
    await new Promise((resolve) => fake.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('AGIL_NODE_ONCE exits 1 (not a crash) when enrollment is rejected', async () => {
  const fake = await startFakeCore({ rejectRegister: true });
  const stateDir = mkdtempSync(path.join(tmpdir(), 'agil-node-agent-'));
  try {
    const result = await runAgent({
      AGIL_CORE_URL: `http://127.0.0.1:${fake.port}`,
      AGIL_NODE_ONCE: 'true',
      AGIL_NODE_STATE_DIR: stateDir,
      AGIL_NODE_TOKEN: 'agil_enr_rejected_token_1234567890',
      AGIL_NODE_KEY: '',
      AGIL_NODE_ID: 'agent-rejected',
      AGIL_NODE_ROLE: 'sfu',
      AGIL_NODE_MODULES: 'off',
    });
    assert.equal(result.signal, null);
    assert.equal(result.code, 1, `expected exit 1, got ${result.code}\n${result.stderr}`);
    assert.ok(!/Assertion failed|UV_HANDLE_CLOSING/i.test(result.stderr), result.stderr);
    // Core error envelope `{error:{code,message}}` must be rendered, not stringified.
    assert.ok(!result.stderr.includes('[object Object]'), result.stderr);
    assert.match(
      result.stderr,
      /enrollment rejected \(HTTP 401\): unauthorized: enrollment token rejected/,
      result.stderr,
    );
  } finally {
    await new Promise((resolve) => fake.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('AGIL_NODE_ONCE reports the discovered Docker module inventory on the heartbeat', async () => {
  const fake = await startFakeCore();
  const fakeDocker = await startFakeDocker();
  const stateDir = mkdtempSync(path.join(tmpdir(), 'agil-node-agent-modules-'));
  try {
    fakeDocker.addContainer({
      moduleId: 'egress',
      nodeId: NODE_ID,
      image: 'agil/node-egress:0.1.0',
      running: true,
      health: 'healthy',
      labels: { 'org.opencontainers.image.version': '0.1.0' },
    });
    const result = await runAgent({
      AGIL_CORE_URL: `http://127.0.0.1:${fake.port}`,
      AGIL_NODE_ONCE: 'true',
      AGIL_NODE_STATE_DIR: stateDir,
      AGIL_NODE_TOKEN: TOKEN,
      AGIL_NODE_KEY: '',
      AGIL_NODE_ID: NODE_ID,
      AGIL_NODE_ROLE: 'sfu',
      AGIL_NODE_LOG_LEVEL: 'info',
      AGIL_NODE_MODULES: 'auto',
      AGIL_NODE_DOCKER_HOST: fakeDocker.url,
    });
    assert.equal(result.code, 0, `expected exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(!/Assertion failed|UV_HANDLE_CLOSING/i.test(result.stderr), result.stderr);

    const heartbeat = fake.requests.find((request) => request.url.endsWith('/heartbeat'));
    assert.ok(Array.isArray(heartbeat.body.modules), 'the heartbeat carries a modules snapshot');
    assert.equal(heartbeat.body.modules.length, 1);
    const [module] = heartbeat.body.modules;
    assert.equal(module.id, 'egress');
    assert.equal(module.image, 'agil/node-egress:0.1.0');
    assert.equal(module.status, 'running');
    assert.equal(module.health, 'healthy');
    assert.equal(module.version, '0.1.0');
    assert.equal(typeof module.updatedAt, 'number');
    assert.ok(!('lastError' in module));
    assert.equal(heartbeat.body.moduleAvailability, 'available');
    assert.ok(!('moduleResults' in heartbeat.body), 'nothing to acknowledge on the first beat');
  } finally {
    await new Promise((resolve) => fake.server.close(resolve));
    await fakeDocker.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('AGIL_NODE_ONCE with no Docker socket stays an agent-only node (no modules field)', async () => {
  const fake = await startFakeCore();
  const stateDir = mkdtempSync(path.join(tmpdir(), 'agil-node-agent-nodocker-'));
  try {
    const result = await runAgent({
      AGIL_CORE_URL: `http://127.0.0.1:${fake.port}`,
      AGIL_NODE_ONCE: 'true',
      AGIL_NODE_STATE_DIR: stateDir,
      AGIL_NODE_TOKEN: TOKEN,
      AGIL_NODE_KEY: '',
      AGIL_NODE_ID: NODE_ID,
      AGIL_NODE_ROLE: 'sfu',
      AGIL_NODE_LOG_LEVEL: 'info',
      AGIL_NODE_MODULES: 'auto',
      // Nothing listens on port 1: the Docker probe fails fast.
      AGIL_NODE_DOCKER_HOST: 'tcp://127.0.0.1:1',
    });
    assert.equal(result.code, 0, `expected exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /agent-only node/, 'the Docker fallback is explained in the log');
    const heartbeat = fake.requests.find((request) => request.url.endsWith('/heartbeat'));
    assert.ok(!('modules' in heartbeat.body), 'no snapshot is invented when Docker is unavailable');
    assert.equal(heartbeat.body.moduleAvailability, 'unavailable');
    assert.ok(heartbeat.body.metrics, 'the rest of the heartbeat is unaffected');
  } finally {
    await new Promise((resolve) => fake.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('long-running: follows Core interval, respects Retry-After and retries the module acknowledgement', async () => {
  const fake = await startFakeCore({
    heartbeatIntervalSec: 5, registrationIntervalSec: 30,
    retrySecondBeatAfterSec: 7, moduleCommands: [moduleCommand('stt', 'install')],
  });
  const fakeDocker = await startFakeDocker();
  const stateDir = mkdtempSync(path.join(tmpdir(), 'agil-node-agent-cmd-'));
  writeFileSync(path.join(stateDir, 'module-env.json'), JSON.stringify(STT_TEST_ENV), { mode: 0o600 });
  // The host can reserve the agent's default port, even when nothing is listening on it.
  const healthPortProbe = createServer();
  await new Promise((resolve) => healthPortProbe.listen(0, '127.0.0.1', resolve));
  const healthPort = healthPortProbe.address().port;
  await new Promise((resolve) => healthPortProbe.close(resolve));
  const agent = startAgentProcess({
    AGIL_CORE_URL: `http://127.0.0.1:${fake.port}`,
    AGIL_NODE_STATE_DIR: stateDir,
    AGIL_NODE_TOKEN: TOKEN,
    AGIL_NODE_KEY: '',
    AGIL_NODE_ID: NODE_ID,
    AGIL_NODE_ROLE: 'sfu',
    AGIL_NODE_HEARTBEAT_SEC: '30',
    AGIL_NODE_HTTP_HOST: '127.0.0.1',
    AGIL_NODE_HTTP_PORT: String(healthPort),
    AGIL_NODE_LOG_LEVEL: 'info',
    AGIL_NODE_MODULES: 'auto',
    AGIL_NODE_DOCKER_HOST: fakeDocker.url,
  });
  try {
    const resultBeat = await waitFor(
      () => fake.requests.filter((request) => request.url.endsWith('/heartbeat'))[2],
      { label: 'the third heartbeat after the Core retry delay', timeoutMs: 25_000 },
    );
    const [first, rejected] = fake.requests.filter((request) => request.url.endsWith('/heartbeat'));
    assert.ok(rejected.at - first.at >= 4900 && rejected.at - first.at < 10000, 'Core interval overrides the local fallback');
    assert.ok(resultBeat.at - rejected.at >= 6900, 'the 429 Retry-After delay is honored');
    assert.deepEqual(resultBeat.body.moduleResults, rejected.body.moduleResults, 'the rejected beat did not drop its result');
    const [ack] = resultBeat.body.moduleResults;
    assert.match(ack.commandId, /^nmc_[0-9a-f]{16}$/);
    assert.equal(ack.ok, true, ack.error);
    assert.equal(ack.status, 'running');
    assert.ok(!('error' in ack), 'a successful result carries no error text');

    // The fake Docker received the pull/create/start calls, and the next
    // inventory snapshot reports the new container.
    assert.equal(fakeDocker.pulls.length, 1);
    assert.equal(fakeDocker.containers.size, 1);
    const container = [...fakeDocker.containers.values()][0];
    assert.equal(container.Config.Labels['agil.module'], 'stt');
    assert.equal(container.Config.Labels['agil.node'], NODE_ID);
    assert.equal(container.State.Running, true);

    const inventoryBeat = await waitFor(
      () => fake.requests.find(
        (request) => request.url.endsWith('/heartbeat')
          && Array.isArray(request.body.modules)
          && request.body.modules.some((module) => module.id === 'stt'),
      ),
      { label: 'a heartbeat carrying the stt inventory', timeoutMs: 15_000 },
    );
    const stt = inventoryBeat.body.modules.find((module) => module.id === 'stt');
    assert.equal(stt.image, 'agil/node-stt:0.1.0');
    assert.equal(stt.status, 'running');

    const { stdout } = agent.output();
    assert.match(stdout, /module command executed/);
    assert.ok(!/Assertion failed|UV_HANDLE_CLOSING/i.test(agent.output().stderr), agent.output().stderr);
  } finally {
    await agent.stop().catch(() => {});
    await new Promise((resolve) => fake.server.close(resolve));
    await fakeDocker.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
