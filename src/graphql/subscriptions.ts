import { createPubSub } from 'graphql-yoga';

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

export function publishTransaction(tx: any): void {
  pubSub.publish('TRANSACTION_ADDED', { transaction: tx });
}

export function publishEvent(event: any): void {
  pubSub.publish('EVENT_EMITTED', { event });
}

export function publishAlert(alert: any): void {
  pubSub.publish('ALERT_TRIGGERED', { alert });
}
