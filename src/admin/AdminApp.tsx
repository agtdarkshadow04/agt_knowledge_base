import { type FormEvent, type KeyboardEvent, lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { formErrors, noFormErrors, TextField } from '../components/Field';
import { changePreference, DisplaySettings } from '../components/SettingsModal';
import { readPreferences, type Preferences } from '../lib/preferences';
import { COMMON_TRANSLATIONS, formatTranslation } from '../translations';
import { useAdminI18n } from './context';
import type { AdminTranslations } from './i18n';
import { MaintenanceNotice } from '../components/MaintenanceNotice';
import { parseAdminSetup, parseCredentials, validate } from '../lib/validation';
import { LoadingState } from '../components/States';
import { AccountPanel } from './AccountPanel';
import { adminUnauthorizedEvent, completeSetup, getServerLogSummary, getSession, getSetupStatus, markServerLogSeen, signIn, signOut } from './api';
import { BackupPanel } from './BackupPanel';
import { DataPanel } from './DataPanel';
import { AuditLogPanel } from './AuditLogPanel';
import { ServerLogPanel } from './ServerLogPanel';
import { SettingsPanel } from './SettingsPanel';
import type { AdminSession, ServerLogSummary, SetupStatus } from './types';
import { UsersPanel } from './UsersPanel';
import { ArchiveIcon, BracesIcon, ClipboardListIcon, DatabaseIcon, KeyRoundIcon, LockKeyholeIcon, LogInIcon, LogOutIcon, ScrollTextIcon, SettingsIcon, ShieldCheckIcon, UsersIcon } from '../components/Icons';

type Phase =
  | { name: 'loading' }
  | { name: 'error'; cause: unknown }
  | { name: 'setup'; status: SetupStatus }
  | { name: 'login'; notice?: Notice }
  | { name: 'dashboard'; session: AdminSession };

type Tab = 'users' | 'data' | 'settings' | 'backup' | 'serverLog' | 'auditLog' | 'account' | 'api';

/** Why the sign-in screen is shown again; the text is translated where it is shown. */
type Notice = 'signedOut' | 'sessionEnded' | 'restored';

const noticeText = (notice: Notice, a: AdminTranslations) => ({ signedOut: a.app.signedOut, sessionEnded: a.app.sessionEnded, restored: a.app.restored })[notice];

// The API reference is loaded only when the API tab is opened.
const ApiPanel = lazy(async () => ({ default: (await import('./ApiPanel')).ApiPanel }));

/** UI-8: the resource tabs, then Settings, Server log, Audit log, Backup & restore and Account; the API reference last. */
const tabs: { id: Tab; icon: typeof UsersIcon }[] = [
  { id: 'users', icon: UsersIcon },
  { id: 'data', icon: DatabaseIcon },
  { id: 'settings', icon: SettingsIcon },
  { id: 'serverLog', icon: ScrollTextIcon },
  { id: 'auditLog', icon: ClipboardListIcon },
  { id: 'backup', icon: ArchiveIcon },
  { id: 'account', icon: KeyRoundIcon },
  { id: 'api', icon: BracesIcon },
];

/** A tab's button and panel IDs (WAI-ARIA tabs). */
const tabId = (tab: Tab) => `admin-tab-${tab}`;
const panelId = (tab: Tab) => `admin-panel-${tab}`;

function SetupScreen({ status, onComplete }: { status: SetupStatus; onComplete(session: AdminSession): void }) {
  const { t, a } = useAdminI18n();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState(noFormErrors);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = {
      setupPassword: String(data.get('setupPassword')),
      username: String(data.get('username')),
      password: String(data.get('password')),
      passwordConfirmation: String(data.get('passwordConfirmation')),
    };
    const checked = validate(parseAdminSetup, input);
    setErrors(formErrors(checked, t));
    if (!checked.ok) return;
    setBusy(true);
    try {
      onComplete(await completeSetup(input));
    } catch (cause) {
      setErrors(formErrors(cause, t));
    } finally { setBusy(false); }
  }

  return (
    <section className="auth-card setup-card" aria-labelledby="admin-setup-title">
      <ShieldCheckIcon className="auth-icon" />
      <p className="eyebrow">{a.setup.eyebrow}</p>
      <h1 id="admin-setup-title">{a.setup.title}</h1>
      {!status.setupPasswordConfigured ? (
        <div className="admin-notice danger" role="alert">{a.setup.unavailable}</div>
      ) : (
        <>
          <p>{a.setup.intro}</p>
          {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
          <form className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
            <TextField label={a.setup.setupPassword} name="setupPassword" type="password" autoComplete="off" required error={errors.fields.setupPassword} />
            <TextField label={a.setup.username} name="username" autoComplete="username" required error={errors.fields.username} />
            <TextField label={a.setup.password} name="password" type="password" autoComplete="new-password" required error={errors.fields.password} help={a.setup.passwordHelp} />
            <TextField label={a.setup.confirm} name="passwordConfirmation" type="password" autoComplete="new-password" required error={errors.fields.passwordConfirmation} />
            <button className="button button-primary" disabled={busy} type="submit"><ShieldCheckIcon />{busy ? a.setup.submitting : a.setup.submit}</button>
          </form>
        </>
      )}
    </section>
  );
}

function LoginScreen({ notice, onSignedIn }: { notice?: Notice; onSignedIn(session: AdminSession): void }) {
  const { t, a } = useAdminI18n();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState(noFormErrors);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = { username: String(data.get('username')), password: String(data.get('password')) };
    const checked = validate(parseCredentials, input);
    setErrors(formErrors(checked, t));
    if (!checked.ok) return;
    setBusy(true);
    try {
      onSignedIn(await signIn(input.username, input.password));
    } catch (cause) {
      setErrors(formErrors(cause, t));
    } finally { setBusy(false); }
  }

  return (
    <section className="auth-card" aria-labelledby="admin-login-title">
      <LockKeyholeIcon className="auth-icon" />
      <p className="eyebrow">{a.login.eyebrow}</p>
      <h1 id="admin-login-title">{a.login.title}</h1>
      <div role="status" aria-live="polite">{notice && <p className="success-note">{noticeText(notice, a)}</p>}</div>
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <form className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
        <TextField label={a.login.username} name="username" autoComplete="username" required error={errors.fields.username} />
        <TextField label={a.login.password} name="password" type="password" autoComplete="current-password" required error={errors.fields.password} />
        <button className="button button-primary" disabled={busy} type="submit"><LogInIcon />{busy ? a.login.submitting : a.login.submit}</button>
      </form>
    </section>
  );
}

function Dashboard({ session, onSessionChange, onSignedOut }: {
  session: AdminSession;
  onSessionChange(session: AdminSession): void;
  onSignedOut(notice?: Notice): void;
}) {
  const { a, number } = useAdminI18n();
  const [tab, setTab] = useState<Tab>('users');
  const [summary, setSummary] = useState<ServerLogSummary | null>(null);

  // LOG-21: the summary when the dashboard loads and whenever the tab changes, never in the background.
  // Opening the Server log tab marks it seen.
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        if (tab === 'serverLog') await markServerLogSeen();
        const next = await getServerLogSummary();
        if (current) setSummary(next);
      } catch {
        if (current) setSummary(null);
      }
    })();
    return () => { current = false; };
  }, [tab]);
  const unseen = summary ? summary.unseenWarnings + summary.unseenErrors : 0;

  function selectWithKeys(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = tabs[(moves[event.key] + tabs.length) % tabs.length].id;
    setTab(next);
    document.getElementById(tabId(next))?.focus();
  }

  return (
    <>
      {session.setupPasswordStillSet && (
        <div className="admin-notice danger" role="alert">{a.app.setupPasswordStillSet}</div>
      )}
      {unseen > 0 && tab !== 'serverLog' && (
        <div className="admin-notice admin-log-link" role="status">
          {formatTranslation(a.app.unseenLog, { count: number(unseen) })}{' '}
          <button className="link-button" type="button" onClick={() => setTab('serverLog')}>{a.app.openServerLog}</button>
        </div>
      )}
      <div className="admin-tabs" role="tablist" aria-label={a.app.sections}>
        {tabs.map(({ id, icon: Icon }, index) => (
          <button
            key={id}
            id={tabId(id)}
            type="button"
            role="tab"
            className="button"
            aria-selected={tab === id}
            aria-controls={panelId(id)}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(event) => selectWithKeys(event, index)}
          >
            <Icon />{a.tabs[id]}
            {id === 'serverLog' && unseen > 0 && tab !== 'serverLog' && (
              <span className={`admin-badge${summary!.unseenErrors > 0 ? ' admin-badge-error' : ''}`}>
                {number(unseen)}<span className="sr-only"> {summary!.unseenErrors > 0 ? a.app.unseenErrors : a.app.unseenWarnings}</span>
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="admin-tab-panel" role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)} tabIndex={0}>
        {tab === 'users' && <UsersPanel />}
        {tab === 'data' && <DataPanel />}
        {tab === 'settings' && <SettingsPanel />}
        {tab === 'serverLog' && <ServerLogPanel />}
        {tab === 'auditLog' && <AuditLogPanel />}
        {tab === 'backup' && <BackupPanel onRestored={() => onSignedOut('restored')} />}
        {tab === 'account' && <AccountPanel session={session} onSessionRenewed={onSessionChange} />}
        {tab === 'api' && <Suspense fallback={<LoadingState message={a.app.loadingApi} />}><ApiPanel /></Suspense>}
      </div>
    </>
  );
}

/**
 * The admin panel, served from admin.html at /admin. It has its own session
 * (an HttpOnly cookie) and never touches the member sign-in.
 */
/** The language, time zone and text size, shared with the knowledge base (I18N-4). */
function PreferencesDialog({ onClose }: { onClose(): void }) {
  const { a } = useAdminI18n();
  const [preferences, setPreferences] = useState(readPreferences);
  function change<K extends keyof Preferences>(name: K, value: Preferences[K]) {
    changePreference(name, value);
    setPreferences((current) => ({ ...current, [name]: value }));
  }
  return (
    <Dialog title={a.preferences.title} eyebrow={a.preferences.eyebrow} onClose={onClose} closeLabel={a.preferences.close} className="settings-dialog">
      <p className="field-help">{a.preferences.text}</p>
      <DisplaySettings preferences={preferences} onChange={change} />
    </Dialog>
  );
}

export function AdminApp() {
  const { t, a, error: describe } = useAdminI18n();
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [preferencesOpen, setPreferencesOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const status = await getSetupStatus();
      if (!status.adminExists) { setPhase({ name: 'setup', status }); return; }
      const session = await getSession();
      setPhase(session ? { name: 'dashboard', session } : { name: 'login' });
    } catch (cause) {
      setPhase({ name: 'error', cause });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const expired = () => setPhase((current) => (current.name === 'dashboard'
      ? { name: 'login', notice: 'sessionEnded' }
      : current));
    window.addEventListener(adminUnauthorizedEvent, expired);
    return () => window.removeEventListener(adminUnauthorizedEvent, expired);
  }, []);

  async function leave() {
    try { await signOut(); } finally { setPhase({ name: 'login', notice: 'signedOut' }); }
  }

  const session = phase.name === 'dashboard' ? phase.session : null;
  return (
    <div className="admin-shell">
      <a className="skip-link" href="#main-content">{t.common.skipToContent}</a>
      <header className="admin-header">
        <div className="admin-title">
          <img className="brand-logo" src="/AgtOfficialLogo.webp" alt="" aria-hidden="true" width="40" height="40" />
          <div>
            <p className="eyebrow">{COMMON_TRANSLATIONS.product}</p>
            <h1>{a.app.title}</h1>
          </div>
        </div>
        <div className="admin-identity">
          {session && <span className="admin-version">{formatTranslation(a.app.version, { version: session.version })}</span>}
          {session && <span className="identity-badge admin"><ShieldCheckIcon /> {session.username}</span>}
          <button
            className="button button-icon"
            type="button"
            aria-label={a.app.settings}
            title={a.app.settings}
            aria-haspopup="dialog"
            aria-expanded={preferencesOpen}
            onClick={() => setPreferencesOpen(true)}
          >
            <SettingsIcon />
          </button>
          <a className="button button-secondary" href="/">{a.app.viewSite}</a>
          {session && <button className="button button-secondary" type="button" onClick={() => void leave()}><LogOutIcon />{a.app.signOut}</button>}
        </div>
      </header>
      <MaintenanceNotice />
      <main id="main-content" className="admin-main" tabIndex={-1}>
        {phase.name === 'loading' && <LoadingState message={a.app.checkingSession} />}
        {phase.name === 'error' && (
          <div className="auth-page"><section className="auth-card"><div className="admin-notice danger" role="alert">{describe(phase.cause)}</div>
            <button className="button button-secondary" type="button" onClick={() => { setPhase({ name: 'loading' }); void load(); }}>{a.app.tryAgain}</button></section></div>
        )}
        {phase.name === 'setup' && <div className="auth-page"><SetupScreen status={phase.status} onComplete={(next) => setPhase({ name: 'dashboard', session: next })} /></div>}
        {phase.name === 'login' && <div className="auth-page"><LoginScreen notice={phase.notice} onSignedIn={(next) => setPhase({ name: 'dashboard', session: next })} /></div>}
        {phase.name === 'dashboard' && (
          <Dashboard
            session={phase.session}
            onSessionChange={(next) => setPhase({ name: 'dashboard', session: next })}
            onSignedOut={(notice) => setPhase({ name: 'login', notice })}
          />
        )}
      </main>
      {preferencesOpen && <PreferencesDialog onClose={() => setPreferencesOpen(false)} />}
    </div>
  );
}
