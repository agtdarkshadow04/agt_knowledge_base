import { appConfig } from '../config';
import type {
  Article,
  ArticleInput,
  ArticleListParams,
  ArticleListResponse,
  ArticleRevision,
  ApplicationSettings,
  CanonicalTag,
  OrphanTagReference,
  SessionUser,
  TagInput,
} from '../types';

/** Member API client. Admin panel requests live in src/admin/api.ts and are not part of this bundle. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorMessage(payload: unknown, status: number) {
  return payload && typeof payload === 'object' && 'message' in payload
    ? String(payload.message)
    : `Request failed with status ${status}`;
}

/**
 * Sends a request with the member session cookie (FE-3: no token is ever
 * visible to JavaScript) and, on every write, the CSRF header (SEC-5).
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (init.method && init.method !== 'GET') headers.set('x-agt-request', '1');

  const response = await fetch(`${appConfig.apiUrl}${path}`, { ...init, headers, credentials: 'same-origin' });
  const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined);

  if (!response.ok) throw new ApiError(errorMessage(payload, response.status), response.status, payload);

  return payload as T;
}

/** Signs a member in; the server sets the HttpOnly member session cookie. */
export function createLocalSession(username: string, password: string) {
  return request<SessionUser>('/member/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function deleteLocalSession() {
  return request<void>('/member/logout', { method: 'POST' });
}

export function getApplicationSettings(signal?: AbortSignal) {
  return request<ApplicationSettings>('/settings/public', { signal });
}

export function getLocalSession() {
  return request<SessionUser>('/member/session');
}

/** `member` reads through the member routes, which also return restricted articles the member may see. */
export function listArticles(params: ArticleListParams, signal?: AbortSignal, member = false) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '' && value !== 'all') query.set(key, String(value));
  });
  const prefix = member ? '/member' : '';
  return request<ArticleListResponse>(`${prefix}/articles?${query.toString()}`, { signal });
}

export function getArticle(id: string, signal?: AbortSignal, member = false) {
  const prefix = member ? '/member' : '';
  return request<Article>(`${prefix}/articles/${encodeURIComponent(id)}`, { signal });
}

export function listTags(search = '', signal?: AbortSignal, member = false) {
  const query = new URLSearchParams();
  if (search.trim()) query.set('search', search.trim());
  const suffix = query.size ? `?${query.toString()}` : '';
  const prefix = member ? '/member' : '';
  return request<CanonicalTag[]>(`${prefix}/tags${suffix}`, { signal });
}

export function createTag(input: TagInput) {
  return request<CanonicalTag>('/tags', { method: 'POST', body: JSON.stringify(input) });
}

export function updateTag(id: string, input: TagInput) {
  return request<CanonicalTag>(
    `/tags/${encodeURIComponent(id)}`,
    { method: 'PUT', body: JSON.stringify(input) },
  );
}

export function deleteTag(id: string) {
  return request<void>(`/tags/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function listOrphanTagReferences(signal?: AbortSignal) {
  return request<OrphanTagReference[]>('/tags/orphans', { signal });
}

export function removeOrphanTagReference(
  articleId: string,
  tagId: string,
  version: number,
) {
  return request<Article>(
    `/articles/${encodeURIComponent(articleId)}/orphan-tags/${encodeURIComponent(tagId)}?version=${version}`,
    { method: 'DELETE' },
  );
}

export function listArticleRevisions(id: string, signal?: AbortSignal) {
  return request<ArticleRevision[]>(`/articles/${encodeURIComponent(id)}/revisions`, { signal });
}

export function createArticle(input: ArticleInput) {
  return request<Article>('/articles', { method: 'POST', body: JSON.stringify(input) });
}

export function updateArticle(id: string, input: ArticleInput) {
  return request<Article>(
    `/articles/${encodeURIComponent(id)}`,
    { method: 'PUT', body: JSON.stringify(input) },
  );
}

export function deleteArticle(id: string, version: number) {
  return request<void>(
    `/articles/${encodeURIComponent(id)}?version=${version}`,
    { method: 'DELETE' },
  );
}

export function setArticleProtection(id: string, isProtected: boolean, version: number) {
  return request<Article>(
    `/articles/${encodeURIComponent(id)}/protection`,
    { method: 'PATCH', body: JSON.stringify({ isProtected, version }) },
  );
}

export function setArticlePinned(id: string, isPinned: boolean, version: number) {
  return request<Article>(
    `/articles/${encodeURIComponent(id)}/pinning`,
    { method: 'PATCH', body: JSON.stringify({ isPinned, version }) },
  );
}

export function setArticleVerified(id: string, isVerified: boolean, version: number) {
  return request<Article>(
    `/articles/${encodeURIComponent(id)}/verification`,
    { method: 'PATCH', body: JSON.stringify({ isVerified, version }) },
  );
}

export function restoreArticleRevision(id: string, revisionVersion: number, currentVersion: number) {
  return request<Article>(
    `/articles/${encodeURIComponent(id)}/revisions/${revisionVersion}/restore`,
    { method: 'POST', body: JSON.stringify({ currentVersion }) },
  );
}
