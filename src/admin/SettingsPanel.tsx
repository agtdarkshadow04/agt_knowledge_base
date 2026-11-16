import { type FormEvent, useEffect, useState } from 'react';
import { LoadingState } from '../components/States';
import { agtVisibilityOptions, legacyVisibilityOptions, parseArticleVisibility } from '../lib/visibility';
import { formatTranslation } from '../translations';
import { useAdminI18n } from './context';
import { getSettings, updateSettings } from './api';
import type { AdminSettingsView, DashboardSettings, SettingKey, SettingState, SettingsWrite } from './types';

type Draft = { [Key in SettingKey]: DashboardSettings[Key] | null };

const limitKeys = [
  'backup.maxZipBytes', 'backup.maxUncompressedBytes', 'backup.maxEntries',
  'logs.serverRetentionDays', 'logs.serverMaxEntries', 'logs.auditRetentionDays', 'logs.auditMaxEntries',
] as const;

function stateMap(view: AdminSettingsView) {
  return Object.fromEntries(view.states.map((state) => [state.key, state])) as { [Key in SettingKey]: SettingState<Key> };
}

function draftFrom(view: AdminSettingsView): Draft {
  const draft = Object.fromEntries(view.states.map((state) => [state.key, state.value])) as Draft;
  // Limits left at their defaults show as empty ("use the default").
  for (const state of view.states) {
    if ((limitKeys as readonly string[]).includes(state.key) && state.source === 'default') draft[state.key] = null;
  }
  return draft;
}

/** Where a value comes from; a key config.yaml sets is read-only (CFG-9). */
function SourceNote({ state }: { state: SettingState }) {
  const { a } = useAdminI18n();
  const template = state.locked ? a.settings.fromConfig : state.source === 'default' ? a.settings.fromDefault : a.settings.fromDashboard;
  return <small className="field-help setting-source">{formatTranslation(template, { key: state.key })}</small>;
}

export function SettingsPanel() {
  const { t, a, number, error: describe } = useAdminI18n();
  const [view, setView] = useState<AdminSettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getSettings(controller.signal).then((next) => { setView(next); setDraft(draftFrom(next)); }).catch((cause) => {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(describe(cause));
    });
    return () => controller.abort();
  }, [describe]);

  if (!view || !draft) return error ? <p className="error-note" role="alert">{error}</p> : <LoadingState message={a.settings.loading} />;

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
      setError(describe(cause));
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
        placeholder={formatTranslation(a.settings.defaultValue, { value: number(states[key].default) })}
        readOnly={states[key].locked}
        onChange={(event) => update(key, event.target.value === '' ? null : Number(event.target.value))}
      />
      <SourceNote state={states[key]} />
    </label>
  );

  return (
    <section className="admin-panel settings-admin-panel" aria-labelledby="application-settings-title">
      <h2 id="application-settings-title">{a.settings.title}</h2>
      <p className="field-help">{a.settings.intro}</p>
      {error && <p className="error-note" role="alert">{error}</p>}
      <div role="status" aria-live="polite">{saved && <p className="success-note">{a.settings.saved}</p>}</div>
      <form className="stack-form" onSubmit={(event) => void save(event)}>
        {textField('site.title', a.settings.siteTitle, { maxLength: 100 })}
        {textField('site.subtitle', a.settings.siteSubtitle, { maxLength: 240, multiline: true })}
        {textField('site.supportUrl', a.settings.supportUrl, { maxLength: 2000, type: 'url' })}
        <label className="field"><span>{a.settings.defaultVisibility}</span>
          <select value={String(draft['articles.defaultVisibility'])} disabled={states['articles.defaultVisibility'].locked} onChange={(event) => update('articles.defaultVisibility', parseArticleVisibility(event.target.value))}>
            <optgroup label={t.visibility.agtGroup}>{agtVisibilityOptions.map((option) => <option key={option.value} value={option.value}>{t.visibility[option.className]}</option>)}</optgroup>
            <optgroup label={t.visibility.legacyGroup}>{legacyVisibilityOptions.map((option) => <option key={option.value} value={option.value}>{t.visibility[option.className]}</option>)}</optgroup>
          </select>
          <SourceNote state={states['articles.defaultVisibility']} />
        </label>
        <label className="check-field">
          <input type="checkbox" checked={Boolean(draft['access.allowPublicBrowsing'])} disabled={states['access.allowPublicBrowsing'].locked} onChange={(event) => update('access.allowPublicBrowsing', event.target.checked)} />
          {a.settings.publicBrowsing}
        </label>
        <SourceNote state={states['access.allowPublicBrowsing']} />
        <h3>{a.settings.backupLimits}</h3>
        {limitField('backup.maxZipBytes', a.settings.maxZipBytes)}
        {limitField('backup.maxEntries', a.settings.maxEntries)}
        {limitField('backup.maxUncompressedBytes', a.settings.maxUncompressedBytes)}
        <h3>{a.settings.logRetention}</h3>
        <p className="field-help">{a.settings.logRetentionHelp}</p>
        {limitField('logs.serverRetentionDays', a.settings.serverRetentionDays)}
        {limitField('logs.serverMaxEntries', a.settings.serverMaxEntries)}
        {limitField('logs.auditRetentionDays', a.settings.auditRetentionDays)}
        {limitField('logs.auditMaxEntries', a.settings.auditMaxEntries)}
        <div className="dialog-actions">
          <button className="button button-primary" disabled={busy} type="submit">{a.settings.save}</button>
          <button className="button button-secondary" disabled={busy} type="button" onClick={() => { setDraft(draftFrom(view)); setSaved(false); }}>{a.settings.cancel}</button>
        </div>
      </form>
    </section>
  );
}
