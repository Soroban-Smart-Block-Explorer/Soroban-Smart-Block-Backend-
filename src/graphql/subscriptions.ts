import { setMaxListeners } from 'events';
import { createPubSub, filter, pipe } from 'graphql-yoga';
import type { Request } from 'express';
import { eventBus, EventNames } from '../events/eventBus';
import { featureFlags } from '../feature-flags';
import { logger } from '../logger';
import {
  CONTRACT_ACTIVITY_KINDS,
  LedgerHeadTracker,
  SubscriptionErrorCode,
  SubscriptionLimiter,
  gqlSubscriptionAdmissions,
  gqlSubscriptionBridgeDuration,
  gqlSubscriptionDropped,
  gqlSubscriptionMessages,
  matchesAlert,
  matchesContractActivity,
  matchesEvent,
  matchesTransaction,
  subscriptionError,
  toLedgerHead,
  toSubscriptionAlert,
  toSubscriptionEvent,
  toSubscriptionTransaction,
  validateAccountAddress,
  validateContractAddress,
  validateToken,
  withRelease,
  type ContractActivity,
  type ContractActivityKind,
  type LedgerHead,
  type SubscriptionAlert,
  type SubscriptionEvent,
  type SubscriptionTopic,
  type SubscriptionTransaction,
} from './subscriptionGateway';

// Contract-scoped messages are published twice: once on the plain topic (for
// unfiltered subscribers) and once on a *_BY_CONTRACT topic keyed by contract
// address, so a contract-filtered subscriber only ever receives its own
// contract's messages (routing cost O(matching subscribers), not O(all)).
type PubSubChannels = {
  TRANSACTION_ADDED: [{ transaction: SubscriptionTransaction }];
  TRANSACTION_BY_CONTRACT: [contract: string, { transaction: SubscriptionTransaction }];
  EVENT_EMITTED: [{ event: SubscriptionEvent }];
  EVENT_BY_CONTRACT: [contract: string, { event: SubscriptionEvent }];
  ALERT_TRIGGERED: [{ alert: SubscriptionAlert }];
  LEDGER_HEAD: [{ ledgerHead: LedgerHead }];
  CONTRACT_ACTIVITY: [contract: string, { contractActivity: ContractActivity }];
};

// Thousands of streams legitimately listen on one topic; lift Node's default
// 10-listener leak warning for this target (leaks are detected by the soak
// test's slot/heap budgets instead).
const pubSubTarget = new EventTarget();
setMaxListeners(0, pubSubTarget);
const pubSub = createPubSub<PubSubChannels>({ eventTarget: pubSubTarget });

export { pubSub };

export const subscriptionLimiter = new SubscriptionLimiter();
export const ledgerHeadTracker = new LedgerHeadTracker();

interface SubscriptionContext {
  req?: Pick<Request, 'ip'> & { apiKey?: { id?: string; developerId?: string } };
}

export interface SubscriptionDeps {
  pubSub: typeof pubSub;
  limiter: SubscriptionLimiter;
  isEnabled: (developerId?: string) => boolean;
}

function clientKey(ctx: SubscriptionContext | undefined): string {
  const apiKeyId = ctx?.req?.apiKey?.id;
  if (apiKeyId) return `key:${apiKeyId}`;
  return `ip:${ctx?.req?.ip ?? 'unknown'}`;
}

function admit(
  deps: SubscriptionDeps,
  ctx: SubscriptionContext | undefined,
  topic: SubscriptionTopic,
): () => void {
  const developerId = ctx?.req?.apiKey?.developerId;
  if (!deps.isEnabled(developerId)) {
    gqlSubscriptionAdmissions.inc({ topic, outcome: 'rejected_disabled' });
    throw subscriptionError(
      SubscriptionErrorCode.Disabled,
      'GraphQL subscriptions are currently disabled; use /api/v1/feed/sse or poll the query API',
      { fallback: '/api/v1/feed/sse' },
    );
  }
  return deps.limiter.acquire(clientKey(ctx), topic);
}

function rejectInvalid(topic: SubscriptionTopic, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    gqlSubscriptionAdmissions.inc({ topic, outcome: 'rejected_invalid' });
    throw err;
  }
}

export function createSubscriptionResolvers(deps: SubscriptionDeps) {
  return {
    transactionAdded: {
      subscribe(
        _parent: unknown,
        args: { contract?: string | null; account?: string | null },
        ctx: SubscriptionContext,
      ) {
        let f: { contract?: string; account?: string } = {};
        rejectInvalid('transactionAdded', () => {
          f = {
            contract: validateContractAddress('contract', args.contract),
            account: validateAccountAddress('account', args.account),
          };
        });
        const release = admit(deps, ctx, 'transactionAdded');
        return withRelease(
          pipe(
            f.contract
              ? deps.pubSub.subscribe('TRANSACTION_BY_CONTRACT', f.contract)
              : deps.pubSub.subscribe('TRANSACTION_ADDED'),
            filter((p: { transaction: SubscriptionTransaction }) =>
              matchesTransaction(p.transaction, f),
            ),
          ),
          release,
        );
      },
      resolve(payload: { transaction: SubscriptionTransaction }) {
        return payload.transaction;
      },
    },

    eventEmitted: {
      subscribe(
        _parent: unknown,
        args: { contract?: string | null; eventType?: string | null; topic?: string | null },
        ctx: SubscriptionContext,
      ) {
        let f: { contract?: string; eventType?: string; topic?: string } = {};
        rejectInvalid('eventEmitted', () => {
          f = {
            contract: validateContractAddress('contract', args.contract),
            eventType: validateToken('eventType', args.eventType),
            topic: validateToken('topic', args.topic),
          };
        });
        const release = admit(deps, ctx, 'eventEmitted');
        return withRelease(
          pipe(
            f.contract
              ? deps.pubSub.subscribe('EVENT_BY_CONTRACT', f.contract)
              : deps.pubSub.subscribe('EVENT_EMITTED'),
            filter((p: { event: SubscriptionEvent }) => matchesEvent(p.event, f)),
          ),
          release,
        );
      },
      resolve(payload: { event: SubscriptionEvent }) {
        return payload.event;
      },
    },

    alertTriggered: {
      subscribe(_parent: unknown, args: { severity?: string | null }, ctx: SubscriptionContext) {
        let severity: string | undefined;
        rejectInvalid('alertTriggered', () => {
          severity = validateToken('severity', args.severity);
        });
        const release = admit(deps, ctx, 'alertTriggered');
        return withRelease(
          pipe(
            deps.pubSub.subscribe('ALERT_TRIGGERED'),
            filter((p: { alert: SubscriptionAlert }) => matchesAlert(p.alert, severity)),
          ),
          release,
        );
      },
      resolve(payload: { alert: SubscriptionAlert }) {
        return payload.alert;
      },
    },

    ledgerHead: {
      subscribe(_parent: unknown, _args: Record<string, never>, ctx: SubscriptionContext) {
        const release = admit(deps, ctx, 'ledgerHead');
        return withRelease(deps.pubSub.subscribe('LEDGER_HEAD'), release);
      },
      resolve(payload: { ledgerHead: LedgerHead }) {
        return payload.ledgerHead;
      },
    },

    contractActivity: {
      subscribe(
        _parent: unknown,
        args: { address: string; kinds?: ContractActivityKind[] | null },
        ctx: SubscriptionContext,
      ) {
        let address = '';
        let kinds: readonly ContractActivityKind[] = CONTRACT_ACTIVITY_KINDS;
        rejectInvalid('contractActivity', () => {
          address = validateContractAddress('address', args.address) ?? '';
          if (!address) {
            throw subscriptionError(SubscriptionErrorCode.InvalidArgument, 'address is required', {
              field: 'address',
            });
          }
          if (args.kinds && args.kinds.length > 0) kinds = args.kinds;
        });
        const release = admit(deps, ctx, 'contractActivity');
        return withRelease(
          pipe(
            deps.pubSub.subscribe('CONTRACT_ACTIVITY', address),
            filter((p: { contractActivity: ContractActivity }) =>
              matchesContractActivity(p.contractActivity, address, kinds),
            ),
          ),
          release,
        );
      },
      resolve(payload: { contractActivity: ContractActivity }) {
        return payload.contractActivity;
      },
    },
  };
}

export const subscriptionResolvers = createSubscriptionResolvers({
  pubSub,
  limiter: subscriptionLimiter,
  isEnabled: (developerId) => featureFlags.isEnabledSync('graphqlSubscriptions', { developerId }),
});

// ── Feed bridge ───────────────────────────────────────────────────────────────

function dropped(reason: string, channel: string): false {
  gqlSubscriptionDropped.inc({ reason });
  logger.warn('[graphql-subscriptions] dropped feed message', { reason, channel });
  return false;
}

function publishHead(head: LedgerHead, target: typeof pubSub): void {
  const next = ledgerHeadTracker.observe(head);
  if (next) {
    target.publish('LEDGER_HEAD', { ledgerHead: next });
    gqlSubscriptionMessages.inc({ topic: 'ledgerHead' });
  }
}

/**
 * Validate one realtime message and fan it out to the GraphQL topics it feeds.
 * Returns true when the message was published, false when it was dropped.
 * Never throws: a corrupt or unexpected message must not break the bus.
 */
export function bridgeRealtimeMessage(
  channel: string,
  data: unknown,
  target: typeof pubSub = pubSub,
): boolean {
  const stop = gqlSubscriptionBridgeDuration.startTimer();
  try {
    switch (channel) {
      case 'transactions': {
        const tx = toSubscriptionTransaction(data);
        if (!tx) return dropped('invalid_payload', channel);
        target.publish('TRANSACTION_ADDED', { transaction: tx });
        gqlSubscriptionMessages.inc({ topic: 'transactionAdded' });
        if (tx.contractAddress) {
          target.publish('TRANSACTION_BY_CONTRACT', tx.contractAddress, { transaction: tx });
          target.publish('CONTRACT_ACTIVITY', tx.contractAddress, {
            contractActivity: {
              kind: 'TRANSACTION',
              contractAddress: tx.contractAddress,
              ledgerSequence: tx.ledgerSequence,
              occurredAt: tx.ledgerCloseTime,
              transaction: tx,
              event: null,
            },
          });
          gqlSubscriptionMessages.inc({ topic: 'contractActivity' });
        }
        publishHead(
          {
            sequence: tx.ledgerSequence,
            closeTime: tx.ledgerCloseTime,
            hash: null,
            txCount: null,
            source: 'DERIVED',
          },
          target,
        );
        return true;
      }
      case 'events': {
        const ev = toSubscriptionEvent(data);
        if (!ev) return dropped('invalid_payload', channel);
        target.publish('EVENT_EMITTED', { event: ev });
        target.publish('EVENT_BY_CONTRACT', ev.contractAddress, { event: ev });
        gqlSubscriptionMessages.inc({ topic: 'eventEmitted' });
        target.publish('CONTRACT_ACTIVITY', ev.contractAddress, {
          contractActivity: {
            kind: 'EVENT',
            contractAddress: ev.contractAddress,
            ledgerSequence: ev.ledgerSequence,
            occurredAt: ev.ledgerCloseTime,
            transaction: null,
            event: ev,
          },
        });
        gqlSubscriptionMessages.inc({ topic: 'contractActivity' });
        publishHead(
          {
            sequence: ev.ledgerSequence,
            closeTime: ev.ledgerCloseTime,
            hash: null,
            txCount: null,
            source: 'DERIVED',
          },
          target,
        );
        return true;
      }
      case 'ledgers': {
        const head = toLedgerHead(data);
        if (!head) return dropped('invalid_payload', channel);
        publishHead(head, target);
        return true;
      }
      case 'alerts': {
        const alert = toSubscriptionAlert(data);
        if (!alert) return dropped('invalid_payload', channel);
        target.publish('ALERT_TRIGGERED', { alert });
        gqlSubscriptionMessages.inc({ topic: 'alertTriggered' });
        return true;
      }
      default:
        // Other feed channels (trades, metrics, …) have no GraphQL topic.
        return false;
    }
  } catch (err) {
    gqlSubscriptionDropped.inc({ reason: 'handler_error' });
    logger.error('[graphql-subscriptions] bridge handler failed', {
      channel,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    stop();
  }
}

/**
 * Publish a transaction to every GraphQL instance via the event bus.
 * Each instance's `startGraphqlEventBridge()` fans it out to its local
 * `pubSub` subscribers.
 */
export function publishTransaction(tx: unknown): void {
  void eventBus.publish(EventNames.GraphqlTransaction, tx);
}

export function publishEvent(event: unknown): void {
  void eventBus.publish(EventNames.GraphqlEvent, event);
}

export function publishAlert(alert: unknown): void {
  void eventBus.publish(EventNames.GraphqlAlert, alert);
}

let bridgeUnsubscribers: Array<() => void> = [];

/**
 * Bridge events from the cross-process bus into this process's in-memory
 * graphql-yoga pubSub, so local GraphQL subscribers receive events published
 * by any instance. Two sources feed the bridge:
 *
 *  - `feed.message` — the realtime feed that also drives /api/v1/feed/sse and
 *    the feed WebSocket (transactions, events, ledgers channels);
 *  - the direct `graphql.*` events (publishTransaction/Event/Alert).
 *
 * Idempotent: calling it twice does not double-deliver.
 */
export function startGraphqlEventBridge(): void {
  if (bridgeUnsubscribers.length > 0) return;
  bridgeUnsubscribers = [
    eventBus.subscribe(EventNames.FeedMessage, (message) => {
      const payload = message.payload as { channelName?: unknown; data?: unknown } | null;
      if (!payload || typeof payload.channelName !== 'string') {
        dropped('malformed_envelope', 'feed.message');
        return;
      }
      bridgeRealtimeMessage(payload.channelName, payload.data);
    }),
    eventBus.subscribe(EventNames.GraphqlTransaction, (message) => {
      bridgeRealtimeMessage('transactions', message.payload);
    }),
    eventBus.subscribe(EventNames.GraphqlEvent, (message) => {
      bridgeRealtimeMessage('events', message.payload);
    }),
    eventBus.subscribe(EventNames.GraphqlAlert, (message) => {
      bridgeRealtimeMessage('alerts', message.payload);
    }),
  ];
  logger.info('[graphql-subscriptions] event bridge started');
}

export function stopGraphqlEventBridge(): void {
  for (const unsubscribe of bridgeUnsubscribers) unsubscribe();
  bridgeUnsubscribers = [];
}
