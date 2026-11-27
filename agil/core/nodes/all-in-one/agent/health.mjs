/**
 * Node-local health, readiness, Prometheus metrics and control endpoints.
 *
 *   GET  /healthz   liveness  — the agent process is up (never 503)
 *   GET  /readyz    readiness — enrolled + fresh heartbeat + not draining + media up
 *   GET  /metrics   Prometheus text format
 *   GET  /          version/feature/port summary
 *   POST /v1/control/drain       {"drain": true|false}  (maintenance)
 *   POST /v1/control/rotate-key  {"keyTtlSec": 2592000} (needs AGIL_API_KEY)
 *
 * Drain semantics in this baseline: core's `drain` flag is a scheduling signal,
 * and there is no multi-node scheduler yet, so the agent marks `/readyz` 503
 * (removing the node from a Kubernetes Service's endpoints) while leaving
 * in-flight calls alone. The local control endpoint is for maintenance when
 * core is unreachable or when an operator wants the same effect immediately.
 *
 * Control authentication: `NODE_CONTROL_TOKEN` when set (constant-time compare);
 * otherwise POSTs are accepted from loopback only, which is enough for
 * `docker exec ... wget 127.0.0.1:8080` but not from the network.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { configSummary, redactUrl } from './config.mjs';

/** Core marks a node offline after 90 s; keep this in sync with cluster.ts. */
const CORE_OFFLINE_AFTER_SEC = 90;

/* ---------------------------------------------------------------- helpers */

function json(res, status, body) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  return address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function presentedControlToken(req) {
  const header = req.headers['x-control-token'];
  if (typeof header === 'string' && header.trim() !== '') return header.trim();
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim();
  }
  return '';
}

export function controlAuthorized(req, controlToken) {
  if (controlToken) return safeEqual(presentedControlToken(req), controlToken);
  return isLoopbackAddress(req.socket.remoteAddress);
}

async function readJsonBody(req, { limit = 4096 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new Error('request body must be a JSON object');
      error.status = 400;
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error.status) throw error;
    const wrapped = new Error('request body is not valid JSON');
    wrapped.status = 400;
    throw wrapped;
  }
}

/* -------------------------------------------------------------- readiness */

/**
 * @param {{config:object, runtime:object, media?:Array, now?:number}} input
 * @returns {{ready:boolean, reason:string, mediaDown?:string[]}}
 */
export function evaluateReadiness({ config, runtime, media = [], now = Date.now() }) {
  if (runtime.shuttingDown) return { ready: false, reason: 'shutting_down' };
  if (!runtime.registered) return { ready: false, reason: 'not_registered' };
  if (!runtime.lastHeartbeatAt) return { ready: false, reason: 'no_heartbeat' };
  if (runtime.lastHeartbeatAt < runtime.lastHeartbeatErrorAt) {
    return { ready: false, reason: 'heartbeat_failing' };
  }
  const maxAgeMs = Math.max(CORE_OFFLINE_AFTER_SEC, config.node.heartbeatSec * 3) * 1000;
  if (now - runtime.lastHeartbeatAt > maxAgeMs) return { ready: false, reason: 'heartbeat_stale' };
  if (runtime.coreDrain || runtime.localDrain) return { ready: false, reason: 'draining' };
  if (config.mediaEnabled || config.sfu?.externalOrigin) {
    const down = media.filter((process) => !(process.ready ?? process.running)).map((process) => process.name);
    if (down.length > 0) return { ready: false, reason: 'media_down', mediaDown: down };
  }
  return { ready: true, reason: 'ok' };
}

/* ----------------------------------------------------------------- metrics */

/**
 * @param {{config:object, runtime:object, media?:Array, modules?:object|null, now?:number}} input
 */
export function renderMetrics({ config, runtime, media = [], modules = null, now = Date.now() }) {
  const readiness = evaluateReadiness({ config, runtime, media, now });
  const heartbeatAge = runtime.lastHeartbeatAt ? Math.max(0, (now - runtime.lastHeartbeatAt) / 1000) : -1;
  const lines = [
    '# HELP agil_node_up Agent process liveness (always 1 while the agent runs).',
    '# TYPE agil_node_up gauge',
    'agil_node_up 1',
    '# HELP agil_node_ready Whether /readyz would return 200.',
    '# TYPE agil_node_ready gauge',
    `agil_node_ready ${readiness.ready ? 1 : 0}`,
    '# HELP agil_node_readiness_state Current readiness reason.',
    '# TYPE agil_node_readiness_state gauge',
    `agil_node_readiness_state{reason="${readiness.reason}"} 1`,
    '# HELP agil_node_registered Whether a node key is present.',
    '# TYPE agil_node_registered gauge',
    `agil_node_registered ${runtime.registered ? 1 : 0}`,
    '# HELP agil_node_draining Whether core or a local operator marked this node draining.',
    '# TYPE agil_node_draining gauge',
    `agil_node_draining ${runtime.coreDrain || runtime.localDrain ? 1 : 0}`,
    '# HELP agil_node_heartbeats_total Accepted heartbeats.',
    '# TYPE agil_node_heartbeats_total counter',
    `agil_node_heartbeats_total ${runtime.heartbeats}`,
    '# HELP agil_node_heartbeat_failures_total Failed heartbeat attempts.',
    '# TYPE agil_node_heartbeat_failures_total counter',
    `agil_node_heartbeat_failures_total ${runtime.failures}`,
    '# HELP agil_node_last_heartbeat_timestamp_seconds Unix time of the last accepted heartbeat (0 = never).',
    '# TYPE agil_node_last_heartbeat_timestamp_seconds gauge',
    `agil_node_last_heartbeat_timestamp_seconds ${runtime.lastHeartbeatAt ? Math.floor(runtime.lastHeartbeatAt / 1000) : 0}`,
    '# HELP agil_node_last_heartbeat_age_seconds Seconds since the last accepted heartbeat (-1 = never).',
    '# TYPE agil_node_last_heartbeat_age_seconds gauge',
    `agil_node_last_heartbeat_age_seconds ${heartbeatAge.toFixed(1)}`,
    '# HELP agil_node_key_expires_timestamp_seconds Unix time when the node key expires (0 = no expiry).',
    '# TYPE agil_node_key_expires_timestamp_seconds gauge',
    `agil_node_key_expires_timestamp_seconds ${runtime.keyExpiresAt ? Math.floor(runtime.keyExpiresAt / 1000) : 0}`,
    '# HELP agil_node_key_rotation_timestamp_seconds Unix time of the last key rotation (0 = never).',
    '# TYPE agil_node_key_rotation_timestamp_seconds gauge',
    `agil_node_key_rotation_timestamp_seconds ${runtime.lastRotationAt ? Math.floor(runtime.lastRotationAt / 1000) : 0}`,
    '# HELP agil_node_info Static node labels.',
    '# TYPE agil_node_info gauge',
    `agil_node_info{node_id="${escapeLabel(runtime.nodeId || config.node.id)}",`
      + `role="${escapeLabel(config.role)}",features="${escapeLabel(config.features.join(','))}",`
      + `version="${escapeLabel(config.version)}",core="${escapeLabel(redactUrl(config.core.url))}"} 1`,
  ];
  if (modules && typeof modules === 'object') {
    // Docker add-on module capability. `managed` is the count from the last
    // inventory, never a guess; an unavailable socket keeps the node online as
    // an agent-only node.
    lines.push(
      '# HELP agil_node_docker_available Whether the Docker Engine socket is reachable (0 = agent-only node).',
      '# TYPE agil_node_docker_available gauge',
      `agil_node_docker_available ${modules.available ? 1 : 0}`,
      '# HELP agil_node_modules_managed Docker module containers discovered for this node.',
      '# TYPE agil_node_modules_managed gauge',
      `agil_node_modules_managed ${Number.isFinite(modules.managed) ? modules.managed : 0}`,
      '# HELP agil_node_module_results_pending Command results waiting for the next heartbeat.',
      '# TYPE agil_node_module_results_pending gauge',
      `agil_node_module_results_pending ${Number.isFinite(modules.pendingResults) ? modules.pendingResults : 0}`,
    );
  }
  // Prometheus requires a single HELP/TYPE pair per metric name; the per-feature
  // and per-process samples below share one header.
  lines.push('# HELP agil_node_feature Feature toggles enabled via NODE_FEATURES.');
  lines.push('# TYPE agil_node_feature gauge');
  for (const feature of config.features) {
    lines.push(`agil_node_feature{feature="${escapeLabel(feature)}"} 1`);
  }
  if (media.length > 0) {
    lines.push('# HELP agil_node_media_up Whether a supervised process is running or an external media service is ready.');
    lines.push('# TYPE agil_node_media_up gauge');
    lines.push('# HELP agil_node_media_ready Whether a media service passes its readiness probe.');
    lines.push('# TYPE agil_node_media_ready gauge');
    lines.push('# HELP agil_node_media_restarts_total Media process restarts by the supervisor.');
    lines.push('# TYPE agil_node_media_restarts_total counter');
  }
  for (const process of media) {
    const labels = `process="${escapeLabel(process.name)}",kind="${escapeLabel(process.kind)}"`;
    lines.push(`agil_node_media_up{${labels}} ${process.running ? 1 : 0}`);
    lines.push(`agil_node_media_ready{${labels}} ${(process.ready ?? process.running) ? 1 : 0}`);
    if (process.managed !== false) {
      lines.push(`agil_node_media_restarts_total{${labels}} ${Number.isFinite(process.restarts) ? process.restarts : 0}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------- server */

/**
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.runtime
 * @param {object} options.log
 * @param {() => Array} [options.getMedia]
 * @param {() => object|null} [options.getModules] Docker module status (`modules.mjs`)
 * @param {(input:{keyTtlSec?:number}) => Promise<{ok:boolean,status?:number,error?:string,keyExpiresAt?:number|null}>} [options.rotateKey]
 */
export async function startHealthServer({
  config,
  runtime,
  log,
  getMedia = () => [],
  getModules = () => null,
  rotateKey,
  now = Date.now,
}) {
  const media = () => (config.mediaEnabled || config.sfu?.externalOrigin ? getMedia() : []);
  const moduleStatus = () => (typeof getModules === 'function' ? getModules() : null);

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const isRead = method === 'GET' || method === 'HEAD';

    if (isRead) {
      switch (url.pathname) {
        case '/healthz':
        case '/health':
          json(res, 200, {
            ok: true,
            role: 'node-agent',
            version: config.version,
            nodeId: runtime.nodeId || config.node.id,
            features: config.features,
            mediaEnabled: config.mediaEnabled,
            uptimeSec: Math.round((now() - runtime.startedAt) / 1000),
            shuttingDown: Boolean(runtime.shuttingDown),
            media: media(),
          });
          return;
        case '/readyz': {
          const readiness = evaluateReadiness({ config, runtime, media: media(), now: now() });
          json(res, readiness.ready ? 200 : 503, {
            ok: readiness.ready,
            reason: readiness.reason,
            nodeId: runtime.nodeId || config.node.id,
            coreDrain: Boolean(runtime.coreDrain),
            localDrain: Boolean(runtime.localDrain),
            lastHeartbeatAt: runtime.lastHeartbeatAt ? new Date(runtime.lastHeartbeatAt).toISOString() : null,
            lastHeartbeatAgeSec: runtime.lastHeartbeatAt
              ? Math.round((now() - runtime.lastHeartbeatAt) / 1000)
              : null,
            lastError: runtime.lastHeartbeatError || null,
            mediaDown: readiness.mediaDown ?? [],
          });
          return;
        }
        case '/metrics':
          text(
            res,
            200,
            renderMetrics({ config, runtime, media: media(), modules: moduleStatus(), now: now() }),
            'text/plain; version=0.0.4; charset=utf-8',
          );
          return;
        case '/':
          json(res, 200, {
            ok: true,
            name: 'agil-node',
            ...configSummary(config),
            // Docker module capability without secrets (mode/availability/count).
            modules: moduleStatus(),
            endpoints: ['/healthz', '/readyz', '/metrics'],
          });
          return;
        default:
          json(res, 404, { ok: false, error: 'not_found' });
          return;
      }
    }

    if (method !== 'POST') {
      json(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }

    const isControl = url.pathname.startsWith('/v1/control/');
    if (!isControl) {
      json(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    if (!controlAuthorized(req, config.node.controlToken)) {
      res.setHeader('www-authenticate', 'Bearer realm="agil-node"');
      json(res, 401, {
        ok: false,
        error: 'unauthorized',
        hint: config.node.controlToken
          ? 'send x-control-token (or Authorization: Bearer) matching NODE_CONTROL_TOKEN'
          : 'set NODE_CONTROL_TOKEN to call control endpoints from a non-loopback address',
      });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      json(res, error.status ?? 400, { ok: false, error: 'invalid_body', message: error.message });
      return;
    }

    if (url.pathname === '/v1/control/drain') {
      if (body.drain !== undefined && typeof body.drain !== 'boolean') {
        json(res, 400, { ok: false, error: 'invalid_body', message: 'drain must be a boolean' });
        return;
      }
      runtime.localDrain = body.drain ?? true;
      log.warn('local drain flag changed', { drain: runtime.localDrain });
      const readiness = evaluateReadiness({ config, runtime, media: media(), now: now() });
      json(res, 200, {
        ok: true,
        drain: { core: Boolean(runtime.coreDrain), local: runtime.localDrain },
        ready: readiness.ready,
      });
      return;
    }

    if (url.pathname === '/v1/control/rotate-key') {
      if (!config.core.apiKey) {
        json(res, 501, {
          ok: false,
          error: 'rotation_requires_admin_key',
          hint: 'set AGIL_API_KEY to an admin key allowed to call POST /v1/admin/nodes/:id/rotate-key',
        });
        return;
      }
      if (typeof rotateKey !== 'function') {
        json(res, 501, { ok: false, error: 'rotation_unavailable' });
        return;
      }
      if (runtime.rotating) {
        json(res, 409, { ok: false, error: 'rotation_in_progress' });
        return;
      }
      runtime.rotating = true;
      try {
        const result = await rotateKey({ keyTtlSec: body.keyTtlSec });
        if (!result.ok) {
          json(res, 502, { ok: false, error: 'rotation_failed', message: result.error ?? 'core rejected rotation' });
          return;
        }
        json(res, 200, {
          ok: true,
          nodeId: runtime.nodeId || config.node.id,
          keyExpiresAt: result.keyExpiresAt ?? null,
          rotatedAt: new Date(runtime.lastRotationAt ?? now()).toISOString(),
        });
      } finally {
        runtime.rotating = false;
      }
      return;
    }

    json(res, 404, { ok: false, error: 'not_found' });
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      log.error('health server request failed', { url: req.url, method: req.method, error: error?.stack ?? String(error) });
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal_error' });
      else res.destroy();
    });
  });
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    log.debug('client error', { error: String(error) });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(
        error?.code === 'EADDRINUSE'
          ? new Error(`NODE_HTTP_PORT ${config.http.port} is already in use; pick another port or stop the other process`)
          : error,
      );
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.http.port, config.http.host);
  });

  log.info('health server listening', { host: config.http.host, port: config.http.port });
  return {
    server,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
