import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { LoadingState } from '../components/States';
import type { UserRole } from '../types';
import { createUser, deleteUser, listUsers, setUserPassword, updateUser } from './api';
import type { LocalUser, LocalUserListResponse } from './types';

const roleOptions: { value: UserRole; label: string }[] = [
  { value: 'Editor', label: 'Editor' },
  { value: 'Moderator', label: 'Moderator' },
];

function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

function UserEditor({ account, busy, onChanged, onDelete, onError }: {
  account: LocalUser;
  busy: boolean;
  onChanged(): Promise<void>;
  onDelete(): Promise<void>;
  onError(message: string): void;
}) {
  const [password, setPassword] = useState('');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await updateUser(account.id, {
        username: String(data.get('username')),
        displayName: String(data.get('displayName')),
        email: String(data.get('email') || '') || undefined,
        role: String(data.get('role')) as UserRole,
        isActive: data.get('isActive') === 'on',
      });
      await onChanged();
    } catch (cause) {
      onError(message(cause, 'The user could not be updated.'));
    }
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault();
    try {
      await setUserPassword(account.id, password);
      setPassword('');
      await onChanged();
    } catch (cause) {
      onError(message(cause, 'The password could not be changed.'));
    }
  }

  return (
    <details className="admin-user-card">
      <summary>
        <span><strong>{account.displayName}</strong><small>@{account.username} · {account.role}</small></span>
        <span className={`status-pill ${account.isActive ? 'active' : 'inactive'}`}>{account.isActive ? 'Active' : 'Inactive'}</span>
      </summary>
      <form className="admin-form-grid" onSubmit={(event) => void save(event)}>
        <label className="field"><span>Username</span><input name="username" defaultValue={account.username} required /></label>
        <label className="field"><span>Display name</span><input name="displayName" defaultValue={account.displayName} required /></label>
        <label className="field"><span>Email</span><input name="email" type="email" defaultValue={account.email ?? ''} /></label>
        <label className="field"><span>Role</span><select name="role" defaultValue={account.role}>
          {roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
        <label className="check-field"><input name="isActive" type="checkbox" defaultChecked={account.isActive} /> Active</label>
        <div className="dialog-actions">
          <button className="button button-primary" disabled={busy} type="submit">Save user</button>
          <button className="button button-danger" disabled={busy} type="button" onClick={() => void onDelete()}>Delete user</button>
        </div>
      </form>
      <form className="password-reset-row" onSubmit={(event) => void resetPassword(event)}>
        <label className="field"><span>New password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} required /></label>
        <button className="button button-secondary" disabled={busy || password.length < 12} type="submit">Set password</button>
      </form>
    </details>
  );
}

/** Member accounts: Editors and Moderators. The Admin account is not listed here. */
export function UsersPanel() {
  const [users, setUsers] = useState<LocalUserListResponse | null>(null);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<'all' | UserRole>('all');
  const [active, setActive] = useState<'all' | 'active' | 'inactive'>('all');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
    setBusy(true);
    setError('');
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await createUser({
        username: String(data.get('username')),
        displayName: String(data.get('displayName')),
        email: String(data.get('email') || '') || undefined,
        role: String(data.get('role')) as UserRole,
        password: String(data.get('password')),
      });
      form.reset();
      await load();
    } catch (cause) {
      setError(message(cause, 'The user could not be created.'));
    } finally { setBusy(false); }
  }

  async function remove(account: LocalUser) {
    if (!window.confirm(`Delete “${account.displayName}” permanently?`)) return;
    setBusy(true);
    setError('');
    try {
      await deleteUser(account.id);
      await load();
    } catch (cause) {
      setError(message(cause, 'The user could not be deleted.'));
    } finally { setBusy(false); }
  }

  return (
    <div className="admin-data-sections">
      {error && <div className="inline-alert" role="alert">{error}</div>}
      <div className="admin-section-grid">
        <section className="admin-panel" aria-labelledby="create-user-title">
          <h2 id="create-user-title">Create user</h2>
          <form className="stack-form" onSubmit={(event) => void create(event)}>
            <label className="field"><span>Username</span><input name="username" required /></label>
            <label className="field"><span>Display name</span><input name="displayName" required /></label>
            <label className="field"><span>Email (optional)</span><input name="email" type="email" /></label>
            <label className="field"><span>Role</span><select name="role" defaultValue="Editor">
              {roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select></label>
            <label className="field"><span>Initial password</span><input name="password" type="password" minLength={12} required /></label>
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
              onDelete={() => remove(account)}
              onError={setError}
            />
          ))}
          {users && users.totalPages > 1 && <nav className="pagination" aria-label="User pages"><button className="button button-secondary" disabled={users.page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button><span>Page {users.page} of {users.totalPages}</span><button className="button button-secondary" disabled={users.page >= users.totalPages} onClick={() => setPage((current) => current + 1)}>Next</button></nav>}
        </section>
      </div>
    </div>
  );
}
