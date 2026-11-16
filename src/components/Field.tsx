import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useId } from 'react';
import { ApiError } from '../lib/client';
import { fieldMessages, type Validation } from '../lib/validation';

/**
 * Form fields with the UI-9 `.field` markup (A11Y-5): a visible label, the help
 * text and the field error linked with `aria-describedby`, and
 * `aria-invalid="true"` while the field has an error.
 */

interface FieldParts {
  label: ReactNode;
  help?: ReactNode;
  error?: string;
}

function useDescription({ help, error }: FieldParts) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return {
    id,
    describedBy: [errorId, helpId].filter(Boolean).join(' ') || undefined,
    after: (
      <>
        {help && <span id={helpId} className="field-help">{help}</span>}
        {error && <span id={errorId} className="field-error">{error}</span>}
      </>
    ),
  };
}

export function TextField({ label, help, error, ...input }: FieldParts & InputHTMLAttributes<HTMLInputElement>) {
  const { id, describedBy, after } = useDescription({ label, help, error });
  return (
    <div className="field">
      <span><label htmlFor={input.id ?? id}>{label}</label></span>
      <input id={id} {...input} aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
      {after}
    </div>
  );
}

export function SelectField({ label, help, error, children, ...select }: FieldParts & SelectHTMLAttributes<HTMLSelectElement>) {
  const { id, describedBy, after } = useDescription({ label, help, error });
  return (
    <div className="field">
      <span><label htmlFor={select.id ?? id}>{label}</label></span>
      <select id={id} {...select} aria-invalid={error ? true : undefined} aria-describedby={describedBy}>{children}</select>
      {after}
    </div>
  );
}

/** The field messages of a failed check or request, and the message for the whole form, if any. */
export function formErrors(result: Validation<unknown> | ApiError | unknown, fallback: string): { fields: Record<string, string>; form: string } {
  if (result && typeof result === 'object' && 'ok' in result) {
    const checked = result as Validation<unknown>;
    return checked.ok ? { fields: {}, form: '' } : { fields: fieldMessages(checked.fields), form: '' };
  }
  if (result instanceof ApiError) {
    // The form message too, in case a field error names a field the form does not show.
    return { fields: fieldMessages(result.fields), form: result.message };
  }
  return { fields: {}, form: result instanceof Error ? result.message : fallback };
}
