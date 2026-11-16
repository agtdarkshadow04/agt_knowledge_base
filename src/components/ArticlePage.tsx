import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { extractHeadings, Markdown } from './Markdown';
import { ErrorState, LoadingState } from './States';
import { ConfirmDialog } from './Dialog';
import { Link, useNavigation } from './Navigation';
import { TagChip } from './TagChip';
import { VisibilityChip } from './VisibilityChip';
import { deleteArticle, getArticle, setArticlePinned, setArticleProtection, setArticleVerified } from '../lib/memberApi';
import type { Article } from '../lib/api';
import { preferencesChangedEvent, readPreferences } from '../lib/preferences';
import { routeHref } from '../lib/routes';
import { formatTranslation } from '../translations';
import { useI18n } from './I18n';
import { BadgeCheckIcon, ClockIcon, DownloadIcon, EditIcon, FileTextIcon, HistoryIcon, LockKeyholeIcon, PinIcon, ShieldCheckIcon, TrashIcon, UnlockKeyholeIcon, UserRoundIcon } from './Icons';

function downloadFilename(title: string, extension: 'md' | 'pdf') {
  const basename = title
    .trim()
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .slice(0, 100) || 'article';
  return `${basename}.${extension}`;
}

export function ArticlePage({ id }: { id: string }) {
  const { navigate } = useNavigation();
  const { user } = useAuth();
  const { t, dateTime, error: describe } = useI18n();
  const viewerSub = user?.sub;
  const articleBodyRef = useRef<HTMLElement>(null);
  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [allowDownloads, setAllowDownloads] = useState(() => readPreferences().allowDownloads);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setArticle(await getArticle(id, undefined, Boolean(viewerSub))); }
    catch (cause) { setError(describe(cause)); }
    finally { setLoading(false); }
  }, [describe, id, viewerSub]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const syncAllowDownloads = () => setAllowDownloads(readPreferences().allowDownloads);
    window.addEventListener(preferencesChangedEvent, syncAllowDownloads);
    window.addEventListener('storage', syncAllowDownloads);
    return () => {
      window.removeEventListener(preferencesChangedEvent, syncAllowDownloads);
      window.removeEventListener('storage', syncAllowDownloads);
    };
  }, []);
  const headings = useMemo(() => extractHeadings(article?.content ?? ''), [article?.content]);
  const isModerator = user?.role === 'Moderator';
  const canEdit = Boolean(user && article && (isModerator || !article.isProtected));

  function downloadMarkdown() {
    if (!article || !user) return;
    const url = URL.createObjectURL(new Blob([article.content], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = downloadFilename(article.title, 'md');
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadPdf() {
    if (!article || !articleBodyRef.current || !user) return;
    setPdfBusy(true);
    setError('');
    const pdfSource = document.createElement('section');
    pdfSource.className = 'pdf-export';
    pdfSource.setAttribute('aria-hidden', 'true');
    const title = document.createElement('h1');
    title.className = 'pdf-export-title';
    title.textContent = article.title;
    const articleBody = articleBodyRef.current.cloneNode(true) as HTMLElement;
    articleBody.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
    pdfSource.append(title, articleBody);

    try {
      const { default: html2pdf } = await import('html2pdf.js');
      await html2pdf()
        .set({
          margin: [12, 12],
          filename: downloadFilename(article.title, 'pdf'),
          image: { type: 'jpeg', quality: 0.98 },
          html2canvas: {
            backgroundColor: '#ffffff',
            scale: 2,
            useCORS: true,
            onclone: (clonedDocument: Document) => {
              // The PDF always uses the default text size, whatever the reader's font scale (A11Y-6).
              clonedDocument.documentElement.dataset.fontScale = '1';
            },
          },
          jsPDF: { format: 'a4', orientation: 'portrait', unit: 'mm' },
        })
        .from(pdfSource)
        .save();
    } catch (cause) {
      setError(cause instanceof Error && !('code' in cause) ? t.article.pdfFailed : describe(cause));
    } finally {
      setPdfBusy(false);
    }
  }

  async function toggleProtection() {
    if (!article || !isModerator) return;
    setActionBusy(true);
    setError('');
    setNotice('');
    try {
      setArticle(await setArticleProtection(article.id, !article.isProtected, article.version));
      setNotice(article.isProtected ? t.article.unprotectedNotice : t.article.protectedNotice);
    } catch (cause) { setError(describe(cause)); }
    finally { setActionBusy(false); }
  }

  async function togglePinned() {
    if (!article || !isModerator) return;
    setActionBusy(true);
    setError('');
    setNotice('');
    try {
      setArticle(await setArticlePinned(article.id, !article.isPinned, article.version));
      setNotice(article.isPinned ? t.article.unpinned : t.article.pinned);
    } catch (cause) { setError(describe(cause)); }
    finally { setActionBusy(false); }
  }

  async function toggleVerified() {
    if (!article || !isModerator) return;
    setActionBusy(true);
    setError('');
    setNotice('');
    try {
      setArticle(await setArticleVerified(article.id, !article.isVerified, article.version));
      setNotice(article.isVerified ? t.article.unverifiedNotice : t.article.verifiedNotice);
    } catch (cause) { setError(describe(cause)); }
    finally { setActionBusy(false); }
  }

  async function removeArticle() {
    if (!article || !isModerator) return;
    setActionBusy(true);
    try {
      await deleteArticle(article.id, article.version);
      navigate('/');
    } catch (cause) {
      setError(describe(cause));
      setActionBusy(false);
      setConfirmDelete(false);
    }
  }

  if (loading) return <LoadingState message={t.article.loading} />;
  if (!article) return <ErrorState message={error || t.article.notFound} onRetry={() => void load()} />;

  return (
    <div className="page article-page">
      <nav className="breadcrumbs" aria-label={t.common.breadcrumb}><Link to="/">{t.common.knowledgeBase}</Link><span>/</span><span aria-current="page">{article.title}</span></nav>
      {error && <p className="error-note" role="alert">{error}</p>}
      <div role="status" aria-live="polite">{notice && <p className="success-note">{notice}</p>}</div>
      <header className="article-header">
        <div className="article-title-row">
          <div>
            <p className="eyebrow">{formatTranslation(t.article.eyebrow, { version: article.version })}</p>
            <h1>{article.title}</h1>
          </div>
          <div className="article-status">
            <VisibilityChip visibility={article.visibility} />
            {article.isVerified && <span className="status-chip verified"><BadgeCheckIcon />{t.status.verified}</span>}
            {article.isPinned && <span className="status-chip pinned"><PinIcon />{t.status.pinned}</span>}
            {article.isProtected && <span className="status-chip protected"><LockKeyholeIcon />{t.status.protected}</span>}
          </div>
        </div>
        <div className="tag-list">{article.tags.map((tag) => <TagChip key={tag.id} tag={tag} />)}</div>
        <dl className="audit-grid">
          <div><dt><UserRoundIcon />{t.article.createdBy}</dt><dd>{article.createdByName}</dd></div>
          <div><dt><ClockIcon />{t.article.created}</dt><dd><time dateTime={article.createdAt}>{dateTime(article.createdAt)}</time></dd></div>
          <div><dt><UserRoundIcon />{t.article.modifiedBy}</dt><dd>{article.modifiedByName}</dd></div>
          <div><dt><ClockIcon />{t.article.modified}</dt><dd><time dateTime={article.modifiedAt}>{dateTime(article.modifiedAt)}</time></dd></div>
        </dl>
        {user && (
          <div className="article-actions">
            {allowDownloads && (
              <>
                <button className="button button-secondary" onClick={downloadMarkdown}>
                  <DownloadIcon /> {t.article.downloadMarkdown}
                </button>
                <button className="button button-secondary" disabled={pdfBusy} onClick={() => void downloadPdf()}>
                  <FileTextIcon />{pdfBusy ? t.article.creatingPdf : t.article.downloadPdf}
                </button>
              </>
            )}
            <Link className="button button-secondary" to={routeHref({ page: 'history', id: article.id })}><HistoryIcon />{t.article.history}</Link>
            {canEdit && <Link className="button button-primary" to={routeHref({ page: 'edit', id: article.id })}><EditIcon />{t.article.edit}</Link>}
            {isModerator && (
              <button className="button button-secondary" disabled={actionBusy} onClick={() => void togglePinned()}>
                <PinIcon />{article.isPinned ? t.article.unpin : t.article.pin}
              </button>
            )}
            {isModerator && (
              <button className="button button-secondary" disabled={actionBusy} onClick={() => void toggleVerified()}>
                <BadgeCheckIcon />{article.isVerified ? t.article.unverify : t.article.verify}
              </button>
            )}
            {isModerator && (
              <button className="button button-secondary" disabled={actionBusy} onClick={() => void toggleProtection()}>
                {article.isProtected ? <UnlockKeyholeIcon aria-hidden="true" /> : <ShieldCheckIcon aria-hidden="true" />}
                {article.isProtected ? t.article.unprotect : t.article.protect}
              </button>
            )}
            {isModerator && <button className="button button-danger" disabled={actionBusy} aria-haspopup="dialog" aria-expanded={confirmDelete} onClick={() => setConfirmDelete(true)}><TrashIcon />{t.article.delete}</button>}
          </div>
        )}
      </header>

      <div className={`article-layout ${headings.length ? '' : 'without-toc'}`}>
        {headings.length > 0 && (
          <aside className="toc" aria-labelledby="toc-title">
            <h2 id="toc-title">{t.article.contents}</h2>
            <ol>{headings.map((heading) => <li className={`depth-${heading.depth}`} key={heading.id}><a href={`#${heading.id}`}>{heading.text}</a></li>)}</ol>
          </aside>
        )}
        <article className="article-body" ref={articleBodyRef}><Markdown content={article.content} /></article>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title={t.article.deleteTitle}
          description={formatTranslation(t.article.deleteText, { title: article.title })}
          confirmLabel={actionBusy ? t.common.deleting : t.article.deleteConfirm}
          danger
          busy={actionBusy}
          onConfirm={() => void removeArticle()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
