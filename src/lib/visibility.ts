import type { AgtArticleVisibility, ArticleVisibility, ArticleVisibilityFilter } from './api.js';

/** The key of a level's CSS class and of its translated name (`t.visibility[key]`). */
export type VisibilityKey = 'agt-public' | 'private' | 'restricted' | 'top-secret' | 'slt-restricted' | 'scc-restricted' | 'public' | 'internal' | 'admin';

interface VisibilityOption {
  value: ArticleVisibility;
  className: VisibilityKey;
  moderatorOnly: boolean;
}

export const agtVisibilityOptions = [
  { value: 0, className: 'agt-public', moderatorOnly: false },
  { value: 1, className: 'private', moderatorOnly: false },
  { value: 2, className: 'restricted', moderatorOnly: true },
  { value: 3, className: 'top-secret', moderatorOnly: true },
  { value: 4, className: 'slt-restricted', moderatorOnly: true },
  { value: 5, className: 'scc-restricted', moderatorOnly: true },
] as const satisfies readonly VisibilityOption[];

export const legacyVisibilityOptions = [
  { value: 'Public', className: 'public', moderatorOnly: false },
  { value: 'Internal', className: 'internal', moderatorOnly: false },
  { value: 'Admin', className: 'admin', moderatorOnly: true },
] as const satisfies readonly VisibilityOption[];

const visibilityOptions: readonly VisibilityOption[] = [...agtVisibilityOptions, ...legacyVisibilityOptions];

export function parseArticleVisibility(value: string): ArticleVisibility {
  const option = visibilityOptions.find((candidate) => String(candidate.value) === value);
  if (!option) throw new Error('Unknown article visibility.');
  return option.value;
}

export function visibilityClassName(visibility: ArticleVisibility): VisibilityKey {
  return visibilityOptions.find((option) => option.value === visibility)!.className;
}

export function visibilityFilterValue(visibility: ArticleVisibility): Exclude<ArticleVisibilityFilter, 'all'> {
  return typeof visibility === 'number'
    ? String(visibility) as `${AgtArticleVisibility}`
    : visibility.toLowerCase() as 'public' | 'internal' | 'admin';
}

export function isModeratorOnlyVisibility(visibility: ArticleVisibility) {
  return visibilityOptions.find((option) => option.value === visibility)!.moderatorOnly;
}
