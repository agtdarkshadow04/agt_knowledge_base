import { useId, useState } from 'react';
import type { SessionUser } from '../lib/api';
import {
  fontScales,
  preferencesChangedEvent,
  readPreferences,
  type Preferences,
  type SearchResultsView,
  type FontScale,
  writePreference,
} from '../lib/preferences';
import { Dialog } from './Dialog';

/** The user settings (UI-7): account details and the preferences stored in this browser (FE-3, A11Y-6). */
export function SettingsModal({ user, onClose }: { user: SessionUser | null; onClose(): void }) {
  const id = useId();
  const [preferences, setPreferences] = useState(readPreferences);

  function change<K extends keyof Preferences>(name: K, value: Preferences[K]) {
    writePreference(name, value);
    setPreferences((current) => ({ ...current, [name]: value }));
    window.dispatchEvent(new Event(preferencesChangedEvent));
  }

  return (
    <Dialog title="Settings" eyebrow="Preferences" onClose={onClose} closeLabel="Close settings" className="settings-dialog">
      <section className="settings-section" aria-labelledby={`${id}-account`}>
        <h3 id={`${id}-account`}>Account</h3>
        <dl className="account-details">
          <div><dt>Username</dt><dd>{user?.username ?? 'Not signed in'}</dd></div>
          <div><dt>Email</dt><dd>{user?.email ?? 'N/A'}</dd></div>
          <div><dt>Account type</dt><dd>{user?.role ?? 'N/A'}</dd></div>
        </dl>
      </section>

      <section className="settings-section" aria-labelledby={`${id}-interface`}>
        <h3 id={`${id}-interface`}>User interface</h3>
        <div className="settings-controls">
          <label className="field">
            <span>Search results</span>
            <select value={preferences.searchResults} onChange={(event) => change('searchResults', event.target.value as SearchResultsView)}>
              <option value="cards">Cards</option>
              <option value="rows">Rows</option>
            </select>
          </label>
          {user && (
            <label className="field">
              <span>Article downloads</span>
              <select value={String(preferences.allowDownloads)} onChange={(event) => change('allowDownloads', event.target.value === 'true')}>
                <option value="false">Don&apos;t offer (default)</option>
                <option value="true">Offer PDF and Markdown</option>
              </select>
            </label>
          )}
        </div>
      </section>

      <section className="settings-section" aria-labelledby={`${id}-accessibility`}>
        <h3 id={`${id}-accessibility`}>Accessibility</h3>
        <div className="settings-controls">
          <label className="field">
            <span>Text size</span>
            <select value={preferences.fontScale} onChange={(event) => change('fontScale', event.target.value as FontScale)} aria-describedby={`${id}-scale-help`}>
              {fontScales.map((scale) => <option key={scale} value={scale}>{scale}×{scale === '1' ? ' (default)' : ''}</option>)}
            </select>
          </label>
          <p id={`${id}-scale-help`} className="field-help">Scales all text from 1× to 2×. Settings are stored only in this browser.</p>
        </div>
      </section>
    </Dialog>
  );
}
