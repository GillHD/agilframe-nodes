/**
 * Configuration parsing and validation for the AGIL all-in-one media node.
 *
 * Everything here is pure: no process is spawned, no file is written and no
 * network call is made. That keeps the safety rules (public relay IP, relay
 * range, feature toggles) unit-testable without Docker, and means a bad
 * `.env` fails with one actionable message instead of three half-started
 * processes.
 *
 * The image runs one container with up to two media processes:
 *
 *   NODE_FEATURES=sfu          LiveKit SFU (signalling + RTC)
 *   NODE_FEATURES=turn         coturn with a static credential + relay range
 *   NODE_FEATURES=stun         coturn in STUN-only mode (no auth, no relay)
 *   NODE_FEATURES=sfu,turn,stun  all of the above on one host
 *
 * `turn` already answers STUN, so `sfu,turn` does not start a second coturn;
 * `stun` on its own starts coturn with `--stun-only`.
 *
 * Environment names: `NODE_*` is the canonical prefix for this image and
 * `AGIL_NODE_*` is accepted as an alias so the same `.env` works with the
 * quickstart node bundle and the `agil-node` Helm chart. The core enrollment
 * contract itself is unchanged (`AGIL_CORE_URL`, `AGIL_NODE_TOKEN`,
 * `AGIL_NODE_KEY`, `AGIL_API_KEY`).
 */

import { networkInterfaces } from 'node:os';
import path from 'node:path';

export const NODE_IMAGE_VERSION = '0.1.0';
export const FEATURES = Object.freeze(['sfu', 'turn', 'stun']);
export const ROLES = Object.freeze(['sfu', 'turn', 'stun', 'all']);

/** Raised for any invalid/missing setting. The message is shown to the operator. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'CONFIG_INVALID';
  }
}

/** Parse a Redis endpoint into the fields accepted by LiveKit. */
export function parseRedisUrl(raw) {
  if (!raw) return null;
  if (!raw.includes('://')) {
    const match = /^(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9._-]+):([0-9]{1,5})$/.exec(raw);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
      throw new ConfigError('SFU_REDIS_URL must be redis://…, rediss://…, or a host:port pair with port 1–65535');
    }
    return { address: raw };
  }
  let url;
  try {
    if (/\s/.test(raw)) throw new TypeError('Whitespace in Redis URL');
    url = new URL(raw);
  } catch {
    throw new ConfigError('SFU_REDIS_URL is not a valid URL');
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new ConfigError('SFU_REDIS_URL must start with redis:// or rediss://');
  }
  if (url.hostname === '' || url.port === '0') {
    throw new ConfigError('SFU_REDIS_URL requires a host and a valid port');
  }
  const db = url.pathname.replace(/^\//, '').trim();
  if (db !== '' && !/^[0-9]{1,3}$/.test(db)) {
    throw new ConfigError('SFU_REDIS_URL has an invalid Redis database (expected /<number>)');
  }
  let username;
  let password;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new ConfigError('SFU_REDIS_URL has invalid percent encoding in its credentials');
  }
  return {
    address: `${url.hostname}:${url.port || '6379'}`,
    username,
    password,
    db: db === '' ? undefined : Number.parseInt(db, 10),
    useTls: url.protocol === 'rediss:',
  };
}

/* --------------------------------------------------------------------- IPv4 */

/** Dotted-quad IPv4 with no leading zeros (mirrors quickstart/lib/net.sh). */
export function ipv4IsValid(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
}

/**
 * Classify an IPv4 address the same way `agil/infra/quickstart/lib/net.sh` does:
 * `public | private | loopback | unspecified | invalid`. `private` includes
 * RFC1918, CGNAT 100.64/10, link-local 169.254/16 and 0/8.
 */
export function classifyIpv4(value) {
  if (!ipv4IsValid(value)) return 'invalid';
  if (value === '0.0.0.0') return 'unspecified';
  const [first, second] = value.split('.').map(Number);
  if (first === 127) return 'loopback';
  if (first === 0 || first === 10) return 'private';
  if (first === 100 && second >= 64 && second <= 127) return 'private';
  if (first === 169 && second === 254) return 'private';
  if (first === 172 && second >= 16 && second <= 31) return 'private';
  if (first === 192 && second === 168) return 'private';
  return 'public';
}

/* ---------------------------------------------------------------- env helpers */

/**
 * Strip URL userinfo before a URL reaches a log line, a metric label or an
 * error message. Credentials never belong in a URL (fetch rejects them), but a
 * value restored from an old state file or a copied command could still carry
 * them, so every operator-facing projection goes through this helper.
 */
export function redactUrl(value) {
  if (typeof value !== 'string' || value === '') return '';
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/i, '$1');
}

function readEnv(env, name, alias = '') {
  const primary = typeof env[name] === 'string' ? env[name].trim() : '';
  if (primary !== '') return primary;
  return alias && typeof env[alias] === 'string' ? env[alias].trim() : '';
}

function parseIntSetting(env, name, alias, fallback, { min, max }) {
  const raw = readEnv(env, name, alias);
  if (raw === '') return fallback;
  if (!/^-?[0-9]+$/.test(raw)) {
    throw new ConfigError(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new ConfigError(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return value;
}

export function readHttpListener(env) {
  return {
    host: readEnv(env, 'NODE_HTTP_HOST', 'AGIL_NODE_HTTP_HOST') || '0.0.0.0',
    port: parseIntSetting(env, 'NODE_HTTP_PORT', 'AGIL_NODE_HTTP_PORT', 8080, { min: 1, max: 65535 }),
  };
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', '']);

function parseBoolSetting(env, name, alias, fallback) {
  const raw = readEnv(env, name, alias).toLowerCase();
  if (raw === '') {
    // readEnv collapses an explicitly empty value into "" — treat it as unset so
    // `NODE_ACCEPT_PRIVATE_IP=` cannot silently disable the safety default.
    return fallback;
  }
  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;
  throw new ConfigError(`${name} must be a boolean (1/0, true/false, yes/no), got "${raw}"`);
}

/** Comma- or whitespace-separated list, trimmed and de-duplicated. */
export function parseList(raw) {
  if (Array.isArray(raw)) return raw.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof raw !== 'string') return [];
  return raw.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

/**
 * Parse `NODE_FEATURES`. Unknown tokens are rejected: silently ignoring a typo
 * (`sfu,tun`) would register a node that claims to do something it does not.
 */
export function parseFeatures(raw) {
  const tokens = parseList(raw).map((token) => token.toLowerCase());
  if (tokens.length === 0) return ['sfu'];
  const unique = [...new Set(tokens)];
  const unknown = unique.filter((token) => !FEATURES.includes(token));
  if (unknown.length > 0) {
    throw new ConfigError(
      `NODE_FEATURES has unknown feature(s): ${unknown.join(', ')} (allowed: ${FEATURES.join(', ')})`,
    );
  }
  return unique;
}

function requireSafeToken(name, value, { min = 8, max = 256, pattern = null } = {}) {
  if (value.length < min || value.length > max) {
    throw new ConfigError(`${name} must be ${min}..${max} characters`);
  }
  if (/[\s]/.test(value) || /[\u0000-\u001f]/.test(value)) {
    throw new ConfigError(`${name} must not contain whitespace or control characters`);
  }
  if (pattern && !pattern.test(value)) {
    throw new ConfigError(`${name} contains unsupported characters`);
  }
  return value;
}

const CAPACITY_MAX = Object.freeze({
  maxRooms: 1_000_000,
  maxParticipants: 10_000_000,
  bandwidthMbps: 1_000_000,
});

function parseCapacity(raw) {
  if (raw === '') return { maxRooms: 0, maxParticipants: 0, bandwidthMbps: 0 };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('NODE_CAPACITY must be valid JSON, e.g. {"maxRooms":10,"maxParticipants":500}');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('NODE_CAPACITY must be a JSON object');
  }
  const capacity = { maxRooms: 0, maxParticipants: 0, bandwidthMbps: 0 };
  for (const key of Object.keys(capacity)) {
    if (parsed[key] === undefined || parsed[key] === null) continue;
    const value = Number(parsed[key]);
    if (!Number.isInteger(value) || value < 0 || value > CAPACITY_MAX[key]) {
      throw new ConfigError(`NODE_CAPACITY.${key} must be an integer in [0, ${CAPACITY_MAX[key]}]`);
    }
    capacity[key] = value;
  }
  return capacity;
}

/** True when the operator reported a non-zero capacity (0 = "not reported"). */
export function capacityIsReported(capacity) {
  return Boolean(
    capacity
      && (capacity.maxRooms > 0 || capacity.maxParticipants > 0 || capacity.bandwidthMbps > 0),
  );
}

/* --------------------------------------------------- registration metadata */

/** Same metadata-host deny list as the Core registry (defence in depth). */
const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'instance-data',
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  'fd00:ec2::254',
]);

const ENDPOINT_RE = /^(https?|wss?):\/\/[^\s/]+/i;

/**
 * Validate `NODE_ENDPOINT` before it reaches the Core registry. An invalid URL
 * would otherwise register as a 400 and the node would never come up.
 */
function parseEndpoint(raw) {
  if (raw === '') return '';
  if (raw.length > 300) throw new ConfigError('NODE_ENDPOINT must be at most 300 characters');
  if (!ENDPOINT_RE.test(raw)) {
    throw new ConfigError('NODE_ENDPOINT must be an http(s)/ws(s) URL, e.g. https://sfu-1.example.net');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`NODE_ENDPOINT "${raw}" is not a valid URL`);
  }
  if (url.username || url.password) {
    throw new ConfigError('NODE_ENDPOINT must not contain credentials; the Core registry stores it in clear text');
  }
  if (url.hostname === '') throw new ConfigError('NODE_ENDPOINT has no hostname');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (METADATA_HOSTS.has(host)) {
    throw new ConfigError('NODE_ENDPOINT must not point at a cloud metadata service');
  }
  return raw;
}

function parseHealthPath(raw) {
  if (raw === '') return '/healthz';
  if (raw.length > 200) throw new ConfigError('NODE_HEALTH_PATH must be at most 200 characters');
  if (!raw.startsWith('/')) throw new ConfigError('NODE_HEALTH_PATH must start with "/"');
  if (/[\s\u0000-\u001f]/.test(raw)) {
    throw new ConfigError('NODE_HEALTH_PATH must not contain whitespace or control characters');
  }
  return raw;
}

function parseBoundedText(name, value, max, { min = 1 } = {}) {
  const text = value.trim();
  if (text.length < min || text.length > max) {
    throw new ConfigError(`${name} must be ${min}..${max} characters`);
  }
  if (/[\u0000-\u001f]/.test(text)) {
    throw new ConfigError(`${name} must not contain control characters`);
  }
  return text;
}

/** First non-internal IPv4 of this host (host networking: the real host NIC). */
export function detectHostIpv4() {
  const interfaces = networkInterfaces();
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (name === 'lo') continue;
      candidates.push(address.address);
    }
  }
  // Prefer a public address, then a private one: behind cloud 1:1 NAT the host
  // NIC is private and the operator must pass TURN_EXTERNAL_IP explicitly.
  return candidates.find((ip) => classifyIpv4(ip) === 'public') ?? candidates[0] ?? '';
}

/**
 * Validate an address advertised to participants (TURN relay candidate or the
 * LiveKit `node_ip`). Private/loopback values are only accepted with
 * `TURN_ALLOW_PRIVATE_IP=1`, mirroring the quickstart installer.
 */
function checkAdvertisedIpv4(label, value, { allowPrivate, required }) {
  if (value === '') {
    if (required) {
      throw new ConfigError(
        `${label} is required: set it to this host's public IPv4. `
          + 'Auto-detection failed or produced a private address; see agil/core/docs/node-image.md.',
      );
    }
    return '';
  }
  const kind = classifyIpv4(value);
  switch (kind) {
    case 'public':
      return value;
    case 'invalid':
      throw new ConfigError(`${label} "${value}" is not a dotted-quad IPv4 address (e.g. 203.0.113.10)`);
    case 'unspecified':
      throw new ConfigError(`${label} is 0.0.0.0; participants cannot reach that relay/candidate address`);
    case 'loopback':
      if (!allowPrivate) {
        throw new ConfigError(
          `${label} is loopback: only processes on this host can use it. `
            + 'Set the public IPv4, or TURN_ALLOW_PRIVATE_IP=1 for a LAN/dev trial.',
        );
      }
      return value;
    case 'private':
      if (!allowPrivate) {
        throw new ConfigError(
          `${label} "${value}" is a private (RFC1918/CGNAT) address; remote participants would receive an `
            + 'unroutable candidate (ICE connects, media never flows). Set the public IPv4, or '
            + 'TURN_ALLOW_PRIVATE_IP=1 for a LAN/dev trial only.',
        );
      }
      return value;
    default:
      throw new ConfigError(`${label} "${value}" could not be classified`);
  }
}

/* -------------------------------------------------------------------- config */

/**
 * Read and validate the whole node configuration.
 *
 * @param {Record<string, string | undefined>} env process environment
 * @param {{ hostIPv4?: string }} [options] injectable host address for tests
 */
export function loadConfig(env = process.env, options = {}) {
  const features = parseFeatures(readEnv(env, 'NODE_FEATURES', 'AGIL_NODE_FEATURES'));
  const derivedRole = features.length === 1 ? features[0] : 'all';
  const explicitRole = readEnv(env, 'NODE_ROLE', 'AGIL_NODE_ROLE').toLowerCase();
  if (explicitRole !== '' && !ROLES.includes(explicitRole)) {
    throw new ConfigError(`NODE_ROLE must be one of ${ROLES.join('|')}, got "${explicitRole}"`);
  }
  if (explicitRole !== '' && explicitRole !== derivedRole && explicitRole !== 'all') {
    throw new ConfigError(
      `NODE_ROLE=${explicitRole} contradicts NODE_FEATURES=${features.join(',')} (derived role: ${derivedRole}). `
        + 'Use NODE_ROLE=all for a multi-feature node, or remove NODE_ROLE and let it derive.',
    );
  }
  const role = explicitRole || derivedRole;

  const coreUrlRaw = readEnv(env, 'AGIL_CORE_URL', 'NODE_CORE_URL') || 'http://127.0.0.1:8787';
  let coreUrlObject;
  try {
    coreUrlObject = new URL(coreUrlRaw);
  } catch {
    throw new ConfigError(`AGIL_CORE_URL "${redactUrl(coreUrlRaw)}" is not a valid URL`);
  }
  if (coreUrlObject.protocol !== 'http:' && coreUrlObject.protocol !== 'https:') {
    throw new ConfigError('AGIL_CORE_URL must start with http:// or https://');
  }
  if (coreUrlObject.username || coreUrlObject.password) {
    // `fetch()` rejects a credential-bearing URL outright ("Request cannot be
    // constructed from a URL that includes credentials"), so accepting it would
    // only turn into an endless enrollment retry that echoes the password into
    // the logs. Credentials must travel in headers, not in the URL.
    throw new ConfigError(
      'AGIL_CORE_URL must not contain credentials (user:password@); the node authenticates '
        + 'with the enrollment token and node key in request headers',
    );
  }
  const coreUrl = coreUrlRaw.replace(/\/+$/, '');

  const allowPrivateIp = parseBoolSetting(env, 'TURN_ALLOW_PRIVATE_IP', 'NODE_ALLOW_PRIVATE_IP', false);
  const heartbeatSec = parseIntSetting(env, 'NODE_HEARTBEAT_SEC', 'AGIL_NODE_HEARTBEAT_SEC', 30, { min: 5, max: 3600 });
  const nodeId = readEnv(env, 'NODE_ID', 'AGIL_NODE_ID') || 'agil-node-1';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(nodeId)) {
    throw new ConfigError(
      `NODE_ID "${nodeId}" must be 1..64 URL-safe characters ([A-Za-z0-9._:-], starting alphanumeric)`,
    );
  }
  // Registration metadata is validated here so the Core does not reject the
  // node with a 400 after the enrollment token has already been burned.
  const nodeNameRaw = readEnv(env, 'NODE_NAME', 'AGIL_NODE_NAME');
  const nodeName = nodeNameRaw === '' ? nodeId : parseBoundedText('NODE_NAME', nodeNameRaw, 80);
  const nodeRegion = readEnv(env, 'NODE_REGION', 'AGIL_NODE_REGION');
  if (nodeRegion !== '') parseBoundedText('NODE_REGION', nodeRegion, 64);
  const nodeEndpoint = parseEndpoint(readEnv(env, 'NODE_ENDPOINT', 'AGIL_NODE_ENDPOINT'));
  const nodeHealthPath = parseHealthPath(readEnv(env, 'NODE_HEALTH_PATH', 'AGIL_NODE_HEALTH_PATH'));

  const logLevelRaw = readEnv(env, 'NODE_LOG_LEVEL', 'AGIL_NODE_LOG_LEVEL').toLowerCase() || 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelRaw)) {
    throw new ConfigError(`NODE_LOG_LEVEL must be debug|info|warn|error, got "${logLevelRaw}"`);
  }

  const controlToken = readEnv(env, 'NODE_CONTROL_TOKEN', 'AGIL_NODE_CONTROL_TOKEN');
  if (controlToken !== '') {
    requireSafeToken('NODE_CONTROL_TOKEN', controlToken, { min: 8, max: 256 });
  }

  const keyRotateBeforeSec = parseIntSetting(env, 'NODE_KEY_ROTATE_BEFORE_SEC', '', 0, { min: 0, max: 7_776_000 });
  const apiKey = readEnv(env, 'AGIL_API_KEY');
  if (keyRotateBeforeSec > 0 && apiKey === '') {
    throw new ConfigError(
      'NODE_KEY_ROTATE_BEFORE_SEC requires AGIL_API_KEY (an admin key that may call '
        + 'POST /v1/admin/nodes/:id/rotate-key), or set NODE_KEY_ROTATE_BEFORE_SEC=0',
    );
  }

  const sfuEnabled = features.includes('sfu');
  const turnEnabled = features.includes('turn');
  const stunEnabled = features.includes('stun');

  /* --------------------------------------------------------------- SFU ---- */
  const sfuExternal = readEnv(env, 'SFU_EXTERNAL_URL');
  let sfuExternalOrigin = '';
  if (sfuExternal) {
    if (!sfuEnabled) throw new ConfigError('SFU_EXTERNAL_URL requires the sfu feature');
    const url = URL.canParse(sfuExternal) ? new URL(sfuExternal) : null;
    if (!url?.hostname || !['http:', 'https:'].includes(url.protocol) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new ConfigError('SFU_EXTERNAL_URL must be an HTTP or HTTPS origin without credentials, path, query or fragment');
    }
    sfuExternalOrigin = url.origin;
  }
  const sfuLocalEnv = sfuExternalOrigin ? {} : env;
  const sfuPort = parseIntSetting(sfuLocalEnv, 'SFU_PORT', '', 7880, { min: 1, max: 65535 });
  const sfuTcpPort = parseIntSetting(sfuLocalEnv, 'SFU_TCP_PORT', '', 7881, { min: 1, max: 65535 });
  const sfuUdpMinPort = parseIntSetting(sfuLocalEnv, 'SFU_UDP_MIN_PORT', '', 50000, { min: 1024, max: 65535 });
  const sfuUdpMaxPort = parseIntSetting(sfuLocalEnv, 'SFU_UDP_MAX_PORT', '', 50100, { min: 1024, max: 65535 });
  if (sfuUdpMaxPort < sfuUdpMinPort) {
    throw new ConfigError(`SFU_UDP_MAX_PORT (${sfuUdpMaxPort}) must be >= SFU_UDP_MIN_PORT (${sfuUdpMinPort})`);
  }
  const sfuUdpMuxPort = parseIntSetting(sfuLocalEnv, 'SFU_UDP_MUX_PORT', '', 0, { min: 0, max: 65535 });
  const sfuMetricsPort = parseIntSetting(sfuLocalEnv, 'SFU_METRICS_PORT', '', 6789, { min: 0, max: 65535 });
  const sfuLogLevel = readEnv(sfuLocalEnv, 'SFU_LOG_LEVEL').toLowerCase() || 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(sfuLogLevel)) {
    throw new ConfigError(`SFU_LOG_LEVEL must be debug|info|warn|error, got "${sfuLogLevel}"`);
  }

  const livekitApiKey = readEnv(env, 'LIVEKIT_API_KEY', 'AGIL_SFU_API_KEY');
  const livekitApiSecret = readEnv(env, 'LIVEKIT_API_SECRET', 'AGIL_SFU_API_SECRET');
  if (sfuEnabled) {
    if (livekitApiKey === '' || livekitApiSecret === '') {
      throw new ConfigError(
        'the sfu feature needs LIVEKIT_API_KEY and LIVEKIT_API_SECRET (the same pair AGIL Core uses as '
          + 'AGIL_SFU_API_KEY/AGIL_SFU_API_SECRET). LiveKit refuses to validate join tokens without them.',
      );
    }
    requireSafeToken('LIVEKIT_API_KEY', livekitApiKey, { min: 3, max: 64, pattern: /^[A-Za-z0-9._-]+$/ });
    requireSafeToken('LIVEKIT_API_SECRET', livekitApiSecret, { min: 32, max: 256 });
  }

  const publicIpEnv = readEnv(env, 'NODE_PUBLIC_IP', 'AGIL_NODE_PUBLIC_IP');
  const sfuNodeIpRaw = sfuExternalOrigin ? '' : readEnv(env, 'SFU_NODE_IP') || publicIpEnv;
  const useExternalIp = parseBoolSetting(sfuLocalEnv, 'SFU_USE_EXTERNAL_IP', '', sfuNodeIpRaw === '');
  // Only validate the advertised SFU address when the SFU actually runs: a
  // turn-only host may carry a leftover SFU_* value from a shared .env.
  const sfuNodeIp = sfuEnabled
    ? checkAdvertisedIpv4('SFU_NODE_IP', sfuNodeIpRaw, { allowPrivate: allowPrivateIp, required: false })
    : '';
  const sfuRedis = parseRedisUrl(readEnv(sfuLocalEnv, 'SFU_REDIS_URL'));
  const sfuRtmpIngressBaseUrl = readEnv(sfuLocalEnv, 'SFU_RTMP_INGRESS_BASE_URL');
  if (sfuRtmpIngressBaseUrl) {
    if (!sfuEnabled) throw new ConfigError('SFU_RTMP_INGRESS_BASE_URL requires the sfu feature');
    const url = URL.canParse(sfuRtmpIngressBaseUrl) ? new URL(sfuRtmpIngressBaseUrl) : null;
    if (!url?.hostname || !['rtmp:', 'rtmps:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new ConfigError('SFU_RTMP_INGRESS_BASE_URL must be an RTMP or RTMPS base URL without credentials, query or fragment');
    }
    if (!sfuRedis) throw new ConfigError('SFU_RTMP_INGRESS_BASE_URL requires SFU_REDIS_URL');
  }

  /* -------------------------------------------------------------- TURN ---- */
  const turnPort = parseIntSetting(env, 'TURN_PORT', '', 3478, { min: 1, max: 65535 });
  const turnMinPort = parseIntSetting(env, 'TURN_MIN_PORT', '', 49200, { min: 1024, max: 65535 });
  const turnMaxPort = parseIntSetting(env, 'TURN_MAX_PORT', '', 49250, { min: 1024, max: 65535 });
  if (turnMaxPort < turnMinPort) {
    throw new ConfigError(`TURN_MAX_PORT (${turnMaxPort}) must be >= TURN_MIN_PORT (${turnMinPort})`);
  }
  const turnRealm = readEnv(env, 'TURN_REALM') || 'agil.local';
  requireSafeToken('TURN_REALM', turnRealm, { min: 1, max: 128, pattern: /^[A-Za-z0-9._-]+$/ });
  const turnUser = readEnv(env, 'TURN_USER') || 'agil';
  requireSafeToken('TURN_USER', turnUser, { min: 1, max: 64, pattern: /^[A-Za-z0-9._~-]+$/ });
  const turnPassword = readEnv(env, 'TURN_PASSWORD');
  const turnStaticAuthSecret = readEnv(env, 'TURN_STATIC_AUTH_SECRET');
  const turnTls = parseBoolSetting(env, 'TURN_TLS', '', false);
  const turnAutoRegister = parseBoolSetting(env, 'TURN_AUTO_REGISTER', '', false);
  const turnTlsPort = parseIntSetting(env, 'TURN_TLS_PORT', '', 5349, { min: 1, max: 65535 });
  const turnTlsHostname = readEnv(env, 'TURN_TLS_HOSTNAME').toLowerCase();
  const turnCert = readEnv(env, 'TURN_CERT');
  const turnPkey = readEnv(env, 'TURN_PKEY');
  const turnTotalQuota = parseIntSetting(env, 'TURN_TOTAL_QUOTA', '', 100, { min: 0, max: 1_000_000 });
  const turnUserQuota = parseIntSetting(env, 'TURN_USER_QUOTA', '', 0, { min: 0, max: 1_000_000 });
  const turnListenIp = readEnv(env, 'TURN_LISTEN_IP');
  const turnInternalIp = readEnv(env, 'TURN_INTERNAL_IP');

  const stunOnly = !turnEnabled && stunEnabled;
  let turnExternalIp = '';
  let turnExternalIpSource = '';
  if (turnEnabled) {
    turnExternalIp = readEnv(env, 'TURN_EXTERNAL_IP') || publicIpEnv;
    turnExternalIpSource = turnExternalIp !== '' ? 'env' : '';
    if (turnExternalIp === '') {
      // Host networking exposes the host's NIC addresses, so this is usually the
      // right address. Behind 1:1 NAT it is private and the check below refuses it.
      turnExternalIp = options.hostIPv4 ?? detectHostIpv4();
      turnExternalIpSource = turnExternalIp !== '' ? 'host' : '';
    }
    turnExternalIp = checkAdvertisedIpv4('TURN_EXTERNAL_IP', turnExternalIp, {
      allowPrivate: allowPrivateIp,
      required: true,
    });
  }
  // STUN-only needs no relay address: a private/loopback TURN_EXTERNAL_IP (or a
  // leftover NODE_PUBLIC_IP from a shared .env) must not fail a STUN node.

  if (turnEnabled) {
    if (!turnPassword && !turnStaticAuthSecret) {
      throw new ConfigError('the turn feature needs TURN_PASSWORD or TURN_STATIC_AUTH_SECRET');
    }
    if (turnPassword && turnStaticAuthSecret) {
      throw new ConfigError('set only one of TURN_PASSWORD and TURN_STATIC_AUTH_SECRET');
    }
    const setting = turnStaticAuthSecret ? 'TURN_STATIC_AUTH_SECRET' : 'TURN_PASSWORD';
    requireSafeToken(setting, turnStaticAuthSecret || turnPassword, {
      min: 8,
      max: 256,
      // `#`/`:`/whitespace would change the meaning of the generated
      // `user=name:password` line in turnserver.conf.
      pattern: /^[^\s:#]+$/,
    });
  }
  if (turnTls) {
    if (!turnEnabled) {
      throw new ConfigError('TURN_TLS=1 requires the turn feature (TLS is only for TURN, not STUN-only mode)');
    }
    if (turnCert === '' || turnPkey === '') {
      throw new ConfigError('TURN_TLS=1 requires TURN_CERT and TURN_PKEY (PEM paths mounted into the container)');
    }
  }
  if (turnAutoRegister && (!turnEnabled || turnStaticAuthSecret.length < 32)) {
    throw new ConfigError('TURN_AUTO_REGISTER=1 requires the turn feature and at least 32 characters in TURN_STATIC_AUTH_SECRET');
  }
  if (turnTlsHostname && (!turnTls || turnTlsHostname.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(turnTlsHostname))) {
    throw new ConfigError('TURN_TLS_HOSTNAME requires TURN_TLS=1 and a fully qualified DNS name');
  }
  if (turnListenIp !== '') {
    if (ipv4IsValid(turnListenIp) === false) throw new ConfigError(`TURN_LISTEN_IP "${turnListenIp}" is not an IPv4 address`);
  }
  if (turnInternalIp !== '') {
    if (ipv4IsValid(turnInternalIp) === false) throw new ConfigError(`TURN_INTERNAL_IP "${turnInternalIp}" is not an IPv4 address`);
  }

  /* -------------------------------------------------- port/range sanity --- */
  const udpRange = (name, min, max) => ({ name, min, max });
  const ranges = [];
  const ports = [];
  if (sfuEnabled && !sfuExternalOrigin) {
    ports.push(['SFU_PORT', sfuPort], ['SFU_TCP_PORT', sfuTcpPort]);
    if (sfuUdpMuxPort > 0) ports.push(['SFU_UDP_MUX_PORT', sfuUdpMuxPort]);
    if (sfuMetricsPort > 0) ports.push(['SFU_METRICS_PORT', sfuMetricsPort]);
    // With the single-port mux enabled, LiveKit ignores the UDP range entirely,
    // so it must not be reserved or checked for overlaps.
    if (sfuUdpMuxPort === 0) ranges.push(udpRange('SFU UDP range', sfuUdpMinPort, sfuUdpMaxPort));
  }
  if (turnEnabled) {
    ports.push(['TURN_PORT', turnPort]);
    if (turnTls) ports.push(['TURN_TLS_PORT', turnTlsPort]);
    ranges.push(udpRange('TURN relay range', turnMinPort, turnMaxPort));
  } else if (stunOnly) {
    ports.push(['TURN_PORT (STUN)', turnPort]);
    if (turnTls) ports.push(['TURN_TLS_PORT', turnTlsPort]);
  }
  for (let i = 0; i < ports.length; i += 1) {
    for (let j = i + 1; j < ports.length; j += 1) {
      if (ports[i][1] === ports[j][1]) {
        throw new ConfigError(`${ports[i][0]} and ${ports[j][0]} both use port ${ports[i][1]}`);
      }
    }
  }
  for (const port of ports) {
    for (const range of ranges) {
      if (port[1] >= range.min && port[1] <= range.max) {
        throw new ConfigError(`${port[0]} (${port[1]}) falls inside the ${range.name} ${range.min}-${range.max}`);
      }
    }
  }
  for (let i = 0; i < ranges.length; i += 1) {
    for (let j = i + 1; j < ranges.length; j += 1) {
      const a = ranges[i];
      const b = ranges[j];
      if (a.min <= b.max && b.min <= a.max) {
        throw new ConfigError(
          `${a.name} ${a.min}-${a.max} overlaps ${b.name} ${b.min}-${b.max}; relay and SFU media need separate ranges`,
        );
      }
    }
  }

  const mediaEnabled = parseBoolSetting(env, 'NODE_MEDIA_ENABLED', 'AGIL_NODE_MEDIA_ENABLED', true);

  /* ------------------------------------------------------- modules ------ */
  const stateDir = readEnv(env, 'NODE_STATE_DIR', 'AGIL_NODE_STATE_DIR') || '/var/lib/agil-node';
  const moduleMode = readEnv(env, 'NODE_MODULES', 'AGIL_NODE_MODULES').toLowerCase() || 'auto';
  if (!['auto', 'on', 'off'].includes(moduleMode)) {
    throw new ConfigError(`NODE_MODULES must be auto|on|off, got "${moduleMode}"`);
  }
  // Docker Engine endpoint for the node's add-on modules. The standard
  // `DOCKER_HOST` is honoured as a fallback; `auto` (default) degrades to an
  // agent-only node when the socket is absent, `on` logs a loud warning.
  const dockerHost = readEnv(env, 'NODE_DOCKER_HOST', 'AGIL_NODE_DOCKER_HOST')
    || readEnv(env, 'DOCKER_HOST')
    || 'unix:///var/run/docker.sock';
  if (!/^(unix|npipe|tcp|http):\/\//.test(dockerHost) && !dockerHost.startsWith('/')) {
    throw new ConfigError(
      `NODE_DOCKER_HOST must be unix://, npipe://, tcp:// or an absolute socket path, got "${dockerHost}"`,
    );
  }

  return {
    version: NODE_IMAGE_VERSION,
    features,
    role,
    sfuEnabled,
    turnEnabled,
    stunEnabled,
    stunOnly,
    once: parseBoolSetting(env, 'NODE_ONCE', 'AGIL_NODE_ONCE', false),
    mediaEnabled,
    logLevel: logLevelRaw,
    core: {
      url: coreUrl,
      token: readEnv(env, 'AGIL_NODE_TOKEN'),
      nodeKey: readEnv(env, 'AGIL_NODE_KEY'),
      apiKey,
    },
    node: {
      id: nodeId,
      name: nodeName,
      region: nodeRegion,
      endpoint: nodeEndpoint,
      healthPath: nodeHealthPath,
      capacity: parseCapacity(readEnv(env, 'NODE_CAPACITY', 'AGIL_NODE_CAPACITY')),
      heartbeatSec,
      keyTtlSec: parseIntSetting(env, 'NODE_KEY_TTL_SEC', '', 0, { min: 0, max: 7_776_000 }),
      keyRotateBeforeSec,
      controlToken,
      stateDir,
    },
    modules: {
      mode: moduleMode,
      dockerHost,
      requestTimeoutMs: parseIntSetting(
        env,
        'NODE_DOCKER_TIMEOUT_MS',
        'AGIL_NODE_DOCKER_TIMEOUT_MS',
        15_000,
        { min: 1_000, max: 600_000 },
      ),
      pullTimeoutMs: parseIntSetting(
        env,
        'NODE_MODULE_PULL_TIMEOUT_MS',
        'AGIL_NODE_MODULE_PULL_TIMEOUT_MS',
        600_000,
        { min: 1_000, max: 3_600_000 },
      ),
      // Node-local module env (values never leave the node/logs) and the
      // persisted command-result state (0600 in the state volume).
      envFile: readEnv(env, 'NODE_MODULE_ENV_FILE', 'AGIL_NODE_MODULE_ENV_FILE')
        || path.join(stateDir, 'module-env.json'),
      templatesFile: readEnv(env, 'NODE_MODULE_TEMPLATES_FILE', 'AGIL_NODE_MODULE_TEMPLATES_FILE')
        || path.join(stateDir, 'module-templates.json'),
      stateFile: path.join(stateDir, 'module-commands.json'),
    },
    http: readHttpListener(env),
    runtimeDir: readEnv(env, 'NODE_RUNTIME_DIR', 'AGIL_NODE_RUNTIME_DIR') || '/run/agil',
    sfu: {
      enabled: sfuEnabled,
      externalOrigin: sfuExternalOrigin,
      port: sfuPort,
      tcpPort: sfuTcpPort,
      udpMinPort: sfuUdpMinPort,
      udpMaxPort: sfuUdpMaxPort,
      udpMuxPort: sfuUdpMuxPort,
      metricsPort: sfuMetricsPort,
      nodeIp: sfuNodeIp,
      useExternalIp,
      redis: sfuRedis,
      rtmpIngressBaseUrl: sfuRtmpIngressBaseUrl,
      logLevel: sfuLogLevel,
      apiKey: livekitApiKey,
      apiSecret: livekitApiSecret,
      bin: readEnv(sfuLocalEnv, 'NODE_LIVEKIT_BIN') || 'livekit-server',
      extraArgs: parseList(readEnv(sfuLocalEnv, 'NODE_LIVEKIT_ARGS')),
    },
    turn: {
      enabled: turnEnabled,
      stunOnly,
      port: turnPort,
      minPort: turnMinPort,
      maxPort: turnMaxPort,
      realm: turnRealm,
      user: turnUser,
      password: turnPassword,
      staticAuthSecret: turnStaticAuthSecret,
      autoRegister: turnAutoRegister,
      externalIp: turnExternalIp,
      externalIpSource: turnExternalIpSource,
      internalIp: turnInternalIp,
      listenIp: turnListenIp,
      allowPrivateIp,
      totalQuota: turnTotalQuota,
      userQuota: turnUserQuota,
      tls: turnTls,
      tlsPort: turnTlsPort,
      tlsHostname: turnTlsHostname,
      cert: turnCert,
      pkey: turnPkey,
      bin: readEnv(env, 'NODE_TURN_BIN') || 'turnserver',
      extraArgs: parseList(readEnv(env, 'NODE_TURN_ARGS')),
    },
  };
}

/**
 * Safe-for-logs projection: never contains the enrollment token, node key,
 * admin key, TURN password or LiveKit secret.
 */
export function configSummary(config) {
  return {
    version: config.version,
    role: config.role,
    features: config.features,
    mediaEnabled: config.mediaEnabled,
    once: config.once,
    coreUrl: redactUrl(config.core.url),
    nodeId: config.node.id,
    region: config.node.region || null,
    heartbeatSec: config.node.heartbeatSec,
    stateDir: config.node.stateDir,
    http: `${config.http.host}:${config.http.port}`,
    modules: {
      mode: config.modules.mode,
      dockerHost: config.modules.dockerHost,
    },
    sfu: config.sfu.externalOrigin ? { mode: 'external' } : config.sfu.enabled
      ? {
          port: config.sfu.port,
          tcpPort: config.sfu.tcpPort,
          udpRange: `${config.sfu.udpMinPort}-${config.sfu.udpMaxPort}`,
          udpMuxPort: config.sfu.udpMuxPort || null,
          nodeIp: config.sfu.nodeIp || null,
          useExternalIp: config.sfu.useExternalIp,
          redis: config.sfu.redis ? 'configured' : null,
        }
      : null,
    turn: config.turn.enabled || config.stunOnly
      ? {
          mode: config.turn.enabled ? 'turn' : 'stun-only',
          port: config.turn.port,
          relayRange: config.turn.enabled ? `${config.turn.minPort}-${config.turn.maxPort}` : null,
          externalIp: config.turn.externalIp || null,
          externalIpSource: config.turn.externalIpSource || null,
          tls: config.turn.tls ? config.turn.tlsPort : null,
          allowPrivateIp: config.turn.allowPrivateIp,
        }
      : null,
  };
}
