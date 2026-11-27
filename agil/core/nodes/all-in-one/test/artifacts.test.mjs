import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { AGENT_DIR } from './helpers.mjs';

const repoRoot = path.resolve(AGENT_DIR, '..', '..', '..', '..');
const imageDir = AGENT_DIR;
const read = (relative) => readFileSync(path.join(imageDir, relative), 'utf8');
const readRepo = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');

test('image artifacts exist and are linked to the operator doc', () => {
  for (const file of [
    'Dockerfile', 'docker-compose.yml', '.env.example', 'README.md', '.dockerignore',
    'systemd/agil-node@.service', 'systemd/prepare-images.sh', 'systemd/prepare-stack.sh',
    'systemd/rollout-image.sh',
  ]) {
    assert.ok(existsSync(path.join(imageDir, file)), `${file} is missing`);
  }
  assert.ok(
    existsSync(path.join(repoRoot, 'agil', 'core', 'docs', 'node-image.md')),
    'agil/core/docs/node-image.md is missing',
  );
  assert.ok(read('README.md').includes('../../docs/node-image.md'), 'README must link the runbook');
});

test('systemd uses the same local Docker socket during preparation, startup and updates', () => {
  const unit = read('systemd/agil-node@.service');
  assert.match(unit, /^UnsetEnvironment=DOCKER_HOST DOCKER_CONTEXT$/m);
  const dockerCommands = unit.split('\n').filter((line) => /^Exec.*=\/usr\/bin\/docker\b/.test(line));
  assert.equal(dockerCommands.length, 3);
  for (const command of dockerCommands) {
    assert.match(command, /=\/usr\/bin\/docker --host unix:\/\/\/var\/run\/docker\.sock compose\b/);
  }
  for (const helper of ['prepare-images.sh', 'rollout-image.sh']) {
    const script = read(`systemd/${helper}`);
    assert.match(script, /^unset DOCKER_HOST DOCKER_CONTEXT$/m);
    assert.match(script, /^\s+docker --host unix:\/\/\/var\/run\/docker\.sock "\$@"$/m);
  }
});

test('Dockerfile: non-root, pinned images, healthcheck, no baked secrets', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^# syntax=docker\/dockerfile:1$/m);
  assert.match(dockerfile, /^FROM livekit\/livekit-server:\$\{LIVEKIT_VERSION\} AS livekit$/m);
  assert.match(dockerfile, /^FROM node:22-bookworm-slim$/m, 'the image must use a supported Node LTS');
  assert.match(dockerfile, /apt-get install -y --no-install-recommends ca-certificates coturn/);
  assert.match(dockerfile, /^COPY --from=livekit \/livekit-server \/usr\/local\/bin\/livekit-server$/m);
  assert.match(dockerfile, /^COPY --chown=node:node agent\/ \/opt\/agil-node\/agent\/$/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^VOLUME \["\/var\/lib\/agil-node"\]$/m);
  assert.match(
    dockerfile,
    /^HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \\\n  CMD \[.*\/readyz\.mjs/m,
  );
  const healthCmd = /^  CMD (\[.*\])$/m.exec(dockerfile)?.[1];
  assert.ok(healthCmd, 'healthcheck CMD must be an exec-form JSON array');
  assert.equal(JSON.parse(healthCmd)[0], 'node');
  assert.match(JSON.parse(healthCmd).join(' '), /\/readyz/);
  assert.match(dockerfile, /^ENTRYPOINT \["node", "\/opt\/agil-node\/agent\/index\.mjs"\]$/m);
  assert.match(dockerfile, /^STOPSIGNAL SIGTERM$/m);
  assert.match(dockerfile, /EXPOSE 7880\/tcp 7881\/tcp 50000-50100\/udp 3478\/tcp 3478\/udp 5349\/tcp 49200-49250\/udp 8080\/tcp 6789\/tcp/);

  // A secret must never be a build-stage constant in the image.
  assert.ok(!/ENV[^\n]*(SECRET|TOKEN|PASSWORD)\s*=\s*\S+/i.test(dockerfile), 'Dockerfile bakes a secret');
  assert.ok(!/^(COPY|ADD)\s+[^\n]*\s\.?env\b/im.test(dockerfile), 'Dockerfile must not copy .env');

  // An image ENV NODE_HTTP_PORT would always win over the documented
  // AGIL_NODE_HTTP_PORT alias (readEnv prefers the canonical name), so the
  // default must live in the agent, not in the image environment.
  const directives = dockerfile.split('\n').filter((line) => !line.trimStart().startsWith('#'));
  assert.ok(
    !directives.some((line) => /^\s*NODE_HTTP_PORT=/.test(line)),
    'NODE_HTTP_PORT must not be an image ENV: it would shadow AGIL_NODE_HTTP_PORT',
  );
});

test('optional Redis Compose override connects LiveKit only after a loopback Redis is healthy', () => {
  const compose = read('compose.local-redis.yml');
  assert.match(compose, /SFU_REDIS_URL: "127\.0\.0\.1:\$\{AGIL_NODE_REDIS_PORT:-6380\}"/);
  assert.match(compose, /redis:\s+condition: service_healthy/);
  assert.match(compose, /--bind\s+- 127\.0\.0\.1/);
  assert.match(compose, /--appendonly\s+- "yes"/);
  assert.match(compose, /redis-data:\/data/);
  assert.doesNotMatch(read('docker-compose.yml'), /^  redis:/m);
});

test('optional Egress Compose override waits for SFU and Redis and uses their configured ports', () => {
  const compose = read('compose.local-egress.yml');
  assert.match(compose, /image: livekit\/egress:v1\.15\.0/);
  assert.match(compose, /node:\s+condition: service_healthy\s+redis:\s+condition: service_healthy/);
  assert.match(compose, /ws_url: ws:\/\/127\.0\.0\.1:\$\{SFU_PORT:-7880\}/);
  assert.match(compose, /address: 127\.0\.0\.1:\$\{AGIL_NODE_REDIS_PORT:-6380\}/);
  assert.match(compose, /health_port: \$\{AGIL_NODE_EGRESS_HEALTH_PORT:-8082\}/);
  assert.match(compose, /curl.*127\.0\.0\.1:\$\{AGIL_NODE_EGRESS_HEALTH_PORT:-8082\}/);
  assert.doesNotMatch(read('docker-compose.yml'), /^  egress:/m);
});

test('optional SIP Compose override passes the mounted config path to the pinned image', () => {
  const compose = read('compose.local-sip.yml');
  assert.match(compose, /command: \["--config", "\/etc\/agil-sip\/sip\.yaml"\]/);
  assert.match(compose, /target: \/etc\/agil-sip\s+read_only: true/);
  assert.match(compose, /node:\s+condition: service_healthy\s+redis:\s+condition: service_healthy/);
  assert.doesNotMatch(read('docker-compose.yml'), /^  sip:/m);
});

test('image healthcheck probes the configured listener and reflects readiness', async () => {
  const healthCommand = JSON.parse(/^  CMD (\[.*\])$/m.exec(read('Dockerfile'))[1]);
  const script = path.join(imageDir, 'agent', path.basename(healthCommand[1]));
  let status = 200;
  const server = createServer((request, response) => {
    assert.equal(request.url, '/readyz');
    response.writeHead(status).end();
  });
  const listening = once(server, 'listening');
  server.listen(0, '::1');
  await listening;
  const port = String(server.address().port);
  const probe = (env) => promisify(execFile)(process.execPath, [script], { env: { ...process.env,
    NODE_HTTP_HOST: '', NODE_HTTP_PORT: '', AGIL_NODE_HTTP_HOST: '', AGIL_NODE_HTTP_PORT: '', ...env,
  }, timeout: 6000 });
  try {
    await probe({ AGIL_NODE_HTTP_HOST: '::1', AGIL_NODE_HTTP_PORT: port });
    await probe({ NODE_HTTP_HOST: ' ::1 ', NODE_HTTP_PORT: port, AGIL_NODE_HTTP_HOST: '127.0.0.1', AGIL_NODE_HTTP_PORT: '1' });
    await probe({ NODE_HTTP_HOST: '::', NODE_HTTP_PORT: port });
    await assert.rejects(probe({ NODE_HTTP_HOST: '0.0.0.0', NODE_HTTP_PORT: port }), { code: 1 });
    status = 503;
    await assert.rejects(probe({ NODE_HTTP_HOST: '::1', NODE_HTTP_PORT: port }), { code: 1 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('compose: host networking, hardening, state volume and healthcheck', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /^name: agil-node$/m);
  assert.match(compose, /^    network_mode: host$/m);
  assert.match(compose, /^    init: true$/m);
  assert.match(compose, /^    read_only: true$/m);
  assert.match(compose, /^      - ALL$/m);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /^      - node-state:\/var\/lib\/agil-node$/m);
  assert.match(compose, /^      - \/run\/agil:mode=0700/m);
  assert.match(compose, /^    stop_grace_period: 30s$/m);
  assert.doesNotMatch(compose, /^    healthcheck:$/m, 'Compose inherits the image healthcheck');
  assert.match(compose, /^volumes:\n  node-state:$/m);
  assert.ok(!/^    ports:$/m.test(compose), 'host networking must not publish Docker ports');
  assert.match(compose, /required: false/, 'compose must parse without a filled .env');

  // Every ${VAR} used for interpolation must be documented in .env.example.
  const envKeys = new Set([...read('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  for (const ref of new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))) {
    assert.ok(envKeys.has(ref), `docker-compose.yml references undocumented ${ref}`);
  }
});

test('.env.example documents the required toggles and secrets without real values', () => {
  const env = read('.env.example');
  for (const key of [
    'AGIL_CORE_URL',
    'AGIL_NODE_TOKEN',
    'NODE_ID',
    'NODE_FEATURES',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'TURN_PASSWORD',
    'TURN_EXTERNAL_IP',
    'NODE_HEARTBEAT_SEC',
    'NODE_CONTROL_TOKEN',
    'SFU_UDP_MIN_PORT',
    'TURN_MIN_PORT',
  ]) {
    assert.match(env, new RegExp(`^${key}=`, 'm'), `${key} is not documented`);
  }
  assert.match(env, /^AGIL_NODE_TOKEN=$/m, 'the token placeholder must be empty');
  assert.match(env, /^LIVEKIT_API_SECRET=$/m, 'the LiveKit secret placeholder must be empty');
  assert.match(env, /^TURN_PASSWORD=$/m, 'the TURN password placeholder must be empty');
  assert.match(env, /^NODE_FEATURES=sfu,turn,stun$/m);

  // A shell-compatible dotenv file: no duplicates, no spaces around '='.
  const keys = new Set();
  for (const [index, line] of env.split('\n').entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    assert.ok(match, `.env.example line ${index + 1} is not KEY=value: ${line}`);
    assert.ok(!keys.has(match[1]), `.env.example defines ${match[1]} twice`);
    keys.add(match[1]);
  }
});

test('LiveKit pin is consistent with the deploy scaffold', () => {
  const dockerfile = read('Dockerfile');
  const envExample = read('.env.example');
  const deploy = readRepo('agil/core/deploy/livekit/docker-compose.yml');
  const version = /^ARG LIVEKIT_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
  assert.ok(version, 'Dockerfile must default LIVEKIT_VERSION');
  // Docker Hub publishes the LiveKit release tags with a `v` prefix; a tag
  // without it resolves to nothing and fails the first `FROM` of a build.
  assert.match(version, /^v\d+\.\d+\.\d+$/, 'LIVEKIT_VERSION must be the registry tag form vX.Y.Z');
  assert.match(envExample, new RegExp(`^LIVEKIT_VERSION=${version}$`, 'm'));
  assert.ok(
    deploy.includes(`livekit/livekit-server:${version}`),
    `agil/core/deploy/livekit pins another LiveKit version than the node image (${version})`,
  );
});

test('image version stays consistent across agent/compose/Dockerfile', () => {
  const agentVersion = /^export const NODE_IMAGE_VERSION = '([^']+)';$/m.exec(read('agent/config.mjs'))?.[1];
  assert.ok(agentVersion, 'NODE_IMAGE_VERSION must be declared');
  assert.match(read('Dockerfile'), new RegExp(`org\\.opencontainers\\.image\\.version="${agentVersion}"`));
  assert.match(read('docker-compose.yml'), new RegExp(`agil-node-all-in-one:${agentVersion}`));
});

test('.gitignore un-ignores the node image .env.example', () => {
  const gitignore = readRepo('.gitignore');
  assert.match(gitignore, /^!agil\/core\/nodes\/all-in-one\/\.env\.example$/m);
});
