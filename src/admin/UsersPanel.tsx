import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '../components/Dialog';
import { formErrors, SelectField, TextField } from '../components/Field';
import { LoadingState } from '../components/States';
import { parseAdminPasswordWrite, parseAdminUserCreate, parseAdminUserUpdate, validate } from '../lib/validation';
import type { Role } from '../lib/api';
import { createUser, deleteUser, listUsers, setUserPassword, updateUser } from './api';
import type { LocalUser, LocalUserListResponse } from './types';

const roleOptions: { value: Role; label: string }[] = [
  { value: 'Editor', label: 'Editor' },
  { value: 'Moderator', label: 'Moderator' },
];

function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

type Errors = { fields: Record<string, string>; form: string };
const noErrors: Errors = { fields: {}, form: '' };

function UserEditor({ account, busy, onChanged, onDelete }: {
  account: LocalUser;
  busy: boolean;
  onChanged(): Promise<void>;
  onDelete(): void;
}) {
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>(noErrors);
  const [passwordErrors, setPasswordErrors] = useState<Errors>(noErrors);
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
      isActive: data.get('isActive') === 'on',
    };
    const checked = validate(parseAdminUserUpdate, input);
    setErrors(formErrors(checked, ''));
    if (!checked.ok) return;
    try {
      await updateUser(account.id, { ...input, role: input.role as Role, email: input.email.trim() || undefined });
      setNotice('Saved.');
      await onChanged();
    } catch (cause) {
      setErrors(formErrors(cause, 'The user could not be updated.'));
    }
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault();
    setNotice('');
    const checked = validate(parseAdminPasswordWrite, { password });
    setPasswordErrors(formErrors(checked, ''));
    if (!checked.ok) return;
    try {
      await setUserPassword(account.id, password);
      setPassword('');
      setNotice('The password was changed and the member was signed out everywhere.');
      await onChanged();
    } catch (cause) {
      setPasswordErrors(formErrors(cause, 'The password could not be changed.'));
    }
  }

  return (
    <details className="admin-user-card">
      <summary>
        <span><strong>{account.displayName}</strong><small>@{account.username} · {account.role}</small></span>
        <span className={`status-pill ${account.isActive ? 'active' : 'inactive'}`}>{account.isActive ? 'Active' : 'Inactive'}</span>
      </summary>
      <div role="status" aria-live="polite">{notice && <p className="success-note">{notice}</p>}</div>
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <form className="admin-form-grid" noValidate onSubmit={(event) => void save(event)}>
        <TextField label="Username" name="username" defaultValue={account.username} required error={errors.fields.username} />
        <TextField label="Display name" name="displayName" defaultValue={account.displayName} required error={errors.fields.displayName} />
        <TextField label="Email" name="email" type="email" defaultValue={account.email ?? ''} error={errors.fields.email} />
        <SelectField label="Role" name="role" defaultValue={account.role} error={errors.fields.role}>
          {roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </SelectField>
        <label className="check-field"><input name="isActive" type="checkbox" defaultChecked={account.isActive} /> Active</label>
        <div className="dialog-actions">
          <button className="button button-primary" disabled={busy} type="submit">Save user</button>
          <button className="button button-danger" disabled={busy} type="button" aria-haspopup="dialog" onClick={onDelete}>Delete user</button>
        </div>
      </form>
      {passwordErrors.form && <p className="error-note" role="alert">{passwordErrors.form}</p>}
      <form className="password-reset-row" noValidate onSubmit={(event) => void resetPassword(event)}>
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={passwordErrors.fields.password}
        />
        <button className="button button-secondary" disabled={busy || !password} type="submit">Set password</button>
      </form>
    </details>
  );
}

/** Member accounts: Editors and Moderators. The Admin account is not listed here. */
export function UsersPanel() {
  const [users, setUsers] = useState<LocalUserListResponse | null>(null);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<'all' | Role>('all');
  const [active, setActive] = useState<'all' | 'active' | 'inactive'>('all');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createErrors, setCreateErrors] = useState<Errors>(noErrors);
  const [pendingDelete, setPendingDelete] = useState<LocalUser | null>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setUsers(await listUsers({ search, role, active, page }, signal));
  }, [active, page, role, search]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((cause) => {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(message(cause, 'Users could not be loaded.'));
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
      password: String(data.get('password')),
    };
    const checked = validate(parseAdminUserCreate, input);
    setCreateErrors(formErrors(checked, ''));
    if (!checked.ok) return;
    setBusy(true);
    try {
      await createUser({ ...input, role: input.role as Role, email: input.email.trim() || undefined });
      form.reset();
      setNotice(`The account “${checked.value.username}” was created.`);
      await load();
    } catch (cause) {
      setCreateErrors(formErrors(cause, 'The user could not be created.'));
    } finally { setBusy(false); }
  }

  async function remove(account: LocalUser) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await deleteUser(account.id);
      setNotice(`The account “${account.username}” was deleted.`);
      await load();
    } catch (cause) {
      setError(message(cause, 'The user could not be deleted.'));
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
          <h2 id="create-user-title">Create user</h2>
          {createErrors.form && <p className="error-note" role="alert">{createErrors.form}</p>}
          <form className="stack-form" noValidate onSubmit={(event) => void create(event)}>
            <TextField label="Username" name="username" required autoComplete="off" error={createErrors.fields.username} help="3–64 lowercase letters, numbers, dots, underscores or hyphens." />
            <TextField label="Display name" name="displayName" required error={createErrors.fields.displayName} />
            <TextField label="Email (optional)" name="email" type="email" error={createErrors.fields.email} />
            <SelectField label="Role" name="role" defaultValue="Editor" error={createErrors.fields.role}>
              {roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </SelectField>
            <TextField label="Initial password" name="password" type="password" autoComplete="new-password" required error={createErrors.fields.password} help="At least 12 characters with uppercase, lowercase, a number and a symbol." />
            <button className="button button-primary" disabled={busy} type="submit">Create user</button>
          </form>
          <p className="field-help">Editors write articles and edit unprotected ones. Moderators also protect, pin, verify, restore, and delete articles, see every visibility level, and manage tags.</p>
        </section>
        <section className="admin-panel admin-user-list" aria-labelledby="users-title">
          <h2 id="users-title">Users</h2>
          <div className="admin-filters">
            <label className="field"><span>Search</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label>
            <label className="field"><span>Role</span><select value={role} onChange={(event) => { setRole(event.target.value as typeof role); setPage(1); }}>
              <option value="all">All</option>
              {roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select></label>
            <label className="field"><span>Status</span><select value={active} onChange={(event) => { setActive(event.target.value as typeof active); setPage(1); }}><option value="all">All</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
          </div>
          {!users && !error && <LoadingState message="Loading users…" />}
          {users && <p className="field-help">{users.total} users</p>}
          {users?.items.map((account) => (
            <UserEditor
              key={`${account.id}-${account.updatedAt}`}
              account={account}
              busy={busy}
              onChanged={async () => { setBusy(true); try { await load(); } finally { setBusy(false); } }}
              onDelete={() => setPendingDelete(account)}
            />
          ))}
          {users && users.totalPages > 1 && <nav className="pagination" aria-label="User pages"><button className="button button-secondary" disabled={users.page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button><span>Page {users.page} of {users.totalPages}</span><button className="button button-secondary" disabled={users.page >= users.totalPages} onClick={() => setPage((current) => current + 1)}>Next</button></nav>}
        </section>
      </div>
      {pendingDelete && (
        <ConfirmDialog
          title={`Delete “${pendingDelete.displayName}”?`}
          description="The account is deleted permanently and signed out everywhere. This cannot be undone."
          confirmLabel={busy ? 'Deleting…' : 'Delete account'}
          danger
          busy={busy}
          onConfirm={() => void remove(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
