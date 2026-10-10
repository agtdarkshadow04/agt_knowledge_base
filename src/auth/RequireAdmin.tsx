import { Navigate, useLocation } from 'react-router-dom';
import { LoadingState } from '../components/States';
import { useAuth } from './AuthContext';

export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingState message="Checking administrator access…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.role !== 'Admin') return <Navigate to="/" replace />;
  return children;
}
