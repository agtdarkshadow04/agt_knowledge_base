import assert from 'node:assert/strict';
import { describe, mock } from 'node:test';
import type { Actor } from '../domain.js';
import { mergeOrphanTagIds, PostgresArticleRepository } from '../repository/articles.js';
import { dataWriteIt, fakeDatabase } from './helpers.js';

type Query = (sql: string, params?: unknown[]) => Promise<unknown>;

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const moderator: Actor = { sub: 'moderator-sub', role: 'Moderator', displayName: 'Moderator', securityLevel: 5 };
const [a, b, c, orphan1, orphan2] = [
  '10000000-0000-4000-8000-00000000000a',
  '10000000-0000-4000-8000-00000000000b',
  '10000000-0000-4000-8000-00000000000c',
  '10000000-0000-4000-8000-0000000000f1',
  '10000000-0000-4000-8000-0000000000f2',
];

/** A client that answers the article SQL with `rows` and records every statement. */
function fakeClient(handler: (sql: string, params?: unknown[]) => unknown = () => undefined) {
  const query = mock.fn<Query>(async (sql, params) => handler(sql, params) ?? { rowCount: 0, rows: [] });
  const client = { query, release: mock.fn() };
  return { client, query, repository: new PostgresArticleRepository(fakeDatabase({ connect: async () => client, query })) };
}

describe('orphaned tag IDs (formerly merge_preserved_orphan_tag_ids, DATA-11)', () => {
  dataWriteIt('keeps every ID no longer in the catalog in its place and fills the others from the submitted IDs', () => {
    const catalog = new Set([a, b, c]);
    assert.deepEqual(mergeOrphanTagIds([a, orphan1, b], catalog, [c, a]), [c, orphan1, a]);
    assert.deepEqual(mergeOrphanTagIds([orphan1, a, orphan2], catalog, [b]), [orphan1, b, orphan2]);
    // Fewer submitted IDs drop catalog IDs, never orphans; more are appended.
    assert.deepEqual(mergeOrphanTagIds([a, b, orphan1], catalog, [c]), [c, orphan1]);
    assert.deepEqual(mergeOrphanTagIds([orphan1], catalog, [a, b]), [orphan1, a, b]);
    assert.deepEqual(mergeOrphanTagIds([], catalog, [a]), [a]);
  });

  dataWriteIt('merges in the update transaction, with the article row locked', async () => {
    const { query, repository } = fakeClient((sql) => {
      if (sql.startsWith('SELECT id FROM tags WHERE id = ANY($1::uuid[]) FOR KEY SHARE')) return { rows: [{ id: b }], rowCount: 1 };
      if (sql.startsWith('SELECT tag_ids FROM articles')) return { rows: [{ tag_ids: [orphan1, a] }], rowCount: 1 };
      if (sql.startsWith('SELECT id FROM tags WHERE id = ANY')) return { rows: [{ id: a }], rowCount: 1 };
      return undefined;
    });
    await repository.update(a, { title: 'Portal Guide', content: 'x'.repeat(20), tagIds: [b], version: 3 }, moderator);
    const sql = query.mock.calls.map(({ arguments: [statement] }) => statement);
    assert.ok(sql.includes('SELECT tag_ids FROM articles WHERE id = $1 FOR UPDATE'));
    const update = query.mock.calls.find(({ arguments: [statement] }) => statement.startsWith('UPDATE articles'))!;
    assert.deepEqual((update.arguments[1] as unknown[])[2], [orphan1, b]);
    assert.ok(!update.arguments[0].includes('merge_preserved_orphan_tag_ids'));
    assert.ok(update.arguments[0].includes('updated_at = now()'));
  });
});

describe('generated IDs (DATA-6)', () => {
  dataWriteIt('gives a new article and a new tag a crypto.randomUUID() ID', async () => {
    const { query, repository } = fakeClient((sql) => (sql.includes('RETURNING') ? { rows: [{ id: a, name: 'Portal', color: '#FFFFFF' }], rowCount: 1 } : undefined));
    await repository.create({ title: 'Portal Guide', content: 'x'.repeat(20), tagIds: [] }, moderator).catch(() => undefined);
    const article = query.mock.calls.find(({ arguments: [sql] }) => sql.startsWith('INSERT INTO articles'))!;
    assert.ok(article.arguments[0].startsWith('INSERT INTO articles (id, '));
    assert.match(String((article.arguments[1] as unknown[])[5]), uuidV4);

    await repository.createTag({ name: 'Portal', color: '#FFFFFF' });
    const tag = query.mock.calls.find(({ arguments: [sql] }) => sql.startsWith('INSERT INTO tags'))!;
    assert.ok(tag.arguments[0].startsWith('INSERT INTO tags (id, '));
    assert.match(String((tag.arguments[1] as unknown[])[2]), uuidV4);
  });
});
