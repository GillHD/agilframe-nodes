import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer, isIP } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'node:tls';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const loopback = new Set(['127.0.0.1', '[::1]']);
const mediaEnvironmentKeys = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LD_LIBRARY_PATH']);

function parseUrl(raw, secure, insecure) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid service URL'); }
  if (url.username || url.password || !url.hostname || url.search || url.hash ||
    (url.protocol !== secure && !(url.protocol === insecure && loopback.has(url.hostname)))) {
    throw new Error('Service URL requires TLS or a numeric loopback address');
  }
  return url;
}

function origin(url) { return `${url.protocol}//${url.host}`; }

class CoreRequestError extends Error {
  constructor(method, status = 0) {
    super(status ? `Core ${method} returned HTTP ${status}` : `Core ${method} failed`);
    this.status = status;
  }
}

function publishTarget(value, allowedOrigin) {
  const url = parseUrl(value?.url, 'rtmps:', 'rtmp:');
  if (origin(url) !== origin(allowedOrigin) || !/^[A-Za-z0-9_-]{12,256}$/.test(value?.streamKey ?? '')) {
    throw new Error('Core supplied an invalid publishing credential or a different Ingress origin');
  }
  return `${origin(url)}${url.pathname.replace(/\/+$/, '')}/${value.streamKey}`;
}

async function publisherTransport(destination) {
  const target = new URL(destination);
  if (target.protocol === 'rtmp:') return { destination };
  // Node validates the RTMPS authority before forwarding the publish key. FFmpeg uses
  // one loopback connection, so certificate verification does not vary by its TLS backend.
  const listener = createServer({ pauseOnConnect: true });
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  let inbound;
  let upstream;
  function close() {
    inbound?.destroy();
    upstream?.destroy();
    if (listener.listening) listener.close();
  }
  listener.on('connection', (socket) => {
    if (inbound) return socket.destroy();
    inbound = socket;
    listener.close();
    inbound.on('error', close).once('close', close);
    upstream = connect({ host: hostname, port: Number(target.port) || 443,
      ...(isIP(hostname) ? {} : { servername: hostname }), rejectUnauthorized: true }, () => {
      if (!socket.destroyed) socket.pipe(upstream).pipe(socket);
    });
    upstream.setTimeout(8000, close);
    upstream.once('secureConnect', () => upstream.setTimeout(0));
    upstream.on('error', close).once('close', close);
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  return { destination: `rtmp://127.0.0.1:${listener.address().port}${target.pathname}`,
    tcUrl: `${origin(target)}${target.pathname.slice(0, target.pathname.lastIndexOf('/'))}`, close };
}

async function validateInput(file, ffprobe, env, signal) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.mp4') {
    throw new Error('Source must be an absolute path to an operator-owned MP4 file');
  }
  const actual = await realpath(file).catch(() => null);
  if (!actual || !(await stat(actual).catch(() => null))?.isFile()) throw new Error('Source MP4 is unavailable');
  let streams;
  try {
    const { stdout } = await exec(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'mov',
      '-enable_drefs', '0', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,profile,sample_rate,channels',
      '-of', 'json', actual], { env, signal, timeout: 8000, maxBuffer: 65_536, windowsHide: true });
    streams = JSON.parse(stdout).streams;
  } catch {
    signal.throwIfAborted();
    throw new Error('FFprobe could not inspect the source MP4');
  }
  const video = streams?.find((stream) => stream.codec_type === 'video');
  const audio = streams?.find((stream) => stream.codec_type === 'audio');
  if (streams?.length !== 2 || video?.codec_name !== 'h264' || video.pix_fmt !== 'yuv420p' ||
    audio?.codec_name !== 'aac' || audio.profile !== 'LC' || ![1, 2].includes(audio.channels) ||
    !['44100', '48000'].includes(audio.sample_rate)) {
    throw new Error('Source requires one H.264 yuv420p video track and one mono or stereo AAC-LC track at 44.1 or 48 kHz');
  }
  return actual;
}

function launch(file, transport, ffmpeg, env) {
  const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'file,pipe', '-re', '-stream_loop', '-1', '-f', 'mov', '-enable_drefs', '0', '-i', file,
    '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'flv',
    ...(transport.tcUrl ? ['-rtmp_tcurl', transport.tcUrl] : []), transport.destination],
  { env, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  let finished = false;
  const closed = new Promise((resolve) => child.once('close', () => {
    finished = true;
    resolve(true);
  }));
  return {
    get finished() { return finished; },
    async stop() {
      if (finished) return;
      child.kill();
      if (!await Promise.race([closed, delay(3000, false, { ref: false })])) {
        child.kill('SIGKILL');
        await closed;
      }
    },
  };
}

/** Run one exclusive, operator-owned publish flow until stopped or media becomes unavailable. */
export async function runRtmpPublisher({ core, ingress, roomId, input, apiKey,
  ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', signal = new AbortController().signal, startupTimeoutMs = 45_000,
  pollIntervalMs = 2000, onState = () => {} }) {
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('Set AGIL_EDGE_CORE_API_KEY to the tenant API credential');
  if (typeof roomId !== 'string' || !roomId || roomId.length > 128) throw new Error('Set the existing SFU room ID');
  const coreUrl = parseUrl(core, 'https:', 'http:');
  const ingressOrigin = parseUrl(ingress, 'rtmps:', 'rtmp:');
  if (coreUrl.pathname !== '/' || !['', '/'].includes(ingressOrigin.pathname)) throw new Error('Use service origins without paths');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => mediaEnvironmentKeys.has(name.toUpperCase())));
  const source = await validateInput(input, ffprobe, env, signal);
  signal.throwIfAborted();
  const flowId = `edge-${randomUUID()}`;
  const route = `/v1/admin/flows/${flowId}`;
  let owned = false;
  let encoder;
  let transport;
  let state;
  let failure;
  function status(next) {
    if (state === next) return;
    state = next;
    onState({ flowId, state });
  }

  async function request(method, target, body) {
    let response;
    try {
      response = await fetch(new URL(target, coreUrl), { method, redirect: 'error',
        headers: { 'x-api-key': apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(method === 'DELETE' ? 20_000 : 8000) });
    } catch { throw new CoreRequestError(method); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CoreRequestError(method, response.status);
    }
    return response;
  }

  async function revoke() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await (await request('DELETE', route)).body?.cancel();
        return;
      } catch (error) {
        if (error.status === 404) return;
        if (attempt === 2 || ![0, 409, 502, 503, 504].includes(error.status)) throw error;
        await delay(500);
      }
    }
  }

  try {
    status('creating');
    const created = await request('POST', '/v1/admin/flows', {
      id: flowId, name: 'Edge H.264/AAC publisher', sources: [{ kind: 'rtmp_ingest', mode: 'push', roomId }],
      sinks: [{ kind: 'room', roomId }],
    });
    owned = true;
    await created.body?.cancel();
    signal.throwIfAborted();
    const issued = await request('POST', `${route}/rtmp-ingress`);
    const credential = await issued.json().catch(() => null);
    const destination = publishTarget(credential, ingressOrigin);
    signal.throwIfAborted();
    transport = await publisherTransport(destination);
    signal.throwIfAborted();
    encoder = launch(source, transport, ffmpeg, env);
    status('connecting');
    let lastPublishing = Date.now();
    while (!signal.aborted) {
      if (encoder.finished) throw new Error('FFmpeg publisher exited');
      const current = await request('GET', `${route}/rtmp-ingress`);
      const media = await current.json().catch(() => null);
      if (media?.roomId !== roomId) throw new Error('Core reported an unexpected Ingress room');
      if (media.status === 'publishing' && !encoder.finished) {
        lastPublishing = Date.now();
        status('ready');
      } else if (['waiting', 'buffering', 'provisioning', 'unknown'].includes(media.status)) {
        status(state === 'ready' || state === 'degraded' ? 'degraded' : 'connecting');
        if (Date.now() - lastPublishing >= startupTimeoutMs) throw new Error('Ingress did not confirm media before the deadline');
      } else {
        throw new Error('Ingress no longer reports a usable receiver');
      }
      await delay(pollIntervalMs, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) failure = error;
  } finally {
    await encoder?.stop();
    transport?.close?.();
    if (owned) {
      try { await revoke(); }
      catch (error) { failure = new Error(`Core did not confirm revocation. Recover flow ${flowId} through the admin API (${error.message})`); }
    }
    status(failure ? 'failed' : 'stopped');
  }
  if (failure) throw failure;
}
