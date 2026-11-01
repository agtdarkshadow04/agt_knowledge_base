import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createInitialAdmin, createLocalSession, getLocalSession, getSetupStatus } from '../services/api';
import type { SessionUser } from '../types';

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  setupRequired: boolean;
  signIn(username: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  completeSetup(input: {
    username: string;
    displayName: string;
    email?: string;
    password: string;
    passwordConfirmation: string;
  }): Promise<void>;
  getToken(): Promise<string>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const localTokenKey = 'agt-local-auth-token';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupRequired, setSetupRequired] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const setup = await getSetupStatus();
      setSetupRequired(setup.required);
      if (setup.required) {
        localStorage.removeItem(localTokenKey);
        setUser(null);
        return;
      }
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

  const completeSetup = useCallback(async (input: {
    username: string;
    displayName: string;
    email?: string;
    password: string;
    passwordConfirmation: string;
  }) => {
    const session = await createInitialAdmin(input);
    localStorage.setItem(localTokenKey, session.token);
    setSetupRequired(false);
    setUser(session.user);
  }, []);

  const getToken = useCallback(async () => {
    const token = localStorage.getItem(localTokenKey);
    if (!token) throw new Error('Your session has expired. Sign in again.');
    return token;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      setupRequired,
      signIn,
      signOut,
      completeSetup,
      getToken,
      refresh,
    }),
    [completeSetup, getToken, loading, refresh, setupRequired, signIn, signOut, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
