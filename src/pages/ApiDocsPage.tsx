import memberSpec from '../../docs/openapi.yaml?raw';
import { ApiReference } from '../components/api-docs/ApiReference';
import { parseOpenApi } from '../components/api-docs/openapi';

// Bundled at build time, so the page works without an API call. Only the
// public and member routes are included; the Admin routes are documented in
// the admin panel.
const document = parseOpenApi(memberSpec);

/** The public API reference for public and member routes. */
export function ApiDocsPage() {
  return (
    <div className="page api-docs-page">
      <header className="hero api-docs-hero">
        <p className="eyebrow">Developer reference</p>
        <h1>{document.title}</h1>
        <p className="api-docs-lede">
          Version {document.version}. Every route below is served under <code>/api</code>. Member routes need a bearer
          token from <code>POST /auth/login</code>. The installation Admin&apos;s routes are documented in the admin panel.
        </p>
      </header>
      <ApiReference document={document} />
    </div>
  );
}
