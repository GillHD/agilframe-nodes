/**
 * Reference node-agent metrics tests.
 *
 * The collector module is byte-identical to the all-in-one node's copy; these
 * tests run against this copy so a bad edit in the reference image's build
 * context cannot slip through. Fake `/proc` contents keep the tests hermetic.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMetricsCollector, normalizeNodeMetrics, parseProcStat } from '../metrics.mjs';

function fakeProc(files) {
  return async (name) => {
    const key = name.replace(/\\/g, '/');
    if (!Object.prototype.hasOwnProperty.call(files, key)) {
      const error = new Error(`ENOENT: /proc/${key}`);
      error.code = 'ENOENT';
      throw error;
    }
    return files[key];
  };
}

const STAT_A = 'cpu  100 0 100 800\n';
const STAT_B = 'cpu  200 0 200 1600\n'; // total +1000, idle +800 -> 20 % busy
const MEMINFO = 'MemTotal: 2000000 kB\nMemAvailable: 500000 kB\n'; // 75 % used
const NET_A = 'face |bytes\n lo: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n eth0: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0\n';
const NET_B = 'face |bytes\n lo: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n eth0: 300 1 0 0 0 0 0 0 400 1 0 0 0 0 0 0\n';

test('reference agent metrics: parses /proc/stat and requires a delta for CPU', async () => {
  assert.deepEqual(parseProcStat(STAT_A), { total: 1000, idle: 800 });
  let clock = 1_000;
  const files = { stat: STAT_A, meminfo: MEMINFO, loadavg: '1.5 1.0 0.5 1/2 3\n', uptime: '3600.00 0\n', 'net/dev': NET_A };
  const collector = createMetricsCollector({
    version: '0.1.0',
    now: () => clock,
    readProcFile: fakeProc(files),
    platform: 'linux',
  });
  const first = await collector.collect();
  assert.equal(first.cpuPercent, undefined);
  assert.equal(first.memoryPercent, 75);
  assert.equal(first.load1, 1.5);
  assert.equal(first.uptimeSec, 3600);

  clock = 3_000;
  files.stat = STAT_B;
  files['net/dev'] = NET_B; // +400 bytes over 2 s = 0.0016 Mbps
  const second = await collector.collect();
  assert.equal(second.cpuPercent, 20);
  assert.equal(second.bandwidthMbps, 0);
  assert.equal(second.reportedAt, 3_000);
});

test('reference agent metrics: missing /proc omits fields instead of faking them', async () => {
  const collector = createMetricsCollector({
    version: '0.1.0',
    now: () => 10_000,
    processStartedAt: 4_000,
    platform: 'win32',
    readProcFile: fakeProc({}),
  });
  assert.deepEqual(await collector.collect(), {
    reportedAt: 10_000,
    version: '0.1.0',
    uptimeSec: 6,
  });
});

test('reference agent metrics: normalize keeps only contract fields and ranges', () => {
  assert.equal(normalizeNodeMetrics({}), undefined);
  assert.deepEqual(normalizeNodeMetrics({ cpuPercent: 200, secret: 'nk_x', reportedAt: 42 }), {
    cpuPercent: 100,
    reportedAt: 42,
  });
});
