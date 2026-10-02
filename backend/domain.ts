export type Role = 'Admin' | 'Standard';
export type ArticleVisibility = 'Public' | 'Internal' | 'Admin';

export interface Actor {
  sub: string;
  displayName: string;
  email?: string;
  role: Role;
}

export interface ArticleRecord {
  id: string;
  title: string;
  content: string;
  tags: string[];
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

export interface ArticleSummaryRecord extends Omit<ArticleRecord, 'content'> {
  excerpt: string;
}

export interface ArticleRevisionRecord {
  articleId: string;
  title: string;
  content: string;
  tags: string[];
  visibility: ArticleVisibility;
  isPinned: boolean;
  isProtected: boolean;
  isVerified: boolean;
  revisedAt: string;
  revisedBy: string;
  revisedByName: string;
  version: number;
}

export interface ListArticlesQuery {
  search: string;
  tag: string;
  visibility: 'all' | 'public' | 'internal' | 'admin';
  pinned: 'all' | 'pinned';
  protection: 'all' | 'protected' | 'unprotected';
  sort: 'createdAt' | 'modifiedAt' | 'title';
  direction: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export interface ArticleListResult {
  items: ArticleSummaryRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ArticleWrite {
  title: string;
  content: string;
  tags: string[];
  visibility?: ArticleVisibility;
  version?: number;
}

export class AppError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Article not found.') { super(message, 404, 'NOT_FOUND'); }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action.') { super(message, 403, 'FORBIDDEN'); }
}

export class ConflictError extends AppError {
  constructor(message = 'The article has changed. Reload the latest version before saving.') { super(message, 409, 'VERSION_CONFLICT'); }
}
