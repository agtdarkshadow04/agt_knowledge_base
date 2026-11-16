import { type FormEvent, useState } from 'react';
import { ApiError } from '../lib/client';
import { formatTranslation } from '../translations';
import { useAdminI18n } from './context';
import type { AdminTranslations } from './i18n';
import { downloadBackup, previewBackup, restoreBackup } from './api';
import { saveFile } from './download';
import type { RestorePreview, RestoreReport } from './types';
import { DownloadIcon, EyeIcon, UploadIcon } from '../components/Icons';

function Counts({ counts }: { counts: Record<string, number> }) {
  const { a, number } = useAdminI18n();
  return (
    <dl className="stats-grid">
      {Object.entries(counts).map(([table, count]) => (
        <div key={table}><dt>{a.backup.tables[table as keyof AdminTranslations['backup']['tables']] ?? table}</dt><dd>{number(count)}</dd></div>
      ))}
    </dl>
  );
}

/** A refused archive's translated reason (`params.reason`), with the server's English details kept for support. */
function rejection(cause: unknown, a: AdminTranslations) {
  if (!(cause instanceof ApiError) || cause.code !== 'archive_rejected') return null;
  const reason = cause.params.reason;
  const text = typeof reason === 'string' ? a.backup.reasons[reason as keyof AdminTranslations['backup']['reasons']] : undefined;
  return text ? { text, details: cause.message } : null;
}

function PreviewDetails({ preview }: { preview: RestorePreview }) {
  const { a, dateTime } = useAdminI18n();
  const { config } = preview;
  return (
    <>
      <p>{formatTranslation(a.backup.created, { date: dateTime(preview.createdAt), version: preview.appVersion, schema: preview.schemaVersion.backup })}</p>
      {preview.schemaVersion.backup < preview.schemaVersion.current && (
        <div className="admin-notice" role="note">
          {formatTranslation(a.backup.olderVersion, { from: preview.schemaVersion.backup, to: preview.schemaVersion.current })}
        </div>
      )}
      {preview.warningCodes.map((code) => <div className="admin-notice" role="note" key={code}>{a.backup.warnings[code]}</div>)}
      <Counts counts={preview.counts} />
      {preview.ignoredSettings.length > 0 && (
        <div className="admin-notice" role="note">
          {formatTranslation(a.backup.ignoredSettings, { keys: preview.ignoredSettings.join(', ') })}
        </div>
      )}
      <h3>{a.backup.configTitle}</h3>
      {!config.included && <p className="field-help">{a.backup.noConfig}</p>}
      {config.included && (
        <>
          <p className="field-help">
            {a.backup.configNeverRestored} {config.identical ? a.backup.configIdentical : a.backup.configDifferent}
          </p>
          {config.diff && !config.identical && (
            <pre className="config-diff" aria-label={a.backup.configDiff}>
              {config.diff.map((line, index) => <span key={index} className={`diff-line diff-${line.kind === '+' ? 'added' : line.kind === '-' ? 'removed' : 'same'}`}>{line.kind} {line.text}{'\n'}</span>)}
            </pre>
          )}
          {config.content !== null && (
            <button className="button button-secondary" type="button" onClick={() => saveFile(new Blob([config.content!], { type: 'text/yaml' }), 'config.from-backup.yaml')}>
              <DownloadIcon /> {a.backup.downloadConfig}
            </button>
          )}
        </>
      )}
    </>
  );
}

export function BackupPanel({ onRestored }: { onRestored(): void }) {
  const { a, error: describe } = useAdminI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState('');

  function fail(cause: unknown) {
    const rejected = rejection(cause, a);
    setError(rejected ? `${describe(cause)} ${rejected.text}` : describe(cause));
    setDetails(rejected?.details ?? '');
  }
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [report, setReport] = useState<RestoreReport | null>(null);

  async function download() {
    setBusy(true);
    setError('');
    setDetails('');
    try {
      const { blob, filename } = await downloadBackup();
      saveFile(blob, filename);
    } catch (cause) {
      fail(cause);
    } finally { setBusy(false); }
  }

  async function runPreview(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');
    setDetails('');
    setPreview(null);
    setConfirmed(false);
    try {
      setPreview(await previewBackup(file));
    } catch (cause) {
      fail(cause);
    } finally { setBusy(false); }
  }

  async function restore() {
    if (!file || !preview || !confirmed) return;
    setBusy(true);
    setError('');
    setDetails('');
    try {
      setReport(await restoreBackup(file));
    } catch (cause) {
      fail(cause);
    } finally { setBusy(false); }
  }

  if (report) {
    return (
      <section className="admin-panel settings-admin-panel" aria-labelledby="backup-restored-title">
        <h2 id="backup-restored-title">{a.backup.restoredTitle}</h2>
        <p>{a.backup.restoredText}</p>
        {report.preRestoreBackup && <p className="field-help">{formatTranslation(a.backup.preRestoreSaved, { file: report.preRestoreBackup })}</p>}
        <Counts counts={report.counts} />
        {report.schemaVersion.backup < report.schemaVersion.current && <p className="field-help">{formatTranslation(a.backup.upgraded, { from: report.schemaVersion.backup, to: report.schemaVersion.current })}</p>}
        {report.warningCodes.map((code) => <p className="field-help" key={code}>{a.backup.warnings[code]}</p>)}
        {report.ignoredSettings.length > 0 && <p className="field-help">{formatTranslation(a.backup.keptFromConfig, { keys: report.ignoredSettings.join(', ') })}</p>}
        <div className="dialog-actions"><button className="button button-primary" type="button" onClick={onRestored}>{a.backup.signInAgain}</button></div>
      </section>
    );
  }

  return (
    <div className="admin-data-sections">
      {error && (
        <div role="alert">
          <p className="error-note">{error}</p>
          {details && <details className="field-help"><summary>{a.backup.technicalDetails}</summary><p>{details}</p></details>}
        </div>
      )}
      <div role="status" aria-live="polite">{busy && <p className="field-help">{a.backup.working}</p>}</div>
      <section className="admin-panel settings-admin-panel" aria-labelledby="backup-export-title">
        <h2 id="backup-export-title">{a.backup.downloadTitle}</h2>
        <p className="field-help">{a.backup.downloadHelp}</p>
        <div className="dialog-actions">
          <button className="button button-primary" disabled={busy} type="button" onClick={() => void download()}>
            <DownloadIcon /> {a.backup.download}
          </button>
        </div>
      </section>
      <section className="admin-panel settings-admin-panel" aria-labelledby="backup-restore-title">
        <h2 id="backup-restore-title">{a.backup.restoreTitle}</h2>
        <p className="field-help">{a.backup.restoreHelp}</p>
        <form className="stack-form" onSubmit={(event) => void runPreview(event)}>
          <label className="field"><span>{a.backup.file}</span>
            <input
              type="file"
              accept="application/zip,.zip"
              onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setConfirmed(false); setError(''); setDetails(''); }}
            />
          </label>
          <div className="dialog-actions">
            <button className="button button-secondary" disabled={busy || !file} type="submit"><EyeIcon /> {a.backup.preview}</button>
          </div>
        </form>
      </section>
      {preview && (
        <section className="admin-panel settings-admin-panel" aria-labelledby="backup-preview-title">
          <h2 id="backup-preview-title">{a.backup.previewTitle}</h2>
          <PreviewDetails preview={preview} />
          <label className="check-field">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            {a.backup.understand}
          </label>
          <div className="dialog-actions">
            <button className="button button-danger" disabled={busy || !confirmed} type="button" onClick={() => void restore()}>
              <UploadIcon /> {a.backup.restore}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
