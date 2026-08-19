import { BiometricAuthResult, SorobanExplorerConfig } from './types';

interface SecureStorageProvider {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface BiometricProvider {
  authenticate(reason: string): Promise<BiometricAuthResult>;
  getBiometricType(): Promise<'faceid' | 'touchid' | 'fingerprint' | 'iris' | 'none'>;
  isAvailable(): Promise<boolean>;
}

export class SorobanExplorerAuth {
  private config: SorobanExplorerConfig;
  private storage: SecureStorageProvider;
  private biometric: BiometricProvider;
  private credentials: { accessToken: string; refreshToken: string; expiresAt: number } | null =
    null;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  private autoLockTimeoutMs: number = 60000;
  private onLockCallback: (() => void) | null = null;

  constructor(
    config: SorobanExplorerConfig,
    storage: SecureStorageProvider,
    biometric: BiometricProvider,
  ) {
    this.config = config;
    this.storage = storage;
    this.biometric = biometric;
  }

  async initialize(): Promise<void> {
    const stored = await this.storage.getItem('soroban_auth');
    if (stored) {
      try {
        this.credentials = JSON.parse(stored);
      } catch {
        await this.storage.removeItem('soroban_auth');
      }
    }
  }

  async authenticate(reason: string = 'Unlock Soroban Explorer'): Promise<boolean> {
    const bioResult = await this.biometric.authenticate(reason);
    if (!bioResult.success) return false;

    const stored = await this.storage.getItem('soroban_auth');
    if (stored) {
      this.credentials = JSON.parse(stored);
      if (this.credentials && this.credentials.expiresAt > Date.now()) {
        return true;
      }
    }

    try {
      const response = await fetch(`${this.config.baseUrl}/api/v1/auth/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ biometricType: bioResult.biometricType }),
      });
      if (!response.ok) return false;
      const auth = await response.json();
      this.credentials = {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        expiresAt: Date.now() + auth.expiresIn * 1000,
      };
      await this.storage.setItem('soroban_auth', JSON.stringify(this.credentials));
      return true;
    } catch {
      return false;
    }
  }

  async getValidToken(): Promise<string | null> {
    if (!this.credentials) return null;
    if (this.credentials.expiresAt > Date.now()) {
      return this.credentials.accessToken;
    }
    return this.refreshToken();
  }

  private async refreshToken(): Promise<string | null> {
    if (!this.credentials) return null;
    try {
      const response = await fetch(`${this.config.baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.credentials.refreshToken }),
      });
      if (!response.ok) {
        this.credentials = null;
        await this.storage.removeItem('soroban_auth');
        return null;
      }
      const auth = await response.json();
      this.credentials = {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        expiresAt: Date.now() + auth.expiresIn * 1000,
      };
      await this.storage.setItem('soroban_auth', JSON.stringify(this.credentials));
      return auth.accessToken;
    } catch {
      this.credentials = null;
      await this.storage.removeItem('soroban_auth');
      return null;
    }
  }

  async getBiometricType(): Promise<'faceid' | 'touchid' | 'fingerprint' | 'iris' | 'none'> {
    return this.biometric.getBiometricType();
  }

  async isBiometricAvailable(): Promise<boolean> {
    return this.biometric.isAvailable();
  }

  async lock(): Promise<void> {
    this.credentials = null;
    await this.storage.removeItem('soroban_auth');
    this.onLockCallback?.();
  }

  onLock(callback: () => void): void {
    this.onLockCallback = callback;
  }

  startAutoLock(timeoutMs: number = 60000): void {
    this.autoLockTimeoutMs = timeoutMs;
    const resetTimer = () => {
      if (this.lockTimer) clearTimeout(this.lockTimer);
      this.lockTimer = setTimeout(() => this.lock(), this.autoLockTimeoutMs);
    };
    document.addEventListener('visibilitychange', resetTimer);
    document.addEventListener('touchstart', resetTimer);
    resetTimer();
  }

  stopAutoLock(): void {
    if (this.lockTimer) clearTimeout(this.lockTimer);
  }
}
