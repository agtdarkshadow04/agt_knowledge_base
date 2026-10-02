import { z } from 'zod';
import type { ArticleWrite, ListArticlesQuery } from './domain.js';

const unsafeMdx = /(^|\n)\s*(import|export)\s|<\/?[A-Za-z][^>]*>/m;

function normalizeTags(tags: string[]) {
  const seen = new Set<string>();
  return tags
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => {
      if (!tag || seen.has(tag)) return false;
      seen.add(tag);
      return true;
    });
}

const articleSchema = z.object({
  title: z.string().trim().min(3).max(180),
  content: z.string().min(20).max(250_000).refine((content) => !unsafeMdx.test(content), {
    message: 'Executable MDX and raw HTML are not allowed.',
  }),
  tags: z.array(z.string().max(40)).max(12).transform(normalizeTags),
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

const restoreSchema = z.object({
  currentVersion: z.number().int().positive(),
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

export function parseRestoreWrite(value: unknown) {
  return restoreSchema.parse(value);
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function parseListQuery(query: Record<string, string | string[] | undefined>): ListArticlesQuery {
  return z.object({
    search: z.string().trim().max(200).default(''),
    tag: z.string().trim().toLowerCase().max(40).default(''),
    visibility: z.enum(['all', 'public', 'internal', 'admin']).default('all'),
    pinned: z.enum(['all', 'pinned']).default('all'),
    protection: z.enum(['all', 'protected', 'unprotected']).default('all'),
    sort: z.enum(['createdAt', 'modifiedAt', 'title']).default('modifiedAt'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(12),
  }).parse({
    search: first(query.search),
    tag: first(query.tag),
    visibility: first(query.visibility),
    pinned: first(query.pinned),
    protection: first(query.protection),
    sort: first(query.sort),
    direction: first(query.direction),
    page: first(query.page),
    pageSize: first(query.pageSize),
  });
}
