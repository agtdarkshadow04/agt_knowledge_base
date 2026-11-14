import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffLines, maxDiffLines } from '../line-diff.js';

describe('line diff', () => {
  it('marks removed, added, and unchanged lines', () => {
    assert.deepEqual(diffLines('server:\n  port: 3001\nsite: {}\n', 'server:\n  port: 4000\nsite: {}\n'), [
      { kind: ' ', text: 'server:' },
      { kind: '-', text: '  port: 3001' },
      { kind: '+', text: '  port: 4000' },
      { kind: ' ', text: 'site: {}' },
    ]);
  });

  it('handles empty inputs and Windows line endings', () => {
    assert.deepEqual(diffLines('', 'a\r\n'), [{ kind: '+', text: 'a' }]);
    assert.deepEqual(diffLines('a\n', ''), [{ kind: '-', text: 'a' }]);
    assert.equal(diffLines('a\r\nb\r\n', 'a\nb\n')?.every((line) => line.kind === ' '), true);
  });

  it('declines to diff very long files', () => {
    assert.equal(diffLines('x\n'.repeat(maxDiffLines + 1), 'y'), null);
  });
});
