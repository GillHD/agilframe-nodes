# AGIL node agent (reference)

A dependency-free Node.js agent that registers a node with AGIL Core and keeps
its record alive. It is **optional**: the default quickstart and `agil-node`
chart run the first-party CLI (`agil/core/scripts/agil-cli.mjs`) inside the
standard `agil-calls` image, with no extra image. Use this agent only when you
want node-local `/healthz`, `/readyz` and Prometheus `/metrics` endpoints; it
implements the same enrollment contract and is not part of the default path.
It does not proxy media, allocate TURN ports or run LiveKit. It only owns:

1. **enrollment** — `POST /v1/nodes/register` with a one-time token;
2. **heartbeat** — `POST /v1/nodes/:id/heartbeat` every 30 s with the returned
   node key;
3. **health** — `/healthz`, `/readyz` and Prometheus `/metrics` on `:8080`;
4. **Docker modules** (optional) — reports the node's allowlisted add-on
   containers (`modules`) and executes the Core's `install/start/stop/restart/
   remove` commands from the heartbeat response through the Docker Engine
   socket, acknowledging each on a later heartbeat (`moduleResults`). Without a
   Docker socket the agent runs as an agent-only node and keeps heartbeating.

## Build and run

```bash
docker build -t agil-node-agent:0.1.0 agil/infra/node-agent

docker run --rm -p 8080:8080 \
  -e AGIL_CORE_URL=http://host.docker.internal:8787 \
  -e AGIL_NODE_TOKEN='agil_enr_...' \
  -e AGIL_NODE_ROLE=sfu \
  -e AGIL_NODE_FEATURES=sfu \
  -v agil-node-state:/var/lib/agil-node \
  agil-node-agent:0.1.0
```

The token is burned on the first successful registration; the returned node key
is written to `/var/lib/agil-node/node.json` with mode `0600`. Keep that volume:
restarts then only need heartbeats, not a new token.

Already have a node key? Pass `AGIL_NODE_KEY=nk_...` instead of a token.

Docker modules are opt-in at the runtime level: mount the Docker socket (and add
the agent's group to the host `docker` group) when the node should manage add-on
containers. Without the mount the agent logs one line and keeps heartbeating as
an agent-only node:

```bash
docker run --rm -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  ...same env/volume as above...
  agil-node-agent:0.1.0
```

Mounting the Docker socket gives the agent root-equivalent control of the host:
do it only for nodes that should run AGIL add-ons, keep the socket off untrusted
paths, and never expose the Docker API over TCP in production (`tcp://` exists
for local/dev/test use; this agent does not implement Docker TLS).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AGIL_CORE_URL` | `http://127.0.0.1:8787` | Core base URL; use HTTPS across the internet |
| `AGIL_NODE_TOKEN` | — | One-time enrollment token (`agil_enr_…`), burned after use |
| `AGIL_NODE_KEY` | — | Pre-issued node key (`nk_…`); skips enrollment |
| `AGIL_NODE_ID` | container hostname | Unique node id; a live duplicate is rejected with 409 |
| `AGIL_NODE_NAME` | hostname | Display name |
| `AGIL_NODE_ROLE` | `sfu` | `sfu`, `turn`, `stun` or `all` |
| `AGIL_NODE_FEATURES` | role | Comma list recorded on the node (e.g. `sfu,egress`) |
| `AGIL_NODE_REGION` | — | Free-form region label |
| `AGIL_NODE_ENDPOINT` | — | Informational media URL (core does not probe it yet) |
| `AGIL_NODE_HEALTH_PATH` | `/health` | Informational health path recorded on the node |
| `AGIL_NODE_CAPACITY` | `{}` | JSON capacity hint, e.g. `{"maxRooms":10,"maxParticipants":500}` |
| `AGIL_NODE_HEARTBEAT_SEC` | `30` | Local fallback interval. The agent uses the interval returned by Core after registration and on each heartbeat. |
| `AGIL_NODE_HTTP_PORT` / `_HOST` | `8080` / `0.0.0.0` | Health/metrics listener |
| `AGIL_NODE_STATE_DIR` | `/var/lib/agil-node` | Where `node.json` (node key) is stored |
| `AGIL_NODE_ONCE` | `false` | Register + one heartbeat, then exit (CI/jobs) |
| `AGIL_NODE_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`; logs are JSON lines |
| `AGIL_NODE_MODULES` | `auto` | Docker modules: `auto` (probe, degrade to agent-only), `on` (warn loudly if absent), `off` |
| `AGIL_NODE_DOCKER_HOST` | `unix:///var/run/docker.sock` | Docker Engine endpoint: `unix://`, `npipe://`, `tcp://`; falls back to `DOCKER_HOST` |
| `AGIL_NODE_DOCKER_TIMEOUT_MS` | `15000` | Docker API timeout for list/inspect/lifecycle calls |
| `AGIL_NODE_MODULE_PULL_TIMEOUT_MS` | `600000` | Timeout for an `install` image pull |
| `AGIL_NODE_MODULE_ENV_FILE` | `<state-dir>/module-env.json` | Node-local module env values (never logged/reported) |
| `AGIL_NODE_MODULE_TEMPLATES_FILE` | `<state-dir>/module-templates.json` | Node-local custom image catalog with optional isolated installation |

For a rate-limited heartbeat, the agent waits for Core's `Retry-After` delay
when it exceeds the usual interval. Pending module results stay queued until
Core accepts the heartbeat.

## Endpoints

| Path | Code | Purpose |
|---|---|---|
| `/healthz` | 200 while the process is up | liveness |
| `/readyz` | 200 when the last heartbeat is fresh (≤ 3 intervals / 90 s) | readiness |
| `/metrics` | 200 | `agil_node_up`, `agil_node_ready`, heartbeat counters, last-heartbeat age |
| `/` | 200 | version/role/features summary plus `modules` capability (`mode`, `available`, `managed`, `pendingResults`) |

`/readyz` returns 503 before the first successful heartbeat, which is correct:
an unenrolled node is not ready. Do not use it as a liveness probe.

## Heartbeat metrics

Every heartbeat carries a best-effort host snapshot under `metrics` (Core's
`nodeMetricsInputSchema`; every field is optional, and an older Core strips the
unknown key, so the heartbeat stays backward compatible):

| Field | Source | Notes |
|---|---|---|
| `cpuPercent` | `/proc/stat` delta between heartbeats | 0–100; omitted on the first beat (no baseline) |
| `memoryPercent` | `/proc/meminfo` (`MemTotal` − `MemAvailable`) | 0–100 |
| `load1` | `/proc/loadavg` (`os.loadavg` fallback off-Windows) | 1-minute load average |
| `uptimeSec` | `/proc/uptime` | host uptime; agent process uptime where `/proc` is unavailable |
| `bandwidthMbps` | `/proc/net/dev` rx+tx delta, non-loopback NICs | over the interval since the previous beat; omitted on the first beat |
| `version` | `AGENT_VERSION` | `0.1.0` |
| `reportedAt` | agent clock | epoch-ms |
| `activeRooms` / `participants` | — | not reported: this agent owns no room state, so the fields are omitted rather than faked |

A failed, missing or malformed `/proc` file only drops that field; the heartbeat
is always sent. No secret (enrollment token, node key) is part of the snapshot.
The collector is [`metrics.mjs`](metrics.mjs), tested in
[`test/metrics.test.mjs`](test/metrics.test.mjs).

## Docker modules (heartbeat `modules` / `moduleCommands`)

The Core owns the module allowlist (`agil/core/apps/server/src/node-modules.ts`);
this agent is the node-side executor. Nothing here is user-configurable from the
dashboard: the agent accepts lifecycle commands only for catalog module ids.

**Discovery.** Every heartbeat carries a full inventory snapshot discovered from
Docker containers that carry both labels:

| Label | Value | Meaning |
|---|---|---|
| `agil.module` | Lowercase ID up to 32 characters, starting with a letter and containing letters, digits or hyphens | inventory identifier |
| `agil.node` | this node's id | ownership — another node's container is never reported or touched |
| `agil.module.kind` | Optional classification in the same format as the ID | type shown for a non-catalog container |
| `agil.module.lifecycle` | `true` | requests start, stop and restart controls for this custom container |
| `agil.managed` | `true` | set by the agent on containers it created |

Each report is derived only from Docker state, never fabricated: `status` from
the container state (`running`/`stopped`/`error`/`unknown`, a restart loop is
`error`), `health` from Docker's health check (`unknown` when the image has
none, `degraded` while the first check is still starting), `version` from the
image's `org.opencontainers.image.version` label or the image tag, `ports` from
published host ports (or `EXPOSE`d ports under host networking), `updatedAt`
from the container's last state change. Catalog containers can report an error
from Docker. Custom containers only report the exit code when available.
Catalog ids are reserved for their allowlisted repositories. Custom IDs appear
in the dashboard. For example, set `agil.module=cache-a`,
`agil.module.kind=cache` and `agil.node=<node-id>` in the container's Compose
configuration. Use a distinct ID for each container you want shown. An omitted
snapshot means the Core keeps the previous inventory. An empty snapshot means
Docker answered and no matching containers were found.

**Optional custom container controls.** Add `agil.module.lifecycle=true` to
the container's Docker or Compose labels when local operators approve remote
start, stop and restart. Both Core and the agent must support the option.
The node checks the exact Docker container ID and node label on each action
and rejects duplicate module IDs. It also rejects privileged and auto-remove
containers, host or shared namespaces, extra capabilities or devices, custom
runtime/security overrides and bind mounts. Ordinary local Docker volumes
without driver options and tmpfs mounts are accepted. If a container changes
or fails a check, its controls are unavailable. Use Docker directly to
remove a container deployed manually or manage an image.

### Node-local image templates

To list approved images in Infrastructure, set
`AGIL_NODE_MODULE_TEMPLATES_FILE` or write `module-templates.json` in the
agent state directory. The all-in-one image also accepts
`NODE_MODULE_TEMPLATES_FILE`. On Linux, the file must be a regular file owned
by the agent user or root and must not be writable by the group or others.
Set its mode to `0600` and keep it in an operator-controlled directory.

```json
[
  {
    "id": "cache-a",
    "image": "registry.example/team/cache@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "install": true,
    "resources": { "cpuMillicores": 750, "memoryMiB": 384, "pidsLimit": 48 }
  }
]
```

Replace the example with the approved image repository and manifest digest.
Use an explicit registry and up to 16 distinct custom IDs in a file of at
most 16 KiB. Each entry accepts `id`, `image`, an optional boolean
`install`, `resources`, `envRefs`, `storageVolume`, `commandArgs`, and
`restartPolicy`.
Omit `install` to show the template without permitting remote
installation. Invalid configuration clears the list on the next full
inventory report. Populate the cache through the host's authorized Docker
workflow.

In the admin panel, open the node's modules in **Infrastructure**, then
select **Prepare template**. Enter a custom ID, the approved image digest
and any resource, volume or environment reference settings. Copy the JSON
or download it. The exported array contains one entry. If the node already
has a template file, merge that entry into the existing array.
The panel prepares a draft in the browser. The node operator reviews it,
applies it locally and caches the image. After the next inventory report,
refresh the module list to install an approved template with `install: true`.

For an existing reported template, select **Prepare changes** beside it.
The form starts from the last digest and resource limits the node reported.
To change the restart policy, select its current value from the local file
and a different target value. A missing local value means `no`. The export
includes `expected.restartPolicy` only when you choose this change.
On a new template, **Startup arguments** accepts a JSON array of 1 to 16
strings for Docker `Cmd`. To update an existing template, select **Change
startup arguments**, enter the current array from the node file, then enter
the proposed array. Leave the current field empty when `commandArgs` is
absent. The export uses `expected.commandArgs: null` in that case. Compare
the expected array to the local value in the same order before applying
`changes.commandArgs`. Remove the field in the local file to restore the
image's default arguments. Keep credentials in the node-local environment file.
Use **Add or replace** or **Remove from template** for the volume,
environment references, or readiness check. Enter the volume name, the names
in `envRefs`, or the `healthcheck` object from the local file before making
the change. A blank baseline denotes an absent volume or check. An empty
`expected.envRefs` matches an absent or empty list. Compare names as a set.
For a healthcheck, compare its fields and keep the exact order of its command
arguments. The form carries the original check as entered, including any
omitted timing options. The same check form is used for new and changed
settings. The agent still verifies the volume, the local environment file,
and readiness when applying an approved replacement.
The export lists the expected values and only the proposed changed fields.
On the correct node, compare `expected` to the current entry with that ID.
For a template without a `resources` field, compare the effective default
limits. If the values match, apply only the fields under `changes` to the
existing entry. For `null` in `changes`, delete that field from the entry.
If they differ, refresh the inventory and prepare the changes again.
Removing the volume field detaches it on the next replacement and keeps
the Docker volume. Removing a reference leaves the node's environment file
intact. Removing the readiness check stops the explicit template probe on
the next replacement. The node agent omits the volume name, environment
references, healthcheck, startup arguments and configured restart policy
from reports to Core. The browser exports the draft locally.
Cache a newly approved digest before returning to Infrastructure.
After applying changes to the local file, refresh the module inventory. If
the image digest is unchanged, select **Apply settings**. The agent creates a
new container from the same cached image and replaces the running container
only after the candidate passes its startup checks. If the replacement
fails, the previous container remains in operation. A container installed
by an older agent may offer this action once to record its applied profile.
The agent retains the profile fingerprint in its private state and reports
only that new settings are available.

#### Set the container command arguments

In the local template entry, use an array such as
`"commandArgs": ["--listen", "127.0.0.1:8080"]`. It replaces the image's
Docker `CMD`. Docker keeps the image's `ENTRYPOINT` and receives each item
as a separate argument. If the image has no entrypoint, specify the
executable as the first item. Leave the field out to use the image defaults.

Set 1 to 16 arguments of at most 512 UTF-8 bytes each. The agent reads
these arguments only for the node-local Docker endpoint and checks the
result before starting the new container. Changing the file affects
future installations and replacements. Use **Apply settings** for changed
arguments with the same image digest. A replacement keeps its previous container if the approval
changes during startup. The arguments stay on the node and Docker
inspect can display them. Use local environment references for credentials.

#### Require a healthcheck before accepting an installation

Set `healthcheck` in the approved template on the node.

```json
{
  "healthcheck": {
    "command": ["/app/check-ready", "--local"],
    "intervalSec": 2,
    "timeoutSec": 1,
    "retries": 3,
    "startupTimeoutSec": 20
  }
}
```

The command runs inside the isolated container through Docker `CMD` exec
form. It needs an executable and accepts up to 16 arguments of at most 512
UTF-8 bytes each. The interval is 1–30 seconds, the command timeout is 1–10
seconds, retries are 1–5, and the installation timeout is 2–90 seconds and
must exceed the interval. The values above are the defaults for omitted
timing fields. Use a command that works without network access or writes to
the container's root filesystem.

The agent waits for Docker to report `healthy` before accepting the new
container. During a replacement, the previous container keeps running until
this check passes. If the new container fails or times out, the agent
removes the candidate. The panel gets a health status and a short error.
Command arguments and probe output stay on the node. Templates without this
field retain the image defaults and existing startup behavior.

#### Declare ports on an approved private network

Templates use no network by default. To connect private services, create
a dedicated IPv4 Docker bridge on the node. Set `node_id` and `module_id`
to the registered node ID and the local template ID.

```bash
docker network create --internal \
  --opt com.docker.network.bridge.gateway_mode_ipv4=isolated \
  --label "agil.node=$node_id" --label "agil.module=$module_id" \
  --label agil.module.network=true "private-$module_id"
```

Use the returned full Docker network ID as `networkId` in the local
template. Add `ports` with one to eight distinct pairs such as
`[{"port":8088,"protocol":"tcp"}]`. TCP and UDP ports from 1 to 65535 are
accepted. The agent verifies the exact network ID, owner, local bridge driver
and isolated gateway mode before creating the container or accepting a
replacement. It declares the ports in Docker and publishes none on the host.
Only the declared port numbers and protocols appear in Infrastructure.

The template form can prepare these two fields together. For an existing
template, select **Prepare changes** and enter the current network ID and
ports from the local file, or indicate that the template currently has no
network. Compare both expected values before merging the proposed changes
on the node. The resulting network identifier stays local.

Attach trusted peers to this module's bridge. Port declarations describe the
service and do not filter traffic between members of the same bridge. For
healthchecks use loopback inside the module. After replacing a container,
refresh the peer's target as needed because Docker can assign a new address.
Docker documents the interface isolation of this gateway mode.
[Docker network gateway modes](https://docs.docker.com/engine/network/port-publishing/#gateway-modes).

#### Limit restarts after a process failure

Set `"restartPolicy": "on-failure"` for a locally approved template.
Docker makes at most three automatic restart attempts after a nonzero
exit. This policy is available through the node-local Docker endpoint.
Manual stop keeps the container stopped and a Docker daemon restart
does not cause an automatic start.
[Docker restart policies](https://docs.docker.com/reference/cli/docker/container/run/#restart).

Omit the field or use `"restartPolicy": "no"` for the default without
automatic retries. The operator chooses the policy in the local JSON.
Changes apply when the container is recreated. The agent verifies the
policy before startup and retains the previous container's policy if a
replacement is rolled back.

#### Attach approved read-only data

On the node, create one named Docker volume using the ordinary local
driver. Label it with the exact node and template IDs.

```bash
docker volume create --driver local \
  --label "agil.node=${NODE_ID}" \
  --label "agil.module=${MODULE_ID}" \
  --label agil.module.storage=true agil-model-data
```

Prepare the data in that volume on the node. The isolated workload runs
as UID/GID 65534 and needs read access to its files. Add
`"storageVolume": "agil-model-data"` to the matching template entry.
The name can contain up to 64 letters, digits, periods, underscores and
hyphens, starting with a letter or digit.

The agent checks the labels, local scope, local connection and local
driver without options. Docker mounts the volume at `/agil-data` as
read-only and skips copying image files into the volume. The panel
shows the profile and any availability problem. The volume name stays
on the node. Container removal, failed installation and replacement keep
volume data. A volume with missing or changed approval blocks the
associated actions until the operator resolves it on the node.

#### Reference local environment values

Add `"envRefs": ["CACHE_AUTH_TOKEN"]` to the template entry. Add the
referenced value under the same module ID in the node's `module-env.json`:

```json
{
  "cache-a": {
    "CACHE_AUTH_TOKEN": "<local-value>"
  }
}
```

The file defaults to the agent state directory. Set
`AGIL_NODE_MODULE_ENV_FILE` to override it. The all-in-one node also
accepts `NODE_MODULE_ENV_FILE`. Use a regular file up to 64 KiB. On Linux,
keep it owned by the agent user or root with permissions `0600`.
Each template can select up to 16 distinct variable names. Each selected
value must be a non-empty string of at most 4,096 UTF-8 bytes.
Use a local Unix socket, local Windows named pipe, or numeric loopback
Docker endpoint. Remote Docker endpoints cannot receive these values.

The agent verifies the local file and selected values before installing
or replacing a container. Infrastructure shows when the environment is
unavailable. After correcting the file, refresh **Modules** after the
next node heartbeat. Variable names and values stay on the node. Docker applies
the selected values to the container's environment, available to local
Docker administrators through the normal container inspection workflow.
Use **Apply settings** after rotating values for an existing container
that keeps the same image digest.

Set any of the following integer limits in `resources`. Omitted fields
use the defaults shown below.

| Field | Default | Allowed range |
| --- | ---: | ---: |
| `cpuMillicores` | 500 (0.5 CPU) | 100–8,000 |
| `memoryMiB` | 256 | 64–8,192 |
| `pidsLimit` | 64 | 16–512 |

The PID limit covers processes and threads. The Docker memory and
memory-plus-swap limits are equal. An invalid field or value invalidates
the local file. Infrastructure shows the limits for the next installation.
Changes are applied when installing or replacing a container. Select
**Apply settings** to replace a container with the same image digest.

To install an opted-in image, open **Infrastructure**, expand the online
node's **Modules**, and choose **Install** under **Node templates**. A
fresh report must confirm the exact digest in Docker, a Linux image with
no declared volumes, and no existing container using the module ID.
Update Core and the node agent before opting an image into installation.
The card distinguishes a missing digest, an incompatible image, and a
failed Docker inspection. For an incompatible image, review its platform
and Dockerfile `VOLUME` declarations on the node.
The agent verifies the file and cached image again before creating the
container. Docker runs the image's own entrypoint as UID/GID 65534 with
a read-only root filesystem, no network by default, and the configured read-only
volume when present. The isolated profile drops all capabilities and
uses no added devices or Docker log storage. Restart on daemon startup is disabled. Approve
an image only if its own entrypoint and filesystem requirements fit this
profile. A successful Docker start may be followed by normal process exit
for short-lived images. Use Docker or Compose on the node for custom
commands, storage, networking and other runtime profiles.

The agent checks the process 700 ms after Docker acknowledges the start.
If startup fails or the process has already exited with a nonzero code,
the agent removes the container created by that command and keeps the
image and volumes. A successful process that exits with code 0 can remain
as a stopped container. Later failures are visible in current inventory.

The module card offers **Remove** when the agent can confirm installation
provenance from its local command state file and the current Docker
inspection. A running container is stopped first. The image and volumes are
kept. Keep the node's command state file in a private persistent directory
across agent upgrades. Containers installed before provenance tracking or
before state loss still support the approved start, stop and restart actions.

### View Docker log entries

An operator can set `agil.module.logs=true` on a container that already
has this agent's `agil.node` and a unique `agil.module`. Use a readable
Docker log driver and disable TTY. In **Infrastructure**, expand the
node's **Modules**, then **Docker log entries** on the module card. Docker
profiles with logging disabled have no event viewer.

The agent reads up to 16 entries for up to four opted-in containers per
inventory. Docker supplies the timestamp and stream. Recognized levels
come from a JSON `level` or `severity` field or a level prefix such as
`[WARN]`. The agent sends levels, times and streams. Message text remains
on the node. Timeouts, unavailable drivers and responses larger than
32 KiB appear as unavailable. The tenant admin panel uses the latest
fresh snapshot, held in Core memory.

### Replace or restore an image version

Change the running module's approved entry in `module-templates.json` to
the desired cached image digest and leave `install: true`. Wait for the
next inventory report, open **Infrastructure**, expand **Modules**, and
select **Replace image** on that entry under **Node templates**.

The agent checks the running container's local installation record and
exact Docker ID. It launches the approved image with the same isolated
profile. Only after the candidate stays running through the startup
check does the agent stop the old container. Then it checks both
containers again, records the new ID and removes the old container.
A candidate that fails startup is removed while the old one keeps
running. If replacement fails after stopping the old container, the
agent attempts to restart that exact container and clean up the candidate.
Cached images and Docker volumes are kept.

To return to a previous version, approve its cached digest on the node
and repeat **Replace image**. Each replacement creates a new container.
The procedure checks early process startup and leaves later runtime
problems visible in the inventory. If the agent or Docker is interrupted
mid-replacement and neither outcome can be confirmed, inspect both
containers on the node before retrying.

### Heartbeat example

Sample heartbeat request (one running egress container, one stopped TURN
container):

```jsonc
{
  "capacity": {},
  "features": ["sfu", "turn"],
  "status": "online",
  "metrics": { "cpuPercent": 12.5, "uptimeSec": 86400, "reportedAt": 1732230000000 },
  "modules": [
    {
      "id": "egress",
      "image": "agil/node-egress:0.1.0", // container image, catalog repository
      "status": "running",
      "health": "healthy",
      "version": "0.1.0",               // image label or tag; omitted if unknown
      "updatedAt": 1732229990000        // Docker state-change time (epoch ms)
    },
    {
      "id": "turn",
      "image": "coturn/coturn:4.6",
      "status": "stopped",
      "health": "unknown",
      "version": "4.6",
      "ports": [3478, 5349],
      "updatedAt": 1732229000000
    }
  ],
  "moduleResults": [
    { "commandId": "nmc_0123456789abcdef", "ok": true, "status": "running" }
  ]
}
```

**Commands.** The heartbeat response always carries `moduleCommands` (each
delivered by exactly one beat). The agent validates every command again on the
node: required `nmc_<16 hex>` id, allowlisted `moduleId`/`action`, unexpired
`expiresAt`, and for catalog `install` an image from the preset repository
(`agil/node-stt` or `coturn/coturn`). These presets accept tags and digests
from the same repository. Official `livekit/egress` and `livekit/sip`
containers appear in inventory. Their deployment and lifecycle are managed
by Compose. Installed legacy `agil/node-egress` and `agil/node-sip`
containers keep lifecycle controls. The agent rejects new install commands
for these legacy workers before a Docker call. Actions are
executed through the Docker Engine API against the node-owned container only:

- `install` — pull the command image, then (re)use the owned container: start it
  if stopped, create+start it with the node labels and the catalog ports if
  absent. Idempotent; an existing container is never recreated (use `remove` +
  `install` to change image/tag).
  If startup fails after creation, the agent tries to remove the new container without force. If Docker confirms the container is already running, the agent reports a successful install. Any cleanup failure is included in the command result.
  To exercise the rollback against a disposable Docker Engine, run `sudo node agil/core/qa/node-autostart-restart-e2e.mjs --install-rollback` from the repository root on Linux or WSL.
- `start` / `stop` / `restart` — lifecycle calls; already-running/stopped is a
  success (`304`), `start`/`restart` of a missing module is a failed result.
- `remove` — force-remove the owned container; removing an absent module is an
  idempotent success.

Command execution is serialized and runs off the heartbeat path so a slow image
pull cannot delay the next beat. Each executed command produces one
`{commandId, ok, status, error?}` (`error` bounded to 300 chars, one line) that
is sent as `moduleResults` on a later heartbeat. Results (and a bounded
executed-id memory) are persisted to `<state-dir>/module-commands.json`
(mode `0600`), so a restart re-sends an unacknowledged result and never executes
a re-delivered command twice; acknowledgements are removed only after a `200`
heartbeat. The queue is bounded (32 results; the protocol maximum).

**Failure behaviour.** A missing, permission-denied or unreachable Docker socket
is expected, not fatal: the agent logs once, omits `modules` (no invented
inventory), keeps heartbeating, and acknowledges any command as failed
(`Docker Engine is not reachable on this node`). Setting
`AGIL_NODE_MODULES=off` disables Docker access entirely (`/` still shows the
mode). With a Docker daemon that starts later, the next heartbeat re-probes and
resumes reporting.

**Env values stay on the node.** If an installed module needs configuration
(see the catalog's env hints), create `<state-dir>/module-env.json`
(or point `AGIL_NODE_MODULE_ENV_FILE` at it):

```json
{
  "stt": { "STT_MODEL_PATH": "/models/whisper-small" },
  "turn": { "TURN_REALM": "calls.example" }
}
```

Values are read at install time and passed to Docker (`Env`) only. They are
never logged, never sent to the Core, never part of a module report or a command
result. Without the file the container is created with no env. The file should
be `0600` and live on the node (not in a ConfigMap/image).

## Security notes

- The enrollment token is read from the environment and never logged; logs are
  JSON and intentionally exclude request bodies.
- The node key is persisted with `0600`; protect the volume/PVC and do not bake
  it into images or ConfigMaps.
- Always use `https://` for a remote core. There is no mTLS in this baseline;
  the token/key are bearer credentials.
- A leaked enrollment token is one registration. Revoke unused tokens in core;
  rotate a node key with `POST /v1/admin/nodes/:id/rotate-key` (the old key stops
  working immediately) or disable/delete the record and re-enroll.
- The container runs as uid 1000 with a read-only root filesystem expectation
  (Helm values), no added capabilities and `no-new-privileges`.
- Docker modules: the socket mount is root-equivalent host access. Enable it
  only on nodes that should run AGIL add-ons; the agent never accepts an image,
  command or env value from the Core/dashboard, only the five allowlisted
  module ids/actions and the catalog image for `install`. `module-env.json`
  holds node-local values (`0600`); no value is ever logged, reported or sent to
  the Core.

## Development

```bash
node --check agil/infra/node-agent/agent.mjs
node --check agil/infra/node-agent/metrics.mjs
node --check agil/infra/node-agent/modules.mjs
npm run test:node-agent   # fake Core + fake /proc + fake Docker Engine API; one-shot exits 0 on Windows/Node 23
AGIL_NODE_ONCE=true \
AGIL_CORE_URL=http://127.0.0.1:8787 \
AGIL_NODE_TOKEN=... \
AGIL_NODE_STATE_DIR=/tmp/agil-node \
node agil/infra/node-agent/agent.mjs
```

The module tests start a fake Docker Engine API on loopback TCP
(`AGIL_NODE_DOCKER_HOST=tcp://127.0.0.1:<port>`) and never touch a real
container or the host socket; `test/modules.test.mjs` covers discovery,
allowlist/ownership rejection, install/start/stop/restart/remove, result
persistence and the no-socket fallback, and `test/agent.test.mjs` covers the
heartbeat `modules`/`moduleResults` round-trip end to end.

No npm install, no build step, no runtime dependencies beyond Node 20+ (uses
global `fetch` and `AbortSignal.timeout`).

## Limitations / replacement

- The registry contract is provisional (core-side enrollment API); this agent
  tracks it. If the API changes, update this file and the quickstart/chart env
  names together.
- No media supervision, no local room allocation, no TURN credential rotation.
- Docker modules are only the five Core-catalog add-ons; there is no free-form
  plugin/image support. Module containers are created with the catalog ports and
  optional node-local env, `unless-stopped` restart policy, and are addressed by
  the `agil.module`/`agil.node` labels (rename a container by hand and it stops
  being managed). `install` reuses an existing owned container instead of
  recreating it, and results survive a restart only through
  `<state-dir>/module-commands.json`. No Docker TLS/mTLS: `tcp://` is for
  local/dev/test, production uses the mounted socket/pipe.
- In **Инфраструктура → Модули**, an administrator can change an installed
  module's auto-start policy. The agent reports `autoStart` for Docker policies
  `unless-stopped` and `no`, updates the policy in place, and reports the result
  on heartbeat. Use **Запустить** separately for a manually stopped module.

  To verify auto-start across Docker Engine restarts, run
  `sudo node agil/core/qa/node-autostart-restart-e2e.mjs` from the repository
  root on Linux or WSL. The scenario needs a locally cached `coturn/coturn:4.6`
  image. It copies that image to a disposable Docker Engine with its own Unix
  socket and data directory, checks both policies against real daemon restarts,
  and verifies that an explicitly stopped container stays stopped.
  [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/).
- Heartbeat metrics are host-level (`/proc`): the agent has no LiveKit/room state,
  so `activeRooms`/`participants` are omitted (never sent as zeros), and
  `bandwidthMbps` is host NIC throughput, not per-room media traffic.
- Core does not probe the node's endpoint/health path yet, so heartbeat
  liveness is the only signal.
- Future first-party agent: keep this image name/contract out of customer
  manifests and switch `image.repository` in the node chart.
