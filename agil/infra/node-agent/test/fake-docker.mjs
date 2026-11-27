/**
 * Fake Docker Engine API for the node-agent tests.
 *
 * Speaks the small subset of the real Engine API that `modules.mjs` uses, over
 * loopback TCP (`AGIL_NODE_DOCKER_HOST=tcp://127.0.0.1:<port>`): ping/version
 * negotiation, container list/inspect/create/start/stop/restart/remove and
 * image pull. Tests pre-seed containers or inspect the recorded calls; **no real
 * container is ever touched**.
 *
 * The shape of every payload mirrors the Docker Engine API v1.4x so a mismatch
 * in `modules.mjs` (inspect path, status fields, port bindings) fails the test
 * instead of passing accidentally.
 */

import { createServer } from 'node:http';

const API_VERSION = '1.45';

let sequence = 0;

function nextContainerId() {
  sequence += 1;
  return `ctr_${String(sequence).padStart(16, '0')}`;
}

function isoNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
  });
}

function labelFilters(rawQuery) {
  const url = new URL(rawQuery, 'http://docker.test');
  const filters = url.searchParams.get('filters');
  if (!filters) return [];
  try {
    const parsed = JSON.parse(filters);
    return Array.isArray(parsed?.label) ? parsed.label.map(String) : [];
  } catch {
    return [];
  }
}

function matchesLabels(labels, filters) {
  return filters.every((filter) => {
    const equals = filter.indexOf('=');
    if (equals >= 0) return labels[filter.slice(0, equals)] === filter.slice(equals + 1);
    return Object.prototype.hasOwnProperty.call(labels, filter);
  });
}

function summaryOf(container) {
  return {
    Id: container.Id,
    Names: [`/${container.Name}`],
    Image: container.Config.Image,
    ImageID: `sha256:${'0'.repeat(64)}`,
    Command: '',
    Created: container.Created,
    Labels: container.Config.Labels,
    State: container.State.Running ? 'running' : container.State.Status,
    Status: container.State.Running ? 'Up 1 minute' : 'Exited (0) 1 minute ago',
    Ports: Object.entries(container.NetworkSettings.Ports).flatMap(([key, bindings]) => {
      const [port, type] = key.split('/');
      return (bindings ?? []).map((binding) => ({
        IP: binding.HostIp,
        PrivatePort: Number(port),
        PublicPort: Number(binding.HostPort),
        Type: type,
      }));
    }),
  };
}

/**
 * @param {object} [options]
 * @param {boolean} [options.pingFails] make `/_ping` answer 500 (daemon down)
 */
export async function startFakeDocker(options = {}) {
  /** @type {Map<string, object>} */
  const containers = new Map();
  const pulls = [];
  const requests = [];
  let pingFails = Boolean(options.pingFails);

  function addContainer({
    id = nextContainerId(),
    moduleId,
    nodeId,
    image,
    name = `agil-${moduleId}-${nodeId}`,
    running = false,
    exitCode = 0,
    health = null,
    error = '',
    ports = [],
    labels = {},
    createdAt = isoNow(-60_000),
    startedAt = running ? isoNow(-30_000) : '',
    finishedAt = running ? '' : isoNow(-20_000),
  }) {
    const exposed = {};
    const bindings = {};
    for (const entry of ports) {
      const key = typeof entry === 'string' ? entry : `${entry.port}/${entry.protocol ?? 'tcp'}`;
      exposed[key] = {};
      if (entry && typeof entry === 'object' && entry.hostPort) {
        bindings[key] = [{ HostIp: '0.0.0.0', HostPort: String(entry.hostPort) }];
      }
    }
    const container = {
      Id: id,
      Name: name,
      Created: createdAt,
      Config: {
        Image: image,
        Labels: {
          ...(moduleId ? { 'agil.module': moduleId } : {}),
          ...(nodeId ? { 'agil.node': nodeId } : {}),
          ...labels,
        },
        Env: [],
        ...(Object.keys(exposed).length > 0 ? { ExposedPorts: exposed } : {}),
      },
      State: {
        Status: running ? 'running' : 'exited',
        Running: running,
        Paused: false,
        Restarting: false,
        Dead: false,
        ExitCode: running ? 0 : exitCode,
        Error: error,
        StartedAt: startedAt,
        FinishedAt: finishedAt,
        ...(health
          ? { Health: { Status: health, FailingStreak: health === 'unhealthy' ? 3 : 0, Log: [] } }
          : {}),
      },
      NetworkSettings: { Ports: bindings },
      HostConfig: { NetworkMode: 'default' },
    };
    containers.set(id, container);
    return container;
  }

  function containerOr404(id, res) {
    const container = containers.get(id) ?? [...containers.values()].find((entry) => entry.Name === id);
    if (!container) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: `No such container: ${id}` }));
      return null;
    }
    return container;
  }

  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = null;
    if (raw.trim() !== '') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { __invalid: raw };
      }
    }
    const url = new URL(req.url ?? '/', 'http://docker.test');
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const json = (status, payload) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' && url.pathname === '/_ping') {
      if (pingFails) {
        res.statusCode = 500;
        res.end('daemon unavailable');
        return;
      }
      res.setHeader('Api-Version', API_VERSION);
      res.setHeader('Docker-Experimental', 'false');
      res.statusCode = 200;
      res.end('OK');
      return;
    }

    const versioned = url.pathname.replace(new RegExp(`^/v\\d+\\.\\d+`), '');
    const match = (pattern) => pattern.exec(versioned);

    // GET /containers/json?all=1&filters=…
    if (req.method === 'GET' && versioned === '/containers/json') {
      const filters = labelFilters(url.pathname + (url.search || ''));
      const list = [...containers.values()]
        .filter((container) => matchesLabels(container.Config.Labels, filters))
        .map(summaryOf);
      json(200, list);
      return;
    }

    // GET /containers/{id}/json
    let hit = match(/^\/containers\/([^/]+)\/json$/);
    if (req.method === 'GET' && hit) {
      const container = containerOr404(decodeURIComponent(hit[1]), res);
      if (container) json(200, container);
      return;
    }

    hit = match(/^\/images\/([^/]+)\/json$/);
    if (req.method === 'GET' && hit) {
      const image = decodeURIComponent(hit[1]);
      if (options.failImageInspections?.includes(image)) {
        json(500, { message: 'internal image error' });
        return;
      }
      const inspection = options.imageInspections?.[image];
      if (inspection) json(200, inspection);
      else json(404, { message: 'No such image' });
      return;
    }

    hit = match(/^\/containers\/([^/]+)\/logs$/);
    if (req.method === 'GET' && hit) {
      const logs = options.moduleLogs?.[decodeURIComponent(hit[1])];
      if (!logs) json(404, { message: 'logs unavailable' });
      else {
        res.statusCode = 200;
        res.end(logs);
      }
      return;
    }

    hit = match(/^\/volumes\/([^/]+)$/);
    if (req.method === 'GET' && hit) {
      const name = decodeURIComponent(hit[1]);
      const volume = options.volumeInspections?.[name];
      if (volume) json(200, volume);
      else json(404, { message: 'No such volume' });
      return;
    }

    // POST /images/create?fromImage=…&tag=…
    if (req.method === 'POST' && versioned === '/images/create') {
      const fromImage = url.searchParams.get('fromImage') ?? '';
      const tag = url.searchParams.get('tag') ?? '';
      const image = tag && tag !== 'latest' ? `${fromImage}:${tag}` : fromImage;
      pulls.push({ image, fromImage, tag });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      if (options.failPullImages?.includes(image)) {
        res.end(`${JSON.stringify({ errorDetail: { message: 'manifest unknown' }, error: 'manifest unknown' })}\n`);
        return;
      }
      res.end(`${JSON.stringify({ status: 'Pulling from library' })}\n${JSON.stringify({ status: 'Downloaded newer image' })}\n`);
      return;
    }

    // POST /containers/create?name=…
    if (req.method === 'POST' && versioned === '/containers/create') {
      const name = url.searchParams.get('name') ?? '';
      if ([...containers.values()].some((container) => container.Name === name)) {
        json(409, { message: `Conflict. The container name "/${name}" is already in use` });
        return;
      }
      if (!body || typeof body.Image !== 'string' || body.Image === '') {
        json(400, { message: 'image is required' });
        return;
      }
      const id = body.HostConfig?.NetworkMode === 'none'
        ? `ca${nextContainerId().slice(4).padStart(62, '0')}`
        : nextContainerId();
      const exposed = body.ExposedPorts ?? {};
      const portBindings = body.HostConfig?.PortBindings ?? {};
      const container = {
        Id: id,
        Image: body.Image,
        Name: name,
        Created: isoNow(),
        Config: {
          Image: body.Image,
          User: body.User ?? '',
          Labels: { ...(body.Labels ?? {}) },
          Env: Array.isArray(body.Env) ? [...body.Env] : [],
          ...(Array.isArray(body.Cmd) ? { Cmd: options.transformCreatedCommand?.(body.Cmd) ?? body.Cmd } : {}),
          ...(body.Healthcheck ? { Healthcheck: body.Healthcheck } : {}),
          ...(Object.keys(exposed).length > 0 ? { ExposedPorts: exposed } : {}),
        },
        State: {
          Status: 'created',
          Running: false,
          Paused: false,
          Restarting: false,
          Dead: false,
          ExitCode: 0,
          Error: '',
          StartedAt: '',
          FinishedAt: '',
        },
        NetworkSettings: {
          Ports: Object.fromEntries(
            Object.entries(portBindings).map(([key, value]) => [key, Array.isArray(value) ? value : []]),
          ),
        },
        HostConfig: body.HostConfig ?? {},
        Mounts: (body.HostConfig?.Mounts ?? []).filter(({ Type }) => Type === 'volume').map((mount) => ({
          Type: 'volume', Name: mount.Source, Destination: mount.Target, RW: !mount.ReadOnly,
          Driver: options.volumeInspections?.[mount.Source]?.Driver ?? 'local',
        })),
      };
      containers.set(id, container);
      if (options.failCreateResponseImages?.includes(body.Image)) {
        json(500, { message: 'create result unavailable' });
        return;
      }
      json(201, { Id: id, Warnings: [] });
      return;
    }

    // POST /containers/{id}/start
    hit = match(/^\/containers\/([^/]+)\/start$/);
    if (req.method === 'POST' && hit) {
      const container = containerOr404(decodeURIComponent(hit[1]), res);
      if (!container) return;
      if (container.State.Running) {
        res.statusCode = 304;
        res.end();
        return;
      }
      if (options.failStartImages?.includes(container.Config.Image)) {
        json(500, { message: 'container start failed: address already in use' });
        return;
      }
      container.State = {
        ...container.State,
        Status: 'running',
        Running: true,
        ExitCode: 0,
        Error: '',
        StartedAt: isoNow(),
        FinishedAt: '',
      };
      const exitCode = options.exitAfterStartCodes?.[container.Config.Image];
      if (exitCode !== undefined) setTimeout(() => {
        container.State = { ...container.State, Status: 'exited', Running: false, ExitCode: exitCode, FinishedAt: isoNow() };
      }, 20).unref();
      await options.afterStart?.(container);
      if (options.failStartResponseImages?.includes(container.Config.Image)) {
        json(500, { message: 'start result unavailable' });
        return;
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    // POST /containers/{id}/stop?t=
    hit = match(/^\/containers\/([^/]+)\/stop$/);
    if (req.method === 'POST' && hit) {
      const container = containerOr404(decodeURIComponent(hit[1]), res);
      if (!container) return;
      if (!container.State.Running) {
        res.statusCode = 304;
        res.end();
        return;
      }
      container.State = {
        ...container.State,
        Status: 'exited',
        Running: false,
        ExitCode: options.stopExitCodes?.[container.Config.Image] ?? 0,
        StartedAt: '',
        FinishedAt: isoNow(),
      };
      res.statusCode = 204;
      res.end();
      return;
    }

    // POST /containers/{id}/restart?t=
    hit = match(/^\/containers\/([^/]+)\/restart$/);
    if (req.method === 'POST' && hit) {
      const container = containerOr404(decodeURIComponent(hit[1]), res);
      if (!container) return;
      container.State = {
        ...container.State,
        Status: 'running',
        Running: true,
        ExitCode: 0,
        Error: '',
        StartedAt: isoNow(),
        FinishedAt: '',
      };
      res.statusCode = 204;
      res.end();
      return;
    }

    // POST /containers/{id}/update
    hit = match(/^\/containers\/([^/]+)\/update$/);
    if (req.method === 'POST' && hit) {
      const container = containerOr404(decodeURIComponent(hit[1]), res);
      if (!container) return;
      if (!['no', 'unless-stopped'].includes(body?.RestartPolicy?.Name)) {
        json(400, { message: 'Invalid restart policy' });
        return;
      }
      container.HostConfig.RestartPolicy = body.RestartPolicy;
      json(200, { Warnings: [] });
      return;
    }

    // DELETE /containers/{id}?force=1&v=1
    hit = match(/^\/containers\/([^/]+)$/);
    if (req.method === 'DELETE' && hit) {
      const id = decodeURIComponent(hit[1]);
      if (!containers.has(id)) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: `No such container: ${id}` }));
        return;
      }
      if (containers.get(id).State.Running && url.searchParams.get('force') !== '1') {
        json(409, { message: 'cannot remove a running container without force' });
        return;
      }
      if (options.failRemoveIds?.includes(id)) {
        json(500, { message: 'container removal failed' });
        return;
      }
      containers.delete(id);
      res.statusCode = 204;
      res.end();
      return;
    }

    json(404, { message: `unknown fake Docker route: ${req.method} ${url.pathname}` });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    url: `tcp://127.0.0.1:${port}`,
    port,
    requests,
    pulls,
    containers,
    addContainer,
    setPingFails(value) {
      pingFails = Boolean(value);
    },
    get pingFails() {
      return pingFails;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/** Build a valid `NodeModuleCommand` for tests. */
const CATALOG_IMAGES = Object.freeze({
  egress: 'agil/node-egress:0.1.0',
  stt: 'agil/node-stt:0.1.0',
  recorder: 'agil/node-recorder:0.1.0',
  turn: 'coturn/coturn:4.6',
  sip: 'agil/node-sip:0.1.0',
});

let commandSequence = 0;

export function moduleCommand(moduleId, action, overrides = {}) {
  commandSequence += 1;
  return {
    id: `nmc_${commandSequence.toString(16).padStart(16, '0')}`,
    moduleId,
    action,
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    ...(action === 'install' ? { image: CATALOG_IMAGES[moduleId] } : {}),
    ...overrides,
  };
}

export { CATALOG_IMAGES as MODULE_TEST_IMAGES };
export const STT_TEST_ENV = { stt: { STT_MODEL_DIR: '/srv/qa-private-model', AGIL_STT_TOKEN: 'qa-stt-test-token' } };
