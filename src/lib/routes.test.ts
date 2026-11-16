import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalHref, legacyPageRedirect, parseRoute, routeHref, safeNext } from './routes.js';

const id = '00000000-0000-4000-8000-000000000001';

describe('routes (FE-4)', () => {
  it('reads the page from the query parameters', () => {
    assert.deepEqual(parseRoute(''), { page: 'home' });
    assert.deepEqual(parseRoute('?search=warp&sort=title'), { page: 'home' });
    assert.deepEqual(parseRoute(`?article=${id}`), { page: 'article', id });
    assert.deepEqual(parseRoute(`?article=${id.toUpperCase()}&view=history`), { page: 'history', id });
    assert.deepEqual(parseRoute(`?article=${id}&view=edit`), { page: 'edit', id });
    assert.deepEqual(parseRoute('?view=new'), { page: 'new' });
    assert.deepEqual(parseRoute('?view=tags'), { page: 'tags' });
    assert.deepEqual(parseRoute('?view=login&next=%2F%3Fview%3Dtags'), { page: 'login', next: '/?view=tags' });
    assert.deepEqual(parseRoute('?article=nope'), { page: 'notFound' });
    assert.deepEqual(parseRoute(`?article=${id}&view=tags`), { page: 'notFound' });
    assert.deepEqual(parseRoute('?view=admin'), { page: 'notFound' });
  });

  it('builds links that parse back to the same page', () => {
    for (const route of [
      { page: 'home' }, { page: 'tags' }, { page: 'new' }, { page: 'login', next: '/' }, { page: 'login', next: `/?article=${id}` },
      { page: 'article', id }, { page: 'history', id }, { page: 'edit', id },
    ] as const) {
      assert.deepEqual(parseRoute(routeHref(route).slice(1)), route);
    }
    assert.equal(routeHref({ page: 'home' }, new URLSearchParams('search=warp&bogus=1&cursor=x')), '/?search=warp');
  });

  it('accepts only return addresses inside the app after sign-in', () => {
    assert.equal(safeNext('/?view=tags'), '/?view=tags');
    assert.equal(safeNext('/'), '/');
    for (const value of [null, '', 'https://evil.example', '//evil.example', '/\\evil.example', '/admin', 'javascript:alert(1)']) {
      assert.equal(safeNext(value), '/', String(value));
    }
  });

  it('normalizes addresses with history.replaceState in mind', () => {
    assert.equal(canonicalHref('/', ''), null);
    assert.equal(canonicalHref('/', `?article=${id}`), null);
    assert.equal(canonicalHref('/', `?article=${id.toUpperCase()}&utm=1`), `/?article=${id}`);
    assert.equal(canonicalHref('/', '?view=login&next=https://evil.example'), '/?view=login');
    assert.equal(canonicalHref('/', '?view=unknown'), null);
  });

  it('redirects the 1.x page paths to their deep links', () => {
    assert.equal(legacyPageRedirect('/login'), '/?view=login');
    assert.equal(legacyPageRedirect('/tags'), '/?view=tags');
    assert.equal(legacyPageRedirect('/articles/new'), '/?view=new');
    assert.equal(legacyPageRedirect(`/articles/${id}`), `/?article=${id}`);
    assert.equal(legacyPageRedirect(`/articles/${id}/history`), `/?article=${id}&view=history`);
    assert.equal(legacyPageRedirect(`/articles/${id}/edit`), `/?article=${id}&view=edit`);
    assert.equal(legacyPageRedirect('/articles/not-an-id'), null);
    assert.equal(legacyPageRedirect('/unknown'), null);
  });
});
