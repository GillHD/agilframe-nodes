/**
 * All-in-one node image: Docker module management tests.
 *
 * The module manager itself is the same file as
 * `agil/infra/node-agent/modules.mjs` (kept byte-identical); these tests pin the
 * image-side wiring: config parsing, heartbeat `modules`/`moduleResults`, command
 * execution through the fake Docker Engine API, and the agent-only fallback when
 * the Docker socket is absent.
 *
 * The fake Docker daemon lives in the reference-agent test folder and is shared
 * by both test suites (no real Docker socket or container is touched).
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../agent/config.mjs';
import { createModuleManager } from '../agent/modules.mjs';
import { moduleCommand, startFakeDocker, STT_TEST_ENV } from '../../../../infra/node-agent/test/fake-docker.mjs';
import { AGENT_DIR, freePort, runAgent, startFakeCore, waitFor } from './helpers.mjs';

const REPO_ROOT = path.resolve(AGENT_DIR, '..', '..', '..', '..');
const SECRET = 's'.repeat(32);
const NODE_ID = 'module-node';

function baseEnv(overrides = {}) {
  return {
    NODE_FEATURES: 'sfu',
    NODE_ID,
    LIVEKIT_API_KEY: 'agil_sfu',
    LIVEKIT_API_SECRET: SECRET,
    NODE_MEDIA_ENABLED: 'false',
    NODE_LOG_LEVEL: 'info',
    ...overrides,
  };
}

test('modules.mjs is byte-identical to the reference node-agent copy', async () => {
  const [imageCopy, reference] = await Promise.all([
    readFile(path.join(AGENT_DIR, 'agent', 'modules.mjs'), 'utf8'),
    readFile(path.join(REPO_ROOT, 'agil', 'infra', 'node-agent', 'modules.mjs'), 'utf8'),
  ]);
  assert.equal(imageCopy, reference, 'all-in-one modules.mjs differs from agil/infra/node-agent/modules.mjs');
});

test('config: module settings default to auto and validate NODE_DOCKER_HOST/NODE_MODULES', () => {
  const defaults = loadConfig(baseEnv());
  assert.equal(defaults.modules.mode, 'auto');
  assert.equal(defaults.modules.dockerHost, 'unix:///var/run/docker.sock');
  assert.equal(defaults.modules.requestTimeoutMs, 15_000);
  assert.equal(defaults.modules.pullTimeoutMs, 600_000);
  assert.match(defaults.modules.stateFile, /module-commands\.json$/);
  assert.match(defaults.modules.envFile, /module-env\.json$/);

  const overridden = loadConfig(baseEnv({
    NODE_MODULES: 'off',
    NODE_DOCKER_HOST: 'tcp://127.0.0.1:2375',
    NODE_DOCKER_TIMEOUT_MS: '2000',
  }));
  assert.equal(overridden.modules.mode, 'off');
  assert.equal(overridden.modules.dockerHost, 'tcp://127.0.0.1:2375');
  assert.equal(overridden.modules.requestTimeoutMs, 2000);

  // AGIL_NODE_* aliases work for the quickstart/Helm `.env`.
  const aliased = loadConfig(baseEnv({
    NODE_MODULES: '',
    AGIL_NODE_MODULES: 'on',
    NODE_DOCKER_HOST: '',
    AGIL_NODE_DOCKER_HOST: 'unix:///run/docker.sock',
  }));
  assert.equal(aliased.modules.mode, 'on');
  assert.equal(aliased.modules.dockerHost, 'unix:///run/docker.sock');

  assert.throws(() => loadConfig(baseEnv({ NODE_MODULES: 'maybe' })), /NODE_MODULES must be auto\|on\|off/);
  assert.throws(() => loadConfig(baseEnv({ NODE_DOCKER_HOST: 'ftp://docker' })), /NODE_DOCKER_HOST/);

  // The safe-for-logs projection exposes the mode but no credentials.
  const summary = JSON.stringify(loadConfig(baseEnv()).modules);
  assert.match(summary, /"mode":"auto"/);
});

test('manager (image copy): discovers node-owned containers through the fake Docker API', async () => {
  const fake = await startFakeDocker();
  try {
    fake.addContainer({
      moduleId: 'egress',
      nodeId: NODE_ID,
      image: 'agil/node-egress:0.1.0',
      running: true,
      health: 'healthy',
    });
    fake.addContainer({ moduleId: 'stt', nodeId: 'another-node', image: 'agil/node-stt:0.1.0', running: true });
    const manager = createModuleManager({ nodeId: NODE_ID, dockerHost: fake.url });
    await manager.init();
    const inventory = await manager.inventory();
    assert.equal(inventory.length, 1);
    assert.equal(inventory[0].id, 'egress');
    assert.equal(inventory[0].image, 'agil/node-egress:0.1.0');
    assert.equal(inventory[0].status, 'running');
    assert.equal(manager.status().managed, 1);
    await manager.close();
  } finally {
    await fake.close();
  }
});

test('one-shot heartbeat carries the Docker module inventory and local image templates', async () => {
  const fake = await startFakeCore({ nodeId: NODE_ID });
  const template = { id: 'qa-cache', image: 'registry.example/qa/cache@sha256:' + 'a'.repeat(64) };
  const blockedTemplate = { id: 'qa-missing', image: 'registry.example/qa/worker@sha256:' + 'b'.repeat(64) };
  const fakeDocker = await startFakeDocker({ imageInspections: {
    [template.image]: { RepoDigests: [template.image] },
  } });
  const stateDir = await mkdtemp(path.join(tmpdir(), 'agil-node-image-modules-'));
  try {
    await writeFile(path.join(stateDir, 'module-templates.json'), JSON.stringify([template, { ...blockedTemplate, install: true }]), { mode: 0o600 });
    fakeDocker.addContainer({
      moduleId: 'egress',
      nodeId: NODE_ID,
      image: 'agil/node-egress:0.1.0',
      running: true,
      health: 'healthy',
    });
    const result = await runAgent(baseEnv({
      AGIL_CORE_URL: fake.url,
      AGIL_NODE_TOKEN: 'agil_enr_node_image_modules_0123456789',
      NODE_STATE_DIR: stateDir,
      NODE_ONCE: 'true',
      NODE_MODULES: 'auto',
      NODE_DOCKER_HOST: fakeDocker.url,
    }));
    assert.equal(result.code, 0, `expected exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(!/Assertion failed|UV_HANDLE_CLOSING/i.test(result.stderr), result.stderr);
    const heartbeat = fake.requests.find((entry) => entry.url.endsWith('/heartbeat'));
    assert.deepEqual(heartbeat.body.modules.map((module) => module.id), ['egress']);
    assert.equal(heartbeat.body.modules[0].status, 'running');
    assert.equal(heartbeat.body.modules[0].image, 'agil/node-egress:0.1.0');
    assert.deepEqual(heartbeat.body.moduleTemplates, [
      { ...template, cached: true },
      { ...blockedTemplate, cached: false, blockedReason: 'image_not_cached' },
    ]);
    assert.ok(!('moduleResults' in heartbeat.body));
  } finally {
    await fake.close();
    await fakeDocker.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('one-shot without a Docker socket is an agent-only node (no modules field)', async () => {
  const fake = await startFakeCore({ nodeId: NODE_ID });
  const stateDir = await mkdtemp(path.join(tmpdir(), 'agil-node-image-nodocker-'));
  try {
    const result = await runAgent(baseEnv({
      AGIL_CORE_URL: fake.url,
      AGIL_NODE_TOKEN: 'agil_enr_node_image_nodocker_0123456789',
      NODE_STATE_DIR: stateDir,
      NODE_ONCE: 'true',
      NODE_MODULES: 'auto',
      NODE_DOCKER_HOST: 'tcp://127.0.0.1:1',
    }));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /agent-only node/);
    const heartbeat = fake.requests.find((entry) => entry.url.endsWith('/heartbeat'));
    assert.ok(!('modules' in heartbeat.body), 'no modules field: the previous Core snapshot is kept');
  } finally {
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('in-process: executes a heartbeat module command and acknowledges it on a later beat', async () => {
  const { main } = await import('../agent/index.mjs');
  const port = await freePort();
  const fake = await startFakeCore({
    nodeId: NODE_ID,
    heartbeatIntervalSec: 5,
    moduleCommands: [moduleCommand('stt', 'install')],
  });
  const fakeDocker = await startFakeDocker();
  const stateDir = await mkdtemp(path.join(tmpdir(), 'agil-node-image-cmd-'));
  try {
    await writeFile(path.join(stateDir, 'module-env.json'), JSON.stringify(STT_TEST_ENV), { mode: 0o600 });
    const handle = await main({
      installSignalHandlers: false,
      env: baseEnv({
        AGIL_CORE_URL: fake.url,
        AGIL_NODE_TOKEN: 'agil_enr_node_image_cmd_0123456789',
        NODE_STATE_DIR: stateDir,
        NODE_HEARTBEAT_SEC: '5',
        NODE_HTTP_HOST: '127.0.0.1',
        NODE_HTTP_PORT: String(port),
        NODE_MODULES: 'auto',
        NODE_DOCKER_HOST: fakeDocker.url,
      }),
    });
    try {
      const resultBeat = await waitFor(
        () => fake.requests.find(
          (entry) => entry.url.endsWith('/heartbeat')
            && Array.isArray(entry.body.moduleResults)
            && entry.body.moduleResults.length > 0,
        ),
        { label: 'heartbeat with moduleResults', timeoutMs: 25_000 },
      );
      const [ack] = resultBeat.body.moduleResults;
      assert.equal(ack.ok, true);
      assert.equal(ack.status, 'running');
      assert.equal(fakeDocker.containers.size, 1);
      const container = [...fakeDocker.containers.values()][0];
      assert.equal(container.Config.Labels['agil.module'], 'stt');
      assert.equal(container.Config.Labels['agil.node'], NODE_ID);

      const inventoryBeat = await waitFor(
        () => fake.requests.find(
          (entry) => entry.url.endsWith('/heartbeat')
            && Array.isArray(entry.body.modules)
            && entry.body.modules.some((module) => module.id === 'stt'),
        ),
        { label: 'heartbeat with stt inventory', timeoutMs: 15_000 },
      );
      assert.equal(
        inventoryBeat.body.modules.find((module) => module.id === 'stt').status,
        'running',
      );
    } finally {
      await handle.shutdown('TEST');
    }
    const heartbeats = fake.requests.filter((entry) => entry.url.endsWith('/heartbeat'));
    assert.equal(heartbeats.at(-1).body.status, 'offline');
    assert.ok(
      Array.isArray(heartbeats.at(-1).body.modules),
      'the graceful offline beat still reports the inventory',
    );
  } finally {
    await fake.close();
    await fakeDocker.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
