import { ShieldCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function SetupPage() {
  const { completeSetup } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    const password = String(data.get('password'));
    const passwordConfirmation = String(data.get('passwordConfirmation'));
    if (password !== passwordConfirmation) {
      setError('Passwords do not match.');
      setBusy(false);
      return;
    }
    try {
      await completeSetup({
        username: String(data.get('username')),
        displayName: String(data.get('displayName')),
        email: String(data.get('email') || '') || undefined,
        password,
        passwordConfirmation,
      });
      navigate('/admin', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Setup could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page auth-page">
      <section className="auth-card setup-card" aria-labelledby="setup-title">
        <ShieldCheck aria-hidden="true" className="auth-icon" />
        <p className="eyebrow">First-run setup</p>
        <h1 id="setup-title">Create the super administrator</h1>
        <p>This protected account owns the installation and cannot be deleted, deactivated, or demoted.</p>
        {error && <div className="inline-alert" role="alert">{error}</div>}
        <form className="stack-form" onSubmit={(event) => void submit(event)} noValidate>
          <label className="field"><span>Username</span><input name="username" autoComplete="username" pattern="[a-z0-9_.-]{3,64}" required /></label>
          <label className="field"><span>Display name</span><input name="displayName" autoComplete="name" maxLength={120} required /></label>
          <label className="field"><span>Email (optional)</span><input name="email" type="email" autoComplete="email" maxLength={254} /></label>
          <label className="field"><span>Password</span><input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
          <label className="field"><span>Confirm password</span><input name="passwordConfirmation" type="password" autoComplete="new-password" minLength={12} required /></label>
          <p className="field-help">Use at least 12 characters with uppercase, lowercase, a number, and a symbol.</p>
          <button className="button button-primary" disabled={busy} type="submit">
            <ShieldCheck aria-hidden="true" />{busy ? 'Creating administrator…' : 'Complete setup'}
          </button>
        </form>
      </section>
    </div>
  );
}
