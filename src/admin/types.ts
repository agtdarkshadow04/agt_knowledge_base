import type { ArticleVisibility, Role } from '../lib/api';

export interface AdminSession {
  username: string;
  /** AGT_KNOWLEDGE_BASE_SETUP_PASSWORD is still set on the server and should be removed (AUTH-6). */
  setupPasswordStillSet: boolean;
  /** The app version, shown in the dashboard header (VER-2). */
  version: string;
}

export interface SetupStatus {
  adminExists: boolean;
  setupPasswordConfigured: boolean;
}

export interface LocalUser {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LocalUserListResponse {
  items: LocalUser[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AdminStats {
  totalArticles: number;
  publicArticles: number;
  internalArticles: number;
  adminArticles: number;
  pinnedArticles: number;
  protectedArticles: number;
  verifiedArticles: number;
  articleRevisions: number;
  canonicalTags: number;
  orphanedTagReferences: number;
}

/** The effective value of each dashboard setting, by dotted key (CFG-6). */
export interface DashboardSettings {
  'site.title': string;
  'site.subtitle': string;
  'site.supportUrl': string;
  'articles.defaultVisibility': ArticleVisibility;
  'access.allowPublicBrowsing': boolean;
  'backup.maxZipBytes': number;
  'backup.maxUncompressedBytes': number;
  'backup.maxEntries': number;
  'logs.serverRetentionDays': number;
  'logs.serverMaxEntries': number;
  'logs.auditRetentionDays': number;
  'logs.auditMaxEntries': number;
}

export type SettingKey = keyof DashboardSettings;
export type SettingSource = 'config' | 'dashboard' | 'default';

/** One setting as `GET /api/admin/settings` reports it (CFG-7). */
export interface SettingState<Key extends SettingKey = SettingKey> {
  key: Key;
  value: DashboardSettings[Key];
  source: SettingSource;
  locked: boolean;
  default: DashboardSettings[Key];
  description: string;
}

export interface AdminSettingsView {
  states: SettingState[];
}

/** `PUT /api/admin/settings`: `null` resets a key to its default (CFG-8). */
export interface SettingsWrite {
  values: { [Key in SettingKey]?: DashboardSettings[Key] | null };
}

export interface DiffLine {
  kind: ' ' | '-' | '+';
  text: string;
}

export interface RestorePreview {
  createdAt: string;
  appVersion: string;
  formatVersion: number;
  /** The backup's schema version and this installation's; an older one is migrated by the restore. */
  schemaVersion: { backup: number; current: number };
  /** Deprecated: migration ids; use `schemaVersion`. */
  migrations: { backup: string[]; upgrade: string[] };
  counts: Record<string, number>;
  config: { included: boolean; content: string | null; diff: DiffLine[] | null; identical: boolean };
  ignoredSettings: string[];
  warnings: string[];
  warningCodes: ('log_tables_ignored' | 'no_admin')[];
}

export interface RestoreReport extends RestorePreview {
  /** Null for a recovery restore after a failed one. */
  preRestoreBackup: string | null;
}

/** A server log entry (LOG-7). */
export interface ServerLogEntry {
  id: string;
  at: string;
  level: 'info' | 'warn' | 'error' | 'fatal';
  source: string;
  message: string;
  requestId: string | null;
  details: Record<string, unknown>;
}

/** An audit log entry (LOG-10); `member` actors are the AUTH-1 deviation. */
export interface AuditLogEntry {
  id: string;
  at: string;
  lastAt: string;
  count: number;
  actorType: 'admin' | 'member' | 'anonymous';
  actor: string | null;
  ipHash: string | null;
  client: 'web' | 'api';
  action: string;
  method: string;
  route: string;
  targetType: string | null;
  targetId: string | null;
  outcome: 'success' | 'denied' | 'rate_limited' | 'failure';
  statusCode: number;
  requestId: string | null;
  details: Record<string, unknown>;
}

export interface LogPage<Entry> {
  items: Entry[];
  nextCursor: string | null;
}

export interface ServerLogSummary {
  unseenWarnings: number;
  unseenErrors: number;
}

/** Filters of either log; empty strings are left out of the request. */
export type LogFilters = Record<string, string>;
