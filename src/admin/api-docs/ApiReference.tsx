import { Markdown } from '../../components/Markdown';
import { useI18n } from '../../components/I18n';
import type { ApiDocument, ApiOperation, AuthMode, SchemaConstraint, SchemaField } from '../../lib/openapi';
import { GaugeIcon, KeyRoundIcon, LockKeyholeIcon, LockOpenIcon, ShieldCheckIcon, ShieldHalfIcon } from '../../components/Icons';
import { formatTranslation } from '../../translations';
import { useAdminI18n } from '../context';

/**
 * Renders a parsed OpenAPI document. Descriptions go through the one Markdown
 * component (SEC-12, raw HTML shown as text); everything else is text.
 * Shown only in the admin panel's API tab (API-14). The document's own text
 * (summaries, descriptions) is the API's, in English; the labels are translated.
 */

const authIcons: Record<AuthMode, typeof LockOpenIcon> = { none: LockOpenIcon, member: KeyRoundIcon, admin: LockKeyholeIcon };

function AuthBadge({ auth }: { auth: AuthMode }) {
  const { a } = useAdminI18n();
  const Icon = authIcons[auth];
  const label = { none: a.api.public, member: a.api.memberSession, admin: a.api.adminSession }[auth];
  return <span className={`api-badge api-auth-${auth}`}><Icon />{label}</span>;
}

function ConstraintText({ constraint }: { constraint: SchemaConstraint }) {
  const { a } = useAdminI18n();
  const { number } = useI18n();
  const c = a.api.constraints;
  switch (constraint.kind) {
    case 'unique': return c.unique;
    case 'pattern': return formatTranslation(c.pattern, { pattern: constraint.pattern });
    case 'default': return constraint.value === null ? c.defaultEmpty : formatTranslation(c.defaultValue, { value: constraint.value });
    default: {
      const texts = { length: [c.lengthRange, c.lengthMin, c.lengthMax], value: [c.valueRange, c.valueMin, c.valueMax], items: [c.itemsRange, c.itemsMin, c.itemsMax] }[constraint.kind];
      const values = { min: constraint.min === undefined ? '' : number(constraint.min), max: constraint.max === undefined ? '' : number(constraint.max) };
      const text = constraint.min !== undefined && constraint.max !== undefined ? texts[0] : constraint.min !== undefined ? texts[1] : texts[2];
      return formatTranslation(text, values);
    }
  }
}

function FieldTable({ fields, caption, showLocation = false }: {
  fields: (SchemaField & { location?: string })[];
  caption: string;
  showLocation?: boolean;
}) {
  const { a } = useAdminI18n();
  return (
    <div className="table-scroll">
      <table className="api-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{a.api.colName}</th>
            {showLocation && <th scope="col">{a.api.colIn}</th>}
            <th scope="col">{a.api.colType}</th>
            <th scope="col">{a.api.colDetails}</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr key={`${field.location ?? ''}:${field.name}`}>
              <td><code>{field.name}</code>{field.required && <span className="api-required"> {a.api.required}</span>}</td>
              {showLocation && <td>{field.location}</td>}
              <td><code>{field.type}</code></td>
              <td>
                {field.description && <Markdown content={field.description} />}
                {field.constraints.length > 0 && (
                  <ul className="api-constraints">
                    {field.constraints.map((constraint, index) => <li key={index}><ConstraintText constraint={constraint} /></li>)}
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
  const { a } = useAdminI18n();
  const titleId = `${operation.id}-title`;
  const name = `${operation.method} ${operation.path}`;
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
            <span className="api-badge api-role"><ShieldCheckIcon />{formatTranslation(a.api.roleOnly, { role: operation.requiredRole })}</span>
          )}
          {operation.csrfHeader && (
            <span className="api-badge api-csrf"><ShieldHalfIcon />x-agt-request: 1</span>
          )}
          {operation.rateLimit && (
            <span className="api-badge api-rate"><GaugeIcon />{formatTranslation(a.api.rateLimited, { limit: operation.rateLimit })}</span>
          )}
          {operation.deprecated && <span className="api-badge api-deprecated">{a.api.deprecated}</span>}
        </div>
      </header>
      {operation.description && <Markdown content={operation.description} />}

      {operation.parameters.length > 0 && (
        <section className="api-subsection">
          <h4>{a.api.parameters}</h4>
          <FieldTable fields={operation.parameters} caption={formatTranslation(a.api.parametersOf, { operation: name })} showLocation />
        </section>
      )}

      {operation.requestBody && (
        <section className="api-subsection">
          <h4>{a.api.requestBody}</h4>
          <p className="api-media"><code>{operation.requestBody.contentType}</code> · <code>{operation.requestBody.type}</code></p>
          {operation.requestBody.fields.length > 0 && (
            <FieldTable fields={operation.requestBody.fields} caption={formatTranslation(a.api.requestBodyOf, { operation: name })} />
          )}
        </section>
      )}

      <section className="api-subsection">
        <h4>{a.api.responses}</h4>
        <div className="table-scroll">
          <table className="api-table">
            <caption className="sr-only">{formatTranslation(a.api.responsesOf, { operation: name })}</caption>
            <thead>
              <tr><th scope="col">{a.api.colStatus}</th><th scope="col">{a.api.colDescription}</th><th scope="col">{a.api.colBody}</th></tr>
            </thead>
            <tbody>
              {operation.responses.map((response) => (
                <tr key={response.status}>
                  <td><span className={`api-status api-status-${response.status[0]}xx`}>{response.status}</span></td>
                  <td>
                    {response.description && <Markdown content={response.description} />}
                    {response.errorCodes.length > 0 && (
                      <ul className="api-error-codes" aria-label={a.api.errorCodes}>
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
  const { a } = useAdminI18n();
  return (
    <div className="api-reference">
      <nav className="toc api-toc" aria-label={a.api.contents}>
        <h2>{a.api.contentsTitle}</h2>
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
          {document.schemas.length > 0 && <li><a href="#api-schemas">{a.api.schemas}</a></li>}
        </ol>
      </nav>

      <div className="api-content">
        {document.description && <section className="api-intro"><Markdown content={document.description} /></section>}

        {document.groups.map((group) => (
          <section key={group.slug} id={group.slug} className="api-group" aria-labelledby={`${group.slug}-title`}>
            <h2 id={`${group.slug}-title`}>{group.name}</h2>
            {group.description && <Markdown content={group.description} />}
            {group.operations.map((operation) => <Operation key={operation.id} operation={operation} />)}
          </section>
        ))}

        {document.schemas.length > 0 && (
          <section id="api-schemas" className="api-group" aria-labelledby="api-schemas-title">
            <h2 id="api-schemas-title">{a.api.schemas}</h2>
            {document.schemas.map((schema) => (
              <article key={schema.name} id={`schema-${schema.name}`} className="api-operation api-schema" aria-labelledby={`schema-${schema.name}-title`}>
                <h3 id={`schema-${schema.name}-title`}>{schema.name}</h3>
                <p className="api-media"><code>{schema.type}</code></p>
                {schema.description && <Markdown content={schema.description} />}
                {schema.fields.length > 0 && <FieldTable fields={schema.fields} caption={formatTranslation(a.api.fieldsOf, { schema: schema.name })} />}
              </article>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
