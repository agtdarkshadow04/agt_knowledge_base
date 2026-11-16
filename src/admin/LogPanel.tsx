import { type FormEvent, Fragment, useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '../components/Dialog';
import { LoadingState } from '../components/States';
import { clearServerLog, exportLog, listAuditLog, listServerLog, type LogKind } from './api';
import { saveFile } from './download';
import type { AuditLogEntry, LogFilters, ServerLogEntry } from './types';
import { DownloadIcon, SearchIcon, TrashIcon } from '../components/Icons';

/**
 * The Server log and Audit log tabs (LOG-19, LOG-20): filters, a table with
 * paging, the details of an entry, export as JSON Lines or CSV, and, for the
 * server log only, Clear log. The audit log can never be changed here.
 */

type Entry = ServerLogEntry | AuditLogEntry;

const levelOptions = [['', 'Any level'], ['info', 'Info and above'], ['warn', 'Warnings and above'], ['error', 'Errors and above'], ['fatal', 'Fatal only']];
const actorOptions = [['', 'Anyone'], ['admin', 'Admin'], ['member', 'Member'], ['anonymous', 'Anonymous']];
const outcomeOptions = [['', 'Any outcome'], ['success', 'Success'], ['denied', 'Denied'], ['rate_limited', 'Rate limited'], ['failure', 'Failure']];

/** LOG-19: colour and text, never colour alone. */
function severity(value: string) {
  if (value === 'error' || value === 'fatal' || value === 'failure') return 'log-severity log-severity-error';
  if (value === 'warn' || value === 'denied' || value === 'rate_limited') return 'log-severity log-severity-warn';
  return 'log-severity';
}

const outcomeLabels: Record<string, string> = { success: 'Success', denied: 'Denied', rate_limited: 'Rate limited', failure: 'Failure' };

/** A `datetime-local` value as ISO 8601, in the browser's time zone. */
function isoTime(value: string) {
  return value ? new Date(value).toISOString() : '';
}

function failure(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

function Select({ label, name, options, value, onChange }: { label: string; name: string; options: string[][]; value: string; onChange(value: string): void }) {
  return (
    <label className="field"><span>{label}</span>
      <select name={name} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}
      </select>
    </label>
  );
}

function TextFilter({ label, name, value, onChange, type = 'text' }: { label: string; name: string; value: string; onChange(value: string): void; type?: string }) {
  return <label className="field"><span>{label}</span><input name={name} type={type} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

export function LogPanel({ kind }: { kind: LogKind }) {
  const [draft, setDraft] = useState<LogFilters>({});
  const [filters, setFilters] = useState<LogFilters>({});
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState<'jsonl' | 'csv'>('jsonl');
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async (applied: LogFilters, after = '') => {
    setBusy(true);
    setError('');
    try {
      const page = kind === 'server' ? await listServerLog(applied, after) : await listAuditLog(applied, after);
      setEntries((current) => (after && current ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(failure(cause, 'The log could not be loaded.'));
    } finally { setBusy(false); }
  }, [kind]);

  useEffect(() => { void load({}); }, [load]);

  const set = (name: string) => (value: string) => setDraft((current) => ({ ...current, [name]: value }));

  function apply(event: FormEvent) {
    event.preventDefault();
    const applied = { ...draft, from: isoTime(draft.from ?? ''), to: isoTime(draft.to ?? '') };
    setFilters(applied);
    setOpen(null);
    void load(applied);
  }

  async function download() {
    setError('');
    try {
      const { blob, filename } = await exportLog(kind, filters, format);
      saveFile(blob, filename);
    } catch (cause) {
      setError(failure(cause, 'The export could not be created.'));
    }
  }

  async function clear() {
    setBusy(true);
    setError('');
    try {
      await clearServerLog();
      setConfirmClear(false);
      setNotice('The server log was cleared.');
      await load(filters);
    } catch (cause) {
      setError(failure(cause, 'The server log could not be cleared.'));
    } finally { setBusy(false); }
  }

  const title = kind === 'server' ? 'Server log' : 'Audit log';
  const columns = kind === 'server' ? ['Time', 'Level', 'Source', 'Message', ''] : ['Time', 'Actor', 'Action', 'Target', 'Outcome', 'Status', ''];

  return (
    <section className="admin-panel log-panel" aria-labelledby={`${kind}-log-title`}>
      <h2 id={`${kind}-log-title`}>{title}</h2>
      <p className="field-help">
        {kind === 'server'
          ? 'Events the server caused itself: startup, migrations, retention, backups and unexpected errors.'
          : 'Who did what, when, with what outcome: every change, sign-in and denied attempt. Addresses are stored only as pseudonymous hashes. The audit log cannot be edited or cleared.'}
        {' '}Logs are not part of backups.
      </p>
      {error && <p className="error-note" role="alert">{error}</p>}
      <div role="status" aria-live="polite">{notice && <p className="success-note">{notice}</p>}</div>
      <form className="log-filters" onSubmit={apply} aria-label={`${title} filters`}>
        {kind === 'server' ? (
          <>
            <Select label="Level" name="level" options={levelOptions} value={draft.level ?? ''} onChange={set('level')} />
            <TextFilter label="Source" name="source" value={draft.source ?? ''} onChange={set('source')} />
          </>
        ) : (
          <>
            <Select label="Actor" name="actorType" options={actorOptions} value={draft.actorType ?? ''} onChange={set('actorType')} />
            <TextFilter label="Action" name="action" value={draft.action ?? ''} onChange={set('action')} />
            <Select label="Outcome" name="outcome" options={outcomeOptions} value={draft.outcome ?? ''} onChange={set('outcome')} />
            <TextFilter label="Target type" name="targetType" value={draft.targetType ?? ''} onChange={set('targetType')} />
            <TextFilter label="Target ID" name="targetId" value={draft.targetId ?? ''} onChange={set('targetId')} />
          </>
        )}
        <TextFilter label="From" name="from" type="datetime-local" value={draft.from ?? ''} onChange={set('from')} />
        <TextFilter label="To" name="to" type="datetime-local" value={draft.to ?? ''} onChange={set('to')} />
        <TextFilter label="Search" name="q" value={draft.q ?? ''} onChange={set('q')} />
        <div className="dialog-actions">
          <button className="button button-secondary" type="submit" disabled={busy}><SearchIcon aria-hidden="true" /> Apply filters</button>
        </div>
      </form>
      <div className="dialog-actions log-actions">
        <label className="field inline-field"><span>Export format</span>
          <select value={format} onChange={(event) => setFormat(event.target.value as 'jsonl' | 'csv')}>
            <option value="jsonl">JSON Lines</option>
            <option value="csv">CSV</option>
          </select>
        </label>
        <button className="button button-secondary" type="button" onClick={() => void download()}><DownloadIcon aria-hidden="true" /> Export</button>
        {kind === 'server' && (
          <button className="button button-danger" type="button" aria-haspopup="dialog" aria-expanded={confirmClear} onClick={() => { setConfirmClear(true); setNotice(''); }}><TrashIcon aria-hidden="true" /> Clear log</button>
        )}
      </div>
      {kind === 'server' && confirmClear && (
        <ConfirmDialog
          title="Clear the server log?"
          description="Every server log entry is deleted. This cannot be undone. The audit log is not affected."
          confirmLabel={busy ? 'Clearing…' : 'Clear the server log'}
          danger
          busy={busy}
          onConfirm={() => void clear()}
          onCancel={() => setConfirmClear(false)}
        />
      )}
      {entries === null ? <LoadingState message="Loading the log…" /> : entries.length === 0 ? (
        <p className="field-help">No entries match.</p>
      ) : (
        <div className="table-scroll">
          <table className="admin-table log-table">
            <thead><tr>{columns.map((column, index) => <th key={index} scope="col">{column || <span className="sr-only">Details</span>}</th>)}</tr></thead>
            <tbody>
              {entries.map((entry) => (
                <Fragment key={entry.id}>
                  <tr>
                    <td><time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time></td>
                    {'level' in entry ? (
                      <>
                        <td><span className={severity(entry.level)}>{entry.level}</span></td>
                        <td>{entry.source}</td>
                        <td>{entry.message}</td>
                      </>
                    ) : (
                      <>
                        <td>{entry.actor ?? '—'} <small className="field-help">({entry.actorType})</small></td>
                        <td><code>{entry.action}</code></td>
                        <td>{entry.targetType ? `${entry.targetType} ${entry.targetId ?? ''}` : '—'}</td>
                        <td><span className={severity(entry.outcome)}>{outcomeLabels[entry.outcome]}</span>{entry.count > 1 && <small className="field-help"> ×{entry.count}</small>}</td>
                        <td>{entry.statusCode}</td>
                      </>
                    )}
                    <td>
                      <button className="button button-secondary button-small" type="button" aria-expanded={open === entry.id} onClick={() => setOpen(open === entry.id ? null : entry.id)}>
                        {open === entry.id ? 'Hide details' : 'Details'}
                      </button>
                    </td>
                  </tr>
                  {open === entry.id && (
                    <tr className="log-details-row">
                      <td colSpan={columns.length}>
                        <pre className="log-details" aria-label="Entry details">{JSON.stringify(
                          'level' in entry
                            ? { requestId: entry.requestId, details: entry.details }
                            : { method: entry.method, route: entry.route, client: entry.client, ipHash: entry.ipHash, requestId: entry.requestId, firstAt: entry.at, lastAt: entry.lastAt, details: entry.details },
                          null,
                          2,
                        )}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <div className="dialog-actions">
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => void load(filters, cursor)}>Load older entries</button>
        </div>
      )}
    </section>
  );
}
