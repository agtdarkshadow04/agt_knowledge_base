/** Member roles. The installation Admin is not a member and has no role. */
export const roles = ['Editor', 'Moderator'] as const;
export type Role = typeof roles[number];
/**
 * Who is reading articles: a member role, an anonymous visitor (null), or the
 * internal system viewer the admin panel uses for inventory and statistics.
 */
export type Viewer = Role | 'System' | null;
export type LegacyArticleVisibility = 'Public' | 'Internal' | 'Admin';
export type AgtArticleVisibility = 0 | 1 | 2 | 3 | 4 | 5;
export type ArticleVisibility = LegacyArticleVisibility | AgtArticleVisibility;
export type ArticleVisibilityFilter = 'all' | 'public' | 'internal' | 'admin' | `${AgtArticleVisibility}`;

/**
 * Moderators (and the system viewer) see every level, including legacy
 * `Admin`, which now means Moderator-only. Editors also see Internal and 1.
 */
export function canViewArticleVisibility(viewer: Viewer, visibility: ArticleVisibility) {
  return viewer === 'Moderator'
    || viewer === 'System'
    || visibility === 'Public'
    || visibility === 0
    || (viewer === 'Editor' && (visibility === 'Internal' || visibility === 1));
}

export function canAssignArticleVisibility(role: Role, visibility: ArticleVisibility) {
  return canViewArticleVisibility(role, visibility);
}

export function articleVisibilityFromFilter(filter: ArticleVisibilityFilter): ArticleVisibility | null {
  if (filter === 'all') return null;
  if (filter === 'public') return 'Public';
  if (filter === 'internal') return 'Internal';
  if (filter === 'admin') return 'Admin';
  return Number(filter) as AgtArticleVisibility;
}

export interface LocalUserRecord {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The effective settings every visitor receives from `GET /settings`. */
export interface ApplicationSettings {
  applicationName: string;
  applicationSubtitle: string;
  defaultVisibility: ArticleVisibility;
  allowPublicBrowsing: boolean;
  version: number;
}

export interface BackupLimits {
  backupMaxBytes: number;
  backupMaxEntries: number;
  backupMaxUncompressedBytes: number;
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

export interface Actor {
  sub: string;
  displayName: string;
  email?: string;
  role: Role;
}

export interface CanonicalTag {
  id: string;
  name: string;
  color: string;
}

export interface TagWrite {
  name: string;
  color: string;
}

export interface TagOrphan {
  articleId: string;
  articleTitle: string;
  version: number;
  missingTagIds: string[];
}

export interface ArticleRecord {
  id: string;
  title: string;
  content: string;
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

export interface ArticleSummaryRecord extends Omit<ArticleRecord, 'content'> {
  excerpt: string;
}

export interface ArticleRevisionRecord {
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
  tagIds: string[];
  visibility?: ArticleVisibility;
  version?: number;
}

export type OrphanCleanupResult =
  | { status: 'updated'; article: ArticleRecord }
  | { status: 'not-found' }
  | { status: 'conflict' }
  | { status: 'not-orphan' };

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

export class NoChangesError extends AppError {
  constructor() { super('No changes were made to the article.', 400, 'NO_CHANGES'); }
}

export class InvalidTagIdsError extends AppError {
  constructor() { super('One or more selected tags do not exist. Refresh the tag list and try again.', 400, 'INVALID_TAG_IDS'); }
}

export class TagNameConflictError extends AppError {
  constructor() { super('A tag with that name already exists.', 409, 'TAG_NAME_CONFLICT'); }
}

export class TagNotFoundError extends AppError {
  constructor() { super('Tag not found.', 404, 'TAG_NOT_FOUND'); }
}

export class NotOrphanedTagError extends AppError {
  constructor() { super('The selected tag ID is not an unresolved reference on this article.', 400, 'TAG_NOT_ORPHANED'); }
}
