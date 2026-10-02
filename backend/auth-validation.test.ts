// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { roleFromClaims } from './auth.js';
import { parseArticleWrite, parseListQuery, parseVerificationWrite } from './validation.js';

describe('authentication and validation', () => {
  it('recognizes Admin group claims and defaults authenticated users to Standard', () => {
    expect(roleFromClaims({ 'cognito:groups': ['Standard', 'Admin'] })).toBe('Admin');
    expect(roleFromClaims({ 'cognito:groups': '["Standard"]' })).toBe('Standard');
    expect(roleFromClaims({})).toBe('Standard');
  });

  it('rejects executable MDX and raw HTML while accepting Markdown', () => {
    expect(parseArticleWrite({ title: 'Safe guide', tags: ['Guide'], content: '# Safe\n\nPlain **Markdown** content.', visibility: 'Public' })).toMatchObject({ visibility: 'Public' });
    expect(() => parseArticleWrite({ title: 'Safe guide', tags: [], content: '# Safe\n\nPlain **Markdown** content.', visibility: 'private' })).toThrow();
    expect(() => parseArticleWrite({ title: 'Unsafe', tags: [], content: 'import Thing from "package"\n\nMore unsafe content.' })).toThrow();
    expect(() => parseArticleWrite({ title: 'Unsafe', tags: [], content: '<script>alert(1)</script> with enough content.' })).toThrow();
  });

  it('bounds pagination and only accepts allowlisted sort fields', () => {
    expect(parseListQuery({ visibility: 'internal', pinned: 'pinned', verification: 'verified', sort: 'title', direction: 'asc', page: '2' })).toMatchObject({ visibility: 'internal', pinned: 'pinned', verification: 'verified', sort: 'title', direction: 'asc', page: 2 });
    expect(() => parseListQuery({ visibility: 'private' })).toThrow();
    expect(() => parseListQuery({ pinned: 'true' })).toThrow();
    expect(() => parseListQuery({ verification: 'true' })).toThrow();
    expect(() => parseListQuery({ sort: 'created_at; DROP TABLE articles' })).toThrow();
    expect(() => parseListQuery({ pageSize: '5000' })).toThrow();
  });

  it('requires a boolean verification value and positive article version', () => {
    expect(parseVerificationWrite({ isVerified: true, version: 2 })).toEqual({ isVerified: true, version: 2 });
    expect(() => parseVerificationWrite({ isVerified: 'true', version: 2 })).toThrow();
    expect(() => parseVerificationWrite({ isVerified: true, version: 0 })).toThrow();
  });
});
