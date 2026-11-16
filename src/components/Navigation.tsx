import { type AnchorHTMLAttributes, createContext, type MouseEvent, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { canonicalHref, parseRoute, type Route } from '../lib/routes';

/**
 * Navigation without a router (STACK-2): the page is the URL's query string
 * (`src/lib/routes.ts`), changed with `history.pushState` and followed on
 * `popstate`. A page with unsaved work can hold navigation with `useBlocker`.
 */

interface PendingNavigation {
  href: string;
  replace: boolean;
}

export interface Blocker {
  state: 'unblocked' | 'blocked';
  proceed(): void;
  reset(): void;
}

interface NavigationValue {
  route: Route;
  params: URLSearchParams;
  /** `force` skips a blocker, for a page that just saved its work. */
  navigate(href: string, options?: { replace?: boolean; force?: boolean }): void;
  blocker: Blocker;
  setBlocking(blocking: boolean): void;
}

const NavigationContext = createContext<NavigationValue | null>(null);

function currentSearch() {
  return window.location.search;
}

export function NavigationProvider({ children }: { children: React.ReactNode }) {
  const [search, setSearch] = useState(() => {
    const canonical = canonicalHref(window.location.pathname, window.location.search);
    if (canonical) window.history.replaceState(window.history.state, '', canonical);
    return currentSearch();
  });
  const [pending, setPending] = useState<PendingNavigation | null>(null);
  const blocking = useRef(false);

  const go = useCallback((href: string, replace: boolean) => {
    const url = new URL(href, window.location.origin);
    const canonical = canonicalHref(url.pathname, url.search) ?? href;
    if (replace) window.history.replaceState(null, '', canonical);
    else window.history.pushState(null, '', canonical);
    setSearch(currentSearch());
    window.scrollTo?.({ top: 0 });
  }, []);

  const navigate = useCallback((href: string, options: { replace?: boolean; force?: boolean } = {}) => {
    if (options.force) blocking.current = false;
    if (blocking.current) {
      setPending({ href, replace: Boolean(options.replace) });
      return;
    }
    go(href, Boolean(options.replace));
  }, [go]);

  // The address on screen, to return to when back or forward is held.
  const shown = useRef('');
  useEffect(() => { shown.current = `${window.location.pathname}${window.location.search}`; }, [search]);

  useEffect(() => {
    function onPopState() {
      const next = `${window.location.pathname}${window.location.search}`;
      if (blocking.current) {
        // Back or forward already moved: return to the page with unsaved work and ask first.
        window.history.pushState(null, '', shown.current);
        setPending({ href: next, replace: false });
        return;
      }
      setSearch(currentSearch());
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const setBlocking = useCallback((value: boolean) => {
    blocking.current = value;
    if (!value) setPending(null);
  }, []);

  const blocker = useMemo<Blocker>(() => ({
    state: pending ? 'blocked' : 'unblocked',
    proceed() {
      if (!pending) return;
      blocking.current = false;
      setPending(null);
      go(pending.href, pending.replace);
    },
    reset() { setPending(null); },
  }), [go, pending]);

  const value = useMemo<NavigationValue>(() => ({
    route: parseRoute(search),
    params: new URLSearchParams(search),
    navigate,
    blocker,
    setBlocking,
  }), [blocker, navigate, search, setBlocking]);

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation() {
  const value = useContext(NavigationContext);
  if (!value) throw new Error('useNavigation must be used within NavigationProvider');
  return value;
}

/** Holds navigation while `when` is true; the returned blocker asks the page to confirm. */
export function useBlocker(when: boolean): Blocker {
  const { blocker, setBlocking } = useNavigation();
  useEffect(() => {
    setBlocking(when);
    return () => setBlocking(false);
  }, [setBlocking, when]);
  return blocker;
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string; replace?: boolean };

/** An ordinary link that navigates in place; modified clicks (new tab, …) keep the browser's behaviour. */
export function Link({ to, replace, onClick, ...props }: LinkProps) {
  const { navigate } = useNavigation();
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target) return;
    event.preventDefault();
    navigate(to, { replace });
  }
  return <a href={to} onClick={handleClick} {...props} />;
}
