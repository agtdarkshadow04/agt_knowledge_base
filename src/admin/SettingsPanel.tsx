import { type FormEvent, useEffect, useState } from 'react';
import { LoadingState } from '../components/States';
import { agtVisibilityOptions, legacyVisibilityOptions, parseArticleVisibility } from '../visibility';
import { getSettings, updateSettings } from './api';
import type { AdminSettingsView, DashboardSettings, SettingKey, SettingState, SettingsWrite } from './types';

type Draft = { [Key in SettingKey]: DashboardSettings[Key] | null };

const limitKeys = ['backup.maxZipBytes', 'backup.maxUncompressedBytes', 'backup.maxEntries'] as const;

function stateMap(view: AdminSettingsView) {
  return Object.fromEntries(view.states.map((state) => [state.key, state])) as { [Key in SettingKey]: SettingState<Key> };
}

function draftFrom(view: AdminSettingsView): Draft {
  const draft = Object.fromEntries(view.states.map((state) => [state.key, state.value])) as Draft;
  // Backup limits left at their defaults show as empty ("use the default").
  for (const state of view.states) {
    if ((limitKeys as readonly string[]).includes(state.key) && state.source === 'default') draft[state.key] = null;
  }
  return draft;
}

/** Where a value comes from; a key config.yaml sets is read-only (CFG-9). */
function SourceNote({ state }: { state: SettingState }) {
  if (state.locked) {
    return <small className="field-help setting-source">Set in the configuration file (<code>{state.key}</code>)</small>;
  }
  return <small className="field-help setting-source">{state.source === 'default' ? 'Default' : 'Set in the dashboard'} · <code>{state.key}</code></small>;
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

  const states = stateMap(view);
  const initial = draftFrom(view);
  const update = <Key extends SettingKey>(key: Key, value: Draft[Key]) => {
    setSaved(false);
    setDraft({ ...draft, [key]: value });
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!view || !draft) return;
    setBusy(true);
    setError('');
    // Only changed, unlocked keys are sent: the API refuses keys config.yaml sets.
    const values: SettingsWrite['values'] = {};
    for (const key of Object.keys(draft) as SettingKey[]) {
      if (!states[key].locked && draft[key] !== initial[key]) Object.assign(values, { [key]: draft[key] });
    }
    try {
      const next = await updateSettings({ values });
      setView(next);
      setDraft(draftFrom(next));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Settings could not be saved.');
    } finally { setBusy(false); }
  }

  const textField = (key: 'site.title' | 'site.subtitle' | 'site.supportUrl', label: string, options: { maxLength: number; multiline?: boolean; type?: string }) => {
    const props = {
      value: draft[key] ?? '',
      maxLength: options.maxLength,
      readOnly: states[key].locked,
      required: true,
      onChange: (event: { target: { value: string } }) => update(key, event.target.value),
    };
    return (
      <label className="field"><span>{label}</span>
        {options.multiline ? <textarea {...props} /> : <input type={options.type ?? 'text'} {...props} />}
        <SourceNote state={states[key]} />
      </label>
    );
  };

  const limitField = (key: typeof limitKeys[number], label: string) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={1}
        step={1}
        value={draft[key] ?? ''}
        placeholder={`Default: ${states[key].default.toLocaleString()}`}
        readOnly={states[key].locked}
        onChange={(event) => update(key, event.target.value === '' ? null : Number(event.target.value))}
      />
      <SourceNote state={states[key]} />
    </label>
  );

  return (
    <section className="admin-panel settings-admin-panel" aria-labelledby="application-settings-title">
      <h2 id="application-settings-title">Settings</h2>
      <p className="field-help">Settings defined in <code>config.yaml</code> are read-only here: the configuration file always wins.</p>
      {error && <div className="inline-alert" role="alert">{error}</div>}
      {saved && <div className="inline-notice" role="status">Settings saved.</div>}
      <form className="stack-form" onSubmit={(event) => void save(event)}>
        {textField('site.title', 'Application name', { maxLength: 100 })}
        {textField('site.subtitle', 'Subtitle or description', { maxLength: 240, multiline: true })}
        {textField('site.supportUrl', 'Support link', { maxLength: 2000, type: 'url' })}
        <label className="field"><span>Default article visibility</span>
          <select value={String(draft['articles.defaultVisibility'])} disabled={states['articles.defaultVisibility'].locked} onChange={(event) => update('articles.defaultVisibility', parseArticleVisibility(event.target.value))}>
            <optgroup label="AGT standard">{agtVisibilityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>
            <optgroup label="Legacy">{legacyVisibilityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>
          </select>
          <SourceNote state={states['articles.defaultVisibility']} />
        </label>
        <label className="check-field">
          <input type="checkbox" checked={Boolean(draft['access.allowPublicBrowsing'])} disabled={states['access.allowPublicBrowsing'].locked} onChange={(event) => update('access.allowPublicBrowsing', event.target.checked)} />
          Allow unauthenticated visitors to browse public articles
        </label>
        <SourceNote state={states['access.allowPublicBrowsing']} />
        <h3>Backup limits</h3>
        {limitField('backup.maxZipBytes', 'Largest backup upload (bytes)')}
        {limitField('backup.maxEntries', 'Most entries in a backup archive')}
        {limitField('backup.maxUncompressedBytes', 'Largest uncompressed backup (bytes)')}
        <div className="dialog-actions">
          <button className="button button-primary" disabled={busy} type="submit">Save settings</button>
          <button className="button button-secondary" disabled={busy} type="button" onClick={() => { setDraft(draftFrom(view)); setSaved(false); }}>Cancel</button>
        </div>
      </form>
    </section>
  );
}
