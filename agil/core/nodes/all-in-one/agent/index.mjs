#!/usr/bin/env node
/**
 * First-party AGIL node agent — PID 1 of the all-in-one media node image.
 *
 * Responsibilities:
 *   1. validate the feature toggles and all media/network settings (config.mjs);
 *   2. enroll with a one-time token (or import an existing node key) and persist
 *      the returned key in the state volume (core.mjs);
 *   3. supervise LiveKit and/or coturn — one container, not one per feature
 *      (media.mjs + render.mjs);
 *   4. heartbeat core, observe `drain`, report `offline` on shutdown, optionally
 *      rotate the node key before it expires (this file);
 *   5. serve `/healthz`, `/readyz`, `/metrics` and the control endpoints
 *      (health.mjs);
 *   6. optionally manage the Core's allowlisted Docker add-on modules through
 *      the Docker Engine socket: report `modules` and execute `moduleCommands`,
 *      acknowledging them as `moduleResults` (modules.mjs). Without a socket
 *      the agent is agent-only and the media path is unaffected.
 *
 * Everything is dependency-free (Node >= 20, global fetch), same constraint as
 * `agil/core/scripts/agil-cli.mjs` and the reference `agil/infra/node-agent`.
 */

import process from 'node:process';
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { ConfigError, configSummary, loadConfig, redactUrl } from './config.mjs';
import { CoreClient, FatalCoreError, NodeStateStore } from './core.mjs';
import { startHealthServer } from './health.mjs';
import { createLogger } from './log.mjs';
import { MediaError, probeExternalSfu, Supervisor } from './media.mjs';
import { createMetricsCollector } from './metrics.mjs';
import { createModuleManager } from './modules.mjs';
import { mediaPlan } from './render.mjs';

/** Core's contract: a node silent for this long is offline. */
const OFFLINE_AFTER_SEC = 90;

function ioLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

/**
 * Run the agent until it exits. Exported so the tests can drive the same code
 * path as the container entrypoint.
 *
 * @param {{env?: Record<string,string|undefined>, installSignalHandlers?: boolean}} [options]
 *   `installSignalHandlers: false` is for in-process tests: they receive the
 *   returned `shutdown()` handle instead of pretending to be PID 1.
 */
export async function main(options = {}) {
  const env = options.env ?? process.env;
  const installSignalHandlers = options.installSignalHandlers !== false;
  const config = loadConfig(env);
  const log = createLogger(config.logLevel);

  log.info('agil node starting', configSummary(config));
  if (config.core.url.startsWith('http://')) {
    let hostname = '';
    try {
      hostname = new URL(config.core.url).hostname;
    } catch {
      /* validated in loadConfig */
    }
    if (!ioLoopback(hostname)) {
      log.warn('AGIL_CORE_URL uses plain HTTP; enrollment tokens and node keys are bearer credentials', {
        coreUrl: redactUrl(config.core.url),
      });
    }
  }

  const store = new NodeStateStore({ stateDir: config.node.stateDir });
  const core = new CoreClient(config, log.child({ component: 'core' }));

  const runtime = {
    startedAt: Date.now(),
    nodeId: config.node.id,
    registered: false,
    lastHeartbeatAt: 0,
    lastHeartbeatErrorAt: 0,
    lastHeartbeatError: '',
    heartbeats: 0,
    failures: 0,
    coreDrain: false,
    localDrain: false,
    shuttingDown: false,
    rotating: false,
    lastRotationAt: 0,
    keyExpiresAt: null,
    heartbeatIntervalSec: config.node.heartbeatSec,
    exitCode: null,
  };

  // Node-local stats attached to every heartbeat (see `metrics.mjs`). State is
  // the previous /proc sample; prime it now so the first heartbeat can already
  // report a CPU/bandwidth delta instead of waiting one full interval. The
  // collector never throws — an unavailable /proc simply drops fields.
  const metricsCollector = createMetricsCollector({
    version: config.version,
    processStartedAt: runtime.startedAt,
  });
  await metricsCollector.collect();

  // Per-node Docker add-on modules (`modules.mjs`). Discovery is label-scoped
  // (`agil.module`/`agil.node`); heartbeat response `moduleCommands` are executed
  // through the Docker Engine socket and acknowledged as `moduleResults` on a
  // later beat. A missing socket is NOT fatal: the heartbeat simply omits
  // `modules` and the node runs agent-only (media processes are unaffected).
  const moduleManager = createModuleManager({
    nodeId: () => runtime.nodeId,
    mode: config.modules.mode,
    dockerHost: config.modules.dockerHost,
    requestTimeoutMs: config.modules.requestTimeoutMs,
    pullTimeoutMs: config.modules.pullTimeoutMs,
    stateFile: config.modules.stateFile,
    envFile: config.modules.envFile,
    templatesFile: config.modules.templatesFile,
    externalSfu: !!config.sfu.externalOrigin,
    log: log.child({ component: 'modules' }),
  });

  /* ------------------------------------------------------------ enrollment */

  const loaded = await store.load();
  if (loaded && loaded.corrupt) {
    log.warn('state file is unreadable; a new enrollment is required', {
      file: store.file,
      error: loaded.error,
    });
  }
  if (loaded?.permissionsRepaired) {
    log.warn('state file permissions were too open; reset to 0600', { file: store.file });
  }
  if (loaded?.permissionsError) {
    log.warn('could not verify/reset the state file permissions; check node.json is 0600', {
      file: store.file,
      error: loaded.permissionsError,
    });
  }
  let nodeKey = loaded?.nodeKey ?? '';
  let nodeId = loaded?.nodeId || config.node.id;
  let keyExpiresAt = loaded?.keyExpiresAt ?? null;

  if (!nodeKey && config.core.nodeKey) {
    // Pre-registered node (Helm/secret): the key comes from a secret instead of
    // a one-time token. Persist it so a later restart does not depend on the env.
    nodeKey = config.core.nodeKey;
    nodeKey = nodeKey.trim();
    await store.save({ nodeId, nodeKey, keyExpiresAt: null, coreUrl: config.core.url });
    log.info('node key imported from AGIL_NODE_KEY', { nodeId, stateFile: store.file });
  }

  if (!nodeKey) {
    const registration = await core.register({ attempts: config.once ? 1 : 30 });
    nodeKey = registration.nodeKey;
    nodeId = registration.nodeId;
    keyExpiresAt = registration.keyExpiresAt;
    await store.save({ nodeId, nodeKey, keyExpiresAt, coreUrl: config.core.url });
    log.info('node registered', {
      nodeId,
      role: config.role,
      features: config.features,
      cluster: registration.clusterId,
      keyExpiresAt: keyExpiresAt ? new Date(keyExpiresAt).toISOString() : null,
      registerSeconds: registration.registerSeconds,
      stateFile: store.file,
    });
  } else {
    log.info('node key loaded from state', {
      nodeId,
      stateFile: store.file,
      keyExpiresAt: keyExpiresAt ? new Date(keyExpiresAt).toISOString() : null,
    });
  }

  runtime.nodeId = nodeId;
  runtime.keyExpiresAt = keyExpiresAt;
  runtime.registered = true;

  // Probe Docker once (loads persisted command results too). Absence is logged
  // and handled: the node keeps heartbeating as an agent-only node.
  await moduleManager.init();

  if (config.once) {
    // CI/smoke mode: enroll + one heartbeat, no media, no HTTP server. A
    // one-shot run cannot acknowledge commands on a later beat, so it reports
    // the inventory but does not execute module commands.
    const pendingResults = moduleManager.pendingResults();
    const modules = await moduleManager.inventory();
    const result = await core.heartbeat({
      nodeId,
      nodeKey,
      status: 'online',
      sfuReady: config.features.includes('sfu') ? false : undefined,
      turnReady: config.mediaEnabled && config.turn.enabled ? false : undefined,
      metrics: await metricsCollector.collect(),
      modules,
      moduleTemplates: modules !== undefined ? await moduleManager.templateCatalog() : undefined,
      moduleAvailability: moduleManager.inventoryAvailability(modules),
      moduleResults: pendingResults,
    });
    if (result.ok) {
      await moduleManager.ackResults(pendingResults.map((entry) => entry.commandId));
      if (result.moduleCommands.length > 0) {
        log.warn('NODE_ONCE: module commands are not executed in one-shot mode', {
          commands: result.moduleCommands.length,
          note: 'run the agent as a long-lived process to manage node modules',
        });
      }
      log.info('single heartbeat accepted', { nodeId, drain: result.drain });
      process.exitCode = 0;
    } else {
      log.error('single heartbeat failed', { nodeId, status: result.status, error: result.error });
      process.exitCode = 1;
    }
    await moduleManager.close();
    return { exitCode: process.exitCode };
  }

  /* ---------------------------------------------------------------- media */

  let supervisor = null;
  const externalSfu = config.sfu.externalOrigin
    ? { name: 'livekit-external', kind: 'sfu', managed: false, running: false, ready: false }
    : null;
  if (config.mediaEnabled) {
    const specs = mediaPlan(config);
    if (specs.length === 0) {
      log.info(externalSfu ? 'external LiveKit selected; no bundled media processes'
        : 'no media feature enabled (NODE_FEATURES); running as a control-plane agent only');
    } else {
      supervisor = new Supervisor({ specs, log: log.child({ component: 'media' }) });
      try {
        await supervisor.startAll();
      } catch (error) {
        log.error(error instanceof MediaError ? error.message : 'media processes failed to start', {
          error: error?.message ?? String(error),
        });
        process.exitCode = 1;
        return { exitCode: 1 };
      }
      log.info('media processes running', {
        processes: supervisor.status().map((process_) => ({
          name: process_.name,
          pid: process_.pid,
          port: process_.port,
        })),
      });
    }
  } else {
    log.warn('NODE_MEDIA_ENABLED=false: no LiveKit/coturn process will be supervised');
  }

  const getMedia = () => {
    const media = supervisor?.status() ?? [];
    return externalSfu ? [...media, externalSfu] : media;
  };

  /* -------------------------------------------------------- key rotation */

  let rotationPromise = null;

  async function rotateImpl({ keyTtlSec } = {}) {
    runtime.rotating = true;
    try {
      const ttl = Number.isInteger(keyTtlSec) && keyTtlSec > 0
        ? keyTtlSec
        : config.node.keyTtlSec > 0 ? config.node.keyTtlSec : undefined;
      const result = await core.rotateKey({ nodeId: runtime.nodeId, keyTtlSec: ttl });
      if (!result.ok) {
        log.error('node key rotation failed', { nodeId: runtime.nodeId, status: result.status, error: result.error });
        return result;
      }
      // Persist before the next heartbeat: core invalidated the old key already.
      nodeKey = result.nodeKey;
      keyExpiresAt = result.keyExpiresAt;
      runtime.keyExpiresAt = keyExpiresAt;
      runtime.lastRotationAt = Date.now();
      await store.save({ nodeId: runtime.nodeId, nodeKey, keyExpiresAt, coreUrl: config.core.url });
      log.warn('node key rotated', {
        nodeId: runtime.nodeId,
        keyExpiresAt: keyExpiresAt ? new Date(keyExpiresAt).toISOString() : null,
        stateFile: store.file,
      });
      return { ok: true, keyExpiresAt };
    } finally {
      runtime.rotating = false;
    }
  }

  /** Serialize rotations: a timer and the control endpoint must never race. */
  function rotateExclusive(input) {
    if (rotationPromise) return Promise.resolve({ ok: false, status: 409, error: 'rotation already in progress' });
    rotationPromise = rotateImpl(input).finally(() => {
      rotationPromise = null;
    });
    return rotationPromise;
  }

  async function maybeRotateKey() {
    if (config.node.keyRotateBeforeSec <= 0 || !runtime.keyExpiresAt || !config.core.apiKey) return false;
    const remainingMs = runtime.keyExpiresAt - Date.now();
    if (remainingMs > config.node.keyRotateBeforeSec * 1000) return false;
    log.info('node key expires soon; rotating', {
      keyExpiresAt: new Date(runtime.keyExpiresAt).toISOString(),
      rotateBeforeSec: config.node.keyRotateBeforeSec,
    });
    const result = await rotateExclusive({});
    return result.ok;
  }

  /* ------------------------------------------------------------ heartbeat */

  let heartbeatTimer = null;

  async function beat({ status = 'online', retryAfterRotation = true, executeCommands = true } = {}) {
    const metrics = await metricsCollector.collect();
    // Capture completed commands first so the accompanying inventory observes their effects.
    // Keep their results until Core returns 200.
    const pendingResults = moduleManager.pendingResults();
    const modules = await moduleManager.inventory();
    if (externalSfu && status === 'online' && !runtime.shuttingDown) {
      const stopping = modules?.some(({ id, sfuDrainState }) => id === 'sfu' && sfuDrainState === 'requested');
      const ready = !stopping && await probeExternalSfu(config.sfu);
      if (ready !== externalSfu.ready) log[ready ? 'info' : 'warn']('external LiveKit readiness changed', { ready });
      externalSfu.running = stopping || ready;
      externalSfu.ready = ready;
    }
    if (runtime.shuttingDown && status === 'online') return;
    const media = getMedia();
    const mediaOnline = status === 'online' && !runtime.localDrain;
    const turnReady = config.mediaEnabled && config.turn.enabled
      ? mediaOnline && media.some((service) => service.kind === 'turn' && service.ready)
      : undefined;
    const turnEndpoint = turnReady ? {
      ip: config.turn.externalIp,
      port: config.turn.port,
      credentialMode: config.turn.staticAuthSecret ? 'rest' : 'static',
      ...(config.turn.tls ? { tlsPort: config.turn.tlsPort } : {}),
      ...(config.turn.tlsHostname ? { tlsHostname: config.turn.tlsHostname } : {}),
    } : undefined;
    const result = await core.heartbeat({
      nodeId: runtime.nodeId,
      nodeKey,
      status,
      sfuReady: config.features.includes('sfu')
        ? mediaOnline && media.some((service) => service.kind === 'sfu' && service.ready)
        : undefined,
      turnReady,
      turnEndpoint,
      turnEndpointProof: turnEndpoint && config.turn.autoRegister
        ? createHmac('sha256', config.turn.staticAuthSecret).update(JSON.stringify([
          'agil-turn-auto-v1', runtime.nodeId, nodeKey, turnEndpoint.ip, turnEndpoint.port,
          turnEndpoint.tlsPort, turnEndpoint.tlsHostname,
        ])).digest('hex') : undefined,
      metrics,
      modules,
      moduleTemplates: modules !== undefined ? await moduleManager.templateCatalog() : undefined,
      moduleAvailability: moduleManager.inventoryAvailability(modules),
      moduleResults: pendingResults,
    });
    if (result.ok) {
      await moduleManager.ackResults(pendingResults.map((entry) => entry.commandId));
      if (executeCommands) {
        // Execute off the heartbeat path: an image pull must not delay the beat.
        moduleManager.handleCommands(result.moduleCommands).catch((error) => {
          log.warn('module command execution failed', { error: String(error) });
        });
      }
      runtime.heartbeats += 1;
      runtime.lastHeartbeatAt = Date.now();
      runtime.lastHeartbeatError = '';
      runtime.registered = true;
      if (Number.isFinite(result.heartbeatIntervalSec)) {
        runtime.heartbeatIntervalSec = Math.min(3600, Math.max(5, result.heartbeatIntervalSec));
      }
      if (result.drain !== runtime.coreDrain) {
        runtime.coreDrain = result.drain;
        log[result.drain ? 'warn' : 'info']('core drain flag changed', {
          drain: result.drain,
          note: result.drain
            ? 'node stays healthy for in-flight calls but /readyz is 503 (no scheduler moves calls yet)'
            : 'node returned to service',
        });
      }
      supervisor?.noteHealthy();
      await maybeRotateKey();
      return result;
    }

    runtime.failures += 1;
    runtime.lastHeartbeatErrorAt = Date.now();
    runtime.lastHeartbeatError = result.error;
    log.error('heartbeat failed', {
      nodeId: runtime.nodeId,
      status: result.status,
      error: result.error,
      action: result.expired
        ? 'key expired: rotate it (NODE_KEY_ROTATE_BEFORE_SEC + AGIL_API_KEY) or re-enroll'
        : result.disabled
          ? 'node disabled in core: re-enable it before it can heartbeat again'
          : result.rateLimited
            ? 'rate limited: check AGIL_NODE_HEARTBEAT_SEC / fleet size'
            : undefined,
    });

    if (result.expired && retryAfterRotation && config.core.apiKey) {
      const rotation = await rotateExclusive({});
      if (rotation.ok) return beat({ status, retryAfterRotation: false });
    }
    return result;
  }

  let health = null;
  health = await startHealthServer({
    config,
    runtime,
    log: log.child({ component: 'http' }),
    getMedia,
    getModules: () => moduleManager.status(),
    rotateKey: rotateExclusive,
  });

  // The first heartbeat decides readiness; a media process that dies later is
  // reported by /readyz and /metrics without killing the agent.
  await beat();

  function scheduleHeartbeat(delayMs) {
    if (runtime.shuttingDown) return;
    const jitter = 1 + (Math.random() * 0.2 - 0.1);
    heartbeatTimer = setTimeout(async () => {
      heartbeatTimer = null;
      await beat();
      if (!runtime.shuttingDown) {
        scheduleHeartbeat(Math.max(5, runtime.heartbeatIntervalSec) * 1000);
      }
    }, Math.round(Math.max(1_000, delayMs) * jitter));
    heartbeatTimer.unref?.();
    log.info('heartbeat scheduled', {
      inSec: Math.round((Math.max(1_000, delayMs) * jitter) / 1000),
      coreOfflineAfterSec: Math.max(OFFLINE_AFTER_SEC, runtime.heartbeatIntervalSec * 3),
    });
  }
  scheduleHeartbeat(Math.max(5, runtime.heartbeatIntervalSec) * 1000);

  /* ------------------------------------------------------------- shutdown */

  let shutdownPromise = null;
  const shutdown = (signal = 'TEST') => {
    if (shutdownPromise) {
      log.warn('second termination signal: exiting immediately', { signal });
      if (installSignalHandlers) process.exit(1);
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      runtime.shuttingDown = true;
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      log.info('shutting down', { signal });
      // Tell core now instead of waiting out the 90 s offline threshold. This is
      // best effort: a dead core must not delay the container stop.
      const pendingResults = moduleManager.pendingResults();
      const offline = await core.heartbeat({
        nodeId: runtime.nodeId,
        nodeKey,
        status: 'offline',
        metrics: await metricsCollector.collect(),
        // Use the last collected snapshot instead of a fresh Docker round-trip:
        // a slow/hung daemon must not delay the container stop.
        modules: moduleManager.lastSnapshot(),
        moduleResults: pendingResults,
      });
      if (offline.ok) await moduleManager.ackResults(pendingResults.map((entry) => entry.commandId));
      log.info('offline heartbeat sent', { ok: offline.ok, status: offline.status ?? null });
      await supervisor?.stopAll();
      await moduleManager.close();
      if (health) await health.close();
      log.info('shutdown complete', { signal });
      runtime.exitCode = 0;
      if (installSignalHandlers) process.exitCode = 0;
      return { exitCode: 0 };
    })();
    // Last-resort guard: never hang a container stop forever. In-process tests
    // must not schedule a process exit that can fire after the test ends.
    if (installSignalHandlers) {
      setTimeout(() => process.exit(0), 20_000).unref?.();
    }
    return shutdownPromise;
  };
  if (installSignalHandlers) {
    process.on('SIGTERM', () => {
      shutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
      shutdown('SIGINT');
    });
  }

  return { exitCode: 0, shutdown };
}

const invokedDirectly = Boolean(process.argv[1])
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().catch((error) => {
    // Bootstrap logger: the config may be what failed, so read only the level.
    const bootstrap = createLogger(process.env.NODE_LOG_LEVEL || process.env.AGIL_NODE_LOG_LEVEL || 'info');
    if (error instanceof ConfigError || error instanceof FatalCoreError || error instanceof MediaError) {
      bootstrap.error(error.message, { code: error.code });
    } else {
      bootstrap.error('node agent crashed', { error: error?.stack ?? String(error) });
    }
    // Do not call process.exit() from an async callback: on Windows/Node 23
    // undici keep-alive handles are still closing and libuv aborts with
    // UV_HANDLE_CLOSING (the reference agent hit this; see its test).
    process.exitCode = 1;
  });
}
