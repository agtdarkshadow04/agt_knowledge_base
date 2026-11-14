import type { ArticleCursor, ListArticlesQuery } from './domain.js';
import { HttpError } from './http.js';

/**
 * Opaque cursors for the article lists (API-8): base64url of the sort order
 * and the sort keys of the last item of the previous page. Filters are not in
 * the cursor; clients send them with every page.
 */

type Order = Pick<ListArticlesQuery, 'sort' | 'direction'>;

export function encodeCursor(order: Order, after: ArticleCursor) {
  return Buffer.from(JSON.stringify([order.sort, order.direction, after.isPinned, after.value, after.id])).toString('base64url');
}

function invalidCursor(): never {
  throw new HttpError(400, 'invalid_request', 'The cursor is not valid for this list. Start again from the first page.');
}

/** Decodes a cursor made for the same sort order; anything else answers `400 invalid_request`. */
export function decodeCursor(order: Order, cursor: string): ArticleCursor | null {
  if (!cursor) return null;
  let parts: unknown;
  try {
    parts = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    invalidCursor();
  }
  if (!Array.isArray(parts) || parts.length !== 5) invalidCursor();
  const [sort, direction, isPinned, value, id] = parts as unknown[];
  if (sort !== order.sort || direction !== order.direction) invalidCursor();
  if (typeof isPinned !== 'boolean' || typeof value !== 'string' || typeof id !== 'string') invalidCursor();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || value.length > 1000) invalidCursor();
  if (sort !== 'title' && Number.isNaN(Date.parse(value))) invalidCursor();
  return { isPinned, value, id };
}
