import { z } from 'zod';
import { isUuidV4, roles, type ArticleWrite, type ListArticlesQuery, type SecurityLevel, type TagWrite } from './api.js';
import { fieldErrorsFromIssues, type FieldError } from './errors.js';

// Zod's JIT probes `new Function` when it builds an object schema, which the
// browser reports as a CSP violation (SEC-1 has no 'unsafe-eval'). Jitless
// parsing never probes; it must be set before the first schema below.
z.config({ jitless: true });

const unsafeMdx = /(^|\n)\s*(import|export)\s|<\/?[A-Za-z][^>]*>/m;

const uuidSchema = z.string().refine(isUuidV4, 'Invalid UUID');

const tagIdsSchema = z.array(uuidSchema).max(12).superRefine((tagIds, context) => {
  if (new Set(tagIds).size !== tagIds.length) {
    context.addIssue({ code: 'custom', message: 'Tag IDs must not contain duplicates.' });
  }
});

export const visibilitySchema = z.union([
  z.enum(['Public', 'Internal', 'Admin']),
  z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
]);

/**
 * Bounds of the backup limits (`backup.*` in config.yaml and the dashboard).
 * The uncompressed size stays below 500 MB because the 1.x archive's
 * database.json is parsed as one string, which must fit V8's string limit.
 */
export const backupLimits = {
  maxZipBytes: { min: 1024, max: 2 * 1024 * 1024 * 1024 },
  maxUncompressedBytes: { min: 1024, max: 8 * 1024 * 1024 * 1024 },
  maxEntries: { min: 1, max: 100_000 },
} as const;

const articleSchema = z.object({
  title: z.string().trim().min(3).max(180),
  content: z.string().min(20).max(250_000).refine((content) => !unsafeMdx.test(content), {
    message: 'Executable MDX and raw HTML are not allowed.',
  }),
  tagIds: tagIdsSchema,
  visibility: visibilitySchema.optional(),
  version: z.number().int().positive().optional(),
}).strict();

const protectionSchema = z.object({
  isProtected: z.boolean(),
  version: z.number().int().positive(),
}).strict();

const pinSchema = z.object({
  isPinned: z.boolean(),
  version: z.number().int().positive(),
}).strict();

const verificationSchema = z.object({
  isVerified: z.boolean(),
  version: z.number().int().positive(),
}).strict();

const restoreSchema = z.object({
  currentVersion: z.number().int().positive(),
}).strict();

const tagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9A-F]{6}$/, 'Color must use canonical #RRGGBB format.'),
}).strict();

const tagListSchema = z.object({
  search: z.string().trim().max(40).default(''),
});

const usernameSchema = z.string().trim().toLowerCase().regex(
  /^[a-z0-9_.-]{3,64}$/,
  'Username must be 3-64 lowercase letters, numbers, dots, underscores, or hyphens.',
);
const displayNameSchema = z.string().trim().min(1).max(120);
const emailSchema = z.union([
  z.literal(''),
  z.string().trim().toLowerCase().email().max(254),
]).transform((value) => value || undefined);
const passwordSchema = z.string().min(12).max(1024)
  .regex(/[a-z]/, 'Password must include a lowercase letter.')
  .regex(/[A-Z]/, 'Password must include an uppercase letter.')
  .regex(/[0-9]/, 'Password must include a number.')
  .regex(/[^A-Za-z0-9]/, 'Password must include a symbol.');

/** AUTH-3: the Admin username is trimmed, then 1–64 Unicode code points, and stored as entered. */
const adminUsernameSchema = z.string().trim()
  .refine((value) => value.length > 0, 'Username is required.')
  .refine((value) => [...value].length <= 64, 'Username must be at most 64 characters.');

/** A confirmation is optional in the API (AUTH-5); when sent it must match. */
const confirmed = <T extends { password: string; passwordConfirmation?: string }>(value: T) => (
  value.passwordConfirmation === undefined || value.password === value.passwordConfirmation
);

const adminSetupSchema = z.object({
  setupPassword: z.string().min(1).max(1024),
  username: adminUsernameSchema,
  password: passwordSchema,
  passwordConfirmation: z.string().optional(),
}).strict().refine(confirmed, {
  message: 'Passwords do not match.',
  path: ['passwordConfirmation'],
});

const credentialsSchema = z.object({
  username: z.string().max(254),
  password: z.string().max(1024),
}).strict();

/**
 * An AGT IAM credential (issue #30): 1-42 Unicode code points, any character
 * but control characters (so no CR or LF). Quotes, commas, plus signs and
 * backslashes are accepted as they are; the value is sent as JSON, unchanged.
 */
const iamCredential = (requireVisible: boolean) => z.string()
  .refine((value) => value.length > 0 && (!requireVisible || /\S/u.test(value)), { message: 'Required.', params: { fieldCode: 'required' } })
  .refine((value) => [...value].length <= 42, { message: 'At most 42 characters.', params: { fieldCode: 'too_long', max: 42 } })
  .refine((value) => !/\p{Cc}/u.test(value), { message: 'Control characters such as line breaks are not allowed.', params: { fieldCode: 'invalid_format' } });

const iamCredentialsSchema = z.object({
  travellerName: iamCredential(true),
  password: iamCredential(false),
}).strict();

/**
 * Replacing an AGT member in the admin panel: the same fields as for a local
 * member, but the name is the Traveller Name; the server accepts only a change
 * of `isActive` (`409 managed_by_iam` otherwise).
 */
const adminIamUserUpdateSchema = z.object({
  username: z.string().max(42 * 2),
  displayName: z.string().max(120),
  email: z.string().max(254).optional(),
  role: z.string().max(20),
  securityLevel: z.number().optional(),
  isActive: z.boolean(),
}).strict();

const adminAccountPasswordSchema = z.object({
  currentPassword: z.string().max(1024),
  password: passwordSchema,
  passwordConfirmation: z.string().optional(),
}).strict().refine(confirmed, {
  message: 'Passwords do not match.',
  path: ['passwordConfirmation'],
});

/** A member's security level (#70): an integer 0-5. */
const securityLevelSchema = z.number().int().min(0).max(5).transform((level) => level as SecurityLevel);

const adminUserCreateSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  email: emailSchema.optional(),
  role: z.enum(roles),
  securityLevel: securityLevelSchema.optional(),
  password: passwordSchema,
}).strict();

const adminUserUpdateSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  email: emailSchema.optional(),
  role: z.enum(roles),
  securityLevel: securityLevelSchema.optional(),
  isActive: z.boolean(),
}).strict();

const adminPasswordSchema = z.object({ password: passwordSchema }).strict();

const userListSchema = z.object({
  search: z.string().trim().max(200).default(''),
  role: z.enum(['all', ...roles]).default('all'),
  active: z.enum(['all', 'active', 'inactive']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function parseArticleWrite(value: unknown): ArticleWrite {
  return articleSchema.parse(value);
}

export function parseProtectionWrite(value: unknown) {
  return protectionSchema.parse(value);
}

export function parsePinWrite(value: unknown) {
  return pinSchema.parse(value);
}

export function parseVerificationWrite(value: unknown) {
  return verificationSchema.parse(value);
}

export function parseRestoreWrite(value: unknown) {
  return restoreSchema.parse(value);
}

export function parseTagWrite(value: unknown): TagWrite {
  return tagSchema.parse(value);
}

export function parseTagListQuery(query: Record<string, string | string[] | undefined>) {
  return tagListSchema.parse({ search: first(query.search) });
}

export function parseAdminSetup(value: unknown) {
  return adminSetupSchema.parse(value);
}

/** Username and password for member or Admin sign-in. */
export function parseCredentials(value: unknown) {
  return credentialsSchema.parse(value);
}

/** Traveller Name and password for AGT sign-in. */
export function parseIamCredentials(value: unknown) {
  return iamCredentialsSchema.parse(value);
}

export function parseAdminIamUserUpdate(value: unknown) {
  return adminIamUserUpdateSchema.parse(value);
}

export function parseAdminAccountPassword(value: unknown) {
  return adminAccountPasswordSchema.parse(value);
}

export function parseAdminUserCreate(value: unknown) {
  return adminUserCreateSchema.parse(value);
}

export function parseAdminUserUpdate(value: unknown) {
  return adminUserUpdateSchema.parse(value);
}

export function parseAdminPasswordWrite(value: unknown) {
  return adminPasswordSchema.parse(value);
}

export function parseUserListQuery(query: Record<string, string | string[] | undefined>) {
  return userListSchema.parse({
    search: first(query.search),
    role: first(query.role),
    active: first(query.active),
    page: first(query.page),
    pageSize: first(query.pageSize),
  });
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function parseListQuery(query: Record<string, string | string[] | undefined>): ListArticlesQuery {
  return z.object({
    search: z.string().trim().max(200).default(''),
    tagId: z.union([z.literal(''), uuidSchema]).default(''),
    visibility: z.enum(['all', 'public', 'internal', 'admin', '0', '1', '2', '3', '4', '5']).default('all'),
    pinned: z.enum(['all', 'pinned']).default('all'),
    protection: z.enum(['all', 'protected', 'unprotected']).default('all'),
    verification: z.enum(['all', 'verified', 'unverified']).default('all'),
    sort: z.enum(['createdAt', 'modifiedAt', 'title']).default('modifiedAt'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().max(1000).default(''),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(50).optional(),
  }).transform(({ limit, page, pageSize, ...rest }) => (page === undefined
    ? { ...rest, limit: limit ?? pageSize ?? 50 }
    // Deprecated offset paging keeps its 1.x page size: `pageSize`, default 12.
    : { ...rest, limit: pageSize ?? 12, page })).parse({
    search: first(query.search),
    tagId: first(query.tagId),
    visibility: first(query.visibility),
    pinned: first(query.pinned),
    protection: first(query.protection),
    verification: first(query.verification),
    sort: first(query.sort),
    direction: first(query.direction),
    limit: first(query.limit),
    cursor: first(query.cursor),
    page: first(query.page),
    pageSize: first(query.pageSize),
  });
}

// --- Logs (LOG-18) -------------------------------------------------------------

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((value) => value || undefined);
const optionalTime = z.string().optional().transform((value, context) => {
  if (!value) return undefined;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    context.addIssue({ code: 'custom', message: 'Use an ISO 8601 date and time.' });
    return z.NEVER;
  }
  return time;
});
const logPage = {
  from: optionalTime,
  to: optionalTime,
  q: optionalText(200),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).default(''),
};
const exportFormat = z.enum(['jsonl', 'csv']).default('jsonl');

const serverLogQuerySchema = z.object({
  level: z.enum(['info', 'warn', 'error', 'fatal']).optional(),
  source: optionalText(50),
  ...logPage,
});

const auditLogQuerySchema = z.object({
  actorType: z.enum(['admin', 'member', 'anonymous']).optional(),
  action: optionalText(100),
  outcome: z.enum(['success', 'denied', 'rate_limited', 'failure']).optional(),
  targetType: optionalText(50),
  targetId: optionalText(100),
  ...logPage,
});

type Query = Record<string, string | string[] | undefined>;
const firstOf = (query: Query) => Object.fromEntries(Object.entries(query).map(([key, value]) => [key, first(value)]));

/** `GET /api/admin/logs/server` filters (LOG-18). */
export function parseServerLogQuery(query: Query) {
  return serverLogQuerySchema.parse(firstOf(query));
}

/** `GET /api/admin/logs/audit` filters (LOG-18). */
export function parseAuditLogQuery(query: Query) {
  return auditLogQuerySchema.parse(firstOf(query));
}

/** The `format` of a log export (LOG-22). */
export function parseExportFormat(query: Query) {
  return exportFormat.parse(first(query.format));
}

export type Validation<T> = { ok: true; value: T } | { ok: false; fields: FieldError[] };

/**
 * Runs one of the parsers above in a form (FE-6): the same rules, field names
 * and field codes the server answers with, mapped as `server/http.ts` maps them.
 */
export function validate<T>(parse: (value: unknown) => T, value: unknown): Validation<T> {
  try {
    return { ok: true, value: parse(value) };
  } catch (error) {
    if (error instanceof z.ZodError) return { ok: false, fields: fieldErrorsFromIssues(error.issues) };
    throw error;
  }
}

/** The first message for each field, keyed by field name (`tagIds.2` counts as `tagIds`). */
export function fieldMessages(fields: readonly FieldError[]): Record<string, string> {
  const messages: Record<string, string> = {};
  for (const error of fields) {
    const name = error.field.split('.')[0] || '_';
    messages[name] ??= error.message;
  }
  return messages;
}
