import { LockKeyhole, LogIn } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function LoginPage() {
  const { user, configured, authMode, signIn, completeNewPassword } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newPasswordRequired, setNewPasswordRequired] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      const result = await signIn(String(data.get('username')), String(data.get('password')));
      if (result === 'NEW_PASSWORD_REQUIRED') {
        setNewPasswordRequired(true);
        return;
      }
      const from = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(from, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed.');
    } finally { setBusy(false); }
  }

  async function handleNewPasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    const newPassword = String(data.get('newPassword'));
    const confirmPassword = String(data.get('confirmPassword'));
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      setBusy(false);
      return;
    }
    try {
      await completeNewPassword(newPassword);
      const from = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(from, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Password change failed.');
    } finally { setBusy(false); }
  }

  return (
    <div className="page auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <LockKeyhole aria-hidden="true" className="auth-icon" />
        <p className="eyebrow">Traveller authorization</p>
        <h1 id="login-title">{newPasswordRequired ? 'Choose a permanent password' : 'Sign in'}</h1>
        <p>{newPasswordRequired
          ? 'Your temporary password was accepted. Set a permanent password to finish signing in.'
          : authMode === 'local'
            ? 'Use your locally managed AGT account to create and maintain archive entries.'
            : 'Use your AGT Cognito account to create and maintain archive entries.'}</p>
        {!configured && <div className="inline-alert" role="alert">Authentication is not configured in this environment.</div>}
        {error && <div className="inline-alert" role="alert">{error}</div>}
        {newPasswordRequired ? (
          <form key="new-password" onSubmit={handleNewPasswordSubmit} className="stack-form">
            <label className="field"><span>New password</span><input name="newPassword" type="password" autoComplete="new-password" minLength={12} required /></label>
            <label className="field"><span>Confirm new password</span><input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} required /></label>
            <p className="field-help">Use at least 12 characters with uppercase, lowercase, a number, and a symbol.</p>
            <button className="button button-primary" disabled={busy || !configured} type="submit"><LogIn aria-hidden="true" />{busy ? 'Setting password…' : 'Set password and sign in'}</button>
          </form>
        ) : (
          <form key="credentials" onSubmit={handleSubmit} className="stack-form">
            <label className="field"><span>Username or email</span><input name="username" autoComplete="username" required /></label>
            <label className="field"><span>Password</span><input name="password" type="password" autoComplete="current-password" required /></label>
            <button className="button button-primary" disabled={busy || !configured} type="submit"><LogIn aria-hidden="true" />{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
        )}
      </section>
    </div>
  );
}
