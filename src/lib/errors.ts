/**
 * Field errors shared by the server and the browser (API-6). A FieldError
 * names the request property (dotted for nested ones, e.g. `tagIds.2`), a
 * stable field code, English text, and the values the text needs.
 */

export type FieldParams = Record<string, string | number | boolean>;

export interface FieldError {
  field: string;
  code: string;
  message: string;
  params?: FieldParams;
}

/** The standard field codes (API-6), plus the app's own. */
export const FIELD_CODES = [
  'required',
  'too_long',
  'too_short',
  'out_of_range',
  'too_many',
  'invalid_format',
  'invalid_url',
  'not_allowed',
  'duplicate',
  'mismatch',
  'same_as_setup_password',
] as const;

export type FieldCode = typeof FIELD_CODES[number];

export function fieldError(field: string, code: FieldCode, message: string, params?: FieldParams): FieldError {
  return params ? { field, code, message, params } : { field, code, message };
}

/** The parts of a Zod issue this mapping reads; kept structural so the browser bundle need not import Zod types. */
export interface ValidationIssue {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  input?: unknown;
  origin?: string;
  maximum?: number | bigint;
  minimum?: number | bigint;
  format?: string;
  keys?: string[];
  params?: Record<string, unknown>;
}

function fieldName(path: readonly PropertyKey[]) {
  return path.map(String).join('.');
}

function limit(value: number | bigint | undefined) {
  return value === undefined ? undefined : Number(value);
}

/**
 * Maps validation issues to field errors. A custom rule names its field code
 * with `params: { fieldCode }` (and `params: { other }` for `mismatch`).
 */
export function fieldErrorsFromIssues(issues: readonly ValidationIssue[]): FieldError[] {
  return issues.flatMap((issue): FieldError[] => {
    const field = fieldName(issue.path);
    switch (issue.code) {
      case 'unrecognized_keys':
        return (issue.keys ?? []).map((key) => fieldError(fieldName([...issue.path, key]), 'not_allowed', `${key} is not allowed.`));
      case 'too_big': {
        const max = limit(issue.maximum);
        const params = max === undefined ? undefined : { max };
        if (issue.origin === 'string') return [fieldError(field, 'too_long', issue.message, params)];
        if (issue.origin === 'array' || issue.origin === 'set') return [fieldError(field, 'too_many', issue.message, params)];
        return [fieldError(field, 'out_of_range', issue.message, params)];
      }
      case 'too_small': {
        const min = limit(issue.minimum);
        if ((issue.origin === 'string' || issue.origin === 'array') && min === 1) return [fieldError(field, 'required', issue.message)];
        if (issue.origin === 'string') return [fieldError(field, 'too_short', issue.message, min === undefined ? undefined : { min })];
        return [fieldError(field, 'out_of_range', issue.message, min === undefined ? undefined : { min })];
      }
      case 'invalid_type':
        return [fieldError(field, issue.input === undefined ? 'required' : 'invalid_format', issue.message)];
      case 'invalid_format':
        return [fieldError(field, issue.format === 'url' ? 'invalid_url' : 'invalid_format', issue.message)];
      case 'invalid_value':
      case 'invalid_union':
      case 'invalid_key':
      case 'invalid_element':
        return [fieldError(field, 'not_allowed', issue.message)];
      case 'custom': {
        const code = issue.params?.fieldCode;
        const known = typeof code === 'string' && (FIELD_CODES as readonly string[]).includes(code) ? code as FieldCode : 'invalid_format';
        const other = issue.params?.other;
        return [fieldError(field, known, issue.message, typeof other === 'string' ? { other } : undefined)];
      }
      default:
        return [fieldError(field, 'invalid_format', issue.message)];
    }
  });
}
