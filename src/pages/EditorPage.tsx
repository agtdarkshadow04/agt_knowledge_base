import { Eye, EyeOff, FilePenLine, Save, X } from 'lucide-react';
import { FormEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { MarkdownContent } from '../components/MarkdownContent';
import { ErrorState, LoadingState } from '../components/States';
import { TagPicker } from '../components/TagPicker';
import { ApiError, createArticle, getArticle, listTags, updateArticle } from '../services/api';
import type { ArticleVisibility, CanonicalTag } from '../types';

type EditorMode = 'plain' | 'rich';

const RichMarkdownEditor = lazy(() => import('../components/RichMarkdownEditor').then((module) => ({
  default: module.RichMarkdownEditor,
})));

interface Draft {
  title: string;
  tagIds: string[];
  content: string;
  visibility: ArticleVisibility;
}

const emptyDraft: Draft = { title: '', tagIds: [], content: '', visibility: 'Internal' };

function serializeDraft(draft: Draft) {
  return JSON.stringify(draft);
}

function MarkdownGuideIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 2h9l5 5v15H6z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  );
}

export function EditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const { user, getToken } = useAuth();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [baseline, setBaseline] = useState(serializeDraft(emptyDraft));
  const [version, setVersion] = useState<number | undefined>();
  const [mode, setMode] = useState<EditorMode>('plain');
  const [preview, setPreview] = useState(false);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [saveConfirmationOpen, setSaveConfirmationOpen] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState('');
  const [catalogTags, setCatalogTags] = useState<CanonicalTag[]>([]);
  const [knownTags, setKnownTags] = useState<CanonicalTag[]>([]);
  const [tagsLoading, setTagsLoading] = useState(true);
  const [tagsReady, setTagsReady] = useState(false);
  const [tagsError, setTagsError] = useState('');
  const allowNavigation = useRef(false);
  const dirty = serializeDraft(draft) !== baseline;

  const rememberTags = useCallback((nextTags: CanonicalTag[]) => {
    setKnownTags((current) => {
      const byId = new Map(current.map((tag) => [tag.id, tag]));
      nextTags.forEach((tag) => byId.set(tag.id, tag));
      return [...byId.values()];
    });
  }, []);

  const refreshTagCatalog = useCallback(async (signal?: AbortSignal) => {
    setTagsLoading(true);
    setTagsReady(false);
    setTagsError('');
    try {
      const nextTags = await listTags('', signal);
      if (signal?.aborted) return null;
      setCatalogTags(nextTags);
      rememberTags(nextTags);
      setTagsReady(true);
      return nextTags;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return null;
      setTagsError(cause instanceof Error ? cause.message : 'Tags could not be verified.');
      return null;
    } finally {
      if (!signal?.aborted) setTagsLoading(false);
    }
  }, [rememberTags]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshTagCatalog(controller.signal);
    return () => controller.abort();
  }, [refreshTagCatalog]);

  useEffect(() => {
    if (!id) return;
    const articleId = id;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      try {
        const article = await getArticle(articleId, controller.signal, await getToken());
        if (article.isProtected && user?.role !== 'Admin') {
          setLoadError('This protected article can only be edited by an Administrator.');
          return;
        }
        const loaded = { title: article.title, tagIds: article.tags.map((tag) => tag.id), content: article.content, visibility: article.visibility };
        rememberTags(article.tags);
        setDraft(loaded);
        setBaseline(serializeDraft(loaded));
        setVersion(article.version);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setLoadError(cause instanceof Error ? cause.message : 'Article could not be opened.');
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [getToken, id, rememberTags, user?.role]);

  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', listener);
    return () => window.removeEventListener('beforeunload', listener);
  }, [dirty]);

  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && !allowNavigation.current && currentLocation.pathname !== nextLocation.pathname,
  );

  const currentRevision = useMemo(() => JSON.parse(baseline) as Draft, [baseline]);
  const proposedRevision = useMemo(() => ({
    title: draft.title.trim(),
    tagIds: draft.tagIds,
    content: draft.content,
    visibility: draft.visibility,
  }), [draft.content, draft.tagIds, draft.title, draft.visibility]);
  const knownTagsById = useMemo(() => new Map(knownTags.map((tag) => [tag.id, tag])), [knownTags]);
  const invalidTagIds = useMemo(() => {
    if (!tagsReady) return [];
    const available = new Set(catalogTags.map((tag) => tag.id));
    return draft.tagIds.filter((tagId) => !available.has(tagId));
  }, [catalogTags, draft.tagIds, tagsReady]);

  function tagNames(tagIds: string[]) {
    return tagIds.map((tagId) => knownTagsById.get(tagId)?.name ?? 'Unavailable tag').join(', ');
  }

  function sameTagIds(left: string[], right: string[]) {
    return left.length === right.length && left.every((tagId, index) => tagId === right[index]);
  }

  function validate(verifiedTags: CanonicalTag[] | null = tagsReady ? catalogTags : null) {
    const next: Record<string, string> = {};
    if (draft.title.trim().length < 3) next.title = 'Enter a title with at least 3 characters.';
    if (draft.title.length > 180) next.title = 'Keep the title to 180 characters or fewer.';
    if (draft.content.trim().length < 20) next.content = 'Article content must contain at least 20 characters.';
    if (draft.tagIds.length > 12) next.tags = 'Use no more than 12 tags.';
    if (!verifiedTags) next.tags = 'Tags could not be verified. Refresh the tag catalog and try again.';
    else {
      const available = new Set(verifiedTags.map((tag) => tag.id));
      if (draft.tagIds.some((tagId) => !available.has(tagId))) {
        next.tags = 'A selected tag was renamed or deleted. Refresh the catalog, remove unavailable tags, and try again.';
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!validate()) return;
    setSaveError('');
    const verifiedTags = await refreshTagCatalog();
    if (!validate(verifiedTags)) return;
    setSaveConfirmationOpen(true);
  }

  async function confirmSave() {
    setSaving(true);
    setSaveError('');
    try {
      const input = { title: draft.title.trim(), content: draft.content, tagIds: draft.tagIds, visibility: draft.visibility, version };
      const saved = isNew
        ? await createArticle(input, await getToken())
        : await updateArticle(id, input, await getToken());
      const savedDraft = { title: saved.title, tagIds: saved.tags.map((tag) => tag.id), content: saved.content, visibility: saved.visibility };
      setBaseline(serializeDraft(savedDraft));
      allowNavigation.current = true;
      navigate(`/articles/${saved.id}`, { replace: true });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setSaveError('This article changed after you opened it. Copy your work, reload the latest version, and merge your changes.');
      } else if (cause instanceof ApiError && cause.status === 400 && /tag/i.test(cause.message)) {
        setSaveError('One or more selected tags is no longer valid. Refresh the tag catalog, review your selections, and try again.');
        await refreshTagCatalog();
      } else {
        setSaveError(cause instanceof Error ? cause.message : 'Article could not be saved.');
      }
      setSaveConfirmationOpen(false);
    } finally { setSaving(false); }
  }

  function cancel() {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return;
    allowNavigation.current = true;
    navigate(isNew ? '/' : `/articles/${id}`);
  }

  if (loading) return <LoadingState message="Preparing editor…" />;
  if (loadError) return <ErrorState message={loadError} />;

  return (
    <div className="page editor-page">
      <header className="editor-header">
        <div><p className="eyebrow">Authoring terminal</p><h1>{isNew ? 'Create article' : 'Edit article'}</h1></div>
        <span className={`save-state ${dirty ? 'dirty' : ''}`}>{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
      </header>

      {saveError && <div className="inline-alert" role="alert">{saveError}</div>}
      <form onSubmit={(event) => void handleSave(event)} noValidate>
        <div className="editor-fields">
          <label className="field"><span>Title</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} aria-invalid={Boolean(errors.title)} aria-describedby={errors.title ? 'title-error' : undefined} /></label>
          {errors.title && <p className="field-error" id="title-error">{errors.title}</p>}
          <TagPicker
            tags={catalogTags}
            knownTags={knownTags}
            selectedIds={draft.tagIds}
            loading={tagsLoading}
            error={errors.tags || tagsError}
            onChange={(tagIds) => {
              setDraft({ ...draft, tagIds });
              setErrors((current) => ({ ...current, tags: '' }));
            }}
            onRefresh={() => void refreshTagCatalog()}
          />
          <label className="field"><span>Visibility</span>
            <select value={draft.visibility} onChange={(event) => setDraft({ ...draft, visibility: event.target.value as ArticleVisibility })}>
              <option value="Public">Public</option>
              <option value="Internal">Internal</option>
              {user?.role === 'Admin' && <option value="Admin">Admin</option>}
            </select>
          </label>
        </div>

        <div className="editor-toolbar" aria-label="Editor options">
          <div className="segmented-control" aria-label="Markdown editor mode">
            <button type="button" className={mode === 'plain' ? 'active' : ''} onClick={() => setMode('plain')}>Plain Markdown</button>
            <button type="button" className={mode === 'rich' ? 'active' : ''} onClick={() => setMode('rich')}>Visual Markdown</button>
          </div>
          <div className="editor-toolbar-actions">
            <a className="icon-button" href="https://www.markdownguide.org/basic-syntax/" target="_blank" rel="noreferrer" title="Markdown Guide"><MarkdownGuideIcon /><span className="sr-only">Markdown Guide</span></a>
            <button className="icon-button" type="button" onClick={cancel} title="Exit without saving"><X aria-hidden="true" /><span className="sr-only">Exit without saving</span></button>
            <button className="icon-button" type="submit" disabled={saving || tagsLoading || !tagsReady || invalidTagIds.length > 0} title="Save article"><Save aria-hidden="true" /><span className="sr-only">Save article</span></button>
            <button className="icon-button" type="button" aria-pressed={preview} onClick={() => setPreview((value) => !value)} title={preview ? 'Hide preview' : 'Show preview'}>
              {preview ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              <span className="sr-only">{preview ? 'Hide preview' : 'Show preview'}</span>
            </button>
          </div>
        </div>

        <div className={`editor-workspace ${preview ? 'with-preview' : ''}`}>
          <section aria-labelledby="editor-label" className="editor-input-panel">
            <h2 id="editor-label"><FilePenLine aria-hidden="true" />{mode === 'plain' ? 'Markdown source' : 'Visual Markdown editor'}</h2>
            {mode === 'plain' ? (
              <textarea aria-label="Markdown source" className="markdown-textarea" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} spellCheck aria-invalid={Boolean(errors.content)} aria-describedby={errors.content ? 'content-error' : 'content-help'} />
            ) : (
              <Suspense fallback={<LoadingState message="Loading visual editor…" />}>
                <RichMarkdownEditor value={draft.content} onChange={(content) => setDraft((current) => ({ ...current, content }))} />
              </Suspense>
            )}
            <p id="content-help" className="field-help">Markdown only. Executable MDX and unsafe HTML are rejected by the API.</p>
            {errors.content && <p className="field-error" id="content-error">{errors.content}</p>}
          </section>
          {preview && <section className="preview-panel" aria-labelledby="preview-label"><h2 id="preview-label">Preview</h2><MarkdownContent content={draft.content || '*Preview will appear here.*'} /></section>}
        </div>

      </form>

      {saveConfirmationOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="confirm-dialog save-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="save-confirm-title" aria-describedby="save-confirm-description">
            <h2 id="save-confirm-title">Review changes before saving</h2>
            <p id="save-confirm-description">Compare the current revision with your proposed revision, then confirm to save.</p>
            <div className="save-diff-headings" aria-hidden="true"><span>Field</span><span>Current revision</span><span>New revision</span></div>
            <dl className="revision-comparison-metadata save-diff-metadata">
              <div className={currentRevision.title === proposedRevision.title ? '' : 'changed'}><dt>Title</dt><dd>{currentRevision.title || 'Not set'}</dd><dd>{proposedRevision.title || 'Not set'}</dd></div>
              <div className={sameTagIds(currentRevision.tagIds, proposedRevision.tagIds) ? '' : 'changed'}><dt>Tags</dt><dd>{tagNames(currentRevision.tagIds) || 'None'}</dd><dd>{tagNames(proposedRevision.tagIds) || 'None'}</dd></div>
              <div className={currentRevision.visibility === proposedRevision.visibility ? '' : 'changed'}><dt>Visibility</dt><dd>{currentRevision.visibility}</dd><dd>{proposedRevision.visibility}</dd></div>
            </dl>
            <div className={`revision-content-grid save-diff-content ${currentRevision.content === proposedRevision.content ? '' : 'changed'}`}>
              <section aria-labelledby="current-content-title"><h3 id="current-content-title">Current revision content</h3><pre>{currentRevision.content || 'No content'}</pre></section>
              <section aria-labelledby="new-content-title"><h3 id="new-content-title">New revision content</h3><pre>{proposedRevision.content || 'No content'}</pre></section>
            </div>
            <div className="dialog-actions">
              <button className="button button-primary" type="button" disabled={saving} onClick={() => void confirmSave()}><Save aria-hidden="true" />{saving ? 'Saving…' : 'Confirm save'}</button>
              <button className="button button-secondary" type="button" disabled={saving} autoFocus onClick={() => setSaveConfirmationOpen(false)}>Keep editing</button>
            </div>
          </section>
        </div>
      )}

      {blocker.state === 'blocked' && (
        <div className="modal-backdrop" role="presentation">
          <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-description">
            <h2 id="discard-title">Discard unsaved changes?</h2>
            <p id="discard-description">Your draft has not been saved to the archive.</p>
            <div className="dialog-actions"><button className="button button-danger" onClick={() => blocker.proceed()}>Discard and leave</button><button className="button button-secondary" autoFocus onClick={() => blocker.reset()}>Keep editing</button></div>
          </section>
        </div>
      )}
    </div>
  );
}
