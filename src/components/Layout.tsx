import { type ReactNode, useEffect, useRef, useState } from 'react';
import { migrateLegacyPreferences, applyPreferences, readPreferences, preferencesChangedEvent } from '../lib/preferences';
import { routeHref } from '../lib/routes';
import { useAppSettings } from './AppSettingsContext';
import { useAuth } from './AuthContext';
import { BookOpenIcon, LogInIcon, LogOutIcon, PlusIcon, SettingsIcon, ShieldCheckIcon, TagsIcon } from './Icons';
import { MaintenanceNotice } from './MaintenanceNotice';
import { Link, useNavigation } from './Navigation';
import { loginHref } from './RequireAuth';
import { SettingsModal } from './SettingsModal';

/** Applies the stored page-wide preferences now and whenever they change (A11Y-6). */
function usePagePreferences() {
  useEffect(() => {
    migrateLegacyPreferences();
    const apply = () => applyPreferences(document.documentElement, readPreferences());
    apply();
    window.addEventListener(preferencesChangedEvent, apply);
    window.addEventListener('storage', apply);
    return () => {
      window.removeEventListener(preferencesChangedEvent, apply);
      window.removeEventListener('storage', apply);
    };
  }, []);
}

/**
 * The public page chrome (UI-7): the `site-header` with the brand lockup and a
 * row of round icon buttons, `<main id="main-content">`, and the `site-footer`
 * with the support link.
 */
export function Layout({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const { settings } = useAppSettings();
  const { route, navigate } = useNavigation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const main = useRef<HTMLElement>(null);
  usePagePreferences();

  // Moving to another page announces it to screen readers by focusing the new content.
  const page = route.page === 'article' || route.page === 'history' || route.page === 'edit' ? `${route.page}:${route.id}` : route.page;
  const firstPage = useRef(true);
  useEffect(() => {
    if (firstPage.current) { firstPage.current = false; return; }
    main.current?.focus({ preventScroll: true });
  }, [page]);

  async function handleSignOut() {
    await signOut();
    navigate('/');
  }

  const isModerator = user?.role === 'Moderator';
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="site-header">
        <div className="header-inner">
          <Link to="/" className="brand" aria-label={`Alliance of Galactic Travellers ${settings.site.title}: home`}>
            <img className="brand-logo" src="/AgtOfficialLogo.webp" alt="" aria-hidden="true" width="44" height="44" />
            <span className="brand-copy">
              <span className="brand-name">Alliance of Galactic Travellers</span>
              <span className="brand-product">{settings.site.title}</span>
            </span>
          </Link>

          <nav className="header-actions" aria-label="Main">
            {user && (
              <span className={`identity-badge ${isModerator ? 'moderator' : ''}`}>
                {isModerator && <ShieldCheckIcon />}
                <span>{user.displayName} · {user.role}</span>
              </span>
            )}
            <Link to="/" className="button button-icon" aria-label="Browse articles" title="Browse articles" aria-current={route.page === 'home' ? 'page' : undefined}>
              <BookOpenIcon />
            </Link>
            {user && (
              <Link to={routeHref({ page: 'new' })} className="button button-icon" aria-label="New article" title="New article" aria-current={route.page === 'new' ? 'page' : undefined}>
                <PlusIcon />
              </Link>
            )}
            {isModerator && (
              <Link to={routeHref({ page: 'tags' })} className="button button-icon" aria-label="Manage tags" title="Manage tags" aria-current={route.page === 'tags' ? 'page' : undefined}>
                <TagsIcon />
              </Link>
            )}
            {user ? (
              <button className="button button-icon" type="button" onClick={() => void handleSignOut()} aria-label="Sign out" title="Sign out">
                <LogOutIcon />
              </button>
            ) : (
              <Link to={route.page === 'login' ? routeHref(route) : loginHref()} className="button button-icon" aria-label="Sign in" title="Sign in" aria-current={route.page === 'login' ? 'page' : undefined}>
                <LogInIcon />
              </Link>
            )}
            <button
              className="button button-icon"
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              title="Settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
            >
              <SettingsIcon />
            </button>
          </nav>
        </div>
      </header>

      <MaintenanceNotice />

      <main id="main-content" ref={main} className="main-content" tabIndex={-1}>
        {children}
      </main>

      <footer className="site-footer">
        <nav aria-label="Alliance links">
          <a href="https://www.nms-agt.com" target="_blank" rel="noreferrer">Home</a>
          <a href="https://www.nms-agt.com/about-the-agt" target="_blank" rel="noreferrer">About</a>
          <a href="https://www.nms-agt.com/contribute" target="_blank" rel="noreferrer">Contribute</a>
          <a href="https://www.nms-agt.com/agt-galactic-archives" target="_blank" rel="noreferrer">Galactic Archives</a>
          <a href={settings.site.supportUrl} target="_blank" rel="noreferrer">Support</a>
        </nav>
        <p>© {new Date().getUTCFullYear()} Alliance of Galactic Travellers</p>
      </footer>
      {settingsOpen && <SettingsModal user={user} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
