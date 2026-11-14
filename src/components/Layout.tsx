import { BookOpen, LogIn, LogOut, Plus, ShieldCheck, Tags } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useAppSettings } from '../settings/AppSettingsContext';
import { applyStoredAccessibilitySettings, SettingsIcon, SettingsModal } from './SettingsModal';

export function Layout() {
  const { user, signOut } = useAuth();
  const { settings } = useAppSettings();
  const [logoFailed, setLogoFailed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    requestAnimationFrame(() => settingsButton.current?.focus());
  }, []);

  useEffect(() => {
    applyStoredAccessibilitySettings();
  }, []);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="site-header">
        <div className="header-inner">
          <Link to="/" className="brand" aria-label={`${settings.site.title} home`}>
            <span className="brand-mark" aria-hidden="true">
              {!logoFailed ? (
                <img src="/assets/agt-icon.png" alt="" onError={() => setLogoFailed(true)} />
              ) : (
                <span>AGT</span>
              )}
            </span>
            <span className="brand-copy">
              <strong><span className="desktop-only">{settings.site.title}</span><span className="mobile-only">AGT</span></strong>
              <small><span className="desktop-only">{settings.site.subtitle}</span><span className="mobile-only">Archives</span></small>
            </span>
          </Link>

          <nav className="header-actions" aria-label="Primary navigation">
            <NavLink to="/" className="icon-link">
              <BookOpen aria-hidden="true" /> <span className="desktop-only">Browse</span>
            </NavLink>
            {user && (
              <NavLink to="/articles/new" className="button button-primary compact">
                <Plus aria-hidden="true" /> <span className="desktop-only">New article</span>
              </NavLink>
            )}
            {user?.role === 'Moderator' && (
              <NavLink to="/tags" className="icon-link">
                <Tags aria-hidden="true" /> <span className="desktop-only">Tags</span>
              </NavLink>
            )}
            <span className={`identity-badge ${user?.role === 'Moderator' ? 'moderator' : ''}`}>
              {user?.role === 'Moderator' && <ShieldCheck aria-hidden="true" />}
              <span>{user ? `${user.displayName} · ${user.role}` : 'Public user'}</span>
            </span>
            {user ? (
              <button className="icon-button" type="button" onClick={() => void signOut()} title="Sign out">
                <LogOut aria-hidden="true" /><span className="sr-only">Sign out</span>
              </button>
            ) : (
              <NavLink to="/login" className="icon-button" title="Sign in">
                <LogIn aria-hidden="true" /><span className="sr-only">Sign in</span>
              </NavLink>
            )}
            <button
              ref={settingsButton}
              className="icon-button"
              type="button"
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
            >
              <SettingsIcon /><span className="sr-only">Settings</span>
            </button>
          </nav>
        </div>
        <div className="header-line" />
      </header>

      <main id="main-content" className="main-content" tabIndex={-1}>
        <Outlet />
      </main>

      <footer className="site-footer">
        <nav aria-label="Alliance links">
          <a href="https://www.nms-agt.com" target="_blank" rel="noreferrer">Home</a>
          <a href="https://www.nms-agt.com/about-the-agt" target="_blank" rel="noreferrer">About</a>
          <a href="https://www.nms-agt.com/contribute" target="_blank" rel="noreferrer">Contribute</a>
          <a href="https://www.nms-agt.com/agt-galactic-archives" target="_blank" rel="noreferrer">Galactic Archives</a>
          <a href="https://www.nms-agt.com/support" target="_blank" rel="noreferrer">Support</a>
        </nav>
        <p>© {new Date().getUTCFullYear()} Alliance of Galactic Travellers</p>
      </footer>
      {settingsOpen && <SettingsModal user={user} onClose={closeSettings} />}
    </div>
  );
}
