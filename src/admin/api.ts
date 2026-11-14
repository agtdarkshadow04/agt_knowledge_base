import { ApiError, errorMessage } from '../services/api';
import type { ArticleListParams, ArticleListResponse, UserRole } from '../types';
import type {
  AdminSession,
  AdminSettingsView,
  AdminStats,
  LocalUser,
  LocalUserListResponse,
  RestorePreview,
  RestoreReport,
  SettingsWrite,
  SetupStatus,
} from './types';

/**
 * Admin panel API client. Requests are always same-origin: the session is an
 * HttpOnly cookie scoped to /api/admin, and every non-GET request carries the
 * CSRF header the server requires. No member token is ever sent.
 */
export const adminApiBase = '/api/admin';
export const adminUnauthorizedEvent = 'agt-admin-unauthorized';

/** Paths whose 401 means "wrong credentials", not "the session ended". */
const credentialPaths = ['/login', '/password', '/api/setup'];

async function adminFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') headers.set('x-agt-request', '1');
  // Paths are relative to /api/admin, except the first-run setup routes under /api/setup (API-1).
  const url = path.startsWith('/api/') ? path : `${adminApiBase}${path}`;
  const response = await fetch(url, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    if (response.status === 401 && !credentialPaths.includes(path)) {
      window.dispatchEvent(new Event(adminUnauthorizedEvent));
    }
    throw new ApiError(errorMessage(payload, response.status), response.status, payload);
  }
  return response;
}

async function adminRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await adminFetch(path, init);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

function query(params: Record<string, unknown>) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '' && value !== 'all') search.set(key, String(value));
  });
  return search.toString();
}

export function getSetupStatus() {
  return adminRequest<SetupStatus>('/api/setup/status');
}

export function completeSetup(input: { setupPassword: string; username: string; password: string; passwordConfirmation: string }) {
  return adminRequest<AdminSession>('/api/setup', { method: 'POST', body: JSON.stringify(input) });
}

export function signIn(username: string, password: string) {
  return adminRequest<AdminSession>('/login', { method: 'POST', body: JSON.stringify({ username, password }) });
}

export function signOut() {
  return adminRequest<void>('/logout', { method: 'POST' });
}

/** The current Admin session, or null when signed out. */
export async function getSession() {
  try {
    return await adminRequest<AdminSession>('/session');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function changePassword(input: { currentPassword: string; password: string; passwordConfirmation: string }) {
  return adminRequest<AdminSession>('/password', { method: 'POST', body: JSON.stringify(input) });
}

export function listUsers(params: {
  search?: string;
  role?: 'all' | UserRole;
  active?: 'all' | 'active' | 'inactive';
  page?: number;
  pageSize?: number;
}, signal?: AbortSignal) {
  return adminRequest<LocalUserListResponse>(`/users?${query(params)}`, { signal });
}

export function createUser(input: { username: string; displayName: string; email?: string; role: UserRole; password: string }) {
  return adminRequest<LocalUser>('/users', { method: 'POST', body: JSON.stringify(input) });
}

export function updateUser(id: string, input: { username: string; displayName: string; email?: string; role: UserRole; isActive: boolean }) {
  return adminRequest<LocalUser>(`/users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) });
}

export function setUserPassword(id: string, password: string) {
  return adminRequest<void>(`/users/${encodeURIComponent(id)}/password`, { method: 'PUT', body: JSON.stringify({ password }) });
}

export function deleteUser(id: string) {
  return adminRequest<void>(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function getStats(signal?: AbortSignal) {
  return adminRequest<AdminStats>('/stats', { signal });
}

export function listArticles(params: ArticleListParams, signal?: AbortSignal) {
  return adminRequest<ArticleListResponse>(`/articles?${query({ ...params })}`, { signal });
}

export function getSettings(signal?: AbortSignal) {
  return adminRequest<AdminSettingsView>('/settings', { signal });
}

export function updateSettings(input: SettingsWrite) {
  return adminRequest<AdminSettingsView>('/settings', { method: 'PUT', body: JSON.stringify(input) });
}

/** Downloads a full backup archive. */
export async function downloadBackup() {
  const response = await adminFetch('/backup', { headers: { Accept: 'application/zip' } });
  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'agt-kb-backup.zip';
  return { blob: await response.blob(), filename };
}

function uploadBackup<T>(file: Blob, action: 'preview' | 'restore') {
  return adminRequest<T>(`/backup/restore?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: file,
  });
}

/** Validates a backup and reports what restoring it would do. Nothing changes. */
export function previewBackup(file: Blob) {
  return uploadBackup<RestorePreview>(file, 'preview');
}

/** Replaces all data with the backup, after saving a pre-restore backup, and signs everyone out. */
export function restoreBackup(file: Blob) {
  return uploadBackup<RestoreReport>(file, 'restore');
}
