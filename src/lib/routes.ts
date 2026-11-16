import { isUuidV4 } from './api.js';

/**
 * The member UI's pages as query parameters on `/` (STACK-2, FE-4): there is
 * no router and no path routing. `?article=<id>` opens an article, `view`
 * selects the other pages, and the article list keeps its filters in its own
 * parameters on the plain `/`.
 */

export type Route =
  | { page: 'home' }
  | { page: 'login'; next: string }
  | { page: 'tags' }
  | { page: 'new' }
  | { page: 'article'; id: string }
  | { page: 'history'; id: string }
  | { page: 'edit'; id: string }
  | { page: 'notFound' };

/** The article-list filters HomePage keeps in the URL. */
export const homeParameters = ['search', 'tagId', 'visibility', 'pinned', 'protection', 'verification', 'sort', 'direction'] as const;

/** A sign-in return address: only a page of this app, never another origin. */
export function safeNext(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value.startsWith('/?') || value === '/' ? value : '/';
}

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const article = params.get('article');
  const view = params.get('view');
  if (article !== null) {
    if (!isUuidV4(article)) return { page: 'notFound' };
    if (view === null) return { page: 'article', id: article.toLowerCase() };
    if (view === 'history' || view === 'edit') return { page: view, id: article.toLowerCase() };
    return { page: 'notFound' };
  }
  switch (view) {
    case null: return { page: 'home' };
    case 'login': return { page: 'login', next: safeNext(params.get('next')) };
    case 'tags': return { page: 'tags' };
    case 'new': return { page: 'new' };
    default: return { page: 'notFound' };
  }
}

/** The link to a page; `home` may carry the list filters. */
export function routeHref(route: Route, filters?: URLSearchParams): string {
  const params = new URLSearchParams();
  switch (route.page) {
    case 'home':
      for (const name of homeParameters) {
        const value = filters?.get(name);
        if (value) params.set(name, value);
      }
      break;
    case 'login':
      params.set('view', 'login');
      if (route.next !== '/') params.set('next', route.next);
      break;
    case 'tags':
    case 'new':
      params.set('view', route.page);
      break;
    case 'article':
      params.set('article', route.id);
      break;
    case 'history':
    case 'edit':
      params.set('article', route.id);
      params.set('view', route.page);
      break;
    case 'notFound':
      return '/';
  }
  const text = params.toString();
  return text ? `/?${text}` : '/';
}

/**
 * The canonical address of the current one (FE-4): the same page without
 * unknown or misplaced parameters, or null when it is already canonical or the
 * page does not exist (the not-found page keeps the address it was given).
 */
export function canonicalHref(pathname: string, search: string): string | null {
  const route = parseRoute(search);
  if (route.page === 'notFound') return null;
  const href = routeHref(route, new URLSearchParams(search));
  return href === `${pathname}${search}` || (href === '/' && pathname === '/' && search === '') ? null : href;
}

/** The pages of 1.x, which used paths, and their deep links now (deprecated; removed in 3.0.0). */
export function legacyPageRedirect(pathname: string): string | null {
  if (pathname === '/login') return '/?view=login';
  if (pathname === '/tags') return '/?view=tags';
  if (pathname === '/articles/new') return '/?view=new';
  const match = /^\/articles\/([^/]+)(?:\/(history|edit))?\/?$/.exec(pathname);
  if (!match || !isUuidV4(match[1])) return null;
  return routeHref(match[2] ? { page: match[2] as 'history' | 'edit', id: match[1].toLowerCase() } : { page: 'article', id: match[1].toLowerCase() });
}
