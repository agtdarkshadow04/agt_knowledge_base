import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import {
  AdminAuthService,
  adminSessionCookie,
  clearedSessionCookie,
  readCookie,
  sessionCookie,
  setupPassword,
  type AdminSessionResult,
} from './admin-auth.js';
import { handleAdminRequest } from './admin-handler.js';
import { authenticate, toActor, type AuthenticatedUser } from './auth.js';
import { getConfig } from './config.js';
import { AppError } from './domain.js';
import { handleRequest } from './handler.js';
import { authenticateLocalUser, issueLocalToken } from './local-auth.js';
import { clientAddress, RateLimiter } from './rate-limit.js';
import { isAdminPath, matchRoute, maxBodyBytes, usesBackupBodyLimit, type AdminIdentity, type ApiResponse } from './routes.js';
import { SettingsService } from './settings-service.js';
import { parseAdminAccountPassword, parseCredentials, parseAdminSetup } from './validation.js';

/** Header every non-GET admin request must carry; with SameSite=Strict it blocks cross-site requests. */
export const csrfHeader = 'x-agt-request';

function sendJson(response: ServerResponse, statusCode: number, body: unknown, headers: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.writeHead(statusCode).end(JSON.stringify(body));
}

function sendError(response: ServerResponse, error: unknown, context: string) {
  if (error instanceof SyntaxError) sendJson(response, 400, { code: 'INVALID_JSON', message: 'The request body must contain valid JSON.' });
  else if (error instanceof ZodError) sendJson(response, 400, { code: 'VALIDATION_ERROR', message: `The request is invalid: ${error.issues[0].message}`, issues: error.issues });
  else if (error instanceof AppError) sendJson(response, error.statusCode, { code: error.code, message: error.message });
  else {
    console.error(`${context} failed`, { error });
    sendJson(response, 500, { code: 'INTERNAL_ERROR', message: `${context} is temporarily unavailable.` });
  }
}

/**
 * Whether the admin cookie gets the Secure attribute. `auto` sets it when the
 * site's configured origin is HTTPS, or when a trusted proxy reports HTTPS.
 */
export function secureCookie(request: Pick<IncomingMessage, 'headers'>) {
  const { adminSession, server } = getConfig();
  if (adminSession.secureCookie !== 'auto') return adminSession.secureCookie;
  if (server.frontendOrigin.startsWith('https:')) return true;
  if (server.trustProxy === false || server.trustProxy === 0) return false;
  const proto = request.headers['x-forwarded-proto'];
  return String(Array.isArray(proto) ? proto[0] : proto ?? '').split(',')[0].trim() === 'https';
}

export interface ApiListenerOptions {
  rateLimiter?: RateLimiter;
}

export function createApiListener(options: ApiListenerOptions = {}) {
  const rateLimiter = options.rateLimiter ?? new RateLimiter();
  const adminAuth = new AdminAuthService();
  const settingsService = new SettingsService();

  function startSession(request: IncomingMessage, response: ServerResponse, statusCode: number, session: AdminSessionResult) {
    sendJson(response, statusCode, { username: session.admin.username, setupPasswordSet: setupPassword() !== undefined }, {
      'set-cookie': sessionCookie(session.token, session.expiresAt, secureCookie(request)),
    });
  }

  return async function listener(request: IncomingMessage, response: ServerResponse) {
    const config = getConfig();
    response.setHeader('access-control-allow-origin', config.server.frontendOrigin);
    response.setHeader('access-control-allow-headers', 'authorization,content-type');
    response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    response.setHeader('vary', 'origin');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }

    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = request.method ?? 'GET';
    const route = matchRoute(method, url.pathname);
    if (!route) { sendJson(response, 404, { code: 'NOT_FOUND', message: 'Route not found.' }); return; }
    const adminRoute = isAdminPath(url.pathname);

    // Rate limits, the CSRF check, and authentication all run before the body
    // is read, so anonymous clients cannot make the server buffer large bodies.
    if (route.rateLimit) {
      const result = rateLimiter.hit(route.rateLimit, clientAddress(request, config.server.trustProxy), config.rateLimits[route.rateLimit]);
      if (!result.allowed) {
        sendJson(response, 429, { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' }, {
          'retry-after': String(result.retryAfterSeconds),
        });
        return;
      }
    }

    if (adminRoute && method !== 'GET' && request.headers[csrfHeader] !== '1') {
      sendJson(response, 403, { code: 'CSRF_HEADER_REQUIRED', message: `Admin requests must include the ${csrfHeader} header.` });
      return;
    }

    let user: AuthenticatedUser | null = null;
    let admin: AdminIdentity | null = null;
    const adminToken = adminRoute ? readCookie(request.headers.cookie, adminSessionCookie) : undefined;
    try {
      if (route.auth === 'member') {
        const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (!token) { sendJson(response, 401, { code: 'UNAUTHENTICATED', message: 'Authentication is required.' }); return; }
        try { user = await authenticate(token); }
        catch { sendJson(response, 401, { code: 'UNAUTHENTICATED', message: 'Invalid or expired authentication token.' }); return; }
      } else if (route.auth === 'admin') {
        admin = adminToken ? await adminAuth.session(adminToken) : null;
        if (!admin) {
          sendJson(response, 401, { code: 'UNAUTHENTICATED', message: 'Admin sign-in is required.' }, adminToken
            ? { 'set-cookie': clearedSessionCookie(secureCookie(request)) }
            : {});
          return;
        }
      }
    } catch (error) {
      sendError(response, error, 'Authentication');
      return;
    }

    let bodyLimit: number;
    try {
      bodyLimit = usesBackupBodyLimit(route.routeKey)
        ? maxBodyBytes(route.routeKey, (await settingsService.getEffective()).backupMaxBytes)
        : maxBodyBytes(route.routeKey);
    } catch (error) {
      sendError(response, error, 'The request');
      return;
    }
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
      sendJson(response, 413, { code: 'BODY_TOO_LARGE', message: 'Request body is too large.' }, { connection: 'close' });
      return;
    }
    const chunks: Buffer[] = [];
    let bodySize = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      bodySize += buffer.length;
      if (bodySize > bodyLimit) {
        sendJson(response, 413, { code: 'BODY_TOO_LARGE', message: 'Request body is too large.' }, { connection: 'close' });
        return;
      }
      chunks.push(buffer);
    }
    const rawBody = chunks.length ? Buffer.concat(chunks) : undefined;
    const body = rawBody && !route.rawBody ? rawBody.toString('utf8') : undefined;

    switch (route.routeKey) {
      case 'POST /auth/login': {
        try {
          const input = parseCredentials(JSON.parse(body ?? ''));
          const signedIn = await authenticateLocalUser(input.username, input.password);
          if (!signedIn) { sendJson(response, 401, { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' }); return; }
          sendJson(response, 200, {
            token: issueLocalToken(signedIn),
            user: {
              sub: signedIn.sub,
              username: signedIn.username,
              displayName: signedIn.displayName,
              email: signedIn.email,
              role: signedIn.role,
            },
          });
        } catch (error) {
          if (error instanceof ZodError) sendJson(response, 400, { code: 'VALIDATION_ERROR', message: 'Username and password are required.' });
          else sendError(response, error, 'Sign-in');
        }
        return;
      }
      case 'GET /auth/session':
        sendJson(response, 200, user);
        return;
      case 'GET /admin/setup/status':
        try { sendJson(response, 200, await adminAuth.setupStatus()); }
        catch (error) { sendError(response, error, 'Setup status'); }
        return;
      case 'POST /admin/setup':
        try {
          const input = parseAdminSetup(JSON.parse(body ?? ''));
          startSession(request, response, 201, await adminAuth.setup(input));
        } catch (error) { sendError(response, error, 'Setup'); }
        return;
      case 'POST /admin/auth/login':
        try {
          const input = parseCredentials(JSON.parse(body ?? ''));
          startSession(request, response, 200, await adminAuth.login(input.username, input.password));
        } catch (error) {
          if (error instanceof ZodError) sendJson(response, 400, { code: 'VALIDATION_ERROR', message: 'Username and password are required.' });
          else sendError(response, error, 'Admin sign-in');
        }
        return;
      case 'POST /admin/auth/logout':
        try {
          await adminAuth.logout(adminToken!);
          response.setHeader('set-cookie', clearedSessionCookie(secureCookie(request)));
          response.setHeader('cache-control', 'no-store');
          response.writeHead(204).end();
        } catch (error) { sendError(response, error, 'Admin sign-out'); }
        return;
      case 'GET /admin/auth/session':
        sendJson(response, 200, { username: admin!.username, setupPasswordSet: setupPassword() !== undefined });
        return;
      case 'PUT /admin/auth/password':
        try {
          const input = parseAdminAccountPassword(JSON.parse(body ?? ''));
          startSession(request, response, 200, await adminAuth.changePassword(input.currentPassword, input.password));
        } catch (error) { sendError(response, error, 'Password change'); }
        return;
    }

    const apiRequest = {
      routeKey: route.routeKey,
      pathParameters: route.pathParameters,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      rawBody: route.rawBody ? rawBody : undefined,
      requestId: crypto.randomUUID(),
    };
    const result: ApiResponse = adminRoute
      ? await handleAdminRequest({ ...apiRequest, actor: null, admin })
      : await handleRequest({ ...apiRequest, actor: user ? toActor(user) : null });
    for (const [key, value] of Object.entries(result.headers)) response.setHeader(key, value);
    response.writeHead(result.statusCode).end(result.body ?? '');
  };
}
