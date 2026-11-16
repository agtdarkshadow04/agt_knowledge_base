import { FormEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { Markdown } from './Markdown';
import { ErrorState, LoadingState } from './States';
import { TagPicker } from './TagPicker';
import { createArticle, getArticle, listTags, updateArticle } from '../lib/memberApi';
import { ApiError } from '../lib/client';
import { useAppSettings } from './AppSettingsContext';
import type { ArticleVisibility, CanonicalTag } from '../lib/api';
import {
  agtVisibilityOptions,
  isModeratorOnlyVisibility,
  legacyVisibilityOptions,
  parseArticleVisibility,
  visibilityLabel,
} from '../lib/visibility';
import { routeHref } from '../lib/routes';
import { fieldMessages, parseArticleWrite, validate as validateInput } from '../lib/validation';
import { ConfirmDialog, Dialog } from './Dialog';
import { CloseIcon, EyeIcon, EyeOffIcon, FilePenLineIcon, SaveIcon } from './Icons';
import { useBlocker, useNavigation } from './Navigation';

type EditorMode = 'plain' | 'rich';

const RichMarkdownEditor = lazy(() => import('./RichMarkdownEditor').then((module) => ({
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
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 2h9l5 5v15H6z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  );
}

export function EditorPage({ id }: { id?: string }) {
  const isNew = !id;
  const { navigate } = useNavigation();
  const keepEditing = useRef<HTMLButtonElement>(null);
  const { user } = useAuth();
  const { settings } = useAppSettings();
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
      const nextTags = await listTags('', signal, true);
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
    if (!isNew || draft.title || draft.content || draft.tagIds.length || baseline !== serializeDraft(emptyDraft)) return;
    const next = {
      ...emptyDraft,
      visibility: isModeratorOnlyVisibility(settings.articles.defaultVisibility) && user?.role !== 'Moderator'
        ? 'Internal'
        : settings.articles.defaultVisibility,
    };
    setDraft(next);
    setBaseline(serializeDraft(next));
  }, [baseline, draft.content, draft.tagIds.length, draft.title, isNew, settings.articles.defaultVisibility, user?.role]);

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
        const article = await getArticle(articleId, controller.signal, true);
        if (article.isProtected && user?.role !== 'Moderator') {
          setLoadError('This protected article can only be edited by a Moderator.');
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
  }, [id, rememberTags, user?.role]);

  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', listener);
    return () => window.removeEventListener('beforeunload', listener);
  }, [dirty]);

  const blocker = useBlocker(dirty);

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
    // FE-6: the server's own rules, then the checks only the browser can make against the tag catalog.
    const checked = validateInput(parseArticleWrite, { title: draft.title, content: draft.content, tagIds: draft.tagIds, visibility: draft.visibility, version });
    const shared = checked.ok ? {} : fieldMessages(checked.fields);
    const next: Record<string, string> = {};
    if (shared.title) next.title = shared.title;
    if (shared.content) next.content = shared.content;
    if (shared.tagIds) next.tags = shared.tagIds;
    if (!next.tags && !verifiedTags) next.tags = 'Tags could not be verified. Refresh the tag catalog and try again.';
    if (!next.tags && verifiedTags) {
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
        ? await createArticle(input)
        : await updateArticle(id, input);
      const savedDraft = { title: saved.title, tagIds: saved.tags.map((tag) => tag.id), content: saved.content, visibility: saved.visibility };
      setBaseline(serializeDraft(savedDraft));
      navigate(routeHref({ page: 'article', id: saved.id }), { replace: true, force: true });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setSaveError('This article changed after you opened it. Copy your work, reload the latest version, and merge your changes.');
      } else if (cause instanceof ApiError && cause.status === 400 && (cause.fields.some((field) => field.field.startsWith('tagIds')) || /tag/i.test(cause.message))) {
        setSaveError('One or more selected tags is no longer valid. Refresh the tag catalog, review your selections, and try again.');
        await refreshTagCatalog();
      } else {
        setSaveError(cause instanceof Error ? cause.message : 'Article could not be saved.');
      }
      setSaveConfirmationOpen(false);
    } finally { setSaving(false); }
  }

  function cancel() {
    // With unsaved changes, the blocker asks first.
    navigate(isNew || !id ? '/' : routeHref({ page: 'article', id }));
  }

  if (loading) return <LoadingState message="Preparing editor…" />;
  if (loadError) return <ErrorState message={loadError} />;

  return (
    <div className="page editor-page">
      <header className="editor-header">
        <div><p className="eyebrow">Authoring terminal</p><h1>{isNew ? 'Create article' : 'Edit article'}</h1></div>
        <span className={`save-state ${dirty ? 'dirty' : ''}`} role="status">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
      </header>

      {saveError && <p className="error-note" role="alert">{saveError}</p>}
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
            <select value={draft.visibility} onChange={(event) => setDraft({ ...draft, visibility: parseArticleVisibility(event.target.value) })}>
              <optgroup label="AGT standard">
                {agtVisibilityOptions.filter((option) => user?.role === 'Moderator' || !option.moderatorOnly).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </optgroup>
              <optgroup label="Legacy">
                {legacyVisibilityOptions.filter((option) => user?.role === 'Moderator' || !option.moderatorOnly).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </optgroup>
            </select>
          </label>
        </div>

        <div className="editor-toolbar" aria-label="Editor options">
          <div className="segmented-control" aria-label="Markdown editor mode">
            <button type="button" className={mode === 'plain' ? 'active' : ''} aria-pressed={mode === 'plain'} onClick={() => setMode('plain')}>Plain Markdown</button>
            <button type="button" className={mode === 'rich' ? 'active' : ''} aria-pressed={mode === 'rich'} onClick={() => setMode('rich')}>Visual Markdown</button>
          </div>
          <div className="editor-toolbar-actions">
            <a className="button button-icon" href="https://www.markdownguide.org/basic-syntax/" target="_blank" rel="noreferrer" title="Markdown Guide"><MarkdownGuideIcon /><span className="sr-only">Markdown Guide</span></a>
            <button className="button button-icon" type="button" onClick={cancel} title="Exit without saving"><CloseIcon aria-hidden="true" /><span className="sr-only">Exit without saving</span></button>
            <button className="button button-icon" type="submit" disabled={saving || tagsLoading || !tagsReady || invalidTagIds.length > 0} title="Save article"><SaveIcon aria-hidden="true" /><span className="sr-only">Save article</span></button>
            <button className="button button-icon" type="button" aria-pressed={preview} onClick={() => setPreview((value) => !value)} title={preview ? 'Hide preview' : 'Show preview'}>
              {preview ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
              <span className="sr-only">{preview ? 'Hide preview' : 'Show preview'}</span>
            </button>
          </div>
        </div>

        <div className={`editor-workspace ${preview ? 'with-preview' : ''}`}>
          <section aria-labelledby="editor-label" className="editor-input-panel">
            <h2 id="editor-label"><FilePenLineIcon aria-hidden="true" />{mode === 'plain' ? 'Markdown source' : 'Visual Markdown editor'}</h2>
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
          {preview && <section className="preview-panel" aria-labelledby="preview-label"><h2 id="preview-label">Preview</h2><Markdown content={draft.content || '*Preview will appear here.*'} /></section>}
        </div>

      </form>

      {saveConfirmationOpen && (
        <Dialog
          title="Review changes before saving"
          description="Compare the current revision with your proposed revision, then confirm to save."
          onClose={() => { if (!saving) setSaveConfirmationOpen(false); }}
          initialFocusRef={keepEditing}
          className="save-confirm-dialog"
          footer={(
            <>
              <button className="button button-primary" type="button" disabled={saving} onClick={() => void confirmSave()}><SaveIcon />{saving ? 'Saving…' : 'Confirm save'}</button>
              <button ref={keepEditing} className="button button-secondary" type="button" disabled={saving} onClick={() => setSaveConfirmationOpen(false)}>Keep editing</button>
            </>
          )}
        >
          <div className="save-diff-headings" aria-hidden="true"><span>Field</span><span>Current revision</span><span>New revision</span></div>
          <dl className="revision-comparison-metadata save-diff-metadata">
            <div className={currentRevision.title === proposedRevision.title ? '' : 'changed'}><dt>Title</dt><dd>{currentRevision.title || 'Not set'}</dd><dd>{proposedRevision.title || 'Not set'}</dd></div>
            <div className={sameTagIds(currentRevision.tagIds, proposedRevision.tagIds) ? '' : 'changed'}><dt>Tags</dt><dd>{tagNames(currentRevision.tagIds) || 'None'}</dd><dd>{tagNames(proposedRevision.tagIds) || 'None'}</dd></div>
            <div className={currentRevision.visibility === proposedRevision.visibility ? '' : 'changed'}><dt>Visibility</dt><dd>{visibilityLabel(currentRevision.visibility)}</dd><dd>{visibilityLabel(proposedRevision.visibility)}</dd></div>
          </dl>
          <div className={`revision-content-grid save-diff-content ${currentRevision.content === proposedRevision.content ? '' : 'changed'}`}>
            <section aria-labelledby="current-content-title"><h3 id="current-content-title">Current revision content</h3><pre>{currentRevision.content || 'No content'}</pre></section>
            <section aria-labelledby="new-content-title"><h3 id="new-content-title">New revision content</h3><pre>{proposedRevision.content || 'No content'}</pre></section>
          </div>
        </Dialog>
      )}

      {blocker.state === 'blocked' && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          description="Your draft has not been saved to the archive."
          confirmLabel="Discard and leave"
          cancelLabel="Keep editing"
          danger
          onConfirm={() => blocker.proceed()}
          onCancel={() => blocker.reset()}
        />
      )}
    </div>
  );
}
