import { securityLevelAllows, type AgtArticleVisibility, type ArticleVisibility, type ArticleVisibilityFilter, type SecurityLevel } from './api.js';

/** The key of a level's CSS class and of its translated name (`t.visibility[key]`). */
export type VisibilityKey = 'agt-public' | 'private' | 'restricted' | 'top-secret' | 'slt-restricted' | 'scc-restricted' | 'public' | 'internal' | 'admin';

interface VisibilityOption {
  value: ArticleVisibility;
  className: VisibilityKey;
}

/** The AGT levels; each one's number is also the security level that reads it (#70). */
export const agtVisibilityOptions = [
  { value: 0, className: 'agt-public' },
  { value: 1, className: 'private' },
  { value: 2, className: 'restricted' },
  { value: 3, className: 'top-secret' },
  { value: 4, className: 'slt-restricted' },
  { value: 5, className: 'scc-restricted' },
] as const satisfies readonly VisibilityOption[];

/** The legacy text levels, read at security levels 0 (Public), 1 (Internal) and 5 (Admin). */
export const legacyVisibilityOptions = [
  { value: 'Public', className: 'public' },
  { value: 'Internal', className: 'internal' },
  { value: 'Admin', className: 'admin' },
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

/** The options a member at `level` may assign: the levels they can read (#70). */
export function assignableOptions<Option extends VisibilityOption>(options: readonly Option[], level: SecurityLevel): Option[] {
  return options.filter((option) => securityLevelAllows(level, option.value));
}

/**
 * The visibility a new article starts with: the site's default if the member
 * may assign it, else the highest AGT level they may (their own level).
 */
export function initialVisibility(defaultVisibility: ArticleVisibility, level: SecurityLevel): ArticleVisibility {
  return securityLevelAllows(level, defaultVisibility) ? defaultVisibility : level;
}
