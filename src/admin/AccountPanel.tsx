import { type FormEvent, useState } from 'react';
import { formErrors, TextField } from '../components/Field';
import { parseAdminAccountPassword, validate } from '../lib/validation';
import { changePassword } from './api';
import type { AdminSession } from './types';

/** Changes the Admin password. Every Admin session is revoked and this one is renewed. */
export function AccountPanel({ session, onSessionRenewed }: { session: AdminSession; onSessionRenewed(session: AdminSession): void }) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ fields: Record<string, string>; form: string }>({ fields: {}, form: '' });
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const input = {
      currentPassword: String(data.get('currentPassword')),
      password: String(data.get('password')),
      passwordConfirmation: String(data.get('passwordConfirmation')),
    };
    setDone(false);
    // FE-6: the server's own rules first; it stays the authority.
    const checked = validate(parseAdminAccountPassword, input);
    setErrors(formErrors(checked, ''));
    if (!checked.ok) return;
    setBusy(true);
    try {
      const renewed = await changePassword(input);
      form.reset();
      setDone(true);
      onSessionRenewed(renewed);
    } catch (cause) {
      setErrors(formErrors(cause, 'The password could not be changed.'));
    } finally { setBusy(false); }
  }

  return (
    <section className="admin-panel settings-admin-panel" aria-labelledby="account-title">
      <h2 id="account-title">Account</h2>
      <dl className="account-details"><div><dt>Admin username</dt><dd>{session.username}</dd></div></dl>
      <p className="field-help">Changing the password signs out every other Admin session.</p>
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <div role="status" aria-live="polite">{done && <p className="success-note">Password changed. Other Admin sessions have been signed out.</p>}</div>
      <form className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
        <TextField label="Current password" name="currentPassword" type="password" autoComplete="current-password" required error={errors.fields.currentPassword} />
        <TextField label="New password" name="password" type="password" autoComplete="new-password" required error={errors.fields.password} help="At least 12 characters with uppercase, lowercase, a number and a symbol." />
        <TextField label="Confirm new password" name="passwordConfirmation" type="password" autoComplete="new-password" required error={errors.fields.passwordConfirmation} />
        <div className="dialog-actions"><button className="button button-primary" disabled={busy} type="submit">{busy ? 'Changing…' : 'Change password'}</button></div>
      </form>
    </section>
  );
}
