import fastifySwagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { adminSessionCookie, memberSessionCookie } from './session.js';
import type { CompiledRoute } from './routes.js';
import { ErrorBodySchema, FieldErrorSchema } from './schemas.js';

/** What each route really requires (API-11, AUTH-9, SEC-5); one value per kind of route. */
export const SECURITY = {
  /** Public reads. */
  none: [],
  /** Admin setup, Admin sign-in and member sign-in: the CSRF header, no session. */
  csrfOnly: [{ csrfHeader: [] }],
  /** Admin reads. */
  adminRead: [{ sessionCookie: [] }],
  /** Admin writes, logout included. */
  adminWrite: [{ sessionCookie: [], csrfHeader: [] }],
  /** Member reads (AUTH-1 deviation). */
  memberRead: [{ memberSessionCookie: [] }],
  /** Member writes, logout included (AUTH-1 deviation, SEC-5). */
  memberWrite: [{ memberSessionCookie: [], csrfHeader: [] }],
} as const;

/** The `security` value of a route, from its auth mode and CSRF requirement. */
export function routeSecurity(route: Pick<CompiledRoute, 'auth' | 'csrf' | 'method'>) {
  if (route.auth === 'admin') return route.method === 'GET' ? SECURITY.adminRead : SECURITY.adminWrite;
  if (route.auth === 'member') return route.method === 'GET' ? SECURITY.memberRead : SECURITY.memberWrite;
  return route.csrf ? SECURITY.csrfOnly : SECURITY.none;
}

/**
 * Registers `@fastify/swagger` (API-11). Call it before any route is added,
 * so every route lands in the document served at `GET /api/openapi.json`.
 */
export function registerOpenApi(app: FastifyInstance, version: string) {
  app.addSchema(FieldErrorSchema);
  app.addSchema(ErrorBodySchema);
  return app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'AGT Knowledge Base API',
        version,
        description: 'The REST API of AGT Knowledge Base. Errors use the `ErrorBody` schema (API-6).',
      },
      components: {
        securitySchemes: {
          sessionCookie: { type: 'apiKey', in: 'cookie', name: adminSessionCookie, description: 'The Admin session.' },
          csrfHeader: { type: 'apiKey', in: 'header', name: 'x-agt-request', description: 'Must be "1".' },
          memberSessionCookie: { type: 'apiKey', in: 'cookie', name: memberSessionCookie, description: 'A member session, from POST /api/member/login.' },
        },
      },
      tags: [
        { name: 'public', description: 'Public reads that need no sign-in.' },
        { name: 'auth', description: 'Member and Admin sign-in, sessions and first-run setup.' },
        { name: 'articles', description: 'Articles and their revisions.' },
        { name: 'tags', description: 'The tag catalog.' },
        { name: 'admin', description: 'The admin dashboard: members, statistics, settings and backups.' },
      ],
    },
    refResolver: { buildLocalReference: (json, _baseUri, _fragment, index) => (typeof json.$id === 'string' ? json.$id : `def-${index}`) },
  });
}
