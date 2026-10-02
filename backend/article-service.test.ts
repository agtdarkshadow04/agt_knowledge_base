// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ArticleService } from './article-service.js';
import {
  ConflictError,
  ForbiddenError,
  type Actor,
  type ArticleRecord,
  type ArticleRevisionRecord,
  type ArticleWrite,
  type ListArticlesQuery,
  type Role,
} from './domain.js';
import type { ArticleRepository } from './repository.js';

const admin: Actor = { sub: 'admin-sub', displayName: 'Atlas', role: 'Admin' };
const standard: Actor = { sub: 'standard-sub', displayName: 'Apollo', role: 'Standard' };

class MemoryRepository implements ArticleRepository {
  records = new Map<string, ArticleRecord>();
  revisions = new Map<string, ArticleRevisionRecord[]>();
  clock = 0;

  private time() { return new Date(Date.UTC(2026, 0, 1, 0, 0, this.clock++)).toISOString(); }

  private recordRevision(record: ArticleRecord) {
    const revision: ArticleRevisionRecord = {
      articleId: record.id,
      title: record.title,
      content: record.content,
      tags: record.tags,
      visibility: record.visibility,
      isPinned: record.isPinned,
      isProtected: record.isProtected,
      isVerified: record.isVerified,
      revisedAt: record.modifiedAt,
      revisedBy: record.modifiedBy,
      revisedByName: record.modifiedByName,
      version: record.version,
    };
    const history = [revision, ...(this.revisions.get(record.id) ?? [])]
      .sort((left, right) => right.version - left.version)
      .slice(0, 5);
    this.revisions.set(record.id, history);
  }

  async list(query: ListArticlesQuery, viewerRole: Role | null) {
    let items = [...this.records.values()];
    const search = query.search.toLowerCase();
    if (search) items = items.filter((item) => `${item.title} ${item.content}`.toLowerCase().includes(search));
    if (query.tag) items = items.filter((item) => item.tags.includes(query.tag));
    if (query.visibility !== 'all') items = items.filter((item) => item.visibility.toLowerCase() === query.visibility);
    if (query.pinned === 'pinned') items = items.filter((item) => item.isPinned);
    if (query.protection !== 'all') items = items.filter((item) => item.isProtected === (query.protection === 'protected'));
    if (query.verification !== 'all') items = items.filter((item) => item.isVerified === (query.verification === 'verified'));
    items = items.filter((item) => viewerRole === 'Admin'
      || item.visibility === 'Public'
      || (viewerRole === 'Standard' && item.visibility === 'Internal'));
    items.sort((left, right) => {
      if (left.isPinned !== right.isPinned) return left.isPinned ? -1 : 1;
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

  async get(id: string, viewerRole: Role | null) {
    const article = this.records.get(id);
    if (!article) return null;
    if (viewerRole === 'Admin' || article.visibility === 'Public') return article;
    return viewerRole === 'Standard' && article.visibility === 'Internal' ? article : null;
  }
  async listRevisions(id: string) { return this.revisions.get(id) ?? []; }
  async getRevision(id: string, version: number) {
    return this.revisions.get(id)?.find((revision) => revision.version === version) ?? null;
  }

  async create(input: ArticleWrite, actor: Actor) {
    const id = `00000000-0000-4000-8000-${String(this.records.size + 1).padStart(12, '0')}`;
    const now = this.time();
    const record: ArticleRecord = {
      id, title: input.title, content: input.content, tags: input.tags,
      visibility: input.visibility ?? 'Internal', isPinned: false, isProtected: false, isVerified: false,
      createdAt: now, createdBy: actor.sub, createdByName: actor.displayName,
      modifiedAt: now, modifiedBy: actor.sub, modifiedByName: actor.displayName, version: 1,
    };
    this.records.set(id, record);
    this.recordRevision(record);
    return record;
  }

  async update(id: string, input: ArticleWrite & { version: number }, actor: Actor) {
    const current = this.records.get(id);
    if (!current || current.version !== input.version || (current.isProtected && actor.role !== 'Admin')) return null;
    const updated = { ...current, ...input, modifiedAt: this.time(), modifiedBy: actor.sub, modifiedByName: actor.displayName, version: current.version + 1 };
    this.records.set(id, updated);
    this.recordRevision(updated);
    return updated;
  }

  async setProtection(id: string, isProtected: boolean, version: number, actor: Actor) {
    const current = this.records.get(id);
    if (!current || current.version !== version) return null;
    const updated = { ...current, isProtected, modifiedAt: this.time(), modifiedBy: actor.sub, modifiedByName: actor.displayName, version: version + 1 };
    this.records.set(id, updated);
    this.recordRevision(updated);
    return updated;
  }

  async setPinned(id: string, isPinned: boolean, version: number, actor: Actor) {
    const current = this.records.get(id);
    if (!current || current.version !== version) return null;
    const updated = { ...current, isPinned, modifiedAt: this.time(), modifiedBy: actor.sub, modifiedByName: actor.displayName, version: version + 1 };
    this.records.set(id, updated);
    this.recordRevision(updated);
    return updated;
  }

  async setVerified(id: string, isVerified: boolean, version: number, actor: Actor) {
    const current = this.records.get(id);
    if (!current || current.version !== version) return null;
    const updated = { ...current, isVerified, modifiedAt: this.time(), modifiedBy: actor.sub, modifiedByName: actor.displayName, version: version + 1 };
    this.records.set(id, updated);
    this.recordRevision(updated);
    return updated;
  }

  async restore(id: string, revisionVersion: number, currentVersion: number, actor: Actor) {
    const current = this.records.get(id);
    const revision = await this.getRevision(id, revisionVersion);
    if (!current || !revision || current.version !== currentVersion) return null;
    const restored: ArticleRecord = {
      ...current,
      title: revision.title,
      content: revision.content,
      tags: revision.tags,
      visibility: revision.visibility,
      isPinned: revision.isPinned,
      isProtected: revision.isProtected,
      isVerified: revision.isVerified,
      modifiedAt: this.time(),
      modifiedBy: actor.sub,
      modifiedByName: actor.displayName,
      version: current.version + 1,
    };
    this.records.set(id, restored);
    this.recordRevision(restored);
    return restored;
  }

  async delete(id: string, version: number) {
    if (this.records.get(id)?.version !== version) return false;
    return this.records.delete(id);
  }
}

const query: ListArticlesQuery = { search: '', tag: '', visibility: 'all', pinned: 'all', protection: 'all', verification: 'all', sort: 'title', direction: 'asc', page: 1, pageSize: 10 };
const articleInput = (title: string, tags: string[] = [], visibility?: ArticleWrite['visibility']): ArticleWrite => ({ title, tags, content: `${title} contains enough persistent Markdown content.`, visibility });

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
    await expect(service.setPinned(created.id, true, 1, standard)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.setVerified(created.id, true, 1, standard)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.delete(created.id, 1, standard)).rejects.toBeInstanceOf(ForbiddenError);
    await service.update(created.id, { ...articleInput('Security Guide v2'), version: 1 }, standard);
    await expect(service.update(created.id, { ...articleInput('Stale'), version: 1 }, standard)).rejects.toBeInstanceOf(ConflictError);
  });

  it('allows only Admins to change verification status', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    const created = await service.create(articleInput('Verification Guide'), standard);

    const verified = await service.setVerified(created.id, true, created.version, admin);
    expect(verified).toMatchObject({ isVerified: true, modifiedBy: admin.sub, version: 2 });
    await expect(service.setVerified(created.id, false, created.version, admin)).rejects.toBeInstanceOf(ConflictError);
    await expect(service.setVerified(created.id, false, verified.version, standard)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.setVerified(created.id, false, verified.version, admin)).resolves.toMatchObject({
      isVerified: false,
      version: 3,
    });
  });

  it('searches, filters, sorts predictably, and paginates', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    await service.create(articleInput('Zeta Freighter', ['ships']), standard);
    await service.create(articleInput('Alpha Portal', ['portals']), standard);
    await service.create(articleInput('Beta Portal', ['portals']), standard);

    const result = await service.list({ ...query, search: 'portal', tag: 'portals', pageSize: 1 }, standard);
    expect(result.total).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.items[0].title).toBe('Alpha Portal');
  });

  it('places pinned articles first and filters to pinned articles', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    await service.create(articleInput('Alpha Portal'), standard);
    const beta = await service.create(articleInput('Beta Portal'), standard);
    await service.setPinned(beta.id, true, beta.version, admin);

    const result = await service.list(query, standard);
    expect(result.items.map((article) => article.title)).toEqual(['Beta Portal', 'Alpha Portal']);

    const pinned = await service.list({ ...query, pinned: 'pinned' }, standard);
    expect(pinned.items).toHaveLength(1);
    expect(pinned.items[0]).toMatchObject({ title: 'Beta Portal', isPinned: true });
  });

  it('filters articles by verification status', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    await service.create(articleInput('Unverified Portal'), standard);
    const verified = await service.create(articleInput('Verified Portal'), standard);
    await service.setVerified(verified.id, true, verified.version, admin);

    await expect(service.list({ ...query, verification: 'verified' }, standard)).resolves.toMatchObject({
      items: [expect.objectContaining({ title: 'Verified Portal', isVerified: true })],
    });
    await expect(service.list({ ...query, verification: 'unverified' }, standard)).resolves.toMatchObject({
      items: [expect.objectContaining({ title: 'Unverified Portal', isVerified: false })],
    });
  });

  it('defaults to Internal visibility and enforces role-based visibility', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    const internal = await service.create(articleInput('Internal Guide'), standard);
    const published = await service.create(articleInput('Public Guide', [], 'Public'), standard);
    const adminOnly = await service.create(articleInput('Admin Guide', [], 'Admin'), admin);

    expect(internal.visibility).toBe('Internal');
    expect(() => service.create(articleInput('Forbidden Admin Guide', [], 'Admin'), standard)).toThrow(ForbiddenError);
    await expect(service.update(internal.id, { ...articleInput('Hidden Guide', [], 'Admin'), version: internal.version }, standard)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.get(internal.id, null)).rejects.toMatchObject({ statusCode: 404 });

    await expect(service.list(query, null)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: published.id })],
    });
    await expect(service.list(query, standard)).resolves.toMatchObject({
      items: expect.not.arrayContaining([expect.objectContaining({ id: adminOnly.id })]),
    });
    await expect(service.list({ ...query, visibility: 'admin' }, admin)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: adminOnly.id })],
    });
  });

  it('retains five dated revisions for Standard users and restricts restoration to Admins', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    let article = await service.create(articleInput('Portal Guide v1'), standard);
    for (let version = 2; version <= 7; version += 1) {
      article = await service.update(article.id, { ...articleInput(`Portal Guide v${version}`), version: article.version }, standard);
    }

    const history = await service.listRevisions(article.id, standard);
    expect(history.map((revision) => revision.version)).toEqual([7, 6, 5, 4, 3]);
    expect(history.every((revision) => revision.revisedAt.endsWith('Z'))).toBe(true);
    await expect(service.restore(article.id, 4, article.version, standard)).rejects.toBeInstanceOf(ForbiddenError);

    const restored = await service.restore(article.id, 4, article.version, admin);
    expect(restored).toMatchObject({ title: 'Portal Guide v4', version: 8, modifiedBy: admin.sub });
    await expect(service.restore(article.id, 2, restored.version, admin)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.restore(article.id, 4, 7, admin)).rejects.toBeInstanceOf(ConflictError);
    await expect(service.listRevisions(article.id, admin)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ version: 8, title: 'Portal Guide v4' })]),
    );
  });
});
