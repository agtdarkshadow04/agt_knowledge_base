// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ForbiddenError, TagNotFoundError, type Actor, type CanonicalTag, type TagOrphan, type TagWrite } from './domain.js';
import type { TagRepository } from './repository.js';
import { TagService } from './tag-service.js';

const moderator: Actor = { sub: 'moderator-sub', displayName: 'Atlas', role: 'Moderator' };
const editor: Actor = { sub: 'editor-sub', displayName: 'Apollo', role: 'Editor' };

class MemoryTagRepository implements TagRepository {
  tags: CanonicalTag[] = [
    { id: '10000000-0000-4000-8000-000000000001', name: 'Portal', color: '#B5C3B7' },
  ];

  async listTags(search: string) {
    return this.tags.filter((tag) => tag.name.toLowerCase().includes(search.toLowerCase()));
  }

  async createTag(input: TagWrite) {
    const tag = { id: '10000000-0000-4000-8000-000000000002', ...input };
    this.tags.push(tag);
    return tag;
  }

  async updateTag(id: string, input: TagWrite) {
    const tag = this.tags.find((candidate) => candidate.id === id);
    if (!tag) return null;
    Object.assign(tag, input);
    return tag;
  }

  async deleteTag(id: string) {
    const index = this.tags.findIndex((tag) => tag.id === id);
    if (index < 0) return false;
    this.tags.splice(index, 1);
    return true;
  }

  async listTagOrphans(): Promise<TagOrphan[]> {
    return [{
      articleId: '00000000-0000-4000-8000-000000000001',
      articleTitle: 'Portal Guide',
      version: 3,
      missingTagIds: ['10000000-0000-4000-8000-000000000099'],
    }];
  }
}

describe('TagService authorization', () => {
  it('allows everyone to search the catalog but reserves orphan inspection for Moderators', async () => {
    const service = new TagService(new MemoryTagRepository());

    await expect(service.list('port')).resolves.toEqual([
      expect.objectContaining({ name: 'Portal', color: '#B5C3B7' }),
    ]);
    expect(() => service.listOrphans(editor)).toThrow(ForbiddenError);
    await expect(service.listOrphans(moderator)).resolves.toEqual([
      expect.objectContaining({ articleTitle: 'Portal Guide', version: 3 }),
    ]);
  });

  it('allows only Moderators to create, update, and delete tags', async () => {
    const repository = new MemoryTagRepository();
    const service = new TagService(repository);

    expect(() => service.create({ name: 'Galaxy', color: '#ABCDEF' }, editor)).toThrow(ForbiddenError);
    await expect(service.update(repository.tags[0].id, { name: 'Gateway', color: '#ABCDEF' }, editor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.delete(repository.tags[0].id, editor)).rejects.toBeInstanceOf(ForbiddenError);

    const created = await service.create({ name: 'Galaxy', color: '#ABCDEF' }, moderator);
    await expect(service.update(created.id, { name: 'Galaxies', color: '#FEDCBA' }, moderator)).resolves.toMatchObject({
      name: 'Galaxies',
      color: '#FEDCBA',
    });
    await expect(service.delete(created.id, moderator)).resolves.toBeUndefined();
  });

  it('reports missing tags consistently for update and delete', async () => {
    const service = new TagService(new MemoryTagRepository());
    const missing = '10000000-0000-4000-8000-000000000099';

    await expect(service.update(missing, { name: 'Missing', color: '#ABCDEF' }, moderator)).rejects.toBeInstanceOf(TagNotFoundError);
    await expect(service.delete(missing, moderator)).rejects.toBeInstanceOf(TagNotFoundError);
  });
});
