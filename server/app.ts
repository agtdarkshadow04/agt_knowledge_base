import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { authenticationHook, createAdminRequestHandler, type AdminRequestHandler } from './adminRoutes.js';
import { auditHook, writeSummary } from './audit.js';
import { toActor, type AuthenticatedUser } from './auth.js';
import type { AppConfig } from './config.js';
import type { AppContext } from './context.js';
import { createRequestHandler, type RequestHandler } from './handler.js';
import { withDataWrite } from './dataWrite.js';
import { noStoreHeaders, securityHeaders } from './headers.js';
import { BodyTooLargeError, errorReply, HttpError, RateLimitedError } from './http.js';
import type { Admission } from './operation.js';
import { registerOpenApi, routeSecurity } from './openapi.js';
import { sharedRateLimitStore } from './rate-limit.js';
import { ping } from './repository.js';
import {
  apiRoutes,
  defaultMaxBodyBytes,
  type ApiRequestUpload,
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
  hashSessionToken,
  legacyAdminSessionCookie,
  MemberAuthService,
  memberSessionCookie,
  sessionCookie,
  type AdminSessionResult,
  type AuthLog,
} from './session.js';
import { SettingsService } from './settings-service.js';
import { parseAdminAccountPassword, parseAdminSetup, parseCredentials } from '../src/lib/validation.js';
import { legacyPageRedirect } from '../src/lib/routes.js';

export { csrfHeader } from './adminRoutes.js';

/** Member UI paths the React router still answers, until query-parameter deep links replace them (FE-4). */

/** The Content-Security-Policy of every response, exactly as SEC-1 gives it. */
export { contentSecurityPolicy, noStoreHeaders } from './headers.js';

export interface BuildAppOptions {
  /** Fastify's logger option; off by default so tests stay quiet. */
  logger?: FastifyServerOptions['logger'];
  /** The pino logger that writes to stdout and the server log (LOG-5); replaces `logger`. */
  loggerInstance?: FastifyServerOptions['loggerInstance'];
  /** The built client (`dist/`) to serve (SRV-9); nothing is served when it is missing. */
  staticDir?: string;
  /** The rate limiter's clock, for tests. */
  rateLimitClock?: () => number;
  /** Runs a `writesData` route's work; `withDataWrite()` on the context's database by default (BAK-8). */
  dataWrite?: <T>(work: () => Promise<T>) => Promise<T>;
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
    /** Whether the route changes the main database (BAK-8). */
    writesData?: boolean;
  }
  interface FastifyRequest {
    member: AuthenticatedUser | null;
    admin: AdminIdentity | null;
    /** The session cookie the authentication hook read, for logout. */
    sessionToken: string | undefined;
    /** The request's admission under the activity lease (BAK-12); released when the response ends. */
    admission: Admission | null;
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

function sendApiResponse(reply: FastifyReply, result: ApiResponse | Outcome) {
  reply.code(result.statusCode).headers(result.headers);
  return result.body === undefined ? reply.send() : reply.send(result.body);
}

/** A response computed before it is sent, so a data write commits first (BAK-12). */
interface Outcome {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body?: unknown;
}

const json = (statusCode: number, body: unknown, headers: Record<string, string | string[]> = {}): Outcome => (
  { statusCode, body, headers: { ...headers, ...jsonType } }
);

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
  // The files Vite copies from public/ (the logo, fonts and their licences, UI-15) at their own paths, never the entry pages.
  for (const file of publicFiles(root, assets)) app.get(`/${file}`, hidden, page(file));
  // FE-4: the member UI's 1.x page paths redirect to their query-parameter deep links (deprecated; removed in 3.0.0).
  const legacyPage = async (request: FastifyRequest, reply: FastifyReply) => {
    const target = legacyPageRedirect(new URL(request.url, 'http://localhost').pathname);
    if (!target) throw new HttpError(404, 'not_found', 'Route not found.', { legacyCode: 'NOT_FOUND' });
    return reply.redirect(target, 301);
  };
  for (const path of ['/login', '/tags', '/articles/*']) app.get(path, hidden, legacyPage);
}

/** Every file under `root` except the entry pages and the hashed build output, as URL paths. */
function publicFiles(root: string, assets: string) {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (path !== assets) walk(path); continue; }
      if (entry.isFile() && !entry.name.endsWith('.html')) files.push(relative(root, path).split(sep).join('/'));
    }
  };
  walk(root);
  return files;
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
    ...(options.loggerInstance ? { loggerInstance: options.loggerInstance } : { logger: options.logger ?? false }),
    trustProxy: trustProxyOption(config.server.trustProxy),
    bodyLimit: defaultMaxBodyBytes,
    // LOG-10: request IDs link an audit entry to its server log entry, across restarts too.
    genReqId: () => randomUUID(),
    // Per-request access logs stay off (LOG-6); the audit log covers user activity.
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
  const backupLog = {
    info: (message: string) => app.log.info({ source: 'backup' }, message),
    warn: (message: string) => app.log.warn({ source: 'backup' }, message),
    error: (message: string) => app.log.error({ source: 'backup' }, message),
  };
  const handleAdminRequest = options.handlers?.admin ?? createAdminRequestHandler(context, { backupLog });

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

  /** A new Admin session; its audit entry names the Admin and only that a setup or password change happened (LOG-14). */
  function startSession(request: FastifyRequest, statusCode: number, session: AdminSessionResult, details?: Record<string, unknown>) {
    request.audit = { actorType: 'admin', actor: session.identity.username, ...(details ? { details } : {}) };
    return json(statusCode, adminSessionBody(session.identity.username), { 'set-cookie': adminCookies(request, session) });
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
  // BAK-1: the restore upload; parts are streamed to a temporary file in serve().
  app.register(fastifyMultipart, { limits: { files: 1, fields: 2, fieldSize: 100, parts: 3 } });
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
    // LOG-7, LOG-8: an unexpected error is a server log entry with its name, message, stack and route only (LOG-9).
    const result = errorReply(error, (unexpected) => request.log.error(
      { err: unexpected, source: 'http', route: request.routeOptions.url },
      'Unhandled API error',
    ));
    // LOG-14: a failure's audit entry names the error code and the failed fields, never their values.
    request.auditError = { error: result.body.error, ...(result.body.fields ? { fields: result.body.fields.map((field) => field.field) } : {}) };
    return sendError(reply, result.statusCode, result.body, result.headers);
  });
  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, { error: 'not_found', message: 'Route not found.', code: 'NOT_FOUND' }));

  // BAK-12 admission: every /api/ request except the health check is admitted
  // under the activity lease, before authentication, so a restore never sees
  // a request touch the database. The BAK-11 recovery session is recognised here.
  app.decorateRequest('admission', null);
  app.decorateRequest('audit', null);
  app.decorateRequest('auditError', null);
  // LOG-11: one hook audits every write, every audited read and every denial.
  app.addHook('onResponse', auditHook(context.logs));
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.config.apiRoute;
    if (!route || route.routeKey === 'GET /api/health') return;
    const token = request.cookies[adminSessionCookie];
    const admission = await context.operations.admit({
      routeKey: route.handlerKey,
      ...(route.admin && token ? { adminTokenHash: hashSessionToken(token) } : {}),
    });
    request.admission = admission;
    reply.raw.once('close', () => admission.release());
    if (admission.recovery) {
      request.admin = { username: admission.recovery.username };
      request.sessionToken = token;
    }
  });
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
          writesData: route.writesData,
          audit: route.audit === true,
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
            // @fastify/multipart reads the raw request itself and enforces the limit as fileSize.
            return route.multipart ? payload : payload.pipe(limitStream(limit));
          },
        } : {}),
        handler: async (request, reply) => serve(route, request, reply),
      });
    }

    if (options.staticDir && existsSync(join(options.staticDir, 'index.html'))) registerStatic(routes, options.staticDir);
  });

  const dataWrite = options.dataWrite ?? (<T>(work: () => Promise<T>) => withDataWrite(context.db, work));

  /** `<dataDir>/<backupsDir>/tmp/<uuid>`: uploads are streamed there and the directory is always deleted (SEC-10). */
  async function uploadDirectory() {
    const directory = join(resolve(config.storage.dataDir, config.storage.backupsDir), 'tmp', randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  /** Reads the multipart restore upload: the `backup` file into `directory`, `action` as text (BAK-1). */
  async function readUpload(request: FastifyRequest, directory: string) {
    if (!request.isMultipart()) throw new HttpError(415, 'multipart_required', 'Send the backup as multipart/form-data with the backup file and action.');
    const maxBytes = (await settingsService.values())['backup.maxZipBytes'];
    let action: string | undefined;
    let file: string | undefined;
    for await (const part of request.parts({ limits: { fileSize: maxBytes, files: 1, fields: 2, fieldSize: 100 } })) {
      if (part.type === 'field') {
        if (part.fieldname !== 'action') throw new HttpError(400, 'invalid_request', `Unexpected form field ${part.fieldname.slice(0, 50)}.`);
        action = String(part.value);
        continue;
      }
      if (part.fieldname !== 'backup' || file) throw new HttpError(400, 'invalid_request', 'Send exactly one file, named backup.');
      const target = join(directory, 'upload.zip');
      await pipeline(part.file, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
      if (part.file.truncated) throw new BodyTooLargeError(maxBytes);
      file = target;
    }
    if (!file) throw new HttpError(400, 'file_required', 'Upload a backup archive as the backup file.');
    return { action: action ?? '', file };
  }

  async function serve(route: CompiledRoute, request: FastifyRequest, reply: FastifyReply) {
    let directory: string | undefined;
    try {
      let upload: ApiRequestUpload | undefined;
      if (route.multipart) {
        directory = await uploadDirectory();
        upload = await readUpload(request, directory);
      } else if (route.rawBody) {
        // The deprecated restore path: the body is the archive itself.
        directory = await uploadDirectory();
        const file = join(directory, 'upload.zip');
        await writeFile(file, Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0), { mode: 0o600 });
        upload = { action: (request.query as Record<string, string>).action ?? '', file };
      }
      const work = () => compute(route, request, upload);
      const outcome = route.writesData ? await dataWrite(work) : await work();
      return sendApiResponse(reply, outcome);
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  async function compute(route: CompiledRoute, request: FastifyRequest, upload?: ApiRequestUpload): Promise<Outcome> {
    const body = route.rawBody || route.multipart ? undefined : request.body;

    switch (route.handlerKey) {
      case 'GET /api/health': {
        // BAK-8: Docker must not restart the container mid-restore (SRV-11).
        const { state } = context.operations;
        if (state === 'restore' || state === 'restore_failed') return json(200, { status: 'maintenance' });
        await ping(context.db);
        return json(200, { status: 'ok' });
      }
      case 'POST /api/member/login': {
        warnOnPlainHttp(request);
        const input = parseCredentials(body);
        const session = await memberAuth.login(input.username, input.password);
        request.audit = { actorType: 'member', actor: session.identity.username };
        return json(200, session.identity, {
          'set-cookie': sessionCookie(memberSessionCookie, session.token, session.expiresAt, secureCookie(request)),
        });
      }
      case 'POST /api/member/logout':
        await memberAuth.logout(request.sessionToken);
        return { statusCode: 204, headers: { 'set-cookie': clearedCookie(memberSessionCookie, secureCookie(request)) } };
      case 'GET /api/member/session':
        return json(200, request.member);
      case 'GET /api/setup/status':
        return json(200, await adminAuth.setupStatus());
      case 'POST /api/setup':
        warnOnPlainHttp(request);
        return startSession(request, 201, await adminAuth.setup(parseAdminSetup(body)), { setup: true });
      case 'POST /api/admin/login': {
        warnOnPlainHttp(request);
        const input = parseCredentials(body);
        return startSession(request, 200, await adminAuth.login(input.username, input.password));
      }
      case 'POST /api/admin/logout':
        await adminAuth.logout(request.sessionToken);
        return { statusCode: 204, headers: { 'set-cookie': adminCookies(request, null) } };
      case 'GET /api/admin/session':
        return json(200, adminSessionBody(request.admin!.username));
      case 'POST /api/admin/password': {
        const input = parseAdminAccountPassword(body);
        return startSession(request, 200, await adminAuth.changePassword(input.currentPassword, input.password), { passwordChanged: true });
      }
    }

    const apiRequest = {
      routeKey: route.handlerKey,
      pathParameters: request.params as Record<string, string>,
      query: request.query as Record<string, string>,
      body,
      upload,
      sessionToken: request.sessionToken,
      requestId: request.id,
    };
    const result = route.admin
      ? await handleAdminRequest({ ...apiRequest, actor: null, admin: request.admin })
      : await handleRequest({ ...apiRequest, actor: request.member ? toActor(request.member) : null });
    // LOG-14: a write's summary (names and field names, never values), refined by the handler.
    if (route.method !== 'GET' || route.audit) {
      const summary = route.writesData ? writeSummary(body, result.body) : {};
      request.audit = { ...summary, ...result.audit, details: { ...summary.details, ...result.audit?.details } };
    }
    // A restore replaces the Admin account, so the caller signs in again (BAK-4 step 6.4).
    if (result.endsAdminSession) return { ...result, headers: { ...result.headers, 'set-cookie': adminCookies(request, null) } };
    return result;
  }

  return app;
}

export type App = ReturnType<typeof buildApp>;
