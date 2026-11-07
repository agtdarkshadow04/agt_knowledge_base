import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createLocalSession, getLocalSession } from '../services/api';
import type { SessionUser } from '../types';

/**
 * The member session. It is independent of the Admin session at /admin:
 * signing in or out of one never affects the other.
 */
interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  signIn(username: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  getToken(): Promise<string>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const localTokenKey = 'agt-local-auth-token';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const token = localStorage.getItem(localTokenKey);
      if (!token) {
        setUser(null);
        return;
      }
      setUser(await getLocalSession(token));
    } catch {
      localStorage.removeItem(localTokenKey);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async (username: string, password: string) => {
    const session = await createLocalSession(username, password);
    localStorage.setItem(localTokenKey, session.token);
    setUser(session.user);
  }, []);

  const signOut = useCallback(async () => {
    localStorage.removeItem(localTokenKey);
    setUser(null);
  }, []);

  const getToken = useCallback(async () => {
    const token = localStorage.getItem(localTokenKey);
    if (!token) throw new Error('Your session has expired. Sign in again.');
    return token;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, signIn, signOut, getToken, refresh }),
    [getToken, loading, refresh, signIn, signOut, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
