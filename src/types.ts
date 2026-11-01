export type UserRole = 'Admin' | 'Standard';
export type LegacyArticleVisibility = 'Public' | 'Internal' | 'Admin';
export type AgtArticleVisibility = 0 | 1 | 2 | 3 | 4 | 5;
export type ArticleVisibility = LegacyArticleVisibility | AgtArticleVisibility;
export type ArticleVisibilityFilter = 'all' | 'public' | 'internal' | 'admin' | `${AgtArticleVisibility}`;

export interface SessionUser {
  sub: string;
  username: string;
  displayName: string;
  email?: string;
  role: UserRole;
  isSuperAdmin?: boolean;
}

export interface LocalUser {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  role: UserRole;
  isActive: boolean;
  isSuperAdmin: boolean;
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

export interface ApplicationSettings {
  applicationName: string;
  applicationSubtitle: string;
  defaultVisibility: ArticleVisibility;
  allowPublicBrowsing: boolean;
  version: number;
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

export interface CanonicalTag {
  id: string;
  name: string;
  color: string;
}

export interface TagInput {
  name: string;
  color: string;
}

export interface OrphanTagReference {
  articleId: string;
  articleTitle: string;
  version: number;
  missingTagIds: string[];
}

export interface ArticleSummary {
  id: string;
  title: string;
  excerpt: string;
  tags: CanonicalTag[];
  visibility: ArticleVisibility;
  isPinned: boolean;
  isProtected: boolean;
  isVerified: boolean;
  createdAt: string;
  createdBy: string;
  createdByName: string;
  modifiedAt: string;
  modifiedBy: string;
  modifiedByName: string;
  version: number;
}

export interface Article extends ArticleSummary {
  content: string;
}

export interface ArticleRevision {
  articleId: string;
  title: string;
  content: string;
  tags: CanonicalTag[];
  visibility: ArticleVisibility;
  isPinned: boolean;
  isProtected: boolean;
  isVerified: boolean;
  revisedAt: string;
  revisedBy: string;
  revisedByName: string;
  version: number;
}

export type ArticleSort = 'createdAt' | 'modifiedAt' | 'title';
export type SortDirection = 'asc' | 'desc';

export interface ArticleListResponse {
  items: ArticleSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ArticleListParams {
  search?: string;
  tagId?: string;
  visibility?: ArticleVisibilityFilter;
  pinned?: 'all' | 'pinned';
  protection?: 'all' | 'protected' | 'unprotected';
  verification?: 'all' | 'verified' | 'unverified';
  sort?: ArticleSort;
  direction?: SortDirection;
  page?: number;
  pageSize?: number;
}

export interface ArticleInput {
  title: string;
  content: string;
  tagIds: string[];
  visibility?: ArticleVisibility;
  version?: number;
}

export type BackupTable =
  | 'app_users'
  | 'local_users'
  | 'tags'
  | 'articles'
  | 'article_revisions'
  | 'application_settings';

export interface BackupRestoreResult {
  restored: Record<BackupTable, number>;
}
