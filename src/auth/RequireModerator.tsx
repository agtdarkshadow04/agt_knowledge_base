import { Navigate, useLocation } from 'react-router-dom';
import { LoadingState } from '../components/States';
import { useAuth } from './AuthContext';

/** Shows its children to Moderators only. The API enforces the same rule. */
export function RequireModerator({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingState message="Checking moderator access…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.role !== 'Moderator') return <Navigate to="/" replace />;
  return children;
}
