# All-in-one media node image (SFU + TURN + STUN)

> **Status (25.11.2026):** built and run locally with Docker Engine in WSL 2.
> The agent enrolled with a real Core, started LiveKit with a local Redis,
> and exchanged datagrams between two authenticated TURN clients. A replacement
> container used the existing state volume to reconnect without an enrollment token.
> The public IPv4 and independent NAT tests are still pending.

This is the first-party node image for AgilFrame. It replaces "a node is only
an enrollment/heartbeat client" with one container that also owns the media
processes:

```
                  ┌──────────────────────────── container (host network) ─┐
 Core  ◄─ HTTPS ──►  node agent (PID 1, Node >= 20, no dependencies)        │
   ▲  register        │  /healthz  /readyz  /metrics  /v1/control/*        │
   │  heartbeat       │  supervisor (restart 1 s → 30 s)                   │
   │  drain/rotate    ├──────────────┬──────────────────────────┐         │
   └───────────────►  │ livekit-server│ turnserver (coturn)      │         │
                      │ 7880/7881     │ 3478, 5349, relay range  │         │
                      │ 50000-50100/udp│ 49200-49250/udp         │         │
                      └──────────────┴──────────────────────────┘         │
                  └───────────────────────────────────────────────────────┘
```

- Agent and image: [`agil/core/nodes/all-in-one/`](../nodes/all-in-one/).
- Compose: [`docker-compose.yml`](../nodes/all-in-one/docker-compose.yml).
- Operator-facing quick start: [`README.md`](../nodes/all-in-one/README.md).

## 1. What it does

1. **Enrollment** — redeems a one-time Core token
   (`POST /v1/nodes/register`) and persists the returned node key in
   `/var/lib/agil-node/node.json` (mode `0600`, named volume). A pre-issued
   `AGIL_NODE_KEY` skips enrollment.
2. **Feature-gated media** — starts only the processes selected by
   `NODE_FEATURES` (see §3). `turn` already answers STUN; `stun` alone runs
   coturn with `stun-only`/`no-auth`.
3. **Heartbeat** — `POST /v1/nodes/:id/heartbeat` every `NODE_HEARTBEAT_SEC`
   (default 30 s, Core offline threshold 90 s), reports capacity/status plus a
   best-effort host `metrics` snapshot (CPU/memory/load/uptime/bandwidth — see
   below) and consumes Core's `drain` flag.
4. **Health/metrics** — `/healthz` (liveness), `/readyz` (readiness),
   `/metrics` (Prometheus), `GET /` (safe summary).
   Readiness requires an `OK` from LiveKit's HTTP listener and a matching UDP
   STUN Binding response from coturn for the enabled media processes. When
   `TURN_TLS=1`, the coturn probe also requires a successful TLS handshake on
   `TURN_TLS_PORT`. Set `TURN_TLS_HOSTNAME` to the public DNS name in the certificate's SAN
   to let the agent verify the name and include it in the heartbeat. The dashboard then
   fills the `turns:` address in the TURN pool draft. Update Core before enabling the
   hostname report. The agent probes locally with a one-second deadline and runs the next check two
   seconds after completion. If a service stops answering, `/readyz` returns
   `503 media_down` and names the service. Authenticated relaying and public
   certificate trust are verified separately with client connections.
   For the bundled TURN mode, the agent also reports `turnReady`. Link the
   configured TURN relay to the node ID in the organization's TURN pool.
   Core uses that report to decide whether to include the relay in ICE.
   In the TURN pool editor, use **Load relay list** to select the node and
   import its IPv4 and UDP/TCP port into the draft. Set matching credentials
   and save the draft before use. For TLS, enter the certificate hostname
   and use the TLS port from the node configuration.
   STUN-only mode does not report TURN readiness.
5. **Drain** — Core's flag or `POST /v1/control/drain` makes `/readyz` 503
   without touching in-flight calls. There is no room scheduler yet, so this is
   a signal for operators/Kubernetes endpoints, not automatic migration.
6. **Graceful stop** — on SIGTERM/SIGINT sends an `offline` heartbeat, stops the
   media children (SIGTERM, then SIGKILL after 10 s) and exits 0. A 20 s guard
   prevents a hung container stop.
7. **Key rotation** — optional automatic rotation before expiry
   (`NODE_KEY_ROTATE_BEFORE_SEC` + `AGIL_API_KEY`) or on demand
   (`POST /v1/control/rotate-key`). The new key is persisted before the next
   heartbeat.

What it deliberately does **not** do: route rooms to nodes, allocate TURN
credentials per call, terminate TLS, run egress/SIP, or replicate the Core
registry. Those stay with Core/edge/other kits.

### Heartbeat metrics

Alongside `capacity` and `status`, every heartbeat may carry one optional
nested object, `metrics` (Core's `nodeMetricsInputSchema`; each field is
independently optional and old Cores strip unknown keys):

| Field | Source (`metrics.mjs`) | Notes |
|---|---|---|
| `cpuPercent` | `/proc/stat` delta between beats | 0–100; omitted on the first beat after start (no baseline) |
| `memoryPercent` | `/proc/meminfo` (`MemTotal` − `MemAvailable`) | 0–100 |
| `load1` | `/proc/loadavg` (`os.loadavg` fallback off-Windows) | 1-minute load average |
| `uptimeSec` | `/proc/uptime` | host uptime; agent process uptime where `/proc` is unavailable |
| `bandwidthMbps` | `/proc/net/dev` rx+tx delta, non-loopback NICs | host NIC throughput since the previous beat; omitted on the first beat; host-wide, not per-room media |
| `version` | `NODE_IMAGE_VERSION` | `0.1.0` |
| `reportedAt` | agent clock | epoch-ms, replaced every report |
| `activeRooms` / `participants` | — | **never reported**: the agent does not own LiveKit room state (needs an authenticated LiveKit API client), so the fields are omitted, not zero-filled |

Collection is best-effort and cannot break a heartbeat: an unreadable or
malformed `/proc` file drops that field, and the request is still sent. No
secret enters the snapshot. Code/tests:
[`agent/metrics.mjs`](../nodes/all-in-one/agent/metrics.mjs),
[`test/metrics.test.mjs`](../nodes/all-in-one/test/metrics.test.mjs).

## 2. Build and run

```bash
cd agil/core/nodes/all-in-one
docker build -t agil-node-all-in-one:0.1.0 .

cp .env.example .env
chmod 600 .env
$EDITOR .env          # token, LiveKit key/secret, TURN password, public IP
docker compose up -d --build
docker compose ps
docker compose logs -f node
```

### Start one SFU node with local Redis

Use `NODE_FEATURES=sfu` or a combination that includes `sfu`. After preparing
`.env`, run the base Compose file with the local Redis override.

```bash
docker compose -f docker-compose.yml -f compose.local-redis.yml up -d --build --wait
```

The override connects LiveKit to Redis on `127.0.0.1:6380`. Set
`AGIL_NODE_REDIS_PORT` in `.env` if the port is in use. Compose starts the
node after Redis passes its `PING` check. Redis uses an append-only log in
the named `redis-data` volume. This instance listens on loopback and is for a
single host. Use a trusted shared Redis endpoint for LiveKit nodes on different
hosts. Set `SFU_REDIS_URL` for that deployment and run the base Compose file.
Keep both named volumes when replacing the containers.

With the same Compose files, `docker compose … ps` reports health and
`docker compose … logs redis node` shows startup errors. [Redis override](../nodes/all-in-one/compose.local-redis.yml)

If the node stays in `Created`, inspect `docker compose … ps -a` and run
`docker compose … exec redis redis-cli -p <port> PING`, using the configured
Redis port. A successful check returns `PONG`. The local Egress override also
waits for Redis and node readiness at startup. Keep `redis-data` when
recovering the stack so Redis can replay its append-only log.

### Monitor a separate LiveKit service

Use this mode when LiveKit has its own deployment. Set the following in
the all-in-one agent's `.env` and use the key pair from that deployment.

```dotenv
NODE_FEATURES=sfu
NODE_MEDIA_ENABLED=false
SFU_EXTERNAL_URL=http://127.0.0.1:7880
LIVEKIT_API_KEY=<livekit-api-key>
LIVEKIT_API_SECRET=<livekit-api-secret>
```

The example uses a separate LiveKit that publishes HTTP to the agent's
host loopback. For different hosts or containers, use the reachable private
HTTP or HTTPS origin for that LiveKit. The value accepts only an origin.
Configure Redis, ICE and media ports in the separate LiveKit deployment.
`NODE_MEDIA_ENABLED=true` with `NODE_FEATURES=sfu,turn` also starts the
bundled TURN service. With `SFU_EXTERNAL_URL` unset the agent supervises
its built-in LiveKit as before.

Configure the registered node ID's browser-facing `wss://` URL on Core.
Set `AGIL_SFU_NODE_URLS` for the direct address and keep `AGIL_SFU_URL` as
the shared fallback. [Direct SFU ingress](operations.md#direct-sfu-ingress-per-room).

The agent verifies the configured LiveKit API and credentials before each
readiness heartbeat. It sends one read-only RoomService request for a random
test name with a short-lived token. The request has a one-second timeout and
requires a direct response. On failure the agent remains up, `/readyz`
returns 503 with `media_down`, and the Core heartbeat sets `sfuReady: false`.
The next successful probe restores `sfuReady`. The status and metrics name
is `livekit-external`. Use a browser media test to validate ICE and RTP.

#### Start a stopped external LiveKit from Infrastructure

For optional lifecycle actions, the all-in-one agent and external LiveKit
must use the same host and local Docker Engine. Run the official LiveKit
image as a Compose service named `livekit`. Add these labels to that service.
Leave `AGIL_NODE_SFU_LIFECYCLE` unset for inventory only.

```yaml
services:
  livekit:
    image: livekit/livekit-server@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20
    network_mode: host
    restart: 'no'
    env_file: [./livekit.env]
    labels:
      agil.module: sfu
      agil.node: "${NODE_ID:?Set the exact registered node ID}"
      agil.module.lifecycle: "${AGIL_NODE_SFU_LIFECYCLE:-false}"
      agil.module.graceful-stop: "${AGIL_NODE_SFU_GRACEFUL_STOP:-false}"
```

Set the LiveKit YAML as `LIVEKIT_CONFIG` in the local `livekit.env`.
Keep the file accessible only to the operator. The optional panel action
requires exactly one matching container, with no mounts, privileged mode,
extra capabilities or Docker devices. For a deployment that needs mounts,
manage the container from its own Compose project.
[LiveKit config source](https://github.com/livekit/livekit/blob/v1.13.11/cmd/server/main.go).

1. In Infrastructure, enable maintenance on the registered SFU node.
2. Keep the node out of any shared fallback gateway, load balancer or other
   service that can send new sessions independently of Core. Maintenance
   excludes new direct allocations in Core. Rooms already assigned to the
   node can still be active and accept connections.
3. To stop from the panel, set both lifecycle variables to `true` in the
   Compose project before creating the container. The stop action uses the
   verified LiveKit 1.13.11 digest above, its original entrypoint, restart
   policy `no` and persistent agent state. In Infrastructure, refresh the
   module inventory and select **Gracefully stop**. LiveKit waits for active
   participants to leave. Keep maintenance on until the module is stopped.
   If the agent cannot confirm a sent signal, inspect the container on the
   node before taking another action. A second signal can force shutdown.
4. Before stopping or restarting outside the panel, verify in both Core
   and LiveKit that this node has no active rooms or sessions. Check
   alternate gateways and external publishers as well. For LiveKit 1.13.11
   with Compose restart policy `no`, send one `SIGTERM` using
   `docker compose kill --signal SIGTERM livekit`. LiveKit enters drain and
   waits for participants. Check `docker compose ps --all livekit` for exit
   before starting it again. A second signal can force shutdown. Docker
   `stop` and `restart` can also force shutdown after their stop timeout.
   With another restart policy, follow the deployment's maintenance
   procedure so the supervisor does not bring the service back during drain.
   [LiveKit signal handling](https://github.com/livekit/livekit/blob/v1.13.11/cmd/server/main.go#L296-L305) ·
   [LiveKit shutdown](https://github.com/livekit/livekit/blob/v1.13.11/pkg/service/server.go#L353-L375).
5. To start the stopped service from the panel, configure
   `AGIL_NODE_SFU_LIFECYCLE=true` on the node before creating the
   container. In the module card, refresh the inventory and select
   **Start**. Confirm the new Docker state and the agent's authenticated
   LiveKit readiness. Verify a media connection before restoring the
   gateway and leaving maintenance.

To restart from Infrastructure, select **Restart after calls** in the same
module card. LiveKit drains first. Core queues a separate start after the same
container reports stopped. Leave maintenance only after the new process
reports ready and a media connection succeeds. If the start fails, inspect
the result and the stopped container before starting it again.

### Start the local Egress worker

On an isolated Linux test host, add the Egress override to the SFU and Redis
setup. Set `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in `.env` to match the SFU.

```bash
docker compose -f docker-compose.yml -f compose.local-redis.yml -f compose.local-egress.yml up -d --build --wait
```

Compose starts Egress after the node and Redis pass their health checks. The
worker uses the same SFU and Redis ports configured in `.env`. It checks its
own HTTP status on `AGIL_NODE_EGRESS_HEALTH_PORT` (default `8082`). Host
networking makes this a host port. Restrict access with the host firewall.
The node health check uses local media probes. Core updates `sfuReady` and
`turnReady` on the next agent heartbeat. Before routing calls to a newly
started node, check those fields in `GET /v1/admin/nodes` for the enabled
services. When testing Egress, check the worker's HTTP status separately.
The worker uses `SYS_ADMIN` and unconfined seccomp for its media pipeline.
Use the [dedicated production Egress deployment](egress-production.md) to
configure storage, output credentials, capacity and network isolation.
[Egress override](../nodes/all-in-one/compose.local-egress.yml)

Set `NODE_ID` to the registered node ID in the Compose environment to show
this worker's status in Infrastructure. Existing projects must merge the
`agil.node` and `agil.module` labels before recreating the worker. Apply
configuration and lifecycle changes in the same Compose project.

For MP4 recording or HLS output on the shared test node, configure storage
on the worker as well as playback in Core. Set
`AGIL_NODE_EGRESS_CONFIG_FILE` to the absolute path of a complete worker
YAML file outside the Git checkout. Start from the
[Egress configuration example](../deploy/livekit/egress.yaml) and provide
the LiveKit credentials, the configured SFU and Redis ports, and
`health_port` matching `AGIL_NODE_EGRESS_HEALTH_PORT`. Set
`enable_chrome_sandbox: false` to match the local override and configure
`storage.s3` with writer credentials. Limit host access to the file and
make it readable by the worker's container user. Configure Core with
reader credentials for the same bucket. [Core S3 playback settings](egress-production-s3.md)

```bash
docker compose -f docker-compose.yml -f compose.local-redis.yml -f compose.local-egress.yml \
  -f compose.local-egress-storage.yml up -d --wait
```

The [storage override](../nodes/all-in-one/compose.local-egress-storage.yml)
mounts the config read-only. Check that the worker can reach the S3 and
RTMP destinations before creating jobs. Compose gates worker startup on the
local SFU and Redis health checks. Reachability and credentials for output
destinations are verified when the worker runs a job.

### Start a local RTMP Ingress worker

Enable `sfu` in `NODE_FEATURES`. Start the node and enable the worker with the
same Redis and LiveKit credentials as the SFU.

```bash
docker compose -f docker-compose.yml -f compose.local-redis.yml -f compose.local-ingress.yml up -d --build --wait
curl -fsS http://127.0.0.1:8083/availability
```

An operator with LiveKit Ingress permissions creates an `RTMP_INPUT` for the
target LiveKit room. For example, Core room `<room-id>` in the `demo` tenant
uses the LiveKit room name `demo__<room-id>`. Publish to the returned base URL
with its stream key.
Keep the key out of logs and dashboards intended for viewers. The default base
URL points to loopback. Set `SFU_RTMP_INGRESS_BASE_URL` to a reachable URL for
publishers on other hosts. The RTMP listener and health endpoint use host
networking. Restrict their network access on the test host. Set the port with
`AGIL_NODE_INGRESS_RTMP_PORT` and check that the base URL matches it.

The same worker can pull SRT or HLS with `CreateIngress` and
`input_type: URL_INPUT`. Set `room_name` to the target LiveKit room and
assign the source a unique `participant_identity`. Use `DeleteIngress`
to stop the source and remove its participant.

- For SRT, run the source in listener mode on a UDP address reachable
  from the worker. Pass `srt://SOURCE_HOST:PORT?mode=caller` as the input URL.
  Local QA used GStreamer `srtsink` with a pre-encoded MPEG-TS file
  carrying H.264 and AAC.
- For HLS, pass a playlist URL reachable from the worker. The worker
  also needs access to the segment URLs. Local QA used a VOD playlist
  with MPEG-TS segments carrying H.264 and AAC.

For both sources, the Core widget in Chromium decoded video and received
audio over WebRTC. Removing the ingress also removed its participant.

Core flow adapters and automatic provisioning from the dashboard have their
own acceptance criteria. [Ingress override](../nodes/all-in-one/compose.local-ingress.yml) ·
[LiveKit Ingress setup](https://docs.livekit.io/transport/self-hosting/ingress/).

#### Verify Ingress worker credential rotation

Run this QA scenario in an isolated Linux VM. Install Node.js 20 or newer,
Docker Engine with Compose v2, Chromium, FFmpeg with `libx264`, Bash and curl.
Cache `livekit/livekit-server:v1.13.11`, `livekit/ingress:v1.6.0` and
`redis:7-alpine` in that VM before going offline. The scenario uses an isolated
Compose project and the guest's ports 26880–26886, including UDP 26883 for SFU.

From the repository root, install workspace dependencies from an available npm
cache, then build the widget and its demo page. Run Chromium as an unprivileged
user with access to the local Docker engine.

```bash
npm ci --offline
npm run build:protocol && npm run build:security && npm run build:ai
npm run build:widget && npm run build:demo
CHROME_PATH=/usr/bin/chromium node --import tsx agil/core/qa/livekit-ingress-recovery-e2e.mjs --rotate-worker-key
```

The scenario generates two credentials for the worker and a separate stable
credential for Core. Chromium on 390 px checks red RTMP video and audio before
rotation, green during overlap, and blue after LiveKit revokes the old worker
credential. The old credential must receive HTTP 401. The new worker and
Redis keep their container IDs during revocation, the RTMP stream key stays
valid, and removing the receiver revokes the RTMP stream key. Each SFU restart
uses a fresh browser join, so this scenario does not measure seamless call
continuity or rolling deployment. QA scenario.

#### Manage an existing Ingress from Infrastructure

Set an explicit `NODE_ID` and `AGIL_NODE_INGRESS_LIFECYCLE=true` in the
Compose environment. Enable the agent's Docker module management and give it
the node's local Docker socket. Apply the Compose configuration so the
Ingress container receives the labels. The override defaults to read-only
inventory until the operator opts in.

Open **Infrastructure**, expand **Modules** on the matching node, and find
**LiveKit Ingress**. The card shows process state and Docker health. It
offers start, stop and restart for the exact operator-approved container.
Stopping or restarting may interrupt active RTMP, SRT and HLS inputs.
Confirm the action in the panel when it is safe to interrupt them.
Install, configure and remove Ingress through Compose on the node.

The agent requires the official `livekit/ingress` repository, the
`ingress` Compose service label and matching node ownership. It supports
the host network in the supplied Ingress override. The eligible container
must be unique and use no mounts, added capabilities, devices, privileged
mode or shared namespaces beyond the Ingress network. The Compose
configuration and credentials remain local.

### Start the local SIP gateway

The [SIP Compose override](../nodes/all-in-one/compose.local-sip.yml) starts
the LiveKit SIP worker after the SFU and Redis become healthy. Set
`AGIL_NODE_SIP_CONFIG_DIR` in the node's `.env` to an absolute path outside
the checkout. The directory mounts read-only at `/etc/agil-sip`. Restrict
host access to the directory and its private keys.

Set `NODE_ID` to the registered node ID in the Compose environment to show
SIP worker status in Infrastructure. Apply changes to the service, mounts
and restart policy in this Compose project.

Create `sip.yaml` in that directory using the same LiveKit credentials and
ports as the SFU, and the same Redis endpoint. This example uses the
default SFU and Redis ports and a SIP TLS listener on 5061.

```yaml
api_key: "<LiveKit API key>"
api_secret: "<LiveKit API secret>"
ws_url: ws://127.0.0.1:7880
redis:
  address: 127.0.0.1:6380
sip_port: 5060
health_port: 28083
rtp_port: 10000-10100
tls:
  port: 5061
  certs:
    - cert_file: /etc/agil-sip/fullchain.pem
      key_file: /etc/agil-sip/privkey.pem
```

If you change `health_port`, set `AGIL_NODE_SIP_HEALTH_PORT` to the same
port for Compose. For a test or private CA, set `AGIL_NODE_SIP_CA_FILE`
to the absolute path of its CA bundle **inside the container**.

```bash
docker compose -f docker-compose.yml -f compose.local-redis.yml -f compose.local-sip.yml up -d --build --wait
curl -fsS http://127.0.0.1:28083/
```

Core's `AGIL_SIP_URL` points at the private LiveKit HTTP endpoint that
serves the SIP control API. Configure the trunks in LiveKit and reference
the outbound trunk ID in the organization. Choose TLS for signaling and
require SRTP on each protected trunk. Set the worker's advertised media
address and restrict SIP and RTP ports to the intended network and trunk
provider. Keep the HTTP health endpoint on the private network.
A test call verifies connectivity and encryption with the trunk.
[Core SIP setup](sip.md) · [Local Asterisk test](sip-local-lab.md#исходящий-звонок-с-tls-и-srtp) · [Secure trunking](https://docs.livekit.io/telephony/features/secure-trunking/)

### Serve browser signaling over TLS

Use the [Caddy override](../nodes/all-in-one/compose.local-edge.yml) for a
Linux media node that owns its HTTPS listener. Configure the following
variables in the node's `.env`.

| Variable | Value |
|---|---|
| `AGIL_SFU_TLS_HOST` | DNS name on the certificate and in the browser signaling URL |
| `AGIL_SFU_TLS_CERT_DIR` | Absolute path to the directory with `fullchain.pem` and `privkey.pem` |
| `AGIL_SFU_TLS_PORT` | HTTPS port, default `443` |
| `AGIL_SFU_TLS_BIND` | Listening IPv4 address, default `0.0.0.0` |
| `SFU_PORT` | LiveKit HTTP port on the same host, default `7880` |

```bash
docker compose -f docker-compose.yml -f compose.local-redis.yml -f compose.local-edge.yml up -d --build --wait
curl -fsS https://sfu.example.com/
```

Set Core's browser endpoint to `AGIL_SFU_URL=wss://sfu.example.com`. Set
`AGIL_SFU_CONTROL_URL` to the private LiveKit HTTP address that Core can
reach for room termination and participant removal. If unset, Core uses
`AGIL_SFU_URL` for RoomService as before. Direct node addresses in
`AGIL_SFU_NODE_URLS` must also use `wss://` when served by this proxy.

Caddy waits for the node's readiness check, serves the certificate mounted
read-only and proxies the LiveKit root and browser signaling paths. It
does not forward Twirp control calls. Restrict the raw LiveKit HTTP port
to private clients such as Core. The browser negotiates media separately
over LiveKit ICE ports or TURN. Keep those ports reachable for your chosen
media topology. [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

Your certificate issuer supplies updates. Replace both files within the
mounted directory, then reload Caddy and check the new certificate from a
client. The file-backed configuration uses a local Unix admin socket.

```bash
docker compose -f docker-compose.yml -f compose.local-redis.yml -f compose.local-edge.yml \
  exec edge caddy reload --force --address unix//run/caddy/admin.sock \
  --config /etc/caddy/Caddyfile --adapter caddyfile
```

### Media node image

The image is based on `node:22-bookworm-slim` (Node 22 LTS, maintenance through
**2027-04-30**; rebuild with the next Node LTS before then) with the Debian
`coturn` package and the pinned `livekit/livekit-server` binary copied from the
official image (`LIVEKIT_VERSION`, default `v1.13.11`, same pin as
`agil/core/deploy/livekit/docker-compose.yml`). No npm install and no build
step: the agent is dependency-free JavaScript and only needs Node >= 20
(global `fetch`).

Compose runs the container with **host networking**, a read-only root, tmpfs
for `/run/agil` and `/tmp`, `cap_drop: ALL`, `no-new-privileges`, a named
`node-state` volume and a `/readyz` healthcheck. Docker Desktop on Windows/
macOS does not provide a real host network; use a Linux host/VM.

Coturn writes its PID and SQLite user database under `/run/agil`. The generated
configuration keeps the TURN credential or signing key in a `0600` file in the same
tmpfs. The agent recreates these files after a container restart. The enrollment
key persists separately in `node-state`.

For temporary browser credentials, set `TURN_STATIC_AUTH_SECRET` on the node
and leave `TURN_PASSWORD` empty. Set the same signing key in Core's
`AGIL_COTURN_REST_SECRETS` under the organization and relay ID. The agent
reports the credential type so the panel selects the matching mode when it
imports the relay. Use the actual relay ID from the draft in Core's environment.
[Core setup and rotation](operations.md#temporary-coturn-credentials)

### Automatic TURN pool membership

Choose a stable `NODE_ID` and generate a separate random signing key for the
node, for example with `openssl rand -hex 32`. Put the key in Core's `AGIL_COTURN_AUTO_SECRETS` under the organization
ID and `NODE_ID`, and set it as `TURN_STATIC_AUTH_SECRET` on the node. For
example, the Core configuration has the shape `{"demo":{"turn-msk":"<key>"}}`.
Upgrade Core before enabling `TURN_AUTO_REGISTER=1` on the node.

The node proves possession of the signing key in its authenticated readiness
report. Core uses the verified UDP/TCP endpoint and, when present, the verified
TLS hostname and port to issue short-lived browser credentials. The report and
the admin API never return the signing key. The panel shows automatic entries
under **Integrations → Scaling → TURN pool**. Entries come from the live
registry. They are excluded while disabled, drained or stale and return after
a fresh report. An explicit pool entry with the same relay ID or node binding
takes precedence. To roll back automatic membership, remove the node's key
from `AGIL_COTURN_AUTO_SECRETS` and restart Core, then clear `TURN_AUTO_REGISTER`
on the node. Keep signing keys out of the tenant JSON and keep this mapping
consistent across Core replicas.

The release workflow builds a `node` image when this Dockerfile exists and tags
it in GHCR together with the Core image (see `agil/core/docs/ci.md` §Images).
No deployment is automated.

### Start the Compose project at boot with systemd

Use a Linux host with Docker Engine and the Compose plugin.

#### First install on Debian or Ubuntu

Set up the signed Docker APT repository or a trusted mirror and refresh its
package index. Follow the instructions for your [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
or [Debian](https://docs.docker.com/engine/install/debian/) release. Ensure the
operator can read the APT source and its public signing key when running the
plan without root. For example, use mode `0644` for the Docker `.sources` file
and `docker.asc` created by these instructions. Run the plan on the new host.

```bash
source_dir=agil/core/nodes/all-in-one
sh "$source_dir/systemd/bootstrap-docker.sh" plan
```

The helper checks for Docker Engine 24+ and Compose 2.24+, then runs an APT
simulation for the Engine, CLI, containerd, Buildx and Compose packages.
It stops if the plan changes or removes installed packages. To install after
reviewing a successful plan, run:

```bash
sudo sh "$source_dir/systemd/bootstrap-docker.sh" install
```

Installation reruns the simulation and keeps APT's removal guard active.
The helper uses the existing APT configuration. Docker packages can start
Docker according to the host's package policy. Enable the AGIL node service
separately after preparing its project.

#### Prepare and enable the node project

The systemd template and its preparation and update scripts use the local
Docker Engine socket at `/var/run/docker.sock`. They ignore `DOCKER_HOST` and
`DOCKER_CONTEXT` so that the images prepared in the shell are available during
startup. Check the local engine and Compose plugin before preparing the project:

```bash
sudo env -u DOCKER_HOST -u DOCKER_CONTEXT docker --host unix:///var/run/docker.sock version
sudo env -u DOCKER_HOST -u DOCKER_CONTEXT docker --host unix:///var/run/docker.sock compose version
```

The service instance name is the Compose project name. Use `agil-node` to
adopt the default project and preserve its `agil-node_node-state` volume. If you
already deploy with a different project name, use that name in the directory,
Compose commands and service instance below. Stop managing the project from
its old directory once systemd owns it.

Prepare a root-owned project directory from a trusted checkout. The helper
copies the base Compose file, bundled overrides, `Caddyfile.sfu`, agent
sources and the `.env` template. A repeated run fills in missing files and
preserves existing deployment files. If a required file path is occupied by
a directory or an unresolved symlink, resolve that conflict before retrying.
For the Caddy override, provide the certificate and private key separately.

A new systemd project uses `NODE_HTTP_HOST=127.0.0.1` and
`SFU_METRICS_PORT=0`. The local health check can reach the agent on loopback.
Set `NODE_HTTP_HOST` to a private address only if a remote monitor needs it.
If you enable LiveKit Prometheus, restrict its port to your monitoring network
before enabling the service. These settings apply to newly created `.env` files.

```bash
source_dir=agil/core/nodes/all-in-one
project=agil-node
stack=/etc/agil-node/$project
sudo sh "$source_dir/systemd/prepare-stack.sh" "$stack"
sudoedit "$stack/.env"
```

When adopting a project, carry over its live `.env`, image tag and overrides.
Keep the deployment directory and `.env` accessible only to root. Put custom
Compose overrides alongside the base file. Grant read access to mounted
certificates and credentials only to the container users that need them.
For multiple Compose files, set `COMPOSE_FILE` in `.env` with
the base file first and the Linux file separator `:`. Check the local Linux
Docker Engine, the Compose startup flags used by systemd, and the resolved
project before building or pulling any images:

```bash
sudo sh "$source_dir/systemd/prepare-images.sh" "$stack" "$project" check
```

Before the first start, check the planned host ports with Python 3 and
`ss` from iproute2 installed:

```bash
sudo sh "$source_dir/systemd/prepare-images.sh" "$stack" "$project" check-ports
```

This checks TCP listeners and bound UDP ports against the effective Compose
settings for agent HTTP, LiveKit, TURN/STUN and bundled local Redis.
It also rejects overlapping port assignments between those services before
checking the host socket table. Conflicts identify the services and ports
involved. Review any additional host-network services the check lists
separately. Run this before
the project starts so its own listeners do not appear as conflicts. The
command reads the current socket table and does not reserve ports or change
firewall rules.

Prepare the image from the checkout before activating the unit:

```bash
sudo sh "$source_dir/systemd/prepare-images.sh" "$stack" "$project" build
```

For a registry deployment, set `AGIL_NODE_IMAGE` in the stack's `.env` to the
approved release tag or digest. Then run the preparation command in registry mode:

```bash
sudo sh "$source_dir/systemd/prepare-images.sh" "$stack" "$project" registry
```

For the official Compose overrides, set the corresponding image pin in
the project's `.env` to the 64 lowercase hexadecimal characters after
`sha256:` in your approved manifest digest. Leaving a pin unset uses the
tag in the selected override.

| Compose override | Pin setting |
|---|---|
| `compose.local-redis.yml` | `AGIL_REDIS_IMAGE_DIGEST` |
| `compose.local-egress.yml` | `AGIL_EGRESS_IMAGE_DIGEST` |
| `compose.local-sip.yml` | `AGIL_SIP_IMAGE_DIGEST` |
| `compose.local-ingress.yml` | `AGIL_INGRESS_IMAGE_DIGEST` |
| `compose.local-edge.yml` | `AGIL_EDGE_IMAGE_DIGEST` |
| `compose.local-monitoring.yml` | `AGIL_NODE_EXPORTER_IMAGE_DIGEST` |

Validate the resolved image references before downloading anything.

```bash
sh "$source_dir/systemd/prepare-images.sh" "$stack" "$project" check-images
```

`check-images` works without a running Docker Engine or registry access.
It uses Python 3 to check the format of digest references when any are present.
The subsequent preparation step confirms that Docker can obtain and cache
the referenced images. Store the approved digests in the project's `.env`
so the systemd unit uses them at startup. Existing staged projects must
adopt the new Compose templates to use these pins. Merge the `image` lines
into any existing locally edited overrides.

#### Service lifecycle in Infrastructure and Compose

Infrastructure shows status for official Egress and SIP workers when their
Compose labels match the registered node ID and the node agent has access to
its Docker inventory. Upgrade Core and the node agent before adding these
labels to an existing deployment. Compose owns installation,
configuration, restart policy and rollback. Earlier AGIL Egress and SIP
containers retain their lifecycle controls if they are already installed.
New installations use the official worker configuration below.

| Service | Supported control | State and readiness to preserve on rollback |
|---|---|---|
| Egress | `livekit/egress:v1.15.0` through Compose. Read-only inventory in Infrastructure. | Keep the Redis and LiveKit connection settings, S3 credentials and output policy. Check the worker HTTP endpoint and complete a sample output. [Egress](#start-the-local-egress-worker). |
| SIP | `livekit/sip:v1.24` through Compose. Read-only inventory in Infrastructure. | Keep the read-only `sip.yaml` and TLS materials. Check the worker HTTP endpoint and complete a call through the test trunk. [SIP](#start-the-local-sip-gateway). |
| Ingress | `livekit/ingress:v1.6.0` through Compose. The panel can start, stop or restart an explicitly approved container. | Keep the local Redis, LiveKit and ingest settings. Check `/availability` and publish a sample stream. [Ingress](#start-a-local-rtmp-ingress-worker). |
| SFU | Bundled in the node image or an approved `livekit/livekit-server` container. Panel start, stop and restart for an approved external container during maintenance. | Keep local LiveKit credentials and Redis connection settings. Test authenticated readiness and media after restoring the previous node image or external image digest. [SFU](#start-a-stopped-external-livekit-from-infrastructure). |
| TURN | Bundled in the node image or installed from the `coturn/coturn:4.6` catalog preset. | Keep the local signing secret, realm, port range and certificate files in the configured deployment. Verify relay allocation after restoring the previous approved image. TURN. |
| STT | `agil/node-stt:0.1.0` catalog tag or a pinned STT release image via the standalone Compose. | Keep the preloaded model mount read-only and retain current token settings during rollback. Verify `/readyz` and a sample recognition. [STT](../nodes/stt/README.md). |
| Recorder | Lifecycle of existing containers only. Use Egress for new deployments. | Retain the installed image reference, recording data, and storage configuration. Restore service and verify access to data in the operator's original deployment. [Recordings](#recording-storage-and-health). |
| Redis | `redis:7-alpine` through Compose or an external managed Redis. No catalog actions. | Keep the data volume and back it up before upgrades. Check `PING` and verify version compatibility before reusing the data with an older image. [Redis](#start-one-sfu-node-with-local-redis). |
| Caddy | `caddy:2.11.2-alpine` through Compose. No catalog actions. | Keep the read-only configuration and certificate mount. Check certificate validation and WebSocket signaling. [Caddy](#serve-browser-signaling-over-tls). |
| Node Exporter | `prom/node-exporter:v1.8.2` through Compose. No catalog actions. | Keep the read-only host mount and private scrape address. Verify that Prometheus receives host metrics again. [Monitoring](#monitor-the-node). |

For an official Compose worker, retain the previous approved image digest and
configuration before changing either. To roll back, restore those values in
the same project, recreate the affected service, and verify its readiness.
Keep its volumes in place and handle incompatible data migrations separately.
Pin bundled SFU and TURN through the approved node image digest. For a
standalone catalog worker that needs its own digest, deploy the chosen image
through the operator's configuration before adding its inventory labels.

#### Verify the image cache and activate the unit

The `build` and `registry` modes both prepare the optional Compose images selected in
`.env`. The script checks every resolved image in the local Docker store
and exits nonzero if an image is missing. The script leaves running containers
and volumes in place. Use the systemd plan to verify the unit and its destination,
then install and activate the unit after preparation succeeds.

```bash
sh "$source_dir/systemd/stage-systemd.sh" /
sudo sh "$source_dir/systemd/stage-systemd.sh" / --install
sudo systemctl daemon-reload
sudo systemctl enable --now "agil-node@$project.service"
sudo systemctl status "agil-node@$project.service"
```

The plan runs `systemd-analyze verify` without writing to the destination.
Pass an existing staging directory in place of `/` to validate a package
layout. Installation preserves identical files and halts if a destination
contains local changes or is a symlink. Review and install intentional upgrades
separately. Reload and activate systemd explicitly as shown above.

Startup waits for Compose healthchecks, including `/readyz` on the node.
The unit uses local images at boot. A stop sends the agent its shutdown signal
and preserves the project volumes. A restart waits for readiness again.
Inspect startup failures with `sudo journalctl
-u "agil-node@$project.service"`. Use Compose `ps --all` and `logs` with the same
local socket from the project directory. A failed start stops the partially
started project, keeping its containers and volumes available for diagnosis.
Use [the port table](#5-host-firewall) to configure the host firewall.

#### Roll out a registry image with automatic rollback

Use the current unit template and reload systemd after installing it. The
project's Compose file must resolve the node image through `AGIL_NODE_IMAGE`.
Run the update during maintenance, after draining the node and letting
its calls finish. An operator or deployment pipeline supplies the approved
image digest explicitly.

```bash
image='ghcr.io/ORG/IMAGE@sha256:APPROVED_DIGEST'
sudo sh "$source_dir/systemd/rollout-image.sh" "$project" "$image"
```

The script uses the active node's local image ID for rollback and pulls the
requested image before restarting the service. The unit reads the selected
image from `release-image.env` in the project directory. Keep the local
image cache for the duration of the update. The script preserves `.env`,
Compose files and project volumes.

To prepare the approved digest before your maintenance window, download and
verify it with `--prepare`. This leaves the running node and its selected
image in place. During maintenance, pass the same digest with `--offline`
to apply it from the local cache without contacting the registry:

```bash
sudo sh "$source_dir/systemd/rollout-image.sh" "$project" "$image" --prepare
sudo sh "$source_dir/systemd/rollout-image.sh" "$project" "$image" --offline
```

If the approved image is missing from the cache or Docker cannot confirm the
active image ID for rollback, the script stops before restarting the node.
Protect both images from pruning until the maintenance window is complete.
The preparation and rollout commands share a lock in the project's directory.
Keep `.release-image.lock` as a regular file so they can coordinate safely.

##### Check for an approved image on a schedule

The optional `agil-node-prepare@.timer` checks the project hourly, with up to
five minutes of jitter. It downloads the exact digest approved by the operator
when that digest is absent from the local cache. It leaves the running unit
and `release-image.env` as they are. Apply the approved image separately
with `--offline` during maintenance.

```bash
sh "$source_dir/systemd/stage-systemd.sh" / --with-prepare-timer
sudo sh "$source_dir/systemd/stage-systemd.sh" / --install --with-prepare-timer
sudoedit "$stack/approved-image.txt"
sudo systemctl daemon-reload
sudo systemctl enable --now "agil-node-prepare@$project.timer"
```

Save one image reference pinned by SHA-256 in `approved-image.txt`. Keep the
file and project directory owned by root, with write access only for root.
The timer skips projects without that file and skips digests already cached
locally. Remove the file to stop staging that digest, or disable the timer
to stop scheduled checks for the project. For a private registry, configure
read access for the root Docker CLI. Inspect the last attempt with
`sudo journalctl -u "agil-node-prepare@$project.service"`.

A Core drain flag makes the agent's `/readyz` return HTTP 503. The systemd
unit waits for this health check during restart, so a drain that remains active
blocks both rollout and rollback checks. Keep new calls off the node during the
maintenance window using your routing or admission controls. Wait for active
calls to finish, then clear the Core drain flag before restarting the unit.
An automatic restart schedule requires a reliable way to verify zero active calls
and hold admission closed throughout the update.

If startup fails or the expected image does not become active, the script
selects the previous image ID and restarts the service again. Its exit status
is nonzero when the requested update fails, even after successful recovery.
Check the journal if recovery also fails. For projects managed through this
script, the image in `release-image.env` takes precedence over `.env` when
the unit starts.

For manual source updates, stage the new Dockerfile and agent sources and
build under a fresh tag. Review changes to the bundled Compose files and
merge the ones needed by your deployment. Save the previous configuration
and image before restarting the project. When switching a project from a
registry-managed image to a local build, include `release-image.env` in the
backup and move it out of the project before starting with the local
`AGIL_NODE_IMAGE` in `.env`.

##### Apply once during an authorized maintenance window

The optional `agil-node-apply@.timer` checks for a one-time authorization
every five minutes in UTC. Enable it only where the operator can hold admission
closed through another routing control and verify that the node has zero active
calls. Complete those steps before granting the authorization. Clear the Core
drain flag before the restart so readiness can recover while admission remains
closed through the separate control.

```bash
sh "$source_dir/systemd/stage-systemd.sh" / --with-apply-timer
sudo sh "$source_dir/systemd/stage-systemd.sh" / --install --with-apply-timer
sudo systemctl daemon-reload
sudo systemctl enable --now "agil-node-apply@$project.timer"
```

If staging reports an existing helper from an earlier release, review its
changes and install the current version before enabling this timer.

Keep the exact approved SHA-256 image reference in `approved-image.txt` and
prepare it in the local Docker store. After isolating traffic, create the
root-owned `approved-rollout.txt` in the project's directory with `sudoedit`.
Enter a single line with the same digest reference followed by the earliest
and latest permissible start times, in Unix seconds. Obtain those values for
your planned UTC start and cutoff with `date -u -d 'YYYY-MM-DD HH:MM:SS UTC' +%s`.
Allow at most one hour between the times and keep write access restricted to
root. The timer ignores expired windows and does not catch up missed triggers
after downtime. Remove the authorization before the start time to cancel it.

The helper checks the cache and the current image ID for rollback, then moves
the authorization to `last-scheduled-rollout.txt` before applying. An attempted
update gets one scheduled restart and an automatic rollback if needed. Keep
admission closed until readiness and the resulting image have been verified,
even if the scheduled start cutoff has passed. Review the result with
`sudo journalctl -u "agil-node-apply@$project.service"`.

## 3. Feature toggles

`NODE_FEATURES` is a comma list; the role is derived (`sfu` → `sfu`, several
features → `all`). Unknown tokens, and a `NODE_ROLE` that contradicts the
derived role, abort startup.

| `NODE_FEATURES` | Processes | Ports used | Notes |
|---|---|---|---|
| `sfu` (default) | livekit-server | 7880/tcp, 7881/tcp, 50000–50100/udp | needs `LIVEKIT_API_KEY/SECRET` |
| `turn` | coturn | 3478/tcp+udp, 49200–49250/udp, optional 5349/tcp+udp | needs one credential setting and an advertised IP |
| `stun` | coturn | 3478/tcp+udp | `stun-only`, no auth, no relay ports, no password |
| `sfu,turn` | both | all of the above | `turn` already answers STUN; one coturn |
| `sfu,turn,stun` | both | all of the above | full all-in-one node; `stun` is redundant with `turn` and does not start a second process |

`NODE_MEDIA_ENABLED=false` disables bundled processes and retains the
configured features. It still checks an explicitly configured external
LiveKit. `NODE_FEATURES` aliases to `AGIL_NODE_FEATURES` for the quickstart/
Helm `.env`; the same applies to the other `NODE_*` names except the Core
credential names (`AGIL_CORE_URL`, `AGIL_NODE_TOKEN`, `AGIL_NODE_KEY`,
`AGIL_API_KEY`).

Validation that happens before any process starts:

- unknown feature, contradictory `NODE_ROLE`;
- missing LiveKit pair for `sfu`, missing or invalid TURN credential setting for `turn`;
- private/loopback/`0.0.0.0` advertised IP without `TURN_ALLOW_PRIVATE_IP=1`;
- duplicate ports or overlapping SFU/TURN UDP ranges;
- invalid `NODE_ENDPOINT` (URL, no credentials, not a metadata service),
  `NODE_HEALTH_PATH`, `NODE_NAME`/`NODE_REGION` length, capacity JSON,
  heartbeat/TTL/rotation bounds;
- `AGIL_CORE_URL` that is not http(s) or contains credentials (`user:pass@`):
  `fetch()` rejects credential-bearing URLs, so startup fails instead of
  retrying forever with the password echoed into the logs;
- key rotation configured without `AGIL_API_KEY`.

## 4. Configuration

The annotated source of truth is
[`.env.example`](../nodes/all-in-one/.env.example). Groups:

| Group | Variables |
|---|---|
| Core | `AGIL_CORE_URL`, `AGIL_NODE_TOKEN`, `AGIL_NODE_KEY`, `AGIL_API_KEY` |
| Identity | `NODE_ID`, `NODE_NAME`, `NODE_REGION`, `NODE_ENDPOINT`, `NODE_HEALTH_PATH`, `NODE_CAPACITY` |
| Features | `NODE_FEATURES`, `NODE_ROLE`, `NODE_MEDIA_ENABLED` |
| Address | `NODE_PUBLIC_IP`, `TURN_ALLOW_PRIVATE_IP` |
| SFU | `LIVEKIT_API_KEY/SECRET`, `SFU_EXTERNAL_URL`, `SFU_PORT`, `SFU_TCP_PORT`, `SFU_UDP_MIN/MAX_PORT`, `SFU_UDP_MUX_PORT`, `SFU_METRICS_PORT`, `SFU_NODE_IP`, `SFU_USE_EXTERNAL_IP`, `SFU_REDIS_URL`, `SFU_LOG_LEVEL` |
| TURN | `TURN_PASSWORD`, `TURN_STATIC_AUTH_SECRET`, `TURN_PORT`, `TURN_MIN/MAX_PORT`, `TURN_REALM`, `TURN_USER`, `TURN_EXTERNAL_IP`, `TURN_INTERNAL_IP`, `TURN_LISTEN_IP`, `TURN_TOTAL_QUOTA`, `TURN_USER_QUOTA`, `TURN_TLS`, `TURN_TLS_PORT`, `TURN_TLS_HOSTNAME`, `TURN_CERT`, `TURN_PKEY` |
| Agent | `NODE_HEARTBEAT_SEC`, `NODE_KEY_TTL_SEC`, `NODE_KEY_ROTATE_BEFORE_SEC`, `NODE_CONTROL_TOKEN`, `NODE_HTTP_HOST/PORT`, `NODE_LOG_LEVEL`, `NODE_ONCE` |
| Paths | `NODE_STATE_DIR` (default `/var/lib/agil-node`), `NODE_RUNTIME_DIR` (default `/run/agil`) |

`NODE_HTTP_PORT` defaults to 8080 and accepts `AGIL_NODE_HTTP_PORT` when the
canonical name is unset (canonical wins when both are set). The image does not
set `NODE_HTTP_PORT` as an `ENV` on purpose: an image ENV would always shadow
the alias. The image healthcheck reads `NODE_HTTP_HOST` and `NODE_HTTP_PORT`
using the same settings and alias precedence as the listener. It probes an
explicit bind address directly and uses the matching loopback address for a
wildcard bind. Compose inherits the image check. Rebuild the image to apply
this change to an existing Compose deployment.

`NODE_CAPACITY` is a JSON object (`{"maxRooms":10,"maxParticipants":500,
"bandwidthMbps":1000}`). All zeros/omitted means "not reported"; the agent
omits the field from register/heartbeat so it never overwrites a capacity set
in the admin panel with zeros (Core merges every provided field).

`NODE_PUBLIC_IP` is the public IPv4 advertised in ICE/TURN candidates. Behind
cloud 1:1 NAT the host NIC is private: set it explicitly (or `TURN_EXTERNAL_IP`
/ `SFU_NODE_IP`) or media will connect signalling but never flow. Auto-detect
prefers a public NIC address, then any non-internal IPv4, and the private value
is rejected unless `TURN_ALLOW_PRIVATE_IP=1` (LAN/dev only).

## 5. Host firewall

Host networking means there is no Docker port mapping to inspect. Generate a
reviewable ingress plan from your resolved Compose configuration and the
source networks used in your deployment. The command requires Python 3 and
the Compose CLI. It reads the project without requiring a running Docker
Engine.

```bash
sudo sh "$source_dir/systemd/prepare-images.sh" "$stack" "$project" firewall-plan \
  --signaling-cidr 192.0.2.10/32 \
  --media-cidr 198.51.100.0/24 \
  --monitoring-cidr 10.20.0.0/24
```

Replace the example networks with the addresses of your signaling proxy,
media clients or relay network, and monitoring system. Repeat an option for
multiple IPv4 or IPv6 networks. A scope with no source CIDR yields no ingress
rule. An unrestricted network is accepted only when explicitly requested for
signaling or media. Loopback listeners and local Redis produce no ingress
rules. The result lists unresolved bind addresses and additional host-network
services for manual review.

The default output is a JSON plan for a host firewall or cloud security group.
If you manage the host with nftables, rerun the same plan with
`--nftables TABLE CHAIN` to render an append-only batch targeting an existing
`inet` table and chain. For example, generate a batch for a dedicated chain
named `agil_node` in the `host_filter` table.

```bash
sh "$source_dir/systemd/prepare-images.sh" "$stack" "$project" firewall-plan \
  --signaling-cidr 192.0.2.10/32 \
  --media-cidr 198.51.100.0/24 \
  --monitoring-cidr 10.20.0.0/24 \
  --nftables host_filter agil_node > agil-ingress.nft
sudo nft --check --file agil-ingress.nft
```

Review the JSON for services that need manual rules, then verify that the
existing input policy reaches the chosen chain before any terminal drop.
Integrate the rendered rules into the configuration managed by your firewall.
The batch contains `accept` rules only and leaves the existing policies and
unrelated rules in place. Applying the same batch twice appends duplicates.
Rendering and `nft --check` leave the active ruleset unchanged.

Use the table below for default port numbers.

| Port | Proto | Purpose | Public? |
|---|---|---|---|
| 7880 | tcp | LiveKit HTTP/WS signalling | yes (or via TLS edge) |
| 7881 | tcp | LiveKit RTC/TCP fallback | yes |
| 50000–50100 | udp | LiveKit RTC media (`SFU_UDP_*`); with `SFU_UDP_MUX_PORT>0` only that single port is used | yes |
| 3478 | tcp+udp | TURN/STUN | yes |
| 5349 | tcp, udp | TURN/TLS and DTLS when `TURN_TLS=1` | yes, for the transports in use |
| 49200–49250 | udp | coturn relay (`TURN_MIN/MAX_PORT`) | yes |
| 8080 | tcp | agent health/metrics/drain control | no — private network |
| 6789 | tcp | LiveKit Prometheus (`SFU_METRICS_PORT`) | no — or set 0 |

`:8080` is a read surface: `/healthz`, `/readyz`, `/metrics` and `/` are
unauthenticated and the listener binds `0.0.0.0` by default (host networking has
no Docker port mapping to filter them). Only the POST control endpoints require
`NODE_CONTROL_TOKEN` or a loopback client. Keep 8080 off the public firewall;
set `NODE_HTTP_HOST=127.0.0.1` if nothing but local/loopback probes need the
read endpoints.

TLS for signalling is terminated in front of LiveKit (Caddy/Nginx/LB). TURN/TLS
is optional and needs a mounted cert/key pair (`TURN_CERT`/`TURN_PKEY`).

## 6. Enrollment and node-key lifecycle

- Mint a one-time `node` token in the dashboard (Infrastructure) or
  `POST /v1/admin/cluster/tokens {"kind":"node","role":"all","features":["sfu","turn","stun"]}`.
  The token is tenant-scoped and burned on first success. Its `role` must be
  `all` or match the role derived from `NODE_FEATURES` (`sfu,turn` derives
  `all`, so a token minted with `role:sfu` is rejected with 403).
- The returned key (`nk_…`) is shown once. The agent writes it atomically to
  `$NODE_STATE_DIR/node.json` with `0600`; it is never logged and never passed
  to LiveKit/coturn.
- Keep the volume/PVC. Lose it and the node must redeem a new token.
- `POST /v1/nodes/register` rejects a duplicate live `NODE_ID` with 409. Use a
  unique id per node and per tenant.
- `NODE_KEY_TTL_SEC` > 0 makes Core expire the key. Configure
  `NODE_KEY_ROTATE_BEFORE_SEC` (requires `AGIL_API_KEY` allowed to call
  `POST /v1/admin/nodes/:id/rotate-key`) to rotate automatically. Rotation
  invalidates the old key immediately; the agent persists the new one before
  the next heartbeat.
- **Lost rotation response** (network failure after Core rotated): the node
  still has the invalid old key and cannot heartbeat. Recovery: issue another
  rotation as admin and write the new key to `node.json`, or delete
  `node.json` and re-enroll with a fresh token. There is no remote key-push
  channel in this baseline.
- A leaked token is one registration; revoke unused tokens and rotate/disable
  the node record if a key leaks.

## 7. Health, readiness and drain

| Endpoint | Behaviour |
|---|---|
| `GET /healthz` | always 200 while the agent runs; includes uptime, features, media state |
| `GET /readyz` | 200 only when registered, last heartbeat > last failure, heartbeat fresh (≤ 90 s or 3× interval), not draining and every supervised media process running; otherwise 503 with `reason` |
| `GET /metrics` | Prometheus text (see §8) |
| `GET /` | config summary without secrets |
| `POST /v1/control/drain` | `{"drain":true|false}`; local maintenance flag, same readiness effect as Core's |
| `POST /v1/control/rotate-key` | `{"keyTtlSec":…}`; 501 without `AGIL_API_KEY`, 409 while busy, 502 on Core rejection |

Control authentication: `NODE_CONTROL_TOKEN` when set (constant-time compare,
sent as `x-control-token` or `Authorization: Bearer`); otherwise loopback
requests only. Set a token if `:8080` is reachable from anything other than
`docker exec`/the local host.

Drain semantics: `/readyz` 503 removes the node from Kubernetes Service
endpoints and tells an operator not to place new work there. **In-flight calls
continue**; the container keeps running. Core has no scheduler yet, and
`coreDrain` is only what Core reports on the heartbeat — toggling it in the
dashboard does not interrupt media.

Readiness is intentionally not liveness: a freshly started or unenrolled node
is not ready. Docker does not restart a container just for `unhealthy`; use
`/healthz` if an external supervisor needs a liveness probe.

## 8. Metrics

| Metric | Type | Meaning |
|---|---|---|
| `agil_node_up` | gauge | agent process alive (always 1) |
| `agil_node_ready` | gauge | `/readyz` would return 200 |
| `agil_node_readiness_state{reason}` | gauge | one sample for the current `/readyz` reason |
| `agil_node_registered` | gauge | node key present |
| `agil_node_draining` | gauge | Core and/or local drain |
| `agil_node_feature{feature}` | gauge | enabled `NODE_FEATURES` |
| `agil_node_heartbeats_total` | counter | accepted heartbeats |
| `agil_node_heartbeat_failures_total` | counter | failed attempts |
| `agil_node_last_heartbeat_timestamp_seconds` | gauge | Unix time (0 = never) |
| `agil_node_last_heartbeat_age_seconds` | gauge | seconds since success (−1 = never) |
| `agil_node_key_expires_timestamp_seconds` | gauge | key expiry (0 = none) |
| `agil_node_key_rotation_timestamp_seconds` | gauge | last rotation (0 = never) |
| `agil_node_docker_available` | gauge | Docker Engine socket reachable (0 = agent-only node) |
| `agil_node_modules_managed` | gauge | module containers in the last inventory |
| `agil_node_module_results_pending` | gauge | module acknowledgements waiting for the next heartbeat |
| `agil_node_media_up{process,kind}` | gauge | supervised process running |
| `agil_node_media_ready{process,kind}` | gauge | supervised service passes its readiness probe |
| `agil_node_media_restarts_total{process,kind}` | counter | supervisor restarts |
| `agil_node_info{node_id,role,features,version,core}` | gauge | static labels (no secrets) |

**Exposure:** `/metrics` has no authentication and the agent listens on
`NODE_HTTP_HOST` (`0.0.0.0` by default) so it is reachable on every host
interface under host networking. Treat 8080 as a private endpoint:

- firewall `8080/tcp` to the monitoring network (never the public internet);
- scrape `http://<private-ip>:8080/metrics` or, locally,
  `docker compose exec node node -e "fetch('http://127.0.0.1:8080/metrics').then(r=>r.text()).then(console.log)"`;
- `NODE_HTTP_HOST=127.0.0.1` removes the network surface entirely, but also
  makes `/readyz` unreachable for an external probe (use the Docker healthcheck
  or a local agent).

The metric labels contain the node id, role, features, version and the redacted
Core base URL — no token, node key, TURN password or LiveKit secret.

### Monitor the node

On a Linux media host, add the [host exporter override](../nodes/all-in-one/compose.local-monitoring.yml)
to the Compose files you already use. The exporter reads host CPU, memory,
disk and network counters. It defaults to loopback. For a remote Prometheus,
set `AGIL_NODE_EXPORTER_LISTEN` to a private address and restrict the port
to the monitoring host.
The exporter sees the filesystems mounted when its container starts.
Restart the exporter after mounting a new filesystem.

```bash
docker compose -f docker-compose.yml -f compose.local-monitoring.yml up -d node-exporter
curl -fsS http://127.0.0.1:9100/metrics | grep '^node_cpu_seconds_total'
docker compose -f docker-compose.yml -f compose.local-monitoring.yml logs --tail=100 node node-exporter
```

Keep the Redis and media overrides in your regular Compose invocation.
The node keeps five Docker log files of up to 50 MB each. The exporter
keeps three of up to 10 MB each. Use the same Compose project for logs,
updates and rollback to a previous approved image.

Enable the `agil-node-agent` job in the [Prometheus configuration](../deploy/observability/prometheus.yml)
and add the exporter to the existing `node` job. Use private addresses for
both. The [alert rules](../deploy/observability/agil-alerts.yml) distinguish
three cases after two minutes.

- `AgilNodeAgentUnreachable` means Prometheus cannot reach the agent. Check
  the private scrape address, firewall, container and its logs.
- `AgilNodeHeartbeatUnhealthy` means the agent is reachable but registration
  or reporting to Core is down. Check `agil_node_readiness_state`, the
  agent logs and the node status in Core.
- `AgilNodeMediaUnready` means the named LiveKit or coturn service failed
  its probe. Check the service logs and ports. A planned drain suppresses
  this media alert.

Prometheus lists these states at `/alerts`. Configure the Alertmanager
target in Prometheus if you need notifications to an external destination.

### Docker add-on modules (optional)

If the Docker Engine socket is mounted into the container, the agent also
reports the Core's allowlisted Docker add-ons. The catalog describes which
actions apply to each kind of deployment. See the
[service lifecycle table](#service-lifecycle-in-infrastructure-and-compose).
It uses the same `modules.mjs` as
`agil/infra/node-agent/modules.mjs`:

- `NODE_MODULES=auto|on|off` (default `auto`) and `NODE_DOCKER_HOST`
  (`unix:///var/run/docker.sock`, `DOCKER_HOST` fallback) control it. With no
  socket the agent logs one line and heartbeats without a `modules` snapshot
  (agent-only node); media and readiness are unaffected.
- Containers must carry `agil.module=<id>` and `agil.node=<this node id>`; only
  those are reported/touched. The dashboard never supplies an image or command:
  `install` always uses the catalog image from the Core command, re-validated
  against the node-side allowlist.
- Command results are acknowledged as `moduleResults` on a later heartbeat and
  persisted (mode `0600`) in the state volume (`module-commands.json`).
- Optional node-local env values live in `module-env.json` in the state volume;
  they are passed to Docker and never logged/reported/sent to the Core.
- Mounting the socket is root-equivalent host access: do it only for nodes that
  should run AGIL add-ons. The full contract is in
  [`nodes/all-in-one/README.md`](../nodes/all-in-one/README.md#docker-add-on-modules-optional)
  and `agil/infra/node-agent/README.md`.

#### Module credentials and rotation

Keep operator values in protected files or the local secrets store of each
deployment. The dashboard displays configuration status and the audit trail
for module commands. Provision shared keys separately to each service that
uses them. The node's command and inventory reports carry neither key values
nor node-local environment values.

| Service | Where credentials are configured | What to verify after a change |
|---|---|---|
| Node agent | One-time enrollment token on the node. The resulting node key lives in the state volume. | Rotate through Core and provide the new key to the node. Confirm a fresh heartbeat and rejection of the old key. [Node key API](api/cluster.md). |
| LiveKit SFU and Ingress | LiveKit API credentials in the service configuration. Core and the Ingress worker receive the credentials required for their own calls. | Join an SFU room, start a test input and confirm that Core can stop it. For a shared credential, stage coordinated changes across all consumers. [Ingress configuration](#start-a-local-rtmp-ingress-worker). |
| TURN | coturn signing key on the relay. Core receives the associated key through its operator configuration. | Drain the affected relay before changing its key, confirm a new allocation with the new key, and restore eligibility after a fresh readiness report. Keep another relay available for new calls. [TURN operations](operations.md#temporary-coturn-credentials). |
| Egress | Worker configuration holds the storage writer credentials. Core receives the read credentials needed for playback. | Complete a new recording, open its signed playback link, and verify access after revoking the old credential. [Egress storage](egress-production.md#6-storage-s3--minio--cdn). |
| STT | Worker token on the node and matching `AGIL_STT_KEY` in Core. | Keep the previous token during the Core rollout. After removing it, confirm HTTP 401 with that token and continued transcription with the new token. [STT rotation](../nodes/stt/README.md#ротация-токена-воркера). |
| SIP | Worker configuration and trunk credentials on the operator's SIP infrastructure. | Reconfigure the trunk in the provider and test incoming and outgoing calls on the designated test number. [SIP setup](sip.md). |

On Linux, keep `module-env.json` readable only by the node agent's service
account (`0600`). Module installation rejects malformed files, symlinks, and
files with broader permissions. When the file supplies module settings, the
agent requires a node-local Docker endpoint. Docker errors during creation
or start use a brief operation message in the panel and logs.

For an independently deployed LiveKit with a multi-key configuration, add
the new key alongside the current one during a maintenance window. Verify
both credentials, update the external SFU agent and each configured consumer,
then remove the old key. Confirm authenticated readiness with the new key
and rejection of the old one. The single-instance QA scenario restarts
LiveKit between these stages and verifies reuse of the node registration.
LiveKit rotation scenario.

#### Recording storage and health

| Recording path | Storage and retention | Health to check |
|---|---|---|
| LiveKit Egress (server recording) | Write to the configured private S3 bucket. Apply the organization's retention period with an S3 lifecycle policy. Include versioned objects, if enabled. [Retention and backup](egress-production.md#14-retention-and-backup). | Check worker and Redis readiness, complete a recording, and verify that Core can read it. [Egress health](egress-production.md#12-health-monitoring-and-alerting). |
| Browser recording uploaded to Core | The built-in recording store uses `AGIL_RECORDINGS_DIR` (default `<AGIL_DATA_DIR>/recordings`). Persist that directory and remove expired records through the admin recordings API under your retention policy. Files downloaded only to the user's device follow device policy. | Check Core and test an upload and a download. The Egress worker is not involved. |
| Existing Recorder container | Inspect its volume or bind mounts and inventory the stored files before removing the container. Removal preserves the attached data and discards the container's writable layer. Apply retention at the existing storage backend, or migrate the data to storage governed by your lifecycle policy. | The dashboard reflects the container's Docker healthcheck. Confirm its output and storage separately. |

For server-side recording on a new node, deploy LiveKit Egress. The Recorder
catalog entry keeps lifecycle controls for containers already in service and
cannot install them. Apply the retention policy to existing data where it lives.

To move new recording jobs from an existing Recorder to Egress, first locate and
back up the Recorder's volume or object-storage data using its deployment
configuration. Check that the backup contains the expected recordings. Configure
Egress with a storage writer and Core with a separate reader, then complete a
test recording and verify playback. Switch new jobs to Egress after this check.
Keep the legacy archive and its metadata available for the organization's
retention period. The Core recording upload API can store a supported legacy
file as a new room recording. It assigns a new recording ID and creation time.
Historical Recorder entries have no import route into the Egress job list.

## 9. Operations

```bash
# health (from the host; 8080 is not public)
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
curl -fsS http://127.0.0.1:8080/metrics

# maintenance drain (loopback works without NODE_CONTROL_TOKEN)
curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"drain":true}' http://127.0.0.1:8080/v1/control/drain

# logs: agent lines are JSON, media lines are passed through unstructured
docker compose logs -f node

# upgrade: rebuild/replace the image; the state volume keeps the key
docker compose up -d --build

# backup/restore the only secret (keep it 0600; it is a bearer credential)
tar -C /var/lib/docker/volumes/<project>_node-state/_data -czf node-state.tgz node.json
```

Upgrade procedure: drain → confirm `/readyz` 503 → `docker compose up -d
--build` (or pull the new digest) → wait for `/readyz` 200 → undrain. A container
stop sends `offline` to Core, so the dashboard does not wait 90 s.

State recovery: if `node.json` is corrupt/unreadable the agent logs a warning
and needs a new enrollment token (the old token was burned). If the volume is
restored, no token is needed. On load the agent also re-asserts `0600` on an
existing `node.json`: a restored volume with group/world-readable permissions is
tightened before the key is used (POSIX; logged as a warning, and a failed
`chmod` is logged without discarding the key).

## 10. Security

- Secrets: `.env` is runtime-only (gitignored); the node key is only in the
  state volume (`0600`, re-asserted on load); LiveKit keys go through
  `LIVEKIT_KEYS` (never written to disk by the agent); the TURN credential is
  written to a `0600` file in tmpfs (`/run/agil`), never to argv/logs.
  `configSummary` and `/metrics` are tested not to contain any credential.
- `AGIL_CORE_URL` is validated to be credential-free (`user:pass@` is a startup
  error); the startup log, `GET /` and the `agil_node_info{core=…}` metric also
  pass the URL through `redactUrl()` as defence in depth, so a config assembled
  without the loader still cannot leak a password.
- The container runs as uid 1000 (`node`), read-only root, `cap_drop: ALL`,
  `no-new-privileges`; writable paths are the state volume, `/run/agil` and
  `/tmp`.
- Media children get a scrubbed environment (`PATH`, `HOME`, `LANG`, `TZ`, …);
  they never see `AGIL_NODE_TOKEN`, the node key or `AGIL_API_KEY`.
- TURN hardening: `no-multicast-peers`, `no-loopback-peers`, `no-cli`,
  fingerprint; the relay range is separate from SFU media ports. The TURN
  credential is static — use TURN/TLS or rotate it with the `.env`.
- LiveKit strict config is enabled upstream; the renderer emits only fields
  accepted by `livekit-server` (notably it does **not** emit the rejected
  `prometheus.bind_addresses`). The Prometheus listener therefore binds all
  interfaces on the host — firewall 6789 or disable it with
  `SFU_METRICS_PORT=0`.
- `AGIL_API_KEY` is an admin credential used only for key rotation; scope it and
  do not pass it if automatic rotation is not used. `NODE_CONTROL_TOKEN` should
  be at least 8 random characters.
- No mTLS in this baseline; use HTTPS to Core. Host networking means the host
  firewall is the security boundary.

### Supply chain (digest pinning)

The Dockerfile pins **tags**, not digests:

| Artifact | Pin | Notes |
|---|---|---|
| Agent runtime | `node:22-bookworm-slim` | Node 22 LTS, maintenance until 2027-04-30 |
| LiveKit | `livekit/livekit-server:v1.13.11` | same tag as `agil/core/deploy/livekit` |
| coturn / CA | Debian bookworm `coturn`, `ca-certificates` | no version lock (`apt-get install` in the Dockerfile) |

For a reproducible/verifiable build, resolve the manifest digests and pin them
in the `FROM` lines (the build ARG keeps the readable version next to the
digest):

```bash
docker buildx imagetools inspect node:22-bookworm-slim
docker buildx imagetools inspect livekit/livekit-server:v1.13.11
# then, in the Dockerfile:
#   FROM node:22-bookworm-slim@sha256:<digest>
#   FROM livekit/livekit-server:v1.13.11@sha256:<digest>
```

The release workflow adds SBOM/provenance; a digest-pinned build is still the
way to prove the bytes that ran. The Debian package layer remains tag/archive
pinned — pin the base digest plus an `apt-get` snapshot for full reproducibility.

## 11. Validation and tests

Executed on the finishing host (Windows; **Docker CLI unavailable**; the test
suite was run on the host Node **23.11.0** and again on Node **22.23.5**, the
image's LTS line):

- `node --check` on all 8 agent modules — clean (also under Node 22).
- `npm run test:node-image` — **84 tests, 83 pass, 0 fail, 1 skipped** (the
  POSIX-SIGTERM spawn test is skipped on Windows; the same shutdown path is
  covered in-process by `main({installSignalHandlers: false})`). The same
  command under `npx --yes node@22 --test "agil/core/nodes/all-in-one/test/*.test.mjs"`
  is also **84 tests, 83 pass, 0 fail, 1 skipped**.
- `npm run typecheck` — clean for every workspace (the node image adds only
  plain `.mjs`, so it has no TS project of its own).
- `npm test` — the node-image suite passes as part of the chain. A full monorepo
  run also hit one **unrelated flaky** assertion in
  `@agil/calls-server` (`cluster.test.ts` P2-R `retry-after` 59 vs 60, a timing
  window); a standalone `npm run test -w @agil/calls-server` run passed
  259/259, and the earlier full run passed the same suite. This predates and is
  outside the node-image change.
- `npm run build` — passed after pointing `TMP`/`TEMP` at a workspace-local
  `.tmp` directory. The first attempt failed in `@agil/calls-widget` inside
  esbuild's temp-file cleanup (`vite:esbuild-transpile remove … Access is
  denied`) for the Windows `%LOCALAPPDATA%\Temp` path; retrying with `TMP`/`TEMP`
  inside the repo succeeded for every workspace. This is an environment/temp-ACL
  issue, not a node-image change.
- `python -c "import yaml; yaml.safe_load(...)"` for `docker-compose.yml`,
  `ci-js.yml` and `release-images.yml` — syntactically valid YAML;
  `${VAR}` interpolation references and `.env.example` keys were cross-checked.
- Rendered LiveKit YAML (node_ip, mux, Redis/TLS, metrics-off variants) was
  parsed back with PyYAML; the coturn config was checked line-by-line against
  the expected options.
- `docker compose config --quiet` and `docker build` passed in WSL for the
  Linux amd64 QA image `agil-node-all-in-one:qa-turn-tls`. The build resolved
  LiveKit v1.13.11 and installed Debian coturn 4.6.1.
- The image ran as `node` with a read-only root. The bundled coturn test used
  a disposable Core fixture and a test certificate. It checked registration,
  the ready heartbeat and advertised TLS port, HTTP readiness, certificate
  trust in a TLS client, relay packets over UDP/TCP and the offline heartbeat.
  Run the scenario against the image with `AGIL_QA_TURNSERVER`,
  `AGIL_QA_TURNCLIENT`, `AGIL_QA_TURN_TLS_CERT` and `AGIL_QA_TURN_TLS_KEY`.
- The same image ran LiveKit only, coturn only, and both together in three
  fresh agent runs using a Core fixture. The test checks the exact process
  set, `/healthz`, `/readyz`, and the ready and offline heartbeats. Run the
  `image media process selection` test in the Linux image with
  `AGIL_QA_LIVEKIT_BIN=/usr/local/bin/livekit-server` and
  `AGIL_QA_TURNSERVER=/usr/bin/turnserver`.

Covered by tests:

| Area | Evidence |
|---|---|
| Feature toggles | unknown/contradictory settings fail; `sfu`/`turn`/`stun`/all plan exactly the expected processes |
| Config validation | public/private/loopback IP, port/range collisions, TLS, capacity, metadata URL, rotation bounds |
| Media supervisor | scrubbed child env, 0600 runtime files, start/stop, missing-binary cleanup, restart backoff, failed-restart recovery then a later crash is restarted |
| LiveKit config | exact ports/range/node_ip, Redis forms, no secret in YAML, no rejected `bind_addresses` |
| coturn config | TURN vs STUN-only, credential in `0600` file, external-ip/internal-ip, TLS pair, pidfile/loopback hardening |
| Health | readiness matrix, drain reasons, 200/503, 404/405/400/401, rotate 501/502/200 |
| Metrics | valid Prometheus lines, one HELP/TYPE per name, no secrets, URL userinfo redacted from the `core` label |
| Core client | register payload, no zero-capacity overwrite, heartbeat drain/offline, expired/disabled/network errors, rotation |
| Heartbeat metrics | fake-`/proc` CPU/memory/load/uptime/NIC deltas, no first-beat CPU/bandwidth, malformed files omitted, protocol range clamps, no fake room counts, no secret in the snapshot |
| State | atomic 0600 round-trip, corrupt/missing file, `0600` re-asserted on a restored file |
| Agent e2e | one-shot enroll+heartbeat exit 0, rejected enrollment exit 1, state-key import, Core drain, local drain, graceful offline (POSIX) |
| Artifacts | Dockerfile/compose/.env invariants, Node 22 LTS base, LiveKit pin consistency, `/readyz` port alias parity (expression evaluated), doc links |

Not covered here (requires Docker + a real network/host):

1. Real LiveKit signalling + WebRTC in 3 rooms, coturn relay allocation over a
   public IP, and public TURN/TLS certificate validation.
2. `docker compose up` and the `/readyz` healthcheck lifecycle in the deployed
   topology.
3. Image size/CVE scan, SBOM (release workflow adds SBOM/provenance).

The manual acceptance script is: one node + three rooms through the SFU, a
participant forced to TURN relay (`iceTransportPolicy: 'relay'`) on a different
network, verify relay traffic on 49200–49250/udp, kill a media process and see
restart + `/readyz` 503/200, then drain and observe 503 without dropping the
call.

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ConfigError: the sfu feature needs LIVEKIT_API_KEY…` | fill the pair, or remove `sfu` from `NODE_FEATURES` |
| `the turn feature needs TURN_PASSWORD or TURN_STATIC_AUTH_SECRET` | set one (no space/`#`/`:`), or use `stun` only |
| `… is a private (RFC1918/CGNAT) address` | set `NODE_PUBLIC_IP` to the public IPv4; only a LAN trial may use `TURN_ALLOW_PRIVATE_IP=1` |
| `/readyz` 503 `not_registered` | no state key and no token; mint a one-time token or restore the volume |
| `/readyz` 503 `heartbeat_failing` | check Core URL/HTTPS, token revocation, key expiry; logs show the Core envelope |
| `/readyz` 503 `heartbeat_stale` | event loop blocked or network loss; check CPU and Core reachability |
| `/readyz` 503 `draining` | Core or local drain flag is set; undrain with the control endpoint |
| `/readyz` 503 `media_down` | inspect `docker compose logs node`; supervisor restarts with backoff, `agil_node_media_up` is 0 |
| media restarts in a loop | port already in use (check `ss -lunp`), bad cert path, or binary missing (`ENOENT` on the initial start fails the container; a restart failure is retried with backoff) |
| signalling works, no media | UDP range/relay ports blocked, or a private advertised IP; check firewall and `SFU_NODE_IP`/`TURN_EXTERNAL_IP` |
| `NODE_HTTP_PORT … already in use` | another agent/process on 8080; change `NODE_HTTP_PORT` (or `AGIL_NODE_HTTP_PORT` when the canonical name is unset) |
| `AGIL_CORE_URL must not contain credentials` | remove `user:pass@` from the URL; the node authenticates with the enrollment token/node key headers |
| container `unhealthy` while the agent logged a listener on 9099 | the probe and agent disagree on the port: use one of `NODE_HTTP_PORT`/`AGIL_NODE_HTTP_PORT`, not both with different values (canonical wins) |
| a media restart failed once (`fatal` in `/healthz`) but the process runs again | the successful start cleared `fatal`; the next crash is restarted normally |
| a duplicate `NODE_ID` gets 409 | use a unique id per node; the old record must be deleted/renamed first |

## 13. Limitations

- **No Docker execution on the finishing host.** Build, compose startup and
  live media were not run; see §11. This is an explicit gap, not a claim.
- **Core integration is registry-only.** Core does not place rooms on nodes or
  probe `endpoint/healthPath`; `drain` is a signal without a scheduler. See
  `CLUSTER_BASELINE_LIMITATIONS` in `@agil/protocol`.
- **Single-process supervision model.** The agent restarts children with
  exponential backoff, but it is not a general init: no per-process cgroups,
  no log rotation inside the container (Docker `json-file` limits in compose).
  A failed restart is never permanent: a successful (re)start clears the
  `fatal` diagnostic, so a recovered binary keeps being restarted on the next
  crash.
- **Node 22 is a maintenance LTS.** `node:22-bookworm-slim` is supported through
  2027-04-30; rebuild the image with the next Node LTS (24) before that date.
  The agent itself only requires Node >= 20.
- **Tag-only supply-chain pins.** The base image, LiveKit stage and Debian
  packages are tag/archive pinned; resolve digests for a reproducible build
  (§10).
- **Host networking only.** Bridge/NAT would advertise an unreachable address;
  Docker Desktop is unsuitable for real media. One node owns all features on a
  host — split roles by running separate nodes with different `NODE_FEATURES`.
- **Node metrics are host-level.** CPU/memory/load/uptime/bandwidth come from
  `/proc` and describe the host that runs the container (host networking), not a
  single LiveKit room. `activeRooms`/`participants` are not reported because the
  agent has no authenticated LiveKit client; they are omitted, never zero-filled.
  `bandwidthMbps` is all non-loopback NIC traffic, not media-only.
- **Static TURN credential.** No per-call TURN REST credentials or credential
  rotation; use TURN/TLS and a strong password, rotate with the `.env`.
- **No automatic key-push after a lost rotation response.** Recovery is manual
  (§6).
- **`stun` combined with `turn` is redundant.** It is accepted and reported as a
  feature, but no second coturn is started.
- **Prometheus endpoint has no bind option in LiveKit.** It is exposed on the
  host; firewall it or set `SFU_METRICS_PORT=0`.

## 14. Related docs

- [`agil/core/docs/deployment.md`](deployment.md) — Core deployment.
- `agil/core/docs/qa-turn.md` — TURN QA checklist.
- `agil/core/docs/sfu-smoke.md` — SFU smoke test.
- [`agil/core/docs/sfu-multinode.md`](sfu-multinode.md) — multi-node LiveKit.
- [`agil/core/docs/operations.md`](operations.md) — monitoring/runbooks.
- [`agil/core/docs/api/cluster.md`](api/cluster.md) — enrollment/registry API.
- [`agil/core/docs/ci.md`](ci.md) — images/release workflow.
- `agil/core/docs/qa-node-ha.md` — QA of this image + Core HA
  (finding status; this round fixed N-P2 media-restart, `AGIL_CORE_URL`
  userinfo, healthcheck alias and the Node 23 base).
