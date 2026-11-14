import { ArticleService } from './article-service.js';
import { json, noContent, parseBody, pathId } from './api-response.js';
import { requireActor } from './auth.js';
import { HttpError, invalidField } from './http.js';
import { PostgresArticleRepository } from './postgres-article-repository.js';
import type { AppContext } from './context.js';
import type { ApiRequest, ApiResponse } from './routes.js';
import { SettingsService } from './settings-service.js';
import { TagService } from './tag-service.js';
import {
  parseArticleWrite,
  parseListQuery,
  parsePinWrite,
  parseProtectionWrite,
  parseRestoreWrite,
  parseTagListQuery,
  parseTagWrite,
  parseVerificationWrite,
} from '../src/lib/validation.js';

/** Public and member routes. Admin routes are dispatched by `admin-handler.ts`. */

const articleId = (request: ApiRequest) => pathId(request, 'id', 'article', 'INVALID_ID');
const tagId = (request: ApiRequest) => pathId(request, 'tagId', 'tag', 'INVALID_TAG_ID');

function revisionVersion(request: ApiRequest) {
  const version = Number(request.pathParameters.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw invalidField('version', 'invalid_format', 'A valid revision version is required.', 'INVALID_VERSION');
  }
  return version;
}

export type RequestHandler = (request: ApiRequest) => Promise<ApiResponse>;

/**
 * Builds the public/member route dispatcher. Errors are thrown, never turned
 * into responses here: the app's single error handler does that (SRV-5).
 */
export function createRequestHandler(context: Pick<AppContext, 'config' | 'db'>): RequestHandler {
  const repository = new PostgresArticleRepository(context.db);
  const service = new ArticleService(repository);
  const tagService = new TagService(repository);
  const settingsService = new SettingsService(context);

  return async function handleRequest(request: ApiRequest): Promise<ApiResponse> {
    switch (request.routeKey) {
      case 'GET /api/settings':
        return json(200, await settingsService.getPublic(), true);
      case 'GET /api/articles': {
        if (!(await settingsService.getPublic()).allowPublicBrowsing) {
          throw new HttpError(403, 'public_browsing_closed', 'Public browsing is disabled.', { legacyCode: 'PUBLIC_BROWSING_DISABLED' });
        }
        return json(200, await service.list(parseListQuery(request.query), null), true);
      }
      case 'GET /api/articles/{id}': {
        if (!(await settingsService.getPublic()).allowPublicBrowsing) {
          throw new HttpError(403, 'public_browsing_closed', 'Public browsing is disabled.', { legacyCode: 'PUBLIC_BROWSING_DISABLED' });
        }
        return json(200, await service.get(articleId(request), null), true);
      }
      case 'GET /api/tags': {
        if (!(await settingsService.getPublic()).allowPublicBrowsing) {
          throw new HttpError(403, 'public_browsing_closed', 'Public browsing is disabled.', { legacyCode: 'PUBLIC_BROWSING_DISABLED' });
        }
        const input = parseTagListQuery(request.query);
        return json(200, await tagService.list(input.search));
      }
      case 'GET /api/member/tags': {
        requireActor(request);
        const input = parseTagListQuery(request.query);
        return json(200, await tagService.list(input.search));
      }
      case 'GET /api/member/articles':
        return json(200, await service.list(parseListQuery(request.query), requireActor(request)));
      case 'GET /api/member/articles/{id}':
        return json(200, await service.get(articleId(request), requireActor(request)));
      case 'GET /api/articles/{id}/revisions': {
        const actor = requireActor(request);
        return json(200, await service.listRevisions(articleId(request), actor));
      }
      case 'POST /api/articles':
        return json(201, await service.create(parseArticleWrite(parseBody(request)), requireActor(request)));
      case 'POST /api/tags':
        return json(201, await tagService.create(parseTagWrite(parseBody(request)), requireActor(request)));
      case 'PUT /api/tags/{tagId}':
        return json(200, await tagService.update(tagId(request), parseTagWrite(parseBody(request)), requireActor(request)));
      case 'DELETE /api/tags/{tagId}':
        await tagService.delete(tagId(request), requireActor(request));
        return noContent();
      case 'GET /api/tags/orphans':
        return json(200, await tagService.listOrphans(requireActor(request)));
      case 'PUT /api/articles/{id}':
        return json(200, await service.update(articleId(request), parseArticleWrite(parseBody(request)), requireActor(request)));
      case 'PATCH /api/articles/{id}/protection': {
        const input = parseProtectionWrite(parseBody(request));
        return json(200, await service.setProtection(articleId(request), input.isProtected, input.version, requireActor(request)));
      }
      case 'PATCH /api/articles/{id}/pinning': {
        const input = parsePinWrite(parseBody(request));
        return json(200, await service.setPinned(articleId(request), input.isPinned, input.version, requireActor(request)));
      }
      case 'PATCH /api/articles/{id}/verification': {
        const input = parseVerificationWrite(parseBody(request));
        return json(200, await service.setVerified(articleId(request), input.isVerified, input.version, requireActor(request)));
      }
      case 'POST /api/articles/{id}/revisions/{version}/restore': {
        const input = parseRestoreWrite(parseBody(request));
        return json(200, await service.restore(
          articleId(request),
          revisionVersion(request),
          input.currentVersion,
          requireActor(request),
        ));
      }
      case 'DELETE /api/articles/{id}/orphan-tags/{tagId}': {
        const version = Number(request.query.version);
        if (!Number.isSafeInteger(version) || version < 1) throw invalidField('version', 'invalid_format', 'A valid version is required.', 'INVALID_VERSION');
        return json(200, await service.removeOrphanTag(
          articleId(request),
          tagId(request),
          version,
          requireActor(request),
        ));
      }
      case 'DELETE /api/articles/{id}': {
        const version = Number(request.query.version);
        if (!Number.isSafeInteger(version) || version < 1) throw invalidField('version', 'invalid_format', 'A valid version is required.', 'INVALID_VERSION');
        await service.delete(articleId(request), version, requireActor(request));
        return noContent();
      }
      default:
        throw new HttpError(404, 'not_found', 'Route not found.');
    }
  };
}
