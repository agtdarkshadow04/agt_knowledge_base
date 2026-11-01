import type { AgtArticleVisibility, ArticleVisibility, ArticleVisibilityFilter } from './types';

interface VisibilityOption {
  value: ArticleVisibility;
  label: string;
  className: string;
  adminOnly: boolean;
}

export const agtVisibilityOptions = [
  { value: 0, label: 'Public', className: 'agt-public', adminOnly: false },
  { value: 1, label: 'Private', className: 'private', adminOnly: false },
  { value: 2, label: 'Restricted', className: 'restricted', adminOnly: true },
  { value: 3, label: 'Top Secret', className: 'top-secret', adminOnly: true },
  { value: 4, label: 'SLT Restricted', className: 'slt-restricted', adminOnly: true },
  { value: 5, label: 'SCC Restricted', className: 'scc-restricted', adminOnly: true },
] as const satisfies readonly VisibilityOption[];

export const legacyVisibilityOptions = [
  { value: 'Public', label: 'Public', className: 'public', adminOnly: false },
  { value: 'Internal', label: 'Internal', className: 'internal', adminOnly: false },
  { value: 'Admin', label: 'Admin', className: 'admin', adminOnly: true },
] as const satisfies readonly VisibilityOption[];

const visibilityOptions: readonly VisibilityOption[] = [...agtVisibilityOptions, ...legacyVisibilityOptions];

export function parseArticleVisibility(value: string): ArticleVisibility {
  const option = visibilityOptions.find((candidate) => String(candidate.value) === value);
  if (!option) throw new Error('Unknown article visibility.');
  return option.value;
}

export function visibilityLabel(visibility: ArticleVisibility) {
  return visibilityOptions.find((option) => option.value === visibility)!.label;
}

export function visibilityClassName(visibility: ArticleVisibility) {
  return visibilityOptions.find((option) => option.value === visibility)!.className;
}

export function visibilityFilterValue(visibility: ArticleVisibility): Exclude<ArticleVisibilityFilter, 'all'> {
  return typeof visibility === 'number'
    ? String(visibility) as `${AgtArticleVisibility}`
    : visibility.toLowerCase() as 'public' | 'internal' | 'admin';
}

export function isAdminOnlyVisibility(visibility: ArticleVisibility) {
  return visibilityOptions.find((option) => option.value === visibility)!.adminOnly;
}
