import { Download, Upload } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { downloadDatabaseBackup, restoreDatabaseBackup } from '../services/api';
import type { BackupRestoreResult } from '../types';

/** Matches backupMaxBodyBytes in backend/routes.ts. */
export const maxBackupBytes = 100 * 1024 * 1024;

const tableLabels: Record<keyof BackupRestoreResult['restored'], string> = {
  local_users: 'Local users',
  app_users: 'Author records',
  tags: 'Tags',
  articles: 'Articles',
  article_revisions: 'Article revisions',
  application_settings: 'Application settings',
};

export function BackupPanel() {
  const { getToken, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [restored, setRestored] = useState<BackupRestoreResult['restored'] | null>(null);

  async function download() {
    setBusy(true);
    setError('');
    try {
      const { blob, filename } = await downloadDatabaseBackup(await getToken());
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The backup could not be created.');
    } finally { setBusy(false); }
  }

  async function restore(event: FormEvent) {
    event.preventDefault();
    if (!file || !confirmed) return;
    if (file.size > maxBackupBytes) {
      setError('The backup file is larger than the 100 MB limit.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await restoreDatabaseBackup(await file.text(), await getToken());
      setRestored(result.restored);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The backup could not be restored.');
    } finally { setBusy(false); }
  }

  async function signInAgain() {
    await signOut();
    // A full reload also refreshes the restored application settings.
    window.location.assign('/login');
  }

  if (restored) {
    return (
      <section className="admin-panel settings-admin-panel" aria-labelledby="backup-restored-title">
        <h2 id="backup-restored-title">Backup restored</h2>
        <p>The database was replaced with the backup contents. Every user, including you, has been signed out.</p>
        <dl className="stats-grid">
          {Object.entries(tableLabels).map(([table, label]) => (
            <div key={table}><dt>{label}</dt><dd>{restored[table as keyof typeof restored].toLocaleString()}</dd></div>
          ))}
        </dl>
        <div className="dialog-actions"><button className="button button-primary" type="button" onClick={() => void signInAgain()}>Sign in again</button></div>
      </section>
    );
  }

  return (
    <div className="admin-data-sections">
      {error && <div className="inline-alert" role="alert">{error}</div>}
      <section className="admin-panel settings-admin-panel" aria-labelledby="backup-export-title">
        <h2 id="backup-export-title">Export backup</h2>
        <p className="field-help">
          Downloads every article, revision, tag, user account, and application setting as a single JSON file.
          The file contains password hashes: store it as securely as the database itself.
        </p>
        <div className="dialog-actions">
          <button className="button button-primary" disabled={busy} type="button" onClick={() => void download()}>
            <Download aria-hidden="true" /> Download backup
          </button>
        </div>
      </section>
      <section className="admin-panel settings-admin-panel" aria-labelledby="backup-restore-title">
        <h2 id="backup-restore-title">Restore backup</h2>
        <p className="field-help">
          Replaces all current data with the contents of a backup file created by this version of the application.
          The restore runs in a single transaction: if the file is invalid, nothing changes. Afterwards every user is signed out.
        </p>
        <form className="stack-form" onSubmit={(event) => void restore(event)}>
          <label className="field"><span>Backup file</span>
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(''); }}
            />
          </label>
          <label className="check-field">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            I understand that restoring permanently replaces all current data.
          </label>
          <div className="dialog-actions">
            <button className="button button-danger" disabled={busy || !file || !confirmed} type="submit">
              <Upload aria-hidden="true" /> Restore backup
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
