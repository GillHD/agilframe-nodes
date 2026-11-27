/**
 * Docker module management for the AGIL node agent.
 *
 * The Core is the source of truth for *which* modules may exist and which image
 * each one installs (see `agil/core/apps/server/src/node-modules.ts` and the
 * `NodeModule`/`NodeModuleCommand` protocol schemas). This file is the node-side
 * half of that contract:
 *
 *   1. **discovery** — list Docker containers labelled `agil.module=<id>` and
 *      `agil.node=<this node id>` and turn each one into a `NodeModuleReport`
 *      (`id`, `image`, `status`, `health`, `version`, `ports`, `updatedAt`,
 *      `lastError`). Only real containers are reported; there is no synthetic
 *      inventory and a non-allowlisted image is never echoed;
 *   2. **commands** — execute the allowlisted `install/start/stop/restart/remove`
 *      actions from `moduleCommands` through the Docker Engine API. The install
 *      image always comes from the command *and* must use the agent-side
 *      allowlisted repository for that module; no image or command from the
 *      dashboard is ever trusted, and only containers owned by this node are
 *      touched;
 *   3. **results** — queue one `{commandId, ok, status, error?}` per executed
 *      command and send them as `moduleResults` on a later heartbeat. Results
 *      (and executed command ids) are persisted so a restart does not lose an
 *      acknowledgement; duplicates are never executed twice.
 *
 * Everything is dependency-free (Node >= 20) and talks to the Docker Engine API
 * over a Unix socket, a Windows named pipe or `tcp://`. Every dependency is
 * injectable so tests use a fake Docker daemon over TCP and never touch a real
 * container:
 *
 *   - `DockerClient` is the thin HTTP client (`/_ping` API-version negotiation,
 *     containers/images endpoints);
 *   - `ModuleManager` owns discovery, the allowlist, the bounded result queue and
 *     the persistence. Construct it with `{ nodeId, docker, ... }`.
 *
 * Failure behaviour: a missing/unreachable Docker socket is **not** an agent
 * failure. The heartbeat keeps flowing without a `modules` field (an omitted
 * snapshot keeps the Core's previous inventory; `[]` would mean "none
 * installed", which would be a lie) and the agent stays `online` as an
 * agent-only node. A command received in that state is acknowledged as failed
 * instead of crashing the process.
 *
 * Secrets: module environment values (if an operator provides them in the
 * node-local env file) are read on the node, passed to Docker and never logged,
 * reported or included in a command result. The Core has no field for them.
 *
 * Duplicated copies: `agil/infra/node-agent/modules.mjs` (reference agent) and
 * `agil/core/nodes/all-in-one/agent/modules.mjs` (first-party node image). Each
 * build context is self-contained, so the two files are kept byte-identical on
 * purpose — update them together (the node-agent test asserts equality).
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rename, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

/* ------------------------------------------------------------------ labels */

/** Container label carrying the inventory module id. */
export const MODULE_LABEL = 'agil.module';
const MODULE_KIND_LABEL = 'agil.module.kind';
const MODULE_LIFECYCLE_LABEL = 'agil.module.lifecycle';
const SFU_GRACEFUL_STOP_LABEL = 'agil.module.graceful-stop';
// LiveKit 1.13.11 drains on the first signal and can force shutdown on the second.
const LIVEKIT_DRAIN_IMAGE = 'livekit/livekit-server@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20';
const MODULE_LOGS_LABEL = 'agil.module.logs';
const MODULE_STORAGE_LABEL = 'agil.module.storage';
const MODULE_NETWORK_LABEL = 'agil.module.network';
const TEMPLATE_STORAGE_TARGET = '/agil-data';
const TEMPLATE_VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
/** Container label carrying the owning node id — the ownership check. */
export const NODE_LABEL = 'agil.node';
/** Marker label set by the agent on containers it created. */
export const MANAGED_LABEL = 'agil.managed';
const TEMPLATE_INSTALL_LABEL = 'agil.module.install-command';

/** Module ids from the Core catalog — the only ids managed by commands. */
export const MODULE_IDS = Object.freeze(['egress', 'stt', 'recorder', 'turn', 'sip', 'ingress', 'sfu']);
const SCOPED_COMPOSE_SERVICES = Object.freeze({ ingress: 'ingress', sfu: 'livekit' });
const isScopedComposeModule = (id) => Object.hasOwn(SCOPED_COMPOSE_SERVICES, id);
const stoppedSfu = (state) => state?.Running === false && !state.Restarting && !state.Dead && !state.Paused &&
  (state.Status === 'created' || state.Status === 'exited');
/** Actions from the protocol — the only actions ever executed. */
export const MODULE_ACTIONS = Object.freeze([
  'install', 'start', 'stop', 'restart', 'remove', 'enable-autostart', 'disable-autostart',
]);
/** Lifecycle states from `nodeModuleStatuses`. */
export const MODULE_STATUSES = Object.freeze(['running', 'stopped', 'error', 'installing', 'unknown']);
/** Health values from `nodeModuleHealths`. */
export const MODULE_HEALTHS = Object.freeze(['healthy', 'degraded', 'unhealthy', 'unknown']);

/** Hard bounds shared with `agil/core/packages/protocol/src/cluster.ts`. */
export const NODE_MODULE_MAX_ITEMS = 32;
export const NODE_MODULE_MAX_PORTS = 8;
export const NODE_MODULE_MAX_ERROR_CHARS = 300;
export const NODE_MODULE_MAX_VERSION_CHARS = 32;
/** Bounded result queue: the protocol rejects a larger `moduleResults` array. */
export const MAX_PENDING_RESULTS = 32;
/** Remember recent command ids so a re-delivery can never execute twice. */
export const MAX_EXECUTED_COMMANDS = 64;
/** Core's per-node command queue is 16; never accept more per heartbeat. */
export const MAX_COMMANDS_PER_BEAT = 16;

const COMMAND_ID_RE = /^nmc_[0-9a-f]{16}$/;
const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;
const CUSTOM_LIFECYCLE_ACTIONS = new Set(['start', 'stop', 'restart', 'remove']);
const MAX_TEMPLATE_CONTAINERS = 256;
const INVENTORY_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const isInventoryId = (value) => typeof value === 'string' && INVENTORY_ID_RE.test(value);
const PINNED_TEMPLATE_IMAGE_RE = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?)\/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/;
const MAX_MODULE_TEMPLATES = 16;
const MAX_MODULE_TEMPLATE_FILE_BYTES = 16 * 1024;
const MAX_TEMPLATE_ENV_FILE_BYTES = 64 * 1024;
const MAX_TEMPLATE_ENV_REFS = 16;
const MAX_TEMPLATE_ENV_VALUE_BYTES = 4096;
const MAX_TEMPLATE_COMMAND_ARGS = 16;
const MAX_TEMPLATE_COMMAND_ARG_BYTES = 512;
const TEMPLATE_RESTART_LIMIT = 3;
const TEMPLATE_STARTUP_OBSERVATION_MS = 700;
const TEMPLATE_RESOURCE_DEFAULTS = Object.freeze({ cpuMillicores: 500, memoryMiB: 256, pidsLimit: 64 });
const TEMPLATE_RESOURCE_RANGES = Object.freeze({ cpuMillicores: [100, 8_000], memoryMiB: [64, 8_192], pidsLimit: [16, 512] });
const MODULE_LOG_LIMIT = 16;
const MODULE_LOG_SNAPSHOT_LIMIT = 4;
const MODULE_LOG_BYTES = 32 * 1024;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Docker Engine API request timeout (a slow `docker ps` must not stall a beat). */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** Image pulls are legitimately slow (large layers); only used for `/images/create`. */
const DEFAULT_PULL_TIMEOUT_MS = 600_000;
/** Re-probe a failed socket at most this often while logging the failure. */
const DOCKER_FAILURE_LOG_INTERVAL_MS = 60_000;
const STT_MODEL_TARGET = '/models/whisper';

/* --------------------------------------------------------- agent allowlist */

/**
 * Node-side allowlist: module id -> Docker repository + the default ports the
 * agent publishes when it creates the container. The repositories mirror the
 * Core catalog (`agil/core/apps/server/src/node-modules.ts`); matching is by
 * repository so a tag/digest bump is accepted while any other image is not.
 *
 * The Core validates the same thing, but it is verified again here: a
 * compromised or buggy Core must not be able to make the node run an arbitrary
 * image, and a manual container with a foreign image is dropped from the
 * reported inventory instead of surfacing on the dashboard.
 */
const CATALOG = Object.freeze({
  egress: Object.freeze({
    repository: 'livekit/egress',
    ports: Object.freeze([]),
  }),
  stt: Object.freeze({
    repository: 'agil/node-stt',
    ports: Object.freeze([Object.freeze({ port: 8090, protocol: 'tcp' })]),
  }),
  recorder: Object.freeze({
    repository: 'agil/node-recorder',
    ports: Object.freeze([Object.freeze({ port: 8091, protocol: 'tcp' })]),
  }),
  turn: Object.freeze({
    repository: 'coturn/coturn',
    ports: Object.freeze([
      Object.freeze({ port: 3478, protocol: 'tcp' }),
      Object.freeze({ port: 3478, protocol: 'udp' }),
      Object.freeze({ port: 5349, protocol: 'tcp' }),
    ]),
  }),
  sip: Object.freeze({
    repository: 'livekit/sip',
    ports: Object.freeze([
      Object.freeze({ port: 5060, protocol: 'udp' }),
      Object.freeze({ port: 5060, protocol: 'tcp' }),
      Object.freeze({ port: 5061, protocol: 'tcp' }),
    ]),
  }),
  ingress: Object.freeze({
    repository: 'livekit/ingress',
    ports: Object.freeze([]),
  }),
  sfu: Object.freeze({
    repository: 'livekit/livekit-server',
    image: 'livekit/livekit-server:v1.13.11',
    ports: Object.freeze([]),
  }),
});
const LEGACY_WORKER_REPOSITORIES = Object.freeze({ egress: 'agil/node-egress', sip: 'agil/node-sip' });

/** Deep copy of the node-side allowlist (safe for tests/consumers to mutate). */
export function moduleCatalog() {
  return MODULE_IDS.map((id) => ({
    id,
    repository: CATALOG[id].repository,
    ports: CATALOG[id].ports.map((port) => ({ ...port })),
  }));
}

export function isKnownModule(moduleId) {
  return typeof moduleId === 'string' && Object.prototype.hasOwnProperty.call(CATALOG, moduleId);
}

/** Repository part of a Docker image reference (`registry:5000/a/b:1` -> `registry:5000/a/b`). */
export function moduleImageRepository(image) {
  if (typeof image !== 'string' || image === '') return '';
  const at = image.indexOf('@');
  const withoutDigest = at >= 0 ? image.slice(0, at) : image;
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

/** Tag part of a reference; `''` for a digest or an untagged image. */
function moduleImageTag(image) {
  if (typeof image !== 'string' || image === '') return '';
  const at = image.indexOf('@');
  if (at >= 0) return '';
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  return colon > slash ? image.slice(colon + 1) : '';
}

/** Docker image reference shape from `nodeModuleImageSchema` (no whitespace/secrets). */
export function isValidImageReference(image) {
  if (typeof image !== 'string' || !IMAGE_RE.test(image)) return false;
  return !image.includes('//') && !image.endsWith(':') && !image.endsWith('/');
}

/** True when `image` is a tag/digest variant of the module's allowlisted repository. */
export function isAllowlistedModuleImage(moduleId, image) {
  if (!isKnownModule(moduleId) || !isValidImageReference(image)) return false;
  const repository = moduleImageRepository(image).toLowerCase();
  if (Object.hasOwn(LEGACY_WORKER_REPOSITORIES, moduleId)) {
    return repository === LEGACY_WORKER_REPOSITORIES[moduleId] || isComposeWorkerImage(moduleId, image);
  }
  return (isScopedComposeModule(moduleId) ? repository.replace(/^docker\.io\//, '') : repository) === CATALOG[moduleId].repository.toLowerCase();
}

function isComposeWorkerImage(moduleId, image) {
  return Object.hasOwn(LEGACY_WORKER_REPOSITORIES, moduleId) && typeof image === 'string' &&
    moduleImageRepository(image).toLowerCase().replace(/^docker\.io\//, '') === CATALOG[moduleId].repository;
}

function isPinnedTemplateImage(image) {
  const registry = isValidImageReference(image) ? PINNED_TEMPLATE_IMAGE_RE.exec(image)?.[1] : undefined;
  if (!registry) return false;
  const [host, port] = registry.split(':');
  return (host === 'localhost' || host.includes('.') || port !== undefined) &&
    (port === undefined || (Number(port) > 0 && Number(port) <= 65535));
}

async function readNodeLocalJson(file, maxBytes, { privateOnly = false } = {}) {
  const initial = fsConstants.O_NOFOLLOW ? null : await lstat(file);
  if (initial && !initial.isFile()) throw new Error('invalid file');
  const options = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  const handle = await open(file, options);
  try {
    const stat = await handle.stat();
    const uid = process.getuid?.();
    // Windows lstat can report device 0 for an ordinary file; the opened
    // file still has to match its observed inode.
    const changed = initial && (initial.ino !== stat.ino || (initial.dev !== 0 && stat.dev !== 0 && initial.dev !== stat.dev));
    if (!stat.isFile() || stat.size > maxBytes || changed ||
      (uid !== undefined && ((stat.uid !== uid && stat.uid !== 0) ||
        (stat.mode & (privateOnly ? 0o077 : 0o022)) !== 0))) throw new Error('invalid file');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('invalid file');
    return JSON.parse(buffer.toString('utf8', 0, length));
  } finally {
    await handle.close();
  }
}

async function readModuleTemplates(file) {
  const parsed = await readNodeLocalJson(file, MAX_MODULE_TEMPLATE_FILE_BYTES);
  if (!Array.isArray(parsed) || parsed.length > MAX_MODULE_TEMPLATES) throw new Error('invalid template list');
  const ids = new Set();
  for (const template of parsed) {
    if (!isPlainObject(template) || Object.keys(template).some((key) =>
      !['id', 'image', 'install', 'resources', 'envRefs', 'storageVolume', 'commandArgs', 'restartPolicy', 'healthcheck', 'networkId', 'ports'].includes(key)) ||
      (template.install !== undefined && typeof template.install !== 'boolean') || !isInventoryId(template.id) ||
      isKnownModule(template.id) || ids.has(template.id) || !isPinnedTemplateImage(template.image)) throw new Error('invalid template');
    if (template.resources !== undefined) {
      if (!isPlainObject(template.resources) || Object.entries(template.resources).some(([key, value]) => {
        if (!Object.hasOwn(TEMPLATE_RESOURCE_RANGES, key) || !Number.isInteger(value)) return true;
        const [min, max] = TEMPLATE_RESOURCE_RANGES[key];
        return value < min || value > max;
      })) throw new Error('invalid template resource limits');
      template.resources = { ...TEMPLATE_RESOURCE_DEFAULTS, ...template.resources };
    }
    if (template.envRefs !== undefined && (!Array.isArray(template.envRefs) || template.envRefs.length > MAX_TEMPLATE_ENV_REFS ||
      template.envRefs.some((key) => typeof key !== 'string' || !ENV_KEY_RE.test(key)) ||
      new Set(template.envRefs).size !== template.envRefs.length)) throw new Error('invalid environment references');
    if (template.storageVolume !== undefined && !validTemplateVolumeName(template.storageVolume)) {
      throw new Error('invalid template storage');
    }
    const { commandArgs } = template;
    if (commandArgs !== undefined && !validTemplateArguments(commandArgs)) throw new Error('invalid template command arguments');
    if (template.healthcheck !== undefined) template.healthcheck = validatedTemplateHealthcheck(template.healthcheck);
    if (template.networkId !== undefined || template.ports !== undefined) {
      if (typeof template.networkId !== 'string' || !CONTAINER_ID_RE.test(template.networkId) ||
        !Array.isArray(template.ports) || template.ports.length < 1 || template.ports.length > NODE_MODULE_MAX_PORTS ||
        template.ports.some((entry) => !isPlainObject(entry) || Object.keys(entry).length !== 2 ||
          !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535 || !['tcp', 'udp'].includes(entry.protocol)) ||
        new Set(template.ports.map(({ port, protocol }) => `${port}/${protocol}`)).size !== template.ports.length) {
        throw new Error('invalid template network or ports');
      }
      template.ports = template.ports.map(({ port, protocol }) => ({ port, protocol }))
        .sort((left, right) => left.port - right.port || left.protocol.localeCompare(right.protocol));
    }
    if (template.restartPolicy !== undefined && template.restartPolicy !== 'no' && template.restartPolicy !== 'on-failure') {
      throw new Error('invalid template restart policy');
    }
    ids.add(template.id);
  }
  return parsed.sort((left, right) => left.id.localeCompare(right.id));
}

function validTemplateArguments(args) {
  return Array.isArray(args) && args.length > 0 && args.length <= MAX_TEMPLATE_COMMAND_ARGS &&
    args.every((arg) => typeof arg === 'string' && !arg.includes('\0') && Buffer.byteLength(arg) <= MAX_TEMPLATE_COMMAND_ARG_BYTES);
}

function validatedTemplateHealthcheck(check) {
  const limits = { intervalSec: [1, 30, 2], timeoutSec: [1, 10, 1], retries: [1, 5, 3], startupTimeoutSec: [2, 90, 20] };
  if (!isPlainObject(check) || !validTemplateArguments(check.command) || !check.command[0] ||
    Object.keys(check).some((key) => key !== 'command' && !Object.hasOwn(limits, key))) throw new Error('invalid template healthcheck');
  const validated = { command: check.command };
  for (const [key, [min, max, fallback]] of Object.entries(limits)) {
    const value = Object.hasOwn(check, key) ? check[key] : fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error('invalid template healthcheck timing');
    validated[key] = value;
  }
  if (validated.startupTimeoutSec <= validated.intervalSec) throw new Error('startup timeout must exceed the healthcheck interval');
  return validated;
}

function templateEnvironment(template, source) {
  const keys = template.envRefs ?? [];
  if (keys.length === 0) return {};
  if (!isPlainObject(source) || !Object.hasOwn(source, template.id) || !isPlainObject(source[template.id])) return null;
  const local = source[template.id];
  const env = {};
  for (const key of keys) {
    const value = Object.hasOwn(local, key) ? local[key] : undefined;
    if (typeof value !== 'string' || value === '' || value.includes('\0') || Buffer.byteLength(value) > MAX_TEMPLATE_ENV_VALUE_BYTES) return null;
    env[key] = value;
  }
  return env;
}

/** Private node-state fingerprint. The heartbeat exposes only an update flag. */
function templateProfileHash(template, environment) {
  const { resources = TEMPLATE_RESOURCE_DEFAULTS, commandArgs, storageVolume, healthcheck, restartPolicy = 'no', networkId, ports } = template;
  const env = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify({ resources, commandArgs, storageVolume, healthcheck, restartPolicy, networkId, ports, env })).digest('hex');
}

/** Docker may omit the default registry and official namespace from RepoDigests. */
function canonicalTemplateReference(image) {
  return image.replace(/^docker\.io\/(?:library\/)?/, '');
}

function imageMatchesTemplate(inspected, image) {
  const reference = canonicalTemplateReference(image);
  return Array.isArray(inspected?.RepoDigests) && inspected.RepoDigests.some((digest) =>
    typeof digest === 'string' && canonicalTemplateReference(digest) === reference);
}

function templateRuntimeImage(inspected) {
  return inspected?.Os === 'linux' && /^sha256:[0-9a-f]{64}$/.test(inspected.Id ?? '') &&
    isPlainObject(inspected.Config) && Object.keys(inspected.Config.Volumes ?? {}).length === 0;
}

/** Docker's non-TTY log stream carries one eight-byte header per frame. */
function normalizedDockerLogEvents(buffer) {
  const events = [];
  for (let offset = 0; offset < buffer.length;) {
    if (offset + 8 > buffer.length) throw new DockerError('Invalid Docker log frame');
    const stream = buffer[offset];
    const end = offset + 8 + buffer.readUInt32BE(offset + 4);
    if ((stream !== 1 && stream !== 2) || end > buffer.length) throw new DockerError('Invalid Docker log frame');
    const frame = buffer.toString('utf8', offset + 8, end);
    offset = end;
    for (const line of frame.split('\n')) {
      const entry = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z) (.*)$/.exec(line);
      if (!entry) continue;
      const time = Date.parse(entry[1]);
      if (!Number.isSafeInteger(time) || time < 0) continue;
      let label = /^\[(debug|info|warn(?:ing)?|error|fatal|panic)\]/i.exec(entry[2])?.[1];
      if (!label && entry[2].startsWith('{')) {
        try {
          const fields = JSON.parse(entry[2]);
          label = fields?.level ?? fields?.severity;
        } catch { /* only recognized levels are published */ }
      }
      const normalized = typeof label === 'string' ? label.toLowerCase() : '';
      const level = normalized === 'warning' ? 'warn' : ['fatal', 'panic'].includes(normalized) ? 'error' :
        ['debug', 'warn', 'error'].includes(normalized) ? normalized : 'info';
      events.push({ time, level, stream: stream === 1 ? 'stdout' : 'stderr' });
    }
  }
  return events.sort((a, b) => a.time - b.time).slice(-MODULE_LOG_LIMIT);
}

function validTemplateVolumeName(value) {
  return typeof value === 'string' && TEMPLATE_VOLUME_NAME_RE.test(value);
}

function matchesTemplateMount(mount, name) {
  return mount?.Type === 'volume' && mount.Driver === 'local' && mount.Name === name &&
    mount.Destination === TEMPLATE_STORAGE_TARGET && mount.RW === false;
}

async function approvedTemplateVolume(docker, name, moduleId, nodeId) {
  if (!name) return true;
  if (!nodeId || !validTemplateVolumeName(name) || docker.nodeLocal !== true) return false;
  const volume = await docker.inspectVolume(name).catch(() => null);
  const labels = volume?.Labels;
  return volume?.Name === name && volume.Driver === 'local' && volume.Scope === 'local' &&
    (!volume.Options || Object.keys(volume.Options).length === 0) &&
    labels?.[MODULE_STORAGE_LABEL] === 'true' && labels[NODE_LABEL] === nodeId && labels[MODULE_LABEL] === moduleId;
}

async function approvedTemplateNetwork(docker, id, moduleId, nodeId) {
  if (!id) return true;
  if (!nodeId || docker.nodeLocal !== true || !CONTAINER_ID_RE.test(id)) return false;
  const network = await docker.inspectNetwork(id).catch(() => null);
  return network?.Id === id && network.Scope === 'local' && network.Driver === 'bridge' && network.Internal === true &&
    network.EnableIPv6 === false && network.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] === 'isolated' &&
    Object.keys(network.Options).length === 1 && network.Labels?.[MODULE_NETWORK_LABEL] === 'true' &&
    network.Labels[NODE_LABEL] === nodeId && network.Labels[MODULE_LABEL] === moduleId;
}

function isolatedTemplateContainer(container, storageVolume, networkId) {
  const config = container?.HostConfig;
  const mounts = container?.Mounts;
  const storageMatches = storageVolume
    ? mounts?.length === 1 && matchesTemplateMount(mounts[0], storageVolume)
    : mounts?.length === 0;
  const networks = Object.entries(container?.NetworkSettings?.Networks ?? {});
  const networkMatches = networkId
    ? networks.length <= 1 && (config?.NetworkMode === networkId || networks.some(([name, network]) =>
      config?.NetworkMode === name && network.NetworkID === networkId)) &&
      (container.State?.Running === true ? networks[0]?.[1]?.NetworkID === networkId :
        networks.every(([, network]) => !network.NetworkID || network.NetworkID === networkId))
    : config?.NetworkMode === 'none' && networks.every(([name]) => name === 'none');
  return networkMatches && !config.PublishAllPorts && !Object.keys(config.PortBindings ?? {}).length &&
    config.ReadonlyRootfs === true && container.Config?.User === '65534:65534' &&
    config.CapDrop?.includes('ALL') && config.SecurityOpt?.includes('no-new-privileges:true') &&
    storageMatches;
}

function hasTemplateResourceLimits(container, limits) {
  const config = container?.HostConfig;
  const memoryBytes = limits.memoryMiB * 1024 * 1024;
  return config?.NanoCpus === limits.cpuMillicores * 1_000_000 &&
    config.Memory === memoryBytes && config.MemorySwap === memoryBytes && config.PidsLimit === limits.pidsLimit;
}

function hasTemplateEnvironment(container, environment) {
  const configured = container?.Config?.Env;
  return Object.entries(environment).every(([key, value]) => {
    if (!Array.isArray(configured)) return false;
    const entries = configured.filter((line) => typeof line === 'string' && line.startsWith(`${key}=`));
    return entries.length === 1 && entries[0] === `${key}=${value}`;
  });
}

function sameCommandArgs(first, second) {
  return first === second || (Array.isArray(first) && Array.isArray(second) &&
    first.length === second.length && first.every((arg, index) => arg === second[index]));
}

function templateDockerRestartPolicy(name) {
  return { Name: name, MaximumRetryCount: name === 'on-failure' ? TEMPLATE_RESTART_LIMIT : 0 };
}

function matchesTemplateRestartPolicy(container, name) {
  const policy = container?.HostConfig?.RestartPolicy;
  const expected = templateDockerRestartPolicy(name);
  return policy?.Name === expected.Name && (policy.MaximumRetryCount ?? 0) === expected.MaximumRetryCount;
}

function dockerTemplateHealthcheck(check) {
  return { Test: ['CMD', ...check.command], Interval: check.intervalSec * 1e9,
    Timeout: check.timeoutSec * 1e9, Retries: check.retries, StartPeriod: 0 };
}

function matchesTemplateHealthcheck(actual, expected) {
  return sameCommandArgs(actual?.Test, expected.Test) && actual.Interval === expected.Interval &&
    actual.Timeout === expected.Timeout && actual.Retries === expected.Retries && (actual.StartPeriod ?? 0) === expected.StartPeriod;
}

/* --------------------------------------------------- command validation */

/**
 * Validate one `NodeModuleCommand` from the Core before execution.
 *
 * @param {unknown} raw command from the heartbeat response
 * @param {{now?: number}} [options]
 * @returns {{ok:true, command:{id:string,moduleId:string,action:string,image?:string,expiresAt:number}}
 *   | {ok:false, commandId?:string, expired?:boolean, error:string}}
 */
export function sanitizeModuleCommand(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'module command is not an object' };
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof record.id === 'string' ? record.id : '';
  if (!COMMAND_ID_RE.test(id)) return { ok: false, error: 'invalid module command id' };

  const moduleId = typeof record.moduleId === 'string' ? record.moduleId : '';
  const catalogModule = isKnownModule(moduleId);
  if (!isInventoryId(moduleId)) {
    return { ok: false, commandId: id, error: `unknown module id "${moduleId.slice(0, 32)}"` };
  }
  const action = typeof record.action === 'string' ? record.action : '';
  if (!MODULE_ACTIONS.includes(action)) {
    return { ok: false, commandId: id, error: `unknown module action "${action.slice(0, 32)}"` };
  }
  const customInstall = !catalogModule && action === 'install';
  if (moduleId === 'ingress' && (!CUSTOM_LIFECYCLE_ACTIONS.has(action) || action === 'remove' ||
    typeof record.targetContainerId !== 'string' || !CONTAINER_ID_RE.test(record.targetContainerId) || record.image !== undefined)) {
    return { ok: false, commandId: id, error: 'Ingress supports only scoped start, stop and restart' };
  }
  if (moduleId === 'sfu' && (!['start', 'stop', 'restart'].includes(action) || record.image !== undefined ||
    !CONTAINER_ID_RE.test(record.targetContainerId ?? ''))) {
    return { ok: false, commandId: id, error: 'External SFU supports only scoped start and graceful drain actions' };
  }
  if (!catalogModule && (customInstall
    ? (record.targetContainerId !== undefined && (typeof record.targetContainerId !== 'string' ||
      !CONTAINER_ID_RE.test(record.targetContainerId))) || !isPinnedTemplateImage(record.image)
    : !CUSTOM_LIFECYCLE_ACTIONS.has(action) || typeof record.targetContainerId !== 'string' ||
      !CONTAINER_ID_RE.test(record.targetContainerId) || record.image !== undefined)) {
    return { ok: false, commandId: id, error: 'invalid custom container lifecycle or install command' };
  }
  if (catalogModule && !isScopedComposeModule(moduleId) && record.targetContainerId !== undefined) {
    return { ok: false, commandId: id, error: 'catalog commands cannot select a container id' };
  }
  const expiresAt = Number(record.expiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    return { ok: false, commandId: id, error: 'invalid module command expiry' };
  }
  if (expiresAt <= now) {
    // The Core prunes expired commands and ignores a late acknowledgement; do
    // not start Docker work for a command the dashboard already gave up on.
    return { ok: false, commandId: id, expired: true, error: 'module command expired' };
  }

  if (customInstall) return { ok: true, command: { id, moduleId, action, image: record.image, expiresAt,
    ...(record.targetContainerId ? { targetContainerId: record.targetContainerId } : {}),
  } };
  /** @type {{id:string,moduleId:string,action:string,image?:string,expiresAt:number}} */
  const command = { id, moduleId, action, expiresAt,
    ...(!catalogModule || isScopedComposeModule(moduleId) ? { targetContainerId: record.targetContainerId } : {}),
  };
  if (action === 'install') {
    if (moduleId === 'recorder') {
      return { ok: false, commandId: id, error: 'Recorder installation is disabled; use Egress for server recording' };
    }
    if (Object.hasOwn(LEGACY_WORKER_REPOSITORIES, moduleId)) {
      return { ok: false, commandId: id, error: `Install ${moduleId} with the node Compose project` };
    }
    // The only install image accepted is a tag/digest of the module's
    // allowlisted repository. An absent/foreign `image` is rejected, never
    // substituted, and the value is never taken from anywhere else.
    if (typeof record.image !== 'string' || !isAllowlistedModuleImage(moduleId, record.image)) {
      return { ok: false, commandId: id, error: `install image is not allowlisted for module "${moduleId}"` };
    }
    command.image = record.image;
  }
  // A non-install command must not carry an image in the contract; if one is
  // present it is ignored (never used), which keeps a newer/older Core from
  // breaking a lifecycle action.
  return { ok: true, command };
}

/* ------------------------------------------------------------ text helpers */

/** Single-line, bounded diagnostic text (never contains env values/secrets). */
export function sanitizeErrorText(value) {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, NODE_MODULE_MAX_ERROR_CHARS);
}

function sanitizeVersion(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f]/g, '').trim();
  return text.slice(0, NODE_MODULE_MAX_VERSION_CHARS);
}

/** Docker timestamps may carry nanoseconds; `Date.parse` is safest at 3 digits. */
function dockerTimestampMs(value) {
  if (typeof value !== 'string' || value === '') return null;
  const normalized = value.replace(/\.(\d{3})\d+/, '.$1');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containerLabels(container) {
  const labels = container?.Config?.Labels;
  return isPlainObject(labels) ? labels : {};
}

function isContainerRunning(container) {
  const state = container?.State;
  // `GET /containers/{id}/json` has an object; `GET /containers/json` (the list
  // used for lifecycle decisions) has a plain string in the same field.
  if (state && typeof state === 'object') return state.Running === true && state.Restarting !== true;
  return state === 'running';
}

/* ------------------------------------------------------------------ Docker */

/** Any Docker Engine API failure (HTTP error, malformed response, bad config). */
export class DockerError extends Error {
  constructor(message, { status = 0, code = '', unavailable = false } = {}) {
    super(message);
    this.name = 'DockerError';
    this.status = status;
    this.code = code;
    this.unavailable = unavailable;
  }
}

/** The socket/pipe/TCP endpoint is unreachable or not permitted — agent-only mode. */
export class DockerUnavailableError extends DockerError {
  constructor(message, options = {}) {
    super(message, { ...options, unavailable: true });
    this.name = 'DockerUnavailableError';
  }
}

/**
 * Parse `AGIL_NODE_DOCKER_HOST` / `DOCKER_HOST`:
 *   `unix:///var/run/docker.sock`      Unix socket (default)
 *   `npipe:////./pipe/docker_engine`   Windows named pipe
 *   `tcp://127.0.0.1:2375`             TCP (dev/tests; TLS is not implemented)
 *   `/var/run/docker.sock`             bare absolute socket path
 *
 * @returns {{socketPath:string} | {host:string, port:number}}
 */
export function parseDockerHost(dockerHost) {
  const value = typeof dockerHost === 'string' ? dockerHost.trim() : '';
  if (value === '') throw new DockerError('Docker host is empty');
  if (value.startsWith('unix://')) {
    return { socketPath: value.slice('unix://'.length) || '/var/run/docker.sock' };
  }
  if (value.startsWith('npipe://')) {
    const rest = value.slice('npipe://'.length);
    return { socketPath: rest.replace(/\//g, '\\') };
  }
  if (value.startsWith('tcp://') || value.startsWith('http://')) {
    const parsed = new URL(value.replace(/^tcp:\/\//, 'http://'));
    const port = Number(parsed.port || 2375);
    if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new DockerError(`invalid Docker TCP host "${value}"`);
    }
    return { host: parsed.hostname, port };
  }
  if (value.startsWith('/')) return { socketPath: value };
  throw new DockerError(
    `unsupported Docker host "${value}" (expected unix://, npipe://, tcp:// or an absolute socket path)`,
  );
}

/**
 * Minimal Docker Engine API client (no dependencies, no TLS/mTLS).
 *
 * API version negotiation: `GET /_ping` returns the daemon's `Api-Version`
 * header, and subsequent calls use `/v<major>.<minor>/…`. If the header is
 * missing (very old/odd daemon) the unversioned path is used.
 */
export class DockerClient {
  /**
   * @param {object} [options]
   * @param {string} [options.dockerHost] `unix://`, `npipe://`, `tcp://` or a socket path
   * @param {number} [options.requestTimeoutMs]
   * @param {number} [options.pullTimeoutMs]
   */
  constructor({
    dockerHost = 'unix:///var/run/docker.sock',
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    pullTimeoutMs = DEFAULT_PULL_TIMEOUT_MS,
  } = {}) {
    this.dockerHost = dockerHost;
    this.connection = parseDockerHost(dockerHost);
    this.requestTimeoutMs = requestTimeoutMs;
    this.pullTimeoutMs = pullTimeoutMs;
    this.apiVersion = '';
  }

  /** Safe label for logs (a socket path/TCP address; never a credential). */
  get endpointLabel() {
    return this.connection.socketPath ?? `${this.connection.host}:${this.connection.port}`;
  }

  get nodeLocal() {
    const { socketPath, host } = this.connection;
    if (typeof socketPath === 'string') {
      const endpoint = socketPath.replaceAll('\\', '/').toLowerCase();
      return endpoint.startsWith('//./pipe/') || endpoint.startsWith('//?/pipe/') ||
        (endpoint.startsWith('/') && !endpoint.startsWith('//'));
    }
    return (isIP(host) === 4 && host.startsWith('127.')) || host === '::1' || host === '[::1]';
  }

  async ping() {
    const response = await this._raw('GET', '/_ping', { timeoutMs: this.requestTimeoutMs });
    if (response.statusCode !== 200) {
      throw new DockerUnavailableError(`Docker Engine ping failed (HTTP ${response.statusCode})`, {
        status: response.statusCode,
      });
    }
    const header = response.headers['api-version'];
    const version = typeof header === 'string' ? header.trim() : '';
    this.apiVersion = /^\d+\.\d+$/.test(version) ? version : '';
    return this.apiVersion;
  }

  _path(pathname) {
    const clean = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return this.apiVersion ? `/v${this.apiVersion}${clean}` : clean;
  }

  _requestOptions(method, pathname) {
    const headers = { accept: 'application/json' };
    /** @type {import('node:http').RequestOptions} */
    const options = { method, path: this._path(pathname), headers };
    if (this.connection.socketPath) options.socketPath = this.connection.socketPath;
    else {
      options.host = this.connection.host;
      options.port = this.connection.port;
    }
    return options;
  }

  /** One HTTP round-trip. Connection errors become `DockerUnavailableError`. */
  _raw(method, pathname, { body, timeoutMs = this.requestTimeoutMs, binary = false, maxBytes } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const options = this._requestOptions(method, pathname);
      if (payload !== null) {
        options.headers['content-type'] = 'application/json';
        options.headers['content-length'] = Buffer.byteLength(payload);
      }
      // `agent: false` + `connection: close`: one short-lived socket per call, so
      // a one-shot agent exits cleanly (no keep-alive handle left in libuv).
      options.agent = false;
      options.headers.connection = 'close';
      const request = httpRequest(options, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          // Bounded read: Docker error bodies are tiny; a runaway stream must not
          // grow without limit. A pull progress stream is bounded by Docker.
          if (size <= (maxBytes ?? 8 * 1024 * 1024)) chunks.push(chunk);
          else if (maxBytes !== undefined) {
            const error = new DockerError('Docker response exceeds the configured limit');
            reject(error);
            request.destroy(error);
          }
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', reject);
      });
      request.setTimeout(timeoutMs, () => {
        request.destroy(new DockerUnavailableError(`Docker API timed out after ${timeoutMs} ms`));
      });
      if (maxBytes !== undefined) {
        const deadline = setTimeout(() => {
          request.destroy(new DockerUnavailableError(`Docker API timed out after ${timeoutMs} ms`));
        }, timeoutMs).unref();
        request.once('close', () => clearTimeout(deadline));
      }
      request.on('error', (error) => {
        const code = typeof error?.code === 'string' ? error.code : '';
        if (error instanceof DockerError) {
          reject(error);
          return;
        }
        if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EACCES', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
          reject(new DockerUnavailableError(
            `Docker Engine is not reachable at ${this.endpointLabel} (${code})`,
            { code },
          ));
          return;
        }
        reject(new DockerError(`Docker API request failed: ${error?.message ?? String(error)}`, { code }));
      });
      if (payload !== null) request.write(payload);
      request.end();
    });
  }

  async _json(method, pathname, options = {}) {
    const response = await this._raw(method, pathname, options);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new DockerError(
        `Docker ${method} ${pathname.split('?')[0]} failed (HTTP ${response.statusCode}): ${this._dockerMessage(response.body)}`,
        { status: response.statusCode },
      );
    }
    if (response.body.trim() === '') return null;
    try {
      return JSON.parse(response.body);
    } catch {
      throw new DockerError(`Docker returned a non-JSON body for ${pathname.split('?')[0]}`, {
        status: response.statusCode,
      });
    }
  }

  async readModuleLogEvents(id) {
    const response = await this._raw(
      'GET', `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&timestamps=1&tail=${MODULE_LOG_LIMIT}`,
      { binary: true, maxBytes: MODULE_LOG_BYTES, timeoutMs: Math.min(this.requestTimeoutMs, 1500) },
    );
    if (response.statusCode !== 200) throw new DockerError('Docker logs are unavailable');
    return normalizedDockerLogEvents(response.body);
  }

  _dockerMessage(body) {
    try {
      const parsed = JSON.parse(body);
      if (isPlainObject(parsed) && typeof parsed.message === 'string') return sanitizeErrorText(parsed.message);
    } catch {
      /* non-JSON proxy page: fall through to the bounded text below */
    }
    return sanitizeErrorText(body) || 'no error message';
  }

  /** `GET /containers/json?all=1` for the module label (ownership filtered by caller). */
  async listContainers() {
    const filters = encodeURIComponent(JSON.stringify({ label: [MODULE_LABEL] }));
    const list = await this._json('GET', `/containers/json?all=1&filters=${filters}`);
    return Array.isArray(list) ? list : [];
  }

  async inspectContainer(id) {
    return this._json('GET', `/containers/${encodeURIComponent(id)}/json`);
  }

  async inspectVolume(name) {
    return this._json('GET', `/volumes/${encodeURIComponent(name)}`);
  }

  async inspectNetwork(id) {
    return this._json('GET', `/networks/${encodeURIComponent(id)}`);
  }

  async inspectImage(image) {
    return this._json('GET', `/images/${encodeURIComponent(image)}/json`);
  }

  /**
   * Pull one image. `/images/create` streams newline-delimited JSON; a registry
   * error can arrive inside a 200 stream, so the whole body is scanned for an
   * `error` field and only then treated as a success.
   */
  async pullImage(image) {
    if (!isValidImageReference(image)) {
      throw new DockerError('refusing to pull an invalid image reference');
    }
    const at = image.indexOf('@');
    let query;
    if (at >= 0) {
      // Digest pulls are passed whole in `fromImage` (there is no tag part).
      query = `fromImage=${encodeURIComponent(image)}`;
    } else {
      const slash = image.lastIndexOf('/');
      const colon = image.lastIndexOf(':');
      if (colon > slash) {
        query = `fromImage=${encodeURIComponent(image.slice(0, colon))}&tag=${encodeURIComponent(image.slice(colon + 1))}`;
      } else {
        query = `fromImage=${encodeURIComponent(image)}&tag=latest`;
      }
    }
    const response = await this._raw('POST', `/images/create?${query}`, { timeoutMs: this.pullTimeoutMs });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new DockerError(
        `Docker image pull failed (HTTP ${response.statusCode}): ${this._dockerMessage(response.body)}`,
        { status: response.statusCode },
      );
    }
    for (const line of response.body.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const event = JSON.parse(trimmed);
        if (isPlainObject(event) && typeof event.error === 'string' && event.error.trim() !== '') {
          throw new DockerError(`Docker image pull failed: ${sanitizeErrorText(event.error)}`);
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        /* progress lines can be interrupted/flushed oddly; ignore non-JSON */
      }
    }
  }

  /**
   * Create a module container. Labels are the ownership contract; published
   * ports come from the agent-side allowlist (never from the dashboard).
   */
  async createContainer({ name, image, labels, env = {}, ports = [], bindIp = '0.0.0.0', modelDirectory, network, templateResources, storageVolume, commandArgs, templateRestart = 'no', templateHealthcheck, templateNetworkId, templatePorts }) {
    const payload = {
      Image: image,
      Labels: labels,
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
      },
    };
    if (templateResources) {
      payload.User = '65534:65534';
      if (commandArgs !== undefined) payload.Cmd = commandArgs;
      if (templateHealthcheck) payload.Healthcheck = templateHealthcheck;
      if (templatePorts) payload.ExposedPorts = Object.fromEntries(templatePorts.map(({ port, protocol }) => [`${port}/${protocol}`, {}]));
      Object.assign(payload.HostConfig, {
        NetworkMode: templateNetworkId ?? 'none',
        IpcMode: 'private',
        CgroupnsMode: 'private',
        Runtime: 'runc',
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        RestartPolicy: templateDockerRestartPolicy(templateRestart),
        Memory: templateResources.memoryMiB * 1024 * 1024,
        MemorySwap: templateResources.memoryMiB * 1024 * 1024,
        NanoCpus: templateResources.cpuMillicores * 1_000_000,
        PidsLimit: templateResources.pidsLimit,
        LogConfig: { Type: 'none' },
      });
      if (storageVolume) payload.HostConfig.Mounts = [{
        Type: 'volume', Source: storageVolume, Target: TEMPLATE_STORAGE_TARGET, ReadOnly: true, VolumeOptions: { NoCopy: true },
      }];
    }
    if (modelDirectory) {
      Object.assign(payload.HostConfig, {
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Mounts: [{ Type: 'bind', Source: modelDirectory, Target: STT_MODEL_TARGET, ReadOnly: true }],
      });
    }
    if (network) payload.HostConfig.NetworkMode = network;
    const envNames = Object.keys(env);
    if (envNames.length > 0) payload.Env = envNames.map((key) => `${key}=${env[key]}`);
    if (ports.length > 0) {
      const exposed = {};
      const bindings = {};
      for (const { port, protocol } of ports) {
        const key = `${port}/${protocol}`;
        exposed[key] = {};
        bindings[key] = [{ HostIp: bindIp, HostPort: String(port) }];
      }
      payload.ExposedPorts = exposed;
      payload.HostConfig.PortBindings = bindings;
    }
    const created = await this._json('POST', `/containers/create?name=${encodeURIComponent(name)}`, { body: payload });
    if (!isPlainObject(created) || typeof created.Id !== 'string' || created.Id === '') {
      throw new DockerError('Docker created a container without returning its id');
    }
    return created;
  }

  /** Start; 304 means "already started" and is therefore success (idempotent). */
  async startContainer(id) {
    const response = await this._raw('POST', `/containers/${encodeURIComponent(id)}/start`);
    if (response.statusCode !== 204 && response.statusCode !== 304) {
      throw new DockerError(
        `Docker container start failed (HTTP ${response.statusCode}): ${this._dockerMessage(response.body)}`,
        { status: response.statusCode },
      );
    }
  }

  /** Stop; 304 means "already stopped" (idempotent). */
  async stopContainer(id, { timeoutSec = 10 } = {}) {
    const response = await this._raw(
      'POST',
      `/containers/${encodeURIComponent(id)}/stop?t=${Math.max(0, Math.trunc(timeoutSec))}`,
    );
    if (response.statusCode !== 204 && response.statusCode !== 304) {
      throw new DockerError(
        `Docker container stop failed (HTTP ${response.statusCode}): ${this._dockerMessage(response.body)}`,
        { status: response.statusCode },
      );
    }
  }

  /** One signal, with no daemon timeout that later escalates to SIGKILL. */
  async signalContainerToDrain(id) {
    const response = await this._raw('POST', `/containers/${encodeURIComponent(id)}/kill?signal=SIGTERM`);
    if (response.statusCode !== 204) {
      throw new DockerError(`Docker refused the SFU drain signal (HTTP ${response.statusCode})`, { status: response.statusCode });
    }
  }

  async restartContainer(id, { timeoutSec = 10 } = {}) {
    const response = await this._raw(
      'POST',
      `/containers/${encodeURIComponent(id)}/restart?t=${Math.max(0, Math.trunc(timeoutSec))}`,
    );
    if (response.statusCode !== 204 && response.statusCode !== 304) {
      throw new DockerError(
        `Docker container restart failed (HTTP ${response.statusCode}): ${this._dockerMessage(response.body)}`,
        { status: response.statusCode },
      );
    }
  }

  /** Remove; explicit operator removal may stop a running container. */
  async removeContainer(id, { force = true, volumes = true } = {}) {
    const response = await this._raw(
      'DELETE',
      `/containers/${encodeURIComponent(id)}?force=${force ? 1 : 0}&v=${volumes ? 1 : 0}`,
    );
    if (response.statusCode !== 204 && response.statusCode !== 404) {
      throw new DockerError(
        `Docker container remove failed (HTTP ${response.statusCode}): ${this._dockerMessage(response.body)}`,
        { status: response.statusCode },
      );
    }
  }

  async updateRestartPolicy(id, enabled) {
    const response = await this._raw('POST', `/containers/${encodeURIComponent(id)}/update`, {
      body: { RestartPolicy: { Name: enabled ? 'unless-stopped' : 'no', MaximumRetryCount: 0 } },
    });
    if (response.statusCode !== 200) {
      throw new DockerError(
        `Docker restart policy update failed (HTTP ${response.statusCode}): ${this._dockerMessage(response.body)}`,
        { status: response.statusCode },
      );
    }
  }
}

/* ----------------------------------------------------- container -> report */

/**
 * Map a Docker inspect payload to a `NodeModuleReport`, or `null` when the
 * container is not a real, allowlisted, node-owned module. This never invents
 * a value: every field comes from Docker or from the container image reference.
 *
 * @param {object} container `GET /containers/{id}/json`
 * @param {{moduleId:string, nodeId:string}} input
 * @returns {null | {id:string,image:string,status:string,health?:string,version?:string,
 *   ports?:number[],updatedAt?:number,lastError?:string}}
 */
export function buildModuleReport(container, { moduleId, nodeId }) {
  if (!isInventoryId(moduleId) || typeof nodeId !== 'string' || nodeId === '') return null;
  const catalogModule = isKnownModule(moduleId);
  const labels = containerLabels(container);
  if (labels[MODULE_LABEL] !== moduleId) return null;
  // Ownership: a container for another node (or without the label) is never
  // reported or touched by this agent, even if it carries the module label.
  if (labels[NODE_LABEL] !== nodeId) return null;
  const image = typeof container?.Config?.Image === 'string' ? container.Config.Image.trim() : '';
  if (!isValidImageReference(image) || (catalogModule && !isAllowlistedModuleImage(moduleId, image))) return null;

  const state = isPlainObject(container?.State) ? container.State : {};
  const status = reportStatusFromState(state, moduleId);

  /** @type {{id:string,kind?:string,image:string,status:string,health?:string,version?:string,
   *   ports?:number[],updatedAt?:number,lastError?:string,autoStart?:boolean}} */
  const report = { id: moduleId, image, status };
  if (!catalogModule && isInventoryId(labels[MODULE_KIND_LABEL])) report.kind = labels[MODULE_KIND_LABEL];

  const health = isScopedComposeModule(moduleId) && status !== 'running' ? 'unknown' : healthFromState(state);
  // `unknown` is the honest default; sending it is harmless and explicit.
  report.health = health;
  const restartPolicy = container.HostConfig?.RestartPolicy?.Name;
  const composeWorker = isComposeWorkerImage(moduleId, image);
  if (!composeWorker && (restartPolicy === 'no' || restartPolicy === 'unless-stopped')) {
    report.autoStart = restartPolicy === 'unless-stopped';
  }

  const imageVersion = containerLabels(container)['org.opencontainers.image.version'];
  const explicitVersion = containerLabels(container)['agil.module.version'];
  const version = sanitizeVersion(
    typeof imageVersion === 'string' && imageVersion.trim() !== ''
      ? imageVersion
      : typeof explicitVersion === 'string' && explicitVersion.trim() !== ''
        ? explicitVersion
        : moduleImageTag(image),
  );
  if (version !== '') report.version = version;

  const ports = publishedPorts(container);
  if (ports.length > 0) report.ports = ports;

  const updatedAt = lastStateChangeMs(container, state);
  if (updatedAt !== null) report.updatedAt = updatedAt;

  const lastError = sanitizeErrorText(
    catalogModule && !isScopedComposeModule(moduleId) && !composeWorker && typeof state.Error === 'string' && state.Error.trim() !== ''
      ? state.Error
      : status === 'error' && Number.isInteger(state.ExitCode) && state.ExitCode !== 0
        ? `container exited with code ${state.ExitCode}`
        : '',
  );
  if (lastError !== '') report.lastError = lastError;

  return report;
}

/** Restrict optional control to operator-labelled, isolated containers. */
async function customLifecycleTarget(docker, container, moduleId, nodeId, externalSfu = false) {
  const labels = containerLabels(container);
  const host = container?.HostConfig;
  const compose = isScopedComposeModule(moduleId);
  if ((isKnownModule(moduleId) && !compose) || !nodeId || labels[MODULE_LABEL] !== moduleId || labels[NODE_LABEL] !== nodeId ||
    labels[MODULE_LIFECYCLE_LABEL] !== 'true' || !CONTAINER_ID_RE.test(container?.Id ?? '') ||
    !isPlainObject(host) || host.Privileged !== false || host.AutoRemove || !Array.isArray(container.Mounts)) return undefined;
  if (moduleId === 'sfu' && (!externalSfu || host.NetworkMode !== 'host' ||
    (!isContainerRunning(container) && !stoppedSfu(container.State)))) return undefined;
  if (compose && (docker.nodeLocal !== true || labels['com.docker.compose.service'] !== SCOPED_COMPOSE_SERVICES[moduleId] ||
    !labels['com.docker.compose.project'] || container.Mounts.length !== 0 ||
    !isAllowlistedModuleImage(moduleId, container.Config?.Image))) return undefined;
  if (host.CapAdd?.length || host.Devices?.length || host.DeviceRequests?.length ||
    host.DeviceCgroupRules?.length || host.VolumesFrom?.length ||
    host.SecurityOpt?.some((option) => option !== 'no-new-privileges' && option !== 'no-new-privileges:true')) return undefined;
  if (typeof host.NetworkMode !== 'string' || (!compose && host.NetworkMode === 'host') || host.NetworkMode.startsWith('container:') ||
    host.PidMode || (host.IpcMode && host.IpcMode !== 'private') ||
    host.UTSMode || host.UsernsMode || (host.CgroupnsMode && host.CgroupnsMode !== 'private') ||
    (host.Runtime && host.Runtime !== 'runc')) return undefined;
  if (container.Mounts.length > 8) return undefined;
  if (COMMAND_ID_RE.test(labels[TEMPLATE_INSTALL_LABEL] ?? '') && container.Mounts.length > 0) {
    const [mount] = container.Mounts;
    return container.Mounts.length === 1 && matchesTemplateMount(mount, mount?.Name) &&
      validTemplateVolumeName(mount.Name) && await approvedTemplateVolume(docker, mount.Name, moduleId, nodeId)
      ? container.Id : undefined;
  }
  for (const mount of container.Mounts) {
    if (mount.Type === 'tmpfs') continue;
    if (mount.Type !== 'volume' || mount.Driver !== 'local' || typeof mount.Name !== 'string' || !mount.Name) return undefined;
    const volume = await docker.inspectVolume(mount.Name);
    if (volume?.Driver !== 'local' || (volume.Options && Object.keys(volume.Options).length > 0)) return undefined;
  }
  return container.Id;
}

function reportStatusFromState(state, moduleId) {
  if (state.Restarting === true) return 'error';
  if (state.Dead === true) return 'error';
  if (state.Paused === true) return 'unknown';
  if (state.Running === true) return 'running';
  switch (state.Status) {
    case 'created':
      return 'stopped';
    case 'exited':
      if (isScopedComposeModule(moduleId) && state.ExitCode === 143 && !state.OOMKilled && !state.Error) return 'stopped';
      return Number.isInteger(state.ExitCode) && state.ExitCode !== 0 ? 'error' : 'stopped';
    case 'removing':
      return 'unknown';
    default:
      return state.Running === false && state.Status === 'created' ? 'stopped' : 'unknown';
  }
}

function healthFromState(state) {
  const health = isPlainObject(state.Health) ? state.Health.Status : '';
  switch (health) {
    case 'healthy':
      return 'healthy';
    case 'unhealthy':
      return 'unhealthy';
    // A health check that has not finished its first interval is not a silent
    // "healthy": report the intermediate state as degraded.
    case 'starting':
      return 'degraded';
    default:
      return 'unknown';
  }
}

function publishedPorts(container) {
  const ports = new Set();
  const bindings = isPlainObject(container?.NetworkSettings?.Ports) ? container.NetworkSettings.Ports : {};
  for (const entries of Object.values(bindings)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const port = Number(entry?.HostPort);
      if (Number.isInteger(port) && port >= 1 && port <= 65_535) ports.add(port);
    }
  }
  // Host networking (no port bindings) still has the container's exported
  // ports; reporting the actual `EXPOSE`d ports is honest and useful.
  if (ports.size === 0) {
    const exposed = isPlainObject(container?.Config?.ExposedPorts) ? container.Config.ExposedPorts : {};
    for (const key of Object.keys(exposed)) {
      const port = Number.parseInt(String(key).split('/')[0], 10);
      if (Number.isInteger(port) && port >= 1 && port <= 65_535) ports.add(port);
    }
  }
  return [...ports].sort((left, right) => left - right).slice(0, NODE_MODULE_MAX_PORTS);
}

function lastStateChangeMs(container, state) {
  const candidates = [
    dockerTimestampMs(state.StartedAt),
    dockerTimestampMs(state.FinishedAt),
    dockerTimestampMs(container?.Created),
  ].filter((value) => value !== null);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

/* ----------------------------------------------------------------- manager */

const noopLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/** Safe container name for a module on this node (`agil-<module>-<node>`). */
export function moduleContainerName(nodeId, moduleId) {
  const slug = String(nodeId)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40) || 'node';
  return `agil-${moduleId}-${slug}`.slice(0, 63);
}

/**
 * Owns module discovery, command execution and the result queue.
 *
 * Public surface used by the agents:
 *   `init()`, `status()`, `inventory()`, `handleCommands()`, `whenIdle()`,
 *   `pendingResults()`, `ackResults()`, `close()`.
 */
export class ModuleManager {
  /**
   * @param {object} [options]
   * @param {string|(() => string)} [options.nodeId] this node's id (ownership label)
   * @param {'auto'|'on'|'off'} [options.mode] `auto` probes and degrades, `on` warns loudly, `off` disables
   * @param {DockerClient} [options.docker] injected client (tests/fakes)
   * @param {string} [options.dockerHost] used only when no `docker` client is supplied
   * @param {number} [options.requestTimeoutMs]
   * @param {number} [options.pullTimeoutMs]
   * @param {string|null} [options.stateFile] persists pending results + executed ids (0600)
   * @param {string|null} [options.envFile] node-local `{ "<module>": { "KEY": "value" } }` env file
   * @param {{debug:Function,info:Function,warn:Function,error:Function}} [options.log]
   * @param {() => number} [options.now]
   */
  constructor({
    nodeId = '',
    mode = 'auto',
    docker = null,
    dockerHost = 'unix:///var/run/docker.sock',
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    pullTimeoutMs = DEFAULT_PULL_TIMEOUT_MS,
    stateFile = null,
    envFile = null,
    templatesFile = null,
    externalSfu = false,
    log = noopLogger,
    now = Date.now,
  } = {}) {
    this.mode = ['auto', 'on', 'off'].includes(mode) ? mode : 'auto';
    this._nodeIdSource = typeof nodeId === 'function' ? nodeId : () => nodeId;
    this.log = log ?? noopLogger;
    this.now = now;
    this.stateFile = stateFile;
    this.envFile = envFile;
    this.templatesFile = templatesFile;
    this.externalSfu = externalSfu === true;
    this.templateConfigurationInvalid = false;
    this.docker = docker ?? new DockerClient({ dockerHost, requestTimeoutMs, pullTimeoutMs });
    this.available = false;
    this.apiVersion = '';
    this.lastError = '';
    this.lastInventory = null;
    this.pending = new Map();
    this.executed = new Map();
    this.templateContainers = new Map();
    this.queue = [];
    this.pumping = false;
    this.closed = false;
    this.idleWaiters = [];
    this.persistChain = Promise.resolve();
    this.failureLogAt = 0;
    this.loaded = false;
    this.ownershipWarned = false;
  }

  _nodeId() {
    const value = this._nodeIdSource();
    return typeof value === 'string' ? value.trim() : '';
  }

  /** Probe Docker, load persisted command results. Never throws. */
  async init() {
    if (this.loaded) return this.status();
    this.loaded = true;
    await this._loadState();
    if (this.mode === 'off') {
      this.log.info('Docker module management disabled (mode=off)');
      return this.status();
    }
    if (this._nodeId() === '') {
      this.log.warn('module management disabled: the node id is empty (cannot own containers)');
      return this.status();
    }
    try {
      this.apiVersion = await this.docker.ping();
      this.available = true;
      this.lastError = '';
      this.log.info('Docker Engine reachable: module management enabled', {
        endpoint: this.docker.endpointLabel ?? null,
        apiVersion: this.apiVersion || null,
        mode: this.mode,
      });
    } catch (error) {
      this._recordDockerFailure(error, { initial: true });
    }
    return this.status();
  }

  /** Safe-for-logs/endpoints summary; never contains env values or secrets. */
  status() {
    return {
      enabled: this.mode !== 'off',
      mode: this.mode,
      available: this.available,
      apiVersion: this.apiVersion || null,
      managed: this.lastInventory ? this.lastInventory.length : 0,
      pendingResults: this.pending.size,
      lastError: this.lastError || null,
    };
  }

  /** Capability for this heartbeat. A failed inventory is unavailable even after a successful ping. */
  inventoryAvailability(snapshot) {
    if (this.mode === 'off') return 'disabled';
    return snapshot === undefined ? 'unavailable' : 'available';
  }

  /** True when Docker was reachable at the last probe. */
  isAvailable() {
    return this.available && this.mode !== 'off';
  }

  _recordDockerFailure(error, { initial = false } = {}) {
    const wasAvailable = this.available;
    this.available = false;
    const message = error instanceof DockerError ? error.message : String(error?.message ?? error);
    this.lastError = sanitizeErrorText(message) || 'Docker Engine unavailable';
    const now = this.now();
    const shouldLog = initial || wasAvailable || now - this.failureLogAt >= DOCKER_FAILURE_LOG_INTERVAL_MS;
    if (!shouldLog) return;
    this.failureLogAt = now;
    const extra = {
      endpoint: this.docker.endpointLabel ?? null,
      error: this.lastError,
      action: 'mount the Docker socket and give the agent user access, or set AGIL_NODE_MODULES=off; '
        + 'the agent keeps heartbeating without a modules snapshot',
    };
    if (initial && this.mode !== 'on') {
      this.log.info('Docker Engine unavailable: running as an agent-only node', extra);
    } else {
      this.log.warn('Docker Engine unavailable: module reporting is paused', extra);
    }
  }

  /** Probe again after a failure so a Docker that starts later is picked up. */
  async _ensureAvailable() {
    if (this.available) return true;
    if (this.mode === 'off' || this.closed) return false;
    try {
      this.apiVersion = await this.docker.ping();
      this.available = true;
      this.lastError = '';
      this.log.info('Docker Engine became reachable again: module management resumed', {
        apiVersion: this.apiVersion || null,
      });
      return true;
    } catch (error) {
      this._recordDockerFailure(error);
      return false;
    }
  }

  /** Read the locally approved catalog and check image availability without pulling. */
  async templateCatalog() {
    if (!this.templatesFile || this.closed || this.mode === 'off') return undefined;
    let entries;
    try {
      entries = await readModuleTemplates(this.templatesFile);
      this.templateConfigurationInvalid = false;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.templateConfigurationInvalid = false;
        return undefined;
      } else if (!this.templateConfigurationInvalid) {
        this.templateConfigurationInvalid = true;
        this.log.warn('local module template catalog is invalid; no templates advertised');
      }
      return [];
    }
    const source = entries.some(({ install, envRefs }) => install && envRefs?.length)
      ? await this._readTemplateEnvironmentSource() : null;
    return Promise.all(entries.map(async (template) => {
      const { id, image, install, resources, storageVolume, commandArgs, restartPolicy, healthcheck, networkId, ports } = template;
      const { cached, inspected, blockedReason: imageBlocked } = await this._inspectTemplateImage(image);
      let blockedReason = imageBlocked;
      if (!blockedReason && install && this.docker.nodeLocal !== true &&
        (commandArgs !== undefined || restartPolicy === 'on-failure' || healthcheck)) blockedReason = 'inspection_failed';
      const environment = install ? templateEnvironment(template, source) : null;
      if (!blockedReason && install && !environment) blockedReason = 'environment_unavailable';
      if (!blockedReason && install && !(await approvedTemplateVolume(this.docker, storageVolume, id, this._nodeId()))) {
        blockedReason = 'storage_unavailable';
      }
      if (!blockedReason && install && !(await approvedTemplateNetwork(this.docker, networkId, id, this._nodeId()))) {
        blockedReason = 'network_unavailable';
      }
      const previous = this.templateContainers.get(id);
      const profileChanged = install && !blockedReason && previous?.imageId === inspected?.Id &&
        previous?.nodeId === this._nodeId() && previous.profileHash !== templateProfileHash(template, environment);
      return {
        id, image, cached, ...(resources ? { resources } : {}),
        ...(storageVolume ? { storage: 'read_only' } : {}),
        ...(ports ? { privatePorts: ports } : {}),
        ...(profileChanged ? { profileChanged: true } : {}),
        ...(install ? blockedReason ? { blockedReason } : { installable: true } : {}),
      };
    }));
  }

  async _readTemplateEnvironmentSource() {
    if (!this.envFile || this.docker.nodeLocal !== true) return null;
    return readNodeLocalJson(this.envFile, MAX_TEMPLATE_ENV_FILE_BYTES, { privateOnly: true }).catch(() => null);
  }

  async _inspectTemplateImage(image) {
    try {
      const inspected = await this.docker.inspectImage(image);
      const cached = imageMatchesTemplate(inspected, image);
      if (!cached) return { cached, blockedReason: 'image_not_cached' };
      if (!templateRuntimeImage(inspected)) return { cached, blockedReason: 'image_incompatible' };
      return { cached, inspected };
    } catch (error) {
      return { cached: false, blockedReason: error?.status === 404 ? 'image_not_cached' : 'inspection_failed' };
    }
  }

  /**
   * Full inventory snapshot. `undefined` = "not reported" (Docker unavailable),
   * `[]` = Docker answered and this node has no managed modules installed.
   */
  async inventory() {
    if (this.mode === 'off' || this.closed) return undefined;
    if (!(await this._ensureAvailable())) return undefined;
    const nodeId = this._nodeId();
    if (nodeId === '') return undefined;
    try {
      const containers = await this.docker.listContainers();
      // Filter by module id + ownership before inspecting: never even look at a
      // container that belongs to another node or has an invalid module id.
      const owned = containers
        .filter((summary) => {
          const labels = isPlainObject(summary?.Labels) ? summary.Labels : {};
          return isInventoryId(labels[MODULE_LABEL]) && labels[NODE_LABEL] === nodeId;
        })
        .sort((left, right) => Number(isKnownModule(right.Labels[MODULE_LABEL])) - Number(isKnownModule(left.Labels[MODULE_LABEL])));
      const labelCounts = new Map();
      for (const { Labels: labels } of owned) {
        const id = labels[MODULE_LABEL];
        labelCounts.set(id, (labelCounts.get(id) ?? 0) + 1);
      }
      const logTargets = new Set(owned.filter(({ Id, Labels }) => CONTAINER_ID_RE.test(Id) &&
        labelCounts.get(Labels[MODULE_LABEL]) === 1 && Labels[MODULE_LOGS_LABEL] === 'true')
        .slice(0, MODULE_LOG_SNAPSHOT_LIMIT).map(({ Id }) => Id));
      // Inspect concurrently so a slow/hung Docker daemon costs one request
      // timeout rather than one per container before the heartbeat proceeds.
      const reports = await Promise.all(owned.slice(0, NODE_MODULE_MAX_ITEMS).map(async (summary) => {
        const moduleId = summary.Labels[MODULE_LABEL];
        try {
          const container = await this.docker.inspectContainer(summary.Id);
          const report = buildModuleReport(container, { moduleId, nodeId });
          if (!report) {
            this.log.warn('module container has a non-allowlisted image or missing ownership; not reported', {
              moduleId,
            });
            return null;
          }
          if (logTargets.has(summary.Id) && container.Id === summary.Id && container.Config?.Tty !== true &&
            containerLabels(container)[MODULE_LOGS_LABEL] === 'true' && container.HostConfig?.LogConfig?.Type !== 'none') {
            report.logs = await this.docker.readModuleLogEvents(summary.Id)
              .then((events) => ({ status: 'ready', events }), () => ({ status: 'unavailable', events: [] }));
          }
          if ((!isKnownModule(moduleId) || isScopedComposeModule(moduleId)) && labelCounts.get(moduleId) === 1) {
            const target = await customLifecycleTarget(this.docker, container, moduleId, nodeId, this.externalSfu).catch(() => undefined);
            if (target === summary.Id) {
              report.lifecycleContainerId = target;
              if (moduleId === 'sfu' && report.status === 'running') {
                const sfuDrainState = await this._externalSfuDrainState(container);
                if (sfuDrainState) report.sfuDrainState = sfuDrainState;
              }
              if (this._matchesInstalledTemplate(container, moduleId, nodeId)) {
                report.templateRemovable = true;
                const installed = this.templateContainers.get(moduleId);
                if (installed?.image) report.image = installed.image;
                const recordedStop = installed?.stoppedAt;
                if (recordedStop && container.State?.Status === 'exited' && !container.State.OOMKilled &&
                  !container.State.Error && container.State.FinishedAt === recordedStop) {
                  report.status = 'stopped';
                  delete report.lastError;
                }
              }
            }
          }
          return report;
        } catch (error) {
          if (error instanceof DockerUnavailableError) throw error;
          // A container removed between `ps` and `inspect` is simply gone.
          this.log.debug('could not inspect a module container; skipping', {
            moduleId,
            error: isKnownModule(moduleId) && !isScopedComposeModule(moduleId)
              ? sanitizeErrorText(error?.message ?? String(error)) : 'Docker inspect failed',
          });
          return null;
        }
      }));
      /** @type {Map<string, object>} */
      const byModule = new Map();
      for (const report of reports) {
        if (!report) continue;
        const previous = byModule.get(report.id);
        const currentIsCompose = isComposeWorkerImage(report.id, report.image);
        const previousIsCompose = previous ? isComposeWorkerImage(previous.id, previous.image) : false;
        if (!previous || (currentIsCompose !== previousIsCompose ? currentIsCompose : preferReport(report, previous))) {
          byModule.set(report.id, report);
        }
      }
      const customIds = [...byModule.keys()].filter((id) => !isKnownModule(id)).sort();
      const snapshot = [...MODULE_IDS, ...customIds].filter((id) => byModule.has(id)).map((id) => byModule.get(id));
      this.lastInventory = snapshot;
      this.lastError = '';
      return snapshot;
    } catch (error) {
      if (error instanceof DockerUnavailableError) {
        this._recordDockerFailure(error);
        // Keep the previous snapshot for the status endpoint but omit it from
        // the heartbeat: a stale inventory must not look current.
        return undefined;
      }
      this.lastError = sanitizeErrorText(error?.message ?? String(error)) || 'Docker inventory failed';
      this.log.warn('Docker module inventory failed; omitting the snapshot this heartbeat', {
        error: this.lastError,
      });
      return undefined;
    }
  }

  /**
   * Last successfully collected inventory (`undefined` when none yet). Used on
   * shutdown so the graceful offline heartbeat does not wait on Docker again.
   */
  lastSnapshot() {
    return this.lastInventory ?? undefined;
  }

  /** Result list to send on the next heartbeat (bounded, oldest first). */
  pendingResults() {
    return [...this.pending.values()];
  }

  /**
   * Drop results the Core acknowledged (called only after a 200 heartbeat).
   * Results added while the request was in flight are not in `commandIds` and
   * stay queued for the following beat.
   */
  async ackResults(commandIds) {
    if (!Array.isArray(commandIds) || commandIds.length === 0) return;
    let changed = false;
    for (const id of commandIds) {
      if (typeof id === 'string' && this.pending.delete(id)) changed = true;
    }
    if (changed) await this._persist();
  }

  /**
   * Queue the commands from one heartbeat and execute them in the background so
   * a slow image pull cannot delay the next heartbeat. Resolves when the queue
   * (including commands added meanwhile) is drained; the caller does not have to
   * await it.
   */
  handleCommands(commands) {
    if (this.closed) return Promise.resolve([]);
    const list = Array.isArray(commands) ? commands.slice(0, MAX_COMMANDS_PER_BEAT) : [];
    if (list.length === 0) return Promise.resolve([]);
    this.queue.push(...list);
    this._pump();
    return this.whenIdle();
  }

  /** Resolves once no command is queued/executing. */
  whenIdle() {
    if (!this.pumping && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  _pump() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    (async () => {
      while (this.queue.length > 0 && !this.closed) {
        const command = this.queue.shift();
        try {
          await this.executeCommand(command);
        } catch (error) {
          // executeCommand catches Docker failures into results; this is a
          // last-resort guard so one bad command can never kill the queue.
          this.log.error('module command handler failed', {
            error: sanitizeErrorText(error?.stack ?? String(error)),
          });
        }
      }
    })().finally(() => {
      this.pumping = false;
      const waiters = this.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    });
  }

  /**
   * Validate and execute exactly one command; records its result.
   * Exposed so tests can drive a command without a heartbeat loop.
   *
   * @returns {Promise<null | {commandId:string, ok:boolean, status:string, error?:string}>}
   */
  async executeCommand(raw) {
    if (this.closed) return null;
    const validation = sanitizeModuleCommand(raw, { now: this.now() });
    if (!validation.ok) {
      if (validation.expired) {
        this.log.warn('module command expired before execution; skipping', {
          commandId: validation.commandId ?? null,
        });
        return null;
      }
      if (!validation.commandId) {
        this.log.warn('dropping malformed module command (no usable command id)', {
          error: validation.error,
        });
        return null;
      }
      // A command with a usable id but an invalid module/action/image is
      // acknowledged as rejected so the Core/dashboard does not wait forever.
      return this._recordResult({
        commandId: validation.commandId,
        ok: false,
        status: 'unknown',
        error: sanitizeErrorText(validation.error) || 'invalid module command',
      }, { phase: 'rejected' });
    }

    const command = validation.command;
    if (this.executed.has(command.id)) {
      this.log.debug('duplicate module command ignored', {
        commandId: command.id,
        moduleId: command.moduleId,
        action: command.action,
      });
      return null;
    }

    if (this.mode === 'off') {
      return this._recordResult({
        commandId: command.id,
        ok: false,
        status: 'unknown',
        error: 'module management is disabled on this node (AGIL_NODE_MODULES=off)',
      }, { command });
    }
    if (!(await this._ensureAvailable())) {
      return this._recordResult({
        commandId: command.id,
        ok: false,
        status: 'unknown',
        error: 'Docker Engine is not reachable on this node; check the Docker socket mount',
      }, { command });
    }

    let result;
    try {
      result = await this._execute(command);
    } catch (error) {
      const custom = !isKnownModule(command.moduleId) || isScopedComposeModule(command.moduleId);
      const status = custom ? 'unknown' : await this._currentStatus(command.moduleId);
      result = {
        commandId: command.id,
        ok: false,
        status,
        error: custom ? 'Custom container action failed; check the container on the node' : sanitizeErrorText(
          error instanceof DockerError
            ? error.message
            : error?.message ?? String(error),
        ) || 'module command failed',
      };
    }
    return this._recordResult(result, { command });
  }

  async _execute(command) {
    const { moduleId, action } = command;
    if (!isKnownModule(moduleId) && action === 'install') return this._installCustomTemplate(command);
    if (command.targetContainerId) return this._executeCustomLifecycle(command);
    const existing = await this._findOwnedContainer(moduleId);
    if (existing && Object.hasOwn(LEGACY_WORKER_REPOSITORIES, moduleId)) {
      const container = await this.docker.inspectContainer(existing.Id);
      const image = container.Config?.Image;
      if (isComposeWorkerImage(moduleId, image)) {
        return { commandId: command.id, ok: false, status: reportStatusFromState(container.State, moduleId),
          error: 'Manage this worker with its node Compose project' };
      }
      if (container.Id !== existing.Id || !buildModuleReport(container, { moduleId, nodeId: this._nodeId() })) {
        return { commandId: command.id, ok: false, status: 'unknown', error: 'The existing worker no longer matches its catalog entry' };
      }
    }

    switch (action) {
      case 'install':
        return this._install(command, existing);
      case 'start': {
        if (!existing) return this._notInstalled(command);
        if (!isContainerRunning(existing)) await this.docker.startContainer(existing.Id);
        return this._resultFor(command, existing.Id);
      }
      case 'stop': {
        if (!existing) return { commandId: command.id, ok: true, status: 'unknown' };
        if (isContainerRunning(existing)) await this.docker.stopContainer(existing.Id);
        return this._resultFor(command, existing.Id);
      }
      case 'restart': {
        if (!existing) return this._notInstalled(command);
        await this.docker.restartContainer(existing.Id);
        return this._resultFor(command, existing.Id);
      }
      case 'enable-autostart':
      case 'disable-autostart': {
        if (!existing) return this._notInstalled(command);
        const container = await this.docker.inspectContainer(existing.Id);
        const report = buildModuleReport(container, { moduleId, nodeId: this._nodeId() });
        if (report?.autoStart === undefined) throw new Error('This container restart policy cannot be managed');
        const enabled = action === 'enable-autostart';
        if (enabled !== report.autoStart) await this.docker.updateRestartPolicy(existing.Id, enabled);
        return this._resultFor(command, existing.Id);
      }
      case 'remove': {
        if (!existing) return { commandId: command.id, ok: true, status: 'unknown' };
        if (moduleId === 'recorder') {
          if (isContainerRunning(existing)) await this.docker.stopContainer(existing.Id);
          await this.docker.removeContainer(existing.Id, { force: false, volumes: false });
        } else {
          await this.docker.removeContainer(existing.Id);
        }
        return { commandId: command.id, ok: true, status: 'unknown' };
      }
      default:
        // sanitizeModuleCommand already rejected unknown actions.
        return { commandId: command.id, ok: false, status: 'unknown', error: `unsupported action "${action}"` };
    }
  }

  async _executeCustomLifecycle(command) {
    const { id, moduleId, action, targetContainerId } = command;
    const nodeId = this._nodeId();
    const matches = (await this.docker.listContainers()).filter(({ Labels }) =>
      Labels?.[MODULE_LABEL] === moduleId && Labels[NODE_LABEL] === nodeId);
    if (!nodeId || matches.length !== 1 || matches[0].Id !== targetContainerId) {
      return { commandId: id, ok: false, status: 'unknown', error: 'Custom container changed or its identifier is no longer unique' };
    }
    const container = await this.docker.inspectContainer(targetContainerId);
    const target = await customLifecycleTarget(this.docker, container, moduleId, nodeId, this.externalSfu);
    if (target !== targetContainerId || !buildModuleReport(container, { moduleId, nodeId })) {
      return { commandId: id, ok: false, status: 'unknown', error: 'Custom container no longer qualifies for lifecycle control' };
    }
    const installed = this.templateContainers.get(moduleId);
    if (installed?.networkId && installed.containerId === targetContainerId && (action === 'start' || action === 'restart') &&
      (!this._matchesInstalledTemplate(container, moduleId, nodeId) ||
        !(await approvedTemplateNetwork(this.docker, installed.networkId, moduleId, nodeId)))) {
      return { commandId: id, ok: false, status: 'unknown', error: 'Approved private module network is unavailable' };
    }
    if (command.expiresAt <= this.now()) return { commandId: id, ok: false, status: 'unknown', error: 'Custom container command expired' };
    // Core sends a separate start only after the restart's drain has finished.
    if (moduleId === 'sfu' && (action === 'stop' || action === 'restart')) return this._requestExternalSfuDrain(command, container);
    if (moduleId === 'sfu' && !stoppedSfu(container.State)) {
      return { commandId: id, ok: false, status: reportStatusFromState(container.State ?? {}, moduleId), error: 'The external SFU container is no longer stopped' };
    }
    const active = isContainerRunning(container) || container.State?.Restarting === true;
    if (action === 'remove') {
      if (!this._matchesInstalledTemplate(container, moduleId, nodeId)) {
        return { commandId: id, ok: false, status: 'unknown', error: 'Only a recorded isolated template container can be removed' };
      }
      if (active) {
        await this.docker.stopContainer(target);
        const stopped = await this.docker.inspectContainer(target);
        if (await customLifecycleTarget(this.docker, stopped, moduleId, nodeId) !== target ||
          !this._matchesInstalledTemplate(stopped, moduleId, nodeId) || command.expiresAt <= this.now()) {
          return { commandId: id, ok: false, status: 'stopped', error: 'Container no longer qualifies for removal' };
        }
      }
      await this.docker.removeContainer(target, { force: false, volumes: false });
      this.templateContainers.delete(moduleId);
      return { commandId: id, ok: true, status: 'unknown' };
    }
    if (action === 'restart') await this.docker.restartContainer(target);
    if (action === 'start' && !active) await this.docker.startContainer(target);
    const requestedStop = action === 'stop' && active;
    if (requestedStop) await this.docker.stopContainer(target);
    return this._resultFor(command, target, { requestedStop });
  }

  _sfuDrainMarker(container) {
    if (process.platform !== 'linux' || !this.stateFile || !dockerTimestampMs(container.State?.StartedAt)) return null;
    const generation = createHash('sha256').update(`${container.Id}:${container.State.StartedAt}`).digest('hex');
    return path.join(`${this.stateFile}.sfu-drain`, generation);
  }

  async _externalSfuDrainState(container) {
    const marker = this._sfuDrainMarker(container);
    if (!marker || !isContainerRunning(container)) return undefined;
    try {
      await lstat(marker);
      return 'requested';
    } catch (error) {
      if (error?.code !== 'ENOENT') return undefined;
    }
    if (container.State.Paused || container.State.Dead || containerLabels(container)[SFU_GRACEFUL_STOP_LABEL] !== 'true' ||
      container.Path !== '/livekit-server' || container.HostConfig.Init === true || container.HostConfig.RestartPolicy?.Name !== 'no') return undefined;
    const image = await this.docker.inspectImage(LIVEKIT_DRAIN_IMAGE).catch(() => null);
    return image?.Id && image.Id === container.Image ? 'available' : undefined;
  }

  async _requestExternalSfuDrain({ id, targetContainerId, expiresAt }, container) {
    const status = reportStatusFromState(container.State, 'sfu');
    const refuse = (error) => ({ commandId: id, ok: false, status, error });
    const stopState = await this._externalSfuDrainState(container);
    if (stopState === 'requested') return refuse('An SFU drain was already requested for this process; check the node locally');
    if (stopState !== 'available') {
      return refuse('Graceful SFU stop requires a running, opted-in LiveKit with the supported image digest, local state and restart policy no');
    }
    if (expiresAt <= this.now()) return refuse('SFU stop command expired');

    const startedAt = container.State.StartedAt;
    const markerPath = this._sfuDrainMarker(container);
    const directory = path.dirname(markerPath);
    try {
      await mkdir(directory, { mode: 0o700, recursive: true });
      const stat = await lstat(directory);
      const uid = process.getuid();
      if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) return refuse('SFU drain journal is not private');
      // Reserve this Docker process generation before sending the signal. An
      // interrupted or ambiguous request must never lead to a second signal.
      const marker = await open(markerPath, 'wx', 0o600);
      try {
        await marker.sync();
      } finally {
        await marker.close();
      }
      for (const entry of [directory, path.dirname(directory)]) {
        const handle = await open(entry, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      return refuse(error?.code === 'EEXIST' ? 'An SFU drain was already requested for this process; check the node locally' :
        'The SFU drain journal could not be saved; no signal was sent');
    }
    const current = await this.docker.inspectContainer(targetContainerId);
    if (current.State?.StartedAt !== startedAt || !isContainerRunning(current) || current.State.Paused ||
      current.State.Restarting || current.HostConfig?.RestartPolicy?.Name !== 'no' || expiresAt <= this.now()) {
      return refuse('The SFU process or shutdown policy changed before the drain signal');
    }
    try {
      await this.docker.signalContainerToDrain(targetContainerId);
    } catch {
      return refuse('SFU drain confirmation was not received; check the node locally before taking action');
    }
    return this._resultFor({ id, moduleId: 'sfu' }, targetContainerId);
  }

  _matchesInstalledTemplate(container, moduleId, nodeId) {
    const record = this.templateContainers.get(moduleId);
    const labels = containerLabels(container);
    return container && record?.nodeId === nodeId && record.containerId === container.Id && record.imageId === container.Image &&
      record.commandId === labels[TEMPLATE_INSTALL_LABEL] && labels[MANAGED_LABEL] === 'true' &&
      isolatedTemplateContainer(container, record.storageVolume, record.networkId);
  }

  async _rememberInstalledTemplate(command, nodeId, containerId, imageId, storageVolume, profileHash, networkId) {
    const previous = this.templateContainers.get(command.moduleId);
    if (!this.stateFile || (!previous && this.templateContainers.size >= MAX_TEMPLATE_CONTAINERS)) return false;
    this.templateContainers.set(command.moduleId, {
      moduleId: command.moduleId, nodeId, containerId, imageId, image: command.image, commandId: command.id,
      profileHash,
      ...(storageVolume ? { storageVolume } : {}),
      ...(networkId ? { networkId } : {}),
    });
    if (await this._persist()) return true;
    if (previous) this.templateContainers.set(command.moduleId, previous);
    else this.templateContainers.delete(command.moduleId);
    return false;
  }

  async _findTemplateInstallApproval(moduleId, image) {
    const templates = this.templatesFile ? await readModuleTemplates(this.templatesFile).catch(() => []) : [];
    return templates.find((template) => template.id === moduleId && template.image === image && template.install === true);
  }

  async _installCustomTemplate(command) {
    const { id, moduleId, image } = command;
    const failed = (error) => ({ commandId: id, ok: false, status: 'unknown', error });
    const nodeId = this._nodeId();
    const approved = nodeId && await this._findTemplateInstallApproval(moduleId, image);
    if (!approved) {
      return failed('Custom template is no longer approved for installation on this node');
    }
    const templateResources = approved.resources ?? TEMPLATE_RESOURCE_DEFAULTS;
    const { storageVolume, commandArgs, restartPolicy = 'no', healthcheck, networkId, ports } = approved;
    if (commandArgs !== undefined && this.docker.nodeLocal !== true) {
      return failed('Approved command arguments require the node-local Docker endpoint');
    }
    if (restartPolicy === 'on-failure' && this.docker.nodeLocal !== true) {
      return failed('Approved restart policy requires the node-local Docker endpoint');
    }
    if (healthcheck && this.docker.nodeLocal !== true) return failed('Approved healthcheck requires the node-local Docker endpoint');
    const templateHealthcheck = healthcheck ? dockerTemplateHealthcheck(healthcheck) : undefined;
    if (!(await approvedTemplateVolume(this.docker, storageVolume, moduleId, nodeId))) {
      return failed('Required local storage is unavailable');
    }
    if (!(await approvedTemplateNetwork(this.docker, networkId, moduleId, nodeId))) return failed('Approved private module network is unavailable');
    const matchesIsolation = (container) => isolatedTemplateContainer(container, storageVolume, networkId);
    const selectedEnvironment = async (entry) => templateEnvironment(entry, entry.envRefs?.length
      ? await this._readTemplateEnvironmentSource() : null);
    const env = await selectedEnvironment(approved);
    if (!env) return failed('Required local environment values are unavailable');
    const profileHash = templateProfileHash(approved, env);
    const stillApproved = async () => {
      const current = await this._findTemplateInstallApproval(moduleId, image);
      if (!current || current.storageVolume !== storageVolume || current.networkId !== networkId ||
        JSON.stringify(current.ports) !== JSON.stringify(ports) || !sameCommandArgs(current.commandArgs, commandArgs) ||
        (current.restartPolicy ?? 'no') !== restartPolicy ||
        JSON.stringify(current.healthcheck) !== JSON.stringify(healthcheck) ||
        !(await approvedTemplateVolume(this.docker, storageVolume, moduleId, nodeId)) ||
        !(await approvedTemplateNetwork(this.docker, networkId, moduleId, nodeId)) ||
        !Object.keys(TEMPLATE_RESOURCE_DEFAULTS).every((key) =>
        (current.resources ?? TEMPLATE_RESOURCE_DEFAULTS)[key] === templateResources[key])) return false;
      const selected = await selectedEnvironment(current);
      return selected && Object.keys(selected).length === Object.keys(env).length &&
        Object.entries(env).every(([key, value]) => selected[key] === value);
    };
    const { inspected, blockedReason } = await this._inspectTemplateImage(image);
    if (!inspected) return failed({
      image_not_cached: 'Approved image digest is missing from the local cache',
      image_incompatible: 'Approved image cannot run in the isolated profile',
      inspection_failed: 'Docker could not verify the approved image',
    }[blockedReason]);
    let previous;
    if (command.targetContainerId) {
      const owned = (await this.docker.listContainers()).filter(({ Labels }) =>
        Labels?.[MODULE_LABEL] === moduleId && Labels[NODE_LABEL] === nodeId);
      if (owned.length !== 1 || owned[0].Id !== command.targetContainerId) return failed('The container to replace changed');
      previous = await this.docker.inspectContainer(command.targetContainerId);
      if (previous?.Id !== command.targetContainerId || !this._matchesInstalledTemplate(previous, moduleId, nodeId) ||
        await customLifecycleTarget(this.docker, previous, moduleId, nodeId) !== previous.Id || !isContainerRunning(previous)) {
        return failed('The container to replace must be running and match the installed template');
      }
      if (previous.Image === inspected.Id && this.templateContainers.get(moduleId)?.profileHash === profileHash) {
        return failed('The approved image and profile are already running on the node');
      }
    } else if (await this._findOwnedContainer(moduleId)) {
      return failed('A container already uses this module identifier');
    }
    if (command.expiresAt <= this.now()) return failed('Custom template install expired before creation');
    const name = previous ? `agil-${moduleId}-${command.id}` : moduleContainerName(nodeId, moduleId);
    const matchesCreate = (container) => container?.Image === inspected.Id && CONTAINER_ID_RE.test(container?.Id ?? '') &&
      containerLabels(container)[TEMPLATE_INSTALL_LABEL] === id &&
      containerLabels(container)[MODULE_LABEL] === moduleId && containerLabels(container)[NODE_LABEL] === nodeId;
    const configMismatch = (container) => {
      if (!matchesTemplateRestartPolicy(container, restartPolicy)) return 'restart policy';
      if (!hasTemplateResourceLimits(container, templateResources)) return 'resource limits';
      if (!hasTemplateEnvironment(container, env)) return 'environment';
      if (commandArgs !== undefined && !sameCommandArgs(container.Config?.Cmd, commandArgs)) return 'command arguments';
      if (templateHealthcheck && !matchesTemplateHealthcheck(container.Config?.Healthcheck, templateHealthcheck)) return 'healthcheck';
      if (ports?.some(({ port, protocol }) => !Object.hasOwn(container.Config?.ExposedPorts ?? {}, `${port}/${protocol}`))) return 'private ports';
      return null;
    };
    const matchesConfig = (container) => configMismatch(container) === null;
    let containerId;
    try {
      const created = await this.docker.createContainer({
        name,
        image: inspected.Id,
        labels: {
          [MODULE_LABEL]: moduleId,
          [NODE_LABEL]: nodeId,
          [MANAGED_LABEL]: 'true',
          [MODULE_LIFECYCLE_LABEL]: 'true',
          [TEMPLATE_INSTALL_LABEL]: id,
        },
        templateResources,
        storageVolume,
        commandArgs,
        templateRestart: restartPolicy,
        templateHealthcheck,
        templateNetworkId: networkId,
        templatePorts: ports,
        env,
      });
      if (!CONTAINER_ID_RE.test(created.Id)) throw new DockerError('Docker did not return a full container id');
      containerId = created.Id;
    } catch {
      const recovered = await this.docker.inspectContainer(name).catch(() => null);
      if (!matchesCreate(recovered)) return failed('Docker could not create the approved module');
      containerId = recovered.Id;
    }
    let startFailed = command.expiresAt <= this.now() || !(await stillApproved());
    const healthDeadline = healthcheck ? performance.now() + healthcheck.startupTimeoutSec * 1000 : undefined;
    if (!startFailed) {
      const configured = await this.docker.inspectContainer(containerId).catch(() => null);
      startFailed = configured?.Id !== containerId || !matchesCreate(configured) || !matchesIsolation(configured) ||
        !matchesConfig(configured);
    }
    if (!startFailed) {
      try {
        await this.docker.startContainer(containerId);
      } catch {
        startFailed = true;
      }
      await delay(TEMPLATE_STARTUP_OBSERVATION_MS);
    }
    try {
      const inspect = () => this.docker.inspectContainer(containerId);
      let observed = await inspect();
      if (healthDeadline !== undefined) {
        while (isContainerRunning(observed) && healthFromState(observed.State) !== 'healthy' &&
          healthFromState(observed.State) !== 'unhealthy' && performance.now() < healthDeadline && this.now() < command.expiresAt) {
          await delay(250);
          observed = await inspect();
        }
      }
      if (observed?.Id !== containerId || !matchesCreate(observed) || !matchesIsolation(observed)) {
        return failed('Docker could not confirm the newly created isolated container');
      }
      const state = observed.State;
      const mismatch = configMismatch(observed);
      const configApplied = mismatch === null;
      const healthy = healthFromState(state);
      const healthAccepted = healthDeadline === undefined ? healthy !== 'unhealthy' :
        healthy === 'healthy' && performance.now() <= healthDeadline && this.now() < command.expiresAt;
      if (previous && isContainerRunning(observed) && healthAccepted && configApplied) {
        return this._finishTemplateReplacement(command, nodeId, previous, observed,
          { matchesCreate, matchesIsolation, matchesConfig, stillApproved, failed, storageVolume, profileHash, networkId, requiresHealth: !!healthcheck });
      }
      const approvedAtStartup = previous !== undefined || await stillApproved();
      const started = !previous && configApplied && approvedAtStartup && (!healthcheck || healthAccepted) &&
        (isContainerRunning(observed) || (!startFailed && state?.Status === 'exited' && state.ExitCode === 0 &&
        !state.OOMKilled && !state.Error));
      if (started && (await this._rememberInstalledTemplate(command, nodeId, containerId, inspected.Id, storageVolume, profileHash, networkId) ||
        (restartPolicy === 'no' && !networkId))) {
        return { commandId: id, ok: true, status: reportStatusFromState(state) };
      }
      if (state?.Running === true || state?.Restarting === true) await this.docker.stopContainer(containerId);
      await this.docker.removeContainer(containerId, { force: false, volumes: false });
      if (mismatch) return failed(`Docker did not apply the approved ${mismatch}. The new container was removed`);
      if (started) return failed('Docker module ownership could not be saved. The new container was removed');
      if (!approvedAtStartup) return failed('The local template changed during startup. The new container was removed');
      if (healthcheck && !healthAccepted) return failed('The approved healthcheck did not pass before the startup deadline. The new container was removed');
      return failed(state?.Status === 'exited' && Number.isSafeInteger(state.ExitCode) && state.ExitCode !== 0
        ? `The approved module exited during startup (code ${state.ExitCode}). The new container was removed`
        : 'Docker could not start the approved module. The new container was removed');
    } catch (error) {
      if (error?.status === 404) return failed('Docker could not find the new module after starting it');
      return failed('Docker could not confirm cleanup of the new module; check the node');
    }
  }

  async _finishTemplateReplacement(command, nodeId, previous, candidate,
    { matchesCreate, matchesIsolation, matchesConfig, stillApproved, failed, storageVolume, profileHash, networkId, requiresHealth }) {
    const { moduleId, targetContainerId } = command;
    const saved = this.templateContainers.get(moduleId);
    const inspectExact = async (id) => {
      try {
        const container = await this.docker.inspectContainer(id);
        if (container?.Id !== id) throw new Error('unexpected container id');
        return container;
      } catch (error) {
        if (error?.status === 404) return null;
        throw error;
      }
    };
    const previousMatches = (container) => this.templateContainers.get(moduleId)?.containerId === saved?.containerId &&
      this._matchesInstalledTemplate(container, moduleId, nodeId);
    let oldStopAttempted = false;
    let oldRemovalAttempted = false;
    try {
      const current = await inspectExact(targetContainerId);
      if (!current || !previousMatches(current) || !isContainerRunning(current) ||
        await customLifecycleTarget(this.docker, current, moduleId, nodeId) !== targetContainerId ||
        !(await stillApproved()) ||
        !matchesIsolation(candidate) || command.expiresAt <= this.now()) throw new Error('target changed');
      oldStopAttempted = true;
      await this.docker.stopContainer(targetContainerId);
      const stopped = await inspectExact(targetContainerId);
      const started = await inspectExact(candidate.Id);
      if (!stopped || !previousMatches(stopped) || isContainerRunning(stopped) ||
        !matchesCreate(started) || !isContainerRunning(started) || !matchesIsolation(started) || !matchesConfig(started) ||
        (requiresHealth ? healthFromState(started.State) !== 'healthy' : healthFromState(started.State) === 'unhealthy') ||
        !(await stillApproved()) ||
        command.expiresAt <= this.now()) throw new Error('replacement changed');
      if (!(await this._rememberInstalledTemplate(command, nodeId, candidate.Id, candidate.Image, storageVolume, profileHash, networkId))) {
        throw new Error('replacement state failed');
      }
      oldRemovalAttempted = true;
      await this.docker.removeContainer(targetContainerId, { force: false, volumes: false });
      return { commandId: command.id, ok: true, status: 'running' };
    } catch {
      try {
        const old = await inspectExact(targetContainerId);
        if (!old && oldRemovalAttempted) {
          const active = await inspectExact(candidate.Id);
          return matchesCreate(active) && isContainerRunning(active) && matchesIsolation(active) && matchesConfig(active)
            ? { commandId: command.id, ok: true, status: 'running' }
            : failed('The previous container was removed. Check the new container on the node');
        }
        if (!old || old.Image !== previous.Image || containerLabels(old)[TEMPLATE_INSTALL_LABEL] !== saved?.commandId ||
          await customLifecycleTarget(this.docker, old, moduleId, nodeId) !== targetContainerId) {
          return failed('Replacement interrupted. Check the original container on the node');
        }
        if (!isContainerRunning(old) && oldStopAttempted) await this.docker.startContainer(targetContainerId);
        const restored = await inspectExact(targetContainerId);
        if (!restored || (oldStopAttempted && !isContainerRunning(restored))) return failed('Replacement interrupted. The previous container could not be restored');
        this.templateContainers.set(moduleId, saved);
        const restoredRecord = await this._persist();
        const staged = await inspectExact(candidate.Id);
        if (staged && matchesCreate(staged) && matchesIsolation(staged)) {
          if (isContainerRunning(staged) || staged.State?.Restarting === true) await this.docker.stopContainer(candidate.Id);
          await this.docker.removeContainer(candidate.Id, { force: false, volumes: false });
        }
        if (staged && (!matchesCreate(staged) || !matchesIsolation(staged))) {
          return failed('Replacement interrupted. The previous container was restored. Check the new container');
        }
        if (!restoredRecord) return failed('Replacement interrupted. Docker was restored but state could not be saved');
        return failed(oldStopAttempted ? 'Replacement failed. The previous container is running' : 'Replacement cancelled before stopping the previous container');
      } catch {
        return failed('Replacement interrupted. Check both containers on the node');
      }
    }
  }

  async _install(command, existing) {
    const env = await this._readModuleEnv(command.moduleId);
    const hasPrivateSettings = Object.keys(env).length > 0;
    const installError = (error, action) => {
      if (!hasPrivateSettings) return error;
      const portBusy = /address already in use|port is already allocated/i.test(error?.message ?? '');
      return new DockerError(`Docker could not ${action} the module${portBusy ? ': address already in use' : ''}`,
        { status: error?.status });
    };
    const stt = command.moduleId === 'stt';
    const localImage = stt && env.STT_IMAGE_SOURCE === 'local';
    // Pull first so a failed pull does not disturb a running container.
    if (existing) {
      if (!localImage) await this.docker.pullImage(command.image);
      // Idempotent install: the owned container already exists, so start it if
      // needed instead of recreating it (recreating would drop its data/state).
      // To change the image/tag, `remove` then `install`.
      if (!isContainerRunning(existing)) {
        await this.docker.startContainer(existing.Id).catch((error) => { throw installError(error, 'start'); });
      }
      return this._resultFor(command, existing.Id);
    }
    const nodeId = this._nodeId();
    if (nodeId === '') throw new DockerError('cannot install a module without a node id');
    let sttOptions;
    if (stt) {
      const { STT_MODEL_DIR, STT_LISTEN_IP = '127.0.0.1', STT_IMAGE_SOURCE, STT_DOCKER_NETWORK, AGIL_STT_TOKEN } = env;
      if (!STT_MODEL_DIR?.startsWith('/') || STT_MODEL_DIR === '/'
        || path.posix.normalize(STT_MODEL_DIR) !== STT_MODEL_DIR || STT_MODEL_DIR.includes('\0')) {
        throw new DockerError('STT_MODEL_DIR must be an absolute Docker-host directory in module-env.json');
      }
      if (!AGIL_STT_TOKEN?.trim()) throw new DockerError('AGIL_STT_TOKEN must be set in module-env.json');
      if (!isIP(STT_LISTEN_IP)) throw new DockerError('STT_LISTEN_IP must be an IP address in module-env.json');
      if (STT_IMAGE_SOURCE && STT_IMAGE_SOURCE !== 'pull' && STT_IMAGE_SOURCE !== 'local') {
        throw new DockerError('STT_IMAGE_SOURCE must be pull or local in module-env.json');
      }
      if (STT_DOCKER_NETWORK && (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(STT_DOCKER_NETWORK)
        || ['host', 'none', 'default'].includes(STT_DOCKER_NETWORK))) {
        throw new DockerError('STT_DOCKER_NETWORK must name a private Docker network in module-env.json');
      }
      sttOptions = { modelDirectory: STT_MODEL_DIR, bindIp: STT_LISTEN_IP, network: STT_DOCKER_NETWORK };
      delete env.STT_MODEL_DIR;
      delete env.STT_LISTEN_IP;
      delete env.STT_IMAGE_SOURCE;
      delete env.STT_DOCKER_NETWORK;
      env.STT_MODEL_PATH = STT_MODEL_TARGET;
    }
    if (!localImage) await this.docker.pullImage(command.image);
    let created;
    try {
      created = await this.docker.createContainer({
        name: moduleContainerName(nodeId, command.moduleId),
        image: command.image,
        labels: {
          [MODULE_LABEL]: command.moduleId,
          [NODE_LABEL]: nodeId,
          [MANAGED_LABEL]: 'true',
        },
        env,
        ports: CATALOG[command.moduleId].ports.map((port) => ({ ...port })),
        ...sttOptions,
      });
    } catch (error) {
      throw installError(error, 'create');
    }
    try {
      await this.docker.startContainer(created.Id);
    } catch (error) {
      // A lost start response may leave a running container. Never force-remove it.
      try {
        const container = await this.docker.inspectContainer(created.Id);
        if (container?.State?.Running === true) return { commandId: command.id, ok: true, status: 'running' };
        await this.docker.removeContainer(created.Id, { force: false });
      } catch (cleanupError) {
        if (cleanupError?.status !== 404) {
          const failure = installError(error, 'start');
          throw new DockerError(`${failure.message}; install cleanup failed${hasPrivateSettings ? '' : `: ${cleanupError.message}`}`);
        }
      }
      throw installError(error, 'start');
    }
    return this._resultFor(command, created.Id);
  }

  _notInstalled(command) {
    return {
      commandId: command.id,
      ok: false,
      status: 'unknown',
      error: `module "${command.moduleId}" is not installed on this node; run install first`,
    };
  }

  async _resultFor(command, containerId, { requestedStop = false } = {}) {
    try {
      const container = await this.docker.inspectContainer(containerId);
      const state = isPlainObject(container?.State) ? container.State : {};
      if (requestedStop && state.Status === 'exited' && !state.OOMKilled && !state.Error && Number.isFinite(Date.parse(state.FinishedAt)) &&
        this._matchesInstalledTemplate(container, command.moduleId, this._nodeId())) {
        this.templateContainers.get(command.moduleId).stoppedAt = state.FinishedAt;
        return { commandId: command.id, ok: true, status: 'stopped' };
      }
      const status = reportStatusFromState(state, command.moduleId);
      return { commandId: command.id, ok: true, status };
    } catch (error) {
      if (error instanceof DockerUnavailableError) {
        return {
          commandId: command.id,
          ok: false,
          status: 'unknown',
          error: !isKnownModule(command.moduleId) || isScopedComposeModule(command.moduleId) ? 'Docker Engine became unavailable' :
            sanitizeErrorText(error.message) || 'Docker Engine became unavailable',
        };
      }
      // The lifecycle call succeeded but the follow-up inspect failed; the
      // command itself is done, so acknowledge success with an honest unknown.
      return { commandId: command.id, ok: true, status: 'unknown' };
    }
  }

  async _findOwnedContainer(moduleId) {
    const nodeId = this._nodeId();
    if (nodeId === '') {
      if (!this.ownershipWarned) {
        this.ownershipWarned = true;
        this.log.warn('module containers cannot be discovered without a node id');
      }
      return null;
    }
    const containers = await this.docker.listContainers();
    const owned = containers.filter((container) => {
      const labels = isPlainObject(container?.Labels) ? container.Labels : {};
      return labels[MODULE_LABEL] === moduleId && labels[NODE_LABEL] === nodeId;
    });
    if (owned.length === 0) return null;
    return owned.sort((left, right) => {
      const composeDelta = Number(isComposeWorkerImage(moduleId, right.Image)) - Number(isComposeWorkerImage(moduleId, left.Image));
      if (composeDelta !== 0) return composeDelta;
      const runningDelta = Number(isContainerRunning(right)) - Number(isContainerRunning(left));
      if (runningDelta !== 0) return runningDelta;
      const createdDelta = sortableCreatedMs(right) - sortableCreatedMs(left);
      if (createdDelta !== 0) return createdDelta;
      return String(right.Id ?? '').localeCompare(String(left.Id ?? ''));
    })[0];
  }

  async _currentStatus(moduleId) {
    try {
      const existing = await this._findOwnedContainer(moduleId);
      if (!existing) return 'unknown';
      const container = await this.docker.inspectContainer(existing.Id);
      return reportStatusFromState(isPlainObject(container?.State) ? container.State : {});
    } catch {
      return 'unknown';
    }
  }

  /** Bounded result queue + idempotency marker + 0600 persistence. */
  async _recordResult(result, { command } = {}) {
    const commandId = typeof result?.commandId === 'string' ? result.commandId : '';
    if (!COMMAND_ID_RE.test(commandId)) return null;
    const normalized = {
      commandId,
      ok: result.ok === true,
      status: MODULE_STATUSES.includes(result.status) ? result.status : 'unknown',
    };
    const error = sanitizeErrorText(result.error);
    if (!normalized.ok && error !== '') normalized.error = error;

    // Bound the idempotency memory: a re-delivered command id never executes
    // twice even after its result was acknowledged.
    this.executed.set(commandId, { at: this.now(), status: normalized.status });
    while (this.executed.size > MAX_EXECUTED_COMMANDS) {
      const oldest = this.executed.keys().next();
      if (oldest.done) break;
      this.executed.delete(oldest.value);
    }

    if (!this.pending.has(commandId)) {
      this.pending.set(commandId, normalized);
      if (this.pending.size > MAX_PENDING_RESULTS) {
        const dropped = this.pending.keys().next();
        if (!dropped.done) {
          this.pending.delete(dropped.value);
          this.log.warn('module result queue full; dropped the oldest acknowledgement', {
            max: MAX_PENDING_RESULTS,
          });
        }
      }
    }

    if (command) {
      this.log.info('module command executed', {
        commandId,
        moduleId: command.moduleId,
        action: command.action,
        ok: normalized.ok,
        status: normalized.status,
        ...(normalized.error ? { error: normalized.error } : {}),
      });
    } else if (normalized.ok === false) {
      this.log.warn('module command rejected', {
        commandId,
        error: normalized.error ?? null,
      });
    }
    await this._persist();
    return normalized;
  }

  /**
   * Node-local module environment file (never leaves the node):
   * `{ "<moduleId>": { "KEY": "value" } }`. Read on install only; values are
   * handed to Docker and never logged, reported or echoed in a result.
   */
  async _readModuleEnv(moduleId) {
    if (!this.envFile) return {};
    let parsed;
    try {
      parsed = await readNodeLocalJson(this.envFile, MAX_TEMPLATE_ENV_FILE_BYTES, { privateOnly: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      // Parser and filesystem messages may include private configuration.
      throw new Error('module-env.json must be a valid node-local JSON file with private permissions');
    }
    if (!isPlainObject(parsed) || (Object.hasOwn(parsed, moduleId) && !isPlainObject(parsed[moduleId]))) {
      throw new Error('module-env.json must contain an object of node-local module settings');
    }
    if (!Object.hasOwn(parsed, moduleId)) return {};
    const env = {};
    for (const [key, value] of Object.entries(parsed[moduleId])) {
      if (!ENV_KEY_RE.test(key)) {
        this.log.warn('ignoring an invalid env variable name in the module env file', { moduleId });
        continue;
      }
      if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > MAX_TEMPLATE_ENV_VALUE_BYTES) {
        this.log.warn('ignoring an invalid env value in the module env file', { moduleId });
        continue;
      }
      env[key] = value;
    }
    if (Object.keys(env).length > 0 && this.docker.nodeLocal !== true) {
      throw new Error('Private module settings require the node-local Docker endpoint');
    }
    return env;
  }

  /* -------------------------------------------------------- persistence -- */

  async _loadState() {
    if (!this.stateFile) return;
    let raw;
    try {
      const options = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
      const handle = await open(this.stateFile, options);
      try {
        const stat = await handle.stat();
        const uid = process.getuid?.();
        if (!stat.isFile() || (uid !== undefined && ((stat.uid !== uid && stat.uid !== 0) || (stat.mode & 0o022) !== 0))) return;
        raw = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.log.warn('module command state file is unreadable; starting empty', { file: this.stateFile });
      }
      return;
    }
    if (raw.trim() === '') return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log.warn('module command state file is not valid JSON; starting empty', { file: this.stateFile });
      return;
    }
    if (!isPlainObject(parsed)) return;
    if (Array.isArray(parsed.templateContainers)) {
      for (const record of parsed.templateContainers.slice(0, MAX_TEMPLATE_CONTAINERS)) {
        if (isPlainObject(record) && isInventoryId(record.moduleId) && !isKnownModule(record.moduleId) &&
          typeof record.nodeId === 'string' && record.nodeId.length > 0 && record.nodeId.length <= 160 &&
          typeof record.containerId === 'string' && CONTAINER_ID_RE.test(record.containerId) &&
          typeof record.commandId === 'string' && COMMAND_ID_RE.test(record.commandId) &&
          typeof record.imageId === 'string' && /^sha256:[0-9a-f]{64}$/.test(record.imageId)) {
          const { moduleId, nodeId, containerId, commandId, imageId, image, stoppedAt, storageVolume, profileHash, networkId } = record;
          this.templateContainers.set(moduleId, { moduleId, nodeId, containerId, commandId, imageId,
            ...(isPinnedTemplateImage(image) ? { image } : {}),
            ...(validTemplateVolumeName(storageVolume) ? { storageVolume } : {}),
            ...(typeof networkId === 'string' && CONTAINER_ID_RE.test(networkId) ? { networkId } : {}),
            ...(typeof profileHash === 'string' && /^[a-f0-9]{64}$/.test(profileHash) ? { profileHash } : {}),
            ...(typeof stoppedAt === 'string' && stoppedAt.length <= 64 && Number.isFinite(Date.parse(stoppedAt)) ? { stoppedAt } : {}),
          });
        }
      }
    }
    if (Array.isArray(parsed.results)) {
      for (const item of parsed.results.slice(0, MAX_PENDING_RESULTS)) {
        if (!isPlainObject(item) || !COMMAND_ID_RE.test(String(item.commandId ?? ''))) continue;
        const result = {
          commandId: item.commandId,
          ok: item.ok === true,
          status: MODULE_STATUSES.includes(item.status) ? item.status : 'unknown',
        };
        const error = sanitizeErrorText(item.error);
        if (!result.ok && error !== '') result.error = error;
        this.pending.set(result.commandId, result);
      }
    }
    if (Array.isArray(parsed.executed)) {
      for (const id of parsed.executed) {
        if (typeof id === 'string' && COMMAND_ID_RE.test(id)) this.executed.set(id, { at: this.now() });
      }
      while (this.executed.size > MAX_EXECUTED_COMMANDS) {
        const oldest = this.executed.keys().next();
        if (oldest.done) break;
        this.executed.delete(oldest.value);
      }
    }
    this.log.debug('module command state loaded', {
      file: this.stateFile,
      pendingResults: this.pending.size,
      executed: this.executed.size,
    });
  }

  _persist() {
    if (!this.stateFile) return Promise.resolve();
    this.persistChain = this.persistChain.then(async () => {
      try {
        await mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
        const tmp = `${this.stateFile}.${process.pid}.tmp`;
        const payload = {
          version: 1,
          results: [...this.pending.values()],
          executed: [...this.executed.keys()],
          templateContainers: [...this.templateContainers.values()],
        };
        await writeFile(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
        await rename(tmp, this.stateFile);
        return true;
      } catch (error) {
        this.log.warn('could not persist module command state', {
          file: this.stateFile,
          error: typeof error?.code === 'string' ? error.code : 'write failed',
        });
        return false;
      }
    });
    return this.persistChain;
  }

  /** Stop accepting commands and flush the persistence chain. */
  async close() {
    this.closed = true;
    this.queue.length = 0;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
    await this.persistChain.catch(() => {});
  }
}

/** Prefer the running container when two containers claim the same module id. */
function preferReport(candidate, previous) {
  const candidateRunning = candidate.status === 'running';
  const previousRunning = previous.status === 'running';
  if (candidateRunning !== previousRunning) return candidateRunning;
  const candidateAt = Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : 0;
  const previousAt = Number.isFinite(previous.updatedAt) ? previous.updatedAt : 0;
  return candidateAt >= previousAt;
}

function sortableCreatedMs(container) {
  const parsed = dockerTimestampMs(container?.Created);
  return parsed ?? 0;
}

/** Convenience constructor (matches the repo's `createX` style). */
export function createModuleManager(options = {}) {
  return new ModuleManager(options);
}

/** Test-only surface kept small and read-only. */
export const modulesInternals = Object.freeze({
  catalog: CATALOG,
  moduleImageTag,
  reportStatusFromState,
  healthFromState,
  publishedPorts,
});
