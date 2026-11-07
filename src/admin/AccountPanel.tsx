import { type FormEvent, useState } from 'react';
import { changePassword } from './api';
import type { AdminSession } from './types';

/** Changes the Admin password. Every Admin session is revoked and this one is renewed. */
export function AccountPanel({ session, onSessionRenewed }: { session: AdminSession; onSessionRenewed(session: AdminSession): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError('');
    setDone(false);
    try {
      const renewed = await changePassword({
        currentPassword: String(data.get('currentPassword')),
        password: String(data.get('password')),
        passwordConfirmation: String(data.get('passwordConfirmation')),
      });
      form.reset();
      setDone(true);
      onSessionRenewed(renewed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The password could not be changed.');
    } finally { setBusy(false); }
  }

  return (
    <section className="admin-panel settings-admin-panel" aria-labelledby="account-title">
      <h2 id="account-title">Account</h2>
      <dl className="account-details"><div><dt>Admin username</dt><dd>{session.username}</dd></div></dl>
      <p className="field-help">Changing the password signs out every other Admin session.</p>
      {error && <div className="inline-alert" role="alert">{error}</div>}
      {done && <div className="inline-notice" role="status">Password changed. Other Admin sessions have been signed out.</div>}
      <form className="stack-form" onSubmit={(event) => void submit(event)}>
        <label className="field"><span>Current password</span><input name="currentPassword" type="password" autoComplete="current-password" required /></label>
        <label className="field"><span>New password</span><input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
        <label className="field"><span>Confirm new password</span><input name="passwordConfirmation" type="password" autoComplete="new-password" minLength={12} required /></label>
        <div className="dialog-actions"><button className="button button-primary" disabled={busy} type="submit">Change password</button></div>
      </form>
    </section>
  );
}
