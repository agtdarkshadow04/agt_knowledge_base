import type { AgtArticleVisibility, ArticleVisibility, ArticleVisibilityFilter, Role } from '../src/lib/api.js';
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


export interface ArticleListResult {
  items: ArticleSummaryRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}


export type OrphanCleanupResult =
  | { status: 'updated'; article: ArticleRecord }
  | { status: 'not-found' }
  | { status: 'conflict' }
  | { status: 'not-orphan' };


export class NotFoundError extends HttpError {
  constructor(message = 'Article not found.') { super(404, 'NOT_FOUND', message); }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'You do not have permission to perform this action.') { super(403, 'FORBIDDEN', message); }
}

export class ConflictError extends HttpError {
  constructor(message = 'The article has changed. Reload the latest version before saving.') { super(409, 'VERSION_CONFLICT', message); }
}

export class NoChangesError extends HttpError {
  constructor() { super(400, 'NO_CHANGES', 'No changes were made to the article.'); }
}

export class InvalidTagIdsError extends HttpError {
  constructor() { super(400, 'INVALID_TAG_IDS', 'One or more selected tags do not exist. Refresh the tag list and try again.'); }
}

export class TagNameConflictError extends HttpError {
  constructor() { super(409, 'TAG_NAME_CONFLICT', 'A tag with that name already exists.'); }
}

export class TagNotFoundError extends HttpError {
  constructor() { super(404, 'TAG_NOT_FOUND', 'Tag not found.'); }
}

export class NotOrphanedTagError extends HttpError {
  constructor() { super(400, 'TAG_NOT_ORPHANED', 'The selected tag ID is not an unresolved reference on this article.'); }
}
