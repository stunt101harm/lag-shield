import { FixedClock } from '@lagshield/core';
import { describe, expect, it } from 'vitest';

import { RealtimeEventHub, type RealtimeEvent } from './event-hub.js';

describe('RealtimeEventHub', () => {
  it('resumes strictly after the last seen ID without duplicating events', () => {
    const hub = new RealtimeEventHub({ capacity: 10, clock: new FixedClock(100) });
    hub.publish('domain-event.committed', { eventId: 'one' });
    hub.publish('decision.committed', { decisionId: 'two' });
    const received: RealtimeEvent[] = [];

    const unsubscribe = hub.subscribe({
      afterId: '1',
      onEvent: (event) => received.push(event),
    });
    hub.publish('order.committed', { orderId: 'three' });
    unsubscribe();
    hub.publish('proof.updated', { receiptId: 'four' });

    expect(received.map(({ id }) => id)).toEqual(['2', '3']);
    expect(new Set(received.map(({ id }) => id)).size).toBe(received.length);
    expect(hub.snapshot()).toMatchObject({ subscriberCount: 0 });
  });

  it('requires a full resync when a reconnect cursor fell out of the bounded buffer', () => {
    const hub = new RealtimeEventHub({ capacity: 10, clock: new FixedClock(100) });
    for (let index = 0; index < 12; index += 1) {
      hub.publish('replay.progress', { index });
    }
    const received: RealtimeEvent[] = [];

    hub.subscribe({ afterId: '1', onEvent: (event) => received.push(event) })();

    expect(received).toEqual([
      {
        emittedAtMs: 100,
        id: '12',
        payload: { oldestAvailableId: '3' },
        topic: 'system.resync-required',
      },
    ]);
  });

  it('rejects malformed resume cursors and drops throwing subscribers', () => {
    const hub = new RealtimeEventHub({ clock: new FixedClock(100) });
    expect(() => hub.subscribe({ afterId: 'bad', onEvent: () => undefined })).toThrow(
      'decimal integers',
    );
    hub.subscribe({
      onEvent: () => {
        throw new Error('connection closed');
      },
    });
    hub.publish('replay.status', { status: 'running' });
    expect(hub.snapshot().subscriberCount).toBe(0);
  });
});
