import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stringToPastelHex } from './tags.js';

describe('tag colours', () => {
  it('generates a stable pastel color from the tag name', () => {
    assert.equal(stringToPastelHex('portal'), '#b5c3b7');
    assert.equal(stringToPastelHex('guide'), '#fd9cf0');
    assert.notEqual(stringToPastelHex('portal'), stringToPastelHex('guide'));
  });
});
