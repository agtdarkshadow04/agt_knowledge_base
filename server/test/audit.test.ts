import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { auditOutcome, writeSummary } from '../audit.js';

describe('audit helpers (LOG-10, LOG-14)', () => {
  it('maps statuses to outcomes', () => {
    assert.deepEqual([200, 204, 302, 401, 403, 429, 400, 404, 409, 500, 503].map(auditOutcome), [
      'success', 'success', 'success', 'denied', 'denied', 'rate_limited', 'failure', 'failure', 'failure', 'failure', 'failure',
    ]);
  });

  it('summarizes a write by its name and field names, never values, and takes the created id', () => {
    assert.deepEqual(writeSummary(
      { title: 'Portal Guide', content: 'Long Markdown body', tagIds: [], password: 'secret' },
      { id: '10000000-0000-4000-8000-000000000001', title: 'Portal Guide' },
    ), {
      targetId: '10000000-0000-4000-8000-000000000001',
      details: { fields: ['content', 'password', 'tagIds', 'title'], title: 'Portal Guide' },
    });
    assert.deepEqual(writeSummary({ username: 'apollo', displayName: 'Apollo' }, undefined).details, { fields: ['displayName', 'username'], username: 'apollo' });
    assert.deepEqual(writeSummary(undefined, undefined), {});
    assert.equal(writeSummary({ title: 'x'.repeat(500) }, undefined).details!.title, 'x'.repeat(200));
  });
});
