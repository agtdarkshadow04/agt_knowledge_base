import { createServer } from 'node:http';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handler } from './handler.js';

const port = Number(process.env.API_PORT ?? 3001);
const origin = process.env.LOCAL_FRONTEND_ORIGIN ?? 'http://localhost:5173';
const userPoolId = process.env.VITE_COGNITO_USER_POOL_ID;
const clientId = process.env.VITE_COGNITO_USER_POOL_CLIENT_ID;
const verifier = userPoolId && clientId
  ? CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' })
  : null;

function routeKey(method: string, pathname: string) {
  if (method === 'GET' && pathname === '/articles') return 'GET /articles';
  if (method === 'GET' && pathname === '/member/articles') return 'GET /member/articles';
  if (method === 'POST' && pathname === '/articles') return 'POST /articles';
  if (/^\/articles\/[^/]+\/revisions\/[^/]+\/restore$/.test(pathname) && method === 'POST') {
    return 'POST /articles/{id}/revisions/{version}/restore';
  }
  if (/^\/articles\/[^/]+\/revisions$/.test(pathname) && method === 'GET') return 'GET /articles/{id}/revisions';
  if (/^\/articles\/[^/]+\/protection$/.test(pathname) && method === 'PATCH') return 'PATCH /articles/{id}/protection';
  if (/^\/articles\/[^/]+\/pinning$/.test(pathname) && method === 'PATCH') return 'PATCH /articles/{id}/pinning';
  if (/^\/member\/articles\/[^/]+$/.test(pathname) && method === 'GET') return 'GET /member/articles/{id}';
  if (/^\/articles\/[^/]+$/.test(pathname)) return `${method} /articles/{id}`;
  return `${method} ${pathname}`;
}

createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-headers', 'authorization,content-type');
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const method = request.method ?? 'GET';
  const matchedRoute = routeKey(method, url.pathname);
  const authenticatedRequest = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
    || matchedRoute === 'GET /articles/{id}/revisions'
    || matchedRoute.startsWith('GET /member/');
  let claims: Record<string, unknown> = {};

  if (authenticatedRequest) {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token || !verifier) { response.writeHead(401).end(JSON.stringify({ message: 'Authentication is not configured.' })); return; }
    try { claims = await verifier.verify(token); }
    catch { response.writeHead(401).end(JSON.stringify({ message: 'Invalid authentication token.' })); return; }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const articleMatch = url.pathname.match(/^\/(?:member\/)?articles\/([^/]+)/);
  const revisionMatch = url.pathname.match(/^\/articles\/[^/]+\/revisions\/([^/]+)/);
  const queryStringParameters = Object.fromEntries(url.searchParams.entries());
  const event = {
    version: '2.0',
    routeKey: matchedRoute,
    rawPath: url.pathname,
    rawQueryString: url.searchParams.toString(),
    headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)])),
    queryStringParameters,
    pathParameters: articleMatch ? { id: articleMatch[1], version: revisionMatch?.[1] } : undefined,
    requestContext: {
      requestId: crypto.randomUUID(),
      authorizer: { jwt: { claims, scopes: [] } },
      http: { method, path: url.pathname, protocol: 'HTTP/1.1', sourceIp: request.socket.remoteAddress ?? '', userAgent: request.headers['user-agent'] ?? '' },
    },
    body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

  const result = await handler(event);
  if (typeof result === 'string') { response.writeHead(200).end(result); return; }
  const statusCode = result.statusCode ?? 200;
  for (const [key, value] of Object.entries(result.headers ?? {})) response.setHeader(key, String(value));
  response.writeHead(statusCode).end(result.body ?? '');
}).listen(port, '127.0.0.1', () => {
  console.log(`AGT API listening on http://127.0.0.1:${port}`);
});
