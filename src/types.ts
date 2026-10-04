export type UserRole = 'Admin' | 'Standard';
export type ArticleVisibility = 'Public' | 'Internal' | 'Admin';

export interface SessionUser {
  sub: string;
  username: string;
  displayName: string;
  email?: string;
  role: UserRole;
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
  visibility?: 'all' | 'public' | 'internal' | 'admin';
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
