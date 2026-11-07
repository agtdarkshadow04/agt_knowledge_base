import { Download, Eye, Upload } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { downloadBackup, previewBackup, restoreBackup } from './api';
import type { RestorePreview, RestoreReport } from './types';

const tableLabels: Record<string, string> = {
  app_users: 'Author records',
  local_users: 'Member accounts',
  tags: 'Tags',
  articles: 'Articles',
  article_revisions: 'Article revisions',
  application_settings: 'Application settings',
  admin: 'Admin account',
};

function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function Counts({ counts }: { counts: Record<string, number> }) {
  return (
    <dl className="stats-grid">
      {Object.entries(counts).map(([table, count]) => (
        <div key={table}><dt>{tableLabels[table] ?? table}</dt><dd>{count.toLocaleString()}</dd></div>
      ))}
    </dl>
  );
}

function PreviewDetails({ preview }: { preview: RestorePreview }) {
  const { config } = preview;
  return (
    <>
      <p>Created {new Date(preview.createdAt).toLocaleString()} by version {preview.appVersion}.</p>
      {preview.migrations.upgrade.length > 0 && (
        <div className="inline-notice" role="note">
          This backup is from an older version. Restoring upgrades it with {preview.migrations.upgrade.length} migration{preview.migrations.upgrade.length === 1 ? '' : 's'}: {preview.migrations.upgrade.join(', ')}.
        </div>
      )}
      <Counts counts={preview.counts} />
      {preview.ignoredSettings.length > 0 && (
        <div className="inline-notice" role="note">
          These settings are defined in this installation&apos;s configuration file, so the backup&apos;s values are ignored: {preview.ignoredSettings.join(', ')}.
        </div>
      )}
      <h3>Configuration file</h3>
      {!config.included && <p className="field-help">The backup does not contain a config.yaml.</p>}
      {config.included && (
        <>
          <p className="field-help">
            config.yaml is never restored. {config.identical ? 'The backup’s file is identical to the current one.' : 'Differences from the current file are shown below; apply any you want by editing config.yaml on the server.'}
          </p>
          {config.diff && !config.identical && (
            <pre className="config-diff" aria-label="config.yaml differences">
              {config.diff.map((line, index) => <span key={index} className={`diff-line diff-${line.kind === '+' ? 'added' : line.kind === '-' ? 'removed' : 'same'}`}>{line.kind} {line.text}{'\n'}</span>)}
            </pre>
          )}
          {config.content !== null && (
            <button className="button button-secondary" type="button" onClick={() => saveFile(new Blob([config.content!], { type: 'text/yaml' }), 'config.from-backup.yaml')}>
              <Download aria-hidden="true" /> Download the backup&apos;s config.yaml
            </button>
          )}
        </>
      )}
    </>
  );
}

export function BackupPanel({ onRestored }: { onRestored(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [report, setReport] = useState<RestoreReport | null>(null);

  async function download() {
    setBusy(true);
    setError('');
    try {
      const { blob, filename } = await downloadBackup();
      saveFile(blob, filename);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The backup could not be created.');
    } finally { setBusy(false); }
  }

  async function runPreview(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');
    setPreview(null);
    setConfirmed(false);
    try {
      setPreview(await previewBackup(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The backup could not be checked.');
    } finally { setBusy(false); }
  }

  async function restore() {
    if (!file || !preview || !confirmed) return;
    setBusy(true);
    setError('');
    try {
      setReport(await restoreBackup(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The backup could not be restored.');
    } finally { setBusy(false); }
  }

  if (report) {
    return (
      <section className="admin-panel settings-admin-panel" aria-labelledby="backup-restored-title">
        <h2 id="backup-restored-title">Backup restored</h2>
        <p>The data was replaced with the backup contents. Every member and the Admin have been signed out; sign in with the Admin account stored in the backup.</p>
        <p className="field-help">The data that was replaced was saved first as <code>{report.preRestoreBackup}</code> in the server&apos;s backups directory.</p>
        <Counts counts={report.counts} />
        {report.migrations.upgrade.length > 0 && <p className="field-help">Upgraded with: {report.migrations.upgrade.join(', ')}.</p>}
        {report.ignoredSettings.length > 0 && <p className="field-help">Kept from the configuration file: {report.ignoredSettings.join(', ')}.</p>}
        <div className="dialog-actions"><button className="button button-primary" type="button" onClick={onRestored}>Sign in again</button></div>
      </section>
    );
  }

  return (
    <div className="admin-data-sections">
      {error && <div className="inline-alert" role="alert">{error}</div>}
      <section className="admin-panel settings-admin-panel" aria-labelledby="backup-export-title">
        <h2 id="backup-export-title">Download backup</h2>
        <p className="field-help">
          Downloads a ZIP archive with every article, revision, tag, member account, the Admin account, the application settings,
          and the current config.yaml, with a SHA-256 checksum for each file. Sessions and .env are never included.
          The archive contains the Admin and member password hashes: store it as securely as the database itself.
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
          Upload a backup to preview it first; nothing changes until you confirm. Older backups are upgraded; backups from a newer version are refused.
          Before restoring, the current data is saved as a pre-restore backup on the server. The restore runs in a single transaction, and afterwards everyone is signed out.
        </p>
        <form className="stack-form" onSubmit={(event) => void runPreview(event)}>
          <label className="field"><span>Backup file</span>
            <input
              type="file"
              accept="application/zip,.zip"
              onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setConfirmed(false); setError(''); }}
            />
          </label>
          <div className="dialog-actions">
            <button className="button button-secondary" disabled={busy || !file} type="submit"><Eye aria-hidden="true" /> Preview backup</button>
          </div>
        </form>
      </section>
      {preview && (
        <section className="admin-panel settings-admin-panel" aria-labelledby="backup-preview-title">
          <h2 id="backup-preview-title">Backup preview</h2>
          <PreviewDetails preview={preview} />
          <label className="check-field">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            I understand that restoring permanently replaces all current data.
          </label>
          <div className="dialog-actions">
            <button className="button button-danger" disabled={busy || !confirmed} type="button" onClick={() => void restore()}>
              <Upload aria-hidden="true" /> Restore backup
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
