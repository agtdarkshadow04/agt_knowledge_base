import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { ApiError, apiErrorFrom, apiFetch, apiRequest, attachmentName, onMaintenance, retryAfterSeconds } from './client.js';

type Call = { url: string; init: RequestInit };

function stubFetch(...responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
  return { calls, fetchMock };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

describe('apiRequest', () => {
  it('sends same-origin, uncached JSON requests with x-agt-client: web (FE-2, LOG-13)', async () => {
    const { calls } = stubFetch(json(200, { ok: true }));
    assert.deepEqual(await apiRequest('/articles'), { ok: true });
    const [{ url, init }] = calls;
    const headers = new Headers(init.headers);
    assert.equal(url, '/api/articles');
    assert.equal(init.method, 'GET');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(headers.get('x-agt-client'), 'web');
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('x-agt-request'), null);
  });

  it('adds the CSRF header and a JSON body to writes (SEC-5)', async () => {
    const { calls } = stubFetch(new Response(null, { status: 204 }));
    assert.equal(await apiRequest('/articles/1', { method: 'put', body: { title: 'A' } }), undefined);
    const headers = new Headers(calls[0].init.headers);
    assert.equal(calls[0].init.method, 'PUT');
    assert.equal(headers.get('x-agt-request'), '1');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(calls[0].init.body, '{"title":"A"}');
  });

  it('sends FormData as it is and keeps paths that already start with /api', async () => {
    const form = new FormData();
    form.append('action', 'preview');
    const { calls } = stubFetch(json(200, {}));
    await apiRequest('/api/admin/restore', { method: 'POST', body: form });
    assert.equal(calls[0].url, '/api/admin/restore');
    assert.equal(calls[0].init.body, form);
    assert.equal(new Headers(calls[0].init.headers).get('content-type'), null);
  });

  it('throws ApiError(status, message, code, fields) from the API-6 body', async () => {
    stubFetch(json(400, { error: 'validation_failed', message: 'Invalid.', fields: [{ field: 'title', code: 'required', message: 'Required.' }, { bogus: true }] }));
    await assert.rejects(apiRequest('/articles', { method: 'POST', body: {} }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'validation_failed');
      assert.equal(error.message, 'Invalid.');
      assert.deepEqual(error.fields, [{ field: 'title', code: 'required', message: 'Required.' }]);
      assert.equal(error.field('title')?.code, 'required');
      return true;
    });
  });

  it('reports a failed connection as network_error', async () => {
    stubFetch(new TypeError('fetch failed'));
    await assert.rejects(apiRequest('/articles'), (error: unknown) => error instanceof ApiError && error.status === 0 && error.code === 'network_error');
  });

  it('notifies the listeners of 503 maintenance and retries once after Retry-After (FE-5, BAK-8)', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const maintenance = json(503, { error: 'maintenance', message: 'Maintenance.' }, { 'retry-after': '10' });
    const { calls } = stubFetch(maintenance, json(200, { ok: true }));
    const seen: number[] = [];
    const stop = onMaintenance((seconds) => seen.push(seconds));
    const pending = apiRequest('/articles');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, [10]);
    assert.equal(calls.length, 1);
    mock.timers.tick(10_000);
    assert.deepEqual(await pending, { ok: true });
    assert.equal(calls.length, 2);
    stop();
  });

  it('gives up after the one retry', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const busy = () => json(503, { error: 'maintenance', message: 'Maintenance.' }, { 'retry-after': '1' });
    const { calls } = stubFetch(busy(), busy());
    const pending = apiRequest('/articles');
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(1000);
    await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.code === 'maintenance');
    assert.equal(calls.length, 2);
  });

  it('does not retry other 503 responses', async () => {
    const { calls } = stubFetch(json(503, { error: 'unavailable', message: 'Down.' }));
    await assert.rejects(apiFetch('/health'), (error: unknown) => error instanceof ApiError && error.code === 'unavailable');
    assert.equal(calls.length, 1);
  });
});

describe('client helpers', () => {
  it('reads error bodies defensively', () => {
    const error = apiErrorFrom(500, 'not json');
    assert.equal(error.code, 'internal');
    assert.equal(error.message, 'Request failed with status 500');
    assert.deepEqual(error.fields, []);
  });

  it('bounds Retry-After', () => {
    assert.equal(retryAfterSeconds(null), 10);
    assert.equal(retryAfterSeconds('soon'), 10);
    assert.equal(retryAfterSeconds('0'), 1);
    assert.equal(retryAfterSeconds('2.5'), 3);
    assert.equal(retryAfterSeconds('3600'), 60);
  });

  it('reads the attachment name', () => {
    assert.equal(attachmentName(new Response('', { headers: { 'content-disposition': 'attachment; filename="a.zip"' } }), 'b.zip'), 'a.zip');
    assert.equal(attachmentName(new Response(''), 'b.zip'), 'b.zip');
  });
});
