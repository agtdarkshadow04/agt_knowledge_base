import { appConfig } from '../config';
import type { Article, ArticleInput, ArticleListParams, ArticleListResponse, ArticleRevision } from '../types';

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

export function listArticles(params: ArticleListParams, signal?: AbortSignal) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '' && value !== 'all') query.set(key, String(value));
  });
  return request<ArticleListResponse>(`/articles?${query.toString()}`, { signal });
}

export function getArticle(id: string, signal?: AbortSignal) {
  return request<Article>(`/articles/${encodeURIComponent(id)}`, { signal });
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

export function restoreArticleRevision(id: string, revisionVersion: number, currentVersion: number, token: string) {
  return request<Article>(
    `/articles/${encodeURIComponent(id)}/revisions/${revisionVersion}/restore`,
    { method: 'POST', body: JSON.stringify({ currentVersion }) },
    token,
  );
}
