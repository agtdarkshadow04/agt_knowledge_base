import { FormEvent, useEffect, useState } from 'react';
import { parseCredentials, validate } from '../lib/validation';
import { useAuth } from './AuthContext';
import { formErrors, noFormErrors, TextField } from './Field';
import { useI18n } from './I18n';
import { LockKeyholeIcon, LogInIcon } from './Icons';
import { useNavigation } from './Navigation';

export function LoginPage() {
  const { user, signIn } = useAuth();
  const { route, navigate } = useNavigation();
  const next = route.page === 'login' ? route.next : null;
  const { t } = useI18n();
  const [errors, setErrors] = useState(noFormErrors);
  const [busy, setBusy] = useState(false);

  // Once signed in, continue to the page that asked for the sign-in (only pages of this app, FE-4).
  useEffect(() => { if (user && next !== null) navigate(next, { replace: true }); }, [navigate, next, user]);
  if (user) return null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = { username: String(data.get('username')), password: String(data.get('password')) };
    const checked = validate(parseCredentials, input);
    setErrors(formErrors(checked, t));
    if (!checked.ok) return;
    setBusy(true);
    try {
      await signIn(input.username, input.password);
    } catch (cause) {
      setErrors(formErrors(cause, t));
    } finally { setBusy(false); }
  }

  return (
    <div className="page auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <LockKeyholeIcon className="auth-icon" />
        <p className="eyebrow">{t.login.eyebrow}</p>
        <h1 id="login-title">{t.login.title}</h1>
        <p>{t.login.text}</p>
        {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
        <form onSubmit={handleSubmit} className="stack-form" noValidate>
          <TextField label={t.login.username} name="username" autoComplete="username" required error={errors.fields.username} />
          <TextField label={t.login.password} name="password" type="password" autoComplete="current-password" required error={errors.fields.password} />
          <button className="button button-primary" disabled={busy} type="submit"><LogInIcon />{busy ? t.login.submitting : t.login.submit}</button>
        </form>
      </section>
    </div>
  );
}
