import { get } from 'node:http';
import { readHttpListener } from './config.mjs';

try {
  const { host, port } = readHttpListener(process.env);
  const hostname = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const ready = await new Promise((resolve) => {
    const request = get({ hostname, port, path: '/readyz', signal: AbortSignal.timeout(4000) }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.on('error', () => resolve(false));
  });
  process.exitCode = ready ? 0 : 1;
} catch {
  process.exitCode = 1;
}
