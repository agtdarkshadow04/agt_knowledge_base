import { type FormEvent, useState } from 'react';
import { formErrors, noFormErrors, TextField } from '../components/Field';
import { useAdminI18n } from './context';
import { parseAdminAccountPassword, validate } from '../lib/validation';
import { changePassword } from './api';
import type { AdminSession } from './types';

/** Changes the Admin password. Every Admin session is revoked and this one is renewed. */
export function AccountPanel({ session, onSessionRenewed }: { session: AdminSession; onSessionRenewed(session: AdminSession): void }) {
  const { t, a } = useAdminI18n();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState(noFormErrors);
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
    setErrors(formErrors(checked, t));
    if (!checked.ok) return;
    setBusy(true);
    try {
      const renewed = await changePassword(input);
      form.reset();
      setDone(true);
      onSessionRenewed(renewed);
    } catch (cause) {
      setErrors(formErrors(cause, t));
    } finally { setBusy(false); }
  }

  return (
    <section className="admin-panel settings-admin-panel" aria-labelledby="account-title">
      <h2 id="account-title">{a.account.title}</h2>
      <dl className="account-details"><div><dt>{a.account.username}</dt><dd>{session.username}</dd></div></dl>
      <p className="field-help">{a.account.help}</p>
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <div role="status" aria-live="polite">{done && <p className="success-note">{a.account.done}</p>}</div>
      <form className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
        <TextField label={a.account.currentPassword} name="currentPassword" type="password" autoComplete="current-password" required error={errors.fields.currentPassword} />
        <TextField label={a.account.newPassword} name="password" type="password" autoComplete="new-password" required error={errors.fields.password} help={a.account.passwordHelp} />
        <TextField label={a.account.confirm} name="passwordConfirmation" type="password" autoComplete="new-password" required error={errors.fields.passwordConfirmation} />
        <div className="dialog-actions"><button className="button button-primary" disabled={busy} type="submit">{busy ? a.account.submitting : a.account.submit}</button></div>
      </form>
    </section>
  );
}
