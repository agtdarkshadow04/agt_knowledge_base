import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { authenticationHook, createAdminRequestHandler, type AdminRequestHandler } from './adminRoutes.js';
import { toActor, type AuthenticatedUser } from './auth.js';
import type { AppConfig } from './config.js';
import type { AppContext } from './context.js';
import { createRequestHandler, type RequestHandler } from './handler.js';
import { BodyTooLargeError, errorReply, RateLimitedError } from './http.js';
import { registerOpenApi, routeSecurity } from './openapi.js';
import { sharedRateLimitStore } from './rate-limit.js';
import {
  apiRoutes,
  defaultMaxBodyBytes,
  maxBackupBodyBytes,
  type AdminIdentity,
  type ApiResponse,
  type CompiledRoute,
  type RateLimitName,
} from './routes.js';
import {
  AdminAuthService,
  adminSessionCookie,
  clearedCookie,
  legacyAdminSessionCookie,
  MemberAuthService,
  memberSessionCookie,
  sessionCookie,
  type AdminSessionResult,
  type AuthLog,
} from './session.js';
import { SettingsService } from './settings-service.js';
import { parseAdminAccountPassword, parseAdminSetup, parseCredentials } from '../src/lib/validation.js';

export { csrfHeader } from './adminRoutes.js';

/** Member UI paths the React router still answers, until query-parameter deep links replace them (FE-4). */
const memberPagePaths = ['/login', '/tags', '/articles/*'];

/** The Content-Security-Policy of every response, exactly as SEC-1 gives it. */
export const contentSecurityPolicy = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' https: http: blob:",
  "font-src 'self'", "connect-src 'self'", "media-src 'self'", "worker-src 'self'", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

/** SEC-1 and SEC-2: on every response. */
const securityHeaders = {
  'content-security-policy': contentSecurityPolicy,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin',
};

/** SEC-3: API and HTML responses are never cached; only hashed `/assets/` files are. */
export const noStoreHeaders = {
  'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
  pragma: 'no-cache',
  expires: '0',
};

export interface BuildAppOptions {
  /** Fastify's logger option; off by default so tests stay quiet. */
  logger?: FastifyServerOptions['logger'];
  /** The built client (`dist/`) to serve (SRV-9); nothing is served when it is missing. */
  staticDir?: string;
  /** The rate limiter's clock, for tests. */
  rateLimitClock?: () => number;
  /** Replace the route dispatchers, for tests of the HTTP pipeline. */
  handlers?: { request?: RequestHandler; admin?: AdminRequestHandler };
  /** Replace the authentication and settings services, for tests of the HTTP pipeline. */
  services?: {
    memberAuth?: Pick<MemberAuthService, 'login' | 'session' | 'logout'>;
    adminAuth?: Pick<AdminAuthService, 'setupStatus' | 'setup' | 'login' | 'session' | 'logout' | 'changePassword'>;
    settings?: Pick<SettingsService, 'values'>;
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
    /** The session cookie the authentication hook read, for logout. */
    sessionToken: string | undefined;
  }
}

const jsonType = { 'content-type': 'application/json; charset=utf-8' };

/** Sends an error body as is (the success response schemas do not apply to it). */
function sendError(reply: FastifyReply, statusCode: number, body: unknown, headers: Record<string, string> = {}) {
  return reply.code(statusCode).headers({ ...headers, ...jsonType }).send(JSON.stringify(body));
}

/** Sends a JSON success value through the route's response schema. */
function sendJson(reply: FastifyReply, statusCode: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  return reply.code(statusCode).headers({ ...headers, ...jsonType }).send(body);
}

function sendApiResponse(reply: FastifyReply, result: ApiResponse) {
  reply.code(result.statusCode).headers(result.headers);
  return result.body === undefined ? reply.send() : reply.send(result.body);
}

/**
 * `server.trustProxy`: false uses the socket address, true trusts every
 * X-Forwarded-For hop, a string or list names trusted proxy addresses, and a
 * number trusts that many proxies nearest the server.
 */
function trustProxyOption(trustProxy: AppConfig['server']['trustProxy']) {
  if (typeof trustProxy !== 'number') return trustProxy;
  return (_address: string, hop: number) => hop < trustProxy;
}

/** The limit each rate-limit bucket uses (SEC-7); the deprecated 1.x keys still override theirs until 3.0.0. */
function rateLimitRule(config: AppConfig, name: RateLimitName) {
  const limits = config.rateLimits;
  switch (name) {
    case 'login': return limits.login;
    case 'adminLogin': return limits.adminLogin ?? limits.login;
    case 'adminPassword': return limits.adminPassword ?? limits.login;
    case 'setup': return limits.setup;
    case 'adminUploads': return limits.adminUploads;
  }
}

function isLoopback(address: string) {
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
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
    // The plugin's own Cache-Control would replace the SEC-3 headers on the entry pages.
    cacheControl: false,
    // Hashed build files never change (SRV-9); the entry pages, also sent by this
    // plugin, keep the SEC-3 headers the onRequest hook set.
    setHeaders: (reply, path) => {
      if (!path.startsWith(`${assets}${sep}`)) return;
      reply.removeHeader('pragma');
      reply.removeHeader('expires');
      reply.header('cache-control', 'public, max-age=31536000, immutable');
    },
  });
  const page = (file: string, extra: Record<string, string> = {}) => async (_request: FastifyRequest, reply: FastifyReply) => (
    reply.headers(extra).sendFile(file, root)
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

  const authLog: AuthLog = {
    error: (message) => app.log.error({ source: 'auth' }, message),
    info: (message) => app.log.info({ source: 'auth' }, message),
  };
  const memberAuth = options.services?.memberAuth ?? new MemberAuthService(context, undefined, authLog);
  const adminAuth = options.services?.adminAuth ?? new AdminAuthService(context, undefined, authLog);
  const settingsService = options.services?.settings ?? new SettingsService(context);
  const handleRequest = options.handlers?.request ?? createRequestHandler(context);
  const handleAdminRequest = options.handlers?.admin ?? createAdminRequestHandler(context);

  /**
   * Whether session cookies get the Secure attribute (AUTH-8). `auto` sets it
   * when the request arrived over HTTPS, as a trusted proxy reports it, or when
   * the deprecated `server.frontendOrigin` is an HTTPS origin.
   */
  function secureCookie(request: FastifyRequest) {
    const { session, server } = config;
    if (session.secureCookie !== 'auto') return session.secureCookie;
    return request.protocol === 'https' || Boolean(server.frontendOrigin?.startsWith('https:'));
  }

  function adminSessionBody(username: string) {
    const stillSet = context.setupPassword !== null;
    return { username, setupPasswordStillSet: stillSet, setupPasswordSet: stillSet, version: context.version };
  }

  /** The new Admin cookie, and the 1.x one cleared so browsers drop it. */
  function adminCookies(request: FastifyRequest, value: { token: string; expiresAt: Date } | null) {
    const secure = secureCookie(request);
    return [
      value ? sessionCookie(adminSessionCookie, value.token, value.expiresAt, secure) : clearedCookie(adminSessionCookie, secure),
      clearedCookie(legacyAdminSessionCookie.name, secure, legacyAdminSessionCookie.path),
    ];
  }

  function startSession(request: FastifyRequest, reply: FastifyReply, statusCode: number, session: AdminSessionResult) {
    return sendJson(reply, statusCode, adminSessionBody(session.identity.username), { 'set-cookie': adminCookies(request, session) });
  }

  /** SEC-4: one warning per process the first time credentials arrive over plain HTTP from another host. */
  let plainHttpWarned = false;
  function warnOnPlainHttp(request: FastifyRequest) {
    if (plainHttpWarned || request.protocol !== 'http' || isLoopback(request.ip)) return;
    plainHttpWarned = true;
    app.log.warn({ source: 'security' }, `A sign-in or setup request arrived over plain HTTP from ${request.ip}: credentials were sent unencrypted. Put a TLS-terminating reverse proxy in front of the server (see README, HTTPS).`);
  }

  // SEC-1..SEC-3 on every response, errors and static files included. Hashed assets override the cache headers.
  app.addHook('onRequest', async (_request, reply) => {
    reply.headers({ ...securityHeaders, ...noStoreHeaders });
  });

  // JSON bodies use Fastify's parser; any other body (backup uploads) arrives as a Buffer.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.decorateRequest('member', null);
  app.decorateRequest('admin', null);
  app.decorateRequest('sessionToken', undefined);
  app.register(fastifyCookie);
  // SEC-7: per-route limits only, keyed by request.ip (which honours server.trustProxy).
  app.register(fastifyRateLimit, {
    global: false,
    store: sharedRateLimitStore(options.rateLimitClock),
    addHeadersOnExceeding: { 'x-ratelimit-limit': false, 'x-ratelimit-remaining': false, 'x-ratelimit-reset': false },
    addHeaders: { 'x-ratelimit-limit': false, 'x-ratelimit-remaining': false, 'x-ratelimit-reset': false, 'retry-after': true },
    errorResponseBuilder: (_request, context) => new RateLimitedError(Math.max(1, Math.ceil(context.ttl / 1000))),
  });
  registerOpenApi(app, context.version);

  app.setErrorHandler((error, request, reply) => {
    const result = errorReply(error, (unexpected) => request.log.error({ err: unexpected }, 'Unhandled API error'));
    return sendError(reply, result.statusCode, result.body, result.headers);
  });
  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, { error: 'not_found', message: 'Route not found.', code: 'NOT_FOUND' }));

  app.addHook('onRequest', authenticationHook({ adminAuth, memberAuth, secureCookie }));

  // Routes are added in a plugin registered after @fastify/swagger and
  // @fastify/rate-limit, so both see every one of them.
  app.register(async (routes) => {
    routes.get('/api/openapi.json', { schema: { hide: true } }, async (_request, reply) => sendJson(reply, 200, app.swagger()));

    for (const route of apiRoutes) {
      const limit = route.rateLimit ? rateLimitRule(config, route.rateLimit) : undefined;
      routes.route({
        method: route.method,
        url: route.path.replace(/\{([^}]+)\}/g, ':$1'),
        config: {
          apiRoute: route,
          // A deprecated path shares its replacement's bucket (groupId), so it adds no attempts.
          ...(limit ? { rateLimit: { max: limit.max, timeWindow: limit.windowMinutes * 60_000, groupId: route.rateLimit } } : {}),
        },
        schema: routeSchema(route),
        // The restore upload is limited by the effective backup.maxZipBytes setting
        // in preParsing; Fastify's own limit there is only the hard ceiling.
        bodyLimit: route.maxBodyBytes === 'backup' ? maxBackupBodyBytes : route.maxBodyBytes ?? defaultMaxBodyBytes,
        ...(route.maxBodyBytes === 'backup' ? {
          preParsing: async (request: FastifyRequest, _reply: FastifyReply, payload: NodeJS.ReadableStream) => {
            const limit = (await settingsService.values())['backup.maxZipBytes'];
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
      case 'POST /api/member/login': {
        warnOnPlainHttp(request);
        const input = parseCredentials(body);
        const session = await memberAuth.login(input.username, input.password);
        return sendJson(reply, 200, session.identity, {
          'set-cookie': sessionCookie(memberSessionCookie, session.token, session.expiresAt, secureCookie(request)),
        });
      }
      case 'POST /api/member/logout':
        await memberAuth.logout(request.sessionToken);
        return reply.code(204).header('set-cookie', clearedCookie(memberSessionCookie, secureCookie(request))).send();
      case 'GET /api/member/session':
        return sendJson(reply, 200, request.member);
      case 'GET /api/setup/status':
        return sendJson(reply, 200, await adminAuth.setupStatus());
      case 'POST /api/setup':
        warnOnPlainHttp(request);
        return startSession(request, reply, 201, await adminAuth.setup(parseAdminSetup(body)));
      case 'POST /api/admin/login': {
        warnOnPlainHttp(request);
        const input = parseCredentials(body);
        return startSession(request, reply, 200, await adminAuth.login(input.username, input.password));
      }
      case 'POST /api/admin/logout':
        await adminAuth.logout(request.sessionToken);
        return reply.code(204).header('set-cookie', adminCookies(request, null)).send();
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
