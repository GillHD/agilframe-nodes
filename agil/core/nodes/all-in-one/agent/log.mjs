/**
 * JSON-line logger. One line per event so `docker logs` output can be filtered
 * by level/process without a collector, and secrets are never passed in
 * (`configSummary`/`apiErrorMessage` are the only config-like extras).
 */

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function write(level, message, extra, { stdout, stderr, threshold, bindings }) {
  if ((LEVELS[level] ?? 20) < threshold) return;
  const record = { ts: new Date().toISOString(), level, msg: message, ...bindings, ...extra };
  let line;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ ts: record.ts, level, msg: message, error: 'unserializable log fields' });
  }
  (level === 'warn' || level === 'error' ? stderr : stdout).write(`${line}\n`);
}

/**
 * @param {'debug'|'info'|'warn'|'error'} levelName
 * @param {{stdout?:NodeJS.WritableStream, stderr?:NodeJS.WritableStream, bindings?:object}} [options]
 */
export function createLogger(levelName = 'info', options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const threshold = LEVELS[levelName] ?? LEVELS.info;
  const bindings = options.bindings ?? {};
  const log = {
    level: levelName,
    debug: (message, extra = {}) => write('debug', message, extra, { stdout, stderr, threshold, bindings }),
    info: (message, extra = {}) => write('info', message, extra, { stdout, stderr, threshold, bindings }),
    warn: (message, extra = {}) => write('warn', message, extra, { stdout, stderr, threshold, bindings }),
    error: (message, extra = {}) => write('error', message, extra, { stdout, stderr, threshold, bindings }),
    child: (extraBindings) => createLogger(levelName, {
      stdout,
      stderr,
      bindings: { ...bindings, ...extraBindings },
    }),
  };
  return log;
}

export { LEVELS };
