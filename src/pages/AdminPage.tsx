import { Database, Settings, ShieldCheck, Users } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ManageTagsPanel } from '../components/ManageTagsModal';
import { LoadingState } from '../components/States';
import {
  createLocalUser,
  deleteLocalUser,
  getAdminStats,
  listAdminArticles,
  listLocalUsers,
  setLocalUserPassword,
  updateApplicationSettings,
  updateLocalUser,
} from '../services/api';
import { useAppSettings } from '../settings/AppSettingsContext';
import type {
  AdminStats,
  ApplicationSettings,
  ArticleListResponse,
  LocalUser,
  LocalUserListResponse,
  UserRole,
} from '../types';

type Section = 'users' | 'data' | 'settings';

function UserEditor({ account, currentUserId, busy, onChanged, onDelete, onError }: {
  account: LocalUser;
  currentUserId: string;
  busy: boolean;
  onChanged(): Promise<void>;
  onDelete(): Promise<void>;
  onError(message: string): void;
}) {
  const { getToken, refresh } = useAuth();
  const [password, setPassword] = useState('');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await updateLocalUser(account.id, {
        username: String(data.get('username')),
        displayName: String(data.get('displayName')),
        email: String(data.get('email') || '') || undefined,
        role: String(data.get('role')) as UserRole,
        isActive: data.get('isActive') === 'on',
      }, await getToken());
      if (account.id === currentUserId) {
        await refresh();
        return;
      }
      await onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'The user could not be updated.');
    }
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault();
    try {
      await setLocalUserPassword(account.id, password, await getToken());
      setPassword('');
      if (account.id === currentUserId) {
        await refresh();
        return;
      }
      await onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'The password could not be changed.');
    }
  }

  return (
    <details className="admin-user-card">
      <summary>
        <span><strong>{account.displayName}</strong><small>@{account.username} · {account.role}</small></span>
        <span className={`status-pill ${account.isActive ? 'active' : 'inactive'}`}>
          {account.isSuperAdmin ? 'Super admin' : account.isActive ? 'Active' : 'Inactive'}
        </span>
      </summary>
      <form className="admin-form-grid" onSubmit={(event) => void save(event)}>
        <label className="field"><span>Username</span><input name="username" defaultValue={account.username} required /></label>
        <label className="field"><span>Display name</span><input name="displayName" defaultValue={account.displayName} required /></label>
        <label className="field"><span>Email</span><input name="email" type="email" defaultValue={account.email ?? ''} /></label>
        <label className="field"><span>Role</span><select name="role" defaultValue={account.role} disabled={account.isSuperAdmin}>
          <option value="Standard">Standard</option><option value="Admin">Admin</option>
        </select></label>
        {account.isSuperAdmin && <input type="hidden" name="role" value="Admin" />}
        <label className="check-field"><input name="isActive" type="checkbox" defaultChecked={account.isActive} disabled={account.isSuperAdmin || account.id === currentUserId} /> Active</label>
        {(account.isSuperAdmin || account.id === currentUserId) && <input type="hidden" name="isActive" value="on" />}
        <div className="dialog-actions">
          <button className="button button-primary" disabled={busy} type="submit">Save user</button>
          <button className="button button-danger" disabled={busy || account.isSuperAdmin || account.id === currentUserId} type="button" onClick={() => void onDelete()}>Delete user</button>
        </div>
      </form>
      <form className="password-reset-row" onSubmit={(event) => void resetPassword(event)}>
        <label className="field"><span>New password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} required /></label>
        <button className="button button-secondary" disabled={busy || password.length < 12} type="submit">Set password</button>
      </form>
    </details>
  );
}

export function AdminPage() {
  const { user, getToken } = useAuth();
  const { settings, setSettings } = useAppSettings();
  const [section, setSection] = useState<Section>('users');
  const [users, setUsers] = useState<LocalUserListResponse | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [articles, setArticles] = useState<ArticleListResponse | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<ApplicationSettings>(settings);
  const [userSearch, setUserSearch] = useState('');
  const [userRole, setUserRole] = useState<'all' | UserRole>('all');
  const [userActive, setUserActive] = useState<'all' | 'active' | 'inactive'>('all');
  const [userPage, setUserPage] = useState(1);
  const [articleSearch, setArticleSearch] = useState('');
  const [articleVisibility, setArticleVisibility] = useState<'all' | 'public' | 'internal' | 'admin'>('all');
  const [articleProtection, setArticleProtection] = useState<'all' | 'protected' | 'unprotected'>('all');
  const [articleVerification, setArticleVerification] = useState<'all' | 'verified' | 'unverified'>('all');
  const [articlePage, setArticlePage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loadedSections = useRef(new Set<Section>());

  const loadUsers = useCallback(async (signal?: AbortSignal) => {
    const token = await getToken();
    setUsers(await listLocalUsers({ search: userSearch, role: userRole, active: userActive, page: userPage }, token, signal));
  }, [getToken, userActive, userPage, userRole, userSearch]);

  const loadData = useCallback(async (signal?: AbortSignal) => {
    const token = await getToken();
    const [nextStats, nextArticles] = await Promise.all([
      getAdminStats(token, signal),
      listAdminArticles({
        search: articleSearch,
        visibility: articleVisibility,
        protection: articleProtection,
        verification: articleVerification,
        page: articlePage,
        pageSize: 50,
      }, token, signal),
    ]);
    setStats(nextStats);
    setArticles(nextArticles);
  }, [articlePage, articleProtection, articleSearch, articleVerification, articleVisibility, getToken]);

  useEffect(() => { setSettingsDraft(settings); }, [settings]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(!loadedSections.current.has(section));
    setError('');
    const load = section === 'users' ? loadUsers(controller.signal)
      : section === 'data' ? loadData(controller.signal)
        : Promise.resolve();
    void load.then(() => loadedSections.current.add(section)).catch((cause) => {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : 'Administrator data could not be loaded.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [loadData, loadUsers, section]);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await createLocalUser({
        username: String(data.get('username')),
        displayName: String(data.get('displayName')),
        email: String(data.get('email') || '') || undefined,
        role: String(data.get('role')) as UserRole,
        password: String(data.get('password')),
      }, await getToken());
      form.reset();
      await loadUsers();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The user could not be created.');
    } finally { setBusy(false); }
  }

  async function removeUser(account: LocalUser) {
    if (!window.confirm(`Delete “${account.displayName}” permanently?`)) return;
    setBusy(true);
    setError('');
    try {
      await deleteLocalUser(account.id, await getToken());
      await loadUsers();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The user could not be deleted.');
    } finally { setBusy(false); }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const saved = await updateApplicationSettings(settingsDraft, await getToken());
      setSettings(saved);
      setSettingsDraft(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Application settings could not be saved.');
    } finally { setBusy(false); }
  }

  return (
    <div className="page admin-page">
      <header className="admin-header">
        <div><p className="eyebrow">Protected control plane</p><h1>Administration</h1></div>
        <span className="identity-badge admin"><ShieldCheck aria-hidden="true" /> {user?.displayName}</span>
      </header>
      <nav className="admin-tabs" aria-label="Administration sections">
        <button className={section === 'users' ? 'active' : ''} onClick={() => setSection('users')}><Users aria-hidden="true" />Users</button>
        <button className={section === 'data' ? 'active' : ''} onClick={() => setSection('data')}><Database aria-hidden="true" />Data</button>
        <button className={section === 'settings' ? 'active' : ''} onClick={() => setSection('settings')}><Settings aria-hidden="true" />Application settings</button>
      </nav>

      {error && <div className="inline-alert" role="alert">{error}</div>}
      {loading && <LoadingState message="Loading administrator data…" />}

      {!loading && section === 'users' && (
        <div className="admin-section-grid">
          <section className="admin-panel" aria-labelledby="create-user-title">
            <h2 id="create-user-title">Create user</h2>
            <form className="stack-form" onSubmit={(event) => void createUser(event)}>
              <label className="field"><span>Username</span><input name="username" required /></label>
              <label className="field"><span>Display name</span><input name="displayName" required /></label>
              <label className="field"><span>Email (optional)</span><input name="email" type="email" /></label>
              <label className="field"><span>Role</span><select name="role" defaultValue="Standard"><option value="Standard">Standard</option><option value="Admin">Admin</option></select></label>
              <label className="field"><span>Initial password</span><input name="password" type="password" minLength={12} required /></label>
              <button className="button button-primary" disabled={busy} type="submit">Create user</button>
            </form>
          </section>
          <section className="admin-panel admin-user-list" aria-labelledby="users-title">
            <h2 id="users-title">Users</h2>
            <div className="admin-filters">
              <label className="field"><span>Search</span><input value={userSearch} onChange={(event) => { setUserSearch(event.target.value); setUserPage(1); }} /></label>
              <label className="field"><span>Role</span><select value={userRole} onChange={(event) => { setUserRole(event.target.value as typeof userRole); setUserPage(1); }}><option value="all">All</option><option value="Admin">Admin</option><option value="Standard">Standard</option></select></label>
              <label className="field"><span>Status</span><select value={userActive} onChange={(event) => { setUserActive(event.target.value as typeof userActive); setUserPage(1); }}><option value="all">All</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
            </div>
            <p className="field-help">{users?.total ?? 0} users</p>
            {users?.items.map((account) => (
              <UserEditor
                key={`${account.id}-${account.updatedAt}`}
                account={account}
                currentUserId={user?.sub ?? ''}
                busy={busy}
                onChanged={async () => { setBusy(true); try { await loadUsers(); } finally { setBusy(false); } }}
                onDelete={() => removeUser(account)}
                onError={setError}
              />
            ))}
            {users && users.totalPages > 1 && <nav className="pagination" aria-label="User pages"><button className="button button-secondary" disabled={users.page <= 1} onClick={() => setUserPage((page) => page - 1)}>Previous</button><span>Page {users.page} of {users.totalPages}</span><button className="button button-secondary" disabled={users.page >= users.totalPages} onClick={() => setUserPage((page) => page + 1)}>Next</button></nav>}
          </section>
        </div>
      )}

      {!loading && section === 'data' && (
        <div className="admin-data-sections">
          <section className="admin-panel" aria-labelledby="stats-title">
            <h2 id="stats-title">Archive statistics</h2>
            <dl className="stats-grid">
              {stats && Object.entries(stats).map(([key, value]) => (
                <div key={key}><dt>{key.replace(/([A-Z])/g, ' $1')}</dt><dd>{value.toLocaleString()}</dd></div>
              ))}
            </dl>
          </section>
          <section className="admin-panel" aria-labelledby="inventory-title">
            <div className="admin-panel-heading"><h2 id="inventory-title">Article inventory</h2><input aria-label="Search article inventory" placeholder="Search articles" value={articleSearch} onChange={(event) => { setArticleSearch(event.target.value); setArticlePage(1); }} /></div>
            <div className="admin-filters">
              <label className="field"><span>Visibility</span><select value={articleVisibility} onChange={(event) => { setArticleVisibility(event.target.value as typeof articleVisibility); setArticlePage(1); }}><option value="all">All</option><option value="public">Public</option><option value="internal">Internal</option><option value="admin">Admin</option></select></label>
              <label className="field"><span>Protection</span><select value={articleProtection} onChange={(event) => { setArticleProtection(event.target.value as typeof articleProtection); setArticlePage(1); }}><option value="all">All</option><option value="protected">Protected</option><option value="unprotected">Unprotected</option></select></label>
              <label className="field"><span>Verification</span><select value={articleVerification} onChange={(event) => { setArticleVerification(event.target.value as typeof articleVerification); setArticlePage(1); }}><option value="all">All</option><option value="verified">Verified</option><option value="unverified">Unverified</option></select></label>
            </div>
            <div className="table-scroll"><table className="admin-table"><thead><tr><th>Title</th><th>Visibility</th><th>Version</th><th>Actions</th></tr></thead><tbody>
              {articles?.items.map((article) => <tr key={article.id}><td>{article.title}</td><td>{article.visibility}</td><td>{article.version}</td><td><Link to={`/articles/${article.id}`}>View</Link> · <Link to={`/articles/${article.id}/edit`}>Edit</Link></td></tr>)}
            </tbody></table></div>
            {articles && articles.totalPages > 1 && <nav className="pagination" aria-label="Article inventory pages"><button className="button button-secondary" disabled={articles.page <= 1} onClick={() => setArticlePage((page) => page - 1)}>Previous</button><span>Page {articles.page} of {articles.totalPages}</span><button className="button button-secondary" disabled={articles.page >= articles.totalPages} onClick={() => setArticlePage((page) => page + 1)}>Next</button></nav>}
          </section>
          <ManageTagsPanel />
        </div>
      )}

      {!loading && section === 'settings' && (
        <section className="admin-panel settings-admin-panel" aria-labelledby="application-settings-title">
          <h2 id="application-settings-title">Application settings</h2>
          <form className="stack-form" onSubmit={(event) => void saveSettings(event)}>
            <label className="field"><span>Application name</span><input value={settingsDraft.applicationName} maxLength={80} onChange={(event) => setSettingsDraft({ ...settingsDraft, applicationName: event.target.value })} required /></label>
            <label className="field"><span>Subtitle or description</span><textarea value={settingsDraft.applicationSubtitle} maxLength={240} onChange={(event) => setSettingsDraft({ ...settingsDraft, applicationSubtitle: event.target.value })} required /></label>
            <label className="field"><span>Default article visibility</span><select value={settingsDraft.defaultVisibility} onChange={(event) => setSettingsDraft({ ...settingsDraft, defaultVisibility: event.target.value as ApplicationSettings['defaultVisibility'] })}><option value="Public">Public</option><option value="Internal">Internal</option><option value="Admin">Admin</option></select></label>
            <label className="check-field"><input type="checkbox" checked={settingsDraft.allowPublicBrowsing} onChange={(event) => setSettingsDraft({ ...settingsDraft, allowPublicBrowsing: event.target.checked })} /> Allow unauthenticated visitors to browse public articles</label>
            <div className="dialog-actions"><button className="button button-primary" disabled={busy} type="submit">Save settings</button><button className="button button-secondary" disabled={busy} type="button" onClick={() => setSettingsDraft(settings)}>Cancel</button></div>
          </form>
        </section>
      )}
    </div>
  );
}
