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
  assignableOptions,
  initialVisibility,
  legacyVisibilityOptions,
  parseArticleVisibility,
  visibilityClassName,
} from '../lib/visibility';
import { routeHref } from '../lib/routes';
import { parseArticleWrite, validate as validateInput } from '../lib/validation';
import { formErrors } from './Field';
import { useI18n } from './I18n';
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
  const { t, error: describe } = useI18n();
  const keepEditing = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
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
      setTagsError(describe(cause));
      return null;
    } finally {
      if (!signal?.aborted) setTagsLoading(false);
    }
  }, [describe, rememberTags]);

  useEffect(() => {
    if (!isNew || draft.title || draft.content || draft.tagIds.length || baseline !== serializeDraft(emptyDraft)) return;
    const next = {
      ...emptyDraft,
      visibility: initialVisibility(settings.articles.defaultVisibility, user?.securityLevel ?? 0),
    };
    setDraft(next);
    setBaseline(serializeDraft(next));
  }, [baseline, draft.content, draft.tagIds.length, draft.title, isNew, settings.articles.defaultVisibility, user?.securityLevel]);

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
          setLoadError(t.editor.protectedOnly);
          return;
        }
        const loaded = { title: article.title, tagIds: article.tags.map((tag) => tag.id), content: article.content, visibility: article.visibility };
        rememberTags(article.tags);
        setDraft(loaded);
        setBaseline(serializeDraft(loaded));
        setVersion(article.version);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setLoadError(describe(cause));
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [describe, id, rememberTags, t.editor.protectedOnly, user?.role]);

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
    return tagIds.map((tagId) => knownTagsById.get(tagId)?.name ?? t.tagPicker.unavailableTag).join(', ');
  }

  function sameTagIds(left: string[], right: string[]) {
    return left.length === right.length && left.every((tagId, index) => tagId === right[index]);
  }

  function validate(verifiedTags: CanonicalTag[] | null = tagsReady ? catalogTags : null) {
    // FE-6: the server's own rules, then the checks only the browser can make against the tag catalog.
    const checked = validateInput(parseArticleWrite, { title: draft.title, content: draft.content, tagIds: draft.tagIds, visibility: draft.visibility, version });
    const shared = formErrors(checked, t).fields;
    const next: Record<string, string> = {};
    if (shared.title) next.title = shared.title;
    if (shared.content) next.content = shared.content;
    if (shared.tagIds) next.tags = shared.tagIds;
    if (!next.tags && !verifiedTags) next.tags = t.editor.tagsUnverified;
    if (!next.tags && verifiedTags) {
      const available = new Set(verifiedTags.map((tag) => tag.id));
      if (draft.tagIds.some((tagId) => !available.has(tagId))) {
        next.tags = t.editor.tagsChanged;
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
        setSaveError(t.editor.conflict);
      } else if (cause instanceof ApiError && cause.status === 400 && (cause.fields.some((field) => field.field.startsWith('tagIds')) || /tag/i.test(cause.message))) {
        setSaveError(t.editor.tagsInvalid);
        await refreshTagCatalog();
      } else {
        setSaveError(describe(cause));
      }
      setSaveConfirmationOpen(false);
    } finally { setSaving(false); }
  }

  function cancel() {
    // With unsaved changes, the blocker asks first.
    navigate(isNew || !id ? '/' : routeHref({ page: 'article', id }));
  }

  if (loading) return <LoadingState message={t.editor.loading} />;
  if (loadError) return <ErrorState message={loadError} />;

  return (
    <div className="page editor-page">
      <header className="editor-header">
        <div><p className="eyebrow">{t.editor.eyebrow}</p><h1>{isNew ? t.editor.createTitle : t.editor.editTitle}</h1></div>
        <span className={`save-state ${dirty ? 'dirty' : ''}`} role="status">{dirty ? t.editor.unsaved : t.editor.saved}</span>
      </header>

      {saveError && <p className="error-note" role="alert">{saveError}</p>}
      <form onSubmit={(event) => void handleSave(event)} noValidate>
        <div className="editor-fields">
          <label className="field"><span>{t.editor.title}</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} aria-invalid={Boolean(errors.title)} aria-describedby={errors.title ? 'title-error' : undefined} /></label>
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
          <label className="field"><span>{t.editor.visibility}</span>
            <select value={draft.visibility} onChange={(event) => setDraft({ ...draft, visibility: parseArticleVisibility(event.target.value) })}>
              <optgroup label={t.visibility.agtGroup}>
                {assignableOptions(agtVisibilityOptions, user?.securityLevel ?? 0).map((option) => (
                  <option key={option.value} value={option.value}>{t.visibility[option.className]}</option>
                ))}
              </optgroup>
              <optgroup label={t.visibility.legacyGroup}>
                {assignableOptions(legacyVisibilityOptions, user?.securityLevel ?? 0).map((option) => (
                  <option key={option.value} value={option.value}>{t.visibility[option.className]}</option>
                ))}
              </optgroup>
            </select>
          </label>
        </div>

        <div className="editor-toolbar" aria-label={t.editor.options}>
          <div className="segmented-control" role="group" aria-label={t.editor.mode}>
            <button type="button" className={mode === 'plain' ? 'active' : ''} aria-pressed={mode === 'plain'} onClick={() => setMode('plain')}>{t.editor.plain}</button>
            <button type="button" className={mode === 'rich' ? 'active' : ''} aria-pressed={mode === 'rich'} onClick={() => setMode('rich')}>{t.editor.rich}</button>
          </div>
          <div className="editor-toolbar-actions">
            <a className="button button-icon" href="https://www.markdownguide.org/basic-syntax/" target="_blank" rel="noreferrer" title={t.editor.guide} aria-label={t.editor.guide}><MarkdownGuideIcon /></a>
            <button className="button button-icon" type="button" onClick={cancel} title={t.editor.exit} aria-label={t.editor.exit}><CloseIcon /></button>
            <button ref={saveButton} className="button button-icon" type="submit" disabled={saving || tagsLoading || !tagsReady || invalidTagIds.length > 0} title={t.editor.save} aria-label={t.editor.save}><SaveIcon /></button>
            <button className="button button-icon" type="button" aria-pressed={preview} onClick={() => setPreview((value) => !value)} title={preview ? t.editor.hidePreview : t.editor.showPreview} aria-label={preview ? t.editor.hidePreview : t.editor.showPreview}>
              {preview ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </div>

        <div className={`editor-workspace ${preview ? 'with-preview' : ''}`}>
          <section aria-labelledby="editor-label" className="editor-input-panel">
            <h2 id="editor-label"><FilePenLineIcon />{mode === 'plain' ? t.editor.sourceHeading : t.editor.richHeading}</h2>
            {mode === 'plain' ? (
              <textarea aria-label={t.editor.source} className="markdown-textarea" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} spellCheck aria-invalid={Boolean(errors.content)} aria-describedby={errors.content ? 'content-error' : 'content-help'} />
            ) : (
              <Suspense fallback={<LoadingState message={t.editor.loadingRich} />}>
                <RichMarkdownEditor value={draft.content} onChange={(content) => setDraft((current) => ({ ...current, content }))} />
              </Suspense>
            )}
            <p id="content-help" className="field-help">{t.editor.contentHelp}</p>
            {errors.content && <p className="field-error" id="content-error">{errors.content}</p>}
          </section>
          {preview && <section className="preview-panel" aria-labelledby="preview-label"><h2 id="preview-label">{t.editor.preview}</h2><Markdown content={draft.content || t.editor.previewEmpty} /></section>}
        </div>

      </form>

      {saveConfirmationOpen && (
        <Dialog
          title={t.editor.reviewTitle}
          description={t.editor.reviewText}
          onClose={() => { if (!saving) setSaveConfirmationOpen(false); }}
          initialFocusRef={keepEditing}
          returnFocusRef={saveButton}
          className="save-confirm-dialog"
          footer={(
            <>
              <button className="button button-primary" type="button" disabled={saving} onClick={() => void confirmSave()}><SaveIcon />{saving ? t.editor.saving : t.editor.confirmSave}</button>
              <button ref={keepEditing} className="button button-secondary" type="button" disabled={saving} onClick={() => setSaveConfirmationOpen(false)}>{t.editor.keepEditing}</button>
            </>
          )}
        >
          <div className="save-diff-headings" aria-hidden="true"><span>{t.editor.diffField}</span><span>{t.editor.diffCurrent}</span><span>{t.editor.diffNew}</span></div>
          <dl className="revision-comparison-metadata save-diff-metadata">
            <div className={currentRevision.title === proposedRevision.title ? '' : 'changed'}><dt>{t.fields.title}</dt><dd>{currentRevision.title || t.common.notSet}</dd><dd>{proposedRevision.title || t.common.notSet}</dd></div>
            <div className={sameTagIds(currentRevision.tagIds, proposedRevision.tagIds) ? '' : 'changed'}><dt>{t.fields.tagIds}</dt><dd>{tagNames(currentRevision.tagIds) || t.common.none}</dd><dd>{tagNames(proposedRevision.tagIds) || t.common.none}</dd></div>
            <div className={currentRevision.visibility === proposedRevision.visibility ? '' : 'changed'}><dt>{t.fields.visibility}</dt><dd>{t.visibility[visibilityClassName(currentRevision.visibility)]}</dd><dd>{t.visibility[visibilityClassName(proposedRevision.visibility)]}</dd></div>
          </dl>
          <div className={`revision-content-grid save-diff-content ${currentRevision.content === proposedRevision.content ? '' : 'changed'}`}>
            <section aria-labelledby="current-content-title"><h3 id="current-content-title">{t.editor.currentContent}</h3><pre>{currentRevision.content || t.editor.noContent}</pre></section>
            <section aria-labelledby="new-content-title"><h3 id="new-content-title">{t.editor.newContent}</h3><pre>{proposedRevision.content || t.editor.noContent}</pre></section>
          </div>
        </Dialog>
      )}

      {blocker.state === 'blocked' && (
        <ConfirmDialog
          title={t.editor.discardTitle}
          description={t.editor.discardText}
          confirmLabel={t.editor.discardConfirm}
          cancelLabel={t.editor.keepEditing}
          danger
          onConfirm={() => blocker.proceed()}
          onCancel={() => blocker.reset()}
        />
      )}
    </div>
  );
}
