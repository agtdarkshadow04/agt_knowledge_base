import { useEffect } from 'react';
import { LoadingState } from './States';
import { useAuth } from './AuthContext';
import { useNavigation } from './Navigation';
import { loginHref } from './RequireAuth';

/** Shows its children to Moderators only. The API enforces the same rule. */
export function RequireModerator({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { navigate } = useNavigation();
  useEffect(() => {
    if (loading) return;
    if (!user) navigate(loginHref(), { replace: true });
    else if (user.role !== 'Moderator') navigate('/', { replace: true });
  }, [loading, navigate, user]);

  if (loading) return <LoadingState message="Checking moderator access…" />;
  if (!user || user.role !== 'Moderator') return null;
  return children;
}
