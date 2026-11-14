import type { AgtArticleVisibility, ArticleVisibility, ArticleVisibilityFilter, ListArticlesQuery, Role } from '../src/lib/api.js';
import { fieldError } from '../src/lib/errors.js';
import { HttpError } from './http.js';

export {
  roles,
  type AgtArticleVisibility,
  type ArticleVisibility,
  type ArticleVisibilityFilter,
  type ArticleWrite,
  type LegacyArticleVisibility,
  type ListArticlesQuery,
  type Role,
  type TagWrite,
} from '../src/lib/api.js';
/**
 * Who is reading articles: a member role, an anonymous visitor (null), or the
 * internal system viewer the admin panel uses for inventory and statistics.
 */
export type Viewer = Role | 'System' | null;

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


/** Where a page of articles starts: after the item with these sort keys (API-8). */
export interface ArticleCursor {
  isPinned: boolean;
  /** The sort column's value: an ISO timestamp with microseconds, or the lower-cased title. */
  value: string;
  id: string;
}

/** What the repository is asked for: the query with its cursor decoded. */
export interface ArticlePageQuery extends Omit<ListArticlesQuery, 'cursor'> {
  after: ArticleCursor | null;
}

export interface ArticlePage {
  items: ArticleSummaryRecord[];
  /** The sort keys of the last item when more items follow, else null. */
  next: ArticleCursor | null;
  total: number;
}

export interface ArticleListResult {
  items: ArticleSummaryRecord[];
  nextCursor: string | null;
  total: number;
  /** Deprecated 1.x paging fields, only with `page` (removed in 3.0.0). */
  page?: number;
  pageSize?: number;
  totalPages?: number;
}


export type OrphanCleanupResult =
  | { status: 'updated'; article: ArticleRecord }
  | { status: 'not-found' }
  | { status: 'conflict' }
  | { status: 'not-orphan' };


export class NotFoundError extends HttpError {
  constructor(message = 'Article not found.') { super(404, 'not_found', message); }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'You do not have permission to perform this action.') { super(403, 'forbidden', message); }
}

export class ConflictError extends HttpError {
  constructor(message = 'The article has changed. Reload the latest version before saving.') { super(409, 'conflict', message, { legacyCode: 'VERSION_CONFLICT' }); }
}

export class NoChangesError extends HttpError {
  constructor() { super(400, 'no_changes', 'No changes were made to the article.'); }
}

export class InvalidTagIdsError extends HttpError {
  constructor() {
    const message = 'One or more selected tags do not exist. Refresh the tag list and try again.';
    super(400, 'validation_failed', message, { fields: [fieldError('tagIds', 'not_allowed', message)], legacyCode: 'INVALID_TAG_IDS' });
  }
}

export class TagNameConflictError extends HttpError {
  constructor() {
    const message = 'A tag with that name already exists.';
    super(409, 'conflict', message, { fields: [fieldError('name', 'duplicate', message)], legacyCode: 'TAG_NAME_CONFLICT' });
  }
}

export class TagNotFoundError extends HttpError {
  constructor() { super(404, 'not_found', 'Tag not found.', { legacyCode: 'TAG_NOT_FOUND' }); }
}

export class NotOrphanedTagError extends HttpError {
  constructor() { super(400, 'tag_not_orphaned', 'The selected tag ID is not an unresolved reference on this article.'); }
}
