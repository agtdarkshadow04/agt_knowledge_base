import { createServer } from 'node:http';
import { ZodError } from 'zod';
import { AdminService } from './admin-service.js';
import { authenticate, toActor, type AuthenticatedUser } from './auth.js';
import { AppError } from './domain.js';
import { handleRequest } from './handler.js';
import { assertLocalAuthConfigured, authenticateLocalUser, issueLocalToken } from './local-auth.js';
import { matchRoute, maxBodyBytes } from './routes.js';
import { parseSetupWrite } from './validation.js';

const port = Number(process.env.API_PORT ?? 3001);
const host = process.env.API_HOST ?? '127.0.0.1';
const origin = process.env.LOCAL_FRONTEND_ORIGIN ?? 'http://localhost:5173';
if (process.env.AUTH_MODE !== undefined && process.env.AUTH_MODE !== 'local') {
  throw new Error('AUTH_MODE must be local or unset. Cognito authentication is no longer supported.');
}
assertLocalAuthConfigured();
const adminService = new AdminService();

function sendJson(response: import('node:http').ServerResponse, statusCode: number, body: unknown) {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.writeHead(statusCode).end(JSON.stringify(body));
}

createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-headers', 'authorization,content-type');
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const method = request.method ?? 'GET';
  const route = matchRoute(method, url.pathname);
  if (!route) { sendJson(response, 404, { code: 'NOT_FOUND', message: 'Route not found.' }); return; }

  // Authenticate before reading the body so anonymous clients cannot make the
  // server buffer the larger bodies some routes (such as restore) accept.
  let user: AuthenticatedUser | null = null;
  if (route.authenticated) {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) { sendJson(response, 401, { message: 'Authentication is required.' }); return; }
    try { user = await authenticate(token); }
    catch { sendJson(response, 401, { message: 'Invalid or expired authentication token.' }); return; }
  }

  const bodyLimit = maxBodyBytes(route.routeKey);
  const chunks: Buffer[] = [];
  let bodySize = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bodySize += buffer.length;
    if (bodySize > bodyLimit) { sendJson(response, 413, { message: 'Request body is too large.' }); return; }
    chunks.push(buffer);
  }
  const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;

  if (route.routeKey === 'POST /auth/login') {
    let input: unknown;
    try { input = JSON.parse(body ?? ''); }
    catch { sendJson(response, 400, { message: 'The request body must contain valid JSON.' }); return; }
    if (!input || typeof input !== 'object'
      || typeof (input as { username?: unknown }).username !== 'string'
      || typeof (input as { password?: unknown }).password !== 'string') {
      sendJson(response, 400, { message: 'Username and password are required.' });
      return;
    }
    try {
      const user = await authenticateLocalUser(
        (input as { username: string }).username,
        (input as { password: string }).password,
      );
      if (!user) { sendJson(response, 401, { message: 'Invalid username or password.' }); return; }
      sendJson(response, 200, { token: issueLocalToken(user), user });
    } catch (error) {
      console.error('Local sign-in failed', { error });
      sendJson(response, 500, { message: 'Sign-in is temporarily unavailable.' });
    }
    return;
  }

  if (route.routeKey === 'GET /setup/status') {
    try { sendJson(response, 200, { required: await adminService.setupRequired() }); }
    catch (error) {
      console.error('Setup status failed', { error });
      sendJson(response, 500, { message: 'Setup status is temporarily unavailable.' });
    }
    return;
  }

  if (route.routeKey === 'POST /setup') {
    try {
      const input = parseSetupWrite(JSON.parse(body ?? ''));
      const user = await adminService.bootstrap(input);
      sendJson(response, 201, { token: issueLocalToken(user), user });
    } catch (error) {
      if (error instanceof SyntaxError) sendJson(response, 400, { message: 'The request body must contain valid JSON.' });
      else if (error instanceof ZodError) sendJson(response, 400, { message: `The request is invalid: ${error.issues[0].message}`, issues: error.issues });
      else if (error instanceof AppError) sendJson(response, error.statusCode, { code: error.code, message: error.message });
      else {
        console.error('Initial setup failed', { error });
        sendJson(response, 500, { message: 'Initial setup is temporarily unavailable.' });
      }
    }
    return;
  }

  if (route.routeKey === 'GET /auth/session') { sendJson(response, 200, user); return; }

  const result = await handleRequest({
    routeKey: route.routeKey,
    pathParameters: route.pathParameters,
    query: Object.fromEntries(url.searchParams.entries()),
    body,
    actor: user ? toActor(user) : null,
    requestId: crypto.randomUUID(),
  });
  for (const [key, value] of Object.entries(result.headers)) response.setHeader(key, value);
  response.writeHead(result.statusCode).end(result.body ?? '');
}).listen(port, host, () => {
  console.log(`AGT API listening on http://${host}:${port}`);
});
