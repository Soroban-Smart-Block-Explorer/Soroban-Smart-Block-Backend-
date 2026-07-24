
interface PushDevice {
  token: string;
  platform: 'ios' | 'android' | 'web';
  deviceId: string;
  subscriptions: SubscriptionType[];
  quietHours?: QuietHours;
  createdAt: Date;
  lastSeenAt: Date;
}

interface QuietHours {
  start: string;
  end: string;
  timezone: string;
  emergencyOverride: boolean;
}

type SubscriptionType =
  | 'price_alert'
  | 'wallet_activity'
  | 'contract_event'
  | 'governance_milestone'
  | 'compliance_event'
  | 'gas_price_spike'
  | 'system_announcement';

interface NotificationEvent {
  id: string;
  type: SubscriptionType;
  title: string;
  body: string;
  data?: Record<string, string>;
  groupKey?: string;
  category?: string;
  deepLink?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  timestamp: Date;
}

interface NotificationDelivery {
  notificationId: string;
  deviceToken: string;
  platform: 'ios' | 'android' | 'web';
  title: string;
  body: string;
  data?: Record<string, string>;
  groupKey?: string;
  category?: string;
  deliveredAt?: Date;
  error?: string;
}

export class NotificationService {
  private fcmApiKey?: string;
  private apnsKey?: string;
  private vapidKeys?: { publicKey: string; privateKey: string };
  private deliveryLog: NotificationDelivery[] = [];
  private maxDeliveryLog: number = 10000;

  constructor(config: {
    fcmApiKey?: string;
    apnsKey?: string;
    vapidKeys?: { publicKey: string; privateKey: string };
  }) {
    this.fcmApiKey = config.fcmApiKey;
    this.apnsKey = config.apnsKey;
    this.vapidKeys = config.vapidKeys;
  }

  async send(notification: {
    title: string;
    body: string;
    data?: Record<string, string>;
    groupKey?: string;
    category?: string;
    deepLink?: string;
    severity?: string;
    devices: Array<{ token: string; platform: string }>;
  }): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    const groupedByPlatform: Record<string, string[]> = {};
    for (const device of notification.devices) {
      if (!groupedByPlatform[device.platform]) {
        groupedByPlatform[device.platform] = [];
      }
      groupedByPlatform[device.platform].push(device.token);
    }

    for (const [platform, tokens] of Object.entries(groupedByPlatform)) {
      try {
        await this.deliverToPlatform(platform, tokens, notification);
        success += tokens.length;
      } catch {
        failed += tokens.length;
      }
    }

    return { success, failed };
  }

  private async deliverToPlatform(
    platform: string,
    tokens: string[],
    notification: {
      title: string;
      body: string;
      data?: Record<string, string>;
      groupKey?: string;
      category?: string;
      deepLink?: string;
    },
  ): Promise<void> {
    switch (platform) {
      case 'android':
        await this.deliverFCM(tokens, notification);
        break;
      case 'ios':
        await this.deliverAPNs(tokens, notification);
        break;
      case 'web':
        await this.deliverWebPush(tokens, notification);
        break;
    }
  }

  private async deliverFCM(
    tokens: string[],
    notification: {
      title: string;
      body: string;
      data?: Record<string, string>;
      groupKey?: string;
      category?: string;
      deepLink?: string;
    },
  ): Promise<void> {
    if (!this.fcmApiKey) throw new Error('FCM not configured');
    const response = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `key=${this.fcmApiKey}`,
      },
      body: JSON.stringify({
        registration_ids: tokens,
        notification: { title: notification.title, body: notification.body },
        data: {
          ...notification.data,
          groupKey: notification.groupKey,
          category: notification.category,
          deepLink: notification.deepLink,
        },
        android: {
          notification: {
            channelId: notification.category === 'compliance' ? 'critical_alerts' : 'default',
            tag: notification.groupKey,
            priority: notification.category === 'compliance' ? 'high' : 'normal',
          },
        },
        apns: {
          payload: {
            aps: {
              alert: { title: notification.title, body: notification.body },
              badge: 1,
              sound: 'default',
              'thread-id': notification.groupKey,
              category: notification.category,
            },
          },
        },
      }),
    });
  }

  private async deliverAPNs(
    tokens: string[],
    notification: {
      title: string;
      body: string;
      data?: Record<string, string>;
      groupKey?: string;
      category?: string;
      deepLink?: string;
    },
  ): Promise<void> {
    if (!this.apnsKey) throw new Error('APNs not configured');
    for (const token of tokens) {
      await fetch('https://api.push.apple.com/3/device/' + token, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apnsKey}`,
          'apns-push-type': 'alert',
          'apns-topic': 'com.soroban.explorer',
          'apns-priority': '10',
        },
        body: JSON.stringify({
          aps: {
            alert: { title: notification.title, body: notification.body },
            badge: 1,
            sound: 'default',
            'thread-id': notification.groupKey,
            category: notification.category,
            'mutable-content': 1,
          },
          data: {
            ...notification.data,
            groupKey: notification.groupKey,
            category: notification.category,
            deepLink: notification.deepLink,
          },
        }),
      });
    }
  }

  private async deliverWebPush(
    tokens: string[],
    notification: {
      title: string;
      body: string;
      data?: Record<string, string>;
      groupKey?: string;
      category?: string;
      deepLink?: string;
    },
  ): Promise<void> {
    if (!this.vapidKeys) throw new Error('VAPID keys not configured');
    for (const token of tokens) {
      await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `key=${this.fcmApiKey}`,
        },
        body: JSON.stringify({
          to: token,
          notification: { title: notification.title, body: notification.body },
          data: {
            ...notification.data,
            groupKey: notification.groupKey,
            category: notification.category,
            deepLink: notification.deepLink,
          },
        }),
      });
    }
  }

  private logDelivery(delivery: NotificationDelivery): void {
    this.deliveryLog.push(delivery);
    if (this.deliveryLog.length > this.maxDeliveryLog) {
      this.deliveryLog.shift();
    }
  }

  getDeliveryLog(): NotificationDelivery[] {
    return [...this.deliveryLog];
  }

  getAnalytics(): { totalSent: number; totalFailed: number; openRate: number } {
    const totalSent = this.deliveryLog.length;
    const totalFailed = this.deliveryLog.filter((d) => d.error).length;
    return {
      totalSent,
      totalFailed,
      openRate: totalSent > 0 ? (totalSent - totalFailed) / totalSent : 0,
    };
  }
}
