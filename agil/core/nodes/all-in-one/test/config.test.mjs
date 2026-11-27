import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ConfigError,
  classifyIpv4,
  configSummary,
  ipv4IsValid,
  loadConfig,
  parseFeatures,
  parseList,
  redactUrl,
} from '../agent/config.mjs';

const SECRET = 's'.repeat(32);
const TURN_PASSWORD = 'turn-password-123';

function baseEnv(overrides = {}) {
  return {
    NODE_FEATURES: 'sfu',
    NODE_ID: 'test-node',
    LIVEKIT_API_KEY: 'agil_sfu',
    LIVEKIT_API_SECRET: SECRET,
    ...overrides,
  };
}

function turnEnv(overrides = {}) {
  return baseEnv({
    NODE_FEATURES: 'turn',
    TURN_EXTERNAL_IP: '203.0.113.10',
    TURN_PASSWORD,
    ...overrides,
  });
}

test('defaults: SFU only, canonical ports, media enabled', () => {
  const config = loadConfig(baseEnv());
  assert.deepEqual(config.features, ['sfu']);
  assert.equal(config.role, 'sfu');
  assert.equal(config.sfuEnabled, true);
  assert.equal(config.turnEnabled, false);
  assert.equal(config.stunOnly, false);
  assert.equal(config.mediaEnabled, true);
  assert.equal(config.once, false);
  assert.equal(config.http.port, 8080);
  assert.equal(config.node.stateDir, '/var/lib/agil-node');
  assert.equal(config.node.name, 'test-node');
  assert.equal(config.node.healthPath, '/healthz');
  assert.equal(config.sfu.port, 7880);
  assert.equal(config.sfu.tcpPort, 7881);
  assert.equal(config.sfu.udpMinPort, 50000);
  assert.equal(config.sfu.udpMaxPort, 50100);
  assert.equal(config.sfu.useExternalIp, true);
  assert.deepEqual(config.node.capacity, { maxRooms: 0, maxParticipants: 0, bandwidthMbps: 0 });
});

test('AGIL_NODE_* aliases and NODE_CORE_URL are accepted', () => {
  const config = loadConfig({
    AGIL_NODE_FEATURES: 'turn',
    AGIL_NODE_ID: 'alias-node',
    AGIL_NODE_STATE_DIR: '/tmp/state',
    AGIL_NODE_HEARTBEAT_SEC: '45',
    AGIL_NODE_MEDIA_ENABLED: 'false',
    AGIL_NODE_RUNTIME_DIR: '/run/alias',
    NODE_CORE_URL: 'https://core.example.test/',
    TURN_EXTERNAL_IP: '203.0.113.10',
    TURN_PASSWORD,
  });
  assert.deepEqual(config.features, ['turn']);
  assert.equal(config.node.id, 'alias-node');
  assert.equal(config.node.stateDir, '/tmp/state');
  assert.equal(config.node.heartbeatSec, 45);
  assert.equal(config.mediaEnabled, false);
  assert.equal(config.runtimeDir, '/run/alias');
  assert.equal(config.core.url, 'https://core.example.test');
});

test('AGIL_NODE_PUBLIC_IP is accepted as the advertised address', () => {
  const config = loadConfig(baseEnv({ AGIL_NODE_PUBLIC_IP: '203.0.113.10' }));
  assert.equal(config.sfu.nodeIp, '203.0.113.10');
  assert.equal(config.sfu.useExternalIp, false);
});

test('feature toggles: stun-only needs no password; all-in-one starts one coturn plan', () => {
  const stun = loadConfig(baseEnv({ NODE_FEATURES: 'stun' }));
  assert.equal(stun.role, 'stun');
  assert.equal(stun.turnEnabled, false);
  assert.equal(stun.stunEnabled, true);
  assert.equal(stun.stunOnly, true);
  assert.equal(stun.turn.password, '');
  assert.equal(stun.turn.externalIp, '');

  // STUN-only ignores an advertised relay address entirely: a private
  // NODE_PUBLIC_IP from a shared .env must not fail a STUN node.
  const stunLan = loadConfig(baseEnv({ NODE_FEATURES: 'stun', NODE_PUBLIC_IP: '192.168.1.5' }));
  assert.equal(stunLan.stunOnly, true);
  assert.equal(stunLan.turn.externalIp, '');

  const all = loadConfig(baseEnv({
    NODE_FEATURES: 'sfu,turn,stun',
    TURN_EXTERNAL_IP: '203.0.113.10',
    TURN_PASSWORD,
  }));
  assert.equal(all.role, 'all');
  assert.deepEqual(all.features, ['sfu', 'turn', 'stun']);
  assert.equal(all.turnEnabled, true);
  assert.equal(all.stunOnly, false, 'turn already answers STUN; no second coturn');
});

test('turn: missing password, private/loopback/unspecified advertised IP', () => {
  assert.throws(
    () => loadConfig(baseEnv({ NODE_FEATURES: 'turn', TURN_EXTERNAL_IP: '203.0.113.10' })),
    /TURN_PASSWORD/,
  );
  assert.throws(
    () => loadConfig(turnEnv({ TURN_EXTERNAL_IP: '10.1.2.3' })),
    /private \(RFC1918\/CGNAT\)/,
  );
  assert.throws(
    () => loadConfig(turnEnv({ TURN_EXTERNAL_IP: '127.0.0.1' })),
    /loopback/,
  );
  assert.throws(
    () => loadConfig(turnEnv({ TURN_EXTERNAL_IP: '0.0.0.0' })),
    /0\.0\.0\.0/,
  );
  assert.throws(
    () => loadConfig(turnEnv({ TURN_EXTERNAL_IP: '300.1.2.3' })),
    /dotted-quad IPv4/,
  );
  const lan = loadConfig(turnEnv({
    TURN_EXTERNAL_IP: '10.1.2.3',
    TURN_ALLOW_PRIVATE_IP: '1',
  }));
  assert.equal(lan.turn.externalIp, '10.1.2.3');
  assert.equal(lan.turn.allowPrivateIp, true);
});

test('turn: temporary credentials require a single safe signing key', () => {
  const staticAuthSecret = 'test_turn_signing_key_1234';
  const config = loadConfig(turnEnv({ TURN_PASSWORD: '', TURN_STATIC_AUTH_SECRET: staticAuthSecret }));
  assert.equal(config.turn.staticAuthSecret, staticAuthSecret);
  assert.ok(!JSON.stringify(configSummary(config)).includes(staticAuthSecret));
  assert.throws(() => loadConfig(turnEnv({ TURN_STATIC_AUTH_SECRET: staticAuthSecret })),
    /set only one of TURN_PASSWORD and TURN_STATIC_AUTH_SECRET/);
  assert.throws(() => loadConfig(turnEnv({ TURN_PASSWORD: '', TURN_STATIC_AUTH_SECRET: 'secret\nno-auth' })),
    /TURN_STATIC_AUTH_SECRET/);
  assert.throws(() => loadConfig(turnEnv({ TURN_AUTO_REGISTER: '1', TURN_PASSWORD: '', TURN_STATIC_AUTH_SECRET: staticAuthSecret })),
    /at least 32 characters/);
  assert.equal(loadConfig(turnEnv({ TURN_AUTO_REGISTER: '1', TURN_PASSWORD: '', TURN_STATIC_AUTH_SECRET: staticAuthSecret.repeat(2) })).turn.autoRegister, true);
});

test('turn: auto-detected private host IP is refused unless explicitly allowed', () => {
  assert.throws(
    () => loadConfig(baseEnv({ NODE_FEATURES: 'turn', TURN_PASSWORD }), { hostIPv4: '10.9.8.7' }),
    /private \(RFC1918\/CGNAT\)/,
  );
  const auto = loadConfig(
    baseEnv({ NODE_FEATURES: 'turn', TURN_PASSWORD, TURN_ALLOW_PRIVATE_IP: 'true' }),
    { hostIPv4: '10.9.8.7' },
  );
  assert.equal(auto.turn.externalIp, '10.9.8.7');
  assert.equal(auto.turn.externalIpSource, 'host');
});

test('turn: TLS requires both certificate paths and turn feature', () => {
  assert.throws(
    () => loadConfig(turnEnv({ TURN_TLS: '1' })),
    /TURN_CERT and TURN_PKEY/,
  );
  assert.throws(
    () => loadConfig(baseEnv({ NODE_FEATURES: 'stun', TURN_TLS: '1' })),
    /requires the turn feature/,
  );
  const tls = loadConfig(turnEnv({
    TURN_TLS: 'true',
    TURN_CERT: '/certs/fullchain.pem',
    TURN_PKEY: '/certs/privkey.pem',
    TURN_TLS_PORT: '443',
    TURN_TLS_HOSTNAME: 'Turn.QA.Example',
  }));
  assert.equal(tls.turn.tls, true);
  assert.equal(tls.turn.tlsPort, 443);
  assert.equal(tls.turn.tlsHostname, 'turn.qa.example');
  assert.throws(() => loadConfig(turnEnv({ TURN_TLS_HOSTNAME: 'turn.qa.example' })), /TURN_TLS_HOSTNAME/);
  assert.throws(() => loadConfig(turnEnv({
    TURN_TLS: '1', TURN_CERT: '/certs/cert.pem', TURN_PKEY: '/certs/key.pem', TURN_TLS_HOSTNAME: '192.0.2.31',
  })), /TURN_TLS_HOSTNAME/);
});

test('sfu: requires an API key pair, validates secret length and node_ip', () => {
  assert.throws(() => loadConfig(baseEnv({ LIVEKIT_API_KEY: '' })), /LIVEKIT_API_KEY and LIVEKIT_API_SECRET/);
  assert.throws(() => loadConfig(baseEnv({ LIVEKIT_API_SECRET: 'short' })), /LIVEKIT_API_SECRET must be/);
  assert.throws(() => loadConfig(baseEnv({ SFU_NODE_IP: '10.0.0.5' })), /SFU_NODE_IP.*private/);
  const explicit = loadConfig(baseEnv({ SFU_NODE_IP: '203.0.113.10' }));
  assert.equal(explicit.sfu.nodeIp, '203.0.113.10');
  assert.equal(explicit.sfu.useExternalIp, false);
  const turnOnly = loadConfig(turnEnv());
  assert.equal(turnOnly.sfu.nodeIp, '', 'a turn-only host ignores leftover SFU_* values');
});

test('sfu: only a credential-free external HTTP origin can opt into readiness', () => {
  const config = loadConfig(baseEnv({
    SFU_EXTERNAL_URL: 'https://livekit.internal:7443/',
    SFU_PORT: 'ignored',
    SFU_NODE_IP: '10.0.0.5',
    SFU_REDIS_URL: 'ignored',
    NODE_MEDIA_ENABLED: 'false',
  }));
  assert.equal(config.sfu.enabled, true);
  assert.equal(config.sfu.externalOrigin, 'https://livekit.internal:7443');
  assert.equal(config.mediaEnabled, false);
  assert.deepEqual(configSummary(config).sfu, { mode: 'external' });
  for (const origin of ['ws://livekit.internal', 'https://user:key@livekit.internal',
    'https://livekit.internal/path', 'https://livekit.internal/?token=abc', 'https://livekit.internal/#x']) {
    assert.throws(() => loadConfig(baseEnv({ SFU_EXTERNAL_URL: origin })), /SFU_EXTERNAL_URL must be/);
  }
  assert.throws(() => loadConfig(turnEnv({ SFU_EXTERNAL_URL: 'http://livekit.internal' })), /requires the sfu feature/);
  assert.throws(() => loadConfig(baseEnv({ SFU_EXTERNAL_URL: 'http://livekit.internal', LIVEKIT_API_KEY: '' })),
    /needs LIVEKIT_API_KEY/);
});

test('features: unknown tokens and contradicting NODE_ROLE fail fast', () => {
  assert.throws(() => loadConfig(baseEnv({ NODE_FEATURES: 'sfu,tun' })), /unknown feature\(s\): tun/);
  assert.throws(
    () => loadConfig(baseEnv({ NODE_FEATURES: 'sfu,turn', NODE_ROLE: 'sfu', TURN_PASSWORD, TURN_EXTERNAL_IP: '203.0.113.10' })),
    /NODE_ROLE=sfu contradicts/,
  );
  const all = loadConfig(baseEnv({ NODE_FEATURES: 'sfu', NODE_ROLE: 'all' }));
  assert.equal(all.role, 'all');
});

test('port and relay-range collisions are rejected', () => {
  const all = (overrides) => loadConfig(baseEnv({
    NODE_FEATURES: 'sfu,turn',
    TURN_EXTERNAL_IP: '203.0.113.10',
    TURN_PASSWORD,
    ...overrides,
  }));
  assert.throws(() => all({ TURN_PORT: '7881' }), /SFU_TCP_PORT and TURN_PORT both use port 7881/);
  assert.throws(() => all({ TURN_PORT: '7880' }), /SFU_PORT and TURN_PORT both use port 7880/);
  assert.throws(
    () => all({ TURN_MIN_PORT: '50050', TURN_MAX_PORT: '50060' }),
    /SFU UDP range 50000-50100 overlaps TURN relay range 50050-50060/,
  );
  assert.throws(() => all({ SFU_METRICS_PORT: '3478' }), /SFU_METRICS_PORT and TURN_PORT both use port 3478/);
  assert.throws(
    () => loadConfig(baseEnv({ SFU_UDP_MIN_PORT: '50100', SFU_UDP_MAX_PORT: '50000' })),
    /SFU_UDP_MAX_PORT.*must be >=/,
  );
  // The single-port mux replaces the range; a mux port inside the (unused)
  // range is therefore not a conflict.
  const mux = loadConfig(baseEnv({ SFU_UDP_MUX_PORT: '50050' }));
  assert.equal(mux.sfu.udpMuxPort, 50050);
});

test('rotation, heartbeat and control settings are bounded', () => {
  assert.throws(
    () => loadConfig(baseEnv({ NODE_KEY_ROTATE_BEFORE_SEC: '600' })),
    /requires AGIL_API_KEY/,
  );
  const rotate = loadConfig(baseEnv({ NODE_KEY_ROTATE_BEFORE_SEC: '600', AGIL_API_KEY: 'admin-key' }));
  assert.equal(rotate.node.keyRotateBeforeSec, 600);
  assert.throws(() => loadConfig(baseEnv({ NODE_HEARTBEAT_SEC: '4' })), /NODE_HEARTBEAT_SEC must be an integer/);
  assert.throws(() => loadConfig(baseEnv({ NODE_HEARTBEAT_SEC: '3601' })), /NODE_HEARTBEAT_SEC must be an integer/);
  assert.throws(() => loadConfig(baseEnv({ NODE_CONTROL_TOKEN: 'short' })), /NODE_CONTROL_TOKEN must be 8\.\.256/);
  assert.throws(() => loadConfig(baseEnv({ NODE_KEY_TTL_SEC: '7776001' })), /NODE_KEY_TTL_SEC/);
});

test('registration metadata is validated before the token is burned', () => {
  assert.throws(
    () => loadConfig(baseEnv({ NODE_ENDPOINT: 'https://user:pass@sfu.example.net:7880' })),
    /must not contain credentials/,
  );
  assert.throws(
    () => loadConfig(baseEnv({ NODE_ENDPOINT: 'http://169.254.169.254/latest/meta-data' })),
    /cloud metadata/,
  );
  assert.throws(
    () => loadConfig(baseEnv({ NODE_ENDPOINT: 'not a url' })),
    /http\(s\)\/ws\(s\) URL/,
  );
  assert.throws(() => loadConfig(baseEnv({ NODE_HEALTH_PATH: 'healthz' })), /must start with/);
  assert.throws(() => loadConfig(baseEnv({ NODE_NAME: 'x'.repeat(81) })), /NODE_NAME must be 1\.\.80/);
  assert.throws(() => loadConfig(baseEnv({ NODE_REGION: 'r'.repeat(65) })), /NODE_REGION must be 1\.\.64/);
  const valid = loadConfig(baseEnv({
    NODE_ENDPOINT: 'https://sfu-1.example.net:7880',
    NODE_HEALTH_PATH: '/custom-health',
    NODE_NAME: 'SFU one',
    NODE_REGION: 'ru-msk',
  }));
  assert.equal(valid.node.endpoint, 'https://sfu-1.example.net:7880');
  assert.equal(valid.node.healthPath, '/custom-health');
  assert.equal(valid.node.name, 'SFU one');
  assert.equal(valid.node.region, 'ru-msk');
});

test('AGIL_CORE_URL rejects URL userinfo and redacts it in every projection', () => {
  // fetch() refuses a URL with credentials, so accepting one only produced an
  // endless enrollment retry whose logs contained the password.
  assert.throws(
    () => loadConfig(baseEnv({ AGIL_CORE_URL: 'https://user:secret@core.example.test' })),
    /AGIL_CORE_URL must not contain credentials/,
  );
  assert.throws(
    () => loadConfig(baseEnv({ NODE_CORE_URL: 'http://user:secret@core.example.test:8787' })),
    /must not contain credentials/,
  );

  assert.equal(redactUrl('https://core.example.test:8787/base'), 'https://core.example.test:8787/base');
  assert.equal(redactUrl('https://user:secret@core.example.test:8787/base?x=1'), 'https://core.example.test:8787/base?x=1');
  assert.equal(redactUrl(''), '');
  assert.equal(redactUrl('not-a-url'), 'not-a-url');

  // A malformed URL must not echo its userinfo in the ConfigError either.
  assert.throws(
    () => loadConfig(baseEnv({ AGIL_CORE_URL: 'https://user:topsecret@ core.example.test' })),
    (error) => {
      assert.match(error.message, /is not a valid URL/);
      assert.ok(!error.message.includes('topsecret'), error.message);
      return true;
    },
  );

  // Defence in depth: a config assembled without loadConfig (test double, old
  // caller) is still redacted by configSummary.
  const strict = loadConfig(baseEnv());
  const bypassed = { ...strict, core: { ...strict.core, url: 'https://user:topsecret@core.example.test' } };
  assert.ok(!JSON.stringify(configSummary(bypassed)).includes('topsecret'));
});

test('capacity JSON is bounded and invalid values are rejected', () => {
  const capacity = loadConfig(baseEnv({
    NODE_CAPACITY: '{"maxRooms":10,"maxParticipants":500,"bandwidthMbps":1000}',
  })).node.capacity;
  assert.deepEqual(capacity, { maxRooms: 10, maxParticipants: 500, bandwidthMbps: 1000 });

  assert.throws(() => loadConfig(baseEnv({ NODE_CAPACITY: '{bad json' })), /valid JSON/);
  assert.throws(() => loadConfig(baseEnv({ NODE_CAPACITY: '[]' })), /JSON object/);
  assert.throws(() => loadConfig(baseEnv({ NODE_CAPACITY: '{"maxRooms":-1}' })), /maxRooms/);
  assert.throws(() => loadConfig(baseEnv({ NODE_CAPACITY: '{"maxParticipants":10000001}' })), /maxParticipants/);
  assert.throws(() => loadConfig(baseEnv({ NODE_CAPACITY: '{"maxRooms":1.5}' })), /maxRooms/);
  assert.throws(() => loadConfig(baseEnv({ NODE_CAPACITY: '{"maxRooms":"ten"}' })), /maxRooms/);
});

test('NODE_ID and log level are validated', () => {
  assert.throws(() => loadConfig(baseEnv({ NODE_ID: '-node' })), /NODE_ID/);
  assert.throws(() => loadConfig(baseEnv({ NODE_ID: 'a'.repeat(65) })), /NODE_ID/);
  assert.throws(() => loadConfig(baseEnv({ NODE_LOG_LEVEL: 'trace' })), /NODE_LOG_LEVEL/);
});

test('SFU_REDIS_URL accepts URL and host:port forms, rejects junk', () => {
  assert.deepEqual(
    loadConfig(baseEnv({ SFU_REDIS_URL: 'redis://:p%40ss@redis:6380/2' })).sfu.redis,
    { address: 'redis:6380', username: '', password: 'p@ss', db: 2, useTls: false },
  );
  assert.deepEqual(loadConfig(baseEnv({ SFU_REDIS_URL: 'redis:6379' })).sfu.redis, { address: 'redis:6379' });
  assert.throws(() => loadConfig(baseEnv({ SFU_REDIS_URL: 'http://redis:6379' })), /SFU_REDIS_URL/);
  assert.throws(() => loadConfig(baseEnv({ SFU_REDIS_URL: 'redis://' })), /SFU_REDIS_URL/);
  for (const url of [
    'redis://:qa-private-password@cache:6379/invalid-db',
    'http://:qa-private-password@cache:6379',
    'redis://:qa-private-password%XX@cache:6379',
    'cache:65536',
    'redis://cache:0',
  ]) {
    assert.throws(() => loadConfig(baseEnv({ SFU_REDIS_URL: url })), (error) =>
      error instanceof ConfigError && error.message.includes('SFU_REDIS_URL') && !error.message.includes('qa-private-password'));
  }
});

test('the RTMP ingress base URL requires Redis and excludes stream credentials', () => {
  const env = { SFU_RTMP_INGRESS_BASE_URL: 'rtmp://127.0.0.1:1935/live' };
  assert.throws(() => loadConfig(turnEnv(env)), /requires the sfu feature/);
  assert.throws(() => loadConfig(baseEnv(env)), /requires SFU_REDIS_URL/);
  assert.equal(loadConfig(baseEnv({ ...env, SFU_REDIS_URL: '127.0.0.1:6380' })).sfu.rtmpIngressBaseUrl,
    env.SFU_RTMP_INGRESS_BASE_URL);
  for (const value of ['https://publish.test/live', 'rtmp:publish.test', 'rtmp://publish.test:99999/live',
    'rtmp://publish.test/live?key=secret', 'rtmps://operator:secret@publish.test/live']) {
    assert.throws(() => loadConfig(baseEnv({ SFU_REDIS_URL: '127.0.0.1:6380', SFU_RTMP_INGRESS_BASE_URL: value })), (error) =>
      error instanceof ConfigError && error.message.includes('SFU_RTMP_INGRESS_BASE_URL') && !error.message.includes('secret'));
  }
});

test('configSummary never contains credentials', () => {  const config = loadConfig(turnEnv({
    AGIL_CORE_URL: 'https://core.example.test',
    AGIL_NODE_TOKEN: 'agil_enr_unique_token_1234567890',
    AGIL_NODE_KEY: 'nk_unique_node_key_1234567890',
    AGIL_API_KEY: 'admin_unique_key_1234567890',
    NODE_CONTROL_TOKEN: 'control_unique_token',
    TURN_PASSWORD: 'turn_unique_password_123',
    LIVEKIT_API_SECRET: 'livekit_unique_secret_0123456789abcdef',
  }));
  const summary = JSON.stringify(configSummary(config));
  for (const secret of [
    'agil_enr_unique_token_1234567890',
    'nk_unique_node_key_1234567890',
    'admin_unique_key_1234567890',
    'control_unique_token',
    'turn_unique_password_123',
    'livekit_unique_secret_0123456789abcdef',
  ]) {
    assert.ok(!summary.includes(secret), `configSummary leaked ${secret}`);
  }
  // Non-secret values are useful for operations and remain visible.
  assert.match(summary, /203\.0\.113\.10/);
  assert.match(summary, /core\.example\.test/);
});

test('parseFeatures/parseList canonicalise and de-duplicate', () => {
  assert.deepEqual(parseFeatures('SFU, turn  stun,sfu'), ['sfu', 'turn', 'stun']);
  assert.deepEqual(parseFeatures(''), ['sfu']);
  assert.deepEqual(parseList('a, b  c'), ['a', 'b', 'c']);
  assert.deepEqual(parseList(['a', ' b ']), ['a', 'b']);
  assert.throws(() => parseFeatures('sfu,egress'), ConfigError);
});

test('classifyIpv4 matches the quickstart network rules', () => {
  assert.equal(ipv4IsValid('203.0.113.10'), true);
  assert.equal(ipv4IsValid('203.0.113.010'), false, 'leading zero');
  assert.equal(ipv4IsValid('203.0.113.256'), false);
  assert.equal(ipv4IsValid('1.2.3'), false);
  assert.equal(classifyIpv4('203.0.113.10'), 'public');
  assert.equal(classifyIpv4('10.0.0.1'), 'private');
  assert.equal(classifyIpv4('172.16.0.1'), 'private');
  assert.equal(classifyIpv4('172.32.0.1'), 'public');
  assert.equal(classifyIpv4('192.168.1.1'), 'private');
  assert.equal(classifyIpv4('100.64.0.1'), 'private');
  assert.equal(classifyIpv4('169.254.1.1'), 'private');
  assert.equal(classifyIpv4('127.0.0.1'), 'loopback');
  assert.equal(classifyIpv4('0.0.0.0'), 'unspecified');
  assert.equal(classifyIpv4('nope'), 'invalid');
});
