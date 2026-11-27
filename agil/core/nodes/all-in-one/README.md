# AgilFrame all-in-one media node

One container that owns a node end-to-end: enrollment, heartbeat, health,
metrics, drain, the media processes for the enabled features, and (optionally)
the node's Docker add-on modules controlled by the Core.

| Feature (`NODE_FEATURES`) | Process | What it serves |
|---|---|---|
| `sfu` | `livekit-server` | LiveKit signalling + WebRTC SFU (7880/tcp, 7881/tcp, 50000–50100/udp) |
| `turn` | `turnserver` (coturn) | TURN with a static credential + relay range (3478, 49200–49250/udp); answers STUN too |
| `stun` | `turnserver` (coturn) | STUN-only, no auth and no relay ports |
| `sfu,turn,stun` | both | Full all-in-one node; `turn` subsumes `stun`, so only one coturn runs |

The Node agent is PID 1 and a supervisor: it starts the children, restarts them
with exponential backoff (1 s → 30 s), reports `/readyz` 503 while one is down,
and reports the node `offline` to Core on SIGTERM. The agent is dependency-free
(no npm install); the image adds the pinned LiveKit binary and the Debian
coturn package.

The Linux lab runs LiveKit and coturn. Public media connectivity depends on
the host address and firewall. The [node runbook](../../docs/node-image.md)
describes the ports, health checks and test coverage.

## Build and run

```bash
cd agil/core/nodes/all-in-one
docker build -t agil-node-all-in-one:0.1.0 .
```

Or with Compose (host networking, state volume, tmpfs runtime dir, read-only
root, healthcheck). Requires Docker Engine 24+ / Compose v2.24+ (long-form
`env_file.required`):

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env          # AGIL_NODE_TOKEN, LIVEKIT_API_KEY/SECRET, TURN_PASSWORD
docker compose up -d --build
docker compose ps
docker compose logs -f node
```

To start an SFU and its single-host Redis together, use
`docker compose -f docker-compose.yml -f compose.local-redis.yml up -d --build --wait`.
The Redis override listens on loopback and stores data in a named volume.
See the [Redis setup](../../docs/node-image.md#start-one-sfu-node-with-local-redis)
for external Redis and port configuration.

The first start burns the one-time token and stores the returned node key in
the `node-state` volume (`/var/lib/agil-node/node.json`, mode 0600). Keep that
volume: later restarts only need heartbeats. `docker compose down -v` deletes
the key and requires a new token.

Use the [systemd unit](../../docs/node-image.md#start-the-compose-project-at-boot-with-systemd)
to start a prepared Compose project when a Linux host boots.

The node appears in the Core dashboard under Infrastructure (or
`GET /v1/admin/cluster/status`) with `role=all` (or the single enabled role) and
the advertised features.

## Endpoints

| Path | Purpose |
|---|---|
| `GET /healthz` | liveness, always 200 while the agent runs |
| `GET /readyz` | readiness: 200 only when enrolled, heartbeat fresh, not draining and media up |
| `GET /metrics` | Prometheus: readiness, heartbeats, key expiry, per-feature/per-process state, Docker module capability |
| `GET /` | version/role/features/port summary (no secrets) plus Docker `modules` capability |
| `POST /v1/control/drain` | `{"drain":true\|false}` — local maintenance drain |
| `POST /v1/control/rotate-key` | `{"keyTtlSec":…}` — needs `AGIL_API_KEY` |

Control endpoints require `NODE_CONTROL_TOKEN` (header `x-control-token` or
`Authorization: Bearer`) when it is set; without it they accept loopback only.
`drain` does **not** kill calls: it makes `/readyz` 503 and lets a scheduler move
new work elsewhere (Core has no room scheduler yet, so today it is an operator
signal plus a Kubernetes endpoint removal).

## Heartbeat metrics

Every heartbeat carries a best-effort local snapshot under `metrics` (Core's
`nodeMetricsInputSchema`; every field is optional and old Cores strip the
unknown key, so this is backward compatible):

| Field | Source | Notes |
|---|---|---|
| `cpuPercent` | `/proc/stat` delta between heartbeats | 0–100; omitted on the first beat after start (no baseline yet) |
| `memoryPercent` | `/proc/meminfo` (`MemTotal` − `MemAvailable`) | 0–100 |
| `load1` | `/proc/loadavg` | 1-minute load average |
| `uptimeSec` | `/proc/uptime` | host uptime; agent process uptime where `/proc` is unavailable |
| `bandwidthMbps` | `/proc/net/dev` rx+tx delta, non-loopback NICs | host NIC throughput over the interval since the previous beat; omitted on the first beat. It is host-wide traffic, not media-only |
| `version` | `NODE_IMAGE_VERSION` | agent image version (`0.1.0`) |
| `reportedAt` | agent clock | epoch-ms, replaced on every report |
| `activeRooms`, `participants` | — | **not reported**: room state lives in LiveKit, not in the agent, so the fields are omitted instead of faked |

Collection never throws and never blocks the heartbeat: an unreadable or
malformed `/proc` file just drops that field. No secret (node key, enrollment
token, LiveKit/TURN credentials) enters the snapshot. See
[`agent/metrics.mjs`](agent/metrics.mjs) and the tests in
[`test/metrics.test.mjs`](test/metrics.test.mjs).

## Docker add-on modules (optional)

When the Docker Engine socket is mounted into this container, the agent also
manages the node's allowlisted Docker add-ons (`egress`, `stt`, `recorder`,
`turn`, `sip`) on behalf of the Core:

- each heartbeat reports a `modules` snapshot discovered from sibling containers
  labelled `agil.module=<id>` and `agil.node=<this node id>` (status, health,
  version, ports, image, `updatedAt`, `lastError`);
- `moduleCommands` in the heartbeat response are executed through the Docker
  Engine API (`install/start/stop/restart/remove`), then acknowledged as
  `moduleResults` on a later beat;
- the install image always comes from the command and is re-validated against
  the node-side allowlist; the dashboard cannot pass an image or a command, and
  only this node's `agil.node`-labelled containers are ever touched.

`NODE_MODULES` defaults to `auto`: with no socket the agent logs one line,
omits `modules` and keeps the media/health/heartbeat path unchanged (an
agent-only node). `on`/`off` force the loud/disabled behaviour. A container with
the socket mounted needs permission to use it (typically `--group-add <docker
gid>`; otherwise the agent logs a permission error and stays agent-only). This
module implementation is the same file as the reference agent's
(`agil/infra/node-agent/modules.mjs`, byte-identical); the full contract,
labels, env file and failure semantics are documented in
[`agil/infra/node-agent/README.md`](../../../infra/node-agent/README.md#docker-modules-heartbeat-modules--modulecommands)
and the [Core cluster API guide](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/api/cluster.md).

Mounting the Docker socket gives the agent root-equivalent control of the host.
Do it only on nodes that should run AGIL add-ons; the base image stays read-only
and non-root for everything else.

## Configuration

Every setting is documented with comments in [`.env.example`](.env.example).
Canonical names use the `NODE_*` prefix; `AGIL_NODE_*` aliases are accepted for
the quickstart/Helm `.env` (`NODE_FEATURES` ↔ `AGIL_NODE_FEATURES`, and so on).
The Core credential names are unchanged: `AGIL_CORE_URL`, `AGIL_NODE_TOKEN`,
`AGIL_NODE_KEY`, `AGIL_API_KEY`.

`NODE_HTTP_HOST` and `NODE_HTTP_PORT` accept `AGIL_NODE_HTTP_HOST` and
`AGIL_NODE_HTTP_PORT` if the canonical settings are empty. The image healthcheck
uses that same listener configuration. For wildcard IPv4 and IPv6 addresses it
probes the matching loopback address. Compose inherits the image healthcheck.
`NODE_MODULES` (`auto|on|off`, default `auto`) and `NODE_DOCKER_HOST` (default
`unix:///var/run/docker.sock`, `DOCKER_HOST` fallback) control the optional
Docker add-on module management; see "Docker add-on modules".
`AGIL_CORE_URL` must be a plain base URL — credentials (`user:pass@`) are
rejected at startup because `fetch()` refuses them and they would leak into
logs/metrics; the node authenticates with headers only.

Important validation rules (all fail before a process starts):

- unknown feature tokens or a `NODE_ROLE` contradicting `NODE_FEATURES`;
- `turn` without either `TURN_PASSWORD` or `TURN_STATIC_AUTH_SECRET`, `sfu` without `LIVEKIT_API_KEY/SECRET`;
- a private/loopback advertised IP without `TURN_ALLOW_PRIVATE_IP=1`;
- duplicate ports or overlapping SFU/TURN UDP ranges;
- invalid `NODE_ENDPOINT`, `NODE_HEALTH_PATH`, heartbeat/TTL bounds or capacity JSON;
- `AGIL_CORE_URL` with credentials (`user:pass@`) or a non-http(s) scheme;
- `NODE_MODULES` other than `auto|on|off`, or `NODE_DOCKER_HOST` that is not
  `unix://`/`npipe://`/`tcp://`/an absolute socket path.

## Required host firewall

With host networking, publish nothing through Docker; open on the host:

| Port | Protocol | Purpose |
|---|---|---|
| 7880 | tcp | LiveKit HTTP/WS signalling |
| 7881 | tcp | LiveKit RTC/TCP fallback |
| 50000–50100 | udp | LiveKit RTC media (`SFU_UDP_*`); when `SFU_UDP_MUX_PORT>0`, open only that port instead |
| 3478 | tcp+udp | TURN/STUN |
| 5349 | tcp | TURN/TLS (`TURN_TLS=1`) |
| 49200–49250 | udp | coturn relay (`TURN_MIN/MAX_PORT`) |
| 8080 | tcp | agent health/metrics/control — private network only |
| 6789 | tcp | LiveKit metrics — private network only (`SFU_METRICS_PORT=0` disables) |

## Security notes

- No secret is baked into the image. `.env` is injected at runtime; the node key
  is only in the state volume; the LiveKit pair is passed to LiveKit through
  `LIVEKIT_KEYS` (never written to disk); the TURN credential goes to a 0600
  file in tmpfs (`/run/agil`), never into argv/logs.
- Docker add-on modules: the optional socket mount is root-equivalent host
  access; only the Core-catalog ids/actions and the catalog image for `install`
  are accepted, and only this node's `agil.node`-labelled containers are touched.
  Optional module env values live in the node-local `module-env.json` (`0600`)
  and are never logged, reported or sent to the Core.
- The container runs as uid 1000 (`node`), `cap_drop: ALL`,
  `no-new-privileges`, read-only root with tmpfs for `/run/agil` and `/tmp`.
- `NODE_CONTROL_TOKEN` should be set if anything other than `docker exec` may
  reach `:8080`; `AGIL_API_KEY` is an admin credential and is only needed for
  key rotation.
- `/healthz`, `/readyz`, `/metrics` and `GET /` are **unauthenticated**. The
  listener binds `NODE_HTTP_HOST=0.0.0.0` by default because host networking
  must expose the port to the host; keep `8080/tcp` off the public firewall and
  scrape it from the private network/host (or set `NODE_HTTP_HOST=127.0.0.1`
  when only local probes are needed). Only the POST control endpoints are
  authenticated/loopback-restricted.
- The state file is re-checked on load: a restored `node.json` with group/world
  permissions is tightened back to `0600` (POSIX) and the repair is logged.
- Supply chain: the base image, LiveKit stage and Debian packages are tag-pinned
  (`node:22-bookworm-slim`, `livekit/livekit-server:v1.13.11`, Debian
  bookworm). For a reproducible build, resolve both digests and pin them as
  `image@sha256:…`; see `docs/node-image.md` §10.
- `node:22-bookworm-slim` is a supported LTS line in maintenance until
  **2027-04-30**; rebuild with the next Node LTS before that date.
- TLS for signalling is terminated in front of LiveKit (Caddy/Nginx/LB). TURN
  can run TLS itself on 5349 with a mounted certificate pair.

## Monitor a separate LiveKit service

Set `NODE_FEATURES=sfu` and `SFU_EXTERNAL_URL=http://127.0.0.1:7880` in
`.env` when LiveKit runs separately on the same host. Use a directly reachable
HTTP or HTTPS origin and set `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` to
the pair shared with Core and LiveKit. The agent sends an authenticated
read-only RoomService request before each readiness heartbeat.

The agent reports the service as `livekit-external` in `/healthz`. If the
request fails, `/readyz` returns 503 and the next report sets `sfuReady` to
false. The next successful probe restores readiness. Set the browser-reachable
signaling URL on Core via `AGIL_SFU_NODE_URLS`. Start, stop and restart the
separate service through its own deployment.
[Deployment guide](../../docs/node-image.md#monitor-a-separate-livekit-service).

## Development

```bash
# Unit + fake-Core e2e tests (Node >= 20; the image uses Node 22 LTS), no deps:
npm run test:node-image

# Direct one-shot enrollment smoke against a running Core:
NODE_ONCE=true \
AGIL_CORE_URL=http://127.0.0.1:8787 \
AGIL_NODE_TOKEN=agil_enr_... \
NODE_ID=node-once-1 \
NODE_FEATURES=sfu \
LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
NODE_MEDIA_ENABLED=false \
node agent/index.mjs
```

## Limitations

- The image passed a local Docker Engine run in WSL 2. External TURN across
  independent networks remains to be verified.
- Core can use configured LiveKit addresses and the agent's `sfuReady` report
  for new room assignments. `endpoint` and `healthPath` remain informational.
  During `drain`, existing rooms retain the assigned ingress.
- A node key lost in the middle of a rotation cannot be recovered from the
  state volume; delete `node.json` and re-enroll with a new one-time token (or
  restore the volume). See the recovery section in `docs/node-image.md`.
- `NODE_MEDIA_ENABLED=false` disables bundled processes. It still advertises
  the configured features and checks an explicit `SFU_EXTERNAL_URL`.
- Heartbeat metrics report host/agent values only. `activeRooms`/`participants`
  are omitted because the agent does not own LiveKit room state (that needs an
  authenticated LiveKit API client); they are never sent as zero. Bandwidth is
  host NIC throughput, not per-room media traffic.
- Docker add-on modules need the Docker Engine socket mounted into this
  container (see "Docker add-on modules"). Without it the node is agent-only:
  the heartbeat omits `modules` and any queued module command is acknowledged as
  failed. The add-on containers run as siblings on the node host — they are not
  supervised by this image's media supervisor and are created with the catalog
  ports and `unless-stopped` restart policy.

See [`agil/core/docs/node-image.md`](../../docs/node-image.md) for the operator
runbook, metrics reference, drain/key-rotation details and the validation
evidence.
