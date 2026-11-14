import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertMatches, assertEquals, match } from './helpers.js';
import { ForbiddenError, TagNotFoundError, type Actor, type CanonicalTag, type TagOrphan, type TagWrite } from '../domain.js';
import type { TagRepository } from '../repository.js';
import { TagService } from '../tag-service.js';

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

    assertEquals(await service.list('port'), [
      match.objectContaining({ name: 'Portal', color: '#B5C3B7' }),
    ]);
    assert.throws(() => service.listOrphans(editor), ForbiddenError);
    assertEquals(await service.listOrphans(moderator), [
      match.objectContaining({ articleTitle: 'Portal Guide', version: 3 }),
    ]);
  });

  it('allows only Moderators to create, update, and delete tags', async () => {
    const repository = new MemoryTagRepository();
    const service = new TagService(repository);

    assert.throws(() => service.create({ name: 'Galaxy', color: '#ABCDEF' }, editor), ForbiddenError);
    await assert.rejects(service.update(repository.tags[0].id, { name: 'Gateway', color: '#ABCDEF' }, editor), ForbiddenError);
    await assert.rejects(service.delete(repository.tags[0].id, editor), ForbiddenError);

    const created = await service.create({ name: 'Galaxy', color: '#ABCDEF' }, moderator);
    assertMatches(await service.update(created.id, { name: 'Galaxies', color: '#FEDCBA' }, moderator), {
      name: 'Galaxies',
      color: '#FEDCBA',
    });
    assert.equal(await service.delete(created.id, moderator), undefined);
  });

  it('reports missing tags consistently for update and delete', async () => {
    const service = new TagService(new MemoryTagRepository());
    const missing = '10000000-0000-4000-8000-000000000099';

    await assert.rejects(service.update(missing, { name: 'Missing', color: '#ABCDEF' }, moderator), TagNotFoundError);
    await assert.rejects(service.delete(missing, moderator), TagNotFoundError);
  });
});
