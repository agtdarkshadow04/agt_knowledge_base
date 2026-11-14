import { AdminService } from './admin-service.js';
import { json, noContent, parseBody, pathId } from './api-response.js';
import { ArticleService } from './article-service.js';
import { requireAdminSession } from './auth.js';
import { BackupService } from './backup-service.js';
import { HttpError } from './http.js';
import { PostgresArticleRepository } from './postgres-article-repository.js';
import type { AppContext } from './context.js';
import type { ApiRequest, ApiResponse } from './routes.js';
import { SettingsService } from './settings-service.js';
import {
  parseAdminPasswordWrite,
  parseAdminUserCreate,
  parseAdminUserUpdate,
  parseApplicationSettingsWrite,
  parseListQuery,
  parseUserListQuery,
} from '../src/lib/validation.js';

/**
 * Routes of the admin panel. The HTTP server has already verified the Admin
 * session cookie and CSRF header; `requireAdminSession` re-checks that a
 * session is attached so these routes never run without one. Member bearer
 * tokens play no part here, and no member `Actor` is ever set.
 */

const userId = (request: ApiRequest) => pathId(request, 'userId', 'user', 'INVALID_USER_ID');

function restoreAction(request: ApiRequest) {
  const action = request.query.action;
  if (action !== 'preview' && action !== 'restore') {
    throw new HttpError(400, 'INVALID_ACTION', 'The action query parameter must be preview or restore.');
  }
  return action;
}

export type AdminRequestHandler = (request: ApiRequest) => Promise<ApiResponse>;

/** Builds the admin route dispatcher. Errors are thrown for the app's error handler (SRV-5). */
export function createAdminRequestHandler(
  context: Pick<AppContext, 'config' | 'configFile' | 'db' | 'version'>,
): AdminRequestHandler {
  const articleService = new ArticleService(new PostgresArticleRepository(context.db));
  const adminService = new AdminService(context);
  const settingsService = new SettingsService(context);
  const backupService = new BackupService(context, settingsService);

  return async function handleAdminRequest(request: ApiRequest): Promise<ApiResponse> {
    requireAdminSession(request);
    switch (request.routeKey) {
      case 'GET /admin/users':
        return json(200, await adminService.listUsers(parseUserListQuery(request.query)));
      case 'POST /admin/users':
        return json(201, await adminService.createUser(parseAdminUserCreate(parseBody(request))));
      case 'PUT /admin/users/{userId}':
        return json(200, await adminService.updateUser(userId(request), parseAdminUserUpdate(parseBody(request))));
      case 'PUT /admin/users/{userId}/password':
        await adminService.setPassword(userId(request), parseAdminPasswordWrite(parseBody(request)).password);
        return noContent();
      case 'DELETE /admin/users/{userId}':
        await adminService.deleteUser(userId(request));
        return noContent();
      case 'GET /admin/stats':
        return json(200, await adminService.getStats());
      case 'GET /admin/articles':
        return json(200, await articleService.listAll(parseListQuery(request.query)));
      case 'GET /admin/settings':
        return json(200, await settingsService.getAdminView());
      case 'PUT /admin/settings':
        return json(200, await settingsService.update(parseApplicationSettingsWrite(parseBody(request))));
      case 'GET /admin/backup': {
        const backup = await backupService.export();
        return {
          statusCode: 200,
          headers: {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="${backup.filename}"`,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          },
          body: backup.archive,
        };
      }
      case 'POST /admin/backup/restore': {
        const action = restoreAction(request);
        const archive = request.rawBody;
        if (!archive?.length) throw new HttpError(400, 'INVALID_REQUEST', 'Upload a backup archive.');
        return json(200, action === 'preview'
          ? await backupService.preview(archive)
          : await backupService.restore(archive));
      }
      default:
        throw new HttpError(404, 'NOT_FOUND', 'Route not found.');
    }
  };
}
