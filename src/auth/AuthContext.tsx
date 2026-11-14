import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createLocalSession, deleteLocalSession, getLocalSession } from '../services/api';
import type { SessionUser } from '../types';

/**
 * The member session: an HttpOnly cookie the server sets at sign-in, never
 * visible to JavaScript (FE-3). It is independent of the Admin session at
 * /admin: signing in or out of one never affects the other.
 */
interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  signIn(username: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
/** Where 1.x kept the member bearer token; removed on load. */
const legacyTokenKey = 'agt-local-auth-token';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setUser(await getLocalSession());
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    try { localStorage.removeItem(legacyTokenKey); } catch { /* storage unavailable */ }
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async (username: string, password: string) => {
    setUser(await createLocalSession(username, password));
  }, []);

  const signOut = useCallback(async () => {
    try {
      await deleteLocalSession();
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, signIn, signOut, refresh }),
    [loading, refresh, signIn, signOut, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
