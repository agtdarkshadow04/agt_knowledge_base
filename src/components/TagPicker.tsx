import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { CanonicalTag } from '../types';
import { TagChip } from './TagChip';

const selectionLimit = 12;
const resultBatchSize = 10;

interface TagPickerProps {
  tags: CanonicalTag[];
  knownTags?: CanonicalTag[];
  selectedIds: string[];
  onChange(selectedIds: string[]): void;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  onRefresh?(): void;
}

export function TagPicker({
  tags,
  knownTags = tags,
  selectedIds,
  onChange,
  disabled = false,
  loading = false,
  error,
  onRefresh,
}: TagPickerProps) {
  const inputId = useId();
  const listboxId = useId();
  const statusId = useId();
  const errorId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(resultBatchSize);
  const [activeIndex, setActiveIndex] = useState(0);

  const availableById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);
  const knownById = useMemo(() => new Map(knownTags.map((tag) => [tag.id, tag])), [knownTags]);
  const matches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return tags.filter((tag) => !normalized || tag.name.toLocaleLowerCase().includes(normalized));
  }, [query, tags]);
  const visibleMatches = matches.slice(0, visibleCount);

  useEffect(() => {
    setVisibleCount(resultBatchSize);
    setActiveIndex(0);
  }, [query, tags]);

  function toggle(tagId: string) {
    if (selectedIds.includes(tagId)) {
      onChange(selectedIds.filter((id) => id !== tagId));
      return;
    }
    if (selectedIds.length < selectionLimit) onChange([...selectedIds, tagId]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.min(index + 1, Math.max(visibleMatches.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Enter' && open && visibleMatches[activeIndex]) {
      event.preventDefault();
      toggle(visibleMatches[activeIndex].id);
    }
  }

  const activeOptionId = open && visibleMatches[activeIndex]
    ? `${listboxId}-option-${visibleMatches[activeIndex].id}`
    : undefined;

  return (
    <div className="tag-picker">
      <label className="field" htmlFor={inputId}><span>Tags</span></label>
      <div className="tag-picker-control">
        <input
          id={inputId}
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-activedescendant={activeOptionId}
          aria-describedby={`${statusId}${error ? ` ${errorId}` : ''}`}
          aria-invalid={Boolean(error)}
          autoComplete="off"
          disabled={disabled || loading}
          placeholder={loading ? 'Loading tags…' : 'Search available tags'}
          value={query}
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
        />

        {open && !loading && (
          <div className="tag-picker-options">
            <div id={listboxId} role="listbox" aria-label="Available tags" aria-multiselectable="true">
              {visibleMatches.map((tag, index) => {
                const selected = selectedIds.includes(tag.id);
                const atLimit = selectedIds.length >= selectionLimit && !selected;
                return (
                  <button
                    id={`${listboxId}-option-${tag.id}`}
                    className={index === activeIndex ? 'active' : ''}
                    key={tag.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={atLimit}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => toggle(tag.id)}
                  >
                    <TagChip tag={tag} />
                    <span>{selected ? 'Selected' : atLimit ? 'Limit reached' : 'Select'}</span>
                  </button>
                );
              })}
            </div>
            {!visibleMatches.length && <p className="tag-picker-empty" role="status">No matching tags.</p>}
            {matches.length > visibleCount && (
              <button
                className="tag-picker-more"
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setVisibleCount((count) => count + resultBatchSize)}
              >
                Show More
              </button>
            )}
          </div>
        )}
      </div>

      {selectedIds.length > 0 && (
        <ul className="selected-tags" aria-label="Selected tags">
          {selectedIds.map((tagId) => {
            const tag = knownById.get(tagId) ?? { id: tagId, name: 'Unavailable tag', color: '#FF6C68' };
            const unavailable = !availableById.has(tagId);
            return (
              <li className={unavailable ? 'unavailable' : ''} key={tagId}>
                <TagChip tag={tag} />
                {unavailable && <span className="tag-unavailable">Unavailable</span>}
                <button type="button" disabled={disabled} onClick={() => toggle(tagId)} aria-label={`Remove ${tag.name}`}>×</button>
              </li>
            );
          })}
        </ul>
      )}

      <p className="field-help tag-picker-status" id={statusId} aria-live="polite">
        {selectedIds.length} of {selectionLimit} tags selected.
      </p>
      {error && <p className="field-error" id={errorId} role="alert">{error}</p>}
      {onRefresh && (
        <button className="button button-ghost compact tag-refresh" type="button" disabled={loading || disabled} onClick={onRefresh}>
          {loading ? 'Refreshing…' : 'Refresh tags'}
        </button>
      )}
    </div>
  );
}
