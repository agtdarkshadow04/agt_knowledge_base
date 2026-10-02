import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import { ArticleService } from './article-service.js';
import { requireActor } from './auth.js';
import { AppError } from './domain.js';
import { PostgresArticleRepository } from './postgres-article-repository.js';
import { parseArticleWrite, parseListQuery, parseProtectionWrite, parseRestoreWrite } from './validation.js';

const service = new ArticleService(new PostgresArticleRepository());
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': statusCode === 200 ? 'public, max-age=30' : 'no-store',
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
      case 'GET /articles':
        return json(200, await service.list(parseListQuery(event.queryStringParameters ?? {})));
      case 'GET /articles/{id}':
        return json(200, await service.get(articleId(event)));
      case 'GET /articles/{id}/revisions':
        requireActor(event);
        return json(200, await service.listRevisions(articleId(event)));
      case 'POST /articles':
        return json(201, await service.create(parseArticleWrite(parseBody(event)), requireActor(event)));
      case 'PUT /articles/{id}':
        return json(200, await service.update(articleId(event), parseArticleWrite(parseBody(event)), requireActor(event)));
      case 'PATCH /articles/{id}/protection': {
        const input = parseProtectionWrite(parseBody(event));
        return json(200, await service.setProtection(articleId(event), input.isProtected, input.version, requireActor(event)));
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
