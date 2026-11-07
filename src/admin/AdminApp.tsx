import { Archive, Database, KeyRound, LockKeyhole, LogIn, LogOut, Settings, ShieldCheck, Users } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { LoadingState } from '../components/States';
import { AccountPanel } from './AccountPanel';
import { adminUnauthorizedEvent, completeSetup, getSession, getSetupStatus, signIn, signOut } from './api';
import { BackupPanel } from './BackupPanel';
import { DataPanel } from './DataPanel';
import { SettingsPanel } from './SettingsPanel';
import type { AdminSession, SetupStatus } from './types';
import { UsersPanel } from './UsersPanel';

type Phase =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'setup'; status: SetupStatus }
  | { name: 'login'; notice?: string }
  | { name: 'dashboard'; session: AdminSession };

type Tab = 'users' | 'data' | 'settings' | 'backup' | 'account';

const tabs: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: 'users', label: 'Users', icon: Users },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'backup', label: 'Backup & restore', icon: Archive },
  { id: 'account', label: 'Account', icon: KeyRound },
];

function failure(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

function SetupScreen({ status, onComplete }: { status: SetupStatus; onComplete(session: AdminSession): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      onComplete(await completeSetup({
        setupPassword: String(data.get('setupPassword')),
        username: String(data.get('username')),
        password: String(data.get('password')),
        passwordConfirmation: String(data.get('passwordConfirmation')),
      }));
    } catch (cause) {
      setError(failure(cause, 'Setup could not be completed.'));
    } finally { setBusy(false); }
  }

  return (
    <section className="auth-card setup-card" aria-labelledby="admin-setup-title">
      <ShieldCheck aria-hidden="true" className="auth-icon" />
      <p className="eyebrow">First-run setup</p>
      <h1 id="admin-setup-title">Create the Admin account</h1>
      {!status.setupPasswordConfigured ? (
        <div className="inline-alert" role="alert">
          Setup is disabled. Set <code>AGT_SETUP_PASSWORD</code> in the server&apos;s <code>.env</code>, restart the stack, and reload this page.
        </div>
      ) : (
        <>
          <p>Enter the one-time setup password from <code>AGT_SETUP_PASSWORD</code>, then choose the Admin username and a new password. The Admin manages members and the installation; it cannot write articles.</p>
          {error && <div className="inline-alert" role="alert">{error}</div>}
          <form className="stack-form" onSubmit={(event) => void submit(event)}>
            <label className="field"><span>Setup password</span><input name="setupPassword" type="password" autoComplete="off" required /></label>
            <label className="field"><span>Admin username</span><input name="username" autoComplete="username" required /></label>
            <label className="field"><span>New password</span><input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
            <label className="field"><span>Confirm new password</span><input name="passwordConfirmation" type="password" autoComplete="new-password" minLength={12} required /></label>
            <p className="field-help">At least 12 characters with uppercase, lowercase, a number, and a symbol; it must differ from the setup password.</p>
            <button className="button button-primary" disabled={busy} type="submit"><ShieldCheck aria-hidden="true" />{busy ? 'Creating…' : 'Complete setup'}</button>
          </form>
        </>
      )}
    </section>
  );
}

function LoginScreen({ notice, onSignedIn }: { notice?: string; onSignedIn(session: AdminSession): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      onSignedIn(await signIn(String(data.get('username')), String(data.get('password'))));
    } catch (cause) {
      setError(failure(cause, 'Sign-in failed.'));
    } finally { setBusy(false); }
  }

  return (
    <section className="auth-card" aria-labelledby="admin-login-title">
      <LockKeyhole aria-hidden="true" className="auth-icon" />
      <p className="eyebrow">Installation administration</p>
      <h1 id="admin-login-title">Admin sign-in</h1>
      {notice && <div className="inline-notice" role="status">{notice}</div>}
      {error && <div className="inline-alert" role="alert">{error}</div>}
      <form className="stack-form" onSubmit={(event) => void submit(event)}>
        <label className="field"><span>Username</span><input name="username" autoComplete="username" required /></label>
        <label className="field"><span>Password</span><input name="password" type="password" autoComplete="current-password" required /></label>
        <button className="button button-primary" disabled={busy} type="submit"><LogIn aria-hidden="true" />{busy ? 'Signing in…' : 'Sign in'}</button>
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

  async function leave() {
    try { await signOut(); } finally { onSignedOut('You have signed out.'); }
  }

  return (
    <div className="page admin-page">
      <header className="admin-header">
        <div><p className="eyebrow">Installation control panel</p><h1>Administration</h1></div>
        <div className="admin-identity">
          <span className="identity-badge admin"><ShieldCheck aria-hidden="true" /> {session.username}</span>
          <button className="icon-button" type="button" onClick={() => void leave()} title="Sign out"><LogOut aria-hidden="true" /><span className="sr-only">Sign out</span></button>
        </div>
      </header>
      {session.setupPasswordSet && (
        <div className="inline-alert" role="alert">
          <code>AGT_SETUP_PASSWORD</code> is still set on the server. It is no longer needed: remove it from <code>.env</code> and restart the stack.
        </div>
      )}
      <nav className="admin-tabs" aria-label="Administration sections">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
            <Icon aria-hidden="true" />{label}
          </button>
        ))}
      </nav>
      {tab === 'users' && <UsersPanel />}
      {tab === 'data' && <DataPanel />}
      {tab === 'settings' && <SettingsPanel />}
      {tab === 'backup' && <BackupPanel onRestored={() => onSignedOut('The backup was restored. Sign in with the Admin account from the backup.')} />}
      {tab === 'account' && <AccountPanel session={session} onSessionRenewed={onSessionChange} />}
    </div>
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
      if (status.required) { setPhase({ name: 'setup', status }); return; }
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

  return (
    <div className="app-shell admin-shell">
      <main id="main-content" className="main-content" tabIndex={-1}>
        {phase.name === 'loading' && <LoadingState message="Checking the Admin session…" />}
        {phase.name === 'error' && (
          <div className="page auth-page"><section className="auth-card"><div className="inline-alert" role="alert">{phase.message}</div>
            <button className="button button-secondary" type="button" onClick={() => { setPhase({ name: 'loading' }); void load(); }}>Try again</button></section></div>
        )}
        {phase.name === 'setup' && <div className="page auth-page"><SetupScreen status={phase.status} onComplete={(session) => setPhase({ name: 'dashboard', session })} /></div>}
        {phase.name === 'login' && <div className="page auth-page"><LoginScreen notice={phase.notice} onSignedIn={(session) => setPhase({ name: 'dashboard', session })} /></div>}
        {phase.name === 'dashboard' && (
          <Dashboard
            session={phase.session}
            onSessionChange={(session) => setPhase({ name: 'dashboard', session })}
            onSignedOut={(notice) => setPhase({ name: 'login', notice })}
          />
        )}
      </main>
    </div>
  );
}
