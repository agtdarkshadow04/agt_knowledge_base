import { isLocale, type Locale } from '../translations.js';
import { isTimeZoneSetting, type TimeZoneSetting } from './format.js';

/**
 * User preferences (FE-3, I18N-4): one JSON object in
 * `localStorage["agt_knowledge_base_settings"]`, shared by the public UI and the
 * admin dashboard. Only preferences, never API data; read defensively, so a
 * missing, invalid or blocked store gives the defaults field by field.
 */

export const settingsKey = 'agt_knowledge_base_settings';

/** The font scale (A11Y-6): every size is in `rem`, so this scales all text. */
export const fontScales = ['1', '1.25', '1.5', '1.75', '2'] as const;
export const searchResultsViews = ['cards', 'rows'] as const;

export type FontScale = typeof fontScales[number];
export type SearchResultsView = typeof searchResultsViews[number];

export interface Preferences {
  /** I18N-1; English unless the reader chooses another (no auto-detection, I18N-4). */
  language: Locale;
  fontScale: FontScale;
  /** `auto` (the browser's zone) or a fixed UTC offset such as `+05:30` (I18N-4, I18N-5). */
  timeZone: TimeZoneSetting;
  searchResults: SearchResultsView;
  /** Whether the article page offers the PDF and Markdown downloads (members only). */
  allowDownloads: boolean;
}

export const defaultPreferences: Preferences = { language: 'en', fontScale: '1', timeZone: 'auto', searchResults: 'cards', allowDownloads: false };

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

function readStored(storage: KeyValueStore | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(settingsKey) ?? 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return values.includes(value as T) ? value as T : fallback;
}

export function readPreferences(storage = browserStorage()): Preferences {
  const stored = readStored(storage);
  return {
    language: isLocale(stored.language) ? stored.language : defaultPreferences.language,
    fontScale: oneOf(fontScales, stored.fontScale, defaultPreferences.fontScale),
    timeZone: isTimeZoneSetting(stored.timeZone) ? stored.timeZone : defaultPreferences.timeZone,
    searchResults: oneOf(searchResultsViews, stored.searchResults, defaultPreferences.searchResults),
    allowDownloads: typeof stored.allowDownloads === 'boolean' ? stored.allowDownloads : defaultPreferences.allowDownloads,
  };
}

/** Stores one preference; a store that refuses the write only loses the preference. */
export function writePreference<K extends keyof Preferences>(name: K, value: Preferences[K], storage = browserStorage()) {
  try {
    storage?.setItem(settingsKey, JSON.stringify({ ...readPreferences(storage), [name]: value }));
  } catch {
    // Storage full or blocked: the preference applies until the page is reloaded.
  }
}

/** The 1.x keys: their values move into the settings object once, then they are deleted. */
const legacyKeys = ['agt-search-results', 'agt-allow-downloads', 'agt-font-size', 'agt-ui-scale', 'agt-local-auth-token'];
const legacyFontScales: Record<string, FontScale> = { large: '1.25', 'extra-large': '1.25' };

export function migrateLegacyPreferences(storage = browserStorage()) {
  if (!storage) return;
  try {
    if (!legacyKeys.some((key) => storage.getItem(key) !== null)) return;
    const stored = readStored(storage);
    const searchResults = storage.getItem('agt-search-results');
    if (stored.searchResults === undefined && (searchResultsViews as readonly string[]).includes(searchResults ?? '')) {
      writePreference('searchResults', searchResults as SearchResultsView, storage);
    }
    const allowDownloads = storage.getItem('agt-allow-downloads');
    if (stored.allowDownloads === undefined && allowDownloads !== null) writePreference('allowDownloads', allowDownloads === 'true', storage);
    const fontScale = legacyFontScales[storage.getItem('agt-font-size') ?? ''];
    if (stored.fontScale === undefined && fontScale) writePreference('fontScale', fontScale, storage);
    for (const key of legacyKeys) storage.removeItem(key);
  } catch {
    // Blocked storage: nothing to migrate.
  }
}
