import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import pg from 'pg';
import { connectionParameters, MIGRATIONS } from '../db.js';
import { securityLevels, visibilityLevel, type ArticleVisibility } from '../../src/lib/api.js';
import { closeTestServers, createTestDatabase, createTestServer, testDatabaseUrl, type TestServer } from './postgres.js';

/**
 * Member security levels on real PostgreSQL (#70): the SQL access rule agrees
 * with `visibilityLevel()` for every stored visibility, migration 0021 keeps
 * the access existing members had, and the Admin sets local members' levels.
 */

const csrf = { 'x-agt-request': '1', 'content-type': 'application/json' };
const adminPassword = 'Admin-Password-1!';
const memberPassword = 'Member-Password-1!';
const visibilities: ArticleVisibility[] = [0, 1, 2, 3, 4, 5, 'Public', 'Internal', 'Admin'];
const servers: TestServer[] = [];

after(async () => {
  await closeTestServers(servers);
});

function cookieFrom(reply: { headers: Record<string, unknown> }, name: string) {
  const cookies = ([] as string[]).concat((reply.headers['set-cookie'] as string | string[] | undefined) ?? []);
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  assert.ok(found, `no ${name} cookie`);
  return found.split(';')[0];
}

function client(database: string) {
  const url = connectionParameters({ connectionString: testDatabaseUrl(), ssl: false });
  return new pg.Client({ host: url.host, port: url.port, user: url.user, password: url.password, database });
}

async function setUp() {
  const target = await createTestServer();
  servers.push(target);
  const setup = await target.app.inject({
    method: 'POST', url: '/api/setup', headers: csrf,
    payload: { setupPassword: 'test-setup-password-1A!', username: 'keeper', password: adminPassword },
  });
  assert.equal(setup.statusCode, 201, setup.body);
  return { target, admin: cookieFrom(setup, 'agt_knowledge_base_session') };
}

async function createMember(target: TestServer, admin: string, username: string, payload: Record<string, unknown>) {
  const reply = await target.app.inject({
    method: 'POST', url: '/api/admin/users', headers: { ...csrf, cookie: admin },
    payload: { username, displayName: username, role: 'Editor', password: memberPassword, ...payload },
  });
  assert.equal(reply.statusCode, 201, reply.body);
  return JSON.parse(reply.body) as { id: string; securityLevel: number };
}

async function signIn(target: TestServer, username: string) {
  const reply = await target.app.inject({ method: 'POST', url: '/api/member/login', headers: csrf, payload: { username, password: memberPassword } });
  assert.equal(reply.statusCode, 200, reply.body);
  return { cookie: cookieFrom(reply, 'agt_knowledge_base_member_session'), member: JSON.parse(reply.body) as { securityLevel: number } };
}

describe('member security levels (#70)', () => {
  it('lets each level read exactly the visibilities up to it, in SQL as in visibilityLevel()', async () => {
    const { target, admin } = await setUp();
    await createMember(target, admin, 'author', { role: 'Moderator', securityLevel: 5 });
    const author = await signIn(target, 'author');
    const ids = new Map<string, ArticleVisibility>();
    for (const visibility of visibilities) {
      const reply = await target.app.inject({
        method: 'POST', url: '/api/articles', headers: { ...csrf, cookie: author.cookie },
        payload: { title: `Level ${String(visibility)} guide`, content: 'Enough Markdown content for this article.', tagIds: [], visibility },
      });
      assert.equal(reply.statusCode, 201, reply.body);
      ids.set(JSON.parse(reply.body).id as string, visibility);
    }
    for (const level of securityLevels) {
      await createMember(target, admin, `reader${level}`, { securityLevel: level });
      const { cookie, member } = await signIn(target, `reader${level}`);
      assert.equal(member.securityLevel, level);
      const list = await target.app.inject({ method: 'GET', url: '/api/member/articles?limit=100', headers: { cookie } });
      const seen = (JSON.parse(list.body).items as Array<{ id: string }>).map((item) => ids.get(item.id)).map(String).sort();
      const expected = visibilities.filter((visibility) => visibilityLevel(visibility) <= level).map(String).sort();
      assert.deepEqual(seen, expected, `level ${level}`);
      for (const [id, visibility] of ids) {
        const read = await target.app.inject({ method: 'GET', url: `/api/member/articles/${id}`, headers: { cookie } });
        assert.equal(read.statusCode, visibilityLevel(visibility) <= level ? 200 : 404, `level ${level} reading ${String(visibility)}`);
      }
    }
    // Visitors read at level 0; the Admin's inventory sees everything.
    const anonymous = await target.app.inject({ method: 'GET', url: '/api/articles?limit=100' });
    assert.deepEqual((JSON.parse(anonymous.body).items as Array<{ id: string }>).map((item) => String(ids.get(item.id))).sort(), ['0', 'Public']);
    const inventory = await target.app.inject({ method: 'GET', url: '/api/admin/articles?limit=100', headers: { cookie: admin } });
    assert.equal(JSON.parse(inventory.body).items.length, visibilities.length);
  });

  it('refuses a visibility above the member\'s own level, whatever their role', async () => {
    const { target, admin } = await setUp();
    await createMember(target, admin, 'lowmod', { role: 'Moderator', securityLevel: 1 });
    const { cookie } = await signIn(target, 'lowmod');
    for (const visibility of [2, 'Admin']) {
      const reply = await target.app.inject({
        method: 'POST', url: '/api/articles', headers: { ...csrf, cookie },
        payload: { title: 'Too secret', content: 'Enough Markdown content for this article.', tagIds: [], visibility },
      });
      assert.equal(reply.statusCode, 403, String(visibility));
    }
  });

  it('lets the Admin set a local member\'s level: Public by default, validated, and a change signs them out', async () => {
    const { target, admin } = await setUp();
    const created = await createMember(target, admin, 'scribe', {});
    assert.equal(created.securityLevel, 0);
    const { cookie } = await signIn(target, 'scribe');
    const update = (payload: Record<string, unknown>) => target.app.inject({
      method: 'PUT', url: `/api/admin/users/${created.id}`, headers: { ...csrf, cookie: admin },
      payload: { username: 'scribe', displayName: 'scribe', role: 'Editor', isActive: true, ...payload },
    });
    for (const securityLevel of [6, -1, 1.5]) {
      const invalid = await update({ securityLevel });
      assert.equal(invalid.statusCode, 400, String(securityLevel));
      assert.equal(JSON.parse(invalid.body).fields[0].field, 'securityLevel');
    }
    // Leaving it out keeps the level and the session.
    assert.equal(JSON.parse((await update({})).body).securityLevel, 0);
    assert.equal((await target.app.inject({ method: 'GET', url: '/api/member/session', headers: { cookie } })).statusCode, 200);
    const raised = await update({ securityLevel: 3 });
    assert.equal(JSON.parse(raised.body).securityLevel, 3);
    assert.equal((await target.app.inject({ method: 'GET', url: '/api/member/session', headers: { cookie } })).statusCode, 401);
    assert.equal((await signIn(target, 'scribe')).member.securityLevel, 3);
  });

  it('migration 0021 gives existing Editors level 1 and Moderators level 5', async () => {
    const database = await createTestDatabase();
    const db = client(database.name);
    await db.connect();
    try {
      for (const migration of MIGRATIONS.slice(0, -1)) await db.query(migration.sql);
      for (const [id, username, role] of [
        ['10000000-0000-4000-8000-000000000001', 'editor', 'Editor'],
        ['10000000-0000-4000-8000-000000000002', 'moderator', 'Moderator'],
      ]) {
        await db.query("INSERT INTO local_users (id, username, password_hash, display_name, role) VALUES ($1, $2, 'scrypt$x', $2, $3)", [id, username, role]);
      }
      assert.equal(MIGRATIONS.at(-1)!.name, 'member_security_level');
      await db.query(MIGRATIONS.at(-1)!.sql);
      const rows = (await db.query('SELECT username, security_level FROM local_users ORDER BY username')).rows;
      assert.deepEqual(rows, [{ username: 'editor', security_level: 1 }, { username: 'moderator', security_level: 5 }]);
      // The server writes every new member's level itself: the column has no default any more.
      await assert.rejects(db.query("INSERT INTO local_users (id, username, password_hash, display_name, role) VALUES ('10000000-0000-4000-8000-000000000003', 'nolevel', 'scrypt$x', 'x', 'Editor')"));
      await assert.rejects(db.query("UPDATE local_users SET security_level = 6 WHERE username = 'editor'"));
    } finally {
      await db.end();
      await database.drop();
    }
  });
});
