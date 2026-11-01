import { ZodError } from 'zod';
import { ArticleService } from './article-service.js';
import { AdminService } from './admin-service.js';
import { requireActor, requireAdmin, requireSuperAdmin } from './auth.js';
import { BackupService } from './backup-service.js';
import { AppError } from './domain.js';
import { PostgresArticleRepository } from './postgres-article-repository.js';
import type { ApiRequest, ApiResponse } from './routes.js';
import { TagService } from './tag-service.js';
import {
  parseArticleWrite,
  parseBackup,
  parseAdminPasswordWrite,
  parseAdminUserCreate,
  parseAdminUserUpdate,
  parseApplicationSettingsWrite,
  parseListQuery,
  parsePinWrite,
  parseProtectionWrite,
  parseRestoreWrite,
  parseTagListQuery,
  parseTagWrite,
  parseUserListQuery,
  parseVerificationWrite,
} from './validation.js';

const repository = new PostgresArticleRepository();
const service = new ArticleService(repository);
const tagService = new TagService(repository);
const adminService = new AdminService();
const backupService = new BackupService();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(statusCode: number, body: unknown, publiclyCacheable = false): ApiResponse {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': statusCode === 200 && publiclyCacheable ? 'public, max-age=30' : 'no-store',
      'x-content-type-options': 'nosniff',
    },
    body: JSON.stringify(body),
  };
}

function parseBody(request: ApiRequest) {
  if (!request.body) throw new AppError('A JSON request body is required.', 400, 'INVALID_REQUEST');
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw new AppError('The request body must contain valid JSON.', 400, 'INVALID_JSON');
  }
}

function articleId(request: ApiRequest) {
  const id = request.pathParameters.id;
  if (!id || !uuidPattern.test(id)) throw new AppError('A valid article id is required.', 400, 'INVALID_ID');
  return id;
}

function tagId(request: ApiRequest) {
  const id = request.pathParameters.tagId;
  if (!id || !uuidPattern.test(id)) throw new AppError('A valid tag id is required.', 400, 'INVALID_TAG_ID');
  return id;
}

function userId(request: ApiRequest) {
  const id = request.pathParameters.userId;
  if (!id || !uuidPattern.test(id)) throw new AppError('A valid user id is required.', 400, 'INVALID_USER_ID');
  return id;
}

function revisionVersion(request: ApiRequest) {
  const version = Number(request.pathParameters.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new AppError('A valid revision version is required.', 400, 'INVALID_VERSION');
  }
  return version;
}

export async function handleRequest(request: ApiRequest): Promise<ApiResponse> {
  try {
    switch (request.routeKey) {
      case 'GET /settings':
        return json(200, await adminService.getSettings(), true);
      case 'GET /articles': {
        if (!(await adminService.getSettings()).allowPublicBrowsing) {
          throw new AppError('Public browsing is disabled.', 403, 'PUBLIC_BROWSING_DISABLED');
        }
        return json(200, await service.list(parseListQuery(request.query), null), true);
      }
      case 'GET /articles/{id}': {
        if (!(await adminService.getSettings()).allowPublicBrowsing) {
          throw new AppError('Public browsing is disabled.', 403, 'PUBLIC_BROWSING_DISABLED');
        }
        return json(200, await service.get(articleId(request), null), true);
      }
      case 'GET /tags': {
        if (!(await adminService.getSettings()).allowPublicBrowsing) {
          throw new AppError('Public browsing is disabled.', 403, 'PUBLIC_BROWSING_DISABLED');
        }
        const input = parseTagListQuery(request.query);
        return json(200, await tagService.list(input.search));
      }
      case 'GET /member/tags': {
        requireActor(request);
        const input = parseTagListQuery(request.query);
        return json(200, await tagService.list(input.search));
      }
      case 'GET /member/articles':
        return json(200, await service.list(parseListQuery(request.query), requireActor(request)));
      case 'GET /member/articles/{id}':
        return json(200, await service.get(articleId(request), requireActor(request)));
      case 'GET /articles/{id}/revisions': {
        const actor = requireActor(request);
        return json(200, await service.listRevisions(articleId(request), actor));
      }
      case 'POST /articles':
        return json(201, await service.create(parseArticleWrite(parseBody(request)), requireActor(request)));
      case 'POST /tags':
        return json(201, await tagService.create(parseTagWrite(parseBody(request)), requireActor(request)));
      case 'PUT /tags/{tagId}':
        return json(200, await tagService.update(tagId(request), parseTagWrite(parseBody(request)), requireActor(request)));
      case 'DELETE /tags/{tagId}':
        await tagService.delete(tagId(request), requireActor(request));
        return { statusCode: 204, headers: { 'cache-control': 'no-store' } };
      case 'GET /tags/orphans':
        return json(200, await tagService.listOrphans(requireActor(request)));
      case 'GET /admin/users':
        requireAdmin(request);
        return json(200, await adminService.listUsers(parseUserListQuery(request.query)));
      case 'POST /admin/users':
        return json(201, await adminService.createUser(
          parseAdminUserCreate(parseBody(request)),
          requireAdmin(request),
        ));
      case 'PUT /admin/users/{userId}':
        return json(200, await adminService.updateUser(
          userId(request),
          parseAdminUserUpdate(parseBody(request)),
          requireAdmin(request),
        ));
      case 'PUT /admin/users/{userId}/password':
        await adminService.setPassword(
          userId(request),
          parseAdminPasswordWrite(parseBody(request)).password,
          requireAdmin(request),
        );
        return { statusCode: 204, headers: { 'cache-control': 'no-store' } };
      case 'DELETE /admin/users/{userId}':
        await adminService.deleteUser(userId(request), requireAdmin(request));
        return { statusCode: 204, headers: { 'cache-control': 'no-store' } };
      case 'GET /admin/stats':
        requireAdmin(request);
        return json(200, await adminService.getStats());
      case 'GET /admin/articles':
        return json(200, await service.list(
          parseListQuery(request.query),
          requireAdmin(request),
        ));
      case 'PUT /admin/settings':
        requireAdmin(request);
        return json(200, await adminService.updateSettings(parseApplicationSettingsWrite(parseBody(request))));
      case 'GET /admin/backup': {
        const backup = await backupService.export(requireSuperAdmin(request));
        const stamp = backup.createdAt.replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
        const response = json(200, backup);
        response.headers['content-disposition'] = `attachment; filename="agt-backup-${stamp}.json"`;
        return response;
      }
      case 'POST /admin/backup/restore': {
        const actor = requireSuperAdmin(request);
        return json(200, { restored: await backupService.restore(parseBackup(parseBody(request)), actor) });
      }
      case 'PUT /articles/{id}':
        return json(200, await service.update(articleId(request), parseArticleWrite(parseBody(request)), requireActor(request)));
      case 'PATCH /articles/{id}/protection': {
        const input = parseProtectionWrite(parseBody(request));
        return json(200, await service.setProtection(articleId(request), input.isProtected, input.version, requireActor(request)));
      }
      case 'PATCH /articles/{id}/pinning': {
        const input = parsePinWrite(parseBody(request));
        return json(200, await service.setPinned(articleId(request), input.isPinned, input.version, requireActor(request)));
      }
      case 'PATCH /articles/{id}/verification': {
        const input = parseVerificationWrite(parseBody(request));
        return json(200, await service.setVerified(articleId(request), input.isVerified, input.version, requireActor(request)));
      }
      case 'POST /articles/{id}/revisions/{version}/restore': {
        const input = parseRestoreWrite(parseBody(request));
        return json(200, await service.restore(
          articleId(request),
          revisionVersion(request),
          input.currentVersion,
          requireActor(request),
        ));
      }
      case 'DELETE /articles/{id}/orphan-tags/{tagId}': {
        const version = Number(request.query.version);
        if (!Number.isSafeInteger(version) || version < 1) throw new AppError('A valid version is required.', 400, 'INVALID_VERSION');
        return json(200, await service.removeOrphanTag(
          articleId(request),
          tagId(request),
          version,
          requireActor(request),
        ));
      }
      case 'DELETE /articles/{id}': {
        const version = Number(request.query.version);
        if (!Number.isSafeInteger(version) || version < 1) throw new AppError('A valid version is required.', 400, 'INVALID_VERSION');
        await service.delete(articleId(request), version, requireActor(request));
        return { statusCode: 204, headers: { 'cache-control': 'no-store' } };
      }
      default:
        return json(404, { code: 'NOT_FOUND', message: 'Route not found.' });
    }
  } catch (error) {
    if (error instanceof AppError) return json(error.statusCode, { code: error.code, message: error.message });
    if (error instanceof ZodError) {
      return json(400, {
        code: 'VALIDATION_ERROR',
        message: `The request is invalid: ${error.issues[0].message}`,
        issues: error.issues,
      });
    }
    console.error('Unhandled API error', { requestId: request.requestId, error });
    return json(500, { code: 'INTERNAL_ERROR', message: 'The archive service encountered an unexpected error.' });
  }
}
