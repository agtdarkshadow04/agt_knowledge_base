import { Clock3, Edit3, LockKeyhole, ShieldCheck, Tag, Trash2, UnlockKeyhole, UserRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { extractHeadings, MarkdownContent } from '../components/MarkdownContent';
import { ErrorState, LoadingState } from '../components/States';
import { deleteArticle, getArticle, setArticleProtection } from '../services/api';
import type { Article } from '../types';

function formatTimestamp(value: string) {
  return `${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value))} UTC`;
}

export function ArticlePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { user, getToken } = useAuth();
  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setArticle(await getArticle(id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Article not found.'); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  const headings = useMemo(() => extractHeadings(article?.content ?? ''), [article?.content]);
  const isAdmin = user?.role === 'Admin';
  const canEdit = Boolean(user && article && (isAdmin || !article.isProtected));

  async function toggleProtection() {
    if (!article || !isAdmin) return;
    setActionBusy(true);
    setError('');
    try {
      const token = await getToken();
      setArticle(await setArticleProtection(article.id, !article.isProtected, article.version, token));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Protection status could not be changed.'); }
    finally { setActionBusy(false); }
  }

  async function removeArticle() {
    if (!article || !isAdmin || !window.confirm(`Permanently delete “${article.title}”?`)) return;
    setActionBusy(true);
    try {
      await deleteArticle(article.id, article.version, await getToken());
      navigate('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Article could not be deleted.');
      setActionBusy(false);
    }
  }

  if (loading) return <LoadingState message="Opening transmission…" />;
  if (!article) return <ErrorState message={error || 'Article not found.'} onRetry={() => void load()} />;

  return (
    <div className="page article-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><Link to="/">Knowledge Base</Link><span>/</span><span aria-current="page">{article.title}</span></nav>
      {error && <div className="inline-alert" role="alert">{error}</div>}
      <header className="article-header">
        <div className="article-title-row">
          <div>
            <p className="eyebrow">Archive entry // version {article.version}</p>
            <h1>{article.title}</h1>
          </div>
          {article.isProtected && <span className="status-chip protected"><LockKeyhole aria-hidden="true" />Protected</span>}
        </div>
        <div className="tag-list">{article.tags.map((tag) => <span className="tag" key={tag}><Tag aria-hidden="true" />{tag}</span>)}</div>
        <dl className="audit-grid">
          <div><dt><UserRound aria-hidden="true" />Created by</dt><dd>{article.createdByName}</dd></div>
          <div><dt><Clock3 aria-hidden="true" />Created</dt><dd>{formatTimestamp(article.createdAt)}</dd></div>
          <div><dt><UserRound aria-hidden="true" />Last edited by</dt><dd>{article.modifiedByName}</dd></div>
          <div><dt><Clock3 aria-hidden="true" />Last modified</dt><dd>{formatTimestamp(article.modifiedAt)}</dd></div>
        </dl>
        {(canEdit || isAdmin) && (
          <div className="article-actions">
            {canEdit && <Link className="button button-primary" to={`/articles/${article.id}/edit`}><Edit3 aria-hidden="true" />Edit article</Link>}
            {isAdmin && (
              <button className="button button-secondary" disabled={actionBusy} onClick={() => void toggleProtection()}>
                {article.isProtected ? <UnlockKeyhole aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                {article.isProtected ? 'Unprotect' : 'Protect'}
              </button>
            )}
            {isAdmin && <button className="button button-danger" disabled={actionBusy} onClick={() => void removeArticle()}><Trash2 aria-hidden="true" />Delete</button>}
          </div>
        )}
      </header>

      <div className={`article-layout ${headings.length ? '' : 'without-toc'}`}>
        {headings.length > 0 && (
          <aside className="toc" aria-labelledby="toc-title">
            <h2 id="toc-title">Contents</h2>
            <ol>{headings.map((heading) => <li className={`depth-${heading.depth}`} key={heading.id}><a href={`#${heading.id}`}>{heading.text}</a></li>)}</ol>
          </aside>
        )}
        <article className="article-body"><MarkdownContent content={article.content} /></article>
      </div>
    </div>
  );
}
