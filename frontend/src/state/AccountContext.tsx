import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, client, refreshAccessToken, session, type Account, type AuthSession } from '../api';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn' | 'expired';

interface AccountState {
  status: AuthStatus;
  account: Account | null;
  setBalance: (balance: number) => void;
  signedIn: (auth: AuthSession) => void;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

const AccountContext = createContext<AccountState>({
  status: 'loading',
  account: null,
  setBalance: () => {},
  signedIn: () => {},
  signOut: async () => {},
  reload: async () => {},
});

export function AccountProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  const reload = useCallback(async () => {
    const me = await api.getMe();
    setAccount(me);
    setStatus('signedIn');
  }, []);

  useEffect(() => {
    let live = true;
    session.onLost(() => {
      if (!live) return;
      setStatus('expired');
    });
    (async () => {
      const token = session.token ?? (await refreshAccessToken());
      if (!live) return;
      if (!token) {
        setStatus('signedOut');
        return;
      }
      try {
        const me = await api.getMe();
        if (!live) return;
        setAccount(me);
        setStatus('signedIn');
      } catch {
        if (live) setStatus('signedOut');
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const setBalance = useCallback((tokenBalance: number) => {
    if (!Number.isFinite(tokenBalance)) return;
    setAccount((prev) => (prev ? { ...prev, tokenBalance } : prev));
  }, []);

  const signedIn = useCallback((auth: AuthSession) => {
    session.set(auth.accessToken);
    setAccount(auth.account);
    setStatus('signedIn');
  }, []);

  const signOut = useCallback(async () => {
    try {
      await client.POST('/v1/auth/logout');
    } catch {
      return;
    } finally {
      session.set(null);
      setAccount(null);
      setStatus('signedOut');
    }
  }, []);

  const value = useMemo(
    () => ({ status, account, setBalance, signedIn, signOut, reload }),
    [status, account, setBalance, signedIn, signOut, reload]
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountState {
  return useContext(AccountContext);
}
