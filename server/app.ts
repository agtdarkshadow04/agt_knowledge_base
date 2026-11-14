import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import {
  AdminAuthService,
  adminSessionCookie,
  clearedSessionCookie,
  sessionCookie,
  type AdminSessionResult,
} from './admin-auth.js';
import { createAdminRequestHandler, type AdminRequestHandler } from './admin-handler.js';
import { authenticate, toActor, type AuthenticatedUser } from './auth.js';
import type { AppContext } from './context.js';
import { createRequestHandler, type RequestHandler } from './handler.js';
import { BodyTooLargeError, errorReply, HttpError, RateLimitedError } from './http.js';
import { LocalAuthService } from './local-auth.js';
import { registerOpenApi, routeSecurity } from './openapi.js';
import { RateLimiter } from './rate-limit.js';
import {
  apiRoutes,
  defaultMaxBodyBytes,
  maxBackupBodyBytes,
  type AdminIdentity,
  type ApiResponse,
  type CompiledRoute,
} from './routes.js';
import { SettingsService } from './settings-service.js';
import { parseAdminAccountPassword, parseAdminSetup, parseCredentials } from '../src/lib/validation.js';

/** Header every non-GET admin request must carry; with SameSite=Strict it blocks cross-site requests. */
export const csrfHeader = 'x-agt-request';

/** Member UI paths the React router still answers, until query-parameter deep links replace them (FE-4). */
const memberPagePaths = ['/login', '/tags', '/articles/*'];

export interface BuildAppOptions {
  /** Fastify's logger option; off by default so tests stay quiet. */
  logger?: FastifyServerOptions['logger'];
  /** The built client (`dist/`) to serve (SRV-9); nothing is served when it is missing. */
  staticDir?: string;
  /** Replaces the in-memory rate limiter, for tests. */
  rateLimiter?: RateLimiter;
  /** Replace the route dispatchers, for tests of the HTTP pipeline. */
  handlers?: { request?: RequestHandler; admin?: AdminRequestHandler };
  /** Replace the authentication and settings services, for tests of the HTTP pipeline. */
  services?: {
    localAuth?: Pick<LocalAuthService, 'authenticate' | 'issueToken' | 'verifyToken'>;
    adminAuth?: Pick<AdminAuthService, 'setupStatus' | 'setup' | 'login' | 'session' | 'logout' | 'changePassword'>;
    settings?: Pick<SettingsService, 'getEffective'>;
  };
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The route-table entry this Fastify route serves. */
    apiRoute?: CompiledRoute;
  }
  interface FastifyRequest {
    member: AuthenticatedUser | null;
    admin: AdminIdentity | null;
    adminToken: string | undefined;
  }
}

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/** Sends an error body as is (the success response schemas do not apply to it). */
function sendError(reply: FastifyReply, statusCode: number, body: unknown, headers: Record<string, string> = {}) {
  return reply.code(statusCode).headers({ ...headers, ...jsonHeaders }).send(JSON.stringify(body));
}

/** Sends a JSON success value through the route's response schema. */
function sendJson(reply: FastifyReply, statusCode: number, body: unknown, headers: Record<string, string> = {}) {
  return reply.code(statusCode).headers({ ...headers, ...jsonHeaders }).send(body);
}

function sendApiResponse(reply: FastifyReply, result: ApiResponse) {
  reply.code(result.statusCode).headers(result.headers);
  return result.body === undefined ? reply.send() : reply.send(result.body);
}

/**
 * `server.trustProxy`: false uses the socket address, true trusts every
 * X-Forwarded-For hop, and a number trusts that many proxies nearest the API.
 */
function trustProxyOption(trustProxy: boolean | number) {
  if (typeof trustProxy === 'boolean') return trustProxy;
  return (_address: string, hop: number) => hop < trustProxy;
}

/** Counts streamed request bytes and fails once they exceed `limit`. */
function limitStream(limit: number) {
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > limit) callback(new BodyTooLargeError(limit));
      else callback(null, chunk);
    },
  });
}

/** The Fastify route schema of a table entry: TypeBox schemas plus the OpenAPI metadata (API-10, API-11). */
function routeSchema(route: CompiledRoute) {
  return {
    operationId: route.operationId,
    tags: [route.tag],
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    ...(route.replacedBy ? { deprecated: true } : {}),
    security: routeSecurity(route),
    ...(route.params ? { params: route.params } : {}),
    ...(route.querystring ? { querystring: route.querystring } : {}),
    ...(route.body ? { body: route.body } : {}),
    response: { ...route.response, default: Type.Ref('ErrorBody', { description: 'Error (API-6).' }) },
  };
}

/** Serves `dist/` (SRV-9): the two entries, hashed assets with long caching, everything else `no-store`. */
function registerStatic(app: FastifyInstance, staticDir: string) {
  const root = resolve(staticDir);
  const assets = join(root, 'assets');
  app.register(fastifyStatic, {
    root: assets,
    prefix: '/assets/',
    index: false,
    // Hashed build files never change; the entry pages (also sent by this plugin) must never be cached.
    setHeaders: (reply, path) => {
      reply.header('cache-control', path.startsWith(`${assets}${sep}`) ? 'public, max-age=31536000, immutable' : 'no-store');
    },
  });
  const page = (file: string, extra: Record<string, string> = {}) => async (_request: FastifyRequest, reply: FastifyReply) => (
    reply.headers({ 'cache-control': 'no-store', ...extra }).sendFile(file, root)
  );
  const hidden = { schema: { hide: true } };
  app.get('/', hidden, page('index.html'));
  app.get('/admin', hidden, page('admin.html', { 'x-robots-tag': 'noindex, nofollow' }));
  app.get('/admin/', hidden, async (_request, reply) => reply.redirect('/admin', 301));
  for (const path of memberPagePaths) app.get(path, hidden, page('index.html'));
}

/**
 * Builds the app without listening (SRV-2): the API routes with their schemas
 * and OpenAPI document, authentication, CSRF and rate limits, body limits,
 * the single error handler (SRV-5), and the built client. `server/index.ts`
 * passes the context and calls `listen()`.
 */
export function buildApp(context: AppContext, options: BuildAppOptions = {}) {
  const { config } = context;
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: trustProxyOption(config.server.trustProxy),
    bodyLimit: defaultMaxBodyBytes,
    // Per-request access logs stay off; the server logs what it does, not every request.
    logController: new LogController({ disableRequestLogging: true }),
    // Keeps the last value of a repeated query parameter, as a plain object of strings.
    routerOptions: { querystringParser: (query: string) => Object.fromEntries(new URLSearchParams(query)) },
    // Undeclared properties are rejected, not dropped, and values are never coerced (API-10).
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  const rateLimiter = options.rateLimiter ?? new RateLimiter();
  const localAuth = options.services?.localAuth ?? new LocalAuthService(context);
  const adminAuth = options.services?.adminAuth ?? new AdminAuthService(context);
  const settingsService = options.services?.settings ?? new SettingsService(context);
  const handleRequest = options.handlers?.request ?? createRequestHandler(context);
  const handleAdminRequest = options.handlers?.admin ?? createAdminRequestHandler(context);

  /**
   * Whether the admin cookie gets the Secure attribute. `auto` sets it when the
   * site's configured origin is HTTPS, or when a trusted proxy reports HTTPS.
   */
  function secureCookie(request: FastifyRequest) {
    const { adminSession, server } = config;
    if (adminSession.secureCookie !== 'auto') return adminSession.secureCookie;
    if (server.frontendOrigin.startsWith('https:')) return true;
    if (server.trustProxy === false || server.trustProxy === 0) return false;
    return request.protocol === 'https';
  }

  function adminSessionBody(username: string) {
    return { username, setupPasswordSet: context.setupPassword !== null, version: context.version };
  }

  function startSession(request: FastifyRequest, reply: FastifyReply, statusCode: number, session: AdminSessionResult) {
    return sendJson(reply, statusCode, adminSessionBody(session.admin.username), {
      'set-cookie': sessionCookie(session.token, session.expiresAt, secureCookie(request)),
    });
  }

  // JSON bodies use Fastify's parser; any other body (backup uploads) arrives as a Buffer.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.decorateRequest('member', null);
  app.decorateRequest('admin', null);
  app.decorateRequest('adminToken', undefined);
  app.register(fastifyCookie);
  registerOpenApi(app, context.version);

  app.setErrorHandler((error, request, reply) => {
    const result = errorReply(error, (unexpected) => request.log.error({ err: unexpected }, 'Unhandled API error'));
    return sendError(reply, result.statusCode, result.body, result.headers);
  });
  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, { error: 'not_found', message: 'Route not found.', code: 'NOT_FOUND' }));

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('access-control-allow-origin', config.server.frontendOrigin);
    reply.header('access-control-allow-headers', 'authorization,content-type');
    reply.header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    reply.header('vary', 'origin');
  });

  // The one authentication hook. Rate limits, the CSRF check and
  // authentication all run before the body is read, so anonymous clients
  // cannot make the server buffer large bodies.
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.config.apiRoute;
    if (!route) return;
    // The router lets a last path parameter be empty (`/articles/`); the route table does not.
    if (Object.values(request.params as Record<string, string>).some((value) => value === '')) {
      throw new HttpError(404, 'not_found', 'Route not found.');
    }
    if (route.rateLimit) {
      const result = rateLimiter.hit(route.rateLimit, request.ip, config.rateLimits[route.rateLimit]);
      if (!result.allowed) throw new RateLimitedError(result.retryAfterSeconds);
    }
    if (route.csrf && request.headers[csrfHeader] !== '1') {
      throw new HttpError(403, 'csrf', `Admin requests must include the ${csrfHeader} header.`, { legacyCode: 'CSRF_HEADER_REQUIRED' });
    }
    if (route.auth === 'member') {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!token) throw new HttpError(401, 'unauthorized', 'Authentication is required.', { legacyCode: 'UNAUTHENTICATED' });
      try {
        request.member = await authenticate(localAuth, token);
      } catch {
        throw new HttpError(401, 'unauthorized', 'Invalid or expired authentication token.', { legacyCode: 'UNAUTHENTICATED' });
      }
    } else if (route.auth === 'admin') {
      const token = request.cookies[adminSessionCookie];
      request.adminToken = token;
      request.admin = token ? await adminAuth.session(token) : null;
      if (!request.admin) {
        if (token) reply.header('set-cookie', clearedSessionCookie(secureCookie(request)));
        throw new HttpError(401, 'unauthorized', 'Admin sign-in is required.', { legacyCode: 'UNAUTHENTICATED' });
      }
    }
  });

  app.options('/*', { schema: { hide: true } }, async (_request, reply) => reply.code(204).send());

  // Routes are added in a plugin registered after @fastify/swagger, so the
  // swagger plugin sees every one of them.
  app.register(async (routes) => {
    routes.get('/api/openapi.json', { schema: { hide: true } }, async (_request, reply) => sendJson(reply, 200, app.swagger()));

    for (const route of apiRoutes) {
      routes.route({
        method: route.method,
        url: route.path.replace(/\{([^}]+)\}/g, ':$1'),
        config: { apiRoute: route },
        schema: routeSchema(route),
        // The restore upload is limited by the effective backup.maxBytes setting
        // in preParsing; Fastify's own limit there is only the hard ceiling.
        bodyLimit: route.maxBodyBytes === 'backup' ? maxBackupBodyBytes : route.maxBodyBytes ?? defaultMaxBodyBytes,
        ...(route.maxBodyBytes === 'backup' ? {
          preParsing: async (request: FastifyRequest, _reply: FastifyReply, payload: NodeJS.ReadableStream) => {
            const limit = (await settingsService.getEffective()).backupMaxBytes;
            const declared = Number(request.headers['content-length']);
            if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError(limit);
            return payload.pipe(limitStream(limit));
          },
        } : {}),
        handler: async (request, reply) => serve(route, request, reply),
      });
    }

    if (options.staticDir && existsSync(join(options.staticDir, 'index.html'))) registerStatic(routes, options.staticDir);
  });

  async function serve(route: CompiledRoute, request: FastifyRequest, reply: FastifyReply) {
    const rawBody = route.rawBody && Buffer.isBuffer(request.body) && request.body.length ? request.body : undefined;
    const body = route.rawBody ? undefined : request.body;

    switch (route.handlerKey) {
      case 'GET /api/health':
        await (await context.db.pool()).query('SELECT 1');
        return sendJson(reply, 200, { status: 'ok' });
      case 'POST /api/auth/login': {
        const input = parseCredentials(body);
        const signedIn = await localAuth.authenticate(input.username, input.password);
        if (!signedIn) throw new HttpError(401, 'invalid_credentials', 'Invalid username or password.');
        return sendJson(reply, 200, {
          token: localAuth.issueToken(signedIn),
          user: {
            sub: signedIn.sub,
            username: signedIn.username,
            displayName: signedIn.displayName,
            email: signedIn.email,
            role: signedIn.role,
          },
        });
      }
      case 'GET /api/auth/session':
        return sendJson(reply, 200, request.member);
      case 'GET /api/setup/status':
        return sendJson(reply, 200, await adminAuth.setupStatus());
      case 'POST /api/setup':
        return startSession(request, reply, 201, await adminAuth.setup(parseAdminSetup(body)));
      case 'POST /api/admin/login': {
        const input = parseCredentials(body);
        return startSession(request, reply, 200, await adminAuth.login(input.username, input.password));
      }
      case 'POST /api/admin/logout':
        await adminAuth.logout(request.adminToken!);
        return reply
          .code(204)
          .headers({ 'set-cookie': clearedSessionCookie(secureCookie(request)), 'cache-control': 'no-store' })
          .send();
      case 'GET /api/admin/session':
        return sendJson(reply, 200, adminSessionBody(request.admin!.username));
      case 'POST /api/admin/password': {
        const input = parseAdminAccountPassword(body);
        return startSession(request, reply, 200, await adminAuth.changePassword(input.currentPassword, input.password));
      }
    }

    const apiRequest = {
      routeKey: route.handlerKey,
      pathParameters: request.params as Record<string, string>,
      query: request.query as Record<string, string>,
      body,
      rawBody,
      requestId: request.id,
    };
    const result = route.admin
      ? await handleAdminRequest({ ...apiRequest, actor: null, admin: request.admin })
      : await handleRequest({ ...apiRequest, actor: request.member ? toActor(request.member) : null });
    return sendApiResponse(reply, result);
  }

  return app;
}

export type App = ReturnType<typeof buildApp>;
