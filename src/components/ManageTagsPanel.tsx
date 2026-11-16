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
import { fieldMessages, parseTagWrite, validate } from '../lib/validation';
import type { CanonicalTag, OrphanTagReference } from '../lib/api';
import { stringToPastelHex, TagChip } from './TagChip';
import { ConfirmDialog } from './Dialog';
import { TextField } from './Field';
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
  const titleId = useId();
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
      setError(cause instanceof Error ? cause.message : 'Tags could not be loaded.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

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
    const next: Partial<TagForm> = checked.ok ? {} : fieldMessages(checked.fields);
    const name = form.name.trim();
    if (!next.name && tags.some((tag) => tag.id !== editingId && tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      next.name = 'Tag names must be unique, regardless of capitalization.';
    }
    setFormErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submitTag(event: FormEvent) {
    event.preventDefault();
    if (!validateForm()) return;
    setBusy(true);
    setError('');
    const input = { name: form.name.trim(), color: form.color.toUpperCase() };
    try {
      if (editingId) await updateTag(editingId, input);
      else await createTag(input);
      resetForm();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The tag could not be saved.');
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
    try {
      await deleteTag(tag.id);
      if (editingId === tag.id) resetForm();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The tag could not be deleted.');
    } finally {
      setPendingDelete(null);
      setBusy(false);
    }
  }

  async function cleanupOrphan(orphan: OrphanTagReference, tagId: string) {
    setBusy(true);
    setError('');
    try {
      await removeOrphanTagReference(orphan.articleId, tagId, orphan.version);
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        await load();
        setError('This article changed before the reference could be removed. The orphan list has been refreshed; try again.');
      } else {
        setError(cause instanceof Error ? cause.message : 'The orphaned reference could not be removed.');
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
            <p className="eyebrow">Moderator tools</p>
            <h1 id={titleId}>Manage tags</h1>
          </div>
        </header>

        {error && <p className="error-note" role="alert">{error}</p>}

        <section className="settings-section" aria-labelledby={`${titleId}-catalog`}>
          <h3 id={`${titleId}-catalog`}><TagIcon aria-hidden="true" /> Tag catalog</h3>
          <form className="tag-form" onSubmit={(event) => void submitTag(event)} noValidate>
            <TextField label="Name" value={form.name} maxLength={40} error={formErrors.name} onChange={(event) => updateName(event.target.value)} />
            <div className="tag-color-row">
              <span className="tag-color-swatch" aria-hidden="true" style={{ backgroundColor: colorPattern.test(form.color) ? form.color : 'transparent' }} />
              <TextField label="Color" value={form.color} placeholder="#RRGGBB" error={formErrors.color} help="Six hexadecimal digits, for example #FFB451." onChange={(event) => setForm({ ...form, color: event.target.value })} />
            </div>
            <div className="dialog-actions tag-form-actions">
              <button className="button button-primary" type="submit" disabled={busy}>
                {editingId ? 'Save tag' : 'Create tag'}
              </button>
              {editingId && <button className="button button-secondary" type="button" disabled={busy} onClick={resetForm}>Cancel edit</button>}
            </div>
          </form>

          {loading ? <p className="field-help">Loading tag catalog…</p> : (
            <ul className="tag-catalog-list" aria-label="Canonical tags">
              {tags.map((tag) => (
                <li key={tag.id}>
                  <TagChip tag={tag} />
                  <code>{tag.color}</code>
                  <span className="tag-catalog-actions">
                    <button className="button button-icon" type="button" disabled={busy} onClick={() => editTag(tag)} aria-label={`Edit ${tag.name}`} title={`Edit ${tag.name}`}><PencilIcon aria-hidden="true" /></button>
                    <button className="button button-icon" type="button" disabled={busy} aria-haspopup="dialog" aria-expanded={pendingDelete?.id === tag.id} onClick={() => setPendingDelete(tag)} aria-label={`Delete ${tag.name}`} title={`Delete ${tag.name}`}><TrashIcon aria-hidden="true" /></button>
                  </span>
                </li>
              ))}
              {!tags.length && <li className="tag-catalog-empty">No canonical tags have been created.</li>}
            </ul>
          )}
        </section>

        <section className="settings-section" aria-labelledby={`${titleId}-orphans`}>
          <h3 id={`${titleId}-orphans`}>Orphaned references</h3>
          <p className="field-help">Missing tag IDs stay hidden on articles until a Moderator explicitly removes them.</p>
          {!loading && orphans.length === 0 && <p className="tag-catalog-empty">No current articles contain missing tag IDs.</p>}
          <ul className="orphan-list">
            {orphans.flatMap((orphan) => orphan.missingTagIds.map((tagId) => (
              <li key={`${orphan.articleId}-${tagId}`}>
                <span><strong>{orphan.articleTitle}</strong><code>{tagId}</code></span>
                <button className="button button-danger compact" type="button" disabled={busy} onClick={() => void cleanupOrphan(orphan, tagId)}>
                  Remove reference
                </button>
              </li>
            )))}
          </ul>
        </section>
      </section>
      {pendingDelete && (
        <ConfirmDialog
          title={`Delete “${pendingDelete.name}”?`}
          description="Article and revision references are kept and stay unresolved until a Moderator removes them under Orphaned references."
          confirmLabel={busy ? 'Deleting…' : 'Delete tag'}
          danger
          busy={busy}
          onConfirm={() => void removeTag(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
