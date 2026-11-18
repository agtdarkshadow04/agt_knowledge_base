import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSecurityLevel, securityLevelAllows, securityLevels, visibilityLevel } from './api.js';
import { agtVisibilityOptions, assignableOptions, initialVisibility, legacyVisibilityOptions } from './visibility.js';

describe('security levels (#70)', () => {
  it('maps every visibility to the security level that reads it', () => {
    for (const option of agtVisibilityOptions) assert.equal(visibilityLevel(option.value), option.value);
    assert.deepEqual(legacyVisibilityOptions.map((option) => visibilityLevel(option.value)), [0, 1, 5]);
  });

  it('reads hierarchically: level N reads every level up to N', () => {
    for (const level of securityLevels) {
      for (const option of agtVisibilityOptions) assert.equal(securityLevelAllows(level, option.value), option.value <= level);
    }
    assert.equal(securityLevelAllows(4, 'Admin'), false);
    assert.equal(securityLevelAllows(5, 'Admin'), true);
    assert.equal(securityLevelAllows(0, 'Internal'), false);
  });

  it('offers only the levels a member may assign, and a default they may use', () => {
    assert.deepEqual(assignableOptions(agtVisibilityOptions, 2).map((option) => option.value), [0, 1, 2]);
    assert.deepEqual(assignableOptions(legacyVisibilityOptions, 2).map((option) => option.value), ['Public', 'Internal']);
    assert.deepEqual(assignableOptions(legacyVisibilityOptions, 5).map((option) => option.value), ['Public', 'Internal', 'Admin']);
    assert.equal(initialVisibility('Internal', 1), 'Internal');
    assert.equal(initialVisibility('Internal', 0), 0);
    assert.equal(initialVisibility(3, 2), 2);
  });

  it('accepts only the integers 0-5 as security levels', () => {
    for (const level of securityLevels) assert.equal(isSecurityLevel(level), true);
    for (const value of [-1, 6, 1.5, '1', null, undefined]) assert.equal(isSecurityLevel(value), false, String(value));
  });
});
