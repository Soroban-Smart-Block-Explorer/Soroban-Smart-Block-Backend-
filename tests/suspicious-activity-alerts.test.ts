import { describe, it, expect } from 'vitest';
import {
  SuspiciousActivityAlertService,
  type AlertSink,
  type IndexedActivity,
  type SuspiciousAlert,
  fromIndexedEvent,
} from '../src/services/suspiciousActivityAlerts';

class RecordingSink implements AlertSink {
  readonly name = 'recording';
  alerts: SuspiciousAlert[] = [];

  deliver(alert: SuspiciousAlert): void {
    this.alerts.push(alert);
  }
}

const MINUTE = 60_000;

function makeService(nowRef: { value: number }) {
  const sink = new RecordingSink();
  const service = new SuspiciousActivityAlertService({
    sinks: [sink],
    now: () => nowRef.value,
  });
  return { service, sink };
}

function activity(overrides: Partial<IndexedActivity> & { timestamp: Date }): IndexedActivity {
  return {
    id: overrides.id ?? `a_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'event',
    ...overrides,
  } as IndexedActivity;
}

describe('SuspiciousActivityAlertService — rule registry', () => {
  it('registers the four built-in rules with sensible defaults', () => {
    const { service } = makeService({ value: 0 });
    const rules = service.listRules();
    const ids = rules.map((r) => r.id).sort();

    expect(ids).toEqual(
      ['rapid_value_movement', 'unusual_approval', 'velocity_anomaly', 'wash_trading'].sort(),
    );
    expect(rules.every((r) => r.defaultEnabled)).toBe(true);
  });

  it('resolves defaults for an unconfigured tenant', () => {
    const { service } = makeService({ value: 0 });
    const config = service.getTenantConfig('tenant-a');

    expect(config.rules.rapid_value_movement.enabled).toBe(true);
    expect(config.rules.wash_trading.cooldownMs).toBe(600_000);
    expect(config.webhookUrls).toEqual([]);
  });
});

describe('rapid_value_movement', () => {
  it('fires when several large movements leave one account in a short window', async () => {
    const nowRef = { value: 0 };
    const { service } = makeService(nowRef);

    for (let i = 0; i < 3; i++) {
      nowRef.value = i * 1000;
      await service.ingest(
        activity({ sourceAccount: 'G_A', amount: 40_000, timestamp: new Date(nowRef.value) }),
      );
    }

    const alerts = service.getRecentAlerts(10, 'default');
    const burst = alerts.find((a) => a.ruleId === 'rapid_value_movement');
    expect(burst).toBeDefined();
    expect(burst!.evidence.total).toBe(120_000);
  });

  it('does not fire for small movements', async () => {
    const nowRef = { value: 0 };
    const { service } = makeService(nowRef);

    for (let i = 0; i < 5; i++) {
      nowRef.value = i * 1000;
      await service.ingest(
        activity({ sourceAccount: 'G_B', amount: 10, timestamp: new Date(nowRef.value) }),
      );
    }

    expect(service.getRecentAlerts(10, 'default')).toHaveLength(0);
  });

  it('fires on a single very large movement', async () => {
    const nowRef = { value: 0 };
    const { service } = makeService(nowRef);

    await service.ingest(
      activity({ sourceAccount: 'G_C', amount: 500_000, timestamp: new Date(nowRef.value) }),
    );

    const alert = service.getRecentAlerts(10, 'default')[0];
    expect(alert.ruleId).toBe('rapid_value_movement');
    expect(alert.evidence.kind).toBe('single');
  });
});

describe('unusual_approval', () => {
  it('flags unlimited approvals', async () => {
    const nowRef = { value: 0 };
    const { service } = makeService(nowRef);

    await service.ingest(
      activity({
        eventType: 'approve',
        sourceAccount: 'G_OWNER',
        decoded: { spender: 'G_SPENDER', unlimited: true },
        timestamp: new Date(nowRef.value),
      }),
    );

    const alert = service.getRecentAlerts(10, 'default')[0];
    expect(alert.ruleId).toBe('unusual_approval');
    expect(alert.severity).toBe('high');
    expect(alert.evidence.unlimited).toBe(true);
  });

  it('flags self-approvals', async () => {
    const nowRef = { value: 0 };
    const { service } = makeService(nowRef);

    await service.ingest(
      activity({
        eventType: 'approve',
        sourceAccount: 'G_SELF',
        decoded: { spender: 'G_SELF', amount: 10 },
        timestamp: new Date(nowRef.value),
      }),
    );

    const alert = service.getRecentAlerts(10, 'default')[0];
    expect(alert.title).toMatch(/self-approval/i);
  });
});

describe('wash_trading', () => {
  it('flags self-trades as critical', async () => {
    const nowRef = { value: 0 };
    const { service } = makeService(nowRef);

    await service.ingest(
      activity({
        eventType: 'swap',
        sourceAccount: 'G_A',
        destinationAccount: 'G_A',
        timestamp: new Date(nowRef.value),
      }),
    );

    const alert = service.getRecentAlerts(10, 'default')[0];
    expect(alert.ruleId).toBe('wash_trading');
    expect(alert.severity).toBe('critical');
  });

  it('flags round-trips between two wallets', async () => {
    const nowRef = { value: 0 };
    const { service } = makeService(nowRef);

    await service.ingest(
      activity({
        eventType: 'swap',
        sourceAccount: 'G_A',
        destinationAccount: 'G_B',
        timestamp: new Date(nowRef.value),
      }),
    );
    nowRef.value = 1000;
    await service.ingest(
      activity({
        eventType: 'swap',
        sourceAccount: 'G_B',
        destinationAccount: 'G_A',
        timestamp: new Date(nowRef.value),
      }),
    );

    const roundTrip = service
      .getRecentAlerts(10, 'default')
      .find((a) => a.ruleId === 'wash_trading' && a.evidence.roundTripId);
    expect(roundTrip).toBeDefined();
  });
});

describe('velocity_anomaly', () => {
  it('flags a statistically abnormal burst of activity', async () => {
    const nowRef = { value: 0 };
    const sink = new RecordingSink();
    const service = new SuspiciousActivityAlertService({
      sinks: [sink],
      now: () => nowRef.value,
      windowMs: 30 * MINUTE,
    });

    // Baseline: varying activity across four minutes (counts 1,2,1,2).
    const baseline = [1, 2, 1, 2];
    baseline.forEach((count, minute) => {
      for (let i = 0; i < count; i++) {
        nowRef.value = minute * MINUTE + i * 100;
        void service.ingest(
          activity({ sourceAccount: 'G_SPIKE', timestamp: new Date(nowRef.value) }),
        );
      }
    });

    // Current minute: an abnormal burst of 5.
    for (let i = 0; i < 5; i++) {
      nowRef.value = 4 * MINUTE + i * 100;
      await service.ingest(
        activity({ sourceAccount: 'G_SPIKE', timestamp: new Date(nowRef.value) }),
      );
    }

    const anomaly = service
      .getRecentAlerts(20, 'default')
      .find((a) => a.ruleId === 'velocity_anomaly');
    expect(anomaly).toBeDefined();
    expect(anomaly!.evidence.zScore as number).toBeGreaterThanOrEqual(3);
  });
});

describe('dedupe + throttling', () => {
  it('collapses duplicate detections and then applies the cooldown', async () => {
    const nowRef = { value: 0 };
    const { service } = makeService(nowRef);

    const approval = () =>
      activity({
        eventType: 'approve',
        sourceAccount: 'G_OWNER',
        decoded: { spender: 'G_SPENDER', unlimited: true },
        timestamp: new Date(nowRef.value),
      });

    await service.ingest(approval());
    await service.ingest(approval());
    expect(service.getRecentAlerts(10, 'default')).toHaveLength(1);

    // Past the dedupe window but still inside the 5-minute cooldown.
    nowRef.value += 31_000;
    await service.ingest(approval());
    expect(service.getRecentAlerts(10, 'default')).toHaveLength(1);

    // Past the cooldown.
    nowRef.value += 300_000;
    await service.ingest(approval());
    expect(service.getRecentAlerts(10, 'default')).toHaveLength(2);
  });
});

describe('per-tenant configuration', () => {
  it('disables a rule for one tenant without affecting another', async () => {
    const nowRef = { value: 0 };
    const { service } = makeService(nowRef);

    service.setTenantConfig('tenant-a', {
      rules: { rapid_value_movement: { enabled: false } },
    });

    nowRef.value = 0;
    const a = await service.ingest(
      activity({ sourceAccount: 'G_X', amount: 500_000, timestamp: new Date(0) }),
      'tenant-a',
    );
    expect(a).toHaveLength(0);

    nowRef.value = 1000;
    const b = await service.ingest(
      activity({ sourceAccount: 'G_Y', amount: 500_000, timestamp: new Date(1000) }),
      'tenant-b',
    );
    expect(b).toHaveLength(1);
  });

  it('drops signals below the configured minimum severity', async () => {
    const nowRef = { value: 0 };
    const { service } = makeService(nowRef);

    service.setTenantConfig('tenant-c', {
      rules: { rapid_value_movement: { minSeverity: 'critical' } },
    });

    const alerts = await service.ingest(
      activity({ sourceAccount: 'G_Z', amount: 500_000, timestamp: new Date(0) }),
      'tenant-c',
    );

    expect(alerts).toHaveLength(0);
  });

  it('resetTenantConfig restores defaults', () => {
    const { service } = makeService({ value: 0 });
    service.setTenantConfig('tenant-d', {
      rules: { unusual_approval: { enabled: false } },
    });
    expect(service.getTenantConfig('tenant-d').rules.unusual_approval.enabled).toBe(false);

    service.resetTenantConfig('tenant-d');
    expect(service.getTenantConfig('tenant-d').rules.unusual_approval.enabled).toBe(true);
  });
});

describe('sinks', () => {
  it('delivers to registered sinks and the in-app inbox', async () => {
    const nowRef = { value: 0 };
    const { service, sink } = makeService(nowRef);

    await service.ingest(
      activity({ sourceAccount: 'G_SINK', amount: 500_000, timestamp: new Date(0) }),
    );

    expect(sink.alerts).toHaveLength(1);
    expect(service.getInbox('default')).toHaveLength(1);
    expect(service.listSinks()).toContain('inApp');
  });
});

describe('fromIndexedEvent', () => {
  it('maps a persisted event row to a normalised activity', () => {
    const mapped = fromIndexedEvent({
      id: 'evt-1',
      transactionHash: 'tx-1',
      contractAddress: 'C_1',
      eventType: 'approve',
      topicSymbol: 'approve',
      decoded: { spender: 'G_SPENDER', amount: 10 },
      ledgerSequence: 42,
      ledgerCloseTime: new Date(1000),
    });

    expect(mapped.id).toBe('evt-1');
    expect(mapped.spender).toBe('G_SPENDER');
    expect(mapped.amount).toBe(10);
    expect(mapped.timestamp.getTime()).toBe(1000);
  });
});
