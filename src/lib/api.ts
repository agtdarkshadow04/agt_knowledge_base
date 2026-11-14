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
  page: number;
  pageSize: number;
}

export interface ArticleWrite {
  title: string;
  content: string;
  tagIds: string[];
  visibility?: ArticleVisibility;
  version?: number;
}
