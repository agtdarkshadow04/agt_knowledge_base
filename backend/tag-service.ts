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
    this.requireModerator(actor);
    return this.repository.createTag(input);
  }

  async update(id: string, input: TagWrite, actor: Actor) {
    this.requireModerator(actor);
    const updated = await this.repository.updateTag(id, input);
    if (!updated) throw new TagNotFoundError();
    return updated;
  }

  async delete(id: string, actor: Actor) {
    this.requireModerator(actor);
    if (!(await this.repository.deleteTag(id))) throw new TagNotFoundError();
  }

  listOrphans(actor: Actor) {
    this.requireModerator(actor);
    return this.repository.listTagOrphans();
  }

  private requireModerator(actor: Actor) {
    if (actor.role !== 'Moderator') {
      throw new ForbiddenError('Only Moderators can manage tags.');
    }
  }
}
