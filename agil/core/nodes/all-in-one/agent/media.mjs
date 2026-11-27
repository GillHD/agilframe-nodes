/**
 * Minimal supervisor for the media processes of the all-in-one node.
 *
 * One container, one PID 1 (the Node agent), up to two children:
 *
 *   livekit-server   SFU (signalling + RTC)
 *   turnserver       coturn (TURN + STUN, or STUN-only)
 *
 * Why a supervisor instead of `supervisord`/s6: the agent already needs to know
 * whether media is up for `/readyz` and `/metrics`, it already handles SIGTERM,
 * and it must not hand its own secrets to the media processes. Adding a second
 * process manager would duplicate restarts and signal handling for no gain.
 *
 * Restarts use exponential backoff (1 s → 30 s) and never give up: a transient
 * port conflict or certificate read error should recover without a container
 * restart, while `/readyz` and the metrics expose the outage.
 */

import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connect as connectTls } from 'node:tls';

const PROBE_TIMEOUT_MS = 1_000;
const PROBE_INTERVAL_MS = 2_000;
const EXTERNAL_SFU_PROBE_MAX_BYTES = 8 * 1024;

/** Verify an independently operated LiveKit and the key pair used by Core. */
export async function probeExternalSfu({ externalOrigin, apiKey, apiSecret }) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    iss: apiKey, nbf: now - 5, exp: now + 15, video: { roomList: true },
  })}`;
  const signature = createHmac('sha256', apiSecret).update(claims).digest('base64url');
  try {
    const response = await fetch(`${externalOrigin}/twirp/livekit.RoomService/ListRooms`, {
      method: 'POST',
      headers: { authorization: `Bearer ${claims}.${signature}`, 'content-type': 'application/json' },
      // Limit the read to a reserved, randomly named room so readiness does not list active calls.
      body: JSON.stringify({ names: [`agil-probe-${randomBytes(12).toString('hex')}`] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel();
      return false;
    }
    if (!response.body) return false;
    let length = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > EXTERNAL_SFU_PROBE_MAX_BYTES) return false;
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
    return Boolean(body && typeof body === 'object' && !Array.isArray(body) &&
      (Object.keys(body).length === 0 || (Array.isArray(body.rooms) && body.rooms.length === 0)));
  } catch {
    return false;
  }
}

async function probeMedia({ protocol, host, port, tlsPort, tlsHostname }) {
  if (protocol === 'http') {
    try {
      const response = await fetch(`http://${host}:${port}/`, {
        redirect: 'error', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return response.ok && (await response.text()).trim() === 'OK';
    } catch {
      return false;
    }
  }

  const [udpReady, tlsReady] = await Promise.all([
    probeStunBinding(host, port),
    tlsPort === undefined ? true : probeTlsListener(host, tlsPort, tlsHostname),
  ]);
  return udpReady && tlsReady;
}

/** STUN Binding Request. Only accept the matching Binding Success Response. */
function probeStunBinding(host, port) {
  const request = Buffer.alloc(20);
  request.writeUInt16BE(0x0001);
  request.writeUInt32BE(0x2112a442, 4);
  randomBytes(12).copy(request, 8);
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let finished = false;
    const finish = (ready) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    socket.on('error', () => finish(false));
    socket.on('message', (message) => {
      if (message.length >= 20 && message.readUInt16BE(0) === 0x0101 &&
          message.subarray(4, 20).equals(request.subarray(4, 20))) finish(true);
    });
    socket.connect(port, host, () => {
      if (!finished) socket.send(request);
    });
  });
}

function probeTlsListener(host, port, hostname) {
  return new Promise((resolve) => {
    // Browser clients still verify trust. The local probe checks the certificate name before advertising it.
    const socket = connectTls({ host, port, servername: hostname || undefined, minVersion: 'TLSv1.2', rejectUnauthorized: false });
    let finished = false;
    const finish = (ready) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    socket.once('secureConnect', () => finish(!hostname ||
      Boolean(socket.getPeerX509Certificate()?.checkHost(hostname, { subject: 'never' }))));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

/** Environment seen by media children: no node token, no API keys, no TURN secret. */
export function childEnv(extra = {}, base = process.env) {
  const allowed = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'NODE_ENV', 'TERM'];
  const env = {};
  for (const key of allowed) {
    if (typeof base[key] === 'string' && base[key] !== '') env[key] = base[key];
  }
  return { ...env, ...extra };
}

export class MediaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MediaError';
    this.code = 'MEDIA_FAILED';
  }
}

export class MediaProcess {
  /**
   * @param {object} options
   * @param {{name:string,kind:string,command:string,args:string[],env:object,files:Array,port?:number}} options.spec
   * @param {object} options.log
   * @param {'inherit'|'ignore'} [options.stdio]
   */
  constructor({ spec, log, stdio = 'inherit', restartBaseMs = 1_000, restartMaxMs = 30_000, stopGraceMs = 10_000 }) {
    this.spec = spec;
    this.log = log;
    this.stdio = stdio;
    this.restartBaseMs = restartBaseMs;
    this.restartMaxMs = restartMaxMs;
    this.stopGraceMs = stopGraceMs;

    this.child = null;
    this.running = false;
    this.ready = false;
    this.stopping = false;
    this.restarts = 0;
    this.lastExit = null;
    this.startedAt = 0;
    this.consecutiveFailures = 0;
    this.restartTimer = null;
    this.probeTimer = null;
    this.fatal = null;
    this.stopWaiters = [];
  }

  get name() {
    return this.spec.name;
  }

  async prepare() {
    for (const file of this.spec.files ?? []) {
      await mkdir(path.dirname(file.path), { recursive: true, mode: 0o700 });
      await writeFile(file.path, file.content, { mode: file.mode ?? 0o600 });
    }
  }

  /** Start once. Resolves after the OS reported a successful spawn. */
  start() {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.spec.command, this.spec.args, {
          env: childEnv(this.spec.env),
          // Media logs are forwarded to the container log as-is; the agent's own
          // lines are JSON. Documented in agil/core/docs/node-image.md.
          stdio: this.stdio === 'ignore' ? 'ignore' : ['ignore', 'inherit', 'inherit'],
          windowsHide: true,
        });
      } catch (error) {
        reject(new MediaError(`${this.name}: could not start "${this.spec.command}": ${error}`));
        return;
      }
      this.child = child;
      let settled = false;

      child.once('spawn', () => {
        settled = true;
        this.running = true;
        this.ready = !this.spec.probe;
        if (this.spec.probe) void this.checkReadiness(child);
        this.startedAt = Date.now();
        // A successful (re)start clears the previous spawn error: `fatal` is a
        // diagnostic for the last failed start, not a permanent latch. Without
        // this, one transient ENOENT during a restart disabled every later
        // auto-restart (the exit handler used to return early when it was set).
        this.fatal = null;
        this.log.info('media process started', {
          process: this.name,
          kind: this.spec.kind,
          pid: child.pid,
          command: this.spec.command,
          port: this.spec.port ?? null,
        });
        resolve();
      });

      child.once('error', (error) => {
        this.running = false;
        this.ready = false;
        clearTimeout(this.probeTimer);
        this.child = null;
        const hint = error && error.code === 'ENOENT'
          ? ` (binary "${this.spec.command}" not found; the image should provide it)`
          : '';
        const wrapped = new MediaError(`${this.name}: failed to start "${this.spec.command}"${hint}: ${error.message}`);
        if (!settled) {
          settled = true;
          reject(wrapped);
          return;
        }
        this.fatal = wrapped;
        this.log.error('media process error', { process: this.name, error: wrapped.message });
      });

      child.once('exit', (code, signal) => {
        this.running = false;
        this.ready = false;
        clearTimeout(this.probeTimer);
        this.child = null;
        this.lastExit = { code, signal, at: Date.now() };
        this.log[code === 0 || this.stopping ? 'info' : 'warn']('media process exited', {
          process: this.name,
          code,
          signal,
          stopping: this.stopping,
        });
        if (this.stopping) {
          for (const waiter of this.stopWaiters.splice(0)) waiter();
          return;
        }
        // Never give up on a child: scheduleRestart() is idempotent (it returns
        // early while a timer is pending), so a crash-loop still backs off but a
        // recovered process is restartable again. `fatal` is status-only.
        this.scheduleRestart();
      });
    });
  }

  async checkReadiness(child) {
    const ready = await probeMedia(this.spec.probe);
    if (this.stopping || this.child !== child) return;
    this.ready = ready;
    this.probeTimer = setTimeout(() => void this.checkReadiness(child), PROBE_INTERVAL_MS);
    this.probeTimer.unref();
  }

  scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    this.restarts += 1;
    this.consecutiveFailures += 1;
    const delay = Math.min(this.restartMaxMs, this.restartBaseMs * 2 ** Math.min(this.consecutiveFailures - 1, 5));
    this.log.warn('restarting media process', {
      process: this.name,
      inMs: delay,
      restarts: this.restarts,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.start().catch((error) => {
        this.fatal = error instanceof MediaError ? error : new MediaError(String(error));
        this.log.error('media process could not be restarted', { process: this.name, error: String(error) });
        this.scheduleRestart();
      });
    }, delay);
  }

  /** Reset the failure counter (and the last spawn error) after a stable run. */
  noteHealthy() {
    if (this.ready && Date.now() - this.startedAt > 60_000) {
      this.consecutiveFailures = 0;
      this.fatal = null;
    }
  }

  async stop() {
    this.stopping = true;
    this.ready = false;
    clearTimeout(this.probeTimer);
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.running = false;
      return;
    }
    const exited = new Promise((resolve) => {
      this.stopWaiters.push(resolve);
      setTimeout(resolve, this.stopGraceMs).unref?.();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    await exited;
    if (this.running && this.child) {
      this.log.warn('media process did not stop in time, killing', {
        process: this.name,
        graceMs: this.stopGraceMs,
      });
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }

  status() {
    return {
      name: this.name,
      kind: this.spec.kind,
      running: this.running,
      ready: this.ready,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      lastExit: this.lastExit,
      fatal: this.fatal ? this.fatal.message : null,
      port: this.spec.port ?? null,
    };
  }
}

export class Supervisor {
  /** @param {{specs:Array, log:object, stdio?:'inherit'|'ignore', restartBaseMs?:number}} options */
  constructor({ specs, log, stdio = 'inherit', restartBaseMs, restartMaxMs, stopGraceMs }) {
    this.processes = specs.map((spec) => new MediaProcess({ spec, log, stdio, restartBaseMs, restartMaxMs, stopGraceMs }));
    this.log = log;
  }

  get enabled() {
    return this.processes.length > 0;
  }

  async startAll() {
    const started = [];
    try {
      for (const process of this.processes) {
        await process.prepare();
        await process.start();
        started.push(process);
      }
    } catch (error) {
      // Do not leave a half-started media set behind: the agent exits and the
      // orchestrator's restart policy starts a clean container.
      await this.stopAll();
      throw error;
    }
    return started;
  }

  async stopAll() {
    await Promise.all(this.processes.map((process) => process.stop()));
  }

  status() {
    return this.processes.map((process) => process.status());
  }

  allRunning() {
    return this.processes.every((process) => process.running);
  }

  noteHealthy() {
    for (const process of this.processes) process.noteHealthy();
  }
}
