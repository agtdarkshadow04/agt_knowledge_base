import { AdminService } from './admin-service.js';
import { errorResponse, json, noContent, parseBody, pathId } from './api-response.js';
import { ArticleService } from './article-service.js';
import { requireAdminSession } from './auth.js';
import { BackupService } from './backup-service.js';
import { AppError } from './domain.js';
import { PostgresArticleRepository } from './postgres-article-repository.js';
import type { ApiRequest, ApiResponse } from './routes.js';
import { SettingsService } from './settings-service.js';
import {
  parseAdminPasswordWrite,
  parseAdminUserCreate,
  parseAdminUserUpdate,
  parseApplicationSettingsWrite,
  parseListQuery,
  parseUserListQuery,
} from './validation.js';

/**
 * Routes of the admin panel. The HTTP server has already verified the Admin
 * session cookie and CSRF header; `requireAdminSession` re-checks that a
 * session is attached so these routes never run without one. Member bearer
 * tokens play no part here, and no member `Actor` is ever set.
 */

const articleService = new ArticleService(new PostgresArticleRepository());
const adminService = new AdminService();
const settingsService = new SettingsService();
const backupService = new BackupService();

const userId = (request: ApiRequest) => pathId(request, 'userId', 'user', 'INVALID_USER_ID');

function restoreAction(request: ApiRequest) {
  const action = request.query.action;
  if (action !== 'preview' && action !== 'restore') {
    throw new AppError('The action query parameter must be preview or restore.', 400, 'INVALID_ACTION');
  }
  return action;
}

export async function handleAdminRequest(request: ApiRequest): Promise<ApiResponse> {
  try {
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
        if (!archive?.length) throw new AppError('Upload a backup archive.', 400, 'INVALID_REQUEST');
        return json(200, action === 'preview'
          ? await backupService.preview(archive)
          : await backupService.restore(archive));
      }
      default:
        return json(404, { code: 'NOT_FOUND', message: 'Route not found.' });
    }
  } catch (error) {
    return errorResponse(error, request.requestId);
  }
}
