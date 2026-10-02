import type { ArticleVisibility } from '../types';

function VisibilityEyeIcon() {
  return (
    <svg className="visibility-eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  );
}

export function VisibilityChip({ visibility }: { visibility: ArticleVisibility }) {
  return (
    <span className={`status-chip visibility-${visibility.toLowerCase()}`}>
      <VisibilityEyeIcon />{visibility}
    </span>
  );
}
