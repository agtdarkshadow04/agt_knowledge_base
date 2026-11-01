import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import { ArticleService } from './article-service.js';
import { AdminService } from './admin-service.js';
import { requireActor, requireAdmin } from './auth.js';
import { AppError } from './domain.js';
import { PostgresArticleRepository } from './postgres-article-repository.js';
import { TagService } from './tag-service.js';
import {
  parseArticleWrite,
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
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(statusCode: number, body: unknown, publiclyCacheable = false): APIGatewayProxyResultV2 {
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

function parseBody(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  if (!event.body) throw new AppError('A JSON request body is required.', 400, 'INVALID_REQUEST');
  try {
    const value = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return JSON.parse(value) as unknown;
  } catch {
    throw new AppError('The request body must contain valid JSON.', 400, 'INVALID_JSON');
  }
}

function articleId(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const id = event.pathParameters?.id;
  if (!id || !uuidPattern.test(id)) throw new AppError('A valid article id is required.', 400, 'INVALID_ID');
  return id;
}

function tagId(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const id = event.pathParameters?.tagId;
  if (!id || !uuidPattern.test(id)) throw new AppError('A valid tag id is required.', 400, 'INVALID_TAG_ID');
  return id;
}

function userId(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const id = event.pathParameters?.userId;
  if (!id || !uuidPattern.test(id)) throw new AppError('A valid user id is required.', 400, 'INVALID_USER_ID');
  return id;
}

function revisionVersion(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const version = Number(event.pathParameters?.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new AppError('A valid revision version is required.', 400, 'INVALID_VERSION');
  }
  return version;
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  try {
    switch (event.routeKey) {
      case 'GET /settings':
        return json(200, await adminService.getSettings(), true);
      case 'GET /articles': {
        if (!(await adminService.getSettings()).allowPublicBrowsing) {
          throw new AppError('Public browsing is disabled.', 403, 'PUBLIC_BROWSING_DISABLED');
        }
        return json(200, await service.list(parseListQuery(event.queryStringParameters ?? {}), null), true);
      }
      case 'GET /articles/{id}': {
        if (!(await adminService.getSettings()).allowPublicBrowsing) {
          throw new AppError('Public browsing is disabled.', 403, 'PUBLIC_BROWSING_DISABLED');
        }
        return json(200, await service.get(articleId(event), null), true);
      }
      case 'GET /tags': {
        if (!(await adminService.getSettings()).allowPublicBrowsing) {
          throw new AppError('Public browsing is disabled.', 403, 'PUBLIC_BROWSING_DISABLED');
        }
        const input = parseTagListQuery(event.queryStringParameters ?? {});
        return json(200, await tagService.list(input.search));
      }
      case 'GET /member/tags': {
        requireActor(event);
        const input = parseTagListQuery(event.queryStringParameters ?? {});
        return json(200, await tagService.list(input.search));
      }
      case 'GET /member/articles':
        return json(200, await service.list(parseListQuery(event.queryStringParameters ?? {}), requireActor(event)));
      case 'GET /member/articles/{id}':
        return json(200, await service.get(articleId(event), requireActor(event)));
      case 'GET /articles/{id}/revisions': {
        const actor = requireActor(event);
        return json(200, await service.listRevisions(articleId(event), actor));
      }
      case 'POST /articles':
        return json(201, await service.create(parseArticleWrite(parseBody(event)), requireActor(event)));
      case 'POST /tags':
        return json(201, await tagService.create(parseTagWrite(parseBody(event)), requireActor(event)));
      case 'PUT /tags/{tagId}':
        return json(200, await tagService.update(tagId(event), parseTagWrite(parseBody(event)), requireActor(event)));
      case 'DELETE /tags/{tagId}':
        await tagService.delete(tagId(event), requireActor(event));
        return { statusCode: 204, headers: { 'cache-control': 'no-store' } };
      case 'GET /tags/orphans':
        return json(200, await tagService.listOrphans(requireActor(event)));
      case 'GET /admin/users':
        requireAdmin(event);
        return json(200, await adminService.listUsers(parseUserListQuery(event.queryStringParameters ?? {})));
      case 'POST /admin/users':
        return json(201, await adminService.createUser(
          parseAdminUserCreate(parseBody(event)),
          requireAdmin(event),
        ));
      case 'PUT /admin/users/{userId}':
        return json(200, await adminService.updateUser(
          userId(event),
          parseAdminUserUpdate(parseBody(event)),
          requireAdmin(event),
        ));
      case 'PUT /admin/users/{userId}/password':
        await adminService.setPassword(
          userId(event),
          parseAdminPasswordWrite(parseBody(event)).password,
          requireAdmin(event),
        );
        return { statusCode: 204, headers: { 'cache-control': 'no-store' } };
      case 'DELETE /admin/users/{userId}':
        await adminService.deleteUser(userId(event), requireAdmin(event));
        return { statusCode: 204, headers: { 'cache-control': 'no-store' } };
      case 'GET /admin/stats':
        requireAdmin(event);
        return json(200, await adminService.getStats());
      case 'GET /admin/articles':
        return json(200, await service.list(
          parseListQuery(event.queryStringParameters ?? {}),
          requireAdmin(event),
        ));
      case 'PUT /admin/settings':
        requireAdmin(event);
        return json(200, await adminService.updateSettings(parseApplicationSettingsWrite(parseBody(event))));
      case 'PUT /articles/{id}':
        return json(200, await service.update(articleId(event), parseArticleWrite(parseBody(event)), requireActor(event)));
      case 'PATCH /articles/{id}/protection': {
        const input = parseProtectionWrite(parseBody(event));
        return json(200, await service.setProtection(articleId(event), input.isProtected, input.version, requireActor(event)));
      }
      case 'PATCH /articles/{id}/pinning': {
        const input = parsePinWrite(parseBody(event));
        return json(200, await service.setPinned(articleId(event), input.isPinned, input.version, requireActor(event)));
      }
      case 'PATCH /articles/{id}/verification': {
        const input = parseVerificationWrite(parseBody(event));
        return json(200, await service.setVerified(articleId(event), input.isVerified, input.version, requireActor(event)));
      }
      case 'POST /articles/{id}/revisions/{version}/restore': {
        const input = parseRestoreWrite(parseBody(event));
        return json(200, await service.restore(
          articleId(event),
          revisionVersion(event),
          input.currentVersion,
          requireActor(event),
        ));
      }
      case 'DELETE /articles/{id}/orphan-tags/{tagId}': {
        const version = Number(event.queryStringParameters?.version);
        if (!Number.isSafeInteger(version) || version < 1) throw new AppError('A valid version is required.', 400, 'INVALID_VERSION');
        return json(200, await service.removeOrphanTag(
          articleId(event),
          tagId(event),
          version,
          requireActor(event),
        ));
      }
      case 'DELETE /articles/{id}': {
        const version = Number(event.queryStringParameters?.version);
        if (!Number.isSafeInteger(version) || version < 1) throw new AppError('A valid version is required.', 400, 'INVALID_VERSION');
        await service.delete(articleId(event), version, requireActor(event));
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
    console.error('Unhandled API error', { requestId: event.requestContext.requestId, error });
    return json(500, { code: 'INTERNAL_ERROR', message: 'The archive service encountered an unexpected error.' });
  }
}
