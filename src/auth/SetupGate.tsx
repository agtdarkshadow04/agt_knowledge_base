import { Navigate, useLocation } from 'react-router-dom';
import { LoadingState } from '../components/States';
import { useAuth } from './AuthContext';

export function SetupGate({ children }: { children: React.ReactNode }) {
  const { authMode, loading, setupRequired } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingState message="Checking installation status…" />;
  if (authMode === 'local' && setupRequired && location.pathname !== '/setup') {
    return <Navigate to="/setup" replace />;
  }
  if ((!setupRequired || authMode !== 'local') && location.pathname === '/setup') {
    return <Navigate to="/login" replace />;
  }
  return children;
}
