// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ArticleService } from './article-service.js';
import { ConflictError, ForbiddenError, type Actor, type ArticleRecord, type ArticleWrite, type ListArticlesQuery } from './domain.js';
import type { ArticleRepository } from './repository.js';

const admin: Actor = { sub: 'admin-sub', displayName: 'Atlas', role: 'Admin' };
const standard: Actor = { sub: 'standard-sub', displayName: 'Apollo', role: 'Standard' };

class MemoryRepository implements ArticleRepository {
  records = new Map<string, ArticleRecord>();
  clock = 0;

  private time() { return new Date(Date.UTC(2026, 0, 1, 0, 0, this.clock++)).toISOString(); }

  async list(query: ListArticlesQuery) {
    let items = [...this.records.values()];
    const search = query.search.toLowerCase();
    if (search) items = items.filter((item) => `${item.title} ${item.content}`.toLowerCase().includes(search));
    if (query.tag) items = items.filter((item) => item.tags.includes(query.tag));
    if (query.protection !== 'all') items = items.filter((item) => item.isProtected === (query.protection === 'protected'));
    items.sort((left, right) => {
      const leftValue = query.sort === 'title' ? left.title.toLowerCase() : left[query.sort];
      const rightValue = query.sort === 'title' ? right.title.toLowerCase() : right[query.sort];
      const result = leftValue.localeCompare(rightValue) || left.id.localeCompare(right.id);
      return query.direction === 'asc' ? result : -result;
    });
    const start = (query.page - 1) * query.pageSize;
    return {
      items: items.slice(start, start + query.pageSize).map(({ content, ...item }) => ({ ...item, excerpt: content.slice(0, 240) })),
      page: query.page, pageSize: query.pageSize, total: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / query.pageSize)),
    };
  }

  async get(id: string) { return this.records.get(id) ?? null; }

  async create(input: ArticleWrite, actor: Actor) {
    const id = `00000000-0000-4000-8000-${String(this.records.size + 1).padStart(12, '0')}`;
    const now = this.time();
    const record: ArticleRecord = {
      id, title: input.title, content: input.content, tags: input.tags, isProtected: false,
      createdAt: now, createdBy: actor.sub, createdByName: actor.displayName,
      modifiedAt: now, modifiedBy: actor.sub, modifiedByName: actor.displayName, version: 1,
    };
    this.records.set(id, record);
    return record;
  }

  async update(id: string, input: ArticleWrite & { version: number }, actor: Actor) {
    const current = this.records.get(id);
    if (!current || current.version !== input.version || (current.isProtected && actor.role !== 'Admin')) return null;
    const updated = { ...current, ...input, modifiedAt: this.time(), modifiedBy: actor.sub, modifiedByName: actor.displayName, version: current.version + 1 };
    this.records.set(id, updated);
    return updated;
  }

  async setProtection(id: string, isProtected: boolean, version: number, actor: Actor) {
    const current = this.records.get(id);
    if (!current || current.version !== version) return null;
    const updated = { ...current, isProtected, modifiedAt: this.time(), modifiedBy: actor.sub, modifiedByName: actor.displayName, version: version + 1 };
    this.records.set(id, updated);
    return updated;
  }

  async delete(id: string, version: number) {
    if (this.records.get(id)?.version !== version) return false;
    return this.records.delete(id);
  }
}

const query: ListArticlesQuery = { search: '', tag: '', protection: 'all', sort: 'title', direction: 'asc', page: 1, pageSize: 10 };
const articleInput = (title: string, tags: string[] = []): ArticleWrite => ({ title, tags, content: `${title} contains enough persistent Markdown content.` });

describe('ArticleService authorization and persistence', () => {
  it('maintains server-owned creator and editor audit fields', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    const created = await service.create(articleInput('Portal Primer'), standard);
    expect(created).toMatchObject({ createdBy: standard.sub, modifiedBy: standard.sub, version: 1 });

    const updated = await service.update(created.id, { ...articleInput('Portal Primer Revised'), version: 1 }, admin);
    expect(updated).toMatchObject({ createdBy: standard.sub, modifiedBy: admin.sub, version: 2 });
  });

  it('allows Standard users to edit open articles but blocks protected articles', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    const created = await service.create(articleInput('Open Guide'), standard);
    await service.update(created.id, { ...articleInput('Open Guide Updated'), version: 1 }, standard);
    const protectedArticle = await service.setProtection(created.id, true, 2, admin);

    await expect(service.update(created.id, { ...articleInput('Forbidden Change'), version: protectedArticle.version }, standard)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.update(created.id, { ...articleInput('Admin Change'), version: protectedArticle.version }, admin)).resolves.toMatchObject({ title: 'Admin Change' });
  });

  it('restricts protection and deletion to Admins and rejects stale writes', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    const created = await service.create(articleInput('Security Guide'), standard);
    await expect(service.setProtection(created.id, true, 1, standard)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.delete(created.id, 1, standard)).rejects.toBeInstanceOf(ForbiddenError);
    await service.update(created.id, { ...articleInput('Security Guide v2'), version: 1 }, standard);
    await expect(service.update(created.id, { ...articleInput('Stale'), version: 1 }, standard)).rejects.toBeInstanceOf(ConflictError);
  });

  it('searches, filters, sorts predictably, and paginates', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    await service.create(articleInput('Zeta Freighter', ['ships']), standard);
    await service.create(articleInput('Alpha Portal', ['portals']), standard);
    await service.create(articleInput('Beta Portal', ['portals']), standard);

    const result = await service.list({ ...query, search: 'portal', tag: 'portals', pageSize: 1 });
    expect(result.total).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.items[0].title).toBe('Alpha Portal');
  });
});
