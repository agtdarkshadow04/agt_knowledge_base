import { MemberRepository } from './repository/members.js';
import { json, noContent, parseBody, pathId } from './api-response.js';
import { ArticleService } from './article-service.js';
import { requireAdminSession } from './auth.js';
import { BackupService } from './backup.js';
import { adminSessionExpiry } from './repository/sessions.js';
import { HttpError, invalidField } from './http.js';
import { PostgresArticleRepository } from './repository/articles.js';
import type { AppContext } from './context.js';
import type { ApiRequest, ApiResponse } from './routes.js';
import { SettingsService, type SettingsWrite } from './settings-service.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { adminSessionCookie, clearedCookie, hashSessionToken, memberSessionCookie, type AdminAuthService, type MemberAuthService } from './session.js';
import {
  parseAdminPasswordWrite,
  parseAdminUserCreate,
  parseAdminUserUpdate,
  parseListQuery,
  parseUserListQuery,
} from '../src/lib/validation.js';

/** Header every state-changing request to the admin, setup and member API must carry (SEC-5, NAME-3). */
export const csrfHeader = 'x-agt-request';

export interface AuthenticationHookOptions {
  adminAuth: Pick<AdminAuthService, 'session'>;
  memberAuth: Pick<MemberAuthService, 'session'>;
  /** Whether cookies get the Secure attribute for this request (`session.secureCookie`). */
  secureCookie(request: FastifyRequest): boolean;
}

/**
 * The one `onRequest` hook that authenticates API requests (AUTH-9). It runs
 * before the body is read, so anonymous clients cannot make the server buffer
 * large bodies:
 * - a state-changing request to `/api/admin/*`, `/api/setup` or a member route
 *   without `x-agt-request: 1` gets `403 csrf` (SEC-5);
 * - every `/api/admin/*` route except login needs the Admin session cookie, and
 *   every member route the member session cookie (`401 unauthorized`). Neither
 *   cookie is ever accepted in place of the other (AUTH-1 deviation).
 * Rate limits (SEC-7) run right after it, as route hooks of `@fastify/rate-limit`.
 */
export function authenticationHook(options: AuthenticationHookOptions) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const route = request.routeOptions.config.apiRoute;
    if (!route) return;
    // The router lets a last path parameter be empty (`/articles/`); the route table does not.
    if (Object.values(request.params as Record<string, string>).some((value) => value === '')) {
      throw new HttpError(404, 'not_found', 'Route not found.');
    }
    if (route.csrf && request.headers[csrfHeader] !== '1') {
      throw new HttpError(403, 'csrf', `Requests that change data must include the ${csrfHeader}: 1 header.`, { legacyCode: 'CSRF_HEADER_REQUIRED' });
    }
    if (route.auth === 'none') return;
    // The BAK-11 recovery session was recognised at admission; the restored sessions table is never consulted.
    if (route.auth === 'admin' && request.admission?.recovery) return;
    const cookie = route.auth === 'admin' ? adminSessionCookie : memberSessionCookie;
    const token = request.cookies[cookie];
    request.sessionToken = token;
    if (route.auth === 'admin') request.admin = await options.adminAuth.session(token);
    else request.member = await options.memberAuth.session(token);
    if (route.auth === 'admin' ? request.admin : request.member) return;
    // An unknown or expired session cookie is cleared so the browser stops sending it.
    if (token) reply.header('set-cookie', clearedCookie(cookie, options.secureCookie(request)));
    throw new HttpError(401, 'unauthorized', route.auth === 'admin' ? 'Admin sign-in is required.' : 'Sign-in is required.', { legacyCode: 'UNAUTHENTICATED' });
  };
}

/**
 * Routes of the admin panel. `authenticationHook` has already verified the
 * Admin session cookie and CSRF header; `requireAdminSession` re-checks that a
 * session is attached so these routes never run without one. Member sessions
 * play no part here, and no member `Actor` is ever set.
 */

const userId = (request: ApiRequest) => pathId(request, 'userId', 'user', 'INVALID_USER_ID');

function restoreAction(request: ApiRequest) {
  const action = request.upload?.action;
  if (action !== 'preview' && action !== 'restore') {
    throw invalidField('action', 'not_allowed', 'The action field must be preview or restore.', 'INVALID_ACTION');
  }
  return action;
}

export type AdminRequestHandler = (request: ApiRequest) => Promise<ApiResponse>;

/** Builds the admin route dispatcher. Errors are thrown for the app's error handler (SRV-5). */
export function createAdminRequestHandler(
  context: Pick<AppContext, 'config' | 'configFile' | 'db' | 'version' | 'operations' | 'toolPath'>,
  options: { backupLog?: { info(message: string): void; warn(message: string): void; error(message: string): void } } = {},
): AdminRequestHandler {
  const articleService = new ArticleService(new PostgresArticleRepository(context.db));
  const members = new MemberRepository(context);
  const settingsService = new SettingsService(context);
  const backupService = new BackupService(context, settingsService, { log: options.backupLog });

  return async function handleAdminRequest(request: ApiRequest): Promise<ApiResponse> {
    requireAdminSession(request);
    switch (request.routeKey) {
      case 'GET /api/admin/users':
        return json(200, await members.listUsers(parseUserListQuery(request.query)));
      case 'POST /api/admin/users':
        return json(201, await members.createUser(parseAdminUserCreate(parseBody(request))));
      case 'PUT /api/admin/users/{userId}':
        return json(200, await members.updateUser(userId(request), parseAdminUserUpdate(parseBody(request))));
      case 'PUT /api/admin/users/{userId}/password':
        await members.setPassword(userId(request), parseAdminPasswordWrite(parseBody(request)).password);
        return noContent();
      case 'DELETE /api/admin/users/{userId}':
        await members.deleteUser(userId(request));
        return noContent();
      case 'GET /api/admin/stats':
        return json(200, await members.getStats());
      case 'GET /api/admin/articles':
        return json(200, await articleService.listAll(parseListQuery(request.query)));
      case 'GET /api/admin/settings':
        return json(200, await settingsService.getAdminView());
      case 'PUT /api/admin/settings':
        return json(200, await settingsService.update(parseBody(request) as SettingsWrite));
      case 'GET /api/admin/backup': {
        const backup = await backupService.backup();
        return {
          statusCode: 200,
          headers: {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="${backup.filename}"`,
            'content-length': String(backup.size),
          },
          body: backup.stream,
        };
      }
      case 'POST /api/admin/restore':
      case 'POST /api/admin/backup/restore': {
        const action = restoreAction(request);
        const upload = request.upload;
        if (!upload) throw new HttpError(400, 'file_required', 'Upload a backup archive as the backup file.');
        if (action === 'preview') return json(200, await backupService.preview(upload.file));
        // BAK-11: the restoring Admin's session becomes the recovery session.
        const token = request.sessionToken ?? '';
        const tokenHash = hashSessionToken(token);
        const recovery = context.operations.state === 'restore_failed';
        const expiresAt = recovery ? new Date(0) : await adminSessionExpiry(await context.db.pool(), tokenHash);
        if (!expiresAt) throw new HttpError(401, 'unauthorized', 'Admin sign-in is required.', { legacyCode: 'UNAUTHENTICATED' });
        const report = await backupService.restore(upload.file, { tokenHash, username: request.admin!.username, expiresAt }, recovery);
        return { ...json(200, report), endsAdminSession: true };
      }
      default:
        throw new HttpError(404, 'not_found', 'Route not found.');
    }
  };
}
