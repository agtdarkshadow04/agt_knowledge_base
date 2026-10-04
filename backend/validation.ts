import { z } from 'zod';
import type { ArticleWrite, ListArticlesQuery, TagWrite } from './domain.js';

const unsafeMdx = /(^|\n)\s*(import|export)\s|<\/?[A-Za-z][^>]*>/m;

const uuidSchema = z.string().uuid();

const tagIdsSchema = z.array(uuidSchema).max(12).superRefine((tagIds, context) => {
  if (new Set(tagIds).size !== tagIds.length) {
    context.addIssue({ code: 'custom', message: 'Tag IDs must not contain duplicates.' });
  }
});

const articleSchema = z.object({
  title: z.string().trim().min(3).max(180),
  content: z.string().min(20).max(250_000).refine((content) => !unsafeMdx.test(content), {
    message: 'Executable MDX and raw HTML are not allowed.',
  }),
  tagIds: tagIdsSchema,
  visibility: z.enum(['Public', 'Internal', 'Admin']).optional(),
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

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function parseListQuery(query: Record<string, string | string[] | undefined>): ListArticlesQuery {
  return z.object({
    search: z.string().trim().max(200).default(''),
    tagId: z.union([z.literal(''), uuidSchema]).default(''),
    visibility: z.enum(['all', 'public', 'internal', 'admin']).default('all'),
    pinned: z.enum(['all', 'pinned']).default('all'),
    protection: z.enum(['all', 'protected', 'unprotected']).default('all'),
    verification: z.enum(['all', 'verified', 'unverified']).default('all'),
    sort: z.enum(['createdAt', 'modifiedAt', 'title']).default('modifiedAt'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(12),
  }).parse({
    search: first(query.search),
    tagId: first(query.tagId),
    visibility: first(query.visibility),
    pinned: first(query.pinned),
    protection: first(query.protection),
    verification: first(query.verification),
    sort: first(query.sort),
    direction: first(query.direction),
    page: first(query.page),
    pageSize: first(query.pageSize),
  });
}
