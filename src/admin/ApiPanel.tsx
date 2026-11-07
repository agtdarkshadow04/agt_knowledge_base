import adminSpec from '../../docs/openapi-admin.yaml?raw';
import { ApiReference } from '../components/api-docs/ApiReference';
import { parseOpenApi } from '../components/api-docs/openapi';

const document = parseOpenApi(adminSpec);

/** The Admin API reference. Public and member routes are on the member app's /api-docs page. */
export function ApiPanel() {
  return (
    <section className="admin-panel api-admin-panel" aria-labelledby="admin-api-title">
      <div className="admin-panel-heading">
        <div>
          <p className="eyebrow">Version {document.version}</p>
          <h2 id="admin-api-title">{document.title}</h2>
        </div>
        <a className="button button-secondary" href="/api-docs">Member API reference</a>
      </div>
      <ApiReference document={document} />
    </section>
  );
}
