// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { diffLines, maxDiffLines } from './line-diff.js';

describe('line diff', () => {
  it('marks removed, added, and unchanged lines', () => {
    expect(diffLines('server:\n  port: 3001\nsite: {}\n', 'server:\n  port: 4000\nsite: {}\n')).toEqual([
      { kind: ' ', text: 'server:' },
      { kind: '-', text: '  port: 3001' },
      { kind: '+', text: '  port: 4000' },
      { kind: ' ', text: 'site: {}' },
    ]);
  });

  it('handles empty inputs and Windows line endings', () => {
    expect(diffLines('', 'a\r\n')).toEqual([{ kind: '+', text: 'a' }]);
    expect(diffLines('a\n', '')).toEqual([{ kind: '-', text: 'a' }]);
    expect(diffLines('a\r\nb\r\n', 'a\nb\n')?.every((line) => line.kind === ' ')).toBe(true);
  });

  it('declines to diff very long files', () => {
    expect(diffLines('x\n'.repeat(maxDiffLines + 1), 'y')).toBeNull();
  });
});
