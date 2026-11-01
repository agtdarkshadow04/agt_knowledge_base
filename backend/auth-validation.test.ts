// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const localAuth = vi.hoisted(() => ({ verifyLocalToken: vi.fn() }));
vi.mock('./local-auth.js', () => localAuth);

import { authenticate, requireActor, requireAdmin, toActor } from './auth.js';
import type { Actor } from './domain.js';
import { parseArticleWrite, parseListQuery, parseTagWrite, parseVerificationWrite } from './validation.js';

const tagId = '10000000-0000-4000-8000-000000000001';

describe('authentication and validation', () => {
  it('resolves a bearer token to the current user without exposing the session version', async () => {
    localAuth.verifyLocalToken.mockResolvedValueOnce({
      sub: '00000000-0000-4000-8000-000000000001',
      username: 'traveller',
      displayName: 'Traveller',
      role: 'Admin',
      isSuperAdmin: false,
      sessionVersion: 3,
    });
    const user = await authenticate('token');
    expect(localAuth.verifyLocalToken).toHaveBeenCalledWith('token');
    expect(user).toEqual({
      sub: '00000000-0000-4000-8000-000000000001',
      username: 'traveller',
      displayName: 'Traveller',
      email: undefined,
      role: 'Admin',
      isSuperAdmin: false,
    });
    expect(toActor(user)).toEqual({
      sub: '00000000-0000-4000-8000-000000000001',
      role: 'Admin',
      displayName: 'Traveller',
      email: undefined,
    });
  });

  it('rejects tokens the local session verifier rejects', async () => {
    localAuth.verifyLocalToken.mockRejectedValueOnce(new Error('Invalid session token.'));
    await expect(authenticate('forged')).rejects.toThrow('Invalid session token.');
  });

  it('requires a signed-in actor and an Admin role where requested', () => {
    const standard: Actor = { sub: 'standard-sub', role: 'Standard', displayName: 'Standard' };
    const admin: Actor = { sub: 'admin-sub', role: 'Admin', displayName: 'Admin' };
    expect(() => requireActor({ actor: null })).toThrow(expect.objectContaining({ statusCode: 401 }));
    expect(requireActor({ actor: standard })).toBe(standard);
    expect(() => requireAdmin({ actor: null })).toThrow(expect.objectContaining({ statusCode: 401 }));
    expect(() => requireAdmin({ actor: standard })).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(requireAdmin({ actor: admin })).toBe(admin);
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
