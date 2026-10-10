import {
  confirmSignIn as amplifyConfirmSignIn,
  fetchAuthSession,
  getCurrentUser,
  signIn as amplifySignIn,
  signOut as amplifySignOut,
} from 'aws-amplify/auth';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { appConfig } from '../config';
import { createLocalSession, getLocalSession } from '../services/api';
import type { SessionUser, UserRole } from '../types';

export type SignInResult = 'SIGNED_IN' | 'NEW_PASSWORD_REQUIRED';

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  configured: boolean;
  authMode: 'cognito' | 'local';
  signIn(username: string, password: string): Promise<SignInResult>;
  completeNewPassword(newPassword: string): Promise<void>;
  signOut(): Promise<void>;
  getToken(): Promise<string>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const localTokenKey = 'agt-local-auth-token';

export function roleFromGroups(groups: unknown): UserRole {
  return Array.isArray(groups) && groups.includes('Admin') ? 'Admin' : 'Standard';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(appConfig.authConfigured);

  const refresh = useCallback(async () => {
    if (!appConfig.authConfigured) {
      setUser(null);
      setLoading(false);
      return;
    }

    try {
      if (appConfig.authMode === 'local') {
        const token = localStorage.getItem(localTokenKey);
        if (!token) {
          setUser(null);
          return;
        }
        setUser(await getLocalSession(token));
        return;
      }
      const [current, session] = await Promise.all([getCurrentUser(), fetchAuthSession()]);
      const payload = session.tokens?.idToken?.payload;
      setUser({
        sub: current.userId,
        username: current.username,
        displayName: String(payload?.name ?? payload?.['cognito:username'] ?? current.username),
        email: payload?.email ? String(payload.email) : undefined,
        role: roleFromGroups(payload?.['cognito:groups']),
      });
    } catch {
      if (appConfig.authMode === 'local') localStorage.removeItem(localTokenKey);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async (username: string, password: string) => {
    if (appConfig.authMode === 'local') {
      const session = await createLocalSession(username, password);
      localStorage.setItem(localTokenKey, session.token);
      setUser(session.user);
      return 'SIGNED_IN';
    }
    const result = await amplifySignIn({ username, password });
    if (result.isSignedIn) {
      await refresh();
      return 'SIGNED_IN';
    }
    if (result.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
      if (result.nextStep.missingAttributes?.length) {
        throw new Error(`Your account is missing required attributes: ${result.nextStep.missingAttributes.join(', ')}. Contact an administrator.`);
      }
      return 'NEW_PASSWORD_REQUIRED';
    }
    throw new Error('This account requires an unsupported additional sign-in step. Contact an administrator.');
  }, [refresh]);

  const completeNewPassword = useCallback(async (newPassword: string) => {
    if (appConfig.authMode === 'local') throw new Error('Password changes are managed by an administrator.');
    const result = await amplifyConfirmSignIn({ challengeResponse: newPassword });
    if (!result.isSignedIn) {
      throw new Error('The password was accepted, but another unsupported sign-in step is required. Contact an administrator.');
    }
    await refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    if (appConfig.authMode === 'local') localStorage.removeItem(localTokenKey);
    else await amplifySignOut();
    setUser(null);
  }, []);

  const getToken = useCallback(async () => {
    if (appConfig.authMode === 'local') {
      const token = localStorage.getItem(localTokenKey);
      if (!token) throw new Error('Your session has expired. Sign in again.');
      return token;
    }
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    if (!token) throw new Error('Your session has expired. Sign in again.');
    return token;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      configured: appConfig.authConfigured,
      authMode: appConfig.authMode,
      signIn,
      completeNewPassword,
      signOut,
      getToken,
      refresh,
    }),
    [completeNewPassword, getToken, loading, refresh, signIn, signOut, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
