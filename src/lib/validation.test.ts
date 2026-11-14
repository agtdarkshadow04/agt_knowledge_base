import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseAdminAccountPassword,
  parseAdminSetup,
  parseAdminUserCreate,
  parseAdminUserUpdate,
  parseArticleWrite,
  parseCredentials,
  parseListQuery,
  parseTagWrite,
  parseVerificationWrite,
} from './validation.js';

const tagId = '10000000-0000-4000-8000-000000000001';

describe('request validation', () => {
  it('accepts only the Editor and Moderator member roles for user management', () => {
    const user = { username: 'apollo', displayName: 'Apollo', password: 'Permanent123!' };
    assert.equal(parseAdminUserCreate({ ...user, role: 'Editor' }).role, 'Editor');
    assert.equal(parseAdminUserCreate({ ...user, role: 'Moderator' }).role, 'Moderator');
    for (const role of ['Admin', 'Standard', 'SuperAdmin']) {
      assert.throws(() => parseAdminUserCreate({ ...user, role }));
      assert.throws(() => parseAdminUserUpdate({ username: 'apollo', displayName: 'Apollo', role, isActive: true }));
    }
    assert.throws(() => parseAdminUserCreate({ ...user, role: 'Editor', isSuperAdmin: true }));
  });

  it('validates Admin setup, sign-in, and password-change requests', () => {
    // AUTH-3: trimmed, then stored as entered (no case folding), 1-64 code points.
    assert.equal(parseAdminSetup({ setupPassword: 'one-time', username: ' Atlas Prime ', password: 'Permanent123!', passwordConfirmation: 'Permanent123!' }).username, 'Atlas Prime');
    assert.equal(parseAdminSetup({ setupPassword: 'one-time', username: '\u{1F680}'.repeat(64), password: 'Permanent123!' }).username.length, 128);
    assert.throws(() => parseAdminSetup({ setupPassword: 'one-time', username: '\u{1F680}'.repeat(65), password: 'Permanent123!' }));
    assert.throws(() => parseAdminSetup({ setupPassword: 'one-time', username: '   ', password: 'Permanent123!' }));
    // AUTH-5: the confirmation is optional; when sent it must match.
    assert.equal(parseAdminSetup({ setupPassword: 'one-time', username: 'atlas', password: 'Permanent123!' }).password, 'Permanent123!');
    assert.throws(() => parseAdminSetup({ setupPassword: 'one-time', username: 'atlas', password: 'Permanent123!', passwordConfirmation: 'Other123!' }));
    assert.throws(() => parseAdminSetup({ setupPassword: '', username: 'atlas', password: 'Permanent123!', passwordConfirmation: 'Permanent123!' }));
    assert.throws(() => parseAdminSetup({ setupPassword: 'x', username: 'atlas', password: 'short', passwordConfirmation: 'short' }));
    assert.deepEqual(parseCredentials({ username: 'atlas', password: 'x' }), { username: 'atlas', password: 'x' });
    assert.throws(() => parseCredentials({ username: 'atlas' }));
    assert.throws(() => parseAdminAccountPassword({ currentPassword: 'old', password: 'Permanent123!', passwordConfirmation: 'Different123!' }));
  });

  it('rejects executable MDX and raw HTML while accepting Markdown', () => {
    assert.equal(parseArticleWrite({ title: 'Safe guide', tagIds: [tagId], content: '# Safe\n\nPlain **Markdown** content.', visibility: 'Public' }).visibility, 'Public');
    assert.equal(parseArticleWrite({ title: 'Private guide', tagIds: [], content: '# Safe\n\nPrivate standard content.', visibility: 1 }).visibility, 1);
    assert.throws(() => parseArticleWrite({ title: 'Private guide', tagIds: [], content: '# Safe\n\nPrivate standard content.', visibility: '1' }));
    assert.throws(() => parseArticleWrite({ title: 'Unknown guide', tagIds: [], content: '# Safe\n\nUnknown standard content.', visibility: 6 }));
    assert.throws(() => parseArticleWrite({ title: 'Safe guide', tagIds: [], content: '# Safe\n\nPlain **Markdown** content.', visibility: 'private' }));
    assert.throws(() => parseArticleWrite({ title: 'Unsafe', tagIds: [], content: 'import Thing from "package"\n\nMore unsafe content.' }));
    assert.throws(() => parseArticleWrite({ title: 'Unsafe', tagIds: [], content: '<script>alert(1)</script> with enough content.' }));
  });

  it('requires unique UUID tag IDs and canonical tag inputs', () => {
    const input = { title: 'Safe guide', content: '# Safe\n\nPlain **Markdown** content.' };
    assert.deepEqual(parseArticleWrite({ ...input, tagIds: [tagId] }).tagIds, [tagId]);
    assert.throws(() => parseArticleWrite({ ...input, tagIds: ['not-a-uuid'] }));
    assert.throws(() => parseArticleWrite({ ...input, tagIds: [tagId, tagId] }));
    assert.throws(() => parseArticleWrite({ ...input, tagIds: Array.from({ length: 13 }, (_, index) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`) }));

    assert.deepEqual(parseTagWrite({ name: 'Portal', color: '#A1B2C3' }), { name: 'Portal', color: '#A1B2C3' });
    assert.throws(() => parseTagWrite({ name: 'Portal', color: '#a1b2c3' }));
    assert.throws(() => parseTagWrite({ name: ' '.repeat(3), color: '#A1B2C3' }));
  });

  it('bounds pagination and only accepts allowlisted sort fields', () => {
    assert.partialDeepStrictEqual(parseListQuery({ visibility: 'internal', pinned: 'pinned', verification: 'verified', sort: 'title', direction: 'asc', page: '2' }), { visibility: 'internal', pinned: 'pinned', verification: 'verified', sort: 'title', direction: 'asc', page: 2 });
    assert.throws(() => parseListQuery({ visibility: 'private' }));
    assert.equal(parseListQuery({ visibility: '5' }).visibility, '5');
    assert.throws(() => parseListQuery({ visibility: '6' }));
    assert.throws(() => parseListQuery({ pinned: 'true' }));
    assert.throws(() => parseListQuery({ verification: 'true' }));
    assert.throws(() => parseListQuery({ sort: 'created_at; DROP TABLE articles' }));
    assert.throws(() => parseListQuery({ pageSize: '5000' }));
    assert.equal(parseListQuery({ tagId }).tagId, tagId);
    assert.throws(() => parseListQuery({ tagId: 'portal' }));
  });

  it('requires a boolean verification value and positive article version', () => {
    assert.deepEqual(parseVerificationWrite({ isVerified: true, version: 2 }), { isVerified: true, version: 2 });
    assert.throws(() => parseVerificationWrite({ isVerified: 'true', version: 2 }));
    assert.throws(() => parseVerificationWrite({ isVerified: true, version: 0 }));
  });
});
