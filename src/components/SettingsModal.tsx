import { useEffect, useId, useRef, useState } from 'react';
import type { SessionUser } from '../types';

const uiScales = ['0.50', '0.75', '1.00', '1.25', '1.50', '2.00'] as const;
const fontSizes = ['small', 'normal', 'large', 'extra-large'] as const;
const searchResultsViews = ['cards', 'rows'] as const;
export const allowDownloadsChangedEvent = 'agt-allow-downloads-changed';
type UiScale = typeof uiScales[number];
type FontSize = typeof fontSizes[number];
type SearchResultsView = typeof searchResultsViews[number];

function storedSetting<T extends string>(key: string, values: readonly T[], fallback: T) {
  const value = localStorage.getItem(key);
  return values.includes(value as T) ? value as T : fallback;
}

export function storedAllowDownloadsSetting() {
  return localStorage.getItem('agt-allow-downloads') === 'true';
}

export function applyStoredAccessibilitySettings() {
  document.documentElement.dataset.searchResults = storedSetting('agt-search-results', searchResultsViews, 'cards');
  document.documentElement.dataset.uiScale = storedSetting('agt-ui-scale', uiScales, '1.00');
  document.documentElement.dataset.fontSize = storedSetting('agt-font-size', fontSizes, 'normal');
}

export function SettingsIcon() {
  return (
    <svg className="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g transform="translate(0 2.4)">
        <path d="M9.5 3.2 10 1.8h4l.5 1.4 1.7 1 1.5-.3 2 3.5-1 1.2v2l1 1.2-2 3.5-1.5-.3-1.7 1-.5 1.4h-4L9.5 16l-1.7-1-1.5.3-2-3.5 1-1.2v-2l-1-1.2 2-3.5 1.5.3 1.7-1Z" />
        <circle cx="12" cy="9.6" r="2.6" />
      </g>
    </svg>
  );
}

export function SettingsModal({ user, onClose }: { user: SessionUser | null; onClose(): void }) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const [searchResultsView, setSearchResultsView] = useState<SearchResultsView>(() => storedSetting('agt-search-results', searchResultsViews, 'cards'));
  const [allowDownloads, setAllowDownloads] = useState(storedAllowDownloadsSetting);
  const [uiScale, setUiScale] = useState<UiScale>(() => storedSetting('agt-ui-scale', uiScales, '1.00'));
  const [fontSize, setFontSize] = useState<FontSize>(() => storedSetting('agt-font-size', fontSizes, 'normal'));

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const focusable = dialog.current?.querySelectorAll<HTMLElement>('button, select, [href], [tabindex]:not([tabindex="-1"])');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    localStorage.setItem('agt-search-results', searchResultsView);
    document.documentElement.dataset.searchResults = searchResultsView;
  }, [searchResultsView]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem('agt-allow-downloads', String(allowDownloads));
    window.dispatchEvent(new Event(allowDownloadsChangedEvent));
  }, [allowDownloads, user]);

  useEffect(() => {
    localStorage.setItem('agt-ui-scale', uiScale);
    document.documentElement.dataset.uiScale = uiScale;
  }, [uiScale]);

  useEffect(() => {
    localStorage.setItem('agt-font-size', fontSize);
    document.documentElement.dataset.fontSize = fontSize;
  }, [fontSize]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialog} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="settings-header">
          <div>
            <p className="eyebrow">Preferences</p>
            <h2 id={titleId}>Settings</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close settings" autoFocus>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <section className="settings-section" aria-labelledby={`${titleId}-account`}>
          <h3 id={`${titleId}-account`}>Account</h3>
          <dl className="account-details">
            <div><dt>Username</dt><dd>{user?.username ?? 'Public user'}</dd></div>
            <div><dt>Email</dt><dd>{user?.email ?? 'N/A'}</dd></div>
            <div><dt>Account type</dt><dd>{user?.role ?? 'N/A'}</dd></div>
          </dl>
        </section>

        <section className="settings-section" aria-labelledby={`${titleId}-user-interface`}>
          <h3 id={`${titleId}-user-interface`}>User Interface</h3>
          <div className="settings-controls">
            <label className="field">
              Search Results
              <select value={searchResultsView} onChange={(event) => setSearchResultsView(event.target.value as SearchResultsView)}>
                <option value="cards">Cards</option>
                <option value="rows">Rows</option>
              </select>
            </label>
            {user && (
              <label className="field">
                Allow Downloads
                <select value={String(allowDownloads)} onChange={(event) => setAllowDownloads(event.target.value === 'true')}>
                  <option value="false">Don't Allow (Default)</option>
                  <option value="true">Allow</option>
                </select>
              </label>
            )}
          </div>
        </section>

        <section className="settings-section" aria-labelledby={`${titleId}-accessibility`}>
          <h3 id={`${titleId}-accessibility`}>Accessibility</h3>
          <div className="settings-controls">
            <label className="field">
              UI scale
              <select value={uiScale} onChange={(event) => setUiScale(event.target.value as UiScale)}>
                {uiScales.map((scale) => <option key={scale} value={scale}>{scale}x{scale === '1.00' ? ' (default)' : ''}</option>)}
              </select>
            </label>
            <label className="field">
              Font size
              <select value={fontSize} onChange={(event) => setFontSize(event.target.value as FontSize)}>
                <option value="small">Small</option>
                <option value="normal">Normal</option>
                <option value="large">Large</option>
                <option value="extra-large">Extra Large</option>
              </select>
            </label>
          </div>
        </section>
      </section>
    </div>
  );
}
