import { EventEmitter } from 'events';

export type RealtimeTopic = 'ledger' | 'contract_event';

export interface LedgerPayload {
  sequence: number;
  hash: string;
  closeTime: string;
  txCount: number;
}

export interface ContractEventPayload {
  contractId: string;
  eventType: string;
  topics: string[];
  data: string;
  ledgerSequence: number;
  transactionHash: string;
  pagingToken: string;
}

export interface RealtimeMessage<T = LedgerPayload | ContractEventPayload> {
  id: number;
  topic: RealtimeTopic;
  payload: T;
  emittedAt: string;
}

const REPLAY_BUFFER_SIZE = Number(process.env.REALTIME_REPLAY_BUFFER_SIZE ?? 5000);

/**
 * In-process fan-out hub between the indexer and realtime consumers (SSE,
 * alert rules). Messages carry a monotonically increasing id so clients can
 * resume via Last-Event-ID; a bounded ring buffer keeps memory constant.
 */
class RealtimeEventHub extends EventEmitter {
  private seq = 0;
  private buffer: RealtimeMessage[] = [];
  private seenKeys = new Set<string>();
  private keyOrder: string[] = [];

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  /** Publishes a message once per dedup key; returns null for duplicates. */
  publish(topic: RealtimeTopic, payload: RealtimeMessage['payload'], dedupKey: string) {
    if (this.seenKeys.has(dedupKey)) return null;
    this.seenKeys.add(dedupKey);
    this.keyOrder.push(dedupKey);
    if (this.keyOrder.length > REPLAY_BUFFER_SIZE) {
      this.seenKeys.delete(this.keyOrder.shift()!);
    }

    const message: RealtimeMessage = {
      id: ++this.seq,
      topic,
      payload,
      emittedAt: new Date().toISOString(),
    };
    this.buffer.push(message);
    if (this.buffer.length > REPLAY_BUFFER_SIZE) this.buffer.shift();
    this.emit('message', message);
    return message;
  }

  publishLedger(ledger: LedgerPayload) {
    return this.publish('ledger', ledger, `ledger:${ledger.sequence}`);
  }

  publishContractEvent(event: ContractEventPayload) {
    return this.publish('contract_event', event, `event:${event.pagingToken}`);
  }

  /** Buffered messages with id greater than `afterId`, in order. */
  since(afterId: number): RealtimeMessage[] {
    return this.buffer.filter((m) => m.id > afterId);
  }

  subscribe(listener: (message: RealtimeMessage) => void): () => void {
    this.on('message', listener);
    return () => this.off('message', listener);
  }

  /** Test helper: clears buffered state. */
  reset() {
    this.seq = 0;
    this.buffer = [];
    this.seenKeys.clear();
    this.keyOrder = [];
    this.removeAllListeners('message');
  }
}

export const realtimeHub = new RealtimeEventHub();
