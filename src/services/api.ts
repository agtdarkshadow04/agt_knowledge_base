import { appConfig } from '../config';
import type {
  Article,
  ArticleInput,
  ArticleListParams,
  ArticleListResponse,
  ArticleRevision,
  AdminStats,
  ApplicationSettings,
  CanonicalTag,
  OrphanTagReference,
  LocalUser,
  LocalUserListResponse,
  SessionUser,
  TagInput,
} from '../types';

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

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`${appConfig.apiUrl}${path}`, { ...init, headers });
  const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined);

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? String(payload.message)
        : `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status, payload);
  }

  return payload as T;
}

export function createLocalSession(username: string, password: string) {
  return request<{ token: string; user: SessionUser }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function getSetupStatus() {
  return request<{ required: boolean }>('/setup/status');
}

export function createInitialAdmin(input: {
  username: string;
  displayName: string;
  email?: string;
  password: string;
  passwordConfirmation: string;
}) {
  return request<{ token: string; user: SessionUser }>('/setup', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getApplicationSettings(signal?: AbortSignal) {
  return request<ApplicationSettings>('/settings', { signal });
}

export function getLocalSession(token: string) {
  return request<SessionUser>('/auth/session', {}, token);
}

export function listArticles(params: ArticleListParams, signal?: AbortSignal, token?: string) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '' && value !== 'all') query.set(key, String(value));
  });
  const prefix = token ? '/member' : '';
  return request<ArticleListResponse>(`${prefix}/articles?${query.toString()}`, { signal }, token);
}

export function getArticle(id: string, signal?: AbortSignal, token?: string) {
  const prefix = token ? '/member' : '';
  return request<Article>(`${prefix}/articles/${encodeURIComponent(id)}`, { signal }, token);
}

export function listTags(search = '', signal?: AbortSignal, token?: string) {
  const query = new URLSearchParams();
  if (search.trim()) query.set('search', search.trim());
  const suffix = query.size ? `?${query.toString()}` : '';
  const prefix = token && appConfig.authMode === 'local' ? '/member' : '';
  return request<CanonicalTag[]>(`${prefix}/tags${suffix}`, { signal }, token);
}

export function listLocalUsers(params: {
  search?: string;
  role?: 'all' | 'Admin' | 'Standard';
  active?: 'all' | 'active' | 'inactive';
  page?: number;
  pageSize?: number;
}, token: string, signal?: AbortSignal) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '' && value !== 'all') query.set(key, String(value));
  });
  return request<LocalUserListResponse>(`/admin/users?${query.toString()}`, { signal }, token);
}

export function createLocalUser(input: {
  username: string;
  displayName: string;
  email?: string;
  role: 'Admin' | 'Standard';
  password: string;
}, token: string) {
  return request<LocalUser>('/admin/users', { method: 'POST', body: JSON.stringify(input) }, token);
}

export function updateLocalUser(id: string, input: {
  username: string;
  displayName: string;
  email?: string;
  role: 'Admin' | 'Standard';
  isActive: boolean;
}, token: string) {
  return request<LocalUser>(`/admin/users/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  }, token);
}

export function setLocalUserPassword(id: string, password: string, token: string) {
  return request<void>(`/admin/users/${encodeURIComponent(id)}/password`, {
    method: 'PUT',
    body: JSON.stringify({ password }),
  }, token);
}

export function deleteLocalUser(id: string, token: string) {
  return request<void>(`/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }, token);
}

export function getAdminStats(token: string, signal?: AbortSignal) {
  return request<AdminStats>('/admin/stats', { signal }, token);
}

export function listAdminArticles(params: ArticleListParams, token: string, signal?: AbortSignal) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '' && value !== 'all') query.set(key, String(value));
  });
  return request<ArticleListResponse>(`/admin/articles?${query.toString()}`, { signal }, token);
}

export function updateApplicationSettings(input: ApplicationSettings, token: string) {
  return request<ApplicationSettings>('/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(input),
  }, token);
}

export function createTag(input: TagInput, token: string) {
  return request<CanonicalTag>('/tags', { method: 'POST', body: JSON.stringify(input) }, token);
}

export function updateTag(id: string, input: TagInput, token: string) {
  return request<CanonicalTag>(
    `/tags/${encodeURIComponent(id)}`,
    { method: 'PUT', body: JSON.stringify(input) },
    token,
  );
}

export function deleteTag(id: string, token: string) {
  return request<void>(`/tags/${encodeURIComponent(id)}`, { method: 'DELETE' }, token);
}

export function listOrphanTagReferences(token: string, signal?: AbortSignal) {
  return request<OrphanTagReference[]>('/tags/orphans', { signal }, token);
}

export function removeOrphanTagReference(
  articleId: string,
  tagId: string,
  version: number,
  token: string,
) {
  return request<Article>(
    `/articles/${encodeURIComponent(articleId)}/orphan-tags/${encodeURIComponent(tagId)}?version=${version}`,
    { method: 'DELETE' },
    token,
  );
}

export function listArticleRevisions(id: string, token: string, signal?: AbortSignal) {
  return request<ArticleRevision[]>(`/articles/${encodeURIComponent(id)}/revisions`, { signal }, token);
}

export function createArticle(input: ArticleInput, token: string) {
  return request<Article>('/articles', { method: 'POST', body: JSON.stringify(input) }, token);
}

export function updateArticle(id: string, input: ArticleInput, token: string) {
  return request<Article>(
    `/articles/${encodeURIComponent(id)}`,
    { method: 'PUT', body: JSON.stringify(input) },
    token,
  );
}

export function deleteArticle(id: string, version: number, token: string) {
  return request<void>(
    `/articles/${encodeURIComponent(id)}?version=${version}`,
    { method: 'DELETE' },
    token,
  );
}

export function setArticleProtection(id: string, isProtected: boolean, version: number, token: string) {
  return request<Article>(
    `/articles/${encodeURIComponent(id)}/protection`,
    { method: 'PATCH', body: JSON.stringify({ isProtected, version }) },
    token,
  );
}

export function setArticlePinned(id: string, isPinned: boolean, version: number, token: string) {
  return request<Article>(
    `/articles/${encodeURIComponent(id)}/pinning`,
    { method: 'PATCH', body: JSON.stringify({ isPinned, version }) },
    token,
  );
}

export function setArticleVerified(id: string, isVerified: boolean, version: number, token: string) {
  return request<Article>(
    `/articles/${encodeURIComponent(id)}/verification`,
    { method: 'PATCH', body: JSON.stringify({ isVerified, version }) },
    token,
  );
}

export function restoreArticleRevision(id: string, revisionVersion: number, currentVersion: number, token: string) {
  return request<Article>(
    `/articles/${encodeURIComponent(id)}/revisions/${revisionVersion}/restore`,
    { method: 'POST', body: JSON.stringify({ currentVersion }) },
    token,
  );
}
