import {
  ForbiddenError,
  TagNotFoundError,
  type Actor,
  type TagWrite,
} from './domain.js';
import type { TagRepository } from './repository.js';

export class TagService {
  constructor(private readonly repository: TagRepository) {}

  list(search: string) {
    return this.repository.listTags(search);
  }

  create(input: TagWrite, actor: Actor) {
    this.requireAdmin(actor);
    return this.repository.createTag(input);
  }

  async update(id: string, input: TagWrite, actor: Actor) {
    this.requireAdmin(actor);
    const updated = await this.repository.updateTag(id, input);
    if (!updated) throw new TagNotFoundError();
    return updated;
  }

  async delete(id: string, actor: Actor) {
    this.requireAdmin(actor);
    if (!(await this.repository.deleteTag(id))) throw new TagNotFoundError();
  }

  listOrphans(actor: Actor) {
    this.requireAdmin(actor);
    return this.repository.listTagOrphans();
  }

  private requireAdmin(actor: Actor) {
    if (actor.role !== 'Admin') {
      throw new ForbiddenError('Only Administrators can manage tags.');
    }
  }
}
