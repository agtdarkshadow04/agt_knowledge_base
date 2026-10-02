import type {
  Actor,
  ArticleListResult,
  ArticleRecord,
  ArticleRevisionRecord,
  ArticleWrite,
  ListArticlesQuery,
  Role,
} from './domain.js';

export interface ArticleRepository {
  list(query: ListArticlesQuery, viewerRole: Role | null): Promise<ArticleListResult>;
  get(id: string, viewerRole: Role | null): Promise<ArticleRecord | null>;
  listRevisions(id: string): Promise<ArticleRevisionRecord[]>;
  getRevision(id: string, version: number): Promise<ArticleRevisionRecord | null>;
  create(input: ArticleWrite, actor: Actor): Promise<ArticleRecord>;
  update(id: string, input: ArticleWrite & { version: number }, actor: Actor): Promise<ArticleRecord | null>;
  setPinned(id: string, isPinned: boolean, version: number, actor: Actor): Promise<ArticleRecord | null>;
  setProtection(id: string, isProtected: boolean, version: number, actor: Actor): Promise<ArticleRecord | null>;
  restore(id: string, revisionVersion: number, currentVersion: number, actor: Actor): Promise<ArticleRecord | null>;
  delete(id: string, version: number): Promise<boolean>;
}
