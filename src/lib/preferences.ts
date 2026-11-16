/**
 * User preferences in `localStorage` (FE-3): only preferences, never API data,
 * under `agt_knowledge_base_*` keys (NAME-2), stored as JSON and read
 * defensively, so a missing, invalid or blocked store gives the defaults.
 */

export const storagePrefix = 'agt_knowledge_base_';

/** The font scale (A11Y-6): every size is in `rem`, so this scales all text. */
export const fontScales = ['1', '1.25', '1.5', '1.75', '2'] as const;
export const searchResultsViews = ['cards', 'rows'] as const;

export type FontScale = typeof fontScales[number];
export type SearchResultsView = typeof searchResultsViews[number];

export interface Preferences {
  searchResults: SearchResultsView;
  /** Whether the article page offers the PDF and Markdown downloads (members only). */
  allowDownloads: boolean;
  fontScale: FontScale;
}

export const defaultPreferences: Preferences = { searchResults: 'cards', allowDownloads: false, fontScale: '1' };

/** Sent on `window` when a preference changes, so open pages can follow it. */
export const preferencesChangedEvent = 'agt_knowledge_base_preferences_changed';

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `localStorage`, or null where it is missing or access throws (private modes, blocked storage). */
export function browserStorage(): KeyValueStore | null {
  try {
    return (globalThis as { localStorage?: KeyValueStore }).localStorage ?? null;
  } catch {
    return null;
  }
}

function readJson(storage: KeyValueStore | null, name: string): unknown {
  try {
    const text = storage?.getItem(storagePrefix + name);
    return text == null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return values.includes(value as T) ? value as T : fallback;
}

export function readPreferences(storage = browserStorage()): Preferences {
  const allowDownloads = readJson(storage, 'allow_downloads');
  return {
    searchResults: oneOf(searchResultsViews, readJson(storage, 'search_results'), defaultPreferences.searchResults),
    allowDownloads: typeof allowDownloads === 'boolean' ? allowDownloads : defaultPreferences.allowDownloads,
    fontScale: oneOf(fontScales, readJson(storage, 'font_scale'), defaultPreferences.fontScale),
  };
}

const keys: Record<keyof Preferences, string> = { searchResults: 'search_results', allowDownloads: 'allow_downloads', fontScale: 'font_scale' };

/** Stores one preference; a store that refuses the write only loses the preference. */
export function writePreference<K extends keyof Preferences>(name: K, value: Preferences[K], storage = browserStorage()) {
  try {
    storage?.setItem(storagePrefix + keys[name], JSON.stringify(value));
  } catch {
    // Storage full or blocked: the preference applies until the page is reloaded.
  }
}

/** The 1.x keys: their values move to the new keys once, then they are deleted. */
const legacyKeys = ['agt-search-results', 'agt-allow-downloads', 'agt-font-size', 'agt-ui-scale', 'agt-local-auth-token'];
const legacyFontScales: Record<string, FontScale> = { large: '1.25', 'extra-large': '1.25' };

export function migrateLegacyPreferences(storage = browserStorage()) {
  if (!storage) return;
  try {
    const searchResults = storage.getItem('agt-search-results');
    if (searchResults && readJson(storage, 'search_results') === undefined && searchViewsInclude(searchResults)) {
      writePreference('searchResults', searchResults, storage);
    }
    const allowDownloads = storage.getItem('agt-allow-downloads');
    if (allowDownloads && readJson(storage, 'allow_downloads') === undefined) writePreference('allowDownloads', allowDownloads === 'true', storage);
    const fontScale = legacyFontScales[storage.getItem('agt-font-size') ?? ''];
    if (fontScale && readJson(storage, 'font_scale') === undefined) writePreference('fontScale', fontScale, storage);
    for (const key of legacyKeys) storage.removeItem(key);
  } catch {
    // Blocked storage: nothing to migrate.
  }
}

function searchViewsInclude(value: string): value is SearchResultsView {
  return (searchResultsViews as readonly string[]).includes(value);
}

/** Applies the preferences that change the whole page, as `data-*` attributes on `<html>`. */
export function applyPreferences(root: { dataset: Record<string, string | undefined> }, preferences: Preferences) {
  root.dataset.searchResults = preferences.searchResults;
  root.dataset.fontScale = preferences.fontScale;
}
