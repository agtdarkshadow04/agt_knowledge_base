import { type FormEvent, Fragment, useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '../components/Dialog';
import { LoadingState } from '../components/States';
import { formatTranslation } from '../translations';
import { useAdminI18n } from './context';
import type { AdminTranslations } from './i18n';
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

const levelOptions = (a: AdminTranslations) => [['', a.logs.anyLevel], ['info', a.logs.infoUp], ['warn', a.logs.warnUp], ['error', a.logs.errorUp], ['fatal', a.logs.fatalOnly]];
const actorOptions = (a: AdminTranslations) => [['', a.logs.anyone], ['admin', a.logs.actorAdmin], ['member', a.logs.actorMember], ['anonymous', a.logs.actorAnonymous]];
const outcomeOptions = (a: AdminTranslations) => [['', a.logs.anyOutcome], ['success', a.logs.success], ['denied', a.logs.denied], ['rate_limited', a.logs.rateLimited], ['failure', a.logs.failure]];

/** LOG-19: colour and text, never colour alone. */
function severity(value: string) {
  if (value === 'error' || value === 'fatal' || value === 'failure') return 'log-severity log-severity-error';
  if (value === 'warn' || value === 'denied' || value === 'rate_limited') return 'log-severity log-severity-warn';
  return 'log-severity';
}

const outcomeLabel = (outcome: string, a: AdminTranslations) => ({ success: a.logs.success, denied: a.logs.denied, rate_limited: a.logs.rateLimited, failure: a.logs.failure } as Record<string, string>)[outcome] ?? outcome;
const actorLabel = (actorType: string, a: AdminTranslations) => ({ admin: a.logs.actorAdmin, member: a.logs.actorMember, anonymous: a.logs.actorAnonymous } as Record<string, string>)[actorType] ?? actorType;
const levelLabel = (level: string, a: AdminTranslations) => a.logs.levels[level as keyof AdminTranslations['logs']['levels']] ?? level;

/** A `datetime-local` value as ISO 8601, in the browser's time zone. */
function isoTime(value: string) {
  return value ? new Date(value).toISOString() : '';
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
  const { a, dateTime, error: describe } = useAdminI18n();
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
      setError(describe(cause));
    } finally { setBusy(false); }
  }, [describe, kind]);

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
      setError(describe(cause));
    }
  }

  async function clear() {
    setBusy(true);
    setError('');
    try {
      await clearServerLog();
      setConfirmClear(false);
      setNotice(a.logs.cleared);
      await load(filters);
    } catch (cause) {
      setError(describe(cause));
    } finally { setBusy(false); }
  }

  const title = kind === 'server' ? a.logs.serverTitle : a.logs.auditTitle;
  const columns = kind === 'server'
    ? [a.logs.colTime, a.logs.colLevel, a.logs.colSource, a.logs.colMessage, '']
    : [a.logs.colTime, a.logs.colActor, a.logs.colAction, a.logs.colTarget, a.logs.colOutcome, a.logs.colStatus, ''];

  return (
    <section className="admin-panel log-panel" aria-labelledby={`${kind}-log-title`}>
      <h2 id={`${kind}-log-title`}>{title}</h2>
      <p className="field-help">
        {kind === 'server' ? a.logs.serverIntro : a.logs.auditIntro}
        {' '}{a.logs.notInBackups}
      </p>
      {error && <p className="error-note" role="alert">{error}</p>}
      <div role="status" aria-live="polite">{notice && <p className="success-note">{notice}</p>}</div>
      <form className="log-filters" onSubmit={apply} aria-label={formatTranslation(a.logs.filters, { log: title })}>
        {kind === 'server' ? (
          <>
            <Select label={a.logs.level} name="level" options={levelOptions(a)} value={draft.level ?? ''} onChange={set('level')} />
            <TextFilter label={a.logs.source} name="source" value={draft.source ?? ''} onChange={set('source')} />
          </>
        ) : (
          <>
            <Select label={a.logs.actor} name="actorType" options={actorOptions(a)} value={draft.actorType ?? ''} onChange={set('actorType')} />
            <TextFilter label={a.logs.action} name="action" value={draft.action ?? ''} onChange={set('action')} />
            <Select label={a.logs.outcome} name="outcome" options={outcomeOptions(a)} value={draft.outcome ?? ''} onChange={set('outcome')} />
            <TextFilter label={a.logs.targetType} name="targetType" value={draft.targetType ?? ''} onChange={set('targetType')} />
            <TextFilter label={a.logs.targetId} name="targetId" value={draft.targetId ?? ''} onChange={set('targetId')} />
          </>
        )}
        <TextFilter label={a.logs.from} name="from" type="datetime-local" value={draft.from ?? ''} onChange={set('from')} />
        <TextFilter label={a.logs.to} name="to" type="datetime-local" value={draft.to ?? ''} onChange={set('to')} />
        <TextFilter label={a.logs.search} name="q" value={draft.q ?? ''} onChange={set('q')} />
        <div className="dialog-actions">
          <button className="button button-secondary" type="submit" disabled={busy}><SearchIcon /> {a.logs.apply}</button>
        </div>
      </form>
      <div className="dialog-actions log-actions">
        <label className="field inline-field"><span>{a.logs.format}</span>
          <select value={format} onChange={(event) => setFormat(event.target.value as 'jsonl' | 'csv')}>
            <option value="jsonl">{a.logs.jsonl}</option>
            <option value="csv">{a.logs.csv}</option>
          </select>
        </label>
        <button className="button button-secondary" type="button" onClick={() => void download()}><DownloadIcon /> {a.logs.export}</button>
        {kind === 'server' && (
          <button className="button button-danger" type="button" aria-haspopup="dialog" aria-expanded={confirmClear} onClick={() => { setConfirmClear(true); setNotice(''); }}><TrashIcon /> {a.logs.clear}</button>
        )}
      </div>
      {kind === 'server' && confirmClear && (
        <ConfirmDialog
          title={a.logs.clearTitle}
          description={a.logs.clearText}
          confirmLabel={busy ? a.logs.clearing : a.logs.clearConfirm}
          danger
          busy={busy}
          onConfirm={() => void clear()}
          onCancel={() => setConfirmClear(false)}
        />
      )}
      {entries === null ? <LoadingState message={a.logs.loading} /> : entries.length === 0 ? (
        <p className="field-help">{a.logs.empty}</p>
      ) : (
        <div className="table-scroll">
          <table className="admin-table log-table">
            <thead><tr>{columns.map((column, index) => <th key={index} scope="col">{column || <span className="sr-only">{a.logs.details}</span>}</th>)}</tr></thead>
            <tbody>
              {entries.map((entry) => (
                <Fragment key={entry.id}>
                  <tr>
                    <td><time dateTime={entry.at}>{dateTime(entry.at)}</time></td>
                    {'level' in entry ? (
                      <>
                        <td><span className={severity(entry.level)}>{levelLabel(entry.level, a)}</span></td>
                        <td>{entry.source}</td>
                        <td>{entry.message}</td>
                      </>
                    ) : (
                      <>
                        <td>{entry.actor ?? '—'} <small className="field-help">({actorLabel(entry.actorType, a)})</small></td>
                        <td><code>{entry.action}</code></td>
                        <td>{entry.targetType ? `${entry.targetType} ${entry.targetId ?? ''}` : '—'}</td>
                        <td><span className={severity(entry.outcome)}>{outcomeLabel(entry.outcome, a)}</span>{entry.count > 1 && <small className="field-help"> ×{entry.count}</small>}</td>
                        <td>{entry.statusCode}</td>
                      </>
                    )}
                    <td>
                      <button className="button button-secondary button-small" type="button" aria-expanded={open === entry.id} onClick={() => setOpen(open === entry.id ? null : entry.id)}>
                        {open === entry.id ? a.logs.hideDetails : a.logs.details}
                      </button>
                    </td>
                  </tr>
                  {open === entry.id && (
                    <tr className="log-details-row">
                      <td colSpan={columns.length}>
                        <pre className="log-details" aria-label={a.logs.entryDetails}>{JSON.stringify(
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
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => void load(filters, cursor)}>{a.logs.loadOlder}</button>
        </div>
      )}
    </section>
  );
}
