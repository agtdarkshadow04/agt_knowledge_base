export type UserRole = 'Admin' | 'Standard';

export interface SessionUser {
  sub: string;
  username: string;
  displayName: string;
  email?: string;
  role: UserRole;
}

export interface ArticleSummary {
  id: string;
  title: string;
  excerpt: string;
  tags: string[];
  isProtected: boolean;
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
  tags: string[];
  isProtected: boolean;
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
  tag?: string;
  protection?: 'all' | 'protected' | 'unprotected';
  sort?: ArticleSort;
  direction?: SortDirection;
  page?: number;
  pageSize?: number;
}

export interface ArticleInput {
  title: string;
  content: string;
  tags: string[];
  version?: number;
}
