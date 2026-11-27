# syntax=docker/dockerfile:1
# AGIL reference node agent — kit-owned glue, not a first-party product image.
# Build (from this directory):
#   docker build -t agil-node-agent:0.1.0 .
# It contains three dependency-free Node scripts (agent + metrics collector +
# Docker module manager); no npm install, no build step.
FROM node:23-alpine

LABEL org.opencontainers.image.title="agil-node-agent" \
      org.opencontainers.image.description="AGIL node enrollment + heartbeat agent (reference implementation)" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.source="https://example.invalid/agil/infra"

WORKDIR /app

# The state directory holds the node key returned by enrollment (mode 0600).
RUN mkdir -p /var/lib/agil-node && chown -R node:node /app /var/lib/agil-node

COPY --chown=node:node agent.mjs /app/agent.mjs
COPY --chown=node:node metrics.mjs /app/metrics.mjs
# Docker add-on module discovery/commands (Docker Engine socket). Optional at
# runtime: without the socket the agent runs as an agent-only node.
COPY --chown=node:node modules.mjs /app/modules.mjs

USER node
ENV NODE_ENV=production \
    AGIL_NODE_STATE_DIR=/var/lib/agil-node \
    AGIL_NODE_HTTP_PORT=8080
EXPOSE 8080
VOLUME ["/var/lib/agil-node"]

# Readiness based: an unenrolled node is legitimately not ready. Use /healthz
# for liveness if the container runtime restarts unhealthy containers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AGIL_NODE_HTTP_PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/agent.mjs"]
