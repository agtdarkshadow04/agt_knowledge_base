import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type Actor,
  type ArticleWrite,
  type ListArticlesQuery,
} from './domain.js';
import type { ArticleRepository } from './repository.js';

export class ArticleService {
  constructor(private readonly repository: ArticleRepository) {}

  list(query: ListArticlesQuery) { return this.repository.list(query); }

  async get(id: string) {
    const article = await this.repository.get(id);
    if (!article) throw new NotFoundError();
    return article;
  }

  async listRevisions(id: string) {
    if (!(await this.repository.get(id))) throw new NotFoundError();
    return this.repository.listRevisions(id);
  }

  create(input: ArticleWrite, actor: Actor) {
    return this.repository.create(input, actor);
  }

  async update(id: string, input: ArticleWrite, actor: Actor) {
    if (!input.version) throw new ConflictError('A version is required when updating an article.');
    const existing = await this.repository.get(id);
    if (!existing) throw new NotFoundError();
    if (existing.isProtected && actor.role !== 'Admin') {
      throw new ForbiddenError('This protected article can only be edited by an Administrator.');
    }
    const updated = await this.repository.update(id, { ...input, version: input.version }, actor);
    if (!updated) throw new ConflictError();
    return updated;
  }

  async setProtection(id: string, isProtected: boolean, version: number, actor: Actor) {
    if (actor.role !== 'Admin') throw new ForbiddenError('Only Administrators can change protection status.');
    if (!(await this.repository.get(id))) throw new NotFoundError();
    const updated = await this.repository.setProtection(id, isProtected, version, actor);
    if (!updated) throw new ConflictError();
    return updated;
  }

  async setPinned(id: string, isPinned: boolean, version: number, actor: Actor) {
    if (actor.role !== 'Admin') throw new ForbiddenError('Only Administrators can change pin status.');
    if (!(await this.repository.get(id))) throw new NotFoundError();
    const updated = await this.repository.setPinned(id, isPinned, version, actor);
    if (!updated) throw new ConflictError();
    return updated;
  }

  async restore(id: string, revisionVersion: number, currentVersion: number, actor: Actor) {
    if (actor.role !== 'Admin') throw new ForbiddenError('Only Administrators can restore article revisions.');
    if (!(await this.repository.get(id))) throw new NotFoundError();
    if (!(await this.repository.getRevision(id, revisionVersion))) {
      throw new NotFoundError('Article revision not found.');
    }
    const restored = await this.repository.restore(id, revisionVersion, currentVersion, actor);
    if (!restored) throw new ConflictError();
    return restored;
  }

  async delete(id: string, version: number, actor: Actor) {
    if (actor.role !== 'Admin') throw new ForbiddenError('Only Administrators can delete articles.');
    if (!(await this.repository.get(id))) throw new NotFoundError();
    if (!(await this.repository.delete(id, version))) throw new ConflictError();
  }
}
