import fastifyCookie from '@fastify/cookie';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { LogController, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { Transform } from 'node:stream';
import { ZodError } from 'zod';
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

export interface BuildAppOptions {
  /** Fastify's logger option; off by default so tests stay quiet. */
  logger?: FastifyServerOptions['logger'];
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

function sendBody(reply: FastifyReply, statusCode: number, body: unknown, headers: Record<string, string> = {}) {
  return reply
    .code(statusCode)
    .headers({
      ...headers,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    .send(JSON.stringify(body));
}

function sendApiResponse(reply: FastifyReply, result: ApiResponse) {
  return reply.code(result.statusCode).headers(result.headers).send(result.body ?? '');
}

function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? '');
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'The request body must contain valid JSON.');
  }
}

/** Credential routes answer schema failures with one short message and no issue details. */
function credentialsRequired<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ZodError) throw new HttpError(400, 'VALIDATION_ERROR', 'Username and password are required.');
    throw error;
  }
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
      if (size > limit) callback(new BodyTooLargeError());
      else callback(null, chunk);
    },
  });
}

/**
 * Builds the API without listening (SRV-2): routes, authentication, CSRF and
 * rate limits, body limits, and the single error handler (SRV-5). The route
 * paths, auth modes and error bodies are those of the route table in
 * `routes.ts`; `server/index.ts` passes the context and calls `listen()`.
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

  function startSession(request: FastifyRequest, reply: FastifyReply, statusCode: number, session: AdminSessionResult) {
    return sendBody(reply, statusCode, { username: session.admin.username, setupPasswordSet: context.setupPassword !== null }, {
      'set-cookie': sessionCookie(session.token, session.expiresAt, secureCookie(request)),
    });
  }

  // Every body arrives as a Buffer; routes parse JSON themselves so their
  // error codes stay those of the route table's handlers.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.decorateRequest('member', null);
  app.decorateRequest('admin', null);
  app.decorateRequest('adminToken', undefined);
  app.register(fastifyCookie);

  app.setErrorHandler((error, request, reply) => {
    const result = errorReply(error, (unexpected) => request.log.error({ err: unexpected }, 'Unhandled API error'));
    return sendBody(reply, result.statusCode, result.body, result.headers);
  });
  app.setNotFoundHandler((_request, reply) => sendBody(reply, 404, { code: 'NOT_FOUND', message: 'Route not found.' }));

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
      throw new HttpError(404, 'NOT_FOUND', 'Route not found.');
    }
    if (route.rateLimit) {
      const result = rateLimiter.hit(route.rateLimit, request.ip, config.rateLimits[route.rateLimit]);
      if (!result.allowed) throw new RateLimitedError(result.retryAfterSeconds);
    }
    if (route.admin && route.method !== 'GET' && request.headers[csrfHeader] !== '1') {
      throw new HttpError(403, 'CSRF_HEADER_REQUIRED', `Admin requests must include the ${csrfHeader} header.`);
    }
    if (route.auth === 'member') {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required.');
      try {
        request.member = await authenticate(localAuth, token);
      } catch {
        throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired authentication token.');
      }
    } else if (route.auth === 'admin') {
      const token = request.cookies[adminSessionCookie];
      request.adminToken = token;
      request.admin = token ? await adminAuth.session(token) : null;
      if (!request.admin) {
        if (token) reply.header('set-cookie', clearedSessionCookie(secureCookie(request)));
        throw new HttpError(401, 'UNAUTHENTICATED', 'Admin sign-in is required.');
      }
    }
  });

  app.options('/*', async (_request, reply) => reply.code(204).send());

  for (const route of apiRoutes) {
    app.route({
      method: route.method,
      url: route.path.replace(/\{([^}]+)\}/g, ':$1'),
      config: { apiRoute: route },
      // The restore upload is limited by the effective backup.maxBytes setting
      // in preParsing; Fastify's own limit there is only the hard ceiling.
      bodyLimit: route.maxBodyBytes === 'backup' ? maxBackupBodyBytes : route.maxBodyBytes ?? defaultMaxBodyBytes,
      ...(route.maxBodyBytes === 'backup' ? {
        preParsing: async (request: FastifyRequest, _reply: FastifyReply, payload: NodeJS.ReadableStream) => {
          const limit = (await settingsService.getEffective()).backupMaxBytes;
          const declared = Number(request.headers['content-length']);
          if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError();
          return payload.pipe(limitStream(limit));
        },
      } : {}),
      handler: async (request, reply) => serve(route, request, reply),
    });
  }

  async function serve(route: CompiledRoute, request: FastifyRequest, reply: FastifyReply) {
    const rawBody = Buffer.isBuffer(request.body) && request.body.length ? request.body : undefined;
    const body = rawBody && !route.rawBody ? rawBody.toString('utf8') : undefined;

    switch (route.routeKey) {
      case 'POST /auth/login': {
        const input = credentialsRequired(() => parseCredentials(parseJson(body)));
        const signedIn = await localAuth.authenticate(input.username, input.password);
        if (!signedIn) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
        return sendBody(reply, 200, {
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
      case 'GET /auth/session':
        return sendBody(reply, 200, request.member);
      case 'GET /admin/setup/status':
        return sendBody(reply, 200, await adminAuth.setupStatus());
      case 'POST /admin/setup':
        return startSession(request, reply, 201, await adminAuth.setup(parseAdminSetup(parseJson(body))));
      case 'POST /admin/auth/login': {
        const input = credentialsRequired(() => parseCredentials(parseJson(body)));
        return startSession(request, reply, 200, await adminAuth.login(input.username, input.password));
      }
      case 'POST /admin/auth/logout':
        await adminAuth.logout(request.adminToken!);
        return reply
          .code(204)
          .headers({ 'set-cookie': clearedSessionCookie(secureCookie(request)), 'cache-control': 'no-store' })
          .send();
      case 'GET /admin/auth/session':
        return sendBody(reply, 200, { username: request.admin!.username, setupPasswordSet: context.setupPassword !== null });
      case 'PUT /admin/auth/password': {
        const input = parseAdminAccountPassword(parseJson(body));
        return startSession(request, reply, 200, await adminAuth.changePassword(input.currentPassword, input.password));
      }
    }

    const apiRequest = {
      routeKey: route.routeKey,
      pathParameters: request.params as Record<string, string>,
      query: request.query as Record<string, string>,
      body,
      rawBody: route.rawBody ? rawBody : undefined,
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
