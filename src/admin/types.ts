import type { ArticleVisibility, UserRole } from '../types';

export interface AdminSession {
  username: string;
  /** AGT_KNOWLEDGE_BASE_SETUP_PASSWORD is still set on the server and should be removed. */
  setupPasswordSet: boolean;
  /** The app version, shown in the dashboard header (VER-2). */
  version: string;
}

export interface SetupStatus {
  required: boolean;
  setupPasswordConfigured: boolean;
}

export interface LocalUser {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  role: UserRole;
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
  migrations: { backup: string[]; upgrade: string[] };
  counts: Record<string, number>;
  config: { included: boolean; content: string | null; diff: DiffLine[] | null; identical: boolean };
  ignoredSettings: string[];
}

export interface RestoreReport extends RestorePreview {
  preRestoreBackup: string;
}
