/**
 * AGIL Core enrollment client + node-key state for the all-in-one node.
 *
 * Implements the first-party node contract in `agil/core/apps/server/src/cluster-api.ts`:
 *
 *   POST /v1/nodes/register                    one-time enrollment token
 *   POST /v1/nodes/:id/heartbeat               `x-node-token: nk_…`
 *   POST /v1/admin/nodes/:id/rotate-key        admin key (optional rotation)
 *
 * The node key is the only persisted secret. It is written atomically to
 * `$NODE_STATE_DIR/node.json` with mode 0600 (a volume/PVC), never to the logs,
 * and never passed to the media child processes (see media.mjs).
 */

import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { capacityIsReported, redactUrl } from './config.mjs';
import { normalizeNodeMetrics } from './metrics.mjs';

const REQUEST_TIMEOUT_MS = 15_000;

/** A non-retryable enrollment/rotation error (bad token, duplicate id, ...). */
export class FatalCoreError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'FatalCoreError';
    this.code = code;
    this.status = status;
  }
}

/** Renders the core error envelope `{error:{code,message}}` without stringifying it. */
export function apiErrorMessage(result) {
  const body = result.json;
  if (body && typeof body === 'object') {
    const nested = body.error;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const code = typeof nested.code === 'string' ? nested.code : '';
      const message = typeof nested.message === 'string' ? nested.message : '';
      if (code || message) return `${code}${code && message ? ': ' : ''}${message}`;
    }
    const detail = typeof body.error === 'string' ? body.error : typeof body.code === 'string' ? body.code : '';
    const message = typeof body.message === 'string'
      ? body.message
      : typeof body.error_description === 'string' ? body.error_description : '';
    if (detail || message) return `${detail}${detail && message ? ': ' : ''}${message}`;
  }
  return (result.text || '').slice(0, 300) || `HTTP ${result.status}`;
}

async function requestCore(config, method, pathname, { body, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const response = await fetch(`${config.core.url}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'user-agent': `agil-node/${config.version}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON edge/proxy error page: keep text for the message */
  }
  return { status: response.status, json, text };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------- state */

export class NodeStateStore {
  constructor({ stateDir }) {
    this.stateDir = stateDir;
    this.file = path.join(stateDir, 'node.json');
  }

  /**
   * Re-assert 0600 on an existing state file. A volume restored from a backup
   * can come back group/world-readable; the key is a bearer credential, so the
   * agent tightens the mode before using it instead of waiting for the next
   * successful save. POSIX-only: Windows has no meaningful owner/mode bits.
   *
   * @returns {Promise<{repaired?:boolean, mode?:number, error?:string}>}
   */
  async assertPrivateMode() {
    if (process.platform === 'win32') return {};
    try {
      const info = await stat(this.file);
      const mode = info.mode & 0o777;
      if (mode === 0o600) return {};
      await chmod(this.file, 0o600);
      return { repaired: true, mode };
    } catch (error) {
      if (error && error.code === 'ENOENT') return {};
      return { error: String(error) };
    }
  }

  /** @returns {Promise<null | {nodeId:string,nodeKey:string,keyExpiresAt:number|null,registeredAt:string,coreUrl:string,permissionsRepaired?:boolean,permissionsError?:string}>} */
  async load() {
    try {
      const permissions = await this.assertPrivateMode();
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (typeof parsed?.nodeKey !== 'string' || parsed.nodeKey === '') return null;
      const state = {
        nodeId: typeof parsed.nodeId === 'string' && parsed.nodeId ? parsed.nodeId : '',
        nodeKey: parsed.nodeKey,
        keyExpiresAt: Number.isFinite(parsed.keyExpiresAt) ? parsed.keyExpiresAt : null,
        registeredAt: typeof parsed.registeredAt === 'string' ? parsed.registeredAt : '',
        coreUrl: typeof parsed.coreUrl === 'string' ? parsed.coreUrl : '',
      };
      if (permissions.repaired) state.permissionsRepaired = true;
      if (permissions.error) state.permissionsError = permissions.error;
      return state;
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      return { corrupt: true, error: String(error) };
    }
  }

  async save(state) {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const payload = {
      nodeId: state.nodeId,
      nodeKey: state.nodeKey,
      keyExpiresAt: state.keyExpiresAt ?? null,
      registeredAt: state.registeredAt || new Date().toISOString(),
      coreUrl: state.coreUrl || '',
    };
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
    return payload;
  }
}

/* ------------------------------------------------------------------ client */

export class CoreClient {
  /**
   * @param {ReturnType<typeof import('./config.mjs').loadConfig>} config
   * @param {{info:Function,warn:Function,error:Function,debug:Function}} log
   */
  constructor(config, log) {
    this.config = config;
    this.log = log;
  }

  registrationPayload(token) {
    const { config } = this;
    const payload = {
      token,
      nodeId: config.node.id,
      role: config.role,
      name: config.node.name,
      features: config.features,
      endpoint: config.node.endpoint,
      region: config.node.region,
      version: config.version,
      healthPath: config.node.healthPath,
    };
    // 0 = "not reported". Omitting an unset capacity lets an operator keep a
    // capacity set in the admin panel; sending zeros would overwrite it (the
    // Core merges every provided field).
    if (capacityIsReported(config.node.capacity)) payload.capacity = config.node.capacity;
    if (config.node.keyTtlSec > 0) payload.keyTtlSec = config.node.keyTtlSec;
    return payload;
  }

  /**
   * Register with a one-time token. Retries transient failures with exponential
   * backoff; 4xx (except 429) is fatal because retrying a burned/revoked token
   * can never succeed.
   */
  async register({ attempts = 30 } = {}) {
    const token = this.config.core.token;
    if (!token) {
      throw new FatalCoreError(
        'No node key in the state volume and AGIL_NODE_TOKEN is empty. Mint a one-time node token '
          + '(dashboard -> Infrastructure, or POST /v1/admin/cluster/tokens {"kind":"node",...}) '
          + 'or restore the node-state volume.',
      );
    }
    const payload = this.registrationPayload(token);
    const startedAt = Date.now();
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let result;
      try {
        result = await requestCore(this.config, 'POST', '/v1/nodes/register', { body: payload });
      } catch (error) {
        this.log.warn('enrollment attempt failed, retrying', {
          attempt,
          error: String(error),
          coreUrl: redactUrl(this.config.core.url),
        });
        if (attempt < attempts) await sleep(Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5)));
        continue;
      }
      if (result.status === 201 && result.json && typeof result.json.nodeKey === 'string') {
        return {
          nodeId: result.json.node?.id ?? this.config.node.id,
          nodeKey: result.json.nodeKey,
          keyExpiresAt: Number.isFinite(result.json.keyExpiresAt) ? result.json.keyExpiresAt : null,
          heartbeatIntervalSec: Number.isFinite(result.json.heartbeatIntervalSec)
            ? result.json.heartbeatIntervalSec
            : this.config.node.heartbeatSec,
          clusterId: result.json.cluster?.id ?? null,
          registerSeconds: Math.round((Date.now() - startedAt) / 1000),
        };
      }
      const detail = apiErrorMessage(result);
      if (result.status === 409) {
        throw new FatalCoreError(
          `node id "${this.config.node.id}" is already registered; use a unique NODE_ID, or disable/delete `
            + 'the old node record in core first',
          { status: 409, code: 'node_exists' },
        );
      }
      if (result.status >= 400 && result.status < 500 && result.status !== 429) {
        throw new FatalCoreError(`enrollment rejected (HTTP ${result.status}): ${detail}`, {
          status: result.status,
          code: 'enrollment_rejected',
        });
      }
      this.log.warn('enrollment attempt failed, retrying', { attempt, status: result.status, error: detail });
      if (attempt < attempts) await sleep(Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5)));
    }
    throw new FatalCoreError(
      `could not enroll node after ${attempts} attempts; is ${redactUrl(this.config.core.url)} reachable?`,
    );
  }

  /**
   * Send one heartbeat. Never throws for HTTP/network failures: the caller
   * decides whether to back off, rotate a key or keep the node in the registry.
   *
   * `metrics` is the optional node-local snapshot from `metrics.mjs`; Core
   * treats every field as optional and strips unknown keys, so an old Core that
   * does not understand `metrics` still accepts the heartbeat.
   *
   * `modules` (full inventory snapshot) and `moduleResults` (acknowledgements
   * for commands executed after an earlier beat) are forwarded only when they
   * carry data: an omitted snapshot keeps Core's previous inventory, while `[]`
   * honestly means "no modules installed". The response's `moduleCommands` are
   * returned to the caller for execution through `modules.mjs`.
   */
  async heartbeat({ nodeId, nodeKey, status = 'online', sfuReady, turnReady, turnEndpoint, turnEndpointProof, metrics, modules, moduleAvailability, moduleTemplates, moduleResults } = {}) {
    const body = { status };
    if (typeof sfuReady === 'boolean') body.sfuReady = sfuReady;
    if (typeof turnReady === 'boolean') body.turnReady = turnReady;
    if (turnReady && turnEndpoint) body.turnEndpoint = turnEndpoint;
    if (turnReady && turnEndpointProof) body.turnEndpointProof = turnEndpointProof;
    if (capacityIsReported(this.config.node.capacity)) body.capacity = this.config.node.capacity;
    const nodeMetrics = normalizeNodeMetrics(metrics);
    // Omit the whole object when nothing is measurable: `{}` is ignored by Core
    // but would add empty noise to every heartbeat.
    if (nodeMetrics) body.metrics = nodeMetrics;
    if (Array.isArray(modules)) body.modules = modules;
    if (Array.isArray(moduleTemplates)) body.moduleTemplates = moduleTemplates;
    if (moduleAvailability !== undefined) body.moduleAvailability = moduleAvailability;
    if (Array.isArray(moduleResults) && moduleResults.length > 0) body.moduleResults = moduleResults;
    try {
      const result = await requestCore(this.config, 'POST', `/v1/nodes/${encodeURIComponent(nodeId)}/heartbeat`, {
        body,
        headers: { 'x-node-token': nodeKey },
        timeoutMs: status === 'offline' ? 5_000 : REQUEST_TIMEOUT_MS,
      });
      if (result.status === 200) {
        return {
          ok: true,
          node: result.json?.node ?? null,
          drain: Boolean(result.json?.drain),
          heartbeatIntervalSec: Number.isFinite(result.json?.heartbeatIntervalSec)
            ? result.json.heartbeatIntervalSec
            : this.config.node.heartbeatSec,
          // Always an array in the contract; tolerate an old Core without it.
          moduleCommands: Array.isArray(result.json?.moduleCommands) ? result.json.moduleCommands : [],
        };
      }
      const detail = apiErrorMessage(result);
      return {
        ok: false,
        status: result.status,
        error: `HTTP ${result.status}: ${detail}`,
        expired: result.status === 401 && /expired/i.test(detail),
        disabled: result.status === 403 || /disabled/i.test(detail),
        rateLimited: result.status === 429,
      };
    } catch (error) {
      return { ok: false, status: 0, error: String(error) };
    }
  }

  /**
   * Rotate the node key through the admin API. Requires `AGIL_API_KEY`; core
   * invalidates the old key immediately, so the caller must persist the new one
   * before the next heartbeat.
   */
  async rotateKey({ nodeId, keyTtlSec } = {}) {
    if (!this.config.core.apiKey) {
      return { ok: false, status: 0, error: 'AGIL_API_KEY is not set; rotation needs an admin key' };
    }
    const body = {};
    if (Number.isInteger(keyTtlSec) && keyTtlSec > 0) body.keyTtlSec = keyTtlSec;
    try {
      const result = await requestCore(
        this.config,
        'POST',
        `/v1/admin/nodes/${encodeURIComponent(nodeId)}/rotate-key`,
        { body, headers: { 'x-api-key': this.config.core.apiKey } },
      );
      if (result.status === 200 && hasNodeKey(result.json)) {
        return {
          ok: true,
          nodeKey: result.json.nodeKey,
          keyExpiresAt: Number.isFinite(result.json.keyExpiresAt) ? result.json.keyExpiresAt : null,
        };
      }
      return { ok: false, status: result.status, error: `HTTP ${result.status}: ${apiErrorMessage(result)}` };
    } catch (error) {
      return { ok: false, status: 0, error: String(error) };
    }
  }
}

function hasNodeKey(json) {
  return Boolean(json && typeof json.nodeKey === 'string' && json.nodeKey.length > 0);
}
