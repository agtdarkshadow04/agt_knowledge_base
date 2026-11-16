import { useEffect, useMemo, useState } from 'react';
import { useAuth } from './AuthContext';
import { ErrorState, LoadingState } from './States';
import { TagChip } from './TagChip';
import { VisibilityChip } from './VisibilityChip';
import { listArticleRevisions, restoreArticleRevision } from '../lib/memberApi';
import { routeHref } from '../lib/routes';
import { ConfirmDialog } from './Dialog';
import { Link, useNavigation } from './Navigation';
import type { ArticleRevision } from '../lib/api';
import { ArrowLeftRightIcon, ClockIcon, HistoryIcon, PinIcon, RotateCcwIcon, ShieldCheckIcon, UserRoundIcon } from './Icons';

function revisionLabel(revision: ArticleRevision, index: number) {
  if (index === 0) return `Version ${revision.version} · Latest`;
  if (index === 1) return `Version ${revision.version} · Previous`;
  return `Version ${revision.version}`;
}

function isoTimestamp(value: string) {
  return new Date(value).toISOString();
}

function sameTags(left: ArticleRevision['tags'], right: ArticleRevision['tags']) {
  return left.length === right.length && left.every((tag, index) => tag.id === right[index].id);
}

function tagList(tags: ArticleRevision['tags']) {
  if (!tags.length) return 'None';
  return <span className="tag-list">{tags.map((tag) => <TagChip key={tag.id} tag={tag} />)}</span>;
}

export function ArticleHistoryPage({ id }: { id: string }) {
  const { navigate } = useNavigation();
  const [confirmRestore, setConfirmRestore] = useState(false);
  const { user } = useAuth();
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
        const history = await listArticleRevisions(id, controller.signal);
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
  }, [id]);

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
    if (!left || !latest || user?.role !== 'Moderator' || left.version === latest.version) return;
    setRestoring(true);
    setError('');
    try {
      await restoreArticleRevision(id, left.version, latest.version);
      navigate(routeHref({ page: 'article', id }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The revision could not be restored.');
      setRestoring(false);
      setConfirmRestore(false);
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
        <Link to={routeHref({ page: 'article', id })}>{latest.title}</Link><span>/</span>
        <span aria-current="page">Revision history</span>
      </nav>
      {error && <p className="error-note" role="alert">{error}</p>}
      <header className="history-header">
        <div>
          <p className="eyebrow">Archive version control</p>
          <h1>Revision history</h1>
          <p>Compare the five most recent copies of “{latest.title}”.</p>
        </div>
        <HistoryIcon aria-hidden="true" />
      </header>

      <ol className="revision-list" aria-label="Article revisions">
        {revisions.map((revision, index) => (
          <li key={revision.version}>
            <strong>{revisionLabel(revision, index)}</strong>
            <span><ClockIcon aria-hidden="true" /><time dateTime={revision.revisedAt}>{isoTimestamp(revision.revisedAt)}</time></span>
            <span><UserRoundIcon aria-hidden="true" />{revision.revisedByName}</span>
          </li>
        ))}
      </ol>

      <section className="comparison-panel" aria-labelledby="comparison-title">
        <div className="comparison-heading">
          <div>
            <p className="eyebrow">Side-by-side comparison</p>
            <h2 id="comparison-title"><ArrowLeftRightIcon aria-hidden="true" />Compare revisions</h2>
          </div>
          {user?.role === 'Moderator' && (
            <button
              className="button button-secondary"
              disabled={restoring || left.version === latest.version}
              aria-haspopup="dialog"
              aria-expanded={confirmRestore}
              onClick={() => setConfirmRestore(true)}
            >
              <RotateCcwIcon aria-hidden="true" />{restoring ? 'Restoring…' : `Restore version ${left.version}`}
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
          <div className={sameTags(left.tags, right.tags) ? '' : 'changed'}><dt>Tags</dt><dd>{tagList(left.tags)}</dd><dd>{tagList(right.tags)}</dd></div>
          <div className={left.visibility === right.visibility ? '' : 'changed'}>
            <dt>Visibility</dt>
            <dd><VisibilityChip visibility={left.visibility} /></dd>
            <dd><VisibilityChip visibility={right.visibility} /></dd>
          </div>
          <div className={left.isProtected === right.isProtected ? '' : 'changed'}>
            <dt>Protection</dt>
            <dd><ShieldCheckIcon aria-hidden="true" />{left.isProtected ? 'Protected' : 'Unprotected'}</dd>
            <dd><ShieldCheckIcon aria-hidden="true" />{right.isProtected ? 'Protected' : 'Unprotected'}</dd>
          </div>
          <div className={left.isPinned === right.isPinned ? '' : 'changed'}>
            <dt>Pin status</dt>
            <dd><PinIcon aria-hidden="true" />{left.isPinned ? 'Pinned' : 'Not pinned'}</dd>
            <dd><PinIcon aria-hidden="true" />{right.isPinned ? 'Pinned' : 'Not pinned'}</dd>
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
      {confirmRestore && (
        <ConfirmDialog
          title={`Restore version ${left.version}?`}
          description={`Version ${left.version} becomes a new latest revision. The current version stays in the history.`}
          confirmLabel={restoring ? 'Restoring…' : 'Restore'}
          busy={restoring}
          onConfirm={() => void restore()}
          onCancel={() => setConfirmRestore(false)}
        />
      )}
    </div>
  );
}
