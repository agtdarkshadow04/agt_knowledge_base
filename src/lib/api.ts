/**
 * API types shared by the server and the browser (REPO-3). The server's
 * `domain.ts` re-exports them; keep request shapes here, next to `validation.ts`.
 */

/** Member roles. The installation Admin is not a member and has no role. */
export const roles = ['Editor', 'Moderator'] as const;
export type Role = typeof roles[number];

export type LegacyArticleVisibility = 'Public' | 'Internal' | 'Admin';
export type AgtArticleVisibility = 0 | 1 | 2 | 3 | 4 | 5;
export type ArticleVisibility = LegacyArticleVisibility | AgtArticleVisibility;
export type ArticleVisibilityFilter = 'all' | 'public' | 'internal' | 'admin' | `${AgtArticleVisibility}`;

export interface TagWrite {
  name: string;
  color: string;
}

export interface ListArticlesQuery {
  search: string;
  tagId: string;
  visibility: ArticleVisibilityFilter;
  pinned: 'all' | 'pinned';
  protection: 'all' | 'protected' | 'unprotected';
  verification: 'all' | 'verified' | 'unverified';
  sort: 'createdAt' | 'modifiedAt' | 'title';
  direction: 'asc' | 'desc';
  /** Items per page: 1–200, default 50 (API-8). */
  limit: number;
  /** The opaque `nextCursor` of the previous page, or '' for the first page. */
  cursor: string;
  /** Deprecated 1.x offset paging (removed in 3.0.0): when set, `limit` is the page size. */
  page?: number;
}

export interface ArticleWrite {
  title: string;
  content: string;
  tagIds: string[];
  visibility?: ArticleVisibility;
  version?: number;
}

/** Whether a value is a UUIDv4, the only ID format the app generates and accepts (DATA-6). */
export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// --- Response types the browser reads -------------------------------------------

export interface SessionUser {
  sub: string;
  username: string;
  displayName: string;
  email?: string;
  role: Role;
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
