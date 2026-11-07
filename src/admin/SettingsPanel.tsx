import { type FormEvent, useEffect, useState } from 'react';
import { LoadingState } from '../components/States';
import { agtVisibilityOptions, legacyVisibilityOptions, parseArticleVisibility } from '../visibility';
import { getSettings, updateSettings } from './api';
import type { AdminSettingsView, DashboardSettings, SettingName, SettingsWrite } from './types';

type Draft = { [Name in SettingName]: DashboardSettings[Name] | null };

const limitNames = ['backupMaxBytes', 'backupMaxEntries', 'backupMaxUncompressedBytes'] as const;

function draftFrom(view: AdminSettingsView): Draft {
  const draft = Object.fromEntries(Object.entries(view.settings).map(([name, setting]) => [name, setting.value])) as Draft;
  // Backup limits left at their defaults show as empty ("use the default").
  for (const name of limitNames) if (view.settings[name].source === 'default') draft[name] = null;
  return draft;
}

function SourceNote({ view, name }: { view: AdminSettingsView; name: SettingName }) {
  const setting = view.settings[name];
  if (setting.source === 'file') {
    return <small className="field-help setting-source">Set in the configuration file (<code>{setting.key}</code>)</small>;
  }
  return <small className="field-help setting-source">{setting.source === 'default' ? 'Default' : 'Set in the dashboard'} · <code>{setting.key}</code></small>;
}

export function SettingsPanel() {
  const [view, setView] = useState<AdminSettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getSettings(controller.signal).then((next) => { setView(next); setDraft(draftFrom(next)); }).catch((cause) => {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : 'Settings could not be loaded.');
    });
    return () => controller.abort();
  }, []);

  if (!view || !draft) return error ? <div className="inline-alert" role="alert">{error}</div> : <LoadingState message="Loading settings…" />;

  const locked = (name: SettingName) => view.settings[name].source === 'file';
  const update = <Name extends SettingName>(name: Name, value: Draft[Name]) => {
    setSaved(false);
    setDraft({ ...draft, [name]: value });
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!view || !draft) return;
    setBusy(true);
    setError('');
    // Only dashboard-editable values are sent: the API rejects file-defined keys.
    const input: SettingsWrite = { version: view.version };
    for (const name of Object.keys(draft) as SettingName[]) {
      if (!locked(name)) Object.assign(input, { [name]: draft[name] });
    }
    try {
      const next = await updateSettings(input);
      setView(next);
      setDraft(draftFrom(next));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Settings could not be saved.');
    } finally { setBusy(false); }
  }

  const limitField = (name: typeof limitNames[number], label: string) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={1}
        step={1}
        value={draft[name] ?? ''}
        placeholder={`Default: ${view.settings[name].source === 'default' ? view.settings[name].value.toLocaleString() : 'server default'}`}
        readOnly={locked(name)}
        onChange={(event) => update(name, event.target.value === '' ? null : Number(event.target.value))}
      />
      <SourceNote view={view} name={name} />
    </label>
  );

  return (
    <section className="admin-panel settings-admin-panel" aria-labelledby="application-settings-title">
      <h2 id="application-settings-title">Settings</h2>
      <p className="field-help">Settings defined in <code>config.yaml</code> are read-only here: the configuration file always wins.</p>
      {error && <div className="inline-alert" role="alert">{error}</div>}
      {saved && <div className="inline-notice" role="status">Settings saved.</div>}
      <form className="stack-form" onSubmit={(event) => void save(event)}>
        <label className="field"><span>Application name</span>
          <input value={draft.applicationName ?? ''} maxLength={80} readOnly={locked('applicationName')} onChange={(event) => update('applicationName', event.target.value)} required />
          <SourceNote view={view} name="applicationName" />
        </label>
        <label className="field"><span>Subtitle or description</span>
          <textarea value={draft.applicationSubtitle ?? ''} maxLength={240} readOnly={locked('applicationSubtitle')} onChange={(event) => update('applicationSubtitle', event.target.value)} required />
          <SourceNote view={view} name="applicationSubtitle" />
        </label>
        <label className="field"><span>Default article visibility</span>
          <select value={String(draft.defaultVisibility)} disabled={locked('defaultVisibility')} onChange={(event) => update('defaultVisibility', parseArticleVisibility(event.target.value))}>
            <optgroup label="AGT standard">{agtVisibilityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>
            <optgroup label="Legacy">{legacyVisibilityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>
          </select>
          <SourceNote view={view} name="defaultVisibility" />
        </label>
        <label className="check-field">
          <input type="checkbox" checked={Boolean(draft.allowPublicBrowsing)} disabled={locked('allowPublicBrowsing')} onChange={(event) => update('allowPublicBrowsing', event.target.checked)} />
          Allow unauthenticated visitors to browse public articles
        </label>
        <SourceNote view={view} name="allowPublicBrowsing" />
        <h3>Backup limits</h3>
        {limitField('backupMaxBytes', 'Largest backup upload (bytes)')}
        {limitField('backupMaxEntries', 'Most entries in a backup archive')}
        {limitField('backupMaxUncompressedBytes', 'Largest uncompressed backup (bytes)')}
        <div className="dialog-actions">
          <button className="button button-primary" disabled={busy} type="submit">Save settings</button>
          <button className="button button-secondary" disabled={busy} type="button" onClick={() => { setDraft(draftFrom(view)); setSaved(false); }}>Cancel</button>
        </div>
      </form>
    </section>
  );
}
