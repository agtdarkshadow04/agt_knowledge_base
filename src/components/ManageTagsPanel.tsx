import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { useAuth } from './AuthContext';
import {
  createTag,
  deleteTag,
  listOrphanTagReferences,
  listTags,
  removeOrphanTagReference,
  updateTag,
} from '../lib/memberApi';
import { ApiError } from '../lib/client';
import { parseTagWrite, validate } from '../lib/validation';
import { formatTranslation } from '../translations';
import { useI18n } from './I18n';
import type { CanonicalTag, OrphanTagReference } from '../lib/api';
import { stringToPastelHex, TagChip } from './TagChip';
import { ConfirmDialog } from './Dialog';
import { formErrors as describeForm, TextField } from './Field';
import { PencilIcon, TagIcon, TrashIcon } from './Icons';

const colorPattern = /^#[0-9a-f]{6}$/i;

interface TagForm {
  name: string;
  color: string;
}

const emptyForm: TagForm = { name: '', color: '#FFB451' };

/** The Moderator's tag catalog and orphaned references (the Tags page). */
export function ManageTagsPanel() {
  const { user } = useAuth();
  const { t, error: describe } = useI18n();
  const titleId = useId();
  const [notice, setNotice] = useState('');
  const [pendingDelete, setPendingDelete] = useState<CanonicalTag | null>(null);
  const [tags, setTags] = useState<CanonicalTag[]>([]);
  const [orphans, setOrphans] = useState<OrphanTagReference[]>([]);
  const [form, setForm] = useState<TagForm>(emptyForm);
  const [editingId, setEditingId] = useState<string>();
  const [formErrors, setFormErrors] = useState<Partial<TagForm>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const [nextTags, nextOrphans] = await Promise.all([
        listTags('', signal, true),
        listOrphanTagReferences(signal),
      ]);
      if (signal?.aborted) return;
      setTags(nextTags);
      setOrphans(nextOrphans);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(describe(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [describe]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function resetForm() {
    setForm(emptyForm);
    setEditingId(undefined);
    setFormErrors({});
  }

  function updateName(name: string) {
    const canonicalName = name.trim();
    setForm({
      name,
      color: canonicalName ? stringToPastelHex(canonicalName) : emptyForm.color,
    });
  }

  function validateForm() {
    // FE-6: the server's rule (parseTagWrite), plus the uniqueness check against the loaded catalog.
    const checked = validate(parseTagWrite, { name: form.name, color: form.color.toUpperCase() });
    const next: Partial<TagForm> = describeForm(checked, t).fields;
    const name = form.name.trim();
    if (!next.name && tags.some((tag) => tag.id !== editingId && tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      next.name = t.tags.duplicate;
    }
    setFormErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submitTag(event: FormEvent) {
    event.preventDefault();
    if (!validateForm()) return;
    setBusy(true);
    setError('');
    setNotice('');
    const input = { name: form.name.trim(), color: form.color.toUpperCase() };
    try {
      if (editingId) await updateTag(editingId, input);
      else await createTag(input);
      setNotice(editingId ? t.tags.saved : t.tags.created);
      resetForm();
      await load();
    } catch (cause) {
      const described = describeForm(cause, t);
      if (Object.keys(described.fields).length) setFormErrors(described.fields);
      setError(described.form);
    } finally {
      setBusy(false);
    }
  }

  function editTag(tag: CanonicalTag) {
    setEditingId(tag.id);
    setForm({ name: tag.name, color: tag.color });
    setFormErrors({});
  }

  async function removeTag(tag: CanonicalTag) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await deleteTag(tag.id);
      if (editingId === tag.id) resetForm();
      setNotice(t.tags.deleted);
      await load();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setPendingDelete(null);
      setBusy(false);
    }
  }

  async function cleanupOrphan(orphan: OrphanTagReference, tagId: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await removeOrphanTagReference(orphan.articleId, tagId, orphan.version);
      setNotice(t.tags.referenceRemoved);
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        await load();
        setError(t.tags.orphanConflict);
      } else {
        setError(describe(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  if (user?.role !== 'Moderator') return null;

  return (
    <div className="tag-management-page">
      <section className="tag-management-panel" aria-labelledby={titleId}>
        <header className="settings-header">
          <div>
            <p className="eyebrow">{t.tags.eyebrow}</p>
            <h1 id={titleId}>{t.tags.title}</h1>
          </div>
        </header>

        {error && <p className="error-note" role="alert">{error}</p>}
        <div role="status" aria-live="polite">{notice && <p className="success-note">{notice}</p>}</div>

        <section className="settings-section" aria-labelledby={`${titleId}-catalog`}>
          <h3 id={`${titleId}-catalog`}><TagIcon /> {t.tags.catalog}</h3>
          <form className="tag-form" onSubmit={(event) => void submitTag(event)} noValidate>
            <TextField label={t.tags.name} value={form.name} maxLength={40} error={formErrors.name} onChange={(event) => updateName(event.target.value)} />
            <div className="tag-color-row">
              <span className="tag-color-swatch" aria-hidden="true" style={{ backgroundColor: colorPattern.test(form.color) ? form.color : 'transparent' }} />
              <TextField label={t.tags.color} value={form.color} placeholder={t.tags.colorPlaceholder} error={formErrors.color} help={t.tags.colorHelp} onChange={(event) => setForm({ ...form, color: event.target.value })} />
            </div>
            <div className="dialog-actions tag-form-actions">
              <button className="button button-primary" type="submit" disabled={busy}>
                {editingId ? t.tags.save : t.tags.create}
              </button>
              {editingId && <button className="button button-secondary" type="button" disabled={busy} onClick={resetForm}>{t.tags.cancelEdit}</button>}
            </div>
          </form>

          {loading ? <p className="field-help" role="status">{t.tags.loading}</p> : (
            <ul className="tag-catalog-list" aria-label={t.tags.list}>
              {tags.map((tag) => (
                <li key={tag.id}>
                  <TagChip tag={tag} />
                  <code>{tag.color}</code>
                  <span className="tag-catalog-actions">
                    <button className="button button-icon" type="button" disabled={busy} onClick={() => editTag(tag)} aria-label={formatTranslation(t.tags.edit, { name: tag.name })} title={formatTranslation(t.tags.edit, { name: tag.name })}><PencilIcon /></button>
                    <button className="button button-icon" type="button" disabled={busy} aria-haspopup="dialog" aria-expanded={pendingDelete?.id === tag.id} onClick={() => setPendingDelete(tag)} aria-label={formatTranslation(t.tags.delete, { name: tag.name })} title={formatTranslation(t.tags.delete, { name: tag.name })}><TrashIcon /></button>
                  </span>
                </li>
              ))}
              {!tags.length && <li className="tag-catalog-empty">{t.tags.empty}</li>}
            </ul>
          )}
        </section>

        <section className="settings-section" aria-labelledby={`${titleId}-orphans`}>
          <h3 id={`${titleId}-orphans`}>{t.tags.orphans}</h3>
          <p className="field-help">{t.tags.orphansHelp}</p>
          {!loading && orphans.length === 0 && <p className="tag-catalog-empty">{t.tags.noOrphans}</p>}
          <ul className="orphan-list">
            {orphans.flatMap((orphan) => orphan.missingTagIds.map((tagId) => (
              <li key={`${orphan.articleId}-${tagId}`}>
                <span><strong>{orphan.articleTitle}</strong><code>{tagId}</code></span>
                <button className="button button-danger compact" type="button" disabled={busy} onClick={() => void cleanupOrphan(orphan, tagId)}>
                  {t.tags.removeReference}
                </button>
              </li>
            )))}
          </ul>
        </section>
      </section>
      {pendingDelete && (
        <ConfirmDialog
          title={formatTranslation(t.tags.deleteTitle, { name: pendingDelete.name })}
          description={t.tags.deleteText}
          confirmLabel={busy ? t.common.deleting : t.tags.deleteConfirm}
          danger
          busy={busy}
          onConfirm={() => void removeTag(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
