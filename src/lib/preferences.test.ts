import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultPreferences, migrateLegacyPreferences, readPreferences, settingsKey, writePreference } from './preferences.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('preferences (FE-3, I18N-4)', () => {
  it('gives the defaults without storage, with invalid JSON and with unknown values', () => {
    assert.deepEqual(readPreferences(null), defaultPreferences);
    assert.deepEqual(defaultPreferences, { language: 'en', fontScale: '1', timeZone: 'auto', searchResults: 'cards', allowDownloads: false });
    assert.deepEqual(readPreferences(memoryStorage({ [settingsKey]: '{not json' })), defaultPreferences);
    assert.deepEqual(readPreferences(memoryStorage({ [settingsKey]: '[1,2]' })), defaultPreferences);
    const odd = memoryStorage({ [settingsKey]: JSON.stringify({ language: 'xx', fontScale: '3', timeZone: 'Mars/Olympus', searchResults: 'grid', allowDownloads: 'yes' }) });
    assert.deepEqual(readPreferences(odd), defaultPreferences);
    const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    assert.deepEqual(readPreferences(throwing), defaultPreferences);
    assert.doesNotThrow(() => writePreference('fontScale', '2', throwing));
    assert.doesNotThrow(() => migrateLegacyPreferences(throwing));
  });

  it('keeps the valid fields of a partly invalid object', () => {
    const storage = memoryStorage({ [settingsKey]: JSON.stringify({ language: 'ja', fontScale: 'huge' }) });
    assert.deepEqual(readPreferences(storage), { ...defaultPreferences, language: 'ja' });
  });

  it('stores every preference in one agt_knowledge_base_settings object (NAME-2)', () => {
    const storage = memoryStorage();
    writePreference('language', 'pt', storage);
    writePreference('timeZone', '+05:30', storage);
    writePreference('fontScale', '1.5', storage);
    writePreference('searchResults', 'rows', storage);
    writePreference('allowDownloads', true, storage);
    assert.deepEqual([...storage.values.keys()], [settingsKey]);
    assert.deepEqual(JSON.parse(storage.values.get(settingsKey)!), { language: 'pt', fontScale: '1.5', timeZone: '+05:30', searchResults: 'rows', allowDownloads: true });
    assert.deepEqual(readPreferences(storage), { language: 'pt', fontScale: '1.5', timeZone: '+05:30', searchResults: 'rows', allowDownloads: true });
  });

  it('moves the 1.x agt-* keys into the settings object once and deletes them', () => {
    const storage = memoryStorage({
      'agt-search-results': 'rows',
      'agt-allow-downloads': 'true',
      'agt-font-size': 'extra-large',
      'agt-ui-scale': '0.50',
      'agt-local-auth-token': 'old-token',
    });
    migrateLegacyPreferences(storage);
    assert.deepEqual([...storage.values.keys()], [settingsKey]);
    assert.deepEqual(readPreferences(storage), { ...defaultPreferences, searchResults: 'rows', allowDownloads: true, fontScale: '1.25' });
  });

  it('keeps preferences already stored in the settings object', () => {
    const storage = memoryStorage({ 'agt-search-results': 'rows', [settingsKey]: JSON.stringify({ searchResults: 'cards' }) });
    migrateLegacyPreferences(storage);
    assert.equal(readPreferences(storage).searchResults, 'cards');
    assert.equal(storage.values.has('agt-search-results'), false);
  });
});
