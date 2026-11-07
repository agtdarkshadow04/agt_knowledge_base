// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const localAuth = vi.hoisted(() => ({ verifyLocalToken: vi.fn() }));
vi.mock('./local-auth.js', () => localAuth);

import { authenticate, requireActor, requireAdminSession, toActor } from './auth.js';
import type { Actor } from './domain.js';
import {
  parseAdminAccountPassword,
  parseAdminSetup,
  parseAdminUserCreate,
  parseAdminUserUpdate,
  parseApplicationSettingsWrite,
  parseArticleWrite,
  parseCredentials,
  parseListQuery,
  parseTagWrite,
  parseVerificationWrite,
} from './validation.js';

const tagId = '10000000-0000-4000-8000-000000000001';

describe('authentication and validation', () => {
  it('resolves a bearer token to the current user without exposing the session version', async () => {
    localAuth.verifyLocalToken.mockResolvedValueOnce({
      sub: '00000000-0000-4000-8000-000000000001',
      username: 'traveller',
      displayName: 'Traveller',
      role: 'Moderator',
      sessionVersion: 3,
    });
    const user = await authenticate('token');
    expect(localAuth.verifyLocalToken).toHaveBeenCalledWith('token');
    expect(user).toEqual({
      sub: '00000000-0000-4000-8000-000000000001',
      username: 'traveller',
      displayName: 'Traveller',
      email: undefined,
      role: 'Moderator',
    });
    expect(toActor(user)).toEqual({
      sub: '00000000-0000-4000-8000-000000000001',
      role: 'Moderator',
      displayName: 'Traveller',
      email: undefined,
    });
  });

  it('rejects tokens the local session verifier rejects', async () => {
    localAuth.verifyLocalToken.mockRejectedValueOnce(new Error('Invalid session token.'));
    await expect(authenticate('forged')).rejects.toThrow('Invalid session token.');
  });

  it('requires a signed-in actor, and an Admin session on admin routes', () => {
    const editor: Actor = { sub: 'editor-sub', role: 'Editor', displayName: 'Editor' };
    expect(() => requireActor({ actor: null })).toThrow(expect.objectContaining({ statusCode: 401 }));
    expect(requireActor({ actor: editor })).toBe(editor);
    expect(() => requireAdminSession({ admin: null })).toThrow(expect.objectContaining({ statusCode: 401 }));
    expect(() => requireAdminSession({})).toThrow(expect.objectContaining({ statusCode: 401 }));
    expect(requireAdminSession({ admin: { username: 'atlas' } })).toEqual({ username: 'atlas' });
  });

  it('accepts only the Editor and Moderator member roles for user management', () => {
    const user = { username: 'apollo', displayName: 'Apollo', password: 'Permanent123!' };
    expect(parseAdminUserCreate({ ...user, role: 'Editor' })).toMatchObject({ role: 'Editor' });
    expect(parseAdminUserCreate({ ...user, role: 'Moderator' })).toMatchObject({ role: 'Moderator' });
    for (const role of ['Admin', 'Standard', 'SuperAdmin']) {
      expect(() => parseAdminUserCreate({ ...user, role })).toThrow();
      expect(() => parseAdminUserUpdate({ username: 'apollo', displayName: 'Apollo', role, isActive: true })).toThrow();
    }
    expect(() => parseAdminUserCreate({ ...user, role: 'Editor', isSuperAdmin: true })).toThrow();
  });

  it('validates Admin setup, sign-in, and password-change requests', () => {
    expect(parseAdminSetup({ setupPassword: 'one-time', username: 'Atlas', password: 'Permanent123!', passwordConfirmation: 'Permanent123!' }))
      .toMatchObject({ username: 'atlas' });
    expect(() => parseAdminSetup({ setupPassword: 'one-time', username: 'atlas', password: 'Permanent123!', passwordConfirmation: 'Other123!' })).toThrow();
    expect(() => parseAdminSetup({ setupPassword: '', username: 'atlas', password: 'Permanent123!', passwordConfirmation: 'Permanent123!' })).toThrow();
    expect(() => parseAdminSetup({ setupPassword: 'x', username: 'atlas', password: 'short', passwordConfirmation: 'short' })).toThrow();
    expect(parseCredentials({ username: 'atlas', password: 'x' })).toEqual({ username: 'atlas', password: 'x' });
    expect(() => parseCredentials({ username: 'atlas' })).toThrow();
    expect(() => parseAdminAccountPassword({ currentPassword: 'old', password: 'Permanent123!', passwordConfirmation: 'Different123!' })).toThrow();
  });

  it('accepts partial settings writes and clears only backup limits with null', () => {
    expect(parseApplicationSettingsWrite({ version: 1, applicationName: 'Archive' })).toEqual({ version: 1, applicationName: 'Archive' });
    expect(parseApplicationSettingsWrite({ version: 1, backupMaxBytes: null })).toEqual({ version: 1, backupMaxBytes: null });
    expect(() => parseApplicationSettingsWrite({ version: 1, backupMaxBytes: 10 })).toThrow();
    expect(() => parseApplicationSettingsWrite({ version: 1, backupMaxUncompressedBytes: 600 * 1024 * 1024 })).toThrow();
    expect(() => parseApplicationSettingsWrite({ version: 1, applicationName: null })).toThrow();
    expect(() => parseApplicationSettingsWrite({ applicationName: 'Archive' })).toThrow();
  });

  it('rejects executable MDX and raw HTML while accepting Markdown', () => {
    expect(parseArticleWrite({ title: 'Safe guide', tagIds: [tagId], content: '# Safe\n\nPlain **Markdown** content.', visibility: 'Public' })).toMatchObject({ visibility: 'Public' });
    expect(parseArticleWrite({ title: 'Private guide', tagIds: [], content: '# Safe\n\nPrivate standard content.', visibility: 1 })).toMatchObject({ visibility: 1 });
    expect(() => parseArticleWrite({ title: 'Private guide', tagIds: [], content: '# Safe\n\nPrivate standard content.', visibility: '1' })).toThrow();
    expect(() => parseArticleWrite({ title: 'Unknown guide', tagIds: [], content: '# Safe\n\nUnknown standard content.', visibility: 6 })).toThrow();
    expect(() => parseArticleWrite({ title: 'Safe guide', tagIds: [], content: '# Safe\n\nPlain **Markdown** content.', visibility: 'private' })).toThrow();
    expect(() => parseArticleWrite({ title: 'Unsafe', tagIds: [], content: 'import Thing from "package"\n\nMore unsafe content.' })).toThrow();
    expect(() => parseArticleWrite({ title: 'Unsafe', tagIds: [], content: '<script>alert(1)</script> with enough content.' })).toThrow();
  });

  it('requires unique UUID tag IDs and canonical tag inputs', () => {
    const input = { title: 'Safe guide', content: '# Safe\n\nPlain **Markdown** content.' };
    expect(parseArticleWrite({ ...input, tagIds: [tagId] })).toMatchObject({ tagIds: [tagId] });
    expect(() => parseArticleWrite({ ...input, tagIds: ['not-a-uuid'] })).toThrow();
    expect(() => parseArticleWrite({ ...input, tagIds: [tagId, tagId] })).toThrow();
    expect(() => parseArticleWrite({ ...input, tagIds: Array.from({ length: 13 }, (_, index) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`) })).toThrow();

    expect(parseTagWrite({ name: 'Portal', color: '#A1B2C3' })).toEqual({ name: 'Portal', color: '#A1B2C3' });
    expect(() => parseTagWrite({ name: 'Portal', color: '#a1b2c3' })).toThrow();
    expect(() => parseTagWrite({ name: ' '.repeat(3), color: '#A1B2C3' })).toThrow();
  });

  it('bounds pagination and only accepts allowlisted sort fields', () => {
    expect(parseListQuery({ visibility: 'internal', pinned: 'pinned', verification: 'verified', sort: 'title', direction: 'asc', page: '2' })).toMatchObject({ visibility: 'internal', pinned: 'pinned', verification: 'verified', sort: 'title', direction: 'asc', page: 2 });
    expect(() => parseListQuery({ visibility: 'private' })).toThrow();
    expect(parseListQuery({ visibility: '5' })).toMatchObject({ visibility: '5' });
    expect(() => parseListQuery({ visibility: '6' })).toThrow();
    expect(() => parseListQuery({ pinned: 'true' })).toThrow();
    expect(() => parseListQuery({ verification: 'true' })).toThrow();
    expect(() => parseListQuery({ sort: 'created_at; DROP TABLE articles' })).toThrow();
    expect(() => parseListQuery({ pageSize: '5000' })).toThrow();
    expect(parseListQuery({ tagId })).toMatchObject({ tagId });
    expect(() => parseListQuery({ tagId: 'portal' })).toThrow();
  });

  it('requires a boolean verification value and positive article version', () => {
    expect(parseVerificationWrite({ isVerified: true, version: 2 })).toEqual({ isVerified: true, version: 2 });
    expect(() => parseVerificationWrite({ isVerified: 'true', version: 2 })).toThrow();
    expect(() => parseVerificationWrite({ isVerified: true, version: 0 })).toThrow();
  });
});
