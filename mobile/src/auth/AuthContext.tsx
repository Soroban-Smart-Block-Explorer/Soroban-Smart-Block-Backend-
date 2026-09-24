import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { Entitlements } from '@soroban-explorer/mobile';
import { authClient } from './client';
import { createWalletSigner, loadWalletSigner } from './stellarSigner';

export type AuthStatus = 'loading' | 'signed-out' | 'locked' | 'ready';

export interface AuthState {
  status: AuthStatus;
  address: string | null;
  entitlements: Entitlements | null;
  /** Creates or reuses the on-device wallet, then signs the login challenge. */
  signIn(): Promise<void>;
  /** Biometric unlock of the stored session. */
  unlock(): Promise<boolean>;
  /** Drops the in-memory session (auto-lock / manual lock). */
  lock(): Promise<void>;
  /** Revokes the session server-side and clears secure storage. */
  signOut(): Promise<void>;
  /** Biometric step-up gated on a premium entitlement. */
  unlockPremium(): Promise<boolean>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [address, setAddress] = useState<string | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);

  const hydrateEntitlements = useCallback(async () => {
    setEntitlements(await authClient.getEntitlements());
  }, []);

  useEffect(() => {
    let mounted = true;

    (async () => {
      await authClient.initialize();
      const hasSession = await authClient.hasStoredSession();
      if (!mounted) return;
      setStatus(hasSession ? 'locked' : 'signed-out');
      if (hasSession) setEntitlements(await authClient.getEntitlements());
    })();

    // Auto-lock after one minute of inactivity / when backgrounded.
    authClient.onLock(() => mounted && setStatus('locked'));
    authClient.startAutoLock(60_000, AppState);

    return () => {
      mounted = false;
      authClient.stopAutoLock();
    };
  }, []);

  const signIn = useCallback(async () => {
    const signer = (await loadWalletSigner()) ?? (await createWalletSigner());
    const session = await authClient.login(signer);
    setAddress(session.address ?? (await signer.getAddress()));
    await hydrateEntitlements();
    setStatus('ready');
  }, [hydrateEntitlements]);

  const unlock = useCallback(async () => {
    const ok = await authClient.unlock('Unlock Soroban Explorer');
    if (!ok) return false;
    await hydrateEntitlements();
    setStatus('ready');
    return true;
  }, [hydrateEntitlements]);

  const lock = useCallback(async () => {
    await authClient.lock();
    setStatus('locked');
  }, []);

  const signOut = useCallback(async () => {
    await authClient.logout();
    setEntitlements(null);
    setAddress(null);
    setStatus('signed-out');
  }, []);

  const unlockPremium = useCallback(async () => {
    const ok = await authClient.unlockPremium('Unlock premium features');
    if (ok) setEntitlements(await authClient.getEntitlements());
    return ok;
  }, []);

  return (
    <AuthContext.Provider
      value={{ status, address, entitlements, signIn, unlock, lock, signOut, unlockPremium }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
