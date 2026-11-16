import { useEffect, useState } from 'react';
import { LoadingState } from '../components/States';
import { parseOpenApi, type ApiDocument } from '../lib/openapi';
import { formatTranslation } from '../translations';
import { ApiReference } from './api-docs/ApiReference';
import { useAdminI18n } from './context';

/**
 * The API reference, shown only in the admin panel (API-14). It renders the
 * OpenAPI document the server generates from its route schemas.
 */
export function ApiPanel() {
  const { a, error: describe } = useAdminI18n();
  const [document, setDocument] = useState<ApiDocument | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/openapi.json', { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(formatTranslation(a.api.loadFailed, { status: response.status }));
        setDocument(parseOpenApi(await response.json()));
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error && !('code' in cause) ? cause.message : describe(cause));
      });
    return () => controller.abort();
  }, [a.api.loadFailed, describe]);

  if (error) return <p className="error-note" role="alert">{error}</p>;
  if (!document) return <LoadingState message={a.app.loadingApi} />;

  return (
    <section className="admin-panel api-admin-panel" aria-labelledby="admin-api-title">
      <div className="admin-panel-heading">
        <div>
          <p className="eyebrow">{formatTranslation(a.api.version, { version: document.version })}</p>
          <h2 id="admin-api-title">{document.title}</h2>
        </div>
        <a className="button button-secondary" href="/api/openapi.json">{a.api.document}</a>
      </div>
      <ApiReference document={document} />
    </section>
  );
}
