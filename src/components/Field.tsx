import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useId } from 'react';
import { ApiError } from '../lib/client';
import { errorText, fieldErrorText, type FieldError } from '../lib/errors';
import type { Validation } from '../lib/validation';
import type { Translations } from '../translations';

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

export interface FormErrors {
  /** The translated message for each field, keyed by top-level field name. */
  fields: Record<string, string>;
  /** The translated message for the whole form, if any. */
  form: string;
}

/** No errors; frozen, so a caller that adds to the result of `formErrors()` never changes it. */
export const noFormErrors: FormErrors = Object.freeze({ fields: Object.freeze({}), form: '' }) as FormErrors;

/**
 * The reader's messages for a failed check or request (I18N-6, FE-6): each field
 * error through `fieldErrorText()` with the translated field label, the request's
 * error through `errorText()`. The browser's check and the server's answer give
 * the same text, because both report the same field codes.
 */
export function formErrors(result: Validation<unknown> | unknown, t: Translations): FormErrors {
  const label = (field: string) => t.fields[field as keyof Translations['fields']] ?? field;
  const translate = (errors: readonly FieldError[]) => {
    const fields: Record<string, string> = {};
    for (const error of errors) {
      const name = error.field.split('.')[0] || '_';
      fields[name] ??= fieldErrorText(error, label(name), t);
    }
    return fields;
  };
  if (result && typeof result === 'object' && 'ok' in result) {
    const checked = result as Validation<unknown>;
    return { fields: checked.ok ? {} : translate(checked.fields), form: '' };
  }
  // The form message too, in case a field error names a field the form does not show.
  if (result instanceof ApiError) return { fields: translate(result.fields), form: errorText(result, t) };
  return { fields: {}, form: errorText(result, t) };
}
