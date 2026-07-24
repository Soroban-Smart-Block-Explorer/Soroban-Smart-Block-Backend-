import {
  SorobanExplorerConfig,
  PushNotification,
  SubscriptionType,
  QuietHours,
  DeepLink,
} from './types';

interface PushPlatformProvider {
  register(): Promise<string>;
  unregister(): Promise<void>;
  onNotification(callback: (notification: PushNotification) => void): () => void;
  onTokenRefresh(callback: (token: string) => void): () => void;
}

export class SorobanExplorerPush {
  private config: SorobanExplorerConfig;
  private provider: PushPlatformProvider;
  private registration: { token: string; platform: 'ios' | 'android' | 'web' } | null = null;
  private notificationCallbacks: Set<(notification: PushNotification) => void> = new Set();
  private deepLinkCallbacks: Set<(link: import('./types').DeepLink) => void> = new Set();

  constructor(config: SorobanExplorerConfig, provider: PushPlatformProvider) {
    this.config = config;
    this.provider = provider;
  }

  async register(platform: 'ios' | 'android' | 'web'): Promise<string> {
    const token = await this.provider.register();
    this.registration = { token, platform };

    try {
      await fetch(`${this.config.baseUrl}/api/v1/push/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, platform }),
      });
    } catch {
      // will retry on next connect
    }

    this.provider.onNotification((notification) => {
      this.handleNotification(notification);
    });

    return token;
  }

  async unregister(): Promise<void> {
    if (!this.registration) return;
    try {
      await fetch(`${this.config.baseUrl}/api/v1/push/unregister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this.registration.token }),
      });
    } catch {
      // best effort
    }
    await this.provider.unregister();
    this.registration = null;
  }

  async updateSubscriptions(subscriptions: SubscriptionType[]): Promise<void> {
    if (!this.registration) return;
    try {
      await fetch(`${this.config.baseUrl}/api/v1/push/subscriptions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this.registration.token, subscriptions }),
      });
    } catch {
      // will retry on next sync
    }
  }

  async setQuietHours(quietHours: QuietHours): Promise<void> {
    if (!this.registration) return;
    try {
      await fetch(`${this.config.baseUrl}/api/v1/push/quiet-hours`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this.registration.token, quietHours }),
      });
    } catch {
      // will retry on next sync
    }
  }

  onNotification(callback: (notification: PushNotification) => void): () => void {
    this.notificationCallbacks.add(callback);
    return () => this.notificationCallbacks.delete(callback);
  }

  onDeepLink(callback: (link: DeepLink) => void): () => void {
    this.deepLinkCallbacks.add(callback);
    return () => this.deepLinkCallbacks.delete(callback);
  }

  parseDeepLink(url: string): DeepLink | null {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'soroban:') return null;

      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length < 2) return null;

      const type = parts[0] as DeepLink['type'];
      const id = parts[1];

      if (!['transaction', 'wallet', 'contract', 'event', 'proposal'].includes(type)) {
        return null;
      }

      return { type, id, raw: url };
    } catch {
      return null;
    }
  }

  private handleNotification(notification: PushNotification): void {
    this.notificationCallbacks.forEach((cb) => cb(notification));

    if (notification.deepLink) {
      const link = this.parseDeepLink(notification.deepLink);
      if (link) {
        this.deepLinkCallbacks.forEach((cb) => cb(link));
      }
    }
  }

  private getDeviceId(): string {
    if (typeof window !== 'undefined' && window.localStorage) {
      let id = window.localStorage.getItem('soroban_device_id');
      if (!id) {
        id = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        window.localStorage.setItem('soroban_device_id', id);
      }
      return id;
    }
    return `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
