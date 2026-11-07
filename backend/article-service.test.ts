// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ArticleService } from './article-service.js';
import {
  articleVisibilityFromFilter,
  canViewArticleVisibility,
  ConflictError,
  ForbiddenError,
  type Actor,
  type ArticleRecord,
  type ArticleRevisionRecord,
  type ArticleWrite,
  type CanonicalTag,
  type ListArticlesQuery,
  type Viewer,
} from './domain.js';
import type { ArticleRepository } from './repository.js';

const moderator: Actor = { sub: 'moderator-sub', displayName: 'Atlas', role: 'Moderator' };
const editor: Actor = { sub: 'editor-sub', displayName: 'Apollo', role: 'Editor' };
const tagCatalog: Record<string, CanonicalTag> = {
  ships: { id: '10000000-0000-4000-8000-000000000001', name: 'ships', color: '#AABBCC' },
  portals: { id: '10000000-0000-4000-8000-000000000002', name: 'portals', color: '#B5C3B7' },
};

function tagsForIds(tagIds: string[]) {
  return tagIds.flatMap((tagId) => {
    const tag = Object.values(tagCatalog).find((candidate) => candidate.id === tagId);
    return tag ? [tag] : [];
  });
}

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

  async list(query: ListArticlesQuery, viewer: Viewer) {
    let items = [...this.records.values()];
    const search = query.search.toLowerCase();
    if (search) items = items.filter((item) => `${item.title} ${item.content}`.toLowerCase().includes(search));
    if (query.tagId) items = items.filter((item) => item.tags.some((tag) => tag.id === query.tagId));
    const visibilityFilter = articleVisibilityFromFilter(query.visibility);
    if (visibilityFilter !== null) items = items.filter((item) => item.visibility === visibilityFilter);
    if (query.pinned === 'pinned') items = items.filter((item) => item.isPinned);
    if (query.protection !== 'all') items = items.filter((item) => item.isProtected === (query.protection === 'protected'));
    if (query.verification !== 'all') items = items.filter((item) => item.isVerified === (query.verification === 'verified'));
    items = items.filter((item) => canViewArticleVisibility(viewer, item.visibility));
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

  async get(id: string, viewer: Viewer) {
    const article = this.records.get(id);
    if (!article) return null;
    return canViewArticleVisibility(viewer, article.visibility) ? article : null;
  }
  async listRevisions(id: string) { return this.revisions.get(id) ?? []; }
  async getRevision(id: string, version: number) {
    return this.revisions.get(id)?.find((revision) => revision.version === version) ?? null;
  }

  async create(input: ArticleWrite, actor: Actor) {
    const id = `00000000-0000-4000-8000-${String(this.records.size + 1).padStart(12, '0')}`;
    const now = this.time();
    const record: ArticleRecord = {
      id, title: input.title, content: input.content, tags: tagsForIds(input.tagIds),
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
    if (!current || current.version !== input.version || (current.isProtected && actor.role !== 'Moderator')) return null;
    const updated: ArticleRecord = {
      ...current,
      title: input.title,
      content: input.content,
      tags: tagsForIds(input.tagIds),
      visibility: input.visibility ?? 'Internal',
      modifiedAt: this.time(),
      modifiedBy: actor.sub,
      modifiedByName: actor.displayName,
      version: current.version + 1,
    };
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

  async removeOrphanTag() {
    return { status: 'not-orphan' as const };
  }
}

const query: ListArticlesQuery = { search: '', tagId: '', visibility: 'all', pinned: 'all', protection: 'all', verification: 'all', sort: 'title', direction: 'asc', page: 1, pageSize: 10 };
const articleInput = (title: string, tags: string[] = [], visibility?: ArticleWrite['visibility']): ArticleWrite => ({
  title,
  tagIds: tags.map((tag) => tagCatalog[tag].id),
  content: `${title} contains enough persistent Markdown content.`,
  visibility,
});

describe('ArticleService authorization and persistence', () => {
  it('maintains server-owned creator and editor audit fields', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    const created = await service.create(articleInput('Portal Primer'), editor);
    expect(created).toMatchObject({ createdBy: editor.sub, modifiedBy: editor.sub, version: 1 });

    const updated = await service.update(created.id, { ...articleInput('Portal Primer Revised'), version: 1 }, moderator);
    expect(updated).toMatchObject({ createdBy: editor.sub, modifiedBy: moderator.sub, version: 2 });
  });

  it('rejects updates that do not change document fields', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    const created = await service.create(articleInput('Unchanged Guide'), editor);

    await expect(service.update(
      created.id,
      { ...articleInput('Unchanged Guide'), version: created.version },
      editor,
    )).rejects.toMatchObject({
      statusCode: 400,
      code: 'NO_CHANGES',
      message: 'No changes were made to the article.',
    });
    expect(repository.records.get(created.id)).toMatchObject({ version: 1 });
    expect(await repository.listRevisions(created.id)).toHaveLength(1);
  });

  it('allows Editors to edit open articles but blocks protected articles', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    const created = await service.create(articleInput('Open Guide'), editor);
    await service.update(created.id, { ...articleInput('Open Guide Updated'), version: 1 }, editor);
    const protectedArticle = await service.setProtection(created.id, true, 2, moderator);

    await expect(service.update(created.id, { ...articleInput('Forbidden Change'), version: protectedArticle.version }, editor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.update(created.id, { ...articleInput('Admin Change'), version: protectedArticle.version }, moderator)).resolves.toMatchObject({ title: 'Admin Change' });
  });

  it('restricts protection and deletion to Moderators and rejects stale writes', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    const created = await service.create(articleInput('Security Guide'), editor);
    await expect(service.setProtection(created.id, true, 1, editor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.setPinned(created.id, true, 1, editor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.setVerified(created.id, true, 1, editor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.delete(created.id, 1, editor)).rejects.toBeInstanceOf(ForbiddenError);
    await service.update(created.id, { ...articleInput('Security Guide v2'), version: 1 }, editor);
    await expect(service.update(created.id, { ...articleInput('Stale'), version: 1 }, editor)).rejects.toBeInstanceOf(ConflictError);
  });

  it('allows only Moderators to change verification status', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    const created = await service.create(articleInput('Verification Guide'), editor);

    const verified = await service.setVerified(created.id, true, created.version, moderator);
    expect(verified).toMatchObject({ isVerified: true, modifiedBy: moderator.sub, version: 2 });
    await expect(service.setVerified(created.id, false, created.version, moderator)).rejects.toBeInstanceOf(ConflictError);
    await expect(service.setVerified(created.id, false, verified.version, editor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.setVerified(created.id, false, verified.version, moderator)).resolves.toMatchObject({
      isVerified: false,
      version: 3,
    });
  });

  it('searches, filters, sorts predictably, and paginates', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    await service.create(articleInput('Zeta Freighter', ['ships']), editor);
    await service.create(articleInput('Alpha Portal', ['portals']), editor);
    await service.create(articleInput('Beta Portal', ['portals']), editor);

    const result = await service.list({ ...query, search: 'portal', tagId: tagCatalog.portals.id, pageSize: 1 }, editor);
    expect(result.total).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.items[0].title).toBe('Alpha Portal');
  });

  it('places pinned articles first and filters to pinned articles', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    await service.create(articleInput('Alpha Portal'), editor);
    const beta = await service.create(articleInput('Beta Portal'), editor);
    await service.setPinned(beta.id, true, beta.version, moderator);

    const result = await service.list(query, editor);
    expect(result.items.map((article) => article.title)).toEqual(['Beta Portal', 'Alpha Portal']);

    const pinned = await service.list({ ...query, pinned: 'pinned' }, editor);
    expect(pinned.items).toHaveLength(1);
    expect(pinned.items[0]).toMatchObject({ title: 'Beta Portal', isPinned: true });
  });

  it('filters articles by verification status', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    await service.create(articleInput('Unverified Portal'), editor);
    const verified = await service.create(articleInput('Verified Portal'), editor);
    await service.setVerified(verified.id, true, verified.version, moderator);

    await expect(service.list({ ...query, verification: 'verified' }, editor)).resolves.toMatchObject({
      items: [expect.objectContaining({ title: 'Verified Portal', isVerified: true })],
    });
    await expect(service.list({ ...query, verification: 'unverified' }, editor)).resolves.toMatchObject({
      items: [expect.objectContaining({ title: 'Unverified Portal', isVerified: false })],
    });
  });

  it('defaults to Internal visibility and enforces role-based visibility', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    const internal = await service.create(articleInput('Internal Guide'), editor);
    const published = await service.create(articleInput('Public Guide', [], 'Public'), editor);
    const adminOnly = await service.create(articleInput('Admin Guide', [], 'Admin'), moderator);
    const agtPublic = await service.create(articleInput('AGT Public Guide', [], 0), editor);
    const privateArticle = await service.create(articleInput('Private Guide', [], 1), editor);
    const restricted = await service.create(articleInput('Restricted Guide', [], 2), moderator);

    expect(internal.visibility).toBe('Internal');
    expect(() => service.create(articleInput('Forbidden Admin Guide', [], 'Admin'), editor)).toThrow(ForbiddenError);
    expect(() => service.create(articleInput('Forbidden Restricted Guide', [], 2), editor)).toThrow(ForbiddenError);
    await expect(service.update(internal.id, { ...articleInput('Hidden Guide', [], 'Admin'), version: internal.version }, editor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.get(internal.id, null)).rejects.toMatchObject({ statusCode: 404 });

    await expect(service.list(query, null)).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: published.id }),
        expect.objectContaining({ id: agtPublic.id }),
      ]),
    });
    await expect(service.list(query, editor)).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: privateArticle.id })]),
    });
    await expect(service.list(query, editor)).resolves.toMatchObject({
      items: expect.not.arrayContaining([
        expect.objectContaining({ id: adminOnly.id }),
        expect.objectContaining({ id: restricted.id }),
      ]),
    });
    await expect(service.list({ ...query, visibility: 'admin' }, moderator)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: adminOnly.id })],
    });
    await expect(service.list({ ...query, visibility: '2' }, moderator)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: restricted.id })],
    });
  });

  it('lists every visibility level for the admin inventory without a member actor', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    await service.create(articleInput('Internal Guide'), editor);
    await service.create(articleInput('Legacy Moderator Guide', [], 'Admin'), moderator);
    await service.create(articleInput('SCC Guide', [], 5), moderator);

    const all = await service.listAll(query);
    expect(all.items.map((item) => item.title).sort()).toEqual(['Internal Guide', 'Legacy Moderator Guide', 'SCC Guide']);
    await expect(service.list(query, editor)).resolves.toMatchObject({ total: 1 });
  });

  it('lets Moderators see legacy Admin and AGT 2-5 articles and Editors only Public, Internal, 0 and 1', () => {
    for (const visibility of ['Admin', 2, 3, 4, 5] as const) {
      expect(canViewArticleVisibility('Moderator', visibility)).toBe(true);
      expect(canViewArticleVisibility('Editor', visibility)).toBe(false);
      expect(canViewArticleVisibility(null, visibility)).toBe(false);
    }
    for (const visibility of ['Public', 'Internal', 0, 1] as const) expect(canViewArticleVisibility('Editor', visibility)).toBe(true);
    expect(canViewArticleVisibility(null, 'Internal')).toBe(false);
  });

  it('retains five dated revisions for Editors and restricts restoration to Moderators', async () => {
    const repository = new MemoryRepository();
    const service = new ArticleService(repository);
    let article = await service.create(articleInput('Portal Guide v1'), editor);
    for (let version = 2; version <= 7; version += 1) {
      article = await service.update(article.id, { ...articleInput(`Portal Guide v${version}`), version: article.version }, editor);
    }

    const history = await service.listRevisions(article.id, editor);
    expect(history.map((revision) => revision.version)).toEqual([7, 6, 5, 4, 3]);
    expect(history.every((revision) => revision.revisedAt.endsWith('Z'))).toBe(true);
    await expect(service.restore(article.id, 4, article.version, editor)).rejects.toBeInstanceOf(ForbiddenError);

    const restored = await service.restore(article.id, 4, article.version, moderator);
    expect(restored).toMatchObject({ title: 'Portal Guide v4', version: 8, modifiedBy: moderator.sub });
    await expect(service.restore(article.id, 2, restored.version, moderator)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.restore(article.id, 4, 7, moderator)).rejects.toBeInstanceOf(ConflictError);
    await expect(service.listRevisions(article.id, moderator)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ version: 8, title: 'Portal Guide v4' })]),
    );
  });
});
