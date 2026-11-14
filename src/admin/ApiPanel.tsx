import { useEffect, useState } from 'react';
import { LoadingState } from '../components/States';
import { parseOpenApi, type ApiDocument } from '../lib/openapi';
import { ApiReference } from './api-docs/ApiReference';

/**
 * The API reference, shown only in the admin panel (API-14). It renders the
 * OpenAPI document the server generates from its route schemas.
 */
export function ApiPanel() {
  const [document, setDocument] = useState<ApiDocument | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/openapi.json', { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`The API description could not be loaded (status ${response.status}).`);
        setDocument(parseOpenApi(await response.json()));
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : 'The API description could not be loaded.');
      });
    return () => controller.abort();
  }, []);

  if (error) return <div className="inline-alert" role="alert">{error}</div>;
  if (!document) return <LoadingState message="Loading the API reference…" />;

  return (
    <section className="admin-panel api-admin-panel" aria-labelledby="admin-api-title">
      <div className="admin-panel-heading">
        <div>
          <p className="eyebrow">Version {document.version}</p>
          <h2 id="admin-api-title">{document.title}</h2>
        </div>
        <a className="button button-secondary" href="/api/openapi.json">OpenAPI document</a>
      </div>
      <ApiReference document={document} />
    </section>
  );
}
