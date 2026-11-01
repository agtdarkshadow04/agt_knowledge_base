import { AlertTriangle, Database, LoaderCircle, SearchX } from 'lucide-react';

export function LoadingState({ message = 'Loading galactic archives…' }: { message?: string }) {
  return (
    <div className="state-panel" role="status" aria-live="polite">
      <LoaderCircle className="spin" aria-hidden="true" />
      <p>{message}</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-panel error-panel" role="alert">
      <AlertTriangle aria-hidden="true" />
      <h2>Archive connection interrupted</h2>
      <p>{message}</p>
      {onRetry && <button className="button button-secondary" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="state-panel">
      {filtered ? <SearchX aria-hidden="true" /> : <Database aria-hidden="true" />}
      <h2>{filtered ? 'No matching transmissions' : 'The archive is ready'}</h2>
      <p>{filtered ? 'Adjust the search or filters and try again.' : 'No articles have been published yet.'}</p>
    </div>
  );
}
