import {
  canAssignArticleVisibility,
  ConflictError,
  ForbiddenError,
  NotOrphanedTagError,
  NoChangesError,
  NotFoundError,
  type Actor,
  type ArticleWrite,
  type ArticleListResult,
  type ListArticlesQuery,
  type Viewer,
} from './domain.js';
import { decodeCursor, encodeCursor } from './pagination.js';
import type { ArticleRepository } from './repository.js';

export class ArticleService {
  constructor(private readonly repository: ArticleRepository) {}

  list(query: ListArticlesQuery, actor: Actor | null) {
    return this.page(query, actor?.securityLevel ?? null);
  }

  /** Every article at every visibility level, for the admin panel's inventory. */
  listAll(query: ListArticlesQuery) {
    return this.page(query, 'System');
  }

  private async page({ cursor, ...query }: ListArticlesQuery, viewer: Viewer): Promise<ArticleListResult> {
    // Deprecated offset paging ignores the cursor.
    const after = query.page === undefined ? decodeCursor(query, cursor) : null;
    const page = await this.repository.list({ ...query, after }, viewer);
    const result: ArticleListResult = {
      items: page.items,
      nextCursor: page.next ? encodeCursor(query, page.next) : null,
      total: page.total,
    };
    if (query.page === undefined) return result;
    return {
      ...result,
      page: query.page,
      pageSize: query.limit,
      totalPages: Math.max(1, Math.ceil(page.total / query.limit)),
    };
  }

  async get(id: string, actor: Actor | null) {
    const article = await this.repository.get(id, actor?.securityLevel ?? null);
    if (!article) throw new NotFoundError();
    return article;
  }

  async listRevisions(id: string, actor: Actor) {
    if (!(await this.repository.get(id, actor.securityLevel))) throw new NotFoundError();
    return this.repository.listRevisions(id);
  }

  create(input: ArticleWrite, actor: Actor) {
    const visibility = input.visibility ?? 'Internal';
    if (!canAssignArticleVisibility(actor.securityLevel, visibility)) {
      throw new ForbiddenError('Your security level does not allow this visibility level.');
    }
    return this.repository.create({ ...input, visibility }, actor);
  }

  async update(id: string, input: ArticleWrite, actor: Actor) {
    if (!input.version) throw new ConflictError('A version is required when updating an article.');
    const existing = await this.repository.get(id, actor.securityLevel);
    if (!existing) throw new NotFoundError();
    if (existing.isProtected && actor.role !== 'Moderator') {
      throw new ForbiddenError('This protected article can only be edited by a Moderator.');
    }
    const visibility = input.visibility ?? existing.visibility;
    if (!canAssignArticleVisibility(actor.securityLevel, visibility)) {
      throw new ForbiddenError('Your security level does not allow this visibility level.');
    }
    if (existing.version !== input.version) throw new ConflictError();
    const unchanged = existing.title === input.title
      && existing.content === input.content
      && existing.visibility === visibility
      && existing.tags.length === input.tagIds.length
      && existing.tags.every((tag, index) => tag.id === input.tagIds[index]);
    if (unchanged) throw new NoChangesError();
    const updated = await this.repository.update(id, { ...input, visibility, version: input.version }, actor);
    if (!updated) throw new ConflictError();
    return updated;
  }

  async setProtection(id: string, isProtected: boolean, version: number, actor: Actor) {
    if (actor.role !== 'Moderator') throw new ForbiddenError('Only Moderators can change protection status.');
    if (!(await this.repository.get(id, actor.securityLevel))) throw new NotFoundError();
    const updated = await this.repository.setProtection(id, isProtected, version, actor);
    if (!updated) throw new ConflictError();
    return updated;
  }

  async setPinned(id: string, isPinned: boolean, version: number, actor: Actor) {
    if (actor.role !== 'Moderator') throw new ForbiddenError('Only Moderators can change pin status.');
    if (!(await this.repository.get(id, actor.securityLevel))) throw new NotFoundError();
    const updated = await this.repository.setPinned(id, isPinned, version, actor);
    if (!updated) throw new ConflictError();
    return updated;
  }

  async setVerified(id: string, isVerified: boolean, version: number, actor: Actor) {
    if (actor.role !== 'Moderator') throw new ForbiddenError('Only Moderators can change verification status.');
    if (!(await this.repository.get(id, actor.securityLevel))) throw new NotFoundError();
    const updated = await this.repository.setVerified(id, isVerified, version, actor);
    if (!updated) throw new ConflictError();
    return updated;
  }

  async restore(id: string, revisionVersion: number, currentVersion: number, actor: Actor) {
    if (actor.role !== 'Moderator') throw new ForbiddenError('Only Moderators can restore article revisions.');
    if (!(await this.repository.get(id, actor.securityLevel))) throw new NotFoundError();
    const revision = await this.repository.getRevision(id, revisionVersion);
    if (!revision) throw new NotFoundError('Article revision not found.');
    // Restoring brings back the revision's visibility, which must be one the Moderator can read (#70).
    if (!canAssignArticleVisibility(actor.securityLevel, revision.visibility)) {
      throw new ForbiddenError('Your security level does not allow this visibility level.');
    }
    const restored = await this.repository.restore(id, revisionVersion, currentVersion, actor);
    if (!restored) throw new ConflictError();
    return restored;
  }

  async delete(id: string, version: number, actor: Actor) {
    if (actor.role !== 'Moderator') throw new ForbiddenError('Only Moderators can delete articles.');
    if (!(await this.repository.get(id, actor.securityLevel))) throw new NotFoundError();
    if (!(await this.repository.delete(id, version))) throw new ConflictError();
  }

  async removeOrphanTag(id: string, tagId: string, version: number, actor: Actor) {
    if (actor.role !== 'Moderator') throw new ForbiddenError('Only Moderators can clean up unresolved tag references.');
    if (!(await this.repository.get(id, actor.securityLevel))) throw new NotFoundError();
    const result = await this.repository.removeOrphanTag(id, tagId, version, actor);
    if (result.status === 'not-found') throw new NotFoundError();
    if (result.status === 'conflict') throw new ConflictError();
    if (result.status === 'not-orphan') throw new NotOrphanedTagError();
    return result.article;
  }
}
