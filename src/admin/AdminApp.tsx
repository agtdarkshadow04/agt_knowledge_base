import { type FormEvent, type KeyboardEvent, lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { formErrors, TextField } from '../components/Field';
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
  | { name: 'error'; message: string }
  | { name: 'setup'; status: SetupStatus }
  | { name: 'login'; notice?: string }
  | { name: 'dashboard'; session: AdminSession };

type Tab = 'users' | 'data' | 'settings' | 'backup' | 'serverLog' | 'auditLog' | 'account' | 'api';

// The API reference is loaded only when the API tab is opened.
const ApiPanel = lazy(async () => ({ default: (await import('./ApiPanel')).ApiPanel }));

/** UI-8: the resource tabs, then Settings, Server log, Audit log, Backup & restore and Account; the API reference last. */
const tabs: { id: Tab; label: string; icon: typeof UsersIcon }[] = [
  { id: 'users', label: 'Users', icon: UsersIcon },
  { id: 'data', label: 'Data', icon: DatabaseIcon },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
  { id: 'serverLog', label: 'Server log', icon: ScrollTextIcon },
  { id: 'auditLog', label: 'Audit log', icon: ClipboardListIcon },
  { id: 'backup', label: 'Backup & restore', icon: ArchiveIcon },
  { id: 'account', label: 'Account', icon: KeyRoundIcon },
  { id: 'api', label: 'API', icon: BracesIcon },
];

/** A tab's button and panel IDs (WAI-ARIA tabs). */
const tabId = (tab: Tab) => `admin-tab-${tab}`;
const panelId = (tab: Tab) => `admin-panel-${tab}`;

function failure(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

type Errors = { fields: Record<string, string>; form: string };
const noErrors: Errors = { fields: {}, form: '' };

function SetupScreen({ status, onComplete }: { status: SetupStatus; onComplete(session: AdminSession): void }) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Errors>(noErrors);

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
    setErrors(formErrors(checked, ''));
    if (!checked.ok) return;
    setBusy(true);
    try {
      onComplete(await completeSetup(input));
    } catch (cause) {
      setErrors(formErrors(cause, 'Setup could not be completed.'));
    } finally { setBusy(false); }
  }

  return (
    <section className="auth-card setup-card" aria-labelledby="admin-setup-title">
      <ShieldCheckIcon aria-hidden="true" className="auth-icon" />
      <p className="eyebrow">First-run setup</p>
      <h1 id="admin-setup-title">Create the Admin account</h1>
      {!status.setupPasswordConfigured ? (
        <div className="admin-notice danger" role="alert">
          Setup is unavailable: <code>AGT_KNOWLEDGE_BASE_SETUP_PASSWORD</code> is not set. Set it in <code>.env</code> and restart.
        </div>
      ) : (
        <>
          <p>Enter the one-time setup password from <code>AGT_KNOWLEDGE_BASE_SETUP_PASSWORD</code>, then choose the Admin username and a new password. The Admin manages members and the installation; it cannot write articles.</p>
          {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
          <form className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
            <TextField label="Setup password" name="setupPassword" type="password" autoComplete="off" required error={errors.fields.setupPassword} />
            <TextField label="Admin username" name="username" autoComplete="username" required error={errors.fields.username} />
            <TextField label="New password" name="password" type="password" autoComplete="new-password" required error={errors.fields.password} help="At least 12 characters with uppercase, lowercase, a number and a symbol; it must differ from the setup password." />
            <TextField label="Confirm new password" name="passwordConfirmation" type="password" autoComplete="new-password" required error={errors.fields.passwordConfirmation} />
            <button className="button button-primary" disabled={busy} type="submit"><ShieldCheckIcon aria-hidden="true" />{busy ? 'Creating…' : 'Complete setup'}</button>
          </form>
        </>
      )}
    </section>
  );
}

function LoginScreen({ notice, onSignedIn }: { notice?: string; onSignedIn(session: AdminSession): void }) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Errors>(noErrors);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = { username: String(data.get('username')), password: String(data.get('password')) };
    const checked = validate(parseCredentials, input);
    setErrors(formErrors(checked, ''));
    if (!checked.ok) return;
    setBusy(true);
    try {
      onSignedIn(await signIn(input.username, input.password));
    } catch (cause) {
      setErrors(formErrors(cause, 'Sign-in failed.'));
    } finally { setBusy(false); }
  }

  return (
    <section className="auth-card" aria-labelledby="admin-login-title">
      <LockKeyholeIcon aria-hidden="true" className="auth-icon" />
      <p className="eyebrow">Installation administration</p>
      <h1 id="admin-login-title">Admin sign-in</h1>
      <div role="status" aria-live="polite">{notice && <p className="success-note">{notice}</p>}</div>
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <form className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
        <TextField label="Username" name="username" autoComplete="username" required error={errors.fields.username} />
        <TextField label="Password" name="password" type="password" autoComplete="current-password" required error={errors.fields.password} />
        <button className="button button-primary" disabled={busy} type="submit"><LogInIcon aria-hidden="true" />{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </section>
  );
}

function Dashboard({ session, onSessionChange, onSignedOut }: {
  session: AdminSession;
  onSessionChange(session: AdminSession): void;
  onSignedOut(notice?: string): void;
}) {
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
        <div className="admin-notice danger" role="alert">
          <code>AGT_KNOWLEDGE_BASE_SETUP_PASSWORD</code> is still set on the server. It is no longer needed: remove it from <code>.env</code> and restart the stack.
        </div>
      )}
      {unseen > 0 && tab !== 'serverLog' && (
        <div className="admin-notice admin-log-link" role="status">
          The server log has {unseen} new {unseen === 1 ? 'warning or error' : 'warnings or errors'}.{' '}
          <button className="link-button" type="button" onClick={() => setTab('serverLog')}>Open the server log</button>
        </div>
      )}
      <div className="admin-tabs" role="tablist" aria-label="Administration sections">
        {tabs.map(({ id, label, icon: Icon }, index) => (
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
            <Icon />{label}
            {id === 'serverLog' && unseen > 0 && tab !== 'serverLog' && (
              <span className={`admin-badge${summary!.unseenErrors > 0 ? ' admin-badge-error' : ''}`}>
                {unseen}<span className="sr-only"> unseen {summary!.unseenErrors > 0 ? 'errors and warnings' : 'warnings'}</span>
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
        {tab === 'backup' && <BackupPanel onRestored={() => onSignedOut('The backup was restored. Sign in with the Admin account from the backup.')} />}
        {tab === 'account' && <AccountPanel session={session} onSessionRenewed={onSessionChange} />}
        {tab === 'api' && <Suspense fallback={<LoadingState message="Loading the API reference…" />}><ApiPanel /></Suspense>}
      </div>
    </>
  );
}

/**
 * The admin panel, served from admin.html at /admin. It has its own session
 * (an HttpOnly cookie) and never touches the member sign-in.
 */
export function AdminApp() {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  const load = useCallback(async () => {
    try {
      const status = await getSetupStatus();
      if (!status.adminExists) { setPhase({ name: 'setup', status }); return; }
      const session = await getSession();
      setPhase(session ? { name: 'dashboard', session } : { name: 'login' });
    } catch (cause) {
      setPhase({ name: 'error', message: failure(cause, 'The admin service could not be reached.') });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const expired = () => setPhase((current) => (current.name === 'dashboard'
      ? { name: 'login', notice: 'Your Admin session has ended. Sign in again.' }
      : current));
    window.addEventListener(adminUnauthorizedEvent, expired);
    return () => window.removeEventListener(adminUnauthorizedEvent, expired);
  }, []);

  async function leave() {
    try { await signOut(); } finally { setPhase({ name: 'login', notice: 'You have signed out.' }); }
  }

  const session = phase.name === 'dashboard' ? phase.session : null;
  return (
    <div className="admin-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="admin-header">
        <div className="admin-title">
          <img className="brand-logo" src="/AgtOfficialLogo.webp" alt="" aria-hidden="true" width="40" height="40" />
          <div>
            <p className="eyebrow">AGT Knowledge Base</p>
            <h1>Administration</h1>
          </div>
        </div>
        <div className="admin-identity">
          {session && <span className="admin-version">Version {session.version}</span>}
          {session && <span className="identity-badge admin"><ShieldCheckIcon /> {session.username}</span>}
          <a className="button button-secondary" href="/">View site</a>
          {session && <button className="button button-secondary" type="button" onClick={() => void leave()}><LogOutIcon />Sign out</button>}
        </div>
      </header>
      <MaintenanceNotice />
      <main id="main-content" className="admin-main" tabIndex={-1}>
        {phase.name === 'loading' && <LoadingState message="Checking the Admin session…" />}
        {phase.name === 'error' && (
          <div className="auth-page"><section className="auth-card"><div className="admin-notice danger" role="alert">{phase.message}</div>
            <button className="button button-secondary" type="button" onClick={() => { setPhase({ name: 'loading' }); void load(); }}>Try again</button></section></div>
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
    </div>
  );
}
