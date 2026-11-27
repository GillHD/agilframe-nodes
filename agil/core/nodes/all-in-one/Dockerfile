# syntax=docker/dockerfile:1
# AgilFrame — first-party all-in-one media node image.
#
# One container, one PID 1 (the dependency-free Node agent), up to two children:
#   livekit-server  SFU: signalling + RTC        (NODE_FEATURES contains "sfu")
#   turnserver      coturn: TURN and/or STUN     (NODE_FEATURES contains "turn"/"stun")
#
# The agent enrolls the node with Core, supervises the media processes, sends
# heartbeats, serves /healthz, /readyz, /metrics and the drain/rotate control
# endpoints, and reports `offline` on SIGTERM. See:
#   agil/core/docs/node-image.md
#   agil/core/nodes/all-in-one/README.md
#
# Build (from this directory — the build context is this directory only):
#   docker build -t agil-node:0.1.0 .
#   docker build --build-arg LIVEKIT_VERSION=v1.13.11 -t agil-node:0.1.0 .
#
# Host networking is required for real media (ICE candidates and the coturn
# relay must advertise the host's public address); the compose file uses it.
# No secret is baked into the image: the node key lives in the state volume and
# the LiveKit/TURN credentials are injected at runtime.
#
# Supply chain: LiveKit is copied from the official pinned image (the same tag
# used by agil/core/deploy/livekit), coturn comes from the Debian bookworm
# archive. Both are tag-pinned; resolve the digests and pin them for stricter
# reproducibility:
#   docker buildx imagetools inspect node:22-bookworm-slim
#   docker buildx imagetools inspect livekit/livekit-server:v1.13.11
#   # FROM node:22-bookworm-slim@sha256:<digest>
#   # FROM livekit/livekit-server:v1.13.11@sha256:<digest>
# See agil/core/docs/node-image.md §10 (Supply chain).
#
# Base image: Node 22 LTS (`node:22-bookworm-slim`). Node 22 is a supported LTS
# line in maintenance until 2027-04-30; move to the next LTS (Node 24) before
# that date — the agent only needs Node >= 20 (global fetch, no dependencies).

ARG LIVEKIT_VERSION=v1.13.11
FROM livekit/livekit-server:${LIVEKIT_VERSION} AS livekit

FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="agil-node-all-in-one" \
      org.opencontainers.image.description="AgilFrame all-in-one media node: LiveKit SFU + coturn TURN/STUN + enrollment/health agent" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="Apache-2.0 AND BSD-3-Clause"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    NODE_STATE_DIR=/var/lib/agil-node \
    NODE_RUNTIME_DIR=/run/agil \
    NODE_LOG_LEVEL=info
# NODE_HTTP_PORT is deliberately NOT an image ENV: an ENV value would always win
# over the documented `AGIL_NODE_HTTP_PORT` alias (see readEnv in agent/config.mjs).
# The agent defaults to 8080 and the healthcheck below uses the same precedence.

# coturn has no dependency-free static release in Debian; the package is the
# supported path. ca-certificates is needed for TURN/TLS chains. The image does
# NOT install a compiler or npm packages: the agent is dependency-free JS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates coturn \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/agil-node /run/agil /opt/agil-node \
 && chown -R node:node /var/lib/agil-node /run/agil /opt/agil-node

# The LiveKit image ships the server as a static Go binary at /livekit-server.
COPY --from=livekit /livekit-server /usr/local/bin/livekit-server
COPY --chown=node:node agent/ /opt/agil-node/agent/

WORKDIR /opt/agil-node

# Ports are documentation with host networking (compose sets network_mode:
# host). Open them on the host firewall, not in a Docker port mapping:
#   7880/tcp  LiveKit HTTP/WS signalling        8080/tcp  agent health/metrics
#   7881/tcp  LiveKit RTC/TCP fallback         3478/tcp,udp  TURN/STUN
#   50000-50100/udp  LiveKit RTC media          5349/tcp  TURN/TLS (TURN_TLS=1)
#   49200-49250/udp  coturn relay              6789/tcp  LiveKit metrics
EXPOSE 7880/tcp 7881/tcp 50000-50100/udp 3478/tcp 3478/udp 5349/tcp 49200-49250/udp 8080/tcp 6789/tcp

VOLUME ["/var/lib/agil-node"]

USER node

# Readiness, not liveness: an unenrolled node is legitimately not ready. Docker
# does not restart a container merely for an unhealthy healthcheck; use /healthz
# for liveness if the supervisor needs a stricter signal. The readiness probe
# reads the same bind address and port as the agent.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["node", "/opt/agil-node/agent/readyz.mjs"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/opt/agil-node/agent/index.mjs"]
