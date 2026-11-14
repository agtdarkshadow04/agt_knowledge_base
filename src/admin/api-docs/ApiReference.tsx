import { Gauge, KeyRound, LockKeyhole, LockOpen, ShieldCheck, ShieldHalf } from 'lucide-react';
import { MarkdownContent } from '../../components/MarkdownContent';
import type { ApiDocument, ApiOperation, AuthMode, SchemaField } from '../../lib/openapi';

/**
 * Renders a parsed OpenAPI document. Descriptions go through MarkdownContent
 * (react-markdown + rehype-sanitize, no raw HTML); everything else is text.
 * Shared by the member API page and the admin panel's API tab, so it must not
 * import from src/admin/.
 */

const authLabels: Record<AuthMode, { label: string; icon: typeof LockOpen }> = {
  none: { label: 'Public', icon: LockOpen },
  member: { label: 'Member token', icon: KeyRound },
  admin: { label: 'Admin session', icon: LockKeyhole },
};

function AuthBadge({ auth }: { auth: AuthMode }) {
  const { label, icon: Icon } = authLabels[auth];
  return <span className={`api-badge api-auth-${auth}`}><Icon aria-hidden="true" />{label}</span>;
}

function FieldTable({ fields, caption, showLocation = false }: {
  fields: (SchemaField & { location?: string })[];
  caption: string;
  showLocation?: boolean;
}) {
  return (
    <div className="table-scroll">
      <table className="api-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            {showLocation && <th scope="col">In</th>}
            <th scope="col">Type</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr key={`${field.location ?? ''}:${field.name}`}>
              <td><code>{field.name}</code>{field.required && <span className="api-required"> required</span>}</td>
              {showLocation && <td>{field.location}</td>}
              <td><code>{field.type}</code></td>
              <td>
                {field.description && <MarkdownContent content={field.description} />}
                {field.constraints.length > 0 && (
                  <ul className="api-constraints">
                    {field.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Operation({ operation }: { operation: ApiOperation }) {
  const titleId = `${operation.id}-title`;
  return (
    <article className="api-operation" id={operation.id} aria-labelledby={titleId}>
      <header className="api-operation-header">
        <p className="api-endpoint">
          <span className={`api-method api-method-${operation.method.toLowerCase()}`}>{operation.method}</span>
          <code>{operation.path}</code>
        </p>
        <h3 id={titleId}>{operation.summary}</h3>
        <div className="api-badges">
          <AuthBadge auth={operation.auth} />
          {operation.requiredRole && (
            <span className="api-badge api-role"><ShieldCheck aria-hidden="true" />{operation.requiredRole} only</span>
          )}
          {operation.csrfHeader && (
            <span className="api-badge api-csrf"><ShieldHalf aria-hidden="true" />x-agt-request: 1</span>
          )}
          {operation.rateLimit && (
            <span className="api-badge api-rate"><Gauge aria-hidden="true" />Rate-limited ({operation.rateLimit})</span>
          )}
          {operation.deprecated && <span className="api-badge api-deprecated">Deprecated</span>}
        </div>
      </header>
      {operation.description && <MarkdownContent content={operation.description} />}

      {operation.parameters.length > 0 && (
        <section className="api-subsection">
          <h4>Parameters</h4>
          <FieldTable fields={operation.parameters} caption={`Parameters of ${operation.method} ${operation.path}`} showLocation />
        </section>
      )}

      {operation.requestBody && (
        <section className="api-subsection">
          <h4>Request body</h4>
          <p className="api-media"><code>{operation.requestBody.contentType}</code> · <code>{operation.requestBody.type}</code></p>
          {operation.requestBody.fields.length > 0 && (
            <FieldTable fields={operation.requestBody.fields} caption={`Request body of ${operation.method} ${operation.path}`} />
          )}
        </section>
      )}

      <section className="api-subsection">
        <h4>Responses</h4>
        <div className="table-scroll">
          <table className="api-table">
            <caption className="sr-only">{`Responses of ${operation.method} ${operation.path}`}</caption>
            <thead>
              <tr><th scope="col">Status</th><th scope="col">Description</th><th scope="col">Body</th></tr>
            </thead>
            <tbody>
              {operation.responses.map((response) => (
                <tr key={response.status}>
                  <td><span className={`api-status api-status-${response.status[0]}xx`}>{response.status}</span></td>
                  <td>
                    {response.description && <MarkdownContent content={response.description} />}
                    {response.errorCodes.length > 0 && (
                      <ul className="api-error-codes" aria-label="Error codes">
                        {response.errorCodes.map((code) => <li key={code}><code>{code}</code></li>)}
                      </ul>
                    )}
                  </td>
                  <td>{response.type ? <code>{response.type}</code> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </article>
  );
}

export function ApiReference({ document }: { document: ApiDocument }) {
  return (
    <div className="api-reference">
      <nav className="toc api-toc" aria-label="API contents">
        <h2>Contents</h2>
        <ol>
          {document.groups.map((group) => (
            <li key={group.slug}>
              <a href={`#${group.slug}`}>{group.name}</a>
              <ol>
                {group.operations.map((operation) => (
                  <li key={operation.id}>
                    <a href={`#${operation.id}`}><span className="api-toc-method">{operation.method}</span> {operation.path}</a>
                  </li>
                ))}
              </ol>
            </li>
          ))}
          {document.schemas.length > 0 && <li><a href="#api-schemas">Schemas</a></li>}
        </ol>
      </nav>

      <div className="api-content">
        {document.description && <section className="api-intro"><MarkdownContent content={document.description} /></section>}

        {document.groups.map((group) => (
          <section key={group.slug} id={group.slug} className="api-group" aria-labelledby={`${group.slug}-title`}>
            <h2 id={`${group.slug}-title`}>{group.name}</h2>
            {group.description && <MarkdownContent content={group.description} />}
            {group.operations.map((operation) => <Operation key={operation.id} operation={operation} />)}
          </section>
        ))}

        {document.schemas.length > 0 && (
          <section id="api-schemas" className="api-group" aria-labelledby="api-schemas-title">
            <h2 id="api-schemas-title">Schemas</h2>
            {document.schemas.map((schema) => (
              <article key={schema.name} id={`schema-${schema.name}`} className="api-operation api-schema" aria-labelledby={`schema-${schema.name}-title`}>
                <h3 id={`schema-${schema.name}-title`}>{schema.name}</h3>
                <p className="api-media"><code>{schema.type}</code></p>
                {schema.description && <MarkdownContent content={schema.description} />}
                {schema.fields.length > 0 && <FieldTable fields={schema.fields} caption={`Fields of ${schema.name}`} />}
              </article>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
