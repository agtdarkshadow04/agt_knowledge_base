import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyPreferences, defaultPreferences, migrateLegacyPreferences, readPreferences, writePreference } from './preferences.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('preferences', () => {
  it('gives the defaults without storage, with invalid JSON and with unknown values (FE-3)', () => {
    assert.deepEqual(readPreferences(null), defaultPreferences);
    const storage = memoryStorage({
      agt_knowledge_base_search_results: '{not json',
      agt_knowledge_base_allow_downloads: '"yes"',
      agt_knowledge_base_font_scale: '"3"',
    });
    assert.deepEqual(readPreferences(storage), defaultPreferences);
    const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    assert.deepEqual(readPreferences(throwing), defaultPreferences);
    assert.doesNotThrow(() => writePreference('fontScale', '2', throwing));
    assert.doesNotThrow(() => migrateLegacyPreferences(throwing));
  });

  it('stores each preference as JSON under an agt_knowledge_base_ key (NAME-2)', () => {
    const storage = memoryStorage();
    writePreference('searchResults', 'rows', storage);
    writePreference('allowDownloads', true, storage);
    writePreference('fontScale', '1.5', storage);
    assert.deepEqual(Object.fromEntries(storage.values), {
      agt_knowledge_base_search_results: '"rows"',
      agt_knowledge_base_allow_downloads: 'true',
      agt_knowledge_base_font_scale: '"1.5"',
    });
    assert.deepEqual(readPreferences(storage), { searchResults: 'rows', allowDownloads: true, fontScale: '1.5' });
  });

  it('moves the 1.x agt-* keys to the new keys once and deletes them', () => {
    const storage = memoryStorage({
      'agt-search-results': 'rows',
      'agt-allow-downloads': 'true',
      'agt-font-size': 'extra-large',
      'agt-ui-scale': '0.50',
      'agt-local-auth-token': 'old-token',
    });
    migrateLegacyPreferences(storage);
    assert.deepEqual(Object.fromEntries(storage.values), {
      agt_knowledge_base_search_results: '"rows"',
      agt_knowledge_base_allow_downloads: 'true',
      agt_knowledge_base_font_scale: '"1.25"',
    });
  });

  it('keeps preferences already stored under the new keys', () => {
    const storage = memoryStorage({ 'agt-search-results': 'rows', agt_knowledge_base_search_results: '"cards"' });
    migrateLegacyPreferences(storage);
    assert.equal(readPreferences(storage).searchResults, 'cards');
    assert.equal(storage.values.has('agt-search-results'), false);
  });

  it('applies the page-wide preferences as data attributes', () => {
    const root = { dataset: {} as Record<string, string | undefined> };
    applyPreferences(root, { searchResults: 'rows', allowDownloads: false, fontScale: '2' });
    assert.deepEqual(root.dataset, { searchResults: 'rows', fontScale: '2' });
  });
});
