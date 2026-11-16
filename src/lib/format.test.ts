import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatBytes, formatDate, formatDateTime, formatNumber, isTimeZoneSetting, offsetLabel, TIME_ZONE_OFFSETS } from './format.js';

const moment = '2026-01-02T03:04:00.000Z';

describe('Intl formatting (I18N-5)', () => {
  it('formats dates and times in the chosen language and fixed offset, naming the offset', () => {
    assert.match(formatDateTime(moment, { tag: 'en', timeZone: '+00:00' }), /Jan 2, 2026.*03:04.*GMT/);
    assert.match(formatDateTime(moment, { tag: 'en', timeZone: '+05:30' }), /08:34.*GMT\+5:30/);
    assert.match(formatDateTime(moment, { tag: 'de', timeZone: '-03:00' }), /2026.*00:04.*GMT-3/);
    assert.match(formatDate(moment, { tag: 'pt-BR', timeZone: '+00:00' }), /2 de jan\.? de 2026/);
    assert.match(formatDate(moment, { tag: 'ja', timeZone: '+00:00' }), /2026\/01\/02/);
  });

  it('shows an unparseable value as it is', () => {
    assert.equal(formatDateTime('soon', { tag: 'en', timeZone: 'auto' }), 'soon');
    assert.equal(formatDate('soon', { tag: 'en', timeZone: 'auto' }), 'soon');
  });

  it('formats numbers and byte counts with the locale\'s separators', () => {
    assert.equal(formatNumber(1234567, { tag: 'en' }), '1,234,567');
    assert.equal(formatNumber(1234567, { tag: 'de' }), '1.234.567');
    assert.equal(formatBytes(512, { tag: 'en' }), '512 byte');
    assert.equal(formatBytes(1_500_000, { tag: 'en' }), '1.5 MB');
  });

  it('accepts only auto and the listed offsets', () => {
    assert.equal(isTimeZoneSetting('auto'), true);
    for (const offset of TIME_ZONE_OFFSETS) assert.equal(isTimeZoneSetting(offset), true);
    for (const value of ['UTC', '+5:30', 'Europe/Paris', 3, null]) assert.equal(isTimeZoneSetting(value), false);
    assert.equal(offsetLabel('-03:30'), 'UTC−03:30');
  });
});
