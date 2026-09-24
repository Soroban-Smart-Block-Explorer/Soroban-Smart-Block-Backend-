import { createPubSub } from 'graphql-yoga';
import { eventBus, EventNames } from '../events/eventBus';

const pubSub = createPubSub<{
  TRANSACTION_ADDED: [{ transaction: any }];
  EVENT_EMITTED: [{ event: any }];
  ALERT_TRIGGERED: [{ alert: any }];
}>();

export { pubSub };

export const subscriptionResolvers = {
  transactionAdded: {
    subscribe(_parent: unknown, _args: Record<string, never>) {
      return pubSub.subscribe('TRANSACTION_ADDED');
    },
    resolve(payload: { transaction: any }) {
      return payload.transaction;
    },
  },

  eventEmitted: {
    subscribe(_parent: unknown, _args: Record<string, never>) {
      return pubSub.subscribe('EVENT_EMITTED');
    },
    resolve(payload: { event: any }) {
      return payload.event;
    },
  },

  alertTriggered: {
    subscribe(_parent: unknown, __args: Record<string, never>) {
      return pubSub.subscribe('ALERT_TRIGGERED');
    },
    resolve(payload: { alert: any }) {
      return payload.alert;
    },
  },
};

/**
 * Publish a transaction to every GraphQL instance via the event bus.
 * Each instance's `startGraphqlEventBridge()` fans it out to its local
 * `pubSub` subscribers.
 */
export function publishTransaction(tx: any): void {
  void eventBus.publish(EventNames.GraphqlTransaction, tx);
}

export function publishEvent(event: any): void {
  void eventBus.publish(EventNames.GraphqlEvent, event);
}

export function publishAlert(alert: any): void {
  void eventBus.publish(EventNames.GraphqlAlert, alert);
}

/**
 * Bridge events from the cross-process bus into this process's in-memory
 * graphql-yoga pubSub, so local GraphQL subscribers receive events published
 * by any instance.
 */
export function startGraphqlEventBridge(): void {
  eventBus.subscribe(EventNames.GraphqlTransaction, (message) => {
    pubSub.publish('TRANSACTION_ADDED', { transaction: message.payload });
  });
  eventBus.subscribe(EventNames.GraphqlEvent, (message) => {
    pubSub.publish('EVENT_EMITTED', { event: message.payload });
  });
  eventBus.subscribe(EventNames.GraphqlAlert, (message) => {
    pubSub.publish('ALERT_TRIGGERED', { alert: message.payload });
  });
}
