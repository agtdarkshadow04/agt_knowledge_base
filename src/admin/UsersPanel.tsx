import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '../components/Dialog';
import { formErrors, noFormErrors, SelectField, TextField } from '../components/Field';
import { formatTranslation } from '../translations';
import { useAdminI18n } from './context';
import { LoadingState } from '../components/States';
import { parseAdminPasswordWrite, parseAdminUserCreate, parseAdminUserUpdate, validate } from '../lib/validation';
import type { Role, SecurityLevel } from '../lib/api';
import { agtVisibilityOptions } from '../lib/visibility';
import { createUser, deleteUser, listUsers, setUserPassword, updateUser } from './api';
import type { LocalUser, LocalUserListResponse } from './types';

const roleOptions: Role[] = ['Editor', 'Moderator'];

/** The security level select (#70): the AGT levels, by number and name. */
function SecurityLevelField({ defaultValue, error, help }: { defaultValue: SecurityLevel; error?: string; help?: string }) {
  const { t, a, number } = useAdminI18n();
  return (
    <SelectField label={a.users.securityLevel} name="securityLevel" defaultValue={String(defaultValue)} error={error} help={help}>
      {agtVisibilityOptions.map((option) => (
        <option key={option.value} value={option.value}>{formatTranslation(a.users.securityLevelOption, { level: number(option.value), name: t.visibility[option.className] })}</option>
      ))}
    </SelectField>
  );
}

/** A security level's number and name, as the select shows it. */
function useSecurityLevelLabel() {
  const { t, a, number } = useAdminI18n();
  return (level: SecurityLevel) => formatTranslation(a.users.securityLevelOption, { level: number(level), name: t.visibility[agtVisibilityOptions[level].className] });
}

function UserEditor({ account, busy, onChanged, onDelete }: {
  account: LocalUser;
  busy: boolean;
  onChanged(): Promise<void>;
  onDelete(): void;
}) {
  const { t, a } = useAdminI18n();
  const levelLabel = useSecurityLevelLabel();
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState(noFormErrors);
  const [passwordErrors, setPasswordErrors] = useState(noFormErrors);
  const [notice, setNotice] = useState('');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice('');
    const data = new FormData(event.currentTarget);
    const input = {
      username: String(data.get('username')),
      displayName: String(data.get('displayName')),
      email: String(data.get('email') ?? ''),
      role: String(data.get('role')),
      securityLevel: Number(data.get('securityLevel')),
      isActive: data.get('isActive') === 'on',
    };
    const checked = validate(parseAdminUserUpdate, input);
    setErrors(formErrors(checked, t));
    if (!checked.ok) return;
    try {
      await updateUser(account.id, { ...input, role: input.role as Role, securityLevel: input.securityLevel as SecurityLevel, email: input.email.trim() || undefined });
      setNotice(a.users.saved);
      await onChanged();
    } catch (cause) {
      setErrors(formErrors(cause, t));
    }
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault();
    setNotice('');
    const checked = validate(parseAdminPasswordWrite, { password });
    setPasswordErrors(formErrors(checked, t));
    if (!checked.ok) return;
    try {
      await setUserPassword(account.id, password);
      setPassword('');
      setNotice(a.users.passwordChanged);
      await onChanged();
    } catch (cause) {
      setPasswordErrors(formErrors(cause, t));
    }
  }

  return (
    <details className="admin-user-card">
      <summary>
        <span><strong>{account.displayName}</strong><small>@{account.username} · {t.roles[account.role]} · {levelLabel(account.securityLevel)}</small></span>
        <span className={`status-pill ${account.isActive ? 'active' : 'inactive'}`}>{account.isActive ? a.users.active : a.users.inactive}</span>
      </summary>
      <div role="status" aria-live="polite">{notice && <p className="success-note">{notice}</p>}</div>
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <form className="admin-form-grid" noValidate onSubmit={(event) => void save(event)}>
        <TextField label={a.users.username} name="username" defaultValue={account.username} required error={errors.fields.username} />
        <TextField label={a.users.displayName} name="displayName" defaultValue={account.displayName} required error={errors.fields.displayName} />
        <TextField label={a.users.email} name="email" type="email" defaultValue={account.email ?? ''} error={errors.fields.email} />
        <SelectField label={a.users.role} name="role" defaultValue={account.role} error={errors.fields.role}>
          {roleOptions.map((option) => <option key={option} value={option}>{t.roles[option]}</option>)}
        </SelectField>
        <SecurityLevelField defaultValue={account.securityLevel} error={errors.fields.securityLevel} help={a.users.securityLevelHelp} />
        <label className="check-field"><input name="isActive" type="checkbox" defaultChecked={account.isActive} /> {a.users.active}</label>
        <div className="dialog-actions">
          <button className="button button-primary" disabled={busy} type="submit">{a.users.save}</button>
          <button className="button button-danger" disabled={busy} type="button" aria-haspopup="dialog" onClick={onDelete}>{a.users.delete}</button>
        </div>
      </form>
      {passwordErrors.form && <p className="error-note" role="alert">{passwordErrors.form}</p>}
      <form className="password-reset-row" noValidate onSubmit={(event) => void resetPassword(event)}>
        <TextField
          label={a.users.newPassword}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={passwordErrors.fields.password}
        />
        <button className="button button-secondary" disabled={busy || !password} type="submit">{a.users.setPassword}</button>
      </form>
    </details>
  );
}

/**
 * A member who signs in with their AGT account (AGT IAM): their name and role
 * come from IAM at every sign-in, so only activation and deletion are offered.
 */
function AgtUserEditor({ account, busy, onChanged, onDelete }: {
  account: LocalUser;
  busy: boolean;
  onChanged(): Promise<void>;
  onDelete(): void;
}) {
  const { t, a } = useAdminI18n();
  const levelLabel = useSecurityLevelLabel();
  const [errors, setErrors] = useState(noFormErrors);
  const [notice, setNotice] = useState('');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice('');
    const isActive = new FormData(event.currentTarget).get('isActive') === 'on';
    try {
      // Everything but isActive is sent unchanged; the server refuses any other change.
      await updateUser(account.id, { username: account.username, displayName: account.displayName, email: account.email, role: account.role, isActive });
      setErrors(noFormErrors);
      setNotice(a.users.saved);
      await onChanged();
    } catch (cause) {
      setErrors(formErrors(cause, t));
    }
  }

  return (
    <details className="admin-user-card">
      <summary>
        <span><strong>{account.displayName}</strong><small>{a.users.agtBadge} · {t.roles[account.role]} · {levelLabel(account.securityLevel)}</small></span>
        <span className={`status-pill ${account.isActive ? 'active' : 'inactive'}`}>{account.isActive ? a.users.active : a.users.inactive}</span>
      </summary>
      <div role="status" aria-live="polite">{notice && <p className="success-note">{notice}</p>}</div>
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <p className="field-help">{a.users.agtManaged}</p>
      <dl className="account-details">
        <div><dt>{a.users.travellerId}</dt><dd>{account.agtTravellerId ?? t.common.notAvailable}</dd></div>
        <div><dt>{a.users.iamPermission}</dt><dd>{account.iamPermission ?? t.common.notAvailable}</dd></div>
        <div><dt>{a.users.securityLevel}</dt><dd>{levelLabel(account.securityLevel)} <small>{a.users.securityLevelFromIam}</small></dd></div>
      </dl>
      <form className="admin-form-grid" noValidate onSubmit={(event) => void save(event)}>
        <label className="check-field"><input name="isActive" type="checkbox" defaultChecked={account.isActive} /> {a.users.active}</label>
        <div className="dialog-actions">
          <button className="button button-primary" disabled={busy} type="submit">{a.users.save}</button>
          <button className="button button-danger" disabled={busy} type="button" aria-haspopup="dialog" onClick={onDelete}>{a.users.delete}</button>
        </div>
      </form>
    </details>
  );
}

/** Member accounts: Editors and Moderators. The Admin account is not listed here. */
export function UsersPanel() {
  const { t, a, number, error: describe } = useAdminI18n();
  const [users, setUsers] = useState<LocalUserListResponse | null>(null);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<'all' | Role>('all');
  const [active, setActive] = useState<'all' | 'active' | 'inactive'>('all');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createErrors, setCreateErrors] = useState(noFormErrors);
  const [pendingDelete, setPendingDelete] = useState<LocalUser | null>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setUsers(await listUsers({ search, role, active, page }, signal));
  }, [active, page, role, search]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((cause) => {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(describe(cause));
    });
    return () => controller.abort();
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice('');
    const form = event.currentTarget;
    const data = new FormData(form);
    const input = {
      username: String(data.get('username')),
      displayName: String(data.get('displayName')),
      email: String(data.get('email') ?? ''),
      role: String(data.get('role')),
      securityLevel: Number(data.get('securityLevel')),
      password: String(data.get('password')),
    };
    const checked = validate(parseAdminUserCreate, input);
    setCreateErrors(formErrors(checked, t));
    if (!checked.ok) return;
    setBusy(true);
    try {
      await createUser({ ...input, role: input.role as Role, securityLevel: input.securityLevel as SecurityLevel, email: input.email.trim() || undefined });
      form.reset();
      setNotice(formatTranslation(a.users.created, { username: checked.value.username }));
      await load();
    } catch (cause) {
      setCreateErrors(formErrors(cause, t));
    } finally { setBusy(false); }
  }

  async function remove(account: LocalUser) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await deleteUser(account.id);
      setNotice(formatTranslation(a.users.deleted, { username: account.username }));
      await load();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
      setPendingDelete(null);
    }
  }

  return (
    <div className="admin-data-sections">
      {error && <p className="error-note" role="alert">{error}</p>}
      <div role="status" aria-live="polite">{notice && <p className="success-note">{notice}</p>}</div>
      <div className="admin-section-grid">
        <section className="admin-panel" aria-labelledby="create-user-title">
          <h2 id="create-user-title">{a.users.createTitle}</h2>
          {createErrors.form && <p className="error-note" role="alert">{createErrors.form}</p>}
          <form className="stack-form" noValidate onSubmit={(event) => void create(event)}>
            <TextField label={a.users.username} name="username" required autoComplete="off" error={createErrors.fields.username} help={a.users.usernameHelp} />
            <TextField label={a.users.displayName} name="displayName" required error={createErrors.fields.displayName} />
            <TextField label={a.users.emailOptional} name="email" type="email" error={createErrors.fields.email} />
            <SelectField label={a.users.role} name="role" defaultValue="Editor" error={createErrors.fields.role}>
              {roleOptions.map((option) => <option key={option} value={option}>{t.roles[option]}</option>)}
            </SelectField>
            <SecurityLevelField defaultValue={0} error={createErrors.fields.securityLevel} help={a.users.securityLevelHelp} />
            <TextField label={a.users.initialPassword} name="password" type="password" autoComplete="new-password" required error={createErrors.fields.password} help={a.users.passwordHelp} />
            <button className="button button-primary" disabled={busy} type="submit">{a.users.create}</button>
          </form>
          <p className="field-help">{a.users.rolesHelp}</p>
        </section>
        <section className="admin-panel admin-user-list" aria-labelledby="users-title">
          <h2 id="users-title">{a.users.listTitle}</h2>
          <div className="admin-filters">
            <label className="field"><span>{a.users.search}</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label>
            <label className="field"><span>{a.users.role}</span><select value={role} onChange={(event) => { setRole(event.target.value as typeof role); setPage(1); }}>
              <option value="all">{a.users.all}</option>
              {roleOptions.map((option) => <option key={option} value={option}>{t.roles[option]}</option>)}
            </select></label>
            <label className="field"><span>{a.users.status}</span><select value={active} onChange={(event) => { setActive(event.target.value as typeof active); setPage(1); }}><option value="all">{a.users.all}</option><option value="active">{a.users.active}</option><option value="inactive">{a.users.inactive}</option></select></label>
          </div>
          {!users && !error && <LoadingState message={a.users.loading} />}
          {users && <p className="field-help">{formatTranslation(a.users.count, { count: number(users.total) })}</p>}
          {users?.items.map((account) => {
            const Editor = account.authSource === 'agt_iam' ? AgtUserEditor : UserEditor;
            return (
              <Editor
                key={`${account.id}-${account.updatedAt}`}
                account={account}
                busy={busy}
                onChanged={async () => { setBusy(true); try { await load(); } finally { setBusy(false); } }}
                onDelete={() => setPendingDelete(account)}
              />
            );
          })}
          {users && users.totalPages > 1 && <nav className="pagination" aria-label={a.users.pages}><button className="button button-secondary" disabled={users.page <= 1} onClick={() => setPage((current) => current - 1)}>{a.users.previous}</button><span>{formatTranslation(a.users.page, { page: number(users.page), pages: number(users.totalPages) })}</span><button className="button button-secondary" disabled={users.page >= users.totalPages} onClick={() => setPage((current) => current + 1)}>{a.users.next}</button></nav>}
        </section>
      </div>
      {pendingDelete && (
        <ConfirmDialog
          title={formatTranslation(a.users.deleteTitle, { name: pendingDelete.displayName })}
          description={a.users.deleteText}
          confirmLabel={busy ? t.common.deleting : a.users.deleteConfirm}
          danger
          busy={busy}
          onConfirm={() => void remove(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
