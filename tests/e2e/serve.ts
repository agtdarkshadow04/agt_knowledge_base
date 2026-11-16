/**
 * Serves the built client (dist/) for the browser tests with exactly the
 * production response headers (server/headers.ts: SEC-1..SEC-3), so the tests
 * see the real CSP. The API is not served: each test answers `/api/*` itself
 * with Playwright's request routing, so no database is needed.
 *
 *   node tests/e2e/serve.ts [port]
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { noStoreHeaders, securityHeaders } from '../../server/headers.ts';

const root = resolve('dist');
const port = Number(process.argv[2] ?? 4173);
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json',
};

createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const file = path === '/' ? 'index.html' : path === '/admin' ? 'admin.html' : normalize(path).slice(1);
  const full = join(root, file);
  response.setHeader('x-served-by', 'e2e');
  for (const [name, value] of Object.entries({ ...securityHeaders, ...noStoreHeaders })) response.setHeader(name, value);
  if (!full.startsWith(`${root}${sep}`) || !existsSync(full) || !statSync(full).isFile()) {
    response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found","message":"Route not found."}');
    return;
  }
  response.writeHead(200, { 'content-type': types[extname(full)] ?? 'application/octet-stream' });
  createReadStream(full).pipe(response);
}).listen(port, '127.0.0.1');
