import { LockKeyhole, LogIn } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function LoginPage() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      await signIn(String(data.get('username')), String(data.get('password')));
      const from = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(from, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed.');
    } finally { setBusy(false); }
  }

  return (
    <div className="page auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <LockKeyhole aria-hidden="true" className="auth-icon" />
        <p className="eyebrow">Traveller authorization</p>
        <h1 id="login-title">Sign in</h1>
        <p>Use your locally managed AGT account to create and maintain archive entries.</p>
        {error && <div className="inline-alert" role="alert">{error}</div>}
        <form onSubmit={handleSubmit} className="stack-form">
          <label className="field"><span>Username or email</span><input name="username" autoComplete="username" required /></label>
          <label className="field"><span>Password</span><input name="password" type="password" autoComplete="current-password" required /></label>
          <button className="button button-primary" disabled={busy} type="submit"><LogIn aria-hidden="true" />{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </section>
    </div>
  );
}
