import type {
  Article,
  ArticleListParams,
  ArticleListResponse,
  ArticleRevision,
  ArticleWrite,
  ApplicationSettings,
  CanonicalTag,
  OrphanTagReference,
  SessionUser,
  TagWrite,
} from './api.js';
import { apiRequest as request } from './client.js';

/**
 * The member UI's API calls, all through `apiRequest()` (FE-2). The member
 * session is an HttpOnly cookie, never visible to JavaScript. Admin panel
 * requests live in src/admin/api.ts and are not part of this bundle.
 */

/** Builds a query string from the set, non-default values. */
export function queryString(params: Record<string, unknown>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '' && value !== 'all') query.set(key, String(value));
  });
  const text = query.toString();
  return text ? `?${text}` : '';
}

/** Signs a member in; the server sets the HttpOnly member session cookie. */
export function createLocalSession(username: string, password: string) {
  return request<SessionUser>('/member/login', {
    method: 'POST',
    body: { username, password },
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
  const prefix = member ? '/member' : '';
  return request<ArticleListResponse>(`${prefix}/articles${queryString({ ...params })}`, { signal });
}

export function getArticle(id: string, signal?: AbortSignal, member = false) {
  const prefix = member ? '/member' : '';
  return request<Article>(`${prefix}/articles/${encodeURIComponent(id)}`, { signal });
}

export function listTags(search = '', signal?: AbortSignal, member = false) {
  const prefix = member ? '/member' : '';
  return request<CanonicalTag[]>(`${prefix}/tags${queryString({ search: search.trim() })}`, { signal });
}

export function createTag(input: TagWrite) {
  return request<CanonicalTag>('/tags', { method: 'POST', body: input });
}

export function updateTag(id: string, input: TagWrite) {
  return request<CanonicalTag>(
    `/tags/${encodeURIComponent(id)}`,
    { method: 'PUT', body: input },
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

export function createArticle(input: ArticleWrite) {
  return request<Article>('/articles', { method: 'POST', body: input });
}

export function updateArticle(id: string, input: ArticleWrite) {
  return request<Article>(
    `/articles/${encodeURIComponent(id)}`,
    { method: 'PUT', body: input },
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
    { method: 'PATCH', body: { isProtected, version } },
  );
}

export function setArticlePinned(id: string, isPinned: boolean, version: number) {
  return request<Article>(
    `/articles/${encodeURIComponent(id)}/pinning`,
    { method: 'PATCH', body: { isPinned, version } },
  );
}

export function setArticleVerified(id: string, isVerified: boolean, version: number) {
  return request<Article>(
    `/articles/${encodeURIComponent(id)}/verification`,
    { method: 'PATCH', body: { isVerified, version } },
  );
}

export function restoreArticleRevision(id: string, revisionVersion: number, currentVersion: number) {
  return request<Article>(
    `/articles/${encodeURIComponent(id)}/revisions/${revisionVersion}/restore`,
    { method: 'POST', body: { currentVersion } },
  );
}
