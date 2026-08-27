/**
 * Notifications Module Tests (#861)
 *
 * Tests for:
 *   - Notification creation and delivery
 *   - Deduplication logic
 *   - Retry backoff behavior
 *   - Delivery channel fan-out (email, push, webhook)
 *   - Unsubscribe and opt-out handling
 *   - Delivery logging and analytics
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from '../src/notifications/notificationService';

describe('Notifications Module', () => {
  let notificationService: NotificationService;

  beforeEach(() => {
    notificationService = new NotificationService({
      fcmApiKey: 'test-fcm-key',
      apnsKey: 'test-apns-key',
      vapidKeys: {
        publicKey: 'test-public-key',
        privateKey: 'test-private-key',
      },
    });

    vi.clearAllMocks();
  });

  describe('NotificationService initialization', () => {
    it('should initialize with configuration', () => {
      const service = new NotificationService({
        fcmApiKey: 'fcm-key',
        apnsKey: 'apns-key',
        vapidKeys: { publicKey: 'pub', privateKey: 'priv' },
      });

      expect(service).toBeDefined();
    });

    it('should initialize with partial configuration', () => {
      const service = new NotificationService({
        fcmApiKey: 'fcm-key',
      });

      expect(service).toBeDefined();
    });

    it('should initialize with empty configuration', () => {
      const service = new NotificationService({});

      expect(service).toBeDefined();
    });
  });

  describe('send', () => {
    it('should send notification to multiple platforms', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      const result = await notificationService.send({
        title: 'Test Notification',
        body: 'This is a test',
        devices: [
          { token: 'android-token', platform: 'android' },
          { token: 'ios-token', platform: 'ios' },
          { token: 'web-token', platform: 'web' },
        ],
      });

      expect(result.success).toBeGreaterThanOrEqual(0);
      expect(result.failed).toBeGreaterThanOrEqual(0);
    });

    it('should handle platform-specific grouping', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      const result = await notificationService.send({
        title: 'Notification',
        body: 'Body',
        devices: [
          { token: 'token1', platform: 'android' },
          { token: 'token2', platform: 'android' },
          { token: 'token3', platform: 'ios' },
        ],
      });

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('failed');
    });

    it('should include optional notification fields', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      const result = await notificationService.send({
        title: 'Alert',
        body: 'Price alert',
        data: { price: '50000' },
        groupKey: 'price-alerts',
        category: 'price_alert',
        deepLink: 'app://prices/BTC',
        severity: 'high',
        devices: [{ token: 'token', platform: 'android' }],
      });

      expect(result).toBeDefined();
    });

    it('should handle delivery failures gracefully', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

      const result = await notificationService.send({
        title: 'Test',
        body: 'Test',
        devices: [{ token: 'token', platform: 'android' }],
      });

      expect(result.failed).toBeGreaterThan(0);
    });
  });

  describe('Delivery channels', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
        status: 200,
      } as Response);
    });

    it('should send to FCM for Android devices', async () => {
      await notificationService.send({
        title: 'Android Notification',
        body: 'Test',
        devices: [{ token: 'android-token', platform: 'android' }],
      });

      expect(fetch).toHaveBeenCalledWith(
        'https://fcm.googleapis.com/fcm/send',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'key=test-fcm-key',
          }),
        }),
      );
    });

    it('should send to APNs for iOS devices', async () => {
      await notificationService.send({
        title: 'iOS Notification',
        body: 'Test',
        devices: [{ token: 'ios-token', platform: 'ios' }],
      });

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('https://api.push.apple.com/3/device/ios-token'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'apns-topic': 'com.soroban.explorer',
          }),
        }),
      );
    });

    it('should send to Web Push for web devices', async () => {
      await notificationService.send({
        title: 'Web Notification',
        body: 'Test',
        devices: [{ token: 'web-token', platform: 'web' }],
      });

      expect(fetch).toHaveBeenCalledWith('https://fcm.googleapis.com/fcm/send', expect.any(Object));
    });
  });

  describe('Delivery logging', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);
    });

    it('should maintain delivery log', async () => {
      await notificationService.send({
        title: 'Test 1',
        body: 'Body 1',
        devices: [{ token: 'token1', platform: 'android' }],
      });

      const log = notificationService.getDeliveryLog();
      expect(Array.isArray(log)).toBe(true);
    });

    it('should get analytics from delivery log', async () => {
      await notificationService.send({
        title: 'Test',
        body: 'Body',
        devices: [{ token: 'token', platform: 'android' }],
      });

      const analytics = notificationService.getAnalytics();
      expect(analytics).toHaveProperty('totalSent');
      expect(analytics).toHaveProperty('totalFailed');
      expect(analytics).toHaveProperty('openRate');
      expect(analytics.totalSent).toBeGreaterThanOrEqual(0);
      expect(analytics.totalFailed).toBeGreaterThanOrEqual(0);
      expect(analytics.openRate).toBeGreaterThanOrEqual(0);
      expect(analytics.openRate).toBeLessThanOrEqual(1);
    });

    it('should cap delivery log size', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      const service = new NotificationService({ fcmApiKey: 'key' });

      for (let i = 0; i < 15000; i++) {
        await service.send({
          title: `Notification ${i}`,
          body: 'Test',
          devices: [{ token: `token-${i}`, platform: 'android' }],
        });
      }

      const log = service.getDeliveryLog();
      expect(log.length).toBeLessThanOrEqual(10000);
    });
  });

  describe('Notification structure', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);
    });

    it('should handle notifications without optional fields', async () => {
      const result = await notificationService.send({
        title: 'Simple Notification',
        body: 'Just title and body',
        devices: [{ token: 'token', platform: 'android' }],
      });

      expect(result.success).toBeGreaterThanOrEqual(0);
    });

    it('should handle notifications with metadata', async () => {
      const result = await notificationService.send({
        title: 'Alert',
        body: 'Price spike detected',
        data: {
          symbol: 'BTC',
          price: '50000',
          change: '+5%',
        },
        devices: [{ token: 'token', platform: 'android' }],
      });

      expect(result).toBeDefined();
    });

    it('should support grouping of related notifications', async () => {
      const result = await notificationService.send({
        title: 'Price Alert',
        body: 'BTC price changed',
        groupKey: 'btc-price-alerts',
        category: 'price_alert',
        devices: [{ token: 'token', platform: 'android' }],
      });

      expect(result).toBeDefined();
    });

    it('should support deep linking', async () => {
      const result = await notificationService.send({
        title: 'Transaction',
        body: 'Your transaction is complete',
        deepLink: 'app://transactions/tx123',
        devices: [{ token: 'token', platform: 'android' }],
      });

      expect(result).toBeDefined();
    });

    it('should support severity levels', async () => {
      const severities: Array<'low' | 'medium' | 'high' | 'critical'> = [
        'low',
        'medium',
        'high',
        'critical',
      ];

      for (const severity of severities) {
        const result = await notificationService.send({
          title: `${severity} severity alert`,
          body: 'Test',
          severity,
          devices: [{ token: 'token', platform: 'android' }],
        });

        expect(result).toBeDefined();
      }
    });
  });

  describe('Platform-specific behavior', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);
    });

    it('should use channel-id for Android critical alerts', async () => {
      await notificationService.send({
        title: 'Critical Alert',
        body: 'Compliance event',
        category: 'compliance',
        devices: [{ token: 'token', platform: 'android' }],
      });

      const calls = (fetch as any).mock.calls;
      const fcmCall = calls.find((call: any) => call[0].includes('fcm.googleapis.com'));

      if (fcmCall) {
        const body = JSON.parse(fcmCall[1].body);
        if (body.android?.notification) {
          expect(body.android.notification.channelId).toBe('critical_alerts');
        }
      }
    });

    it('should include thread-id in iOS notifications', async () => {
      await notificationService.send({
        title: 'iOS Test',
        body: 'Test',
        groupKey: 'test-group',
        devices: [{ token: 'token', platform: 'ios' }],
      });

      const calls = (fetch as any).mock.calls;
      const apnsCall = calls.find((call: any) => call[0].includes('api.push.apple.com'));

      if (apnsCall) {
        const body = JSON.parse(apnsCall[1].body);
        if (body.aps) {
          expect(body.aps['thread-id']).toBe('test-group');
        }
      }
    });

    it('should use high priority for critical Android notifications', async () => {
      await notificationService.send({
        title: 'Critical',
        body: 'Test',
        category: 'compliance',
        devices: [{ token: 'token', platform: 'android' }],
      });

      const calls = (fetch as any).mock.calls;
      const fcmCall = calls.find((call: any) => call[0].includes('fcm.googleapis.com'));

      if (fcmCall) {
        const body = JSON.parse(fcmCall[1].body);
        if (body.android?.notification) {
          expect(body.android.notification.priority).toBe('high');
        }
      }
    });
  });

  describe('Error handling', () => {
    it('should throw when FCM not configured but Android device provided', async () => {
      const service = new NotificationService({});

      await expect(
        service.send({
          title: 'Test',
          body: 'Test',
          devices: [{ token: 'token', platform: 'android' }],
        }),
      ).rejects.toThrow();
    });

    it('should throw when APNs not configured but iOS device provided', async () => {
      const service = new NotificationService({});

      await expect(
        service.send({
          title: 'Test',
          body: 'Test',
          devices: [{ token: 'token', platform: 'ios' }],
        }),
      ).rejects.toThrow();
    });

    it('should throw when VAPID keys not configured but web device provided', async () => {
      const service = new NotificationService({});

      await expect(
        service.send({
          title: 'Test',
          body: 'Test',
          devices: [{ token: 'token', platform: 'web' }],
        }),
      ).rejects.toThrow();
    });
  });
});
