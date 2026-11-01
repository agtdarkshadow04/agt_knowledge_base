import { Navigate, useLocation } from 'react-router-dom';
import { LoadingState } from '../components/States';
import { useAuth } from './AuthContext';

export function SetupGate({ children }: { children: React.ReactNode }) {
  const { loading, setupRequired } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingState message="Checking installation status…" />;
  if (setupRequired && location.pathname !== '/setup') {
    return <Navigate to="/setup" replace />;
  }
  if (!setupRequired && location.pathname === '/setup') {
    return <Navigate to="/login" replace />;
  }
  return children;
}
