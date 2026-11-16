import { useEffect, useState } from 'react';
import { onMaintenance } from '../lib/client';

/**
 * FE-5: a non-blocking notice while the server answers `503 maintenance`
 * (a restore, or a write that waited for a backup, BAK-8). `apiRequest()`
 * retries the request once after `Retry-After`; the notice goes away then.
 */
export function MaintenanceNotice() {
  const [retryAt, setRetryAt] = useState<number | null>(null);

  useEffect(() => onMaintenance((seconds) => setRetryAt(Date.now() + seconds * 1000)), []);

  useEffect(() => {
    if (retryAt === null) return undefined;
    // Hide the notice a moment after the retry, when it has either worked or shown its own error.
    const timer = setTimeout(() => setRetryAt(null), Math.max(retryAt - Date.now(), 0) + 2000);
    return () => clearTimeout(timer);
  }, [retryAt]);

  return (
    <div className="maintenance-region" role="status" aria-live="polite">
      {retryAt !== null && (
        <p className="admin-notice maintenance-notice">
          Maintenance in progress: the server is busy with a backup or restore. Your request is retried automatically in a few seconds.
        </p>
      )}
    </div>
  );
}
