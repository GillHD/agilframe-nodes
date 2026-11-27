#!/usr/bin/env node
/**
 * AGIL reference node agent (kit-owned, not part of `@agil/calls-server`).
 *
 * Why this exists: AGIL Core exposes a node registry and one-time enrollment
 * tokens, but no first-party node daemon ships in the 0.1.0 baseline. This
 * dependency-free agent is the glue the quickstart and the
 * `agil-node` Helm chart use to:
 *
 *   1. register this host once with a one-time enrollment token
 *      (`POST /v1/nodes/register`) and persist the returned node key;
 *   2. heartbeat the node record (`POST /v1/nodes/:id/heartbeat`,
 *      `x-node-token: nk_…`) on a fixed interval;
 *   3. expose local liveness/readiness/metrics endpoints for Docker/Kubernetes
 *      probes (`/healthz`, `/readyz`, `/metrics`);
 *   4. optionally manage the Core's allowlisted Docker add-on modules: report
 *      the containers labelled `agil.module`/`agil.node` under `modules` and
 *      execute `moduleCommands` (`install/start/stop/restart/remove`) through
 *      the Docker Engine socket, acknowledging them as `moduleResults`
 *      (`modules.mjs`). Without a Docker socket the agent is agent-only.
 *
 * It is deliberately not a media server: LiveKit/TURN/STUN processes stay
 * separate (as sibling containers for Docker modules), never in this process.
 *
 * Security: the enrollment token is read from the environment, used once and
 * never logged. The node key is written to `AGIL_NODE_STATE_DIR` with mode 0600.
 * No telemetry, no outbound traffic except to `AGIL_CORE_URL`.
 */

import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { createMetricsCollector, normalizeNodeMetrics } from './metrics.mjs';
import { createModuleManager } from './modules.mjs';

const AGENT_VERSION = '0.1.0';
const STARTED_AT = Date.now();
const VALID_ROLES = new Set(['sfu', 'turn', 'stun', 'all']);

/* ------------------------------------------------------------------ config */

function envStr(name, fallback = '') {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function envInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = envStr(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return parsed;
}

function envBool(name, fallback = false) {
  const raw = envStr(name).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be a boolean, got "${raw}"`);
}

function csvList(raw) {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCapacity(raw) {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AGIL_NODE_CAPACITY must be valid JSON (e.g. {"maxRooms":10,"maxParticipants":500})');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AGIL_NODE_CAPACITY must be a JSON object');
  }
  const capacity = {};
  for (const key of ['maxRooms', 'maxParticipants']) {
    if (parsed[key] === undefined || parsed[key] === null) continue;
    const value = Number(parsed[key]);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`AGIL_NODE_CAPACITY.${key} must be a positive integer`);
    }
    capacity[key] = value;
  }
  return capacity;
}

function readConfig() {
  const coreUrl = envStr('AGIL_CORE_URL', 'http://127.0.0.1:8787').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(coreUrl)) {
    throw new Error('AGIL_CORE_URL must start with http:// or https://');
  }
  const role = envStr('AGIL_NODE_ROLE', 'sfu').toLowerCase();
  if (!VALID_ROLES.has(role)) {
    throw new Error(`AGIL_NODE_ROLE must be one of ${[...VALID_ROLES].join('|')}, got "${role}"`);
  }
  const defaultFeatures = role === 'all' ? ['sfu', 'turn', 'stun'] : [role];
  const features = csvList(envStr('AGIL_NODE_FEATURES'));
  const stateDir = envStr('AGIL_NODE_STATE_DIR', '/var/lib/agil-node');
  const moduleMode = envStr('AGIL_NODE_MODULES', 'auto').toLowerCase();
  if (!['auto', 'on', 'off'].includes(moduleMode)) {
    throw new Error(`AGIL_NODE_MODULES must be auto|on|off, got "${moduleMode}"`);
  }
  const dockerHost = envStr('AGIL_NODE_DOCKER_HOST', envStr('DOCKER_HOST', 'unix:///var/run/docker.sock'));
  if (!/^(unix|npipe|tcp|http):\/\//.test(dockerHost) && !dockerHost.startsWith('/')) {
    throw new Error('AGIL_NODE_DOCKER_HOST must be unix://, npipe://, tcp:// or an absolute socket path');
  }
  return {
    coreUrl,
    token: envStr('AGIL_NODE_TOKEN'),
    nodeKey: envStr('AGIL_NODE_KEY'),
    stateDir,
    nodeId: envStr('AGIL_NODE_ID', hostname()),
    nodeName: envStr('AGIL_NODE_NAME', hostname()),
    role,
    features: features.length > 0 ? features : defaultFeatures,
    capacity: parseCapacity(envStr('AGIL_NODE_CAPACITY')),
    endpoint: envStr('AGIL_NODE_ENDPOINT'),
    region: envStr('AGIL_NODE_REGION'),
    healthPath: envStr('AGIL_NODE_HEALTH_PATH', '/health'),
    heartbeatSec: envInt('AGIL_NODE_HEARTBEAT_SEC', 30, { min: 5, max: 3600 }),
    httpPort: envInt('AGIL_NODE_HTTP_PORT', 8080, { min: 1, max: 65535 }),
    httpHost: envStr('AGIL_NODE_HTTP_HOST', '0.0.0.0'),
    once: envBool('AGIL_NODE_ONCE', false),
    logLevel: envStr('AGIL_NODE_LOG_LEVEL', 'info').toLowerCase(),
    // Docker add-on modules (`modules.mjs`). `auto` probes the socket and falls
    // back to an agent-only node; `on` logs a loud warning if it is missing;
    // `off` disables discovery/commands entirely.
    modules: {
      mode: moduleMode,
      dockerHost,
      requestTimeoutMs: envInt('AGIL_NODE_DOCKER_TIMEOUT_MS', 15_000, { min: 1_000, max: 600_000 }),
      pullTimeoutMs: envInt('AGIL_NODE_MODULE_PULL_TIMEOUT_MS', 600_000, { min: 1_000, max: 3_600_000 }),
      // Node-local env file for installed modules: `{"<module>":{"KEY":"value"}}`.
      // Values never leave the node, are never logged and never reach the Core.
      envFile: envStr('AGIL_NODE_MODULE_ENV_FILE', path.join(stateDir, 'module-env.json')),
      templatesFile: envStr('AGIL_NODE_MODULE_TEMPLATES_FILE', path.join(stateDir, 'module-templates.json')),
      // Pending command results + executed ids survive an agent restart.
      stateFile: path.join(stateDir, 'module-commands.json'),
    },
  };
}

const config = readConfig();
const STATE_FILE = path.join(config.stateDir, 'node.json');
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Node-local stats attached to every heartbeat (`metrics.mjs`). State is the
// previous /proc sample; prime it at startup so the first heartbeat can report
// a CPU/bandwidth delta. Collection never throws and never reads a secret.
const metricsCollector = createMetricsCollector({
  version: AGENT_VERSION,
  processStartedAt: STARTED_AT,
});

/* ----------------------------------------------------------------- logging */

function log(level, message, extra = {}) {
  if ((LOG_LEVELS[level] ?? 20) < (LOG_LEVELS[config.logLevel] ?? 20)) return;
  const line = { ts: new Date().toISOString(), level, msg: message, ...extra };
  (level === 'error' || level === 'warn' ? console.error : console.log)(JSON.stringify(line));
}

class FatalError extends Error {}

/* ------------------------------------------------------------ state + HTTP */

let state = {
  nodeId: config.nodeId,
  nodeKey: '',
  registeredAt: '',
  coreUrl: config.coreUrl,
};

// Docker add-on modules (`modules.mjs`): the inventory is discovered from
// containers labelled `agil.module`/`agil.node`, and `moduleCommands` from a
// heartbeat are executed through the Docker Engine socket. A missing socket is
// not fatal: the heartbeat omits `modules` and the node stays an agent-only node.
// The node id is read lazily because enrollment may assign the final id.
const moduleManager = createModuleManager({
  nodeId: () => state.nodeId,
  mode: config.modules.mode,
  dockerHost: config.modules.dockerHost,
  requestTimeoutMs: config.modules.requestTimeoutMs,
  pullTimeoutMs: config.modules.pullTimeoutMs,
  stateFile: config.modules.stateFile,
  envFile: config.modules.envFile,
  templatesFile: config.modules.templatesFile,
  log: {
    debug: (message, extra) => log('debug', message, { component: 'modules', ...extra }),
    info: (message, extra) => log('info', message, { component: 'modules', ...extra }),
    warn: (message, extra) => log('warn', message, { component: 'modules', ...extra }),
    error: (message, extra) => log('error', message, { component: 'modules', ...extra }),
  },
});

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.nodeId === 'string' && parsed.nodeId) state.nodeId = parsed.nodeId;
    if (typeof parsed.nodeKey === 'string' && parsed.nodeKey) state.nodeKey = parsed.nodeKey;
    if (typeof parsed.registeredAt === 'string') state.registeredAt = parsed.registeredAt;
    log('info', 'node key loaded from state', { nodeId: state.nodeId, file: STATE_FILE });
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    log('warn', 'state file is unreadable, enrollment is required', { file: STATE_FILE, error: String(error) });
  }
}

async function saveState() {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, STATE_FILE);
}

async function request(method, pathname, body, headers = {}) {
  const response = await fetch(`${config.coreUrl}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'user-agent': `agil-node-agent/${AGENT_VERSION}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page: keep text for the log */
  }
  return { status: response.status, json, text, retryAfter: response.headers.get('retry-after') };
}

function apiError(result) {
  const body = result.json;
  if (body && typeof body === 'object') {
    // Core error envelope: `{error:{code,message}}`. Older/flat shapes keep
    // working; never stringify an object directly (that printed
    // "[object Object]" for a rejected enrollment).
    const nested = body.error;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const code = typeof nested.code === 'string' ? nested.code : '';
      const nestedMessage = typeof nested.message === 'string' ? nested.message : '';
      if (code || nestedMessage) return `${code}${code && nestedMessage ? ': ' : ''}${nestedMessage}`;
    }
    const detail = typeof body.error === 'string' ? body.error : typeof body.code === 'string' ? body.code : '';
    const message = typeof body.message === 'string'
      ? body.message
      : typeof body.error_description === 'string' ? body.error_description : '';
    if (detail || message) return `${detail}${detail && message ? ': ' : ''}${message}`;
  }
  return (result.text || '').slice(0, 300) || `HTTP ${result.status}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------------------------------------------------------------- lifecycle */

const runtime = {
  registered: Boolean(state.nodeKey),
  lastHeartbeatAt: 0,
  lastErrorAt: 0,
  lastError: '',
  heartbeats: 0,
  failures: 0,
  shuttingDown: false,
  registerSeconds: 0,
  heartbeatIntervalSec: config.heartbeatSec,
  retryNotBefore: 0,
};

function applyHeartbeatInterval(value) {
  if (Number.isInteger(value) && value >= 5 && value <= 3600) runtime.heartbeatIntervalSec = value;
}

async function register({ attempts = 30 } = {}) {
  if (!config.token) {
    throw new FatalError(
      'No node key in state and AGIL_NODE_TOKEN is empty. Mint a one-time token '
        + '(POST /v1/admin/cluster/tokens {"kind":"node",...}) or restore the state volume.',
    );
  }
  const payload = {
    token: config.token,
    nodeId: config.nodeId,
    role: config.role,
    name: config.nodeName,
    features: config.features,
    capacity: config.capacity,
    endpoint: config.endpoint,
    region: config.region,
    version: AGENT_VERSION,
    healthPath: config.healthPath,
  };
  const registerStart = Date.now();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await request('POST', '/v1/nodes/register', payload);
      if (result.status === 201 && result.json && typeof result.json.nodeKey === 'string') {
        state.nodeId = result.json.node?.id ?? config.nodeId;
        state.nodeKey = result.json.nodeKey;
        state.registeredAt = new Date().toISOString();
        state.coreUrl = config.coreUrl;
        await saveState();
        runtime.registered = true;
        applyHeartbeatInterval(result.json.heartbeatIntervalSec);
        runtime.registerSeconds = Math.round((Date.now() - registerStart) / 1000);
        log('info', 'node registered', {
          nodeId: state.nodeId,
          role: config.role,
          features: config.features,
          cluster: result.json.cluster?.id ?? null,
          heartbeatIntervalSec: runtime.heartbeatIntervalSec,
          stateFile: STATE_FILE,
        });
        return;
      }
      if (result.status === 409) {
        throw new FatalError(
          `node id "${config.nodeId}" is already registered and live; use a unique AGIL_NODE_ID `
            + 'or disable/delete the old node record first',
        );
      }
      if (result.status >= 400 && result.status < 500) {
        throw new FatalError(`enrollment rejected (HTTP ${result.status}): ${apiError(result)}`);
      }
      log('warn', 'enrollment attempt failed, retrying', { attempt, status: result.status, error: apiError(result) });
    } catch (error) {
      if (error instanceof FatalError) throw error;
      log('warn', 'enrollment attempt failed, retrying', { attempt, error: String(error) });
    }
    if (attempt < attempts) await sleep(Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5)));
  }
  throw new FatalError(`could not enroll node after ${attempts} attempts; is ${config.coreUrl} reachable?`);
}

async function heartbeat({ executeCommands = true } = {}) {
  if (!state.nodeKey) return false;
  try {
    // Best-effort host metrics. A collector failure (not expected: it catches
    // per-file errors) must never prevent the liveness beat from being sent.
    let metrics;
    try {
      metrics = normalizeNodeMetrics(await metricsCollector.collect());
    } catch {
      metrics = undefined;
    }
    // Capture acknowledgements before inspecting Docker so a result and its
    // accompanying inventory cannot describe opposite sides of the action.
    // A failed beat keeps the results for retry.
    const moduleResults = moduleManager.pendingResults();
    // Full module inventory. `undefined` means Docker is unavailable, so the
    // field is omitted and Core keeps the previous snapshot (inventing `[]`
    // would claim "no modules installed"); `[]` is sent only when Docker
    // answered and this node truly has no managed module containers.
    const modules = await moduleManager.inventory();
    const body = {
      capacity: config.capacity,
      features: config.features,
      status: 'online',
      moduleAvailability: moduleManager.inventoryAvailability(modules),
    };
    // Omit the object entirely when nothing is measurable; Core strips unknown
    // keys, so an older Core still accepts this heartbeat unchanged.
    if (metrics) body.metrics = metrics;
    if (modules !== undefined) {
      body.modules = modules;
      body.moduleTemplates = await moduleManager.templateCatalog();
    }
    if (moduleResults.length > 0) body.moduleResults = moduleResults;
    const result = await request(
      'POST',
      `/v1/nodes/${encodeURIComponent(state.nodeId)}/heartbeat`,
      body,
      { 'x-node-token': state.nodeKey },
    );
    if (result.status === 200) {
      runtime.heartbeats += 1;
      runtime.lastHeartbeatAt = Date.now();
      runtime.registered = true;
      applyHeartbeatInterval(result.json?.heartbeatIntervalSec);
      runtime.retryNotBefore = 0;
      await moduleManager.ackResults(moduleResults.map((entry) => entry.commandId));
      const commands = Array.isArray(result.json?.moduleCommands) ? result.json.moduleCommands : [];
      if (commands.length > 0) {
        if (executeCommands) {
          // Execute in the background: a slow image pull must not delay the
          // next heartbeat; results are queued for the following beat.
          moduleManager.handleCommands(commands).catch((error) => {
            log('warn', 'module command execution failed', { error: String(error) });
          });
        } else {
          log('warn', 'AGIL_NODE_ONCE: module commands are not executed in one-shot mode', {
            commands: commands.length,
            note: 'run the agent as a long-lived process to manage node modules',
          });
        }
      }
      if (runtime.heartbeats === 1) {
        log('info', 'heartbeat accepted', {
          nodeId: state.nodeId,
          drain: Boolean(result.json?.drain),
          heartbeatIntervalSec: runtime.heartbeatIntervalSec,
          modules: modules === undefined ? null : modules.length,
        });
      }
      return true;
    }
    runtime.failures += 1;
    runtime.lastErrorAt = Date.now();
    const retryAfterSec = Number(result.retryAfter);
    if (result.status === 429 && Number.isInteger(retryAfterSec) && retryAfterSec > 0 && retryAfterSec <= 3600) {
      runtime.retryNotBefore = runtime.lastErrorAt + retryAfterSec * 1000;
    }
    runtime.lastError = `HTTP ${result.status}: ${apiError(result)}`;
    log('error', 'heartbeat rejected', {
      nodeId: state.nodeId,
      status: result.status,
      error: apiError(result),
      // 401/403 means the node key was revoked or the node was disabled.
      action: result.status === 401 || result.status === 403 ? 'check node key / node status in core' : undefined,
    });
    return false;
  } catch (error) {
    runtime.failures += 1;
    runtime.lastErrorAt = Date.now();
    runtime.lastError = String(error);
    log('warn', 'heartbeat failed', { nodeId: state.nodeId, error: String(error) });
    return false;
  }
}

function isReady() {
  if (!runtime.registered || !runtime.lastHeartbeatAt) return false;
  const maxAgeMs = Math.max(runtime.heartbeatIntervalSec * 3, 90) * 1000;
  const last = Math.max(runtime.lastHeartbeatAt, runtime.lastErrorAt);
  return Date.now() - last <= maxAgeMs && runtime.lastHeartbeatAt >= runtime.lastErrorAt;
}

/* -------------------------------------------------------------- health API */

function json(res, status, body) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function metrics() {
  const age = runtime.lastHeartbeatAt ? Math.max(0, (Date.now() - runtime.lastHeartbeatAt) / 1000) : -1;
  const moduleStatus = moduleManager.status();
  return [
    '# HELP agil_node_up Process liveness (always 1 while the agent runs).',
    '# TYPE agil_node_up gauge',
    'agil_node_up 1',
    '# HELP agil_node_ready Whether the last heartbeat is within 3 intervals.',
    '# TYPE agil_node_ready gauge',
    `agil_node_ready ${isReady() ? 1 : 0}`,
    '# HELP agil_node_registered Whether an enrollment key is present.',
    '# TYPE agil_node_registered gauge',
    `agil_node_registered ${runtime.registered ? 1 : 0}`,
    '# HELP agil_node_heartbeats_total Accepted heartbeats.',
    '# TYPE agil_node_heartbeats_total counter',
    `agil_node_heartbeats_total ${runtime.heartbeats}`,
    '# HELP agil_node_heartbeat_failures_total Failed heartbeats.',
    '# TYPE agil_node_heartbeat_failures_total counter',
    `agil_node_heartbeat_failures_total ${runtime.failures}`,
    '# HELP agil_node_last_heartbeat_timestamp_seconds Unix time of the last accepted heartbeat (0 = never).',
    '# TYPE agil_node_last_heartbeat_timestamp_seconds gauge',
    `agil_node_last_heartbeat_timestamp_seconds ${runtime.lastHeartbeatAt ? Math.floor(runtime.lastHeartbeatAt / 1000) : 0}`,
    '# HELP agil_node_last_heartbeat_age_seconds Seconds since the last accepted heartbeat (-1 = never).',
    '# TYPE agil_node_last_heartbeat_age_seconds gauge',
    `agil_node_last_heartbeat_age_seconds ${age.toFixed(1)}`,
    '# HELP agil_node_docker_available Whether the Docker Engine socket is reachable (0 = agent-only node).',
    '# TYPE agil_node_docker_available gauge',
    `agil_node_docker_available ${moduleStatus.available ? 1 : 0}`,
    '# HELP agil_node_modules_managed Docker module containers discovered for this node.',
    '# TYPE agil_node_modules_managed gauge',
    `agil_node_modules_managed ${moduleStatus.managed}`,
    '# HELP agil_node_module_results_pending Command results waiting for the next heartbeat.',
    '# TYPE agil_node_module_results_pending gauge',
    `agil_node_module_results_pending ${moduleStatus.pendingResults}`,
    '# HELP agil_node_info Static labels for joins.',
    '# TYPE agil_node_info gauge',
    `agil_node_info{node_id="${escapeLabel(state.nodeId)}",role="${escapeLabel(config.role)}",core="${escapeLabel(config.coreUrl)}",version="${AGENT_VERSION}"} 1`,
    '',
  ].join('\n');
}

function startHealthServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    switch (url.pathname) {
      case '/healthz':
      case '/health':
        json(res, 200, {
          ok: true,
          role: 'node-agent',
          nodeId: state.nodeId,
          version: AGENT_VERSION,
          uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
          shuttingDown: runtime.shuttingDown,
        });
        return;
      case '/readyz': {
        const ready = isReady() && !runtime.shuttingDown;
        json(res, ready ? 200 : 503, {
          ok: ready,
          reason: ready ? 'heartbeat_fresh' : runtime.registered ? 'heartbeat_stale' : 'not_registered',
          nodeId: state.nodeId,
          lastHeartbeatAt: runtime.lastHeartbeatAt ? new Date(runtime.lastHeartbeatAt).toISOString() : null,
          lastError: runtime.lastError || null,
        });
        return;
      }
      case '/metrics':
        res.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(metrics());
        return;
      case '/':
        json(res, 200, {
          ok: true,
          name: 'agil-node-agent',
          version: AGENT_VERSION,
          nodeId: state.nodeId,
          role: config.role,
          features: config.features,
          core: config.coreUrl,
          heartbeatIntervalSec: runtime.heartbeatIntervalSec,
          // Docker module capability without secrets: enabled/available and how
          // many containers this node reports. `managed` is the count from the
          // last inventory, not a guess.
          modules: moduleManager.status(),
          endpoints: ['/healthz', '/readyz', '/metrics'],
        });
        return;
      default:
        json(res, 404, { ok: false, error: 'not_found' });
    }
  });
  server.listen(config.httpPort, config.httpHost, () => {
    log('info', 'health server listening', { host: config.httpHost, port: config.httpPort });
  });
  return server;
}

/* ------------------------------------------------------------------- main */

let heartbeatTimer = null;

function scheduleHeartbeat() {
  if (runtime.shuttingDown) return;
  const jitter = 1 + Math.random() * 0.1; // Spread the fleet without going below Core's interval.
  const delayMs = Math.max(runtime.heartbeatIntervalSec * 1000 * jitter, runtime.retryNotBefore - Date.now());
  heartbeatTimer = setTimeout(async () => {
    await heartbeat();
    scheduleHeartbeat();
  }, Math.ceil(delayMs));
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

async function main() {
  log('info', 'agil node agent starting', {
    version: AGENT_VERSION,
    nodeId: config.nodeId,
    role: config.role,
    features: config.features,
    coreUrl: config.coreUrl,
    heartbeatSec: config.heartbeatSec,
    once: config.once,
    modules: config.modules.mode,
  });

  await loadState();
  // Prime the /proc CPU/NIC baseline before enrollment so the first heartbeat
  // after a (possibly slow) registration already has a real delta.
  await metricsCollector.collect();
  if (!state.nodeKey && config.nodeKey) {
    // Pre-registered node: the key comes from a secret instead of a one-time
    // token. This is how Kubernetes deployments normally run the agent.
    state.nodeKey = config.nodeKey;
    state.registeredAt = new Date().toISOString();
    await saveState();
    log('info', 'node key imported from AGIL_NODE_KEY', { nodeId: state.nodeId, stateFile: STATE_FILE });
  }
  if (!state.nodeKey) await register({ attempts: config.once ? 1 : 30 });
  else runtime.registered = true;

  // Probe Docker once at startup so a missing socket is logged once and the
  // agent continues as an agent-only node (never fatal). Persisted command
  // results are loaded here as well.
  await moduleManager.init();

  if (config.once) {
    // One-shot mode cannot acknowledge commands on a later heartbeat, so it
    // reports the inventory but deliberately does not execute commands.
    const ok = await heartbeat({ executeCommands: false });
    log(ok ? 'info' : 'error', 'single heartbeat finished', { nodeId: state.nodeId, ok });
    // Do NOT call process.exit() from inside the async request callback: on
    // Windows/Node 23 undici keep-alive handles are still closing and libuv
    // aborts with UV_HANDLE_CLOSING (exit 0xC0000409). Setting exitCode and
    // returning lets the process drain its handles and exit with the right code.
    await moduleManager.close();
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const server = startHealthServer();
  await heartbeat();
  scheduleHeartbeat();

  const shutdown = (signal) => {
    if (runtime.shuttingDown) return;
    runtime.shuttingDown = true;
    log('info', 'shutting down', { signal });
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    // Flush pending module results to the state file before exiting; an
    // in-flight command is not interrupted by waiting for it here.
    moduleManager.close().catch(() => {}).finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  if (error instanceof FatalError) log('error', error.message);
  else log('error', 'node agent crashed', { error: error?.stack ?? String(error) });
  // Same Windows/libuv reason as the one-shot success path: drain, don't abort
  // handles from inside an async callback.
  process.exitCode = 1;
});
