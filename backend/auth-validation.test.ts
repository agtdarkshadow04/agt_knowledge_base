// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { roleFromClaims } from './auth.js';
import { parseArticleWrite, parseListQuery, parseTagWrite, parseVerificationWrite } from './validation.js';

const tagId = '10000000-0000-4000-8000-000000000001';

describe('authentication and validation', () => {
  it('recognizes Admin group claims and defaults authenticated users to Standard', () => {
    expect(roleFromClaims({ 'cognito:groups': ['Standard', 'Admin'] })).toBe('Admin');
    expect(roleFromClaims({ role: 'Admin' })).toBe('Admin');
    expect(roleFromClaims({ 'cognito:groups': '["Standard"]' })).toBe('Standard');
    expect(roleFromClaims({})).toBe('Standard');
  });

  it('rejects executable MDX and raw HTML while accepting Markdown', () => {
    expect(parseArticleWrite({ title: 'Safe guide', tagIds: [tagId], content: '# Safe\n\nPlain **Markdown** content.', visibility: 'Public' })).toMatchObject({ visibility: 'Public' });
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
