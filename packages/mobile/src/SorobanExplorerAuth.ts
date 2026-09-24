import {
  AppStateLike,
  AuthSession,
  BiometricAuthResult,
  BiometricType,
  Entitlements,
  SorobanExplorerConfig,
  WalletSigner,
} from './types';

/**
 * Secure key/value store for tokens. Backed by `expo-secure-store`
 * (Secure Enclave / Android Keystore) on device, or any equivalent provider.
 */
export interface SecureStorageProvider {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Biometric gate. Backed by `expo-local-authentication` on device.
 */
export interface BiometricProvider {
  authenticate(reason: string): Promise<BiometricAuthResult>;
  getBiometricType(): Promise<BiometricType>;
  isAvailable(): Promise<boolean>;
}

interface LoginOptions {
  network?: 'testnet' | 'mainnet' | 'devnet';
  appId?: string;
}

interface ChallengeResponse {
  challenge: string;
  challengeId: string;
  expiresAt?: string;
  type?: string;
}

interface TokenResponse {
  token?: string;
  accessToken?: string;
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
  sessionId?: string;
  expiresAt?: string;
  expiresIn?: number;
}

const STORAGE_KEY = 'soroban_auth';
const DEFAULT_AUTH_PATH = '/api/v1/auth';
const DEFAULT_APP_ID = 'explorer-mobile';
/** Refresh the access token this long before it actually expires. */
const EXPIRY_SKEW_MS = 30_000;
const DEFAULT_ACCESS_TOKEN_TTL_MS = 15 * 60_000;

const TIER_ORDER: Entitlements['tier'][] = ['free', 'developer', 'premium', 'enterprise'];

/**
 * Mobile authentication client.
 *
 * Reuses the backend's Stellar challenge/verify login (the same flow the web
 * app uses) and stores the resulting JWT + refresh token in the platform secure
 * store. Biometric authentication gates unlocking the stored session and is
 * required as a step-up check before premium-only features.
 *
 * Flow:
 *   1. `login(signer)`  → POST /auth/challenge → sign → POST /auth/verify
 *   2. store tokens securely, fetch entitlements from /auth/me
 *   3. `authenticate()` → biometric gate that re-hydrates the session
 *   4. `getValidToken()` → transparently rotates via POST /auth/refresh
 *   5. `unlockPremium()` → biometric + tier check for premium features
 */
export class SorobanExplorerAuth {
  private config: SorobanExplorerConfig;
  private storage: SecureStorageProvider;
  private biometric: BiometricProvider;
  private session: AuthSession | null = null;
  private entitlements: Entitlements | null = null;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  private autoLockTimeoutMs: number = 60_000;
  private onLockCallback: (() => void) | null = null;
  private appStateSubscription: { remove: () => void } | null = null;
  private webListenerCleanup: (() => void) | null = null;
  private refreshing: Promise<AuthSession | null> | null = null;

  constructor(
    config: SorobanExplorerConfig,
    storage: SecureStorageProvider,
    biometric: BiometricProvider,
  ) {
    this.config = config;
    this.storage = storage;
    this.biometric = biometric;
  }

  private get authPath(): string {
    return (this.config.authPath ?? DEFAULT_AUTH_PATH).replace(/\/$/, '');
  }

  private get network(): 'testnet' | 'mainnet' | 'devnet' {
    return this.config.network ?? 'testnet';
  }

  private get appId(): string {
    return this.config.appId ?? DEFAULT_APP_ID;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(
      `${this.config.baseUrl.replace(/\/$/, '')}${this.authPath}${path}`,
      {
        ...init,
        credentials: this.config.credentials ?? 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...((init.headers as Record<string, string> | undefined) ?? {}),
        },
      },
    );

    if (!response.ok) {
      const message = await response
        .json()
        .then(
          (body: { error?: string; message?: string }): string | undefined =>
            body.error ?? body.message,
        )
        .catch((): undefined => undefined);
      throw new Error(message ?? `Auth request failed (${response.status})`);
    }

    return (await response.json()) as T;
  }

  private toSession(body: TokenResponse): AuthSession | null {
    const accessToken = body.token ?? body.accessToken ?? body.access_token;
    const refreshToken = body.refreshToken ?? body.refresh_token;
    if (!accessToken || !refreshToken) return null;

    const expiresAt = body.expiresAt
      ? Date.parse(body.expiresAt)
      : body.expiresIn
        ? Date.now() + body.expiresIn * 1000
        : Date.now() + DEFAULT_ACCESS_TOKEN_TTL_MS;

    return {
      accessToken,
      refreshToken,
      sessionId: body.sessionId,
      expiresAt: Number.isNaN(expiresAt) ? Date.now() + DEFAULT_ACCESS_TOKEN_TTL_MS : expiresAt,
    };
  }

  private async persist(session: AuthSession | null): Promise<void> {
    this.session = session;
    if (session) {
      await this.storage.setItem(STORAGE_KEY, JSON.stringify(session));
    } else {
      await this.storage.removeItem(STORAGE_KEY);
    }
  }

  /** Loads any previously stored session into memory without a biometric prompt. */
  async initialize(): Promise<void> {
    const stored = await this.storage.getItem(STORAGE_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as AuthSession;
      if (parsed?.accessToken && parsed?.refreshToken) {
        this.session = parsed;
      } else {
        await this.storage.removeItem(STORAGE_KEY);
      }
    } catch {
      await this.storage.removeItem(STORAGE_KEY);
    }
  }

  /**
   * Logs in by signing the backend's Stellar challenge with the wallet key.
   * The private key never leaves the signer implementation.
   */
  async login(signer: WalletSigner, options: LoginOptions = {}): Promise<AuthSession> {
    const address = await signer.getAddress();
    const network = options.network ?? this.network;
    const appId = options.appId ?? this.appId;

    const challenge = await this.request<ChallengeResponse>('/challenge', {
      method: 'POST',
      body: JSON.stringify({ address, network, appId }),
    });
    if (!challenge?.challenge || !challenge?.challengeId) {
      throw new Error('Malformed challenge response');
    }

    const signature = await signer.sign(challenge.challenge);

    const verified = await this.request<TokenResponse>('/verify', {
      method: 'POST',
      body: JSON.stringify({
        address,
        challengeId: challenge.challengeId,
        signature,
        network,
      }),
    });

    const session = this.toSession(verified);
    if (!session) throw new Error('Malformed token response');

    const next: AuthSession = { ...session, address };
    await this.persist(next);
    return next;
  }

  /**
   * True when a session is available in memory or in secure storage. Lets the
   * app decide between showing the biometric lock screen and the login screen
   * without prompting for biometrics.
   */
  async hasStoredSession(): Promise<boolean> {
    if (this.session) return true;
    return (await this.storage.getItem(STORAGE_KEY)) !== null;
  }

  /**
   * Biometric app-unlock. Re-hydrates the stored session so API calls can
   * resume without a full re-login. Returns false when biometrics fail or no
   * session has been stored yet.
   */
  async authenticate(reason: string = 'Unlock Soroban Explorer'): Promise<boolean> {
    const bioResult = await this.biometric.authenticate(reason);
    if (!bioResult.success) return false;

    if (!this.session) {
      await this.initialize();
    }
    return this.session !== null;
  }

  /** Alias for {@link authenticate} used by app-lock screens. */
  async unlock(reason?: string): Promise<boolean> {
    return this.authenticate(reason);
  }

  /**
   * Returns a usable access token, refreshing it when it is close to expiry.
   * Concurrent callers share a single refresh request.
   */
  async getValidToken(): Promise<string | null> {
    if (!this.session) return null;
    if (this.session.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      return this.session.accessToken;
    }
    const refreshed = await this.refreshToken();
    return refreshed?.accessToken ?? null;
  }

  /**
   * Rotates the access + refresh token pair via the backend. Clears the stored
   * session (and fires the lock callback) when the refresh token is rejected.
   */
  async refreshToken(): Promise<AuthSession | null> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.performRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async performRefresh(): Promise<AuthSession | null> {
    if (!this.session?.refreshToken) return null;
    try {
      const body = await this.request<TokenResponse>('/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: this.session.refreshToken }),
      });
      const rotated = this.toSession(body);
      if (!rotated) throw new Error('Malformed refresh response');

      const next: AuthSession = {
        ...this.session,
        ...rotated,
        address: this.session.address,
      };
      await this.persist(next);
      return next;
    } catch {
      await this.persist(null);
      this.entitlements = null;
      this.onLockCallback?.();
      return null;
    }
  }

  /** Revokes the current session server-side and clears it locally. */
  async logout(): Promise<void> {
    const token = this.session?.accessToken;
    if (token) {
      try {
        await this.request('/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        // Best-effort: always clear local state even if the server call fails.
      }
    }
    this.entitlements = null;
    await this.persist(null);
    this.onLockCallback?.();
  }

  /**
   * Fetches (and caches) tier + feature entitlements from the backend. Used to
   * gate premium-only mobile features on the same entitlements as the web app.
   */
  async getEntitlements(): Promise<Entitlements | null> {
    const token = await this.getValidToken();
    if (!token) return null;

    try {
      const me = await this.request<{
        tier?: string;
        features?: string[];
        rateLimit?: { requestsPerMinute: number; burstLimit: number };
      }>('/me', { headers: { Authorization: `Bearer ${token}` } });

      const tier = (
        TIER_ORDER.includes(me.tier as Entitlements['tier']) ? me.tier : 'free'
      ) as Entitlements['tier'];

      this.entitlements = {
        tier,
        features: me.features ?? [],
        rateLimit: me.rateLimit,
        isPremium: tier === 'premium' || tier === 'enterprise',
      };
      return this.entitlements;
    } catch {
      return null;
    }
  }

  /** Last resolved entitlements, or null before {@link getEntitlements} runs. */
  getCachedEntitlements(): Entitlements | null {
    return this.entitlements;
  }

  /** True when the cached entitlements include the given feature flag. */
  hasFeature(feature: string): boolean {
    return this.entitlements?.features.includes(feature) ?? false;
  }

  /** True when the cached tier is premium or enterprise. */
  hasPremiumAccess(): boolean {
    if (!this.entitlements) return false;
    return this.entitlements.isPremium;
  }

  /**
   * Step-up gate for premium-only features: requires a valid premium
   * entitlement *and* a successful biometric prompt.
   */
  async unlockPremium(reason: string = 'Unlock premium features'): Promise<boolean> {
    const entitlements = this.entitlements ?? (await this.getEntitlements());
    if (!entitlements?.isPremium) return false;
    return this.authenticate(reason);
  }

  async getBiometricType(): Promise<BiometricType> {
    return this.biometric.getBiometricType();
  }

  async isBiometricAvailable(): Promise<boolean> {
    return this.biometric.isAvailable();
  }

  /** Drops the in-memory session. The stored refresh token is kept so the user
   * can re-unlock with biometrics without logging in again. */
  async lock(): Promise<void> {
    this.session = null;
    this.entitlements = null;
    this.onLockCallback?.();
  }

  onLock(callback: () => void): void {
    this.onLockCallback = callback;
  }

  /**
   * Locks the client after `timeoutMs` of inactivity. Accepts a React Native
   * `AppState`-like object; falls back to DOM listeners for web/PWA builds.
   */
  startAutoLock(timeoutMs: number = 60_000, appState?: AppStateLike): void {
    this.autoLockTimeoutMs = timeoutMs;
    this.stopAutoLock();

    const resetTimer = () => {
      if (this.lockTimer) clearTimeout(this.lockTimer);
      this.lockTimer = setTimeout(() => this.lock(), this.autoLockTimeoutMs);
    };

    if (appState?.addEventListener) {
      const subscription = appState.addEventListener('change', (state) => {
        if (state === 'active') resetTimer();
        else if (state === 'background' || state === 'inactive') void this.lock();
      });
      this.appStateSubscription =
        subscription && typeof subscription.remove === 'function' ? subscription : null;
    } else if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', resetTimer);
      document.addEventListener('touchstart', resetTimer);
      this.webListenerCleanup = () => {
        document.removeEventListener('visibilitychange', resetTimer);
        document.removeEventListener('touchstart', resetTimer);
      };
    }

    resetTimer();
  }

  stopAutoLock(): void {
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
    if (this.webListenerCleanup) {
      this.webListenerCleanup();
      this.webListenerCleanup = null;
    }
  }

  /** Clears the session from memory and secure storage (sign-out). */
  async clearCredentials(): Promise<void> {
    this.entitlements = null;
    await this.persist(null);
  }
}
