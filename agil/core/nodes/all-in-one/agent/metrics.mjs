/**
 * Best-effort host metrics for Core node heartbeats.
 *
 * The heartbeat contract accepts one optional nested object (validated by
 * `nodeMetricsInputSchema` in `agil/core/packages/protocol/src/cluster.ts`):
 *
 *   metrics: {
 *     cpuPercent, memoryPercent, load1, activeRooms, participants,
 *     bandwidthMbps, uptimeSec, version, reportedAt
 *   }
 *
 * Every field is independently optional. This collector reports a field only
 * when it can actually measure it on this host:
 *
 *   cpuPercent    /proc/stat delta since the previous collection (first
 *                 collection has no baseline, so it is omitted)
 *   memoryPercent /proc/meminfo: (MemTotal - MemAvailable) / MemTotal
 *   load1         /proc/loadavg (os.loadavg fallback on non-Windows)
 *   uptimeSec     /proc/uptime (host uptime; agent process uptime fallback)
 *   bandwidthMbps /proc/net/dev delta (all non-loopback NICs) over the interval
 *                 since the previous collection
 *   activeRooms / participants
 *                 NOT collected: the node agent does not own LiveKit room state
 *                 locally (that needs an authenticated LiveKit API client), so
 *                 the fields are omitted instead of reported as fake zeros.
 *
 * Collecting never throws and never delays a heartbeat with retries: an
 * unreadable/invalid `/proc` file just drops that field. Nothing here reads a
 * secret; the values are plain host counters.
 *
 * The module is dependency-free (Node >= 20) and every input can be injected,
 * so tests feed fake `/proc` contents without touching the real host.
 *
 * Duplicated copies: `agil/infra/node-agent/metrics.mjs` (reference agent) and
 * `agil/core/scripts/lib/node-metrics.mjs` (CLI, which ships in the core image).
 * Each container/image build context is self-contained, so the three files are
 * kept byte-identical on purpose — update them together.
 */

import { readFile } from 'node:fs/promises';
import { loadavg as osLoadavg } from 'node:os';
import path from 'node:path';

const DEFAULT_PROC_ROOT = '/proc';
const MAX_VERSION_LENGTH = 32;
/** Hard caps from the protocol schema (a value outside them would be rejected). */
const LIMITS = Object.freeze({
  percent: 100,
  load1: 1_000_000,
  bandwidthMbps: 1_000_000,
  activeRooms: 1_000_000,
  participants: 10_000_000,
  uptimeSec: 315_360_000,
});

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/* ----------------------------------------------------------------- parsers */

/**
 * Parse `/proc/stat` CPU summary line into cumulative jiffies.
 *
 * @param {string} text
 * @returns {{total:number, idle:number} | null}
 */
export function parseProcStat(text) {
  if (typeof text !== 'string') return null;
  const line = text.split('\n').find((entry) => entry.startsWith('cpu '));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map((entry) => Number(entry));
  if (values.length < 4) return null;
  // guest/guest_nice are already included in user/nice, so summing all columns
  // would double-count them; the first eight are the documented CPU time parts.
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = values;
  const parts = [user, nice, system, idle, iowait, irq, softirq, steal];
  if (parts.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const total = parts.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  return { total, idle: idle + iowait };
}

/**
 * Parse `/proc/meminfo` into total/available kilobytes. `MemAvailable` is the
 * kernel's own estimate (Linux >= 3.14); a header-only/legacy file is rejected
 * rather than guessed.
 *
 * @param {string} text
 * @returns {{totalKb:number, availableKb:number} | null}
 */
export function parseMeminfo(text) {
  if (typeof text !== 'string') return null;
  const values = new Map();
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z()_]+):\s+(\d+)/.exec(line);
    if (match) values.set(match[1], Number(match[2]));
  }
  const totalKb = values.get('MemTotal');
  const availableKb = values.get('MemAvailable');
  if (!Number.isFinite(totalKb) || totalKb <= 0) return null;
  if (!Number.isFinite(availableKb) || availableKb < 0) return null;
  return { totalKb, availableKb: Math.min(availableKb, totalKb) };
}

/**
 * Parse the 1-minute load average from `/proc/loadavg`.
 *
 * @param {string} text
 * @returns {number | null}
 */
export function parseLoadavg(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed.split(/\s+/)[0]);
  return isFiniteNonNegative(value) ? value : null;
}

/**
 * Parse the host uptime in seconds from `/proc/uptime`.
 *
 * @param {string} text
 * @returns {number | null}
 */
export function parseUptime(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed.split(/\s+/)[0]);
  return isFiniteNonNegative(value) ? value : null;
}

/**
 * Sum received+transmitted bytes over non-loopback interfaces in `/proc/net/dev`.
 *
 * @param {string} text
 * @returns {{bytes:number} | null}
 */
export function parseNetDev(text) {
  if (typeof text !== 'string') return null;
  let bytes = 0;
  let interfaces = 0;
  for (const line of text.split('\n')) {
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    // `lo` only ever mirrors local traffic; counting it would inflate the node.
    if (name === 'lo' || name.startsWith('lo:')) continue;
    const columns = match[2].trim().split(/\s+/).map(Number);
    // rx: bytes packets errs drop fifo frame compressed multicast (8 columns),
    // then tx: bytes packets errs drop fifo colls carrier compressed (8 more).
    if (columns.length < 16) continue;
    if (!Number.isFinite(columns[0]) || !Number.isFinite(columns[8])) continue;
    if (columns[0] < 0 || columns[8] < 0) continue;
    bytes += columns[0] + columns[8];
    interfaces += 1;
  }
  return interfaces > 0 ? { bytes } : null;
}

/* --------------------------------------------------------------- collector */

/**
 * Build a stateful collector. State is the previous `/proc` sample (CPU jiffies,
 * NIC bytes + timestamp); it lives in memory and resets on agent restart, which
 * is exactly when a delta would be meaningless.
 *
 * @param {object} [options]
 * @param {string} [options.version] node agent version (1..32 chars)
 * @param {() => number} [options.now] clock, injected in tests
 * @param {(name:string) => Promise<string>} [options.readProcFile] reads a file
 *   name relative to the proc root (`stat`, `meminfo`, `net/dev`, ...)
 * @param {number} [options.processStartedAt] fallback uptime baseline
 * @param {NodeJS.Platform|string} [options.platform] `process.platform` override
 * @param {() => number[]} [options.osLoad] load-average override for tests
 * @param {boolean} [options.collectNetwork] sample `/proc/net/dev` (default true)
 * @returns {{collect: () => Promise<object>, reset: () => void}}
 */
export function createMetricsCollector(options = {}) {
  const {
    version = '',
    now = Date.now,
    readProcFile = (name) => readFile(path.join(DEFAULT_PROC_ROOT, name), 'utf8'),
    processStartedAt = now(),
    platform = process.platform,
    osLoad = osLoadavg,
    collectNetwork = true,
  } = options;

  let previousCpu = null;
  let previousNetwork = null;

  async function readParsed(name, parse) {
    let text;
    try {
      text = await readProcFile(name);
    } catch {
      // ENOENT/EACCES on a non-Linux host: the metric is simply unavailable.
      return null;
    }
    try {
      return parse(text);
    } catch {
      return null;
    }
  }

  async function collect() {
    const reportedAt = Math.trunc(now());
    /** @type {Record<string, number|string>} */
    const metrics = { reportedAt };

    const safeVersion = typeof version === 'string' ? version.trim().slice(0, MAX_VERSION_LENGTH) : '';
    if (safeVersion !== '') metrics.version = safeVersion;

    // CPU percent: only a delta between two samples is meaningful, so the first
    // collection after start reports no CPU rather than a fabricated value.
    const stat = await readParsed('stat', parseProcStat);
    if (stat) {
      if (previousCpu && stat.total > previousCpu.total) {
        const totalDelta = stat.total - previousCpu.total;
        const idleDelta = clamp(stat.idle - previousCpu.idle, 0, totalDelta);
        metrics.cpuPercent = round(clamp((1 - idleDelta / totalDelta) * 100, 0, LIMITS.percent), 2);
      }
      previousCpu = stat;
    }

    const memory = await readParsed('meminfo', parseMeminfo);
    if (memory) {
      const usedKb = Math.max(0, memory.totalKb - memory.availableKb);
      metrics.memoryPercent = round(clamp((usedKb / memory.totalKb) * 100, 0, LIMITS.percent), 2);
    }

    let load1 = await readParsed('loadavg', parseLoadavg);
    if (load1 === null && platform !== 'win32') {
      // /proc is Linux-only; macOS/BSD expose loadavg through node:os. Windows
      // always returns [0,0,0] there, so it is omitted instead of reported as 0.
      try {
        const value = osLoad()?.[0];
        if (isFiniteNonNegative(value)) load1 = value;
      } catch {
        /* os.loadavg unavailable */
      }
    }
    if (load1 !== null) metrics.load1 = round(clamp(load1, 0, LIMITS.load1), 2);

    let uptimeSec = await readParsed('uptime', parseUptime);
    if (uptimeSec === null) uptimeSec = Math.max(0, (reportedAt - processStartedAt) / 1000);
    // The protocol accepts a fractional number of seconds (process.uptime() is
    // fine); keep two decimals instead of flooring away sub-second uptime.
    metrics.uptimeSec = round(clamp(uptimeSec, 0, LIMITS.uptimeSec), 2);

    if (collectNetwork) {
      const net = await readParsed(path.join('net', 'dev'), parseNetDev);
      if (net) {
        if (previousNetwork && reportedAt > previousNetwork.at) {
          const bytes = Math.max(0, net.bytes - previousNetwork.bytes);
          const seconds = (reportedAt - previousNetwork.at) / 1000;
          metrics.bandwidthMbps = round(
            clamp((bytes * 8) / seconds / 1_000_000, 0, LIMITS.bandwidthMbps),
            2,
          );
        }
        previousNetwork = { bytes: net.bytes, at: reportedAt };
      }
    }

    // activeRooms/participants are intentionally absent: see the module comment.
    return metrics;
  }

  return {
    collect,
    reset() {
      previousCpu = null;
      previousNetwork = null;
    },
  };
}

/**
 * Copy only valid, contract-shaped fields. The collector already produces valid
 * values; this guards callers that build a metrics object by hand (the CLI) and
 * keeps malformed input from turning a heartbeat into a 400.
 *
 * @param {unknown} raw
 * @returns {object | undefined} `undefined` when nothing usable remains
 */
export function normalizeNodeMetrics(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  /** @type {Record<string, number|string>} */
  const metrics = {};
  const clampField = (key, max) => {
    if (isFiniteNonNegative(raw[key])) metrics[key] = round(clamp(raw[key], 0, max), 2);
  };
  clampField('cpuPercent', LIMITS.percent);
  clampField('memoryPercent', LIMITS.percent);
  clampField('load1', LIMITS.load1);
  clampField('bandwidthMbps', LIMITS.bandwidthMbps);
  for (const [key, max] of [['activeRooms', LIMITS.activeRooms], ['participants', LIMITS.participants]]) {
    if (Number.isInteger(raw[key]) && raw[key] >= 0 && raw[key] <= max) metrics[key] = raw[key];
  }
  // uptimeSec may be fractional: the protocol accepts `process.uptime()` as-is.
  if (isFiniteNonNegative(raw.uptimeSec) && raw.uptimeSec <= LIMITS.uptimeSec) {
    metrics.uptimeSec = round(clamp(raw.uptimeSec, 0, LIMITS.uptimeSec), 2);
  }
  if (typeof raw.version === 'string') {
    const version = raw.version.trim().slice(0, MAX_VERSION_LENGTH);
    if (version !== '') metrics.version = version;
  }
  if (Number.isInteger(raw.reportedAt) && raw.reportedAt >= 0 && Number.isSafeInteger(raw.reportedAt)) {
    metrics.reportedAt = raw.reportedAt;
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}
