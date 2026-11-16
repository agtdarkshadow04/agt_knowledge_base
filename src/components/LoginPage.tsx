import { FormEvent, useEffect, useState } from 'react';
import { parseCredentials, validate } from '../lib/validation';
import { useAuth } from './AuthContext';
import { formErrors, TextField } from './Field';
import { LockKeyholeIcon, LogInIcon } from './Icons';
import { useNavigation } from './Navigation';

export function LoginPage() {
  const { user, signIn } = useAuth();
  const { route, navigate } = useNavigation();
  const next = route.page === 'login' ? route.next : null;
  const [errors, setErrors] = useState<{ fields: Record<string, string>; form: string }>({ fields: {}, form: '' });
  const [busy, setBusy] = useState(false);

  // Once signed in, continue to the page that asked for the sign-in (only pages of this app, FE-4).
  useEffect(() => { if (user && next !== null) navigate(next, { replace: true }); }, [navigate, next, user]);
  if (user) return null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = { username: String(data.get('username')), password: String(data.get('password')) };
    const checked = validate(parseCredentials, input);
    setErrors(formErrors(checked, ''));
    if (!checked.ok) return;
    setBusy(true);
    try {
      await signIn(input.username, input.password);
    } catch (cause) {
      setErrors(formErrors(cause, 'Sign-in failed.'));
    } finally { setBusy(false); }
  }

  return (
    <div className="page auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <LockKeyholeIcon className="auth-icon" />
        <p className="eyebrow">Traveller authorization</p>
        <h1 id="login-title">Sign in</h1>
        <p>Use your locally managed AGT account to create and maintain archive entries.</p>
        {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
        <form onSubmit={handleSubmit} className="stack-form" noValidate>
          <TextField label="Username or email" name="username" autoComplete="username" required error={errors.fields.username} />
          <TextField label="Password" name="password" type="password" autoComplete="current-password" required error={errors.fields.password} />
          <button className="button button-primary" disabled={busy} type="submit"><LogInIcon />{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </section>
    </div>
  );
}
