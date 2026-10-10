import { createServer } from 'node:http';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { roleFromClaims } from './auth.js';
import { handler } from './handler.js';
import {
  assertLocalAuthConfigured,
  authenticateLocalUser,
  issueLocalToken,
  localClaims,
  verifyLocalToken,
} from './local-auth.js';

const port = Number(process.env.API_PORT ?? 3001);
const host = process.env.API_HOST ?? '127.0.0.1';
const origin = process.env.LOCAL_FRONTEND_ORIGIN ?? 'http://localhost:5173';
const authMode = process.env.AUTH_MODE ?? 'cognito';
const userPoolId = process.env.VITE_COGNITO_USER_POOL_ID;
const clientId = process.env.VITE_COGNITO_USER_POOL_CLIENT_ID;
if (authMode !== 'cognito' && authMode !== 'local') throw new Error('AUTH_MODE must be cognito or local.');
if (authMode === 'local') assertLocalAuthConfigured();
const verifier = authMode === 'cognito' && userPoolId && clientId
  ? CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' })
  : null;

function routeKey(method: string, pathname: string) {
  if (method === 'POST' && pathname === '/auth/login') return 'POST /auth/login';
  if (method === 'GET' && pathname === '/auth/session') return 'GET /auth/session';
  if (method === 'GET' && pathname === '/articles') return 'GET /articles';
  if (method === 'GET' && pathname === '/tags') return 'GET /tags';
  if (method === 'POST' && pathname === '/tags') return 'POST /tags';
  if (method === 'GET' && pathname === '/tags/orphans') return 'GET /tags/orphans';
  if (/^\/tags\/[^/]+$/.test(pathname) && method === 'PUT') return 'PUT /tags/{tagId}';
  if (/^\/tags\/[^/]+$/.test(pathname) && method === 'DELETE') return 'DELETE /tags/{tagId}';
  if (method === 'GET' && pathname === '/member/articles') return 'GET /member/articles';
  if (method === 'POST' && pathname === '/articles') return 'POST /articles';
  if (/^\/articles\/[^/]+\/revisions\/[^/]+\/restore$/.test(pathname) && method === 'POST') {
    return 'POST /articles/{id}/revisions/{version}/restore';
  }
  if (/^\/articles\/[^/]+\/revisions$/.test(pathname) && method === 'GET') return 'GET /articles/{id}/revisions';
  if (/^\/articles\/[^/]+\/protection$/.test(pathname) && method === 'PATCH') return 'PATCH /articles/{id}/protection';
  if (/^\/articles\/[^/]+\/pinning$/.test(pathname) && method === 'PATCH') return 'PATCH /articles/{id}/pinning';
  if (/^\/articles\/[^/]+\/verification$/.test(pathname) && method === 'PATCH') return 'PATCH /articles/{id}/verification';
  if (/^\/articles\/[^/]+\/orphan-tags\/[^/]+$/.test(pathname) && method === 'DELETE') {
    return 'DELETE /articles/{id}/orphan-tags/{tagId}';
  }
  if (/^\/member\/articles\/[^/]+$/.test(pathname) && method === 'GET') return 'GET /member/articles/{id}';
  if (/^\/articles\/[^/]+$/.test(pathname)) return `${method} /articles/{id}`;
  return `${method} ${pathname}`;
}

function sendJson(response: import('node:http').ServerResponse, statusCode: number, body: unknown) {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.writeHead(statusCode).end(JSON.stringify(body));
}

function sessionUser(claims: Record<string, unknown>) {
  return {
    sub: String(claims.sub),
    username: String(claims.username ?? claims['cognito:username'] ?? claims.sub),
    displayName: String(claims.name ?? claims.username ?? claims['cognito:username'] ?? 'AGT Traveller'),
    email: typeof claims.email === 'string' ? claims.email : undefined,
    role: roleFromClaims(claims),
  };
}

createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-headers', 'authorization,content-type');
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const method = request.method ?? 'GET';
  const matchedRoute = routeKey(method, url.pathname);
  const chunks: Buffer[] = [];
  let bodySize = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bodySize += buffer.length;
    if (bodySize > 1_000_000) { sendJson(response, 413, { message: 'Request body is too large.' }); return; }
    chunks.push(buffer);
  }
  const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;

  if (matchedRoute === 'POST /auth/login') {
    if (authMode !== 'local') { sendJson(response, 404, { message: 'Route not found.' }); return; }
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

  const authenticatedRequest = (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
    || matchedRoute === 'GET /articles/{id}/revisions'
    || matchedRoute === 'GET /tags/orphans'
    || matchedRoute.startsWith('GET /member/')
    || matchedRoute === 'GET /auth/session');
  let claims: Record<string, unknown> = {};

  if (authenticatedRequest) {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token || (authMode === 'cognito' && !verifier)) {
      sendJson(response, 401, { message: 'Authentication is not configured.' });
      return;
    }
    try {
      claims = authMode === 'local'
        ? localClaims(verifyLocalToken(token))
        : await verifier!.verify(token);
    } catch { sendJson(response, 401, { message: 'Invalid or expired authentication token.' }); return; }
  }

  if (matchedRoute === 'GET /auth/session') { sendJson(response, 200, sessionUser(claims)); return; }

  const articleMatch = url.pathname.match(/^\/(?:member\/)?articles\/([^/]+)/);
  const revisionMatch = url.pathname.match(/^\/articles\/[^/]+\/revisions\/([^/]+)/);
  const orphanTagMatch = url.pathname.match(/^\/articles\/[^/]+\/orphan-tags\/([^/]+)/);
  const catalogTagMatch = url.pathname.match(/^\/tags\/([^/]+)$/);
  const queryStringParameters = Object.fromEntries(url.searchParams.entries());
  const event = {
    version: '2.0',
    routeKey: matchedRoute,
    rawPath: url.pathname,
    rawQueryString: url.searchParams.toString(),
    headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)])),
    queryStringParameters,
    pathParameters: articleMatch || catalogTagMatch ? {
      id: articleMatch?.[1],
      version: revisionMatch?.[1],
      tagId: orphanTagMatch?.[1] ?? catalogTagMatch?.[1],
    } : undefined,
    requestContext: {
      requestId: crypto.randomUUID(),
      authorizer: { jwt: { claims, scopes: [] } },
      http: { method, path: url.pathname, protocol: 'HTTP/1.1', sourceIp: request.socket.remoteAddress ?? '', userAgent: request.headers['user-agent'] ?? '' },
    },
    body,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

  const result = await handler(event);
  if (typeof result === 'string') { response.writeHead(200).end(result); return; }
  const statusCode = result.statusCode ?? 200;
  for (const [key, value] of Object.entries(result.headers ?? {})) response.setHeader(key, String(value));
  response.writeHead(statusCode).end(result.body ?? '');
}).listen(port, host, () => {
  console.log(`AGT API listening on http://${host}:${port}`);
});
