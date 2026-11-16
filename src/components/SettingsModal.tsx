import { useId, useState } from 'react';
import type { SessionUser } from '../lib/api';
import { offsetLabel, TIME_ZONE_OFFSETS, type TimeZoneSetting } from '../lib/format';
import {
  fontScales,
  preferencesChangedEvent,
  readPreferences,
  type FontScale,
  type Preferences,
  type SearchResultsView,
  writePreference,
} from '../lib/preferences';
import { formatTranslation, LOCALES, type Locale } from '../translations';
import { Dialog } from './Dialog';
import { useI18n } from './I18n';

/** Stores one preference and tells the open pages (both entries share them, I18N-4). */
export function changePreference<K extends keyof Preferences>(name: K, value: Preferences[K]) {
  writePreference(name, value);
  window.dispatchEvent(new Event(preferencesChangedEvent));
}

/** The language, time zone and text size controls, shared with the admin dashboard's settings (I18N-4, A11Y-6). */
export function DisplaySettings({ preferences, onChange }: {
  preferences: Preferences;
  onChange<K extends keyof Preferences>(name: K, value: Preferences[K]): void;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="settings-controls">
      <label className="field">
        <span>{t.settings.language}</span>
        <select value={preferences.language} onChange={(event) => onChange('language', event.target.value as Locale)}>
          {LOCALES.map((locale) => <option key={locale.value} value={locale.value} lang={locale.tag}>{locale.flag} {locale.label}</option>)}
        </select>
      </label>
      <label className="field">
        <span>{t.settings.timeZone}</span>
        <select value={preferences.timeZone} onChange={(event) => onChange('timeZone', event.target.value as TimeZoneSetting)}>
          <option value="auto">{t.settings.timeZoneAuto}</option>
          {TIME_ZONE_OFFSETS.map((offset) => <option key={offset} value={offset}>{offsetLabel(offset)}</option>)}
        </select>
      </label>
      <label className="field">
        <span>{t.settings.textSize}</span>
        <select value={preferences.fontScale} onChange={(event) => onChange('fontScale', event.target.value as FontScale)} aria-describedby={`${id}-scale-help`}>
          {fontScales.map((scale) => (
            <option key={scale} value={scale}>{scale === '1' ? formatTranslation(t.settings.textSizeDefault, { scale }) : `${scale}×`}</option>
          ))}
        </select>
      </label>
      <p id={`${id}-scale-help`} className="field-help">{t.settings.textSizeHelp}</p>
    </div>
  );
}

/** The user settings (UI-7, I18N-4): account details and the preferences stored in this browser (FE-3). */
export function SettingsModal({ user, onClose }: { user: SessionUser | null; onClose(): void }) {
  const { t } = useI18n();
  const id = useId();
  const [preferences, setPreferences] = useState(readPreferences);

  function change<K extends keyof Preferences>(name: K, value: Preferences[K]) {
    changePreference(name, value);
    setPreferences((current) => ({ ...current, [name]: value }));
  }

  return (
    <Dialog title={t.settings.title} eyebrow={t.settings.eyebrow} onClose={onClose} closeLabel={t.settings.close} className="settings-dialog">
      <section className="settings-section" aria-labelledby={`${id}-display`}>
        <h3 id={`${id}-display`}>{t.settings.display}</h3>
        <DisplaySettings preferences={preferences} onChange={change} />
      </section>

      <section className="settings-section" aria-labelledby={`${id}-articles`}>
        <h3 id={`${id}-articles`}>{t.settings.interface}</h3>
        <div className="settings-controls">
          <label className="field">
            <span>{t.settings.searchResults}</span>
            <select value={preferences.searchResults} onChange={(event) => change('searchResults', event.target.value as SearchResultsView)}>
              <option value="cards">{t.settings.cards}</option>
              <option value="rows">{t.settings.rows}</option>
            </select>
          </label>
          {user && (
            <label className="field">
              <span>{t.settings.downloads}</span>
              <select value={String(preferences.allowDownloads)} onChange={(event) => change('allowDownloads', event.target.value === 'true')}>
                <option value="false">{t.settings.downloadsOff}</option>
                <option value="true">{t.settings.downloadsOn}</option>
              </select>
            </label>
          )}
        </div>
      </section>

      <section className="settings-section" aria-labelledby={`${id}-account`}>
        <h3 id={`${id}-account`}>{t.settings.account}</h3>
        <dl className="account-details">
          <div><dt>{t.settings.username}</dt><dd>{user?.username ?? t.settings.notSignedIn}</dd></div>
          <div><dt>{t.settings.email}</dt><dd>{user?.email ?? t.common.notAvailable}</dd></div>
          <div><dt>{t.settings.accountType}</dt><dd>{user ? t.roles[user.role] : t.common.notAvailable}</dd></div>
        </dl>
      </section>
    </Dialog>
  );
}
