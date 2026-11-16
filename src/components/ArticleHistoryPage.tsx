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
import { formatTranslation, type Translations } from '../translations';
import { useI18n } from './I18n';
import { ArrowLeftRightIcon, ClockIcon, HistoryIcon, PinIcon, RotateCcwIcon, ShieldCheckIcon, UserRoundIcon } from './Icons';

function revisionLabel(revision: ArticleRevision, index: number, t: Translations) {
  const template = index === 0 ? t.history.latest : index === 1 ? t.history.previous : t.history.version;
  return formatTranslation(template, { version: revision.version });
}

function sameTags(left: ArticleRevision['tags'], right: ArticleRevision['tags']) {
  return left.length === right.length && left.every((tag, index) => tag.id === right[index].id);
}

function tagList(tags: ArticleRevision['tags'], t: Translations) {
  if (!tags.length) return t.common.none;
  return <span className="tag-list">{tags.map((tag) => <TagChip key={tag.id} tag={tag} />)}</span>;
}

export function ArticleHistoryPage({ id }: { id: string }) {
  const { navigate } = useNavigation();
  const { t, dateTime, error: describe } = useI18n();
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
          setError(describe(cause));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [describe, id]);

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
      setError(describe(cause));
      setRestoring(false);
      setConfirmRestore(false);
    }
  }

  if (loading) return <LoadingState message={t.history.loading} />;
  if (!latest || !left || !right) {
    return <ErrorState message={error || t.history.empty} />;
  }

  return (
    <div className="page history-page">
      <nav className="breadcrumbs" aria-label={t.common.breadcrumb}>
        <Link to="/">{t.common.knowledgeBase}</Link><span>/</span>
        <Link to={routeHref({ page: 'article', id })}>{latest.title}</Link><span>/</span>
        <span aria-current="page">{t.history.title}</span>
      </nav>
      {error && <p className="error-note" role="alert">{error}</p>}
      <header className="history-header">
        <div>
          <p className="eyebrow">{t.history.eyebrow}</p>
          <h1>{t.history.title}</h1>
          <p>{formatTranslation(t.history.intro, { title: latest.title })}</p>
        </div>
        <HistoryIcon />
      </header>

      <ol className="revision-list" aria-label={t.history.revisions}>
        {revisions.map((revision, index) => (
          <li key={revision.version}>
            <strong>{revisionLabel(revision, index, t)}</strong>
            <span><ClockIcon aria-hidden="true" /><time dateTime={revision.revisedAt}>{dateTime(revision.revisedAt)}</time></span>
            <span><UserRoundIcon aria-hidden="true" />{revision.revisedByName}</span>
          </li>
        ))}
      </ol>

      <section className="comparison-panel" aria-labelledby="comparison-title">
        <div className="comparison-heading">
          <div>
            <p className="eyebrow">{t.history.compareEyebrow}</p>
            <h2 id="comparison-title"><ArrowLeftRightIcon />{t.history.compareTitle}</h2>
          </div>
          {user?.role === 'Moderator' && (
            <button
              className="button button-secondary"
              disabled={restoring || left.version === latest.version}
              aria-haspopup="dialog"
              aria-expanded={confirmRestore}
              onClick={() => setConfirmRestore(true)}
            >
              <RotateCcwIcon />{restoring ? t.history.restoring : formatTranslation(t.history.restore, { version: left.version })}
            </button>
          )}
        </div>

        <div className="revision-selectors">
          <label className="field"><span>{t.history.earlier}</span>
            <select value={left.version} onChange={(event) => setLeftVersion(Number(event.target.value))}>
              {revisions.map((revision, index) => (
                <option key={revision.version} value={revision.version}>{revisionLabel(revision, index, t)}</option>
              ))}
            </select>
          </label>
          <label className="field"><span>{t.history.later}</span>
            <select value={right.version} onChange={(event) => setRightVersion(Number(event.target.value))}>
              {revisions.map((revision, index) => (
                <option key={revision.version} value={revision.version}>{revisionLabel(revision, index, t)}</option>
              ))}
            </select>
          </label>
        </div>

        <dl className="revision-comparison-metadata">
          <div className={left.title === right.title ? '' : 'changed'}><dt>{t.history.fieldTitle}</dt><dd>{left.title}</dd><dd>{right.title}</dd></div>
          <div className={sameTags(left.tags, right.tags) ? '' : 'changed'}><dt>{t.history.fieldTags}</dt><dd>{tagList(left.tags, t)}</dd><dd>{tagList(right.tags, t)}</dd></div>
          <div className={left.visibility === right.visibility ? '' : 'changed'}>
            <dt>{t.history.fieldVisibility}</dt>
            <dd><VisibilityChip visibility={left.visibility} /></dd>
            <dd><VisibilityChip visibility={right.visibility} /></dd>
          </div>
          <div className={left.isProtected === right.isProtected ? '' : 'changed'}>
            <dt>{t.history.fieldProtection}</dt>
            <dd><ShieldCheckIcon />{left.isProtected ? t.history.protected : t.history.unprotected}</dd>
            <dd><ShieldCheckIcon />{right.isProtected ? t.history.protected : t.history.unprotected}</dd>
          </div>
          <div className={left.isPinned === right.isPinned ? '' : 'changed'}>
            <dt>{t.history.fieldPinned}</dt>
            <dd><PinIcon />{left.isPinned ? t.history.pinned : t.history.notPinned}</dd>
            <dd><PinIcon />{right.isPinned ? t.history.pinned : t.history.notPinned}</dd>
          </div>
        </dl>

        <div className={`revision-content-grid ${left.content === right.content ? '' : 'changed'}`}>
          <section aria-labelledby="left-content-title">
            <h3 id="left-content-title">{formatTranslation(t.history.content, { version: left.version })}</h3>
            <pre>{left.content}</pre>
          </section>
          <section aria-labelledby="right-content-title">
            <h3 id="right-content-title">{formatTranslation(t.history.content, { version: right.version })}</h3>
            <pre>{right.content}</pre>
          </section>
        </div>
      </section>
      {confirmRestore && (
        <ConfirmDialog
          title={formatTranslation(t.history.restoreTitle, { version: left.version })}
          description={formatTranslation(t.history.restoreText, { version: left.version })}
          confirmLabel={restoring ? t.history.restoring : t.history.restoreConfirm}
          busy={restoring}
          onConfirm={() => void restore()}
          onCancel={() => setConfirmRestore(false)}
        />
      )}
    </div>
  );
}
