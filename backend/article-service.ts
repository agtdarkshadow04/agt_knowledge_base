import {
  canAssignArticleVisibility,
  ConflictError,
  ForbiddenError,
  NotOrphanedTagError,
  NoChangesError,
  NotFoundError,
  type Actor,
  type ArticleWrite,
  type ListArticlesQuery,
} from './domain.js';
import type { ArticleRepository } from './repository.js';

export class ArticleService {
  constructor(private readonly repository: ArticleRepository) {}

  list(query: ListArticlesQuery, actor: Actor | null) {
    return this.repository.list(query, actor?.role ?? null);
  }

  /** Every article at every visibility level, for the admin panel's inventory. */
  listAll(query: ListArticlesQuery) {
    return this.repository.list(query, 'System');
  }

  async get(id: string, actor: Actor | null) {
    const article = await this.repository.get(id, actor?.role ?? null);
    if (!article) throw new NotFoundError();
    return article;
  }

  async listRevisions(id: string, actor: Actor) {
    if (!(await this.repository.get(id, actor.role))) throw new NotFoundError();
    return this.repository.listRevisions(id);
  }

  create(input: ArticleWrite, actor: Actor) {
    const visibility = input.visibility ?? 'Internal';
    if (!canAssignArticleVisibility(actor.role, visibility)) {
      throw new ForbiddenError('Editors cannot assign this visibility level.');
    }
    return this.repository.create({ ...input, visibility }, actor);
  }

  async update(id: string, input: ArticleWrite, actor: Actor) {
    if (!input.version) throw new ConflictError('A version is required when updating an article.');
    const existing = await this.repository.get(id, actor.role);
    if (!existing) throw new NotFoundError();
    if (existing.isProtected && actor.role !== 'Moderator') {
      throw new ForbiddenError('This protected article can only be edited by a Moderator.');
    }
    const visibility = input.visibility ?? existing.visibility;
    if (!canAssignArticleVisibility(actor.role, visibility)) {
      throw new ForbiddenError('Editors cannot assign this visibility level.');
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
    if (!(await this.repository.get(id, actor.role))) throw new NotFoundError();
    const updated = await this.repository.setProtection(id, isProtected, version, actor);
    if (!updated) throw new ConflictError();
    return updated;
  }

  async setPinned(id: string, isPinned: boolean, version: number, actor: Actor) {
    if (actor.role !== 'Moderator') throw new ForbiddenError('Only Moderators can change pin status.');
    if (!(await this.repository.get(id, actor.role))) throw new NotFoundError();
    const updated = await this.repository.setPinned(id, isPinned, version, actor);
    if (!updated) throw new ConflictError();
    return updated;
  }

  async setVerified(id: string, isVerified: boolean, version: number, actor: Actor) {
    if (actor.role !== 'Moderator') throw new ForbiddenError('Only Moderators can change verification status.');
    if (!(await this.repository.get(id, actor.role))) throw new NotFoundError();
    const updated = await this.repository.setVerified(id, isVerified, version, actor);
    if (!updated) throw new ConflictError();
    return updated;
  }

  async restore(id: string, revisionVersion: number, currentVersion: number, actor: Actor) {
    if (actor.role !== 'Moderator') throw new ForbiddenError('Only Moderators can restore article revisions.');
    if (!(await this.repository.get(id, actor.role))) throw new NotFoundError();
    if (!(await this.repository.getRevision(id, revisionVersion))) {
      throw new NotFoundError('Article revision not found.');
    }
    const restored = await this.repository.restore(id, revisionVersion, currentVersion, actor);
    if (!restored) throw new ConflictError();
    return restored;
  }

  async delete(id: string, version: number, actor: Actor) {
    if (actor.role !== 'Moderator') throw new ForbiddenError('Only Moderators can delete articles.');
    if (!(await this.repository.get(id, actor.role))) throw new NotFoundError();
    if (!(await this.repository.delete(id, version))) throw new ConflictError();
  }

  async removeOrphanTag(id: string, tagId: string, version: number, actor: Actor) {
    if (actor.role !== 'Moderator') throw new ForbiddenError('Only Moderators can clean up unresolved tag references.');
    const result = await this.repository.removeOrphanTag(id, tagId, version, actor);
    if (result.status === 'not-found') throw new NotFoundError();
    if (result.status === 'conflict') throw new ConflictError();
    if (result.status === 'not-orphan') throw new NotOrphanedTagError();
    return result.article;
  }
}
