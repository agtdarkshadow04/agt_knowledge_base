import { Pencil, Tag as TagIcon, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import {
  ApiError,
  createTag,
  deleteTag,
  listOrphanTagReferences,
  listTags,
  removeOrphanTagReference,
  updateTag,
} from '../services/api';
import type { CanonicalTag, OrphanTagReference } from '../types';
import { stringToPastelHex, TagChip } from './TagChip';

const colorPattern = /^#[0-9a-f]{6}$/i;

interface TagForm {
  name: string;
  color: string;
}

const emptyForm: TagForm = { name: '', color: '#FFB451' };

export function ManageTagsModal({ onClose }: { onClose(): void }) {
  const { user, getToken } = useAuth();
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
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
      const token = await getToken();
      const [nextTags, nextOrphans] = await Promise.all([
        listTags('', signal),
        listOrphanTagReferences(token, signal),
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
  }, [getToken]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const focusable = dialog.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

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
    const next: Partial<TagForm> = {};
    const name = form.name.trim();
    if (!name) next.name = 'Enter a tag name.';
    else if (name.length > 40) next.name = 'Keep the tag name to 40 characters or fewer.';
    else if (tags.some((tag) => tag.id !== editingId && tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      next.name = 'Tag names must be unique, regardless of capitalization.';
    }
    if (!colorPattern.test(form.color)) next.color = 'Enter a color in #RRGGBB format.';
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
      const token = await getToken();
      if (editingId) await updateTag(editingId, input, token);
      else await createTag(input, token);
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
    const confirmed = window.confirm(
      `Delete “${tag.name}”? Article and revision references will be retained and may become unresolved until explicitly cleaned up.`,
    );
    if (!confirmed) return;
    setBusy(true);
    setError('');
    try {
      await deleteTag(tag.id, await getToken());
      if (editingId === tag.id) resetForm();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The tag could not be deleted.');
    } finally {
      setBusy(false);
    }
  }

  async function cleanupOrphan(orphan: OrphanTagReference, tagId: string) {
    setBusy(true);
    setError('');
    try {
      await removeOrphanTagReference(orphan.articleId, tagId, orphan.version, await getToken());
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

  if (user?.role !== 'Admin') return null;

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialog} className="settings-dialog tag-management-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="settings-header">
          <div>
            <p className="eyebrow">Administrator tools</p>
            <h2 id={titleId}>Manage Tags</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close tag management" autoFocus>
            <X aria-hidden="true" />
          </button>
        </header>

        {error && <div className="inline-alert tag-management-alert" role="alert">{error}</div>}

        <section className="settings-section" aria-labelledby={`${titleId}-catalog`}>
          <h3 id={`${titleId}-catalog`}><TagIcon aria-hidden="true" /> Tag catalog</h3>
          <form className="tag-form" onSubmit={(event) => void submitTag(event)} noValidate>
            <label className="field">
              Name
              <input
                value={form.name}
                maxLength={40}
                aria-invalid={Boolean(formErrors.name)}
                aria-describedby={formErrors.name ? `${titleId}-name-error` : undefined}
                onChange={(event) => updateName(event.target.value)}
              />
            </label>
            {formErrors.name && <p className="field-error" id={`${titleId}-name-error`}>{formErrors.name}</p>}
            <label className="field">
              Color
              <span className="tag-color-field">
                <span aria-hidden="true" style={{ backgroundColor: colorPattern.test(form.color) ? form.color : 'transparent' }} />
                <input
                  value={form.color}
                  placeholder="#RRGGBB"
                  aria-invalid={Boolean(formErrors.color)}
                  aria-describedby={formErrors.color ? `${titleId}-color-error` : undefined}
                  onChange={(event) => setForm({ ...form, color: event.target.value })}
                />
              </span>
            </label>
            {formErrors.color && <p className="field-error" id={`${titleId}-color-error`}>{formErrors.color}</p>}
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
                    <button className="icon-button" type="button" disabled={busy} onClick={() => editTag(tag)} aria-label={`Edit ${tag.name}`}><Pencil aria-hidden="true" /></button>
                    <button className="icon-button" type="button" disabled={busy} onClick={() => void removeTag(tag)} aria-label={`Delete ${tag.name}`}><Trash2 aria-hidden="true" /></button>
                  </span>
                </li>
              ))}
              {!tags.length && <li className="tag-catalog-empty">No canonical tags have been created.</li>}
            </ul>
          )}
        </section>

        <section className="settings-section" aria-labelledby={`${titleId}-orphans`}>
          <h3 id={`${titleId}-orphans`}>Orphaned references</h3>
          <p className="field-help">Missing tag IDs stay hidden on articles until an Administrator explicitly removes them.</p>
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
    </div>
  );
}
