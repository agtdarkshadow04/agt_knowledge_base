import type { Actor, ArticleListResult, ArticleRecord, ArticleWrite, ListArticlesQuery } from './domain.js';

export interface ArticleRepository {
  list(query: ListArticlesQuery): Promise<ArticleListResult>;
  get(id: string): Promise<ArticleRecord | null>;
  create(input: ArticleWrite, actor: Actor): Promise<ArticleRecord>;
  update(id: string, input: ArticleWrite & { version: number }, actor: Actor): Promise<ArticleRecord | null>;
  setProtection(id: string, isProtected: boolean, version: number, actor: Actor): Promise<ArticleRecord | null>;
  delete(id: string, version: number): Promise<boolean>;
}
