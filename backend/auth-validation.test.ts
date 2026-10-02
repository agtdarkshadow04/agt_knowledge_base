// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { roleFromClaims } from './auth.js';
import { parseArticleWrite, parseListQuery } from './validation.js';

describe('authentication and validation', () => {
  it('recognizes Admin group claims and defaults authenticated users to Standard', () => {
    expect(roleFromClaims({ 'cognito:groups': ['Standard', 'Admin'] })).toBe('Admin');
    expect(roleFromClaims({ 'cognito:groups': '["Standard"]' })).toBe('Standard');
    expect(roleFromClaims({})).toBe('Standard');
  });

  it('rejects executable MDX and raw HTML while accepting Markdown', () => {
    expect(() => parseArticleWrite({ title: 'Safe guide', tags: ['Guide'], content: '# Safe\n\nPlain **Markdown** content.' })).not.toThrow();
    expect(() => parseArticleWrite({ title: 'Unsafe', tags: [], content: 'import Thing from "package"\n\nMore unsafe content.' })).toThrow();
    expect(() => parseArticleWrite({ title: 'Unsafe', tags: [], content: '<script>alert(1)</script> with enough content.' })).toThrow();
  });

  it('bounds pagination and only accepts allowlisted sort fields', () => {
    expect(parseListQuery({ pinned: 'pinned', sort: 'title', direction: 'asc', page: '2' })).toMatchObject({ pinned: 'pinned', sort: 'title', direction: 'asc', page: 2 });
    expect(() => parseListQuery({ pinned: 'true' })).toThrow();
    expect(() => parseListQuery({ sort: 'created_at; DROP TABLE articles' })).toThrow();
    expect(() => parseListQuery({ pageSize: '5000' })).toThrow();
  });
});
