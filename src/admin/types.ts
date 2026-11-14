import type { ArticleVisibility, UserRole } from '../types';

export interface AdminSession {
  username: string;
  /** AGT_SETUP_PASSWORD is still set on the server and should be removed. */
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

export interface DashboardSettings {
  applicationName: string;
  applicationSubtitle: string;
  defaultVisibility: ArticleVisibility;
  allowPublicBrowsing: boolean;
  backupMaxBytes: number;
  backupMaxEntries: number;
  backupMaxUncompressedBytes: number;
}

export type SettingName = keyof DashboardSettings;
export type SettingSource = 'file' | 'dashboard' | 'default';

export interface AdminSettingsView {
  version: number;
  settings: { [Name in SettingName]: { key: string; value: DashboardSettings[Name]; source: SettingSource } };
}

export type SettingsWrite = { [Name in SettingName]?: DashboardSettings[Name] | null } & { version: number };

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
