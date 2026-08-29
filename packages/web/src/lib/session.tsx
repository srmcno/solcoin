import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setCsrfToken, setUnauthorizedHandler } from './api';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'owner' | 'admin' | 'analyst' | 'viewer';
  permissions: string[];
}

interface SessionState {
  user: SessionUser | null;
  loading: boolean;
  needsBootstrap: boolean;
  secretStoreUnlocked: boolean;
  onboardingCompleted: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  bootstrap: (input: { email: string; password: string; displayName: string }) => Promise<void>;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [secretStoreUnlocked, setSecretStoreUnlocked] = useState(false);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const bootstrap = await api<{ needsBootstrap: boolean; secretStoreUnlocked: boolean; onboardingCompleted: boolean }>(
        '/api/system/bootstrap',
      );
      setNeedsBootstrap(bootstrap.needsBootstrap);
      setSecretStoreUnlocked(bootstrap.secretStoreUnlocked);
      setOnboardingCompleted(bootstrap.onboardingCompleted);

      const session = await api<{ authenticated: boolean; user: SessionUser | null; csrfToken: string | null }>(
        '/api/auth/session',
      );
      setUser(session.authenticated ? session.user : null);
      setCsrfToken(session.csrfToken);
    } catch {
      // A failure here means the API is unreachable; the shell renders an
      // explanatory screen rather than an infinite spinner.
      setUser(null);
      setCsrfToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setCsrfToken(null);
    });
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await api<{ user: SessionUser; csrfToken: string }>('/api/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      setCsrfToken(result.csrfToken);
      setUser(result.user);
      await refresh();
    },
    [refresh],
  );

  const bootstrap = useCallback(
    async (input: { email: string; password: string; displayName: string }) => {
      const result = await api<{ user: SessionUser; csrfToken: string }>('/api/system/bootstrap', {
        method: 'POST',
        body: input,
      });
      setCsrfToken(result.csrfToken);
      setUser(result.user);
      setNeedsBootstrap(false);
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setUser(null);
    setCsrfToken(null);
  }, []);

  const can = useCallback((permission: string) => user?.permissions.includes(permission) ?? false, [user]);

  const value = useMemo<SessionState>(
    () => ({ user, loading, needsBootstrap, secretStoreUnlocked, onboardingCompleted, refresh, login, bootstrap, logout, can }),
    [user, loading, needsBootstrap, secretStoreUnlocked, onboardingCompleted, refresh, login, bootstrap, logout, can],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside a SessionProvider.');
  return context;
}
