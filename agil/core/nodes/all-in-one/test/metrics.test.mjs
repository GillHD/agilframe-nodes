/**
 * Node metrics collector tests (all-in-one node agent).
 *
 * The collector is fed fake `/proc` contents and a fake clock, so the tests run
 * on Windows/macOS CI too and never read the real host's CPU counters. They
 * cover the contract fields from `nodeMetricsInputSchema` and the "omit, never
 * fake" rule for values the host cannot measure.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createMetricsCollector,
  normalizeNodeMetrics,
  parseLoadavg,
  parseMeminfo,
  parseNetDev,
  parseProcStat,
  parseUptime,
} from '../agent/metrics.mjs';

const STAT_A = 'cpu  100 10 100 780 10 0 0 0 5 5\ncpu0 100 10 100 780 10 0 0 0 5 5\nintr 1\n';
const STAT_B = 'cpu  130 10 120 930 10 0 0 0 5 5\ncpu0 130 10 120 930 10 0 0 0 5 5\n';
// total A = 100+10+100+780+10 = 1000, idle A = 790
// total B = 130+10+120+930+10 = 1200, idle B = 940
// delta: total 200, idle 150 -> 25 % busy
const MEMINFO = [
  'MemTotal:       1000000 kB',
  'MemFree:         100000 kB',
  'MemAvailable:    400000 kB',
  'Buffers:          50000 kB',
  'Cached:          250000 kB',
  '',
].join('\n');

/** `readProcFile` over an in-memory map; a missing key behaves like ENOENT. */
function fakeProc(files) {
  return async (name) => {
    const key = name.replace(/\\/g, '/');
    if (!Object.prototype.hasOwnProperty.call(files, key)) {
      const error = new Error(`ENOENT: no such file, open '/proc/${key}'`);
      error.code = 'ENOENT';
      throw error;
    }
    return files[key];
  };
}

/**
 * net/dev with a loopback interface that MUST be ignored plus eth0 counters.
 * rx bytes 1000, tx bytes 2000 -> 3000 total.
 */
function netDev(rxBytes, txBytes) {
  return [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 999999 1 0 0 0 0 0 0 888888 1 0 0 0 0 0 0',
    `  eth0: ${rxBytes} 10 0 0 0 0 0 0 ${txBytes} 20 0 0 0 0 0 0`,
    '',
  ].join('\n');
}

test('parseProcStat: sums CPU jiffies and skips guest columns that double-count user/nice', () => {
  assert.deepEqual(parseProcStat(STAT_A), { total: 1000, idle: 790 });
  // guest/guest_nice (last two columns) are already part of user/nice.
  assert.equal(parseProcStat('cpu  1 2 3 4 5 6 7 8 100 200\n').total, 36);
  assert.equal(parseProcStat('cpu  1 2 3 4 5 6 7 8 100 200\n').idle, 9);
  assert.equal(parseProcStat(''), null);
  assert.equal(parseProcStat('cpu 1 2 3\n'), null, 'a short line has no idle');
  assert.equal(parseProcStat('cpu 1 2 3 -4\n'), null, 'negative counters are invalid');
  assert.equal(parseProcStat('cpu 0 0 0 0\n'), null, 'a zero-total sample has no baseline');
});

test('parseMeminfo: reports MemTotal/MemAvailable and rejects a file without them', () => {
  assert.deepEqual(parseMeminfo(MEMINFO), { totalKb: 1_000_000, availableKb: 400_000 });
  assert.equal(parseMeminfo('MemTotal: 1000 kB\nMemFree: 10 kB\n'), null, 'no MemAvailable = no estimate');
  assert.equal(parseMeminfo('MemTotal: 0 kB\nMemAvailable: 0 kB\n'), null);
  assert.equal(parseMeminfo('garbage'), null);
});

test('parseLoadavg / parseUptime: first column only, finite and non-negative', () => {
  assert.equal(parseLoadavg('0.42 0.30 0.20 1/100 1234\n'), 0.42);
  assert.equal(parseLoadavg('0.00 0.00 0.00 1/1 1\n'), 0);
  assert.equal(parseLoadavg('nope 1 1'), null);
  assert.equal(parseLoadavg('-1 0 0'), null);
  assert.equal(parseUptime('86400.50 100000.00\n'), 86400.5);
  assert.equal(parseUptime(''), null);
});

test('parseNetDev: sums rx+tx across non-loopback interfaces and ignores lo', () => {
  assert.deepEqual(parseNetDev(netDev(1000, 2000)), { bytes: 3000 });
  assert.deepEqual(parseNetDev(''), null);
  assert.deepEqual(
    parseNetDev('Inter-|\n face |\n    lo: 10 1 0 0 0 0 0 0 10 1 0 0 0 0 0 0\n'),
    null,
    'a host with only loopback has nothing to report',
  );
  assert.deepEqual(parseNetDev('eth0: 1 2 3\n'), null, 'short column list is invalid');
});

test('collector: first sample has no CPU/bandwidth delta, deeper fields are real', async () => {
  let clock = 1000;
  const collector = createMetricsCollector({
    version: '0.1.0',
    now: () => clock,
    readProcFile: fakeProc({
      stat: STAT_A,
      meminfo: MEMINFO,
      loadavg: '0.42 0.30 0.20 1/100 1234\n',
      uptime: '86400.50 100000.00\n',
      'net/dev': netDev(1000, 2000),
    }),
    platform: 'linux',
  });
  const metrics = await collector.collect();
  assert.equal(metrics.version, '0.1.0');
  assert.equal(metrics.reportedAt, 1000);
  assert.equal(metrics.memoryPercent, 60, '(1000000-400000)/1000000 = 60 %');
  assert.equal(metrics.load1, 0.42);
  assert.equal(metrics.uptimeSec, 86400.5, 'host uptime keeps sub-second precision (protocol allows fractions)');
  assert.equal(metrics.cpuPercent, undefined, 'no previous /proc/stat sample = no CPU delta');
  assert.equal(metrics.bandwidthMbps, undefined, 'no previous NIC sample = no bandwidth delta');
  assert.equal(metrics.activeRooms, undefined, 'room state is not local to the agent');
  assert.equal(metrics.participants, undefined);
});

test('collector: second sample derives CPU percent and bandwidth from the deltas', async () => {
  let clock = 1000;
  const files = {
    stat: STAT_A,
    meminfo: MEMINFO,
    loadavg: '0.42 0.30 0.20 1/100 1234\n',
    uptime: '86400.50 100000.00\n',
    'net/dev': netDev(1000, 2000),
  };
  const collector = createMetricsCollector({
    version: '0.1.0',
    now: () => clock,
    readProcFile: fakeProc(files),
    platform: 'linux',
  });
  await collector.collect();

  clock = 3000; // two seconds later
  files.stat = STAT_B;
  files.uptime = '86402.50 100000.00\n';
  files['net/dev'] = netDev(600_000, 403_000); // 1 003 000 - 3 000 = +1 000 000 bytes over 2 s
  const metrics = await collector.collect();

  assert.equal(metrics.cpuPercent, 25, '200 jiffies total, 150 idle -> 25 % busy');
  assert.equal(metrics.bandwidthMbps, 4, '(1000000 bytes * 8) / 2 s / 1e6 = 4');
  assert.equal(metrics.uptimeSec, 86402.5);
  assert.equal(metrics.reportedAt, 3000);
});

test('collector: a host without /proc still reports version/reportedAt/process uptime only', async () => {
  const collector = createMetricsCollector({
    version: '0.1.0',
    now: () => 5000,
    processStartedAt: 2000,
    readProcFile: fakeProc({}), // every read is ENOENT (Windows/macOS, containers without /proc)
    platform: 'win32',
  });
  const metrics = await collector.collect();
  assert.deepEqual(metrics, {
    reportedAt: 5000,
    version: '0.1.0',
    uptimeSec: 3,
  });
});

test('collector: malformed /proc values are ignored, not coerced into fake numbers', async () => {
  const collector = createMetricsCollector({
    now: () => 7000,
    processStartedAt: 7000,
    platform: 'win32',
    readProcFile: fakeProc({
      stat: 'garbage\n',
      meminfo: 'MemTotal: nope\n',
      loadavg: 'nope\n',
      uptime: 'nope\n',
      'net/dev': 'garbage\n',
    }),
  });
  const metrics = await collector.collect();
  assert.deepEqual(metrics, { reportedAt: 7000, uptimeSec: 0 });
});

test('collector: os.loadavg is a non-Windows fallback when /proc/loadavg is absent', async () => {
  const collector = createMetricsCollector({
    now: () => 1,
    platform: 'linux',
    osLoad: () => [0.75, 0.5, 0.25],
    readProcFile: fakeProc({}),
  });
  const metrics = await collector.collect();
  assert.equal(metrics.load1, 0.75);
  assert.equal(metrics.memoryPercent, undefined, 'no /proc/meminfo -> memory is omitted');
});

test('collector: values are clamped to the protocol ranges', async () => {
  let clock = 1000;
  const files = {
    stat: 'cpu  0 0 0 1000\n',
    meminfo: 'MemTotal: 1000 kB\nMemAvailable: 0 kB\n',
    loadavg: '2000000 0 0 1/1 1\n',
    uptime: '999999999999 0\n',
    'net/dev': netDev(0, 0),
  };
  const collector = createMetricsCollector({
    now: () => clock,
    readProcFile: fakeProc(files),
    platform: 'linux',
  });
  await collector.collect();
  clock = 2000;
  files.stat = 'cpu  1000 0 0 1000\n'; // 100 % busy
  files['net/dev'] = netDev(2_000_000_000_000, 0); // absurd 8000 Tbps
  const metrics = await collector.collect();
  assert.equal(metrics.cpuPercent, 100);
  assert.equal(metrics.memoryPercent, 100);
  assert.equal(metrics.load1, 1_000_000);
  assert.equal(metrics.uptimeSec, 315_360_000);
  assert.equal(metrics.bandwidthMbps, 1_000_000);
});

test('collector: version is trimmed and capped at 32 characters', async () => {
  const collector = createMetricsCollector({
    version: `  ${'v'.repeat(40)}  `,
    now: () => 1,
    platform: 'win32',
    readProcFile: fakeProc({}),
  });
  const metrics = await collector.collect();
  assert.equal(metrics.version.length, 32);
  assert.equal(metrics.version, 'v'.repeat(32));
});

test('normalizeNodeMetrics: keeps valid fields, drops undefined/NaN/out-of-range ones', () => {
  assert.equal(normalizeNodeMetrics(undefined), undefined);
  assert.equal(normalizeNodeMetrics({}), undefined);
  assert.equal(normalizeNodeMetrics({ cpuPercent: Number.NaN, load1: Number.POSITIVE_INFINITY }), undefined);

  const normalized = normalizeNodeMetrics({
    cpuPercent: 150,
    memoryPercent: -5,
    load1: Number.NaN,
    activeRooms: 3,
    participants: 17,
    bandwidthMbps: 12.5,
    uptimeSec: 86400,
    version: '  0.1.0  ',
    reportedAt: 1732230000000,
    secret: 'never-forwarded',
  });
  assert.deepEqual(normalized, {
    cpuPercent: 100,
    bandwidthMbps: 12.5,
    activeRooms: 3,
    participants: 17,
    uptimeSec: 86400,
    version: '0.1.0',
    reportedAt: 1732230000000,
  });
  assert.ok(!('memoryPercent' in normalized), 'a negative percentage is dropped, not clamped to a lie');
  assert.ok(!('secret' in normalized));

  assert.deepEqual(normalizeNodeMetrics({ activeRooms: 1.5 }), undefined, 'rooms are an integer count');
  assert.deepEqual(normalizeNodeMetrics({ reportedAt: -1 }), undefined);
  assert.deepEqual(normalizeNodeMetrics({ uptimeSec: 12.5 }), { uptimeSec: 12.5 }, 'uptime may be fractional');
});
