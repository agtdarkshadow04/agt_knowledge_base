import { useI18n } from './I18n';
import { DatabaseIcon, SearchXIcon, SpinnerIcon, WarningIcon } from './Icons';

export function LoadingState({ message }: { message?: string }) {
  const { t } = useI18n();
  return (
    <div className="state-panel" role="status" aria-live="polite">
      <SpinnerIcon className="spin" />
      <p>{message ?? t.states.loading}</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="state-panel error-panel" role="alert">
      <WarningIcon />
      <h2>{t.states.errorTitle}</h2>
      <p>{message}</p>
      {onRetry && <button className="button button-secondary" onClick={onRetry}>{t.common.retry}</button>}
    </div>
  );
}

export function EmptyState({ filtered }: { filtered: boolean }) {
  const { t } = useI18n();
  return (
    <div className="state-panel">
      {filtered ? <SearchXIcon /> : <DatabaseIcon />}
      <h2>{filtered ? t.states.noMatchesTitle : t.states.emptyTitle}</h2>
      <p>{filtered ? t.states.noMatchesText : t.states.emptyText}</p>
    </div>
  );
}
