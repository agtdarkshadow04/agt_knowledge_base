import { useEffect } from 'react';
import { useI18n } from './I18n';
import { LoadingState } from './States';
import { useAuth } from './AuthContext';
import { useNavigation } from './Navigation';
import { routeHref } from '../lib/routes';

/** The sign-in page, returning to the current page afterwards. */
export function loginHref() {
  return routeHref({ page: 'login', next: `${window.location.pathname}${window.location.search}` });
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { navigate } = useNavigation();
  const { t } = useI18n();
  useEffect(() => { if (!loading && !user) navigate(loginHref(), { replace: true }); }, [loading, navigate, user]);

  if (loading) return <LoadingState message={t.states.checkingSession} />;
  if (!user) return null;
  return children;
}
