import { describe, it, expect, afterEach } from 'vitest';
import { eventBus } from '../src/events/eventBus';

// Tests exercise the in-process fallback (no Redis is configured in CI, and
// profiles default cacheUrl to memory:// so EVENT_BUS_URL resolves to memory).
afterEach(async () => {
  await eventBus.close();
});

describe('eventBus (in-memory backend)', () => {
  it('reports the memory backend when Redis is not configured', () => {
    expect(eventBus.backendType()).toBe('memory');
    expect(eventBus.isConnected()).toBe(false);
  });

  it('delivers a published message to subscribers exactly once', async () => {
    const received: unknown[] = [];
    eventBus.subscribe('test.event', (msg) => received.push(msg.payload));

    await eventBus.publish('test.event', { value: 42 });

    expect(received).toEqual([{ value: 42 }]);
  });

  it('delivers to multiple listeners for the same event', async () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    eventBus.subscribe('multi', (msg) => a.push(msg.payload));
    eventBus.subscribe('multi', (msg) => b.push(msg.payload));

    await eventBus.publish('multi', 'hello');

    expect(a).toEqual(['hello']);
    expect(b).toEqual(['hello']);
  });

  it('returns an unsubscribe function that stops delivery', async () => {
    const received: unknown[] = [];
    const unsubscribe = eventBus.subscribe('scoped', (msg) => received.push(msg.payload));

    await eventBus.publish('scoped', 1);
    unsubscribe();
    await eventBus.publish('scoped', 2);

    expect(received).toEqual([1]);
  });

  it('returns a message envelope with id, event, payload, and timestamp', async () => {
    const message = await eventBus.publish('envelope', { n: 1 });

    expect(message.id).toBeTruthy();
    expect(message.event).toBe('envelope');
    expect(message.payload).toEqual({ n: 1 });
    expect(message.publishedAt).toBeTruthy();
  });

  it('isolates events by name', async () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    eventBus.subscribe('only.a', (msg) => a.push(msg.payload));
    eventBus.subscribe('only.b', (msg) => b.push(msg.payload));

    await eventBus.publish('only.a', 'x');

    expect(a).toEqual(['x']);
    expect(b).toEqual([]);
  });

  it('close() resolves and stops further delivery', async () => {
    const received: unknown[] = [];
    eventBus.subscribe('closing', (msg) => received.push(msg.payload));
    await eventBus.publish('closing', 1);

    await eventBus.close();
    await eventBus.publish('closing', 2);

    expect(received).toEqual([1]);
  });
});
