/**
 * Shared test helpers for the all-in-one node image.
 *
 * No test framework beyond `node:test`, no npm dependency and no Docker: the
 * fake Core speaks the real enrollment/heartbeat/rotation contract from
 * `agil/core/apps/server/src/cluster-api.ts`, so the agent is exercised through
 * the same HTTP surface the container uses.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const AGENT_ENTRY = path.join(AGENT_DIR, 'agent', 'index.mjs');

/** Pick a free loopback TCP port (small race window is fine for tests). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
  });
}

/**
 * Fake Core implementing the node contract.
 *
 * Mutate `fake.state` from a test:
 *   rejectRegister, registerStatus, drain, rejectHeartbeatStatus,
 *   heartbeatIntervalSec, apiKey, keyExpiresAt.
 */
export async function startFakeCore(options = {}) {
  const state = {
    nodeId: options.nodeId ?? 'test-node',
    nodeKey: options.nodeKey ?? 'nk_test_node_key_0123456789abcdef',
    heartbeatIntervalSec: options.heartbeatIntervalSec ?? 5,
    drain: options.drain ?? false,
    rejectRegister: options.rejectRegister ?? false,
    registerStatus: options.registerStatus ?? 0,
    rejectHeartbeatStatus: options.rejectHeartbeatStatus ?? 0,
    apiKey: options.apiKey ?? '',
    keyExpiresAt: options.keyExpiresAt ?? null,
    /** Module commands delivered on the next heartbeat (like the real Core). */
    moduleCommands: [...(options.moduleCommands ?? [])],
    requests: [],
    rotations: 0,
  };

  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { __invalid: raw };
    }
    state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    const json = (status, payload) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    const apiError = (status, code, message) =>
      json(status, { error: { code, message } });

    if (req.method === 'POST' && req.url === '/v1/nodes/register') {
      if (state.rejectRegister || state.registerStatus >= 400) {
        apiError(state.registerStatus || 401, 'unauthorized', 'enrollment token rejected');
        return;
      }
      if (typeof body.nodeId === 'string' && body.nodeId) state.nodeId = body.nodeId;
      state.registered = true;
      json(201, {
        node: {
          id: state.nodeId,
          role: body.role,
          features: body.features ?? [],
          capacity: body.capacity ?? { maxRooms: 0, maxParticipants: 0, bandwidthMbps: 0 },
          status: 'online',
          tenantId: 'tn_test',
        },
        nodeKey: state.nodeKey,
        keyExpiresAt: state.keyExpiresAt,
        heartbeatIntervalSec: state.heartbeatIntervalSec,
        cluster: { id: 'cl_test', role: 'leader', version: '0.1.0' },
      });
      return;
    }

    const heartbeatMatch = /^\/v1\/nodes\/([^/]+)\/heartbeat$/.exec(req.url ?? '');
    if (req.method === 'POST' && heartbeatMatch) {
      if (state.rejectHeartbeatStatus >= 400) {
        apiError(
          state.rejectHeartbeatStatus,
          state.rejectHeartbeatStatus === 401 ? 'unauthorized' : 'forbidden',
          state.rejectHeartbeatMessage ?? 'node key expired',
        );
        return;
      }
      if (req.headers['x-node-token'] !== state.nodeKey) {
        apiError(401, 'unauthorized', 'invalid node key');
        return;
      }
      if (decodeURIComponent(heartbeatMatch[1]) !== state.nodeId) {
        apiError(404, 'not_found', 'Node not found');
        return;
      }
      const commands = state.moduleCommands;
      state.moduleCommands = [];
      json(200, {
        node: { id: state.nodeId, status: body.status ?? 'online' },
        drain: state.drain,
        heartbeatIntervalSec: state.heartbeatIntervalSec,
        serverTime: Date.now(),
        moduleCommands: commands,
      });
      return;
    }

    const rotateMatch = /^\/v1\/admin\/nodes\/([^/]+)\/rotate-key$/.exec(req.url ?? '');
    if (req.method === 'POST' && rotateMatch) {
      if (!state.apiKey || req.headers['x-api-key'] !== state.apiKey) {
        apiError(401, 'unauthorized', 'admin key required');
        return;
      }
      state.rotations += 1;
      state.nodeKey = `nk_rotated_${state.rotations}_0123456789abcdef`;
      state.keyExpiresAt = Date.now() + 30 * 24 * 3600 * 1000;
      json(200, {
        node: { id: state.nodeId },
        nodeKey: state.nodeKey,
        keyExpiresAt: state.keyExpiresAt,
        heartbeatIntervalSec: state.heartbeatIntervalSec,
      });
      return;
    }

    apiError(404, 'not_found', 'no route');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    state,
    port,
    url: `http://127.0.0.1:${port}`,
    requests: state.requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/** Env for a child agent with the host's AGIL_/NODE_/LIVEKIT_/TURN_/SFU_/DOCKER_ vars removed. */
export function agentEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(AGIL_|NODE_|LIVEKIT_|TURN_|SFU_|DOCKER_)/.test(key)) delete env[key];
  }
  return { ...env, ...overrides };
}

/** Run the agent to completion (for NODE_ONCE / expected-failure tests). */
export function runAgent(env, { timeoutMs = 25_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AGENT_ENTRY], {
      env: agentEnv(env),
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
      child.kill('SIGKILL');
      reject(new Error(`agent did not exit within ${timeoutMs} ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** Start a long-running agent for health/drain tests. */
export async function startAgent(env, { timeoutMs = 20_000 } = {}) {
  const child = spawn(process.execPath, [AGENT_ENTRY], {
    env: agentEnv(env),
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
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  // Fail fast on a startup crash instead of waiting out the readiness timeout.
  const earlyExit = exited.then((result) => {
    if (result.code !== 0 && !child.__stopping) {
      throw new Error(`agent exited early (${result.code})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    return result;
  });
  return {
    child,
    output: () => ({ stdout, stderr }),
    exit: earlyExit,
    async stop({ signal = 'SIGTERM', timeoutMs: stopTimeoutMs = 15_000 } = {}) {
      child.__stopping = true;
      child.kill(signal);
      const timer = setTimeout(() => child.kill('SIGKILL'), stopTimeoutMs);
      timer.unref?.();
      const result = await exited;
      clearTimeout(timer);
      return { ...result, stdout, stderr };
    },
    kill: () => child.kill('SIGKILL'),
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `fn` until it returns a truthy value or the timeout expires. */
export async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

/** GET/POST JSON helper used by the health-server tests. */
export async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* plain-text endpoint (/metrics) */
  }
  return { status: response.status, headers: response.headers, text, json };
}
