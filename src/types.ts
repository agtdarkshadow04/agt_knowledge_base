/** Member roles. The installation Admin is a separate account that signs in at /admin. */
export type UserRole = 'Editor' | 'Moderator';
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
}

/** The settings the public UI needs, from `GET /api/settings/public`, grouped as in config.yaml. */
export interface ApplicationSettings {
  site: { title: string; subtitle: string; supportUrl: string };
  articles: { defaultVisibility: ArticleVisibility };
  access: { allowPublicBrowsing: boolean };
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
  /** Pass as `cursor` for the next page; null on the last page (API-8). */
  nextCursor: string | null;
  total: number;
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
  /** Articles per page, 1–200. */
  limit?: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
}

export interface ArticleInput {
  title: string;
  content: string;
  tagIds: string[];
  visibility?: ArticleVisibility;
  version?: number;
}
