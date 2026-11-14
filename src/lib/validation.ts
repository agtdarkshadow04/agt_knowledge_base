import { z } from 'zod';
import { roles, type ArticleWrite, type ListArticlesQuery, type TagWrite } from './api.js';

const unsafeMdx = /(^|\n)\s*(import|export)\s|<\/?[A-Za-z][^>]*>/m;

const uuidSchema = z.string().uuid();

const tagIdsSchema = z.array(uuidSchema).max(12).superRefine((tagIds, context) => {
  if (new Set(tagIds).size !== tagIds.length) {
    context.addIssue({ code: 'custom', message: 'Tag IDs must not contain duplicates.' });
  }
});

export const visibilitySchema = z.union([
  z.enum(['Public', 'Internal', 'Admin']),
  z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
]);

/** Largest database.json a backup may contain: it is parsed as one string, so it must stay below V8's string limit. */
export const backupUncompressedCeiling = 500 * 1024 * 1024;

/** Bounds for the backup limits, which can be set in config.yaml or the admin dashboard. */
export const backupLimitSchemas = {
  maxBytes: z.number().int().min(1024 * 1024).max(1024 * 1024 * 1024),
  maxEntries: z.number().int().min(3).max(10_000),
  maxUncompressedBytes: z.number().int().min(1024 * 1024).max(backupUncompressedCeiling),
};

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

const adminSetupSchema = z.object({
  setupPassword: z.string().min(1).max(1024),
  username: usernameSchema,
  password: passwordSchema,
  passwordConfirmation: z.string(),
}).strict().refine((value) => value.password === value.passwordConfirmation, {
  message: 'Passwords do not match.',
  path: ['passwordConfirmation'],
});

const credentialsSchema = z.object({
  username: z.string().max(254),
  password: z.string().max(1024),
}).strict();

const adminAccountPasswordSchema = z.object({
  currentPassword: z.string().max(1024),
  password: passwordSchema,
  passwordConfirmation: z.string(),
}).strict().refine((value) => value.password === value.passwordConfirmation, {
  message: 'Passwords do not match.',
  path: ['passwordConfirmation'],
});

const adminUserCreateSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  email: emailSchema.optional(),
  role: z.enum(roles),
  password: passwordSchema,
}).strict();

const adminUserUpdateSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  email: emailSchema.optional(),
  role: z.enum(roles),
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

const applicationSettingsSchema = z.object({
  applicationName: z.string().trim().min(1).max(80).optional(),
  applicationSubtitle: z.string().trim().min(1).max(240).optional(),
  defaultVisibility: visibilitySchema.optional(),
  allowPublicBrowsing: z.boolean().optional(),
  /** null clears the dashboard value so the default applies again. */
  backupMaxBytes: backupLimitSchemas.maxBytes.nullable().optional(),
  backupMaxEntries: backupLimitSchemas.maxEntries.nullable().optional(),
  backupMaxUncompressedBytes: backupLimitSchemas.maxUncompressedBytes.nullable().optional(),
  version: z.number().int().positive(),
}).strict();

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

export function parseApplicationSettingsWrite(value: unknown) {
  return applicationSettingsSchema.parse(value);
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
