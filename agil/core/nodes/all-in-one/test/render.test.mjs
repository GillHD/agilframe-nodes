import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { ConfigError, loadConfig, parseRedisUrl } from '../agent/config.mjs';
import {
  mediaPlan,
  renderLiveKitConfig,
  renderLiveKitKeys,
  renderTurnConfig,
  turnConfigPath,
} from '../agent/render.mjs';

const SECRET = 's'.repeat(32);
const TURN_PASSWORD = 'turn-password-123';

function sfuConfig(overrides = {}) {
  return loadConfig({
    NODE_FEATURES: 'sfu',
    NODE_ID: 'render-node',
    LIVEKIT_API_KEY: 'agil_sfu',
    LIVEKIT_API_SECRET: SECRET,
    ...overrides,
  });
}

function turnConfig(overrides = {}) {
  return loadConfig({
    NODE_FEATURES: 'turn',
    NODE_ID: 'turn-node',
    TURN_EXTERNAL_IP: '203.0.113.10',
    TURN_PASSWORD,
    ...overrides,
  });
}

test('LiveKit YAML: ports, node_ip and use_external_ip semantics', () => {
  const explicit = renderLiveKitConfig(sfuConfig({ SFU_NODE_IP: '203.0.113.10' }));
  assert.match(explicit, /^port: 7880$/m);
  assert.match(explicit, /^  tcp_port: 7881$/m);
  assert.match(explicit, /^  port_range_start: 50000$/m);
  assert.match(explicit, /^  port_range_end: 50100$/m);
  assert.match(explicit, /^  node_ip: "203\.0\.113\.10"$/m);
  assert.match(explicit, /^  use_external_ip: false$/m);
  assert.match(explicit, /^  json: true$/m);

  const stunDiscovered = renderLiveKitConfig(sfuConfig());
  assert.match(stunDiscovered, /^  use_external_ip: true$/m);
  assert.ok(!stunDiscovered.includes('node_ip'), 'no node_ip when STUN discovery is used');

  const disabled = sfuConfig({ SFU_METRICS_PORT: '0', SFU_UDP_MUX_PORT: '7882' });
  const yaml = renderLiveKitConfig(disabled);
  assert.match(yaml, /^  udp_port: 7882$/m);
  assert.ok(!yaml.includes('port_range_start'), 'LiveKit ignores udp_port when a range is present');
  assert.ok(!yaml.includes('port_range_end'), 'LiveKit ignores udp_port when a range is present');
  assert.ok(!yaml.includes('prometheus:'), 'metrics listener disabled with port 0');
});

test('LiveKit YAML uses only strict-config fields (no prometheus bind_addresses)', () => {
  const yaml = renderLiveKitConfig(sfuConfig());
  assert.ok(!yaml.includes('bind_addresses'), 'LiveKit strict config rejects prometheus.bind_addresses');
  assert.match(yaml, /^prometheus:\n  port: 6789$/m);
});

test('LiveKit YAML renders Redis URL forms and TLS', () => {
  const withRedis = renderLiveKitConfig(sfuConfig({
    SFU_REDIS_URL: 'redis://user:pass@redis.internal:6380/3',
  }));
  assert.match(withRedis, /^redis:$/m);
  assert.match(withRedis, /^  address: "redis\.internal:6380"$/m);
  assert.match(withRedis, /^  username: "user"$/m);
  assert.match(withRedis, /^  password: "pass"$/m);
  assert.match(withRedis, /^  db: 3$/m);
  assert.ok(!withRedis.includes('use_tls'));

  const withTls = renderLiveKitConfig(sfuConfig({ SFU_REDIS_URL: 'rediss://redis.internal' }));
  assert.match(withTls, /^  use_tls: true$/m);
  assert.match(withTls, /^  address: "redis\.internal:6379"$/m);
});

test('LiveKit YAML advertises the RTMP ingress URL only when configured', () => {
  assert.doesNotMatch(renderLiveKitConfig(sfuConfig()), /^ingress:/m);
  const configured = renderLiveKitConfig(sfuConfig({
    SFU_REDIS_URL: 'redis.internal:6380',
    SFU_RTMP_INGRESS_BASE_URL: 'rtmps://publish.example.test:21935/live',
  }));
  assert.match(configured, /^ingress:\n  rtmp_base_url: "rtmps:\/\/publish\.example\.test:21935\/live"$/m);
});

test('parseRedisUrl: bare host:port, credentials, DB and invalid schemes', () => {
  assert.deepEqual(parseRedisUrl('localhost:6379'), { address: 'localhost:6379' });
  assert.deepEqual(parseRedisUrl('[::1]:6379'), { address: '[::1]:6379' });
  assert.deepEqual(parseRedisUrl('redis://:secret@cache:6380/2'), {
    address: 'cache:6380',
    username: '',
    password: 'secret',
    db: 2,
    useTls: false,
  });
  assert.deepEqual(parseRedisUrl('rediss://cache'), {
    address: 'cache:6379',
    username: '',
    password: '',
    db: undefined,
    useTls: true,
  });
  assert.equal(parseRedisUrl(''), null);
  assert.throws(() => parseRedisUrl('http://cache:6379'), ConfigError);
  assert.throws(() => parseRedisUrl('not a redis address'), ConfigError);
  assert.throws(() => parseRedisUrl('redis://'), ConfigError);
  assert.throws(() => parseRedisUrl('redis://cache:6379/not-a-db'), ConfigError);
});

test('LiveKit keys stay out of the YAML body', () => {
  const config = sfuConfig();
  const yaml = renderLiveKitConfig(config);
  const keys = renderLiveKitKeys(config);
  assert.equal(keys, `agil_sfu: ${SECRET}`);
  assert.ok(!yaml.includes(SECRET), 'the API secret must reach LiveKit via LIVEKIT_KEYS, not the config file');
});

test('coturn config: TURN mode, credentials, relay range and hardening', () => {
  const config = turnConfig({ TURN_INTERNAL_IP: '10.0.0.5', TURN_REALM: 'calls.example.net' });
  const rendered = renderTurnConfig(config);
  assert.match(rendered, /^log-file=stdout$/m);
  assert.match(rendered, /^no-cli$/m);
  assert.match(rendered, /^no-multicast-peers$/m);
  assert.match(rendered, /^denied-peer-ip=127\.0\.0\.0-127\.255\.255\.255$/m);
  assert.match(rendered, /^denied-peer-ip=::1$/m);
  assert.match(rendered, /^pidfile=\/run\/agil\/turnserver\.pid$/m);
  assert.match(rendered, /^userdb=\/run\/agil\/turn-userdb\.sqlite$/m);
  assert.match(rendered, /^listening-port=3478$/m);
  assert.match(rendered, /^lt-cred-mech$/m);
  assert.match(rendered, /^realm=calls\.example\.net$/m);
  assert.match(rendered, new RegExp(`^user=agil:${TURN_PASSWORD}$`, 'm'));
  assert.match(rendered, /^min-port=49200$/m);
  assert.match(rendered, /^max-port=49250$/m);
  assert.match(rendered, /^external-ip=203\.0\.113\.10\/10\.0\.0\.5$/m);
  assert.match(rendered, /^no-tls$/m);
  assert.match(rendered, /^no-dtls$/m);
  assert.ok(!rendered.includes('stun-only'));
});

test('coturn config: STUN-only mode has no credential or relay ports', () => {
  const config = loadConfig({ NODE_FEATURES: 'stun', NODE_ID: 'stun-node' });
  const rendered = renderTurnConfig(config);
  assert.match(rendered, /^stun-only$/m);
  assert.match(rendered, /^no-auth$/m);
  assert.ok(!rendered.includes('lt-cred-mech'));
  assert.ok(!rendered.includes('user='));
  assert.ok(!rendered.includes('min-port='));
  assert.ok(!rendered.includes('external-ip='));
  assert.match(rendered, /^listening-port=3478$/m);
});

test('coturn config: temporary credentials use secret-based authentication only', () => {
  const rendered = renderTurnConfig(turnConfig({ TURN_PASSWORD: '', TURN_STATIC_AUTH_SECRET: 'qa_turn_signing_key' }));
  assert.match(rendered, /^use-auth-secret$/m);
  assert.match(rendered, /^static-auth-secret=qa_turn_signing_key$/m);
  assert.doesNotMatch(rendered, /^(?:lt-cred-mech$|user=)/m);
});

test('coturn config: TURN/TLS listens on 5349 with the mounted pair', () => {
  const config = turnConfig({
    TURN_TLS: '1',
    TURN_TLS_PORT: '443',
    TURN_CERT: '/certs/fullchain.pem',
    TURN_PKEY: '/certs/privkey.pem',
  });
  const rendered = renderTurnConfig(config);
  assert.match(rendered, /^tls-listening-port=443$/m);
  assert.match(rendered, /^cert=\/certs\/fullchain\.pem$/m);
  assert.match(rendered, /^pkey=\/certs\/privkey\.pem$/m);
  assert.match(rendered, /^no-tlsv1$/m);
  assert.equal(mediaPlan(config)[0].probe.tlsPort, 443);
  assert.ok(!rendered.includes('no-tls\n'));
});

test('renderTurnConfig is empty when no TURN/STUN feature is enabled', () => {
  assert.equal(renderTurnConfig(sfuConfig()), '');
});

test('media plan follows NODE_FEATURES and never starts coturn twice', () => {
  const sfu = mediaPlan(sfuConfig());
  assert.equal(sfu.length, 1);
  assert.equal(sfu[0].name, 'livekit');
  assert.equal(sfu[0].kind, 'sfu');
  assert.equal(sfu[0].port, 7880);
  assert.equal(sfu[0].files.length, 0);
  assert.match(sfu[0].env.LIVEKIT_CONFIG, /^port: 7880$/m);
  assert.match(sfu[0].env.LIVEKIT_KEYS, /^agil_sfu: /);

  const turn = mediaPlan(turnConfig());
  assert.equal(turn.length, 1);
  assert.equal(turn[0].name, 'turnserver');
  assert.equal(turn[0].kind, 'turn');
  assert.equal(turn[0].files.length, 1);
  assert.equal(turn[0].files[0].mode, 0o600);
  assert.equal(turn[0].files[0].path, turnConfigPath(turnConfig()));
  assert.deepEqual(turn[0].args.slice(-2), ['-c', turn[0].files[0].path]);

  const stun = mediaPlan(loadConfig({ NODE_FEATURES: 'stun', NODE_ID: 'stun-node' }));
  assert.equal(stun.length, 1);
  assert.equal(stun[0].kind, 'stun');

  const all = mediaPlan(loadConfig({
    NODE_FEATURES: 'sfu,turn,stun',
    NODE_ID: 'all-node',
    LIVEKIT_API_KEY: 'agil_sfu',
    LIVEKIT_API_SECRET: SECRET,
    TURN_EXTERNAL_IP: '203.0.113.10',
    TURN_PASSWORD,
  }));
  assert.deepEqual(all.map((process) => process.name), ['livekit', 'turnserver']);
  assert.equal(all[1].kind, 'turn', 'turn subsumes stun; one coturn only');
});

test('media plan keeps bundled TURN when LiveKit is external', () => {
  const config = loadConfig({
    NODE_FEATURES: 'sfu,turn',
    NODE_ID: 'mixed-node',
    SFU_EXTERNAL_URL: 'http://livekit.internal:7880',
    LIVEKIT_API_KEY: 'agil_sfu',
    LIVEKIT_API_SECRET: SECRET,
    TURN_EXTERNAL_IP: '203.0.113.10',
    TURN_PORT: '7880',
    TURN_PASSWORD,
  });
  assert.deepEqual(mediaPlan(config).map(({ name }) => name), ['turnserver']);
  assert.deepEqual(mediaPlan(sfuConfig({ SFU_EXTERNAL_URL: 'http://livekit.internal:7880' })), []);
});

test('turn config path stays inside the runtime dir', () => {
  const config = turnConfig({ NODE_RUNTIME_DIR: '/run/custom-agil' });
  assert.equal(turnConfigPath(config), path.posix.join('/run/custom-agil', 'turnserver.conf'));
});
