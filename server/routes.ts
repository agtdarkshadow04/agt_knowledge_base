import { Type, type TSchema } from '@sinclair/typebox';
import type { Actor } from './domain.js';
import * as S from './schemas.js';

export interface AdminIdentity {
  username: string;
}

export interface ApiRequest {
  /** The canonical route key the handlers switch on, e.g. `GET /api/articles/{id}`. */
  routeKey: string;
  pathParameters: Record<string, string>;
  query: Record<string, string>;
  /** The parsed JSON request body, already checked against the route's TypeBox schema. */
  body?: unknown;
  /** The raw request body, for routes declared with `rawBody` (backup uploads). */
  rawBody?: Buffer;
  /** The signed-in member, or null on public and admin routes and anonymous requests. */
  actor: Actor | null;
  /** The signed-in installation Admin; set only on admin routes. */
  admin?: AdminIdentity | null;
  requestId: string;
}

export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  /** A JSON value, serialized with the route's response schema, or a Buffer sent as is. */
  body?: unknown;
}

/**
 * - `none`: no credentials are checked (public reads, member sign-in, Admin setup and sign-in).
 * - `member`: a member bearer token is required; admin cookies are ignored.
 * - `admin`: an Admin session cookie is required; bearer tokens are ignored.
 */
export type RouteAuth = 'none' | 'member' | 'admin';
export type RateLimitName = 'login' | 'adminLogin' | 'setup' | 'adminPassword';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  auth: RouteAuth;
  operationId: string;
  /** One OpenAPI tag: `auth`, `public`, `admin`, or a resource name (API-11). */
  tag: 'auth' | 'public' | 'articles' | 'tags' | 'admin';
  summary: string;
  description?: string;
  /** A 1.x path kept until 3.0.0; `replacedBy` names the route that replaces it (VER-10). */
  replacedBy?: string;
  params?: TSchema;
  querystring?: TSchema;
  body?: TSchema;
  /** Success responses by status code. */
  response: Record<number, TSchema>;
  /** Largest accepted body in bytes, or `backup` for the effective `backup.maxBytes`. */
  maxBodyBytes?: number | 'backup';
  /** Pass the body to the handler as a Buffer (backup uploads). */
  rawBody?: boolean;
  /** Rate limit applied before authentication and body parsing. */
  rateLimit?: RateLimitName;
}

export const defaultMaxBodyBytes = 1_000_000;
/** The highest `backup.maxBytes` can be set to; the effective value is checked per request. */
export const maxBackupBodyBytes = 1024 * 1024 * 1024;

const moderatorOnly = 'Moderators only.';

// The single list of API routes. Every path is under /api/ (API-1).
const routes: RouteDefinition[] = [
  { method: 'GET', path: '/api/health', auth: 'none', operationId: 'getHealth', tag: 'public', summary: 'Check that the API and its database answer.', response: { 200: S.Health } },

  { method: 'POST', path: '/api/auth/login', auth: 'none', rateLimit: 'login', operationId: 'createMemberSession', tag: 'auth', summary: 'Sign in a member and return a bearer token.', body: S.Credentials, response: { 200: S.MemberLogin } },
  { method: 'GET', path: '/api/auth/session', auth: 'member', operationId: 'getMemberSession', tag: 'auth', summary: 'Return the signed-in member.', response: { 200: S.MemberUser } },
  { method: 'GET', path: '/api/settings', auth: 'none', operationId: 'getPublicSettings', tag: 'public', summary: 'Return the settings the public UI needs.', response: { 200: S.PublicSettings } },

  { method: 'GET', path: '/api/articles', auth: 'none', operationId: 'listPublicArticles', tag: 'articles', summary: 'List public articles, newest pinned first, one page at a time.', querystring: S.ArticleListQuery, response: { 200: S.ArticleList } },
  { method: 'POST', path: '/api/articles', auth: 'member', operationId: 'createArticle', tag: 'articles', summary: 'Create an article.', body: S.ArticleWriteBody, response: { 201: S.Article } },
  { method: 'GET', path: '/api/articles/{id}', auth: 'none', operationId: 'getPublicArticle', tag: 'articles', summary: 'Return a public article.', params: S.IdParams, response: { 200: S.Article } },
  { method: 'PUT', path: '/api/articles/{id}', auth: 'member', operationId: 'updateArticle', tag: 'articles', summary: 'Replace an article\'s title, content, tags and visibility.', description: 'Answers 409 when `version` is not the current version.', params: S.IdParams, body: S.ArticleWriteBody, response: { 200: S.Article } },
  { method: 'DELETE', path: '/api/articles/{id}', auth: 'member', operationId: 'deleteArticle', tag: 'articles', summary: 'Delete an article.', description: `${moderatorOnly} Answers 409 when \`version\` is not the current version.`, params: S.IdParams, querystring: S.VersionQuery, response: { 204: S.NoContent } },
  { method: 'GET', path: '/api/articles/{id}/revisions', auth: 'member', operationId: 'listArticleRevisions', tag: 'articles', summary: 'List the five most recent revisions of an article.', params: S.IdParams, response: { 200: Type.Array(S.Revision) } },
  { method: 'POST', path: '/api/articles/{id}/revisions/{version}/restore', auth: 'member', operationId: 'restoreArticleRevision', tag: 'articles', summary: 'Restore a revision as the new latest version.', description: moderatorOnly, params: S.RevisionParams, body: S.RestoreRevisionBody, response: { 200: S.Article } },
  { method: 'PATCH', path: '/api/articles/{id}/protection', auth: 'member', operationId: 'setArticleProtection', tag: 'articles', summary: 'Protect or unprotect an article.', description: moderatorOnly, params: S.IdParams, body: S.ProtectionBody, response: { 200: S.Article } },
  { method: 'PATCH', path: '/api/articles/{id}/pinning', auth: 'member', operationId: 'setArticlePinning', tag: 'articles', summary: 'Pin or unpin an article.', description: moderatorOnly, params: S.IdParams, body: S.PinningBody, response: { 200: S.Article } },
  { method: 'PATCH', path: '/api/articles/{id}/verification', auth: 'member', operationId: 'setArticleVerification', tag: 'articles', summary: 'Mark an article verified or unverified.', description: moderatorOnly, params: S.IdParams, body: S.VerificationBody, response: { 200: S.Article } },
  { method: 'DELETE', path: '/api/articles/{id}/orphan-tags/{tagId}', auth: 'member', operationId: 'removeOrphanTag', tag: 'articles', summary: 'Remove a tag ID that no longer exists from an article.', description: moderatorOnly, params: S.ArticleTagParams, querystring: S.VersionQuery, response: { 200: S.Article } },

  { method: 'GET', path: '/api/tags', auth: 'none', operationId: 'listPublicTags', tag: 'tags', summary: 'List or search the tag catalog.', querystring: S.TagListQuery, response: { 200: Type.Array(S.Tag) } },
  { method: 'POST', path: '/api/tags', auth: 'member', operationId: 'createTag', tag: 'tags', summary: 'Create a tag.', description: moderatorOnly, body: S.TagWriteBody, response: { 201: S.Tag } },
  { method: 'GET', path: '/api/tags/orphans', auth: 'member', operationId: 'listOrphanTags', tag: 'tags', summary: 'List articles that refer to tags that no longer exist.', description: moderatorOnly, response: { 200: Type.Array(S.TagOrphan) } },
  { method: 'PUT', path: '/api/tags/{tagId}', auth: 'member', operationId: 'updateTag', tag: 'tags', summary: 'Rename or recolour a tag.', description: moderatorOnly, params: S.TagIdParams, body: S.TagWriteBody, response: { 200: S.Tag } },
  { method: 'DELETE', path: '/api/tags/{tagId}', auth: 'member', operationId: 'deleteTag', tag: 'tags', summary: 'Delete a tag.', description: moderatorOnly, params: S.TagIdParams, response: { 204: S.NoContent } },

  { method: 'GET', path: '/api/member/articles', auth: 'member', operationId: 'listMemberArticles', tag: 'articles', summary: 'List the articles the signed-in member may read.', querystring: S.ArticleListQuery, response: { 200: S.ArticleList } },
  { method: 'GET', path: '/api/member/articles/{id}', auth: 'member', operationId: 'getMemberArticle', tag: 'articles', summary: 'Return an article the signed-in member may read.', params: S.IdParams, response: { 200: S.Article } },
  { method: 'GET', path: '/api/member/tags', auth: 'member', operationId: 'listMemberTags', tag: 'tags', summary: 'List or search the tag catalog, also while public browsing is off.', querystring: S.TagListQuery, response: { 200: Type.Array(S.Tag) } },

  // Admin setup and authentication (API-1), served by the app itself.
  { method: 'GET', path: '/api/setup/status', auth: 'none', operationId: 'getSetupStatus', tag: 'auth', summary: 'Report whether first-run setup is needed and possible.', response: { 200: S.SetupStatus } },
  { method: 'POST', path: '/api/setup', auth: 'none', rateLimit: 'setup', operationId: 'completeSetup', tag: 'auth', summary: 'Create the Admin with the setup password and sign in.', body: S.AdminSetupBody, response: { 201: S.AdminSession } },
  { method: 'POST', path: '/api/admin/login', auth: 'none', rateLimit: 'adminLogin', operationId: 'createAdminSession', tag: 'auth', summary: 'Sign in the Admin.', body: S.Credentials, response: { 200: S.AdminSession } },
  { method: 'POST', path: '/api/admin/logout', auth: 'admin', operationId: 'deleteAdminSession', tag: 'auth', summary: 'Sign out the Admin.', response: { 204: S.NoContent } },
  { method: 'GET', path: '/api/admin/session', auth: 'admin', operationId: 'getAdminSession', tag: 'auth', summary: 'Return the signed-in Admin and the app version.', response: { 200: S.AdminSession } },
  { method: 'POST', path: '/api/admin/password', auth: 'admin', rateLimit: 'adminPassword', operationId: 'changeAdminPassword', tag: 'auth', summary: 'Change the Admin password; ends every other session.', body: S.AdminPasswordBody, response: { 200: S.AdminSession } },

  // 1.x paths of the routes above, kept until 3.0.0 (VER-10).
  { method: 'GET', path: '/api/admin/setup/status', auth: 'none', replacedBy: 'GET /api/setup/status', operationId: 'getSetupStatusDeprecated', tag: 'auth', summary: 'Deprecated: use GET /api/setup/status.', response: { 200: S.SetupStatus } },
  { method: 'POST', path: '/api/admin/setup', auth: 'none', rateLimit: 'setup', replacedBy: 'POST /api/setup', operationId: 'completeSetupDeprecated', tag: 'auth', summary: 'Deprecated: use POST /api/setup.', body: S.AdminSetupBody, response: { 201: S.AdminSession } },
  { method: 'POST', path: '/api/admin/auth/login', auth: 'none', rateLimit: 'adminLogin', replacedBy: 'POST /api/admin/login', operationId: 'createAdminSessionDeprecated', tag: 'auth', summary: 'Deprecated: use POST /api/admin/login.', body: S.Credentials, response: { 200: S.AdminSession } },
  { method: 'POST', path: '/api/admin/auth/logout', auth: 'admin', replacedBy: 'POST /api/admin/logout', operationId: 'deleteAdminSessionDeprecated', tag: 'auth', summary: 'Deprecated: use POST /api/admin/logout.', response: { 204: S.NoContent } },
  { method: 'GET', path: '/api/admin/auth/session', auth: 'admin', replacedBy: 'GET /api/admin/session', operationId: 'getAdminSessionDeprecated', tag: 'auth', summary: 'Deprecated: use GET /api/admin/session.', response: { 200: S.AdminSession } },
  { method: 'PUT', path: '/api/admin/auth/password', auth: 'admin', rateLimit: 'adminPassword', replacedBy: 'POST /api/admin/password', operationId: 'changeAdminPasswordDeprecated', tag: 'auth', summary: 'Deprecated: use POST /api/admin/password.', body: S.AdminPasswordBody, response: { 200: S.AdminSession } },

  { method: 'GET', path: '/api/admin/users', auth: 'admin', operationId: 'listUsers', tag: 'admin', summary: 'List member accounts.', querystring: S.UserListQuery, response: { 200: S.LocalUserList } },
  { method: 'POST', path: '/api/admin/users', auth: 'admin', operationId: 'createUser', tag: 'admin', summary: 'Create a member account.', body: S.UserCreateBody, response: { 201: S.LocalUser } },
  { method: 'PUT', path: '/api/admin/users/{userId}', auth: 'admin', operationId: 'updateUser', tag: 'admin', summary: 'Replace a member account; a role change or deactivation signs the member out.', params: S.UserIdParams, body: S.UserUpdateBody, response: { 200: S.LocalUser } },
  { method: 'PUT', path: '/api/admin/users/{userId}/password', auth: 'admin', operationId: 'setUserPassword', tag: 'admin', summary: 'Set a member\'s password and sign them out.', params: S.UserIdParams, body: S.UserPasswordBody, response: { 204: S.NoContent } },
  { method: 'DELETE', path: '/api/admin/users/{userId}', auth: 'admin', operationId: 'deleteUser', tag: 'admin', summary: 'Delete a member account.', params: S.UserIdParams, response: { 204: S.NoContent } },
  { method: 'GET', path: '/api/admin/stats', auth: 'admin', operationId: 'getStats', tag: 'admin', summary: 'Return content statistics.', response: { 200: S.AdminStats } },
  { method: 'GET', path: '/api/admin/articles', auth: 'admin', operationId: 'listAdminArticles', tag: 'admin', summary: 'List every article, at every visibility level.', querystring: S.ArticleListQuery, response: { 200: S.ArticleList } },
  { method: 'GET', path: '/api/admin/settings', auth: 'admin', operationId: 'getSettings', tag: 'admin', summary: 'Return each dashboard setting with its value and source.', response: { 200: S.AdminSettings } },
  { method: 'PUT', path: '/api/admin/settings', auth: 'admin', operationId: 'updateSettings', tag: 'admin', summary: 'Change dashboard settings; keys config.yaml defines are refused.', body: S.SettingsWriteBody, response: { 200: S.AdminSettings } },
  { method: 'GET', path: '/api/admin/backup', auth: 'admin', operationId: 'downloadBackup', tag: 'admin', summary: 'Download a backup ZIP of every table and config.yaml.', response: { 200: S.BackupArchive } },
  { method: 'POST', path: '/api/admin/backup/restore', auth: 'admin', maxBodyBytes: 'backup', rawBody: true, operationId: 'restoreBackup', tag: 'admin', summary: 'Preview or restore an uploaded backup ZIP.', description: 'The body is the ZIP archive itself, at most `backup.maxBytes`.', querystring: S.RestoreActionQuery, body: S.BackupUpload, response: { 200: Type.Union([S.RestoreReport, S.RestorePreview]) } },
];

/** A route-table entry with its derived key, as registered on the Fastify app. */
export interface CompiledRoute extends RouteDefinition {
  /** `METHOD /path`, e.g. `GET /api/articles/{id}`. */
  routeKey: string;
  /** The key the handlers switch on: the route's own key, or for a deprecated path the key of its replacement. */
  handlerKey: string;
  /** Whether the path belongs to the admin API, which uses the Admin cookie. */
  admin: boolean;
  /** Whether the request must carry `x-agt-request: 1` (SEC-5). */
  csrf: boolean;
}

/** Whether a path belongs to the admin API. */
function isAdminPath(pathname: string) {
  return pathname.startsWith('/api/admin/');
}

export const apiRoutes: readonly CompiledRoute[] = routes.map((route) => {
  const admin = isAdminPath(route.path);
  return {
    ...route,
    routeKey: `${route.method} ${route.path}`,
    handlerKey: route.replacedBy ?? `${route.method} ${route.path}`,
    admin,
    csrf: route.method !== 'GET' && (admin || route.path === '/api/setup'),
  };
});

/** Every declared route key, e.g. `GET /api/articles/{id}`. */
export const routeKeys: readonly string[] = apiRoutes.map((route) => route.routeKey);
