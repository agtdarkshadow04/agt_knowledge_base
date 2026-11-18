import { FormEvent, KeyboardEvent, useEffect, useState } from 'react';
import { parseCredentials, parseIamCredentials, validate } from '../lib/validation';
import { useAppSettings } from './AppSettingsContext';
import { useAuth } from './AuthContext';
import { formErrors, noFormErrors, TextField } from './Field';
import { useI18n } from './I18n';
import { LockKeyholeIcon, LogInIcon } from './Icons';
import { useNavigation } from './Navigation';

type Method = 'local' | 'agt';
const methods: Method[] = ['local', 'agt'];
const tabId = (method: Method) => `login-method-${method}`;
const panelId = 'login-method-panel';

export function LoginPage() {
  const { user, signIn, signInWithAgt } = useAuth();
  const { settings } = useAppSettings();
  const { route, navigate } = useNavigation();
  const next = route.page === 'login' ? route.next : null;
  const { t } = useI18n();
  const [errors, setErrors] = useState(noFormErrors);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<Method>('local');
  // AGT sign-in is offered only while the server says it is on and configured (issue #30).
  const method: Method = settings.iam.signIn ? chosen : 'local';

  // Once signed in, continue to the page that asked for the sign-in (only pages of this app, FE-4).
  useEffect(() => { if (user && next !== null) navigate(next, { replace: true }); }, [navigate, next, user]);
  if (user) return null;

  function choose(next: Method) {
    setChosen(next);
    setErrors(noFormErrors);
  }

  function chooseWithKeys(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: methods.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const target = methods[(moves[event.key] + methods.length) % methods.length];
    choose(target);
    document.getElementById(tabId(target))?.focus();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = String(data.get('password'));
    if (method === 'agt') {
      const input = { travellerName: String(data.get('travellerName')), password };
      const checked = validate(parseIamCredentials, input);
      setErrors(formErrors(checked, t));
      if (!checked.ok) return;
      setBusy(true);
      try {
        await signInWithAgt(input.travellerName, input.password);
      } catch (cause) {
        setErrors(formErrors(cause, t));
      } finally { setBusy(false); }
      return;
    }
    const input = { username: String(data.get('username')), password };
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

  const form = (
    <form key={method} onSubmit={handleSubmit} className="stack-form" noValidate>
      {method === 'agt' ? (
        <TextField label={t.login.travellerName} name="travellerName" autoComplete="username" required error={errors.fields.travellerName} />
      ) : (
        <TextField label={t.login.username} name="username" autoComplete="username" required error={errors.fields.username} />
      )}
      <TextField
        label={t.login.password}
        name="password"
        type="password"
        autoComplete="current-password"
        required
        error={errors.fields.password}
      />
      <button className="button button-primary" disabled={busy} type="submit"><LogInIcon />{busy ? t.login.submitting : t.login.submit}</button>
    </form>
  );

  return (
    <div className="page auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <LockKeyholeIcon className="auth-icon" />
        <p className="eyebrow">{t.login.eyebrow}</p>
        <h1 id="login-title">{t.login.title}</h1>
        {settings.iam.signIn && (
          <div className="auth-methods" role="tablist" aria-label={t.login.methods}>
            {methods.map((option, index) => (
              <button
                key={option}
                id={tabId(option)}
                type="button"
                role="tab"
                className="button"
                aria-selected={method === option}
                aria-controls={panelId}
                tabIndex={method === option ? 0 : -1}
                onClick={() => choose(option)}
                onKeyDown={(event) => chooseWithKeys(event, index)}
              >
                {option === 'agt' ? t.login.agtTab : t.login.localTab}
              </button>
            ))}
          </div>
        )}
        <div className="auth-method-panel" {...(settings.iam.signIn ? { role: 'tabpanel', id: panelId, 'aria-labelledby': tabId(method) } : {})}>
          <p>{method === 'agt' ? t.login.agtText : t.login.text}</p>
          {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
          {form}
        </div>
      </section>
    </div>
  );
}
