import { ArrowLeftRight, Clock3, History, Pin, RotateCcw, ShieldCheck, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ErrorState, LoadingState } from '../components/States';
import { listArticleRevisions, restoreArticleRevision } from '../services/api';
import type { ArticleRevision } from '../types';

function revisionLabel(revision: ArticleRevision, index: number) {
  if (index === 0) return `Version ${revision.version} · Latest`;
  if (index === 1) return `Version ${revision.version} · Previous`;
  return `Version ${revision.version}`;
}

function isoTimestamp(value: string) {
  return new Date(value).toISOString();
}

function sameTags(left: string[], right: string[]) {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

export function ArticleHistoryPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { user, getToken } = useAuth();
  const [revisions, setRevisions] = useState<ArticleRevision[]>([]);
  const [leftVersion, setLeftVersion] = useState<number>();
  const [rightVersion, setRightVersion] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError('');
      try {
        const history = await listArticleRevisions(id, await getToken(), controller.signal);
        setRevisions(history);
        setLeftVersion(history[1]?.version ?? history[0]?.version);
        setRightVersion(history[0]?.version);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Revision history could not be loaded.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [getToken, id]);

  const left = useMemo(
    () => revisions.find((revision) => revision.version === leftVersion),
    [leftVersion, revisions],
  );
  const right = useMemo(
    () => revisions.find((revision) => revision.version === rightVersion),
    [revisions, rightVersion],
  );
  const latest = revisions[0];

  async function restore() {
    if (!left || !latest || user?.role !== 'Admin' || left.version === latest.version) return;
    if (!window.confirm(`Restore version ${left.version} as a new latest revision?`)) return;
    setRestoring(true);
    setError('');
    try {
      await restoreArticleRevision(id, left.version, latest.version, await getToken());
      navigate(`/articles/${id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The revision could not be restored.');
      setRestoring(false);
    }
  }

  if (loading) return <LoadingState message="Reading revision history…" />;
  if (!latest || !left || !right) {
    return <ErrorState message={error || 'No revision history is available for this article.'} />;
  }

  return (
    <div className="page history-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">Knowledge Base</Link><span>/</span>
        <Link to={`/articles/${id}`}>{latest.title}</Link><span>/</span>
        <span aria-current="page">Revision history</span>
      </nav>
      {error && <div className="inline-alert" role="alert">{error}</div>}
      <header className="history-header">
        <div>
          <p className="eyebrow">Archive version control</p>
          <h1>Revision history</h1>
          <p>Compare the five most recent copies of “{latest.title}”.</p>
        </div>
        <History aria-hidden="true" />
      </header>

      <ol className="revision-list" aria-label="Article revisions">
        {revisions.map((revision, index) => (
          <li key={revision.version}>
            <strong>{revisionLabel(revision, index)}</strong>
            <span><Clock3 aria-hidden="true" /><time dateTime={revision.revisedAt}>{isoTimestamp(revision.revisedAt)}</time></span>
            <span><UserRound aria-hidden="true" />{revision.revisedByName}</span>
          </li>
        ))}
      </ol>

      <section className="comparison-panel" aria-labelledby="comparison-title">
        <div className="comparison-heading">
          <div>
            <p className="eyebrow">Side-by-side comparison</p>
            <h2 id="comparison-title"><ArrowLeftRight aria-hidden="true" />Compare revisions</h2>
          </div>
          {user?.role === 'Admin' && (
            <button
              className="button button-secondary"
              disabled={restoring || left.version === latest.version}
              onClick={() => void restore()}
            >
              <RotateCcw aria-hidden="true" />{restoring ? 'Restoring…' : `Restore version ${left.version}`}
            </button>
          )}
        </div>

        <div className="revision-selectors">
          <label className="field">Earlier revision
            <select value={left.version} onChange={(event) => setLeftVersion(Number(event.target.value))}>
              {revisions.map((revision, index) => (
                <option key={revision.version} value={revision.version}>{revisionLabel(revision, index)}</option>
              ))}
            </select>
          </label>
          <label className="field">Later revision
            <select value={right.version} onChange={(event) => setRightVersion(Number(event.target.value))}>
              {revisions.map((revision, index) => (
                <option key={revision.version} value={revision.version}>{revisionLabel(revision, index)}</option>
              ))}
            </select>
          </label>
        </div>

        <dl className="revision-comparison-metadata">
          <div className={left.title === right.title ? '' : 'changed'}><dt>Title</dt><dd>{left.title}</dd><dd>{right.title}</dd></div>
          <div className={sameTags(left.tags, right.tags) ? '' : 'changed'}><dt>Tags</dt><dd>{left.tags.join(', ') || 'None'}</dd><dd>{right.tags.join(', ') || 'None'}</dd></div>
          <div className={left.isProtected === right.isProtected ? '' : 'changed'}>
            <dt>Protection</dt>
            <dd><ShieldCheck aria-hidden="true" />{left.isProtected ? 'Protected' : 'Unprotected'}</dd>
            <dd><ShieldCheck aria-hidden="true" />{right.isProtected ? 'Protected' : 'Unprotected'}</dd>
          </div>
          <div className={left.isPinned === right.isPinned ? '' : 'changed'}>
            <dt>Pin status</dt>
            <dd><Pin aria-hidden="true" />{left.isPinned ? 'Pinned' : 'Not pinned'}</dd>
            <dd><Pin aria-hidden="true" />{right.isPinned ? 'Pinned' : 'Not pinned'}</dd>
          </div>
        </dl>

        <div className={`revision-content-grid ${left.content === right.content ? '' : 'changed'}`}>
          <section aria-labelledby="left-content-title">
            <h3 id="left-content-title">Version {left.version} content</h3>
            <pre>{left.content}</pre>
          </section>
          <section aria-labelledby="right-content-title">
            <h3 id="right-content-title">Version {right.version} content</h3>
            <pre>{right.content}</pre>
          </section>
        </div>
      </section>
    </div>
  );
}
