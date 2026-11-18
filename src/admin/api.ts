import type { ArticleListParams, ArticleListResponse, Role, SecurityLevel } from '../lib/api';
import { ApiError, apiFetch, apiRequest, attachmentName, type RequestOptions } from '../lib/client';
import { queryString } from '../lib/memberApi';
import type {
  AuditLogEntry,
  LogFilters,
  LogPage,
  ServerLogEntry,
  ServerLogSummary,
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
 * Admin panel API calls, all through `apiRequest()` (FE-2). The session is an
 * HttpOnly cookie scoped to /api/admin; no member session is ever used here.
 */
export const adminApiBase = '/api/admin';
export const adminUnauthorizedEvent = 'agt_knowledge_base_admin_unauthorized';

/** Paths whose 401 means "wrong credentials", not "the session ended". */
const credentialPaths = ['/login', '/password', '/api/setup'];

/** Paths are relative to /api/admin, except the first-run setup routes under /api/setup (API-1). */
function adminUrl(path: string) {
  return path.startsWith('/api/') ? path : `${adminApiBase}${path}`;
}

function signalSessionEnd(path: string, error: unknown): never {
  if (error instanceof ApiError && error.status === 401 && !credentialPaths.includes(path)) {
    window.dispatchEvent(new Event(adminUnauthorizedEvent));
  }
  throw error;
}

async function adminFetch(path: string, options: RequestOptions = {}) {
  try {
    return await apiFetch(adminUrl(path), options);
  } catch (error) {
    signalSessionEnd(path, error);
  }
}

async function adminRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await apiRequest<T>(adminUrl(path), options);
  } catch (error) {
    signalSessionEnd(path, error);
  }
}

const query = (params: Record<string, unknown>) => queryString(params).slice(1);

export function getSetupStatus() {
  return adminRequest<SetupStatus>('/api/setup/status');
}

export function completeSetup(input: { setupPassword: string; username: string; password: string; passwordConfirmation: string }) {
  return adminRequest<AdminSession>('/api/setup', { method: 'POST', body: input });
}

export function signIn(username: string, password: string) {
  return adminRequest<AdminSession>('/login', { method: 'POST', body: { username, password } });
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
  return adminRequest<AdminSession>('/password', { method: 'POST', body: input });
}

export function listUsers(params: {
  search?: string;
  role?: 'all' | Role;
  active?: 'all' | 'active' | 'inactive';
  page?: number;
  pageSize?: number;
}, signal?: AbortSignal) {
  return adminRequest<LocalUserListResponse>(`/users?${query(params)}`, { signal });
}

export function createUser(input: { username: string; displayName: string; email?: string; role: Role; securityLevel?: SecurityLevel; password: string }) {
  return adminRequest<LocalUser>('/users', { method: 'POST', body: input });
}

export function updateUser(id: string, input: { username: string; displayName: string; email?: string; role: Role; securityLevel?: SecurityLevel; isActive: boolean }) {
  return adminRequest<LocalUser>(`/users/${encodeURIComponent(id)}`, { method: 'PUT', body: input });
}

export function setUserPassword(id: string, password: string) {
  return adminRequest<void>(`/users/${encodeURIComponent(id)}/password`, { method: 'PUT', body: { password } });
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
  return adminRequest<AdminSettingsView>('/settings', { method: 'PUT', body: input });
}

/** Downloads a full backup archive. */
export async function downloadBackup() {
  const response = await adminFetch('/backup', { accept: 'application/zip' });
  return { blob: await response.blob(), filename: attachmentName(response, 'agt-knowledge-base-backup.zip') };
}

/** BAK-1: `POST /api/admin/restore` with the `backup` file and the action as multipart/form-data. */
function uploadBackup<T>(file: Blob, action: 'preview' | 'restore') {
  const form = new FormData();
  form.append('action', action);
  form.append('backup', file, file instanceof File ? file.name : 'backup.zip');
  return adminRequest<T>('/restore', { method: 'POST', body: form });
}

/** Validates a backup and reports what restoring it would do. Nothing changes. */
export function previewBackup(file: Blob) {
  return uploadBackup<RestorePreview>(file, 'preview');
}

/** Replaces all data with the backup, after saving a pre-restore backup, and signs everyone out. */
export function restoreBackup(file: Blob) {
  return uploadBackup<RestoreReport>(file, 'restore');
}

// --- Logs (LOG-18) ---------------------------------------------------------------

export type LogKind = 'server' | 'audit';

function logQuery(filters: LogFilters, extra: Record<string, string> = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function listServerLog(filters: LogFilters, cursor = '') {
  return adminRequest<LogPage<ServerLogEntry>>(`/logs/server${logQuery(filters, { cursor })}`);
}

export function listAuditLog(filters: LogFilters, cursor = '') {
  return adminRequest<LogPage<AuditLogEntry>>(`/logs/audit${logQuery(filters, { cursor })}`);
}

export function getServerLogSummary() {
  return adminRequest<ServerLogSummary>('/logs/server/summary');
}

export function markServerLogSeen() {
  return adminRequest<void>('/logs/server/seen', { method: 'POST' });
}

/** LOG-20: clears the server log. There is no way to clear the audit log. */
export function clearServerLog() {
  return adminRequest<void>('/logs/server', { method: 'DELETE' });
}

/** Downloads the entries matching `filters` as JSON Lines or CSV (LOG-22). */
export async function exportLog(log: LogKind, filters: LogFilters, format: 'jsonl' | 'csv') {
  const response = await adminFetch(`/logs/${log}/export${logQuery(filters, { format })}`);
  return { blob: await response.blob(), filename: attachmentName(response, `agt-knowledge-base-${log}-log.${format}`) };
}
