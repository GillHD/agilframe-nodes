/**
 * Docker module management tests (`modules.mjs`).
 *
 * Everything runs against the fake Docker Engine API in `fake-docker.mjs` or
 * with a Docker client pointed at a closed port — no real Docker daemon and no
 * real containers are touched. The fake speaks the same list/inspect/create/
 * start/stop/restart/remove/pull contract the module manager uses, so a wrong
 * status field or a missing ownership check fails here.
 */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createModuleManager,
  DockerClient,
  DockerUnavailableError,
  isAllowlistedModuleImage,
  isValidImageReference,
  moduleCatalog,
  moduleContainerName,
  moduleImageRepository,
  sanitizeModuleCommand,
  sanitizeErrorText,
  buildModuleReport,
  parseDockerHost,
} from '../modules.mjs';
import { moduleCommand, startFakeDocker, STT_TEST_ENV } from './fake-docker.mjs';

const AGENT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.resolve(AGENT_DIR, '..', '..', '..');
const NODE_ID = 'edge-1';
let fixtureDirectory;
let fixtureEnvFile;
before(async () => {
  fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'agil-stt-module-fixture-'));
  fixtureEnvFile = path.join(fixtureDirectory, 'module-env.json');
  await writeFile(fixtureEnvFile, JSON.stringify(STT_TEST_ENV), { mode: 0o600 });
});
after(async () => { await rm(fixtureDirectory, { recursive: true, force: true }); });

function captureLogger() {
  const entries = [];
  const push = (level) => (message, extra = {}) => {
    entries.push({ level, message, extra, line: JSON.stringify({ level, message, extra }) });
  };
  return {
    entries,
    log: {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    },
  };
}

async function makeManager(fakeDocker, overrides = {}) {
  const { entries, log } = captureLogger();
  const manager = createModuleManager({
    nodeId: overrides.nodeId ?? NODE_ID,
    dockerHost: fakeDocker?.url ?? 'tcp://127.0.0.1:1',
    stateFile: overrides.stateFile ?? null,
    envFile: overrides.envFile === undefined ? fixtureEnvFile : overrides.envFile,
    templatesFile: overrides.templatesFile,
    externalSfu: overrides.externalSfu,
    log,
    now: overrides.now ?? Date.now,
    mode: overrides.mode ?? 'auto',
  });
  await manager.init();
  return { manager, logs: entries };
}

/* ------------------------------------------------------- allowlist tests */

test('module catalog mirrors the Core allowlist repositories and ports', () => {
  const catalog = moduleCatalog();
  assert.deepEqual(
    catalog.map((entry) => entry.id),
    ['egress', 'stt', 'recorder', 'turn', 'sip', 'ingress', 'sfu'],
  );
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('egress').repository, 'livekit/egress');
  assert.equal(byId.get('stt').repository, 'agil/node-stt');
  assert.equal(byId.get('recorder').repository, 'agil/node-recorder');
  assert.equal(byId.get('turn').repository, 'coturn/coturn');
  assert.equal(byId.get('sip').repository, 'livekit/sip');
  assert.deepEqual(byId.get('turn').ports.map((port) => `${port.port}/${port.protocol}`), [
    '3478/tcp',
    '3478/udp',
    '5349/tcp',
  ]);
});

test('image repository parsing matches the protocol helper', () => {
  assert.equal(moduleImageRepository('agil/node-egress:0.1.0'), 'agil/node-egress');
  assert.equal(moduleImageRepository('agil/node-egress@sha256:abc'), 'agil/node-egress');
  assert.equal(moduleImageRepository('registry:5000/agil/egress:1.2'), 'registry:5000/agil/egress');
  assert.equal(moduleImageRepository('coturn/coturn'), 'coturn/coturn');
  assert.equal(moduleImageRepository(''), '');
});

test('allowlist accepts tag/digest bumps but no other repository or malformed reference', () => {
  assert.equal(isAllowlistedModuleImage('egress', 'agil/node-egress:0.1.0'), true);
  assert.equal(isAllowlistedModuleImage('egress', 'agil/node-egress:0.2.0'), true);
  assert.equal(isAllowlistedModuleImage('egress', `agil/node-egress@sha256:${'a'.repeat(64)}`), true);
  assert.equal(isAllowlistedModuleImage('turn', 'coturn/coturn:4.6'), true);
  assert.equal(isAllowlistedModuleImage('egress', 'evil/node-egress:0.1.0'), false);
  assert.equal(isAllowlistedModuleImage('egress', 'docker.io/agil/node-egress:0.1.0'), false);
  assert.equal(isAllowlistedModuleImage('unknown', 'agil/node-egress:0.1.0'), false);
  assert.equal(isAllowlistedModuleImage('egress', 'agil/node-egress:'), false);
  assert.equal(isAllowlistedModuleImage('egress', 'agil//node-egress:1'), false);
  assert.equal(isValidImageReference('agil/node-egress:0.1.0'), true);
  assert.equal(isValidImageReference('bad image:1'), false);
});

test('command validation: allowlisted only, install image from the command, expiry honoured', () => {
  const now = 1_800_000_000_000;
  const install = sanitizeModuleCommand(
    { id: 'nmc_0123456789abcdef', moduleId: 'stt', action: 'install', image: 'agil/node-stt:0.2.0', expiresAt: now + 60_000 },
    { now },
  );
  assert.equal(install.ok, true);
  assert.deepEqual(install.command, {
    id: 'nmc_0123456789abcdef',
    moduleId: 'stt',
    action: 'install',
    image: 'agil/node-stt:0.2.0',
    expiresAt: now + 60_000,
  });

  const lifecycle = sanitizeModuleCommand(
    { id: 'nmc_0123456789abcdef', moduleId: 'turn', action: 'restart', expiresAt: now + 60_000 },
    { now },
  );
  assert.equal(lifecycle.ok, true);
  assert.equal('image' in lifecycle.command, false, 'non-install actions never carry an image');
  // A non-install image supplied by a buggy Core is ignored, never used.
  const withImage = sanitizeModuleCommand(
    { id: 'nmc_0123456789abcdef', moduleId: 'turn', action: 'start', image: 'evil/x:1', expiresAt: now + 60_000 },
    { now },
  );
  assert.equal(withImage.ok, true);
  assert.equal('image' in withImage.command, false);

  for (const bad of [
    { id: 'nope', moduleId: 'stt', action: 'start', expiresAt: now + 1 },
    { id: 'nmc_0123456789abcdef', moduleId: 'grafana', action: 'start', expiresAt: now + 1 },
    { id: 'nmc_0123456789abcdef', moduleId: 'stt', action: 'exec', expiresAt: now + 1 },
    { id: 'nmc_0123456789abcdef', moduleId: 'stt', action: 'install', image: 'evil/node-stt:1', expiresAt: now + 1 },
    { id: 'nmc_0123456789abcdef', moduleId: 'stt', action: 'install', expiresAt: now + 1 },
    { id: 'nmc_0123456789abcdef', moduleId: 'stt', action: 'install', image: 'agil/node-stt:1', expiresAt: now },
    { id: 'nmc_0123456789abcdef', moduleId: 'stt', action: 'install', image: 'agil/node-stt:1', expiresAt: 'soon' },
  ]) {
    const result = sanitizeModuleCommand(bad, { now });
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
  // Expiry is distinguishable so the caller can drop the command silently.
  const expired = sanitizeModuleCommand(
    { id: 'nmc_0123456789abcdef', moduleId: 'stt', action: 'start', expiresAt: now - 1 },
    { now },
  );
  assert.equal(expired.ok, false);
  assert.equal(expired.expired, true);
});

test('error text is bounded to one line and 300 characters', () => {
  assert.equal(sanitizeErrorText('boom\n\nsecond   line'), 'boom second line');
  assert.equal(sanitizeErrorText('x'.repeat(500)).length, 300);
  assert.equal(sanitizeErrorText(undefined), '');
});

test('parseDockerHost accepts unix/npipe/tcp and rejects unsupported values', () => {
  assert.deepEqual(parseDockerHost('unix:///var/run/docker.sock'), { socketPath: '/var/run/docker.sock' });
  assert.deepEqual(parseDockerHost('/run/docker.sock'), { socketPath: '/run/docker.sock' });
  assert.deepEqual(parseDockerHost('tcp://127.0.0.1:2375'), { host: '127.0.0.1', port: 2375 });
  assert.deepEqual(parseDockerHost('http://docker.example:2375'), { host: 'docker.example', port: 2375 });
  assert.deepEqual(parseDockerHost('npipe:////./pipe/docker_engine'), {
    socketPath: '\\\\.\\pipe\\docker_engine',
  });
  assert.throws(() => parseDockerHost('ftp://docker'), /unsupported Docker host/);
  assert.throws(() => parseDockerHost(''), /empty/);
});

test('moduleContainerName is a valid, bounded Docker name', () => {
  assert.equal(moduleContainerName('edge-1', 'egress'), 'agil-egress-edge-1');
  assert.match(moduleContainerName('Node/With Spaces:42', 'stt'), /^[a-z0-9][a-z0-9_.-]{0,62}$/);
  assert.ok(moduleContainerName('x'.repeat(100), 'turn').length <= 63);
});

/* ------------------------------------------- inspect -> NodeModuleReport */

function inspectContainer({
  moduleId = 'egress',
  nodeId = NODE_ID,
  image = 'agil/node-egress:0.1.0',
  running = true,
  status = running ? 'running' : 'exited',
  exitCode = running ? 0 : 0,
  health = null,
  labels = {},
  error = '',
  ports = {},
  exposed = {},
  startedAt = '2026-11-22T10:00:00.123456789Z',
  finishedAt = '',
  created = '2026-11-21T09:00:00.000000000Z',
} = {}) {
  return {
    Id: 'ctr_test',
    Created: created,
    Config: {
      Image: image,
      Labels: { 'agil.module': moduleId, 'agil.node': nodeId, ...labels },
      ...(Object.keys(exposed).length > 0 ? { ExposedPorts: exposed } : {}),
    },
    State: {
      Status: status,
      Running: running,
      Restarting: false,
      Dead: false,
      Paused: false,
      ExitCode: exitCode,
      Error: error,
      StartedAt: startedAt,
      FinishedAt: finishedAt,
      ...(health ? { Health: { Status: health, FailingStreak: 0, Log: [] } } : {}),
    },
    NetworkSettings: { Ports: ports },
  };
}

test('buildModuleReport: honest status/health/version/ports/updatedAt/lastError', () => {
  const running = buildModuleReport(inspectContainer({ health: 'healthy' }), { moduleId: 'egress', nodeId: NODE_ID });
  assert.equal(running.id, 'egress');
  assert.equal(running.image, 'agil/node-egress:0.1.0');
  assert.equal(running.status, 'running');
  assert.equal(running.health, 'healthy');
  assert.equal(running.version, '0.1.0', 'version falls back to the image tag');
  assert.equal(running.updatedAt, Date.parse('2026-11-22T10:00:00.123Z'));
  assert.equal('ports' in running, false, 'egress publishes no ports');
  assert.equal('lastError' in running, false);

  const unhealthy = buildModuleReport(
    inspectContainer({ moduleId: 'turn', image: 'coturn/coturn:4.6', health: 'unhealthy', error: 'health check failed' }),
    { moduleId: 'turn', nodeId: NODE_ID },
  );
  assert.equal(unhealthy.health, 'unhealthy');
  assert.equal(unhealthy.lastError, 'health check failed');
  assert.equal(unhealthy.version, '4.6');

  const starting = buildModuleReport(
    inspectContainer({ moduleId: 'stt', image: 'agil/node-stt:0.1.0', health: 'starting' }),
    { moduleId: 'stt', nodeId: NODE_ID },
  );
  assert.equal(starting.health, 'degraded', 'an unfinished health check is not silently healthy');

  const stopped = buildModuleReport(
    inspectContainer({ moduleId: 'stt', image: 'agil/node-stt:0.1.0', running: false, status: 'exited', exitCode: 0 }),
    { moduleId: 'stt', nodeId: NODE_ID },
  );
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.health, 'unknown');

  const crashed = buildModuleReport(
    inspectContainer({ moduleId: 'sip', image: 'agil/node-sip:0.1.0', running: false, status: 'exited', exitCode: 3 }),
    { moduleId: 'sip', nodeId: NODE_ID },
  );
  assert.equal(crashed.status, 'error');
  assert.equal(crashed.lastError, 'container exited with code 3');

  const restarting = buildModuleReport(
    (() => {
      const container = inspectContainer({ moduleId: 'recorder', image: 'agil/node-recorder:0.1.0' });
      container.State.Restarting = true;
      return container;
    })(),
    { moduleId: 'recorder', nodeId: NODE_ID },
  );
  assert.equal(restarting.status, 'error');

  const versioned = buildModuleReport(
    inspectContainer({
      moduleId: 'recorder',
      image: 'agil/node-recorder:latest',
      labels: { 'org.opencontainers.image.version': '0.3.1' },
    }),
    { moduleId: 'recorder', nodeId: NODE_ID },
  );
  assert.equal(versioned.version, '0.3.1', 'an image label wins over the tag');

  const digested = buildModuleReport(
    inspectContainer({ image: `agil/node-egress@sha256:${'b'.repeat(64)}` }),
    { moduleId: 'egress', nodeId: NODE_ID },
  );
  assert.equal('version' in digested, false, 'a digest has no invented version');
});

test('buildModuleReport: published ports, exposed-only fallback and dedupe', () => {
  const published = buildModuleReport(
    inspectContainer({
      moduleId: 'stt',
      image: 'agil/node-stt:0.1.0',
      ports: { '8090/tcp': [{ HostIp: '0.0.0.0', HostPort: '18090' }] },
    }),
    { moduleId: 'stt', nodeId: NODE_ID },
  );
  assert.deepEqual(published.ports, [18090]);

  const exposedOnly = buildModuleReport(
    inspectContainer({
      moduleId: 'turn',
      image: 'coturn/coturn:4.6',
      exposed: { '3478/udp': {}, '3478/tcp': {}, '5349/tcp': {} },
    }),
    { moduleId: 'turn', nodeId: NODE_ID },
  );
  assert.deepEqual(exposedOnly.ports, [3478, 5349], 'host networking reports EXPOSEd ports, deduped');

  const capped = buildModuleReport(
    inspectContainer({
      moduleId: 'sip',
      image: 'agil/node-sip:0.1.0',
      ports: Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`${5060 + index}/tcp`, [{ HostIp: '0.0.0.0', HostPort: String(6000 + index) }]]),
      ),
    }),
    { moduleId: 'sip', nodeId: NODE_ID },
  );
  assert.equal(capped.ports.length, 8, 'protocol caps ports at 8');
});

test('buildModuleReport: ownership and image allowlist are enforced on the report path', () => {
  assert.equal(
    buildModuleReport(inspectContainer({ nodeId: 'other-node' }), { moduleId: 'egress', nodeId: NODE_ID }),
    null,
    'another node\'s container is never reported',
  );
  assert.equal(
    buildModuleReport(inspectContainer({ image: 'evil/egress:1' }), { moduleId: 'egress', nodeId: NODE_ID }),
    null,
    'a non-allowlisted image is never reported',
  );
  assert.equal(
    buildModuleReport(inspectContainer({ moduleId: 'turn' }), { moduleId: 'egress', nodeId: NODE_ID }),
    null,
    'the label must match the allowlisted module id',
  );
  assert.equal(
    buildModuleReport(inspectContainer({ moduleId: 'Bad ID' }), { moduleId: 'Bad ID', nodeId: NODE_ID }),
    null,
    'invalid inventory ids are dropped',
  );
});

/* ------------------------------------------------- fake Docker: inventory */

test('inventory: discovers node-owned module containers and nothing else', async () => {
  const fake = await startFakeDocker();
  try {
    fake.addContainer({
      moduleId: 'egress',
      nodeId: NODE_ID,
      image: 'agil/node-egress:0.1.0',
      running: true,
      health: 'healthy',
      labels: { 'org.opencontainers.image.version': '0.1.0' },
    });
    fake.addContainer({
      moduleId: 'stt',
      nodeId: NODE_ID,
      image: 'agil/node-stt:0.2.0',
      running: false,
      ports: [{ port: 8090, protocol: 'tcp', hostPort: 18090 }],
    });
    // Not ours and foreign repositories on a reserved id never appear.
    fake.addContainer({ moduleId: 'turn', nodeId: 'other-node', image: 'coturn/coturn:4.6', running: true });
    fake.addContainer({ moduleId: 'egress', nodeId: NODE_ID, image: 'evil/egress:1', running: true });
    const grafana = fake.addContainer({ moduleId: 'grafana', nodeId: NODE_ID, image: 'grafana/grafana:10', running: true,
      labels: { 'agil.module.kind': 'monitoring' } });
    grafana.State.Error = 'Local Docker detail containing fixture configuration';
    const foreign = fake.addContainer({ moduleId: 'hidden-cache', nodeId: 'other-node', image: 'redis:7', running: true });
    fake.addContainer({ moduleId: 'sip', nodeId: NODE_ID, image: 'agil/node-sip:0.1.0', running: true, labels: { 'agil.module.version': '9.9.9' } });

    const { manager } = await makeManager(fake);
    const inventory = await manager.inventory();
    assert.ok(Array.isArray(inventory));
    assert.deepEqual(inventory.map((entry) => entry.id), ['egress', 'stt', 'sip', 'grafana'], 'catalog entries first');
    assert.equal(inventory.at(-1).kind, 'monitoring');
    assert.equal(inventory.at(-1).lastError, undefined);
    assert.ok(!fake.requests.some(({ path }) => path.endsWith(`/containers/${foreign.Id}/json`)));
    const initialRequests = fake.requests.length;
    assert.equal((await manager.executeCommand(moduleCommand('grafana', 'stop'))).ok, false);
    assert.equal(fake.requests.length, initialRequests);
    const egress = inventory.find((entry) => entry.id === 'egress');
    assert.equal(egress.status, 'running');
    assert.equal(egress.health, 'healthy');
    assert.equal(egress.image, 'agil/node-egress:0.1.0');
    assert.equal(egress.version, '0.1.0');
    const stt = inventory.find((entry) => entry.id === 'stt');
    assert.equal(stt.status, 'stopped');
    assert.deepEqual(stt.ports, [18090]);
    assert.equal(inventory.find((entry) => entry.id === 'sip').version, '9.9.9');
    assert.equal(manager.status().managed, 4);
    assert.equal(manager.status().available, true);
  } finally {
    await fake.close();
  }
});

test('inventory: docker socket absent is an agent-only node, not a crash', async () => {
  const { manager, logs } = await makeManager(null);
  assert.equal(manager.status().available, false);
  assert.equal(manager.status().enabled, true);
  assert.equal(await manager.inventory(), undefined, 'no snapshot is invented');
  assert.ok(logs.some((entry) => /agent-only node/.test(entry.message)), 'the fallback is logged once');

  // A lifecycle command is acknowledged as failed instead of throwing.
  const result = await manager.executeCommand(moduleCommand('stt', 'start'));
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unknown');
  assert.match(result.error, /Docker Engine is not reachable/i);
  assert.deepEqual(manager.pendingResults().map((entry) => entry.commandId), [result.commandId]);
});

test('Ingress lifecycle requires an exact opted-in Compose container and leaves deployment to the operator', async () => {
  const ingressId = 'a'.repeat(64);
  const image = 'docker.io/livekit/ingress:v1.6.0';
  const labels = { 'agil.module.lifecycle': 'true', 'com.docker.compose.service': 'ingress', 'com.docker.compose.project': 'fixture-compose' };
  const fake = await startFakeDocker({ stopExitCodes: { [image]: 143 } });
  try {
    const entry = fake.addContainer({ id: ingressId, moduleId: 'ingress', nodeId: NODE_ID, image,
      labels, running: true, health: 'healthy' });
    entry.HostConfig.NetworkMode = 'host';
    entry.HostConfig.Privileged = false;
    entry.Mounts = [];
    entry.Config.Env = ['INGRESS_CONFIG_BODY=ingress-fixture-private'];
    const { manager, logs } = await makeManager(fake);
    const run = (action, targetContainerId = ingressId) =>
      manager.executeCommand(moduleCommand('ingress', action, { targetContainerId, env: { INGRESS_CONFIG_BODY: 'caller-ignored' } }));
    const [reported] = await manager.inventory();
    assert.equal(reported.lifecycleContainerId, ingressId);
    assert.equal(reported.health, 'healthy');
    assert.doesNotMatch(JSON.stringify({ reported, logs }), /ingress-fixture-private|INGRESS_CONFIG_BODY/);
    assert.equal((await run('stop', 'b'.repeat(64))).ok, false);
    for (const action of ['install', 'remove', 'enable-autostart', 'disable-autostart']) {
      assert.equal((await run(action)).ok, false);
    }
    entry.Config.Labels['agil.module.lifecycle'] = 'false';
    assert.equal((await manager.inventory())[0].lifecycleContainerId, undefined);
    assert.equal((await run('stop')).ok, false);
    entry.Config.Labels['agil.module.lifecycle'] = 'true';
    entry.Config.Labels['com.docker.compose.service'] = 'other';
    assert.equal((await run('stop')).ok, false);
    entry.Config.Labels['com.docker.compose.service'] = 'ingress';
    entry.HostConfig.Privileged = true;
    assert.equal((await run('stop')).ok, false);
    entry.HostConfig.Privileged = false;
    assert.ok(!fake.requests.some(({ method }) => method === 'POST' || method === 'DELETE'));
    for (const [action, status] of [['stop', 'stopped'], ['start', 'running'], ['restart', 'running']]) {
      const result = await run(action);
      assert.equal(result.ok, true, result.error);
      assert.equal(result.status, status);
      assert.equal((await manager.inventory())[0].status, status);
    }
    assert.equal(entry.HostConfig.NetworkMode, 'host');
    assert.deepEqual(entry.Config.Env, ['INGRESS_CONFIG_BODY=ingress-fixture-private']);
    const mutating = fake.requests.filter(({ method }) => method === 'POST' || method === 'DELETE');
    assert.deepEqual(mutating.map(({ path }) => path.split('/').at(-1)), ['stop', 'start', 'restart']);
    assert.ok(mutating.every(({ path }) => path.includes(ingressId)));
  } finally {
    await fake.close();
  }
});

test('external SFU starts only an opted-in stopped Compose container on the local node', async () => {
  const targetContainerId = 'a'.repeat(64);
  const image = 'docker.io/livekit/livekit-server:v1.13.11';
  const fake = await startFakeDocker();
  try {
    const container = fake.addContainer({ id: targetContainerId, moduleId: 'sfu', nodeId: NODE_ID, image,
      labels: { 'agil.module.lifecycle': 'true', 'com.docker.compose.service': 'livekit', 'com.docker.compose.project': 'qa' } });
    container.HostConfig = { NetworkMode: 'host', Privileged: false };
    container.Mounts = [];
    container.Config.Env = ['LIVEKIT_CONFIG=private-local-config'];
    const { manager: bundled } = await makeManager(fake);
    assert.equal((await bundled.inventory())[0].lifecycleContainerId, undefined);
    assert.equal((await bundled.executeCommand(moduleCommand('sfu', 'start', { targetContainerId }))).ok, false);
    const { manager } = await makeManager(fake, { externalSfu: true });
    const run = (action, target = targetContainerId) => manager.executeCommand(moduleCommand('sfu', action, { targetContainerId: target }));
    assert.equal((await manager.inventory())[0].lifecycleContainerId, targetContainerId);
    assert.equal((await run('start', 'b'.repeat(64))).ok, false);
    for (const action of ['stop', 'restart', 'install', 'remove', 'enable-autostart']) assert.equal((await run(action)).ok, false);
    container.Config.Labels['agil.module.lifecycle'] = 'false';
    assert.equal((await run('start')).ok, false);
    container.Config.Labels['agil.module.lifecycle'] = 'true';
    container.State.Restarting = true;
    assert.equal((await run('start')).ok, false);
    container.State.Restarting = false;
    const started = await run('start');
    assert.equal(started.ok, true, started.error);
    assert.equal(started.status, 'running');
    assert.equal((await run('start')).ok, false);
    assert.deepEqual(container.Config.Env, ['LIVEKIT_CONFIG=private-local-config']);
    assert.doesNotMatch(JSON.stringify(await manager.inventory()), /LIVEKIT_CONFIG|private-local-config/);
    assert.deepEqual(fake.requests.filter(({ method }) => method === 'POST').map(({ path }) => path.split('/').at(-1)), ['start']);
  } finally {
    await fake.close();
  }
});

test('official Compose workers are observable but never modified or installed by the agent', async () => {
  const fake = await startFakeDocker();
  try {
    const { manager } = await makeManager(fake);
    for (const [moduleId, image, legacyImage] of [
      ['egress', 'docker.io/livekit/egress:v1.15.0', 'agil/node-egress:0.1.0'],
      ['sip', 'livekit/sip:v1.24', 'agil/node-sip:0.1.0'],
    ]) {
      const legacy = fake.addContainer({ moduleId, nodeId: NODE_ID, image: legacyImage, running: true });
      const compose = fake.addContainer({ moduleId, nodeId: NODE_ID, image, running: false });
      const [snapshot] = (await manager.inventory()).filter(({ id }) => id === moduleId);
      assert.equal(snapshot.image, image);
      assert.equal(snapshot.lifecycleContainerId, undefined);
      assert.equal(snapshot.autoStart, undefined);
      const requestStart = fake.requests.length;
      for (const action of ['start', 'stop', 'restart', 'remove', 'enable-autostart', 'disable-autostart', 'install']) {
        const result = await manager.executeCommand(moduleCommand(moduleId, action, { image: legacyImage }));
        assert.equal(result.ok, false, action);
        assert.match(result.error, /node Compose project/);
      }
      assert.ok(!fake.requests.slice(requestStart).some(({ method }) => method === 'POST' || method === 'DELETE'));
      assert.equal(legacy.State.Running, true);
      fake.containers.delete(compose.Id);
      assert.equal((await manager.executeCommand(moduleCommand(moduleId, 'stop'))).ok, true);
      assert.equal(legacy.State.Running, false);
    }
    await manager.close();
  } finally {
    await fake.close();
  }
});

test('Docker log snapshots require local ownership and opt-in and omit raw lines', async () => {
  const ownId = 'a'.repeat(64);
  const quietId = 'b'.repeat(64);
  const foreignId = 'c'.repeat(64);
  const tooLargeId = 'd'.repeat(64);
  const frame = (stream, line) => {
    const body = Buffer.from(line);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  };
  const first = '2026-11-27T06:01:02.123456789Z';
  const second = '2026-11-27T06:01:03Z';
  const raw = Buffer.concat([
    frame(1, `${first} {"level":"warn","message":"secret-sentinel-should-stay-local"}\n`),
    frame(2, `${second} [ERROR] A secret-sentinel-should-stay-local message\n`),
  ]);
  const fake = await startFakeDocker({ moduleLogs: {
    [ownId]: raw, [quietId]: raw, [foreignId]: raw, [tooLargeId]: Buffer.alloc(32 * 1024 + 1),
  } });
  try {
    fake.addContainer({ id: ownId, moduleId: 'qa-opted', nodeId: NODE_ID, image: 'local/image:1', labels: { 'agil.module.logs': 'true' } });
    fake.addContainer({ id: quietId, moduleId: 'qa-quiet', nodeId: NODE_ID, image: 'local/image:1' });
    fake.addContainer({ id: foreignId, moduleId: 'qa-other', nodeId: 'foreign-node', image: 'local/image:1', labels: { 'agil.module.logs': 'true' } });
    fake.addContainer({ id: tooLargeId, moduleId: 'qa-overflow', nodeId: NODE_ID, image: 'local/image:1', labels: { 'agil.module.logs': 'true' } });
    const tty = fake.addContainer({ id: 'e'.repeat(64), moduleId: 'qa-tty', nodeId: NODE_ID, image: 'local/image:1',
      labels: { 'agil.module.logs': 'true' } });
    tty.Config.Tty = true;
    const noDriver = fake.addContainer({ id: 'f'.repeat(64), moduleId: 'qa-no-driver', nodeId: NODE_ID, image: 'local/image:1',
      labels: { 'agil.module.logs': 'true' } });
    noDriver.HostConfig.LogConfig = { Type: 'none' };
    const { manager, logs } = await makeManager(fake);
    const inventory = await manager.inventory();
    const reports = new Map(inventory.map((item) => [item.id, item.logs]));
    assert.deepEqual(reports.get('qa-opted'), { status: 'ready', events: [
      { time: Date.parse(first), level: 'warn', stream: 'stdout' },
      { time: Date.parse(second), level: 'error', stream: 'stderr' },
    ] });
    assert.deepEqual(reports.get('qa-overflow'), { status: 'unavailable', events: [] });
    assert.equal(reports.get('qa-quiet'), undefined);
    assert.equal(reports.get('qa-tty'), undefined);
    assert.equal(reports.get('qa-no-driver'), undefined);
    assert.equal(reports.has('qa-other'), false);
    assert.ok(!JSON.stringify({ inventory, logs }).includes('secret-sentinel'));
    const requests = fake.requests.filter(({ path }) => path.endsWith('/logs'));
    assert.deepEqual(requests.map(({ path }) => path.split('/').at(-2)).sort(), [ownId, tooLargeId]);
    assert.ok(requests.every(({ method, query }) => method === 'GET' && query.tail === '16' && !('follow' in query)));
  } finally {
    await fake.close();
  }
});

test('local template catalog validates exact digests and never pulls or forwards configuration', async () => {
  const cached = { id: 'cache-armed', image: 'docker.io/library/redis@sha256:' + 'a'.repeat(64) };
  const missing = { id: 'web-preview', image: 'registry.example/team/nginx@sha256:' + 'b'.repeat(64) };
  const fake = await startFakeDocker({ imageInspections: {
    [cached.image]: { RepoDigests: [cached.image.replace('docker.io/library/', '')], Config: { Env: ['FIXTURE=hidden-value'] } },
    [missing.image]: { RepoDigests: ['another.example/team/nginx@sha256:' + 'b'.repeat(64)] },
  } });
  const templatesFile = path.join(fixtureDirectory, 'module-templates.json');
  try {
    const { manager, logs } = await makeManager(fake, { templatesFile });
    assert.equal(await manager.templateCatalog(), undefined);
    await writeFile(templatesFile, JSON.stringify([missing, cached]), { mode: 0o600 });
    assert.deepEqual(await manager.templateCatalog(), [{ ...cached, cached: true }, { ...missing, cached: false }]);
    const requestsBefore = fake.requests.length;
    for (const invalid of [
      [{ ...cached, image: 'registry.example/team/cache:latest' }],
      [{ ...cached, image: 'redis@sha256:' + 'a'.repeat(64) }],
      [{ ...cached, id: 'egress' }],
      [{ ...cached, env: { FIXTURE: 'hidden-value' } }],
      [cached, { ...cached, image: missing.image }],
    ]) {
      await writeFile(templatesFile, JSON.stringify(invalid));
      assert.deepEqual(await manager.templateCatalog(), []);
    }
    assert.equal(fake.requests.length, requestsBefore);
    assert.ok(fake.requests.every(({ method }) => method === 'GET'));
    assert.ok(!JSON.stringify(logs).includes('hidden-value'));
    await rm(templatesFile);
    assert.equal(await manager.templateCatalog(), undefined);
  } finally {
    await fake.close();
  }
});

test('local resource profiles control isolated Docker limits and ignore command overrides', async () => {
  const id = 'qa-resources';
  const image = 'registry.example/qa/worker@sha256:' + 'a'.repeat(64);
  const imageId = 'sha256:' + 'b'.repeat(64);
  let drift = true;
  const fake = await startFakeDocker({
    imageInspections: { [image]: { Id: imageId, Os: 'linux', RepoDigests: [image], Config: {} } },
    afterStart(container) {
      if (drift) container.HostConfig.NanoCpus = 500_000_000;
    },
  });
  const templatesFile = path.join(fixtureDirectory, 'resource-template.json');
  const configure = (resources) => writeFile(templatesFile, JSON.stringify([{ id, image, install: true, resources }]), { mode: 0o600 });
  try {
    const { manager } = await makeManager(fake, { templatesFile });
    for (const invalid of [{ cpuMillicores: 0 }, { memoryMiB: 8193 }, { pidsLimit: 32.1 }, { memory: 128 }, null]) {
      await configure(invalid);
      assert.deepEqual(await manager.templateCatalog(), []);
      assert.equal((await manager.executeCommand(moduleCommand(id, 'install', { image }))).ok, false);
    }
    assert.ok(!fake.requests.some(({ method }) => method === 'POST'));
    await configure({ cpuMillicores: 750, memoryMiB: 384 });
    assert.deepEqual(await manager.templateCatalog(), [{
      id, image, cached: true, installable: true, resources: { cpuMillicores: 750, memoryMiB: 384, pidsLimit: 64 },
    }]);
    const mismatched = await manager.executeCommand(moduleCommand(id, 'install', { image }));
    assert.match(mismatched.error, /Docker did not apply the approved resource limits/);
    assert.equal(fake.containers.size, 0);
    drift = false;
    const result = await manager.executeCommand(moduleCommand(id, 'install', {
      image, resources: { cpuMillicores: 8_000, memoryMiB: 8_192, pidsLimit: 512 },
    }));
    assert.equal(result.ok, true, result.error);
    const [container] = [...fake.containers.values()];
    assert.equal(container.HostConfig.NanoCpus, 750_000_000);
    assert.equal(container.HostConfig.Memory, 384 * 1024 * 1024);
    assert.equal(container.HostConfig.MemorySwap, 384 * 1024 * 1024);
    assert.equal(container.HostConfig.PidsLimit, 64);
    assert.equal(container.HostConfig.NetworkMode, 'none');
    assert.deepEqual(container.Mounts, []);
  } finally {
    await fake.close();
  }
});

test('template command arguments come only from the node and are verified before start and replacement', async () => {
  const id = 'qa-command-profile';
  const image = 'registry.example/qa/worker@sha256:' + 'a'.repeat(64);
  const replacement = 'registry.example/qa/worker@sha256:' + 'b'.repeat(64);
  const templatesFile = path.join(fixtureDirectory, 'command-template.json');
  const stateFile = path.join(fixtureDirectory, 'command-template-state.json');
  const commandArgs = ['worker', '--label', 'node-local arg with spaces & literal syntax', ''];
  const configure = (args, approvedImage = image) =>
    writeFile(templatesFile, JSON.stringify([{ id, image: approvedImage, install: true, commandArgs: args }]), { mode: 0o600 });
  let transformCreatedCommand;
  let duringStart;
  const fake = await startFakeDocker({
    imageInspections: Object.fromEntries([image, replacement].map((reference, index) => [reference, {
      Id: 'sha256:' + (index ? 'c' : 'd').repeat(64), Os: 'linux', RepoDigests: [reference], Config: {},
    }])),
    transformCreatedCommand: (args) => transformCreatedCommand?.(args) ?? args,
    afterStart: (container) => duringStart?.(container),
  });
  try {
    const { manager, logs } = await makeManager(fake, { templatesFile, stateFile });
    const install = () => manager.executeCommand(moduleCommand(id, 'install', { image, commandArgs: ['caller-supplied'] }));
    for (const invalid of ['a command string', [], [123], [String.fromCharCode(0)], ['é'.repeat(257)], Array(17).fill('arg')]) {
      await configure(invalid);
      assert.deepEqual(await manager.templateCatalog(), []);
    }
    await configure(commandArgs);
    const preview = await manager.templateCatalog();
    assert.deepEqual(preview, [{ id, image, cached: true, installable: true }]);
    const localEndpoint = manager.docker.connection;
    manager.docker.connection = { host: 'docker.example', port: 2375 };
    assert.match((await install()).error, /node-local Docker endpoint/);
    manager.docker.connection = localEndpoint;
    transformCreatedCommand = () => ['Docker-changed-command'];
    const before = fake.requests.length;
    assert.match((await install()).error, /Docker did not apply the approved command arguments/);
    assert.equal(fake.containers.size, 0);
    assert.ok(fake.requests.slice(before).every(({ method, path }) => method !== 'POST' || !path.endsWith('/start')));
    transformCreatedCommand = undefined;
    const installed = await install();
    assert.equal(installed.ok, true, installed.error);
    const [container] = [...fake.containers.values()];
    assert.deepEqual(container.Config.Cmd, commandArgs);
    await configure(['second-command'], replacement);
    duringStart = () => configure(['changed-during-startup'], replacement);
    const update = await manager.executeCommand(moduleCommand(id, 'install', { image: replacement, targetContainerId: container.Id }));
    assert.match(update.error, /cancelled before stopping/);
    assert.equal(container.State.Running, true);
    assert.deepEqual([...fake.containers.keys()], [container.Id]);
    const exported = JSON.stringify({ report: await manager.inventory(), preview, logs, state: await readFile(stateFile, 'utf8'), update });
    assert.ok(!exported.includes(commandArgs[2]));
    assert.ok(!exported.includes('caller-supplied'));
    assert.ok(!exported.includes('changed-during-startup'));
    await manager.close();
  } finally {
    await fake.close();
  }
});

test('template healthcheck accepts only the local configuration and requires positive Docker health', async () => {
  const id = 'qa-probe';
  const image = 'registry.example/qa/worker@sha256:' + 'a'.repeat(64);
  const templatesFile = path.join(fixtureDirectory, 'health-template.json');
  const stateFile = path.join(fixtureDirectory, 'health-template-state.json');
  const configure = (healthcheck) => writeFile(templatesFile, JSON.stringify([{ id, image, install: true, healthcheck }]), { mode: 0o600 });
  let health = 'unhealthy';
  const fake = await startFakeDocker({
    imageInspections: { [image]: { Id: 'sha256:' + 'b'.repeat(64), Os: 'linux', RepoDigests: [image], Config: {} } },
    afterStart: (container) => {
      container.State.Health = { Status: health, Log: [{ Output: 'local-probe-log-private' }] };
    },
  });
  try {
    const { manager, logs } = await makeManager(fake, { templatesFile, stateFile });
    const install = () => manager.executeCommand(moduleCommand(id, 'install', { image, healthcheck: { command: ['caller-probe'] } }));
    for (const invalid of [null, { command: [] }, { command: [''] }, { command: ['x'], retries: 0 },
      { command: ['x'], startupTimeoutSec: 2 }, { command: ['x'], startupTimeoutSec: 91 }, { command: ['x'], shell: true }]) {
      await configure(invalid);
      assert.deepEqual(await manager.templateCatalog(), []);
    }
    await configure({ command: ['node-local-probe', '--ready'], intervalSec: 1, startupTimeoutSec: 2 });
    const preview = await manager.templateCatalog();
    assert.deepEqual(preview, [{ id, image, cached: true, installable: true }]);
    const endpoint = manager.docker.connection;
    manager.docker.connection = { host: 'docker.example', port: 2375 };
    assert.match((await install()).error, /node-local Docker endpoint/);
    manager.docker.connection = endpoint;
    assert.match((await install()).error, /approved healthcheck did not pass/);
    assert.equal(fake.containers.size, 0);
    health = 'starting';
    assert.match((await install()).error, /approved healthcheck did not pass/);
    assert.equal(fake.containers.size, 0);
    health = 'healthy';
    const installed = await install();
    assert.equal(installed.ok, true, installed.error);
    const [container] = [...fake.containers.values()];
    assert.deepEqual(container.Config.Healthcheck.Test, ['CMD', 'node-local-probe', '--ready']);
    const disclosed = JSON.stringify({ preview, logs, reports: await manager.inventory(), state: await readFile(stateFile, 'utf8') });
    assert.doesNotMatch(disclosed, /node-local-probe|caller-probe|local-probe-log-private/);
    await manager.close();
  } finally {
    await fake.close();
  }
});

test('private environment references select local values and never enter reports or the state file', async () => {
  const id = 'qa-private-env';
  const image = 'registry.example/qa/worker@sha256:' + 'a'.repeat(64);
  const replacement = 'registry.example/qa/worker@sha256:' + 'd'.repeat(64);
  const templatesFile = path.join(fixtureDirectory, 'environment-template.json');
  const envFile = path.join(fixtureDirectory, 'local-template-values.json');
  const stateFile = path.join(fixtureDirectory, 'environment-template-state.json');
  const configure = (envRefs, approvedImage = image) =>
    writeFile(templatesFile, JSON.stringify([{ id, image: approvedImage, install: true, envRefs }]), { mode: 0o600 });
  const writeValues = (value) => writeFile(envFile, JSON.stringify({
    [id]: { QA_LOCAL_SECRET: value, UNSELECTED: 'unused-local-sentinel' },
    'another-module': { QA_LOCAL_SECRET: 'foreign-local-sentinel' },
  }), { mode: 0o600 });
  let actionDuringStart;
  const fake = await startFakeDocker({
    imageInspections: {
      [image]: { Id: 'sha256:' + 'b'.repeat(64), Os: 'linux', RepoDigests: [image], Config: {} },
      [replacement]: { Id: 'sha256:' + 'c'.repeat(64), Os: 'linux', RepoDigests: [replacement], Config: {} },
    },
    afterStart: (container) => actionDuringStart?.(container),
  });
  try {
    const { manager, logs } = await makeManager(fake, { templatesFile, envFile, stateFile });
    for (const invalid of [['QA_LOCAL_SECRET', 'QA_LOCAL_SECRET'], ['not-an-env-name'], Array.from({ length: 17 }, (_, i) => 'ENV_' + i)]) {
      await configure(invalid);
      assert.deepEqual(await manager.templateCatalog(), []);
    }
    await configure(['QA_LOCAL_SECRET']);
    const install = () => manager.executeCommand(moduleCommand(id, 'install', { image, env: { QA_LOCAL_SECRET: 'caller-sentinel' } }));
    assert.equal((await manager.templateCatalog())[0].blockedReason, 'environment_unavailable');
    assert.match((await install()).error, /local environment values are unavailable/);
    await writeValues('x'.repeat(4097));
    assert.equal((await manager.templateCatalog())[0].blockedReason, 'environment_unavailable');
    assert.ok(!fake.requests.some(({ method }) => method === 'POST'));

    await writeValues('initial-local-sentinel');
    for (const [dockerHost, local] of [
      ['unix:///var/run/docker.sock', true],
      ['npipe:////./pipe/docker_engine', true],
      ['npipe:////remote/pipe/docker_engine', false],
      ['tcp://127.0.0.1:2375', true],
      ['tcp://[::1]:2375', true],
      ['tcp://docker.example:2375', false],
    ]) {
      assert.equal(new DockerClient({ dockerHost }).nodeLocal, local, dockerHost);
    }
    const localEndpoint = manager.docker.connection;
    manager.docker.connection = { host: 'docker.example', port: 2375 };
    assert.equal(await manager._readTemplateEnvironmentSource(), null);
    manager.docker.connection = localEndpoint;
    actionDuringStart = () => writeValues('rotated-local-sentinel');
    assert.match((await install()).error, /local template changed during startup/);
    assert.equal(fake.containers.size, 0);
    actionDuringStart = (container) => { container.Config.Env = []; };
    assert.match((await install()).error, /Docker did not apply the approved environment/);
    assert.equal(fake.containers.size, 0);
    actionDuringStart = undefined;
    const completed = await install();
    assert.equal(completed.ok, true, completed.error);
    const [container] = [...fake.containers.values()];
    assert.deepEqual(container.Config.Env, ['QA_LOCAL_SECRET=rotated-local-sentinel']);
    await configure(['QA_LOCAL_SECRET'], replacement);
    actionDuringStart = () => writeValues('latest-local-sentinel');
    const cancelledReplacement = await manager.executeCommand(moduleCommand(id, 'install', {
      image: replacement, targetContainerId: container.Id,
    }));
    assert.match(cancelledReplacement.error, /cancelled before stopping/);
    assert.equal(container.State.Running, true);
    assert.deepEqual([...fake.containers.keys()], [container.Id]);
    actionDuringStart = undefined;
    await configure(['QA_LOCAL_SECRET'], image);
    assert.equal((await manager.templateCatalog())[0].profileChanged, true);
    const rotated = await manager.executeCommand(moduleCommand(id, 'install', { image, targetContainerId: container.Id }));
    assert.equal(rotated.ok, true, rotated.error);
    const [updated] = [...fake.containers.values()];
    assert.notEqual(updated.Id, container.Id);
    assert.deepEqual(updated.Config.Env, ['QA_LOCAL_SECRET=latest-local-sentinel']);
    assert.equal((await manager.templateCatalog())[0].profileChanged, undefined);
    const disclosed = JSON.stringify({ templates: await manager.templateCatalog(), inventory: await manager.inventory(),
      results: manager.pendingResults(), logs, state: await readFile(stateFile, 'utf8') });
    assert.doesNotMatch(disclosed, /sentinel|QA_LOCAL_SECRET|UNSELECTED|envRefs/);
  } finally {
    await fake.close();
  }
});

test('approved template storage mounts only an owned local volume read-only and leaves it after removal', async () => {
  const id = 'qa-model';
  const image = 'registry.example/qa/model@sha256:' + 'a'.repeat(64);
  const imageId = 'sha256:' + 'b'.repeat(64);
  const volumeName = 'qa-private-volume';
  const labels = { 'agil.node': NODE_ID, 'agil.module': id, 'agil.module.storage': 'true' };
  const volume = { Name: volumeName, Driver: 'local', Scope: 'local', Options: null, Labels: { ...labels } };
  const volumeInspections = {};
  const fake = await startFakeDocker({
    imageInspections: { [image]: { Id: imageId, Os: 'linux', RepoDigests: [image], Config: {} } }, volumeInspections,
  });
  const templatesFile = path.join(fixtureDirectory, 'storage-template.json');
  const stateFile = path.join(fixtureDirectory, 'storage-template-state.json');
  const configure = (storageVolume) => writeFile(templatesFile,
    JSON.stringify([{ id, image, install: true, storageVolume }]), { mode: 0o600 });
  try {
    const config = { templatesFile, stateFile };
    let { manager } = await makeManager(fake, config);
    await configure('/var/run/docker.sock');
    assert.deepEqual(await manager.templateCatalog(), []);
    await configure(volumeName);
    const install = () => manager.executeCommand(moduleCommand(id, 'install', {
      image, storageVolume: 'foreign-variable', mounts: [{ source: '/etc', target: '/unsafe' }],
    }));
    for (const invalid of [
      undefined, { ...volume, Driver: 'nfs' }, { ...volume, Scope: 'global' },
      { ...volume, Options: { o: 'bind', device: '/etc' } },
      { ...volume, Labels: { ...labels, 'agil.node': 'foreign' } },
      { ...volume, Labels: { ...labels, 'agil.module': 'another' } },
      { ...volume, Labels: { ...labels, 'agil.module.storage': 'false' } },
    ]) {
      volumeInspections[volumeName] = invalid;
      assert.deepEqual((await manager.templateCatalog())[0], {
        id, image, cached: true, storage: 'read_only', blockedReason: 'storage_unavailable',
      });
      assert.match((await install()).error, /local storage is unavailable/);
    }
    assert.ok(!fake.requests.some(({ method }) => method === 'POST'));
    volumeInspections[volumeName] = volume;
    assert.equal((await install()).ok, true);
    const [installed] = [...fake.containers.values()];
    assert.deepEqual(installed.HostConfig.Mounts, [{
      Type: 'volume', Source: volumeName, Target: '/agil-data', ReadOnly: true, VolumeOptions: { NoCopy: true },
    }]);
    assert.equal(installed.HostConfig.NetworkMode, 'none');
    assert.doesNotMatch(JSON.stringify(await manager.templateCatalog()), /qa-private-volume/);
    await manager.close();
    ({ manager } = await makeManager(fake, config));
    assert.equal((await manager.inventory())[0].templateRemovable, true);
    const remove = () => manager.executeCommand(moduleCommand(id, 'remove', { targetContainerId: installed.Id }));
    volume.Labels['agil.node'] = 'foreign';
    assert.equal((await manager.inventory())[0].lifecycleContainerId, undefined);
    assert.equal((await remove()).ok, false);
    volume.Labels['agil.node'] = NODE_ID;
    assert.equal((await remove()).ok, true);
    assert.deepEqual((await manager.docker.inspectVolume(volumeName)).Labels, labels);
    assert.equal(fake.requests.find(({ method }) => method === 'DELETE').query.v, '0');
  } finally {
    await fake.close();
  }
});

test('template installation uses only the approved cache entry and compensates partial failures', async () => {
  const entries = ['ready', 'refused', 'recovered', 'touchless', 'volume'].map((id, index) => ({
    id: `custom-${id}`, image: 'registry.example/qa/worker@sha256:' + String(index).repeat(64),
    install: id !== 'touchless',
  }));
  const imageIds = entries.map((_, index) => 'sha256:' + (index + 5).toString(16).repeat(64));
  const fake = await startFakeDocker({
    imageInspections: Object.fromEntries(entries.map(({ image, id }, index) => [image, {
      Id: imageIds[index], Os: 'linux', RepoDigests: [image], Config: id === 'custom-volume' ? { Volumes: { '/data': {} } } : {},
    }])),
    failStartImages: [imageIds[1]],
    failCreateResponseImages: [imageIds[2]],
    failStartResponseImages: [imageIds[2]],
  });
  const templatesFile = path.join(fixtureDirectory, 'module-install-templates.json');
  await writeFile(templatesFile, JSON.stringify(entries), { mode: 0o600 });
  try {
    const { manager } = await makeManager(fake, { templatesFile });
    const report = await manager.templateCatalog();
    assert.deepEqual(report.filter(({ installable }) => installable).map(({ id }) => id),
      ['custom-ready', 'custom-recovered', 'custom-refused']);
    const install = (index, overrides = {}) => manager.executeCommand(moduleCommand(entries[index].id, 'install', {
      image: entries[index].image, ...overrides,
    }));
    for (const result of [await install(3), await install(4), await install(0, { image: entries[2].image })]) {
      assert.equal(result.ok, false);
    }
    assert.equal(fake.requests.some(({ method }) => method === 'POST'), false);
    assert.equal((await install(0, { env: { token: 'secret' }, ports: [8080], command: ['unapproved'] })).status, 'running');
    assert.equal((await install(0)).ok, false, 'an existing module is never replaced');
    assert.equal((await install(1)).ok, false);
    assert.equal((await install(2)).status, 'running');
    assert.deepEqual((await manager.inventory()).map(({ id, status }) => [id, status]).sort(),
      [['custom-ready', 'running'], ['custom-recovered', 'running']]);
    assert.equal(fake.pulls.length, 0);
    const mutations = fake.requests.filter(({ method }) => method === 'POST' || method === 'DELETE');
    const create = mutations.find(({ method, body }) => method === 'POST' && body?.Image === imageIds[0]);
    assert.equal(create.body.User, '65534:65534');
    assert.equal(create.body.HostConfig.NetworkMode, 'none');
    assert.equal(create.body.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(create.body.HostConfig.CapDrop, ['ALL']);
    assert.deepEqual(create.body.HostConfig.SecurityOpt, ['no-new-privileges:true']);
    assert.equal(create.body.HostConfig.Memory, 256 * 1024 * 1024);
    assert.equal(create.body.HostConfig.PidsLimit, 64);
    for (const key of ['Env', 'ExposedPorts', 'Cmd', 'Entrypoint']) assert.ok(!(key in create.body));
    for (const key of ['Mounts', 'Binds', 'PortBindings', 'Devices', 'CapAdd']) assert.ok(!(key in create.body.HostConfig));
    assert.equal(mutations.filter(({ method }) => method === 'DELETE').length, 1);
    assert.ok(!JSON.stringify(mutations).includes('secret'));
  } finally {
    await fake.close();
    await rm(templatesFile, { force: true });
  }
});

test('template installation reports image problems and rolls back only a candidate that fails startup', async () => {
  const templates = ['missing', 'incompatible', 'inspect', 'crash', 'one-shot'].map((name, index) => ({
    id: `qa-${name}`, image: 'registry.example/qa/worker@sha256:' + String(index).repeat(64), install: true,
  }));
  const ids = templates.map((_, index) => 'sha256:' + String(index + 5).repeat(64));
  const imageInspection = (index, config = {}) => ({
    Id: ids[index], Os: 'linux', RepoDigests: [templates[index].image], Config: config,
  });
  const fake = await startFakeDocker({
    imageInspections: {
      [templates[1].image]: imageInspection(1, { Volumes: { '/data': {} } }),
      [templates[3].image]: imageInspection(3),
      [templates[4].image]: imageInspection(4),
    },
    failImageInspections: [templates[2].image],
    exitAfterStartCodes: { [ids[3]]: 23, [ids[4]]: 0 },
  });
  const templatesFile = path.join(fixtureDirectory, 'failed-template-install.json');
  await writeFile(templatesFile, JSON.stringify(templates), { mode: 0o600 });
  try {
    const other = fake.addContainer({ moduleId: 'qa-existing', nodeId: NODE_ID, image: 'alpine:3.20', running: true });
    const { manager } = await makeManager(fake, { templatesFile });
    const byId = Object.fromEntries((await manager.templateCatalog()).map((template) => [template.id, template]));
    assert.equal(byId['qa-missing'].blockedReason, 'image_not_cached');
    assert.equal(byId['qa-incompatible'].blockedReason, 'image_incompatible');
    assert.equal(byId['qa-inspect'].blockedReason, 'inspection_failed');
    const install = ({ id, image }) => manager.executeCommand(moduleCommand(id, 'install', { image }));
    for (const [index, error] of [/missing from the local cache/, /cannot run in the isolated profile/, /could not verify/].entries()) {
      const result = await install(templates[index]);
      assert.equal(result.ok, false);
      assert.match(result.error, error);
    }
    assert.equal(fake.requests.some(({ method }) => method === 'POST'), false);
    const crashed = await install(templates[3]);
    assert.equal(crashed.ok, false);
    assert.match(crashed.error, /code 23.*container was removed/);
    const oneShot = await install(templates[4]);
    assert.equal(oneShot.ok, true);
    assert.equal(oneShot.status, 'stopped');
    assert.equal(other.State.Running, true);
    assert.deepEqual((await manager.inventory()).map(({ id }) => id).sort(), ['qa-existing', 'qa-one-shot']);
    assert.equal(fake.pulls.length, 0);
    const deletes = fake.requests.filter(({ method }) => method === 'DELETE');
    assert.equal(deletes.length, 1);
    assert.deepEqual(deletes[0].query, { force: '0', v: '0' });
  } finally {
    await fake.close();
  }
});

test('template replacement stages the approved digest and compensates failed startup and promotion', async () => {
  const moduleId = 'qa-replacement';
  const images = ['a', 'b', 'c'].map((prefix) => 'registry.example/qa/worker@sha256:' + prefix.repeat(64));
  const ids = ['d', 'e', 'f'].map((prefix) => 'sha256:' + prefix.repeat(64));
  const failRemoveIds = [];
  let revokeOnStart;
  const fake = await startFakeDocker({
    imageInspections: Object.fromEntries(images.map((image, index) =>
      [image, { Id: ids[index], Os: 'linux', RepoDigests: [image], Config: {} }])),
    failRemoveIds,
    afterStart: (container) => revokeOnStart?.(container),
    exitAfterStartCodes: { [ids[2]]: 15 },
  });
  const stateFile = path.join(fixtureDirectory, 'replacement-state.json');
  const templatesFile = path.join(fixtureDirectory, 'replacement-templates.json');
  const config = { stateFile, templatesFile };
  const approve = (image, resources, restartPolicy) =>
    writeFile(templatesFile, JSON.stringify([{ id: moduleId, image, install: true, resources, restartPolicy }]), { mode: 0o600 });
  try {
    let { manager } = await makeManager(fake, config);
    const run = (image, targetContainerId) => manager.executeCommand(moduleCommand(moduleId, 'install', { image, targetContainerId }));
    const running = async (image) => {
      const inventory = await manager.inventory();
      assert.equal(inventory.length, 1);
      assert.equal(inventory[0].image, image);
      assert.equal(inventory[0].status, 'running');
      assert.equal(inventory[0].templateRemovable, true);
      return inventory[0].lifecycleContainerId;
    };
    for (const invalid of ['always', 'unless-stopped', 'on-failure:0', { name: 'on-failure', maxRetries: 50 }, null]) {
      await approve(images[0], undefined, invalid);
      assert.deepEqual(await manager.templateCatalog(), []);
    }
    await approve(images[0], undefined, 'on-failure');
    const localEndpoint = manager.docker.connection;
    manager.docker.connection = { host: 'docker.example', port: 2375 };
    assert.match((await run(images[0])).error, /restart policy requires the node-local Docker endpoint/);
    manager.docker.connection = localEndpoint;
    const persist = manager._persist;
    manager._persist = async () => false;
    try {
      assert.match((await run(images[0])).error, /ownership could not be saved/);
      assert.equal(fake.containers.size, 0);
    } finally {
      manager._persist = persist;
    }
    assert.equal((await run(images[0])).ok, true);
    const oldId = await running(images[0]);
    assert.deepEqual(fake.containers.get(oldId).HostConfig.RestartPolicy, { Name: 'on-failure', MaximumRetryCount: 3 });
    await approve(images[2]);
    assert.equal((await run(images[2], '0'.repeat(64))).ok, false);
    assert.equal((await run(images[0], oldId)).ok, false);
    assert.match((await run(images[2], oldId)).error, /code 15/);
    assert.equal(await running(images[0]), oldId);
    assert.ok(!fake.requests.some(({ path }) => path.includes(`/containers/${oldId}/stop`)));
    await approve(images[1], undefined, 'on-failure');
    revokeOnStart = (container) => { container.State.Restarting = true; };
    assert.match((await run(images[1], oldId)).error, /could not start the approved module/);
    revokeOnStart = undefined;
    assert.equal(await running(images[0]), oldId);
    assert.deepEqual([...fake.containers.keys()], [oldId]);
    await approve(images[1]);
    revokeOnStart = (container) => container.Config.Image === ids[1] ? approve(images[0]) : undefined;
    assert.match((await run(images[1], oldId)).error, /cancelled before stopping/);
    revokeOnStart = undefined;
    assert.equal(await running(images[0]), oldId);
    assert.ok(!fake.requests.some(({ path }) => path.includes(`/containers/${oldId}/stop`)));
    await approve(images[1]);
    revokeOnStart = (container) => container.Config.Image === ids[1] ? approve(images[1], { memoryMiB: 512 }) : undefined;
    assert.match((await run(images[1], oldId)).error, /cancelled before stopping/);
    revokeOnStart = undefined;
    assert.equal(await running(images[0]), oldId);
    assert.ok(!fake.requests.some(({ path }) => path.includes(`/containers/${oldId}/stop`)));
    await approve(images[1]);
    revokeOnStart = () => approve(images[1], undefined, 'on-failure');
    assert.match((await run(images[1], oldId)).error, /cancelled before stopping/);
    revokeOnStart = undefined;
    assert.equal(await running(images[0]), oldId);
    await approve(images[1]);
    failRemoveIds.push(oldId);
    assert.match((await run(images[1], oldId)).error, /previous container is running/);
    assert.equal(await running(images[0]), oldId);
    assert.deepEqual(fake.containers.get(oldId).HostConfig.RestartPolicy, { Name: 'on-failure', MaximumRetryCount: 3 });
    failRemoveIds.length = 0;
    assert.equal((await run(images[1], oldId)).ok, true);
    const newId = await running(images[1]);
    assert.deepEqual(fake.containers.get(newId).HostConfig.RestartPolicy, { Name: 'no', MaximumRetryCount: 0 });
    assert.notEqual(newId, oldId);
    assert.equal(fake.containers.has(oldId), false);
    await manager.close();
    ({ manager } = await makeManager(fake, config));
    assert.equal(await running(images[1]), newId);
    await approve(images[0]);
    assert.equal((await run(images[0], newId)).ok, true);
    assert.notEqual(await running(images[0]), oldId);
    assert.equal(fake.pulls.length, 0);
    assert.ok(fake.requests.filter(({ method }) => method === 'DELETE').every(({ query }) =>
      query.force === '0' && query.v === '0'));
  } finally {
    await fake.close();
  }
});

test('recorded template provenance survives agent restart and limits removal to its exact isolated container', async () => {
  const id = 'custom-managed';
  const name = 'registry.example/qa/test@sha256:' + 'a'.repeat(64);
  const imageId = 'sha256:' + 'b'.repeat(64);
  const fake = await startFakeDocker({
    imageInspections: { [name]: { Id: imageId, Os: 'linux', RepoDigests: [name], Config: {} } },
    stopExitCodes: { [imageId]: 143 },
  });
  const stateFile = path.join(fixtureDirectory, 'template-removal-state.json');
  const templatesFile = path.join(fixtureDirectory, 'template-removal.json');
  try {
    await writeFile(templatesFile, JSON.stringify([{ id, image: name, install: true }]), { mode: 0o600 });
    const { manager: first } = await makeManager(fake, { stateFile, templatesFile });
    const installed = await first.executeCommand(moduleCommand(id, 'install', { image: name, env: { SECRET: 'ignored-sensitive-fixture' } }));
    assert.equal(installed.status, 'running');
    const [initial] = await first.inventory();
    assert.equal(initial.templateRemovable, true);
    assert.ok(!(await readFile(stateFile, 'utf8')).includes('ignored-sensitive-fixture'));
    await first.close();
    let { manager: restarted } = await makeManager(fake, { stateFile, templatesFile });
    assert.equal((await restarted.inventory())[0].templateRemovable, true);
    const target = initial.lifecycleContainerId;
    const action = (verb, moduleId = id, targetContainerId = target) =>
      restarted.executeCommand(moduleCommand(moduleId, verb, { targetContainerId }));
    assert.equal((await action('stop')).status, 'stopped');
    await restarted.close();
    ({ manager: restarted } = await makeManager(fake, { stateFile, templatesFile }));
    const [stopped] = await restarted.inventory();
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.lastError, undefined);
    fake.containers.get(target).State.FinishedAt = '2026-01-01T01:00:00.000Z';
    assert.equal((await restarted.inventory())[0].status, 'error');
    for (const [verb, status] of [['start', 'running'], ['restart', 'running']]) {
      const result = await action(verb);
      assert.equal(result.ok, true, result.error);
      assert.equal(result.status, status);
    }
    const active = fake.containers.get(target);
    const impostor = fake.addContainer({
      id: 'f'.repeat(64), moduleId: 'custom-impostor', nodeId: NODE_ID, image: imageId,
      running: true, labels: { ...active.Config.Labels, 'agil.module': 'custom-impostor' },
    });
    impostor.HostConfig = { ...active.HostConfig };
    impostor.Mounts = [];
    impostor.Config.User = active.Config.User;
    impostor.Image = imageId;
    assert.equal((await action('remove', 'custom-impostor', impostor.Id)).ok, false);
    assert.equal((await action('remove', id, impostor.Id)).ok, false);
    active.HostConfig.NetworkMode = 'bridge';
    assert.equal((await action('remove')).ok, false);
    assert.equal(active.State.Running, true);
    active.HostConfig.NetworkMode = 'none';
    active.NetworkSettings.Networks = { 'external-network': {} };
    assert.equal((await action('remove')).ok, false);
    delete active.NetworkSettings.Networks;
    assert.equal((await action('remove')).ok, true);
    assert.deepEqual((await restarted.inventory()).map(({ id: entryId }) => entryId), ['custom-impostor']);
    const deletes = fake.requests.filter(({ method }) => method === 'DELETE');
    assert.equal(deletes.length, 1);
    assert.match(deletes[0].path, new RegExp(target));
    assert.deepEqual(deletes[0].query, { force: '0', v: '0' });
    assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')).templateContainers, []);
    await restarted.close();
  } finally {
    await fake.close();
  }
});

test('custom lifecycle requires local approval and an isolated unique container', async () => {
  const fake = await startFakeDocker();
  try {
    const add = (id, moduleId, owner = NODE_ID, host = {}, mounts = []) => {
      const container = fake.addContainer({ id: id.repeat(64), moduleId, nodeId: owner, image: 'alpine:3.20', running: true,
        labels: { 'agil.module.lifecycle': 'true' } });
      Object.assign(container.HostConfig, { Privileged: false, ...host });
      container.Mounts = mounts;
      return container;
    };
    const owned = add('a', 'cache');
    const foreign = add('b', 'cache', 'another-node');
    add('c', 'host-net', NODE_ID, { NetworkMode: 'host' });
    add('d', 'privileged', NODE_ID, { Privileged: true });
    add('e', 'extra-caps', NODE_ID, { CapAdd: ['SYS_ADMIN'] });
    add('f', 'unsafe-mount', NODE_ID, {}, [{ Type: 'bind', Source: '/var/run/docker.sock' }]);
    add('0', 'unsafe-security', NODE_ID, { SecurityOpt: ['seccomp=unconfined'] });
    const { manager } = await makeManager(fake);
    const inventory = await manager.inventory();
    assert.deepEqual(inventory.filter(({ lifecycleContainerId }) => lifecycleContainerId)
      .map(({ id, lifecycleContainerId }) => [id, lifecycleContainerId]), [['cache', owned.Id]]);
    const command = (action, targetContainerId = owned.Id) =>
      manager.executeCommand(moduleCommand('cache', action, { targetContainerId }));
    assert.equal((await command('stop', foreign.Id)).ok, false);
    assert.equal((await command('remove')).ok, false);
    assert.equal((await command('stop')).status, 'stopped');
    assert.equal((await command('start')).status, 'running');
    assert.equal((await command('restart')).ok, true);
    const duplicate = add('1', 'cache');
    assert.equal((await manager.inventory()).find(({ id }) => id === 'cache').lifecycleContainerId, undefined);
    assert.equal((await command('stop')).ok, false);
    fake.containers.delete(duplicate.Id);
    owned.HostConfig.Privileged = true;
    assert.equal((await command('stop')).ok, false, 'agent rechecks runtime after Core queues');
    assert.equal(owned.State.Running, true);
    assert.equal(foreign.State.Running, true);
  } finally {
    await fake.close();
  }
});

test('inventory: a Docker daemon that stops answering degrades to no snapshot', async () => {
  const fake = await startFakeDocker();
  try {
    const { manager } = await makeManager(fake);
    assert.deepEqual(await manager.inventory(), []);
    fake.setPingFails(true);
    fake.close();
    const snapshot = await manager.inventory();
    assert.equal(snapshot, undefined);
    assert.equal(manager.status().available, false);
  } finally {
    await fake.close();
  }
});

test('inventory: duplicate containers for one module prefer the running one', async () => {
  const fake = await startFakeDocker();
  try {
    fake.addContainer({ moduleId: 'recorder', nodeId: NODE_ID, image: 'agil/node-recorder:0.1.0', running: false });
    fake.addContainer({ moduleId: 'recorder', nodeId: NODE_ID, image: 'agil/node-recorder:0.2.0', running: true });
    const { manager } = await makeManager(fake);
    const inventory = await manager.inventory();
    assert.equal(inventory.length, 1);
    assert.equal(inventory[0].status, 'running');
    assert.equal(inventory[0].version, '0.2.0');
  } finally {
    await fake.close();
  }
});

/* -------------------------------------------------- fake Docker: commands */

test('install: pulls the command image, creates a labelled container and starts it', async () => {
  const fake = await startFakeDocker();
  try {
    const { manager, logs } = await makeManager(fake);
    const command = moduleCommand('stt', 'install');
    const result = await manager.executeCommand(command);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'running');
    assert.deepEqual(fake.pulls.map((pull) => pull.image), ['agil/node-stt:0.1.0']);

    const created = [...fake.containers.values()];
    assert.equal(created.length, 1);
    assert.equal(created[0].Config.Image, 'agil/node-stt:0.1.0');
    assert.deepEqual(created[0].Config.Labels, {
      'agil.module': 'stt',
      'agil.node': NODE_ID,
      'agil.managed': 'true',
    });
    assert.equal(created[0].State.Running, true, 'install starts the container');
    assert.ok(created[0].Config.ExposedPorts['8090/tcp'], 'agent publishes the catalog port');
    assert.deepEqual(manager.pendingResults().map((entry) => entry.commandId), [command.id]);

    // The result is JSON-shaped and bounded; no env/secret appears in logs.
    assert.ok(logs.some((entry) => entry.message === 'module command executed' && entry.extra.ok === true));
    assert.ok(!JSON.stringify(logs).includes('STT_MODEL_PATH'));
  } finally {
    await fake.close();
  }
});

test('install: node-local env file values reach Docker but never logs or reports', async () => {
  const fake = await startFakeDocker();
  const dir = await mkdtemp(path.join(tmpdir(), 'agil-modules-env-'));
  try {
    const envFile = path.join(dir, 'module-env.json');
    await writeFile(envFile, JSON.stringify({
      stt: { ...STT_TEST_ENV.stt, STT_IMAGE_SOURCE: 'local', STT_LISTEN_IP: '192.0.2.7', STT_DOCKER_NETWORK: 'stt-internal' },
    }), { mode: 0o600 });
    const { manager, logs } = await makeManager(fake, { envFile });
    const result = await manager.executeCommand(moduleCommand('stt', 'install'));
    assert.equal(result.ok, true);
    const created = [...fake.containers.values()][0];
    assert.deepEqual(created.Config.Env, ['AGIL_STT_TOKEN=qa-stt-test-token', 'STT_MODEL_PATH=/models/whisper']);
    assert.deepEqual(created.HostConfig.Mounts, [{
      Type: 'bind', Source: '/srv/qa-private-model', Target: '/models/whisper', ReadOnly: true,
    }]);
    assert.deepEqual(created.HostConfig.PortBindings['8090/tcp'], [{ HostIp: '192.0.2.7', HostPort: '8090' }]);
    assert.equal(created.HostConfig.ReadonlyRootfs, true);
    assert.equal(created.HostConfig.NetworkMode, 'stt-internal');
    assert.equal(fake.pulls.length, 0);
    assert.ok(!JSON.stringify(logs).includes('private-model'), 'env values must never be logged');
    assert.ok(!JSON.stringify(manager.pendingResults()).includes('private-model'));
    assert.ok(!JSON.stringify(await manager.inventory()).includes('private-model'));
  } finally {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('install: private module settings are checked before Docker and not echoed by Docker diagnostics', async () => {
  const fake = await startFakeDocker();
  const envFile = path.join(fixtureDirectory, 'private-preset-env.json');
  const value = 'private-preset-fixture-value';
  try {
    const { manager, logs } = await makeManager(fake, { envFile });
    const install = () => manager.executeCommand(moduleCommand('stt', 'install'));
    const valid = JSON.stringify({ stt: { ...STT_TEST_ENV.stt, AGIL_STT_TOKEN: value } });
    await writeFile(envFile, `invalid-json-${value}`, { mode: 0o600 });
    assert.match((await install()).error, /node-local JSON file with private permissions/);
    await writeFile(envFile, valid, { mode: 0o600 });
    if (process.platform !== 'win32') {
      await chmod(envFile, 0o644);
      assert.match((await install()).error, /private permissions/);
      await chmod(envFile, 0o600);
      const link = `${envFile}.link`;
      await symlink(envFile, link);
      manager.envFile = link;
      assert.match((await install()).error, /private permissions/);
      manager.envFile = envFile;
    }
    Object.defineProperty(manager.docker, 'nodeLocal', { value: false, configurable: true });
    assert.match((await install()).error, /require the node-local Docker endpoint/);
    delete manager.docker.nodeLocal;
    assert.equal(fake.pulls.length, 0);
    assert.equal(fake.containers.size, 0);
    manager.docker.createContainer = async () => { throw new Error(`test Docker rejected config: ${value}`); };
    const rejected = await install();
    assert.equal(rejected.error, 'Docker could not create the module');
    assert.doesNotMatch(JSON.stringify({ rejected, logs, reports: manager.pendingResults() }), /private-preset-fixture-value/);
    await manager.close();
  } finally {
    await fake.close();
  }
});

test('install: missing STT host directory fails before creating a container or pulling the image', async () => {
  const fake = await startFakeDocker();
  try {
    const { manager } = await makeManager(fake, { envFile: null });
    const result = await manager.executeCommand(moduleCommand('stt', 'install'));
    assert.equal(result.ok, false);
    assert.match(result.error, /STT_MODEL_DIR/);
    assert.equal(fake.pulls.length, 0);
    assert.equal(fake.containers.size, 0);
  } finally {
    await fake.close();
  }
});

test('install: a digested allowlisted image is pulled by digest and reported without a fake version', async () => {
  const fake = await startFakeDocker();
  try {
    const digest = `coturn/coturn@sha256:${'a'.repeat(64)}`;
    const { manager } = await makeManager(fake);
    const result = await manager.executeCommand(moduleCommand('turn', 'install', { image: digest }));
    assert.equal(result.ok, true);
    assert.equal(fake.pulls.length, 1);
    assert.equal(fake.pulls[0].fromImage, digest, 'a digest pull is passed whole, not split into repo+tag');
    assert.equal(fake.pulls[0].tag, '');
    const inventory = await manager.inventory();
    assert.equal(inventory[0].image, digest);
    assert.equal('version' in inventory[0], false, 'no version is invented from a digest');
  } finally {
    await fake.close();
  }
});

test('install: a foreign image is rejected before any Docker call', async () => {
  const fake = await startFakeDocker();
  try {
    const { manager } = await makeManager(fake);
    const requestsBefore = fake.requests.length;
    const result = await manager.executeCommand(moduleCommand('stt', 'install', { image: 'evil/node-stt:0.1.0' }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unknown');
    assert.match(result.error, /not allowlisted/i);
    assert.equal(fake.pulls.length, 0, 'no image is ever pulled');
    assert.equal(
      fake.requests.slice(requestsBefore).filter((entry) => entry.path.startsWith('/v1.45/containers/create')).length,
      0,
      'no container is ever created',
    );
  } finally {
    await fake.close();
  }
});

test('install: a pull error is reported as a failed result, not a crash', async () => {
  const fake = await startFakeDocker({ failPullImages: ['agil/node-stt:0.1.0'] });
  try {
    const { manager } = await makeManager(fake);
    const result = await manager.executeCommand(moduleCommand('stt', 'install'));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unknown');
    assert.match(result.error, /manifest unknown/i);
    assert.equal(fake.containers.size, 0);
  } finally {
    await fake.close();
  }
});

test('install rolls back only the new container when startup fails', async () => {
  const brokenImage = 'agil/node-stt:0.1.0';
  const fake = await startFakeDocker({ failStartImages: [brokenImage] });
  try {
    const foreign = fake.addContainer({ moduleId: 'stt', nodeId: 'another-node', image: brokenImage, running: true });
    const { manager } = await makeManager(fake);
    const result = await manager.executeCommand(moduleCommand('stt', 'install'));
    assert.equal(result.ok, false);
    assert.match(result.error, /address already in use/);
    assert.deepEqual(await manager.inventory(), []);
    assert.equal(fake.containers.size, 1);
    assert.equal(fake.containers.get(foreign.Id).State.Running, true);
    const deletes = fake.requests.filter((request) => request.method === 'DELETE');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].query.force, '0');
    const existing = fake.addContainer({ moduleId: 'stt', nodeId: NODE_ID, image: brokenImage });
    const retry = await manager.executeCommand(moduleCommand('stt', 'install'));
    assert.equal(retry.ok, false);
    assert.ok(fake.containers.has(existing.Id));
    assert.equal(fake.requests.filter((request) => request.method === 'DELETE').length, 1);
    assert.equal((await manager.executeCommand(moduleCommand('turn', 'install'))).ok, true);
  } finally {
    await fake.close();
  }
});

test('install keeps a running container when Docker loses the start result', async () => {
  const fake = await startFakeDocker({ failStartResponseImages: ['agil/node-stt:0.1.0'] });
  try {
    const { manager } = await makeManager(fake);
    const installed = await manager.executeCommand(moduleCommand('stt', 'install'));
    assert.equal(installed.ok, true);
    assert.equal(installed.status, 'running');
    assert.deepEqual((await manager.inventory()).map(({ id, status }) => [id, status]), [['stt', 'running']]);
    assert.equal(fake.requests.some((request) => request.method === 'DELETE'), false);
  } finally {
    await fake.close();
  }
});

test('start/stop/restart/remove act only on the node-owned container', async () => {
  const fake = await startFakeDocker();
  try {
    fake.addContainer({ moduleId: 'stt', nodeId: NODE_ID, image: 'agil/node-stt:0.1.0', running: true });
    fake.addContainer({ moduleId: 'turn', nodeId: 'other-node', image: 'coturn/coturn:4.6', running: true });
    const { manager } = await makeManager(fake);

    const stop = await manager.executeCommand(moduleCommand('stt', 'stop'));
    assert.equal(stop.ok, true);
    assert.equal(stop.status, 'stopped');
    assert.equal(manager.status().available, true);

    const start = await manager.executeCommand(moduleCommand('stt', 'start'));
    assert.equal(start.ok, true);
    assert.equal(start.status, 'running');

    const restart = await manager.executeCommand(moduleCommand('stt', 'restart'));
    assert.equal(restart.ok, true);
    assert.equal(restart.status, 'running');

    // A command for a module only present on another node must not touch it.
    const foreignStart = await manager.executeCommand(moduleCommand('turn', 'start'));
    assert.equal(foreignStart.ok, false);
    assert.match(foreignStart.error, /not installed/);
    const foreignTurn = [...fake.containers.values()].find((container) => container.Config.Labels['agil.node'] === 'other-node');
    assert.equal(foreignTurn.State.Running, true, 'another node\'s container is untouched');

    const remove = await manager.executeCommand(moduleCommand('stt', 'remove'));
    assert.equal(remove.ok, true);
    assert.equal(remove.status, 'unknown');
    assert.equal([...fake.containers.values()].filter((container) => container.Config.Labels['agil.node'] === NODE_ID).length, 0);

    // Idempotent no-ops: stopping/removing an absent module is not an error.
    assert.equal((await manager.executeCommand(moduleCommand('stt', 'stop'))).ok, true);
    assert.equal((await manager.executeCommand(moduleCommand('stt', 'remove'))).ok, true);
    // Starting an absent module is a real failure.
    assert.equal((await manager.executeCommand(moduleCommand('stt', 'start'))).ok, false);
  } finally {
    await fake.close();
  }
});

test('recorder: old install command is rejected and removal keeps Docker volumes', async () => {
  const fake = await startFakeDocker();
  try {
    const image = 'agil/node-recorder:0.1.0';
    const owned = fake.addContainer({ moduleId: 'recorder', nodeId: NODE_ID, image, running: true });
    const other = fake.addContainer({ moduleId: 'recorder', nodeId: 'another-node', image, running: true });
    const { manager } = await makeManager(fake);
    const requestsBeforeInstall = fake.requests.length;
    const install = await manager.executeCommand(moduleCommand('recorder', 'install', { image }));
    assert.equal(install.ok, false);
    assert.match(install.error, /recorder installation is disabled/i);
    assert.equal(fake.requests.length, requestsBeforeInstall);

    const removed = await manager.executeCommand(moduleCommand('recorder', 'remove'));
    assert.equal(removed.ok, true, removed.error);
    const deletes = fake.requests.filter((request) => request.method === 'DELETE');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].query.v, '0');
    assert.equal(deletes[0].query.force, '0');
    assert.ok(fake.requests.some((request) => request.path.endsWith(`/containers/${owned.Id}/stop`)));
    assert.ok(!fake.containers.has(owned.Id));
    assert.equal(fake.containers.get(other.Id).State.Running, true);
  } finally {
    await fake.close();
  }
});

test('auto-start updates only the owned container without restarting it', async () => {
  const fake = await startFakeDocker();
  try {
    const own = fake.addContainer({ moduleId: 'turn', nodeId: NODE_ID, image: 'coturn/coturn:4.6', running: true });
    const foreign = fake.addContainer({ moduleId: 'turn', nodeId: 'other-node', image: 'coturn/coturn:4.6', running: true });
    own.HostConfig.RestartPolicy = { Name: 'unless-stopped' };
    foreign.HostConfig.RestartPolicy = { Name: 'unless-stopped' };
    const startedAt = own.State.StartedAt;
    const { manager } = await makeManager(fake);
    assert.equal((await manager.inventory())[0].autoStart, true);
    assert.equal((await manager.executeCommand(moduleCommand('turn', 'disable-autostart'))).ok, true);
    const { manager: restarted } = await makeManager(fake);
    assert.equal((await restarted.inventory())[0].autoStart, false);
    assert.equal((await restarted.executeCommand(moduleCommand('turn', 'enable-autostart'))).ok, true);
    assert.equal((await restarted.inventory())[0].autoStart, true);
    assert.equal(own.State.StartedAt, startedAt);
    assert.equal(foreign.HostConfig.RestartPolicy.Name, 'unless-stopped');
    assert.equal(fake.requests.filter((request) => request.path.endsWith('/update')).length, 2);
    own.HostConfig.RestartPolicy = { Name: 'always' };
    assert.equal((await restarted.inventory())[0].autoStart, undefined);
    assert.equal((await restarted.executeCommand(moduleCommand('turn', 'disable-autostart'))).ok, false);
    assert.equal(own.HostConfig.RestartPolicy.Name, 'always');
  } finally {
    await fake.close();
  }
});

test('a re-delivered command id never executes twice', async () => {
  const fake = await startFakeDocker();
  try {
    const { manager } = await makeManager(fake);
    const command = moduleCommand('stt', 'install');
    const first = await manager.executeCommand(command);
    assert.equal(first.ok, true);
    const pulls = fake.pulls.length;
    const containers = fake.containers.size;

    const duplicate = await manager.executeCommand({ ...command });
    assert.equal(duplicate, null, 'the duplicate is ignored');
    assert.equal(fake.pulls.length, pulls, 'no second pull');
    assert.equal(fake.containers.size, containers, 'no second container');
    assert.equal(manager.pendingResults().length, 1, 'the acknowledgement is still queued once');
  } finally {
    await fake.close();
  }
});

test('expired or malformed commands are dropped without Docker work or acknowledgements', async () => {
  const fake = await startFakeDocker();
  try {
    const { manager } = await makeManager(fake);
    assert.equal(
      await manager.executeCommand(moduleCommand('stt', 'install', { expiresAt: Date.now() - 1 })),
      null,
      'an expired command is not executed',
    );
    assert.equal(await manager.executeCommand({ id: 'not-a-command-id', moduleId: 'stt' }), null);
    assert.equal(fake.pulls.length, 0);
    assert.deepEqual(manager.pendingResults(), []);
  } finally {
    await fake.close();
  }
});

test('commands are executed sequentially and results are bounded', async () => {
  const fake = await startFakeDocker();
  try {
    const { manager } = await makeManager(fake);
    const commands = [
      moduleCommand('stt', 'install'),
      moduleCommand('stt', 'stop'),
      moduleCommand('stt', 'start'),
    ];
    const idle = manager.handleCommands(commands);
    await idle;
    await manager.whenIdle();
    assert.equal(fake.pulls.length, 1, 'install pulls once; the other actions reuse the container');
    const results = manager.pendingResults();
    assert.equal(results.length, 3);
    assert.deepEqual(results.map((entry) => entry.status), ['running', 'stopped', 'running']);
    assert.equal(manager.status().pendingResults, 3);

    // The queue is capped at the protocol maximum: oldest are dropped first.
    for (let index = 0; index < 40; index += 1) {
      await manager.executeCommand(moduleCommand('stt', 'start'));
    }
    assert.equal(manager.pendingResults().length, 32);
  } finally {
    await fake.close();
  }
});

test('results survive a restart through the 0600 state file and are acked once', async () => {
  const fake = await startFakeDocker();
  const dir = await mkdtemp(path.join(tmpdir(), 'agil-modules-state-'));
  try {
    const stateFile = path.join(dir, 'module-commands.json');
    const first = await makeManager(fake, { stateFile });
    const command = moduleCommand('stt', 'install');
    const result = await first.manager.executeCommand(command);
    assert.equal(result.ok, true);
    await first.manager.close();

    const second = await makeManager(fake, { stateFile });
    const pending = second.manager.pendingResults();
    assert.deepEqual(pending.map((entry) => entry.commandId), [command.id], 'queued result restored');
    // The executed-id memory also survives, so a re-delivery is still a no-op.
    assert.equal(await second.manager.executeCommand({ ...command }), null);
    assert.equal(fake.pulls.length, 1);

    await second.manager.ackResults([command.id]);
    assert.deepEqual(second.manager.pendingResults(), []);
    await second.manager.close();

    const third = await makeManager(fake, { stateFile });
    assert.deepEqual(third.manager.pendingResults(), [], 'acked results stay acknowledged');
    await third.manager.close();
  } finally {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('mode=off disables Docker work but still acknowledges commands as failed', async () => {
  const fake = await startFakeDocker();
  try {
    const { manager } = await makeManager(fake, { mode: 'off' });
    assert.equal(manager.status().enabled, false);
    assert.equal(await manager.inventory(), undefined);
    const result = await manager.executeCommand(moduleCommand('stt', 'install'));
    assert.equal(result.ok, false);
    assert.match(result.error, /disabled/i);
    assert.equal(fake.pulls.length, 0);
    assert.equal(fake.requests.length, 0, 'no Docker request is made at all');
  } finally {
    await fake.close();
  }
});

/* ------------------------------------------------------------- duplicates */

test('modules.mjs stays byte-identical to the all-in-one node copy', async () => {
  const [reference, imageCopy] = await Promise.all([
    readFile(path.join(AGENT_DIR, 'modules.mjs'), 'utf8'),
    readFile(path.join(REPO_ROOT, 'agil', 'core', 'nodes', 'all-in-one', 'agent', 'modules.mjs'), 'utf8'),
  ]);
  // Each build context is self-contained, so the file is duplicated on purpose.
  // This test makes drift a failure instead of a runtime surprise.
  assert.equal(reference, imageCopy, 'all-in-one modules.mjs differs from agil/infra/node-agent/modules.mjs');
});

test('DockerUnavailableError is distinguishable from API errors', () => {
  const unavailable = new DockerUnavailableError('no socket', { code: 'ENOENT' });
  assert.equal(unavailable.unavailable, true);
  assert.equal(unavailable.code, 'ENOENT');
});
