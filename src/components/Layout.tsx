import { type ReactNode, useEffect, useRef, useState } from 'react';
import { COMMON_TRANSLATIONS, formatTranslation } from '../translations';
import { routeHref } from '../lib/routes';
import { useAppSettings } from './AppSettingsContext';
import { useAuth } from './AuthContext';
import { useI18n } from './I18n';
import { BookOpenIcon, LogInIcon, LogOutIcon, PlusIcon, SettingsIcon, ShieldCheckIcon, TagsIcon } from './Icons';
import { MaintenanceNotice } from './MaintenanceNotice';
import { Link, useNavigation } from './Navigation';
import { loginHref } from './RequireAuth';
import { SettingsModal } from './SettingsModal';

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
  const { t } = useI18n();

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
      <a className="skip-link" href="#main-content">{t.common.skipToContent}</a>
      <header className="site-header">
        <div className="header-inner">
          <Link to="/" className="brand" aria-label={formatTranslation(t.layout.homeLabel, { alliance: COMMON_TRANSLATIONS.alliance, product: settings.site.title })}>
            <img className="brand-logo" src="/AgtOfficialLogo.webp" alt="" aria-hidden="true" width="44" height="44" />
            <span className="brand-copy">
              <span className="brand-name">{COMMON_TRANSLATIONS.alliance}</span>
              <span className="brand-product">{settings.site.title}</span>
            </span>
          </Link>

          <nav className="header-actions" aria-label={t.layout.mainNavigation}>
            {user && (
              <span className={`identity-badge ${isModerator ? 'moderator' : ''}`}>
                {isModerator && <ShieldCheckIcon />}
                <span>{user.displayName} · {t.roles[user.role]}</span>
              </span>
            )}
            <Link to="/" className="button button-icon" aria-label={t.layout.browse} title={t.layout.browse} aria-current={route.page === 'home' ? 'page' : undefined}>
              <BookOpenIcon />
            </Link>
            {user && (
              <Link to={routeHref({ page: 'new' })} className="button button-icon" aria-label={t.layout.newArticle} title={t.layout.newArticle} aria-current={route.page === 'new' ? 'page' : undefined}>
                <PlusIcon />
              </Link>
            )}
            {isModerator && (
              <Link to={routeHref({ page: 'tags' })} className="button button-icon" aria-label={t.layout.manageTags} title={t.layout.manageTags} aria-current={route.page === 'tags' ? 'page' : undefined}>
                <TagsIcon />
              </Link>
            )}
            {user ? (
              <button className="button button-icon" type="button" onClick={() => void handleSignOut()} aria-label={t.layout.signOut} title={t.layout.signOut}>
                <LogOutIcon />
              </button>
            ) : (
              <Link to={route.page === 'login' ? routeHref(route) : loginHref()} className="button button-icon" aria-label={t.layout.signIn} title={t.layout.signIn} aria-current={route.page === 'login' ? 'page' : undefined}>
                <LogInIcon />
              </Link>
            )}
            <button
              className="button button-icon"
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label={t.layout.settings}
              title={t.layout.settings}
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
        <nav aria-label={t.layout.allianceLinks}>
          <a href="https://www.nms-agt.com" target="_blank" rel="noreferrer">{t.layout.footerHome}</a>
          <a href="https://www.nms-agt.com/about-the-agt" target="_blank" rel="noreferrer">{t.layout.footerAbout}</a>
          <a href="https://www.nms-agt.com/contribute" target="_blank" rel="noreferrer">{t.layout.footerContribute}</a>
          <a href="https://www.nms-agt.com/agt-galactic-archives" target="_blank" rel="noreferrer">{t.layout.footerArchives}</a>
          <a href={settings.site.supportUrl} target="_blank" rel="noreferrer">{t.layout.footerSupport}</a>
        </nav>
        <p>{formatTranslation(t.layout.copyright, { year: new Date().getUTCFullYear(), alliance: COMMON_TRANSLATIONS.alliance })}</p>
      </footer>
      {settingsOpen && <SettingsModal user={user} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
