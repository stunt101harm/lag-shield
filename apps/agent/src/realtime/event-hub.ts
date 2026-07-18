import { toJsonValue, type Clock, type JsonValue } from '@lagshield/core';

export type RealtimeTopic =
  | 'decision.committed'
  | 'domain-event.committed'
  | 'order.committed'
  | 'proof.updated'
  | 'replay.progress'
  | 'replay.status'
  | 'system.resync-required';

export type RealtimeEvent = Readonly<{
  emittedAtMs: number;
  id: string;
  payload: JsonValue;
  topic: RealtimeTopic;
}>;

type Subscriber = (event: RealtimeEvent) => void;

function sequence(id: string): number {
  if (!/^\d+$/.test(id)) throw new Error('Realtime event IDs must be decimal integers.');
  const value = Number(id);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Realtime event ID is outside the safe integer range.');
  }
  return value;
}

export class RealtimeEventHub {
  readonly #capacity: number;
  readonly #clock: Clock;
  readonly #events: RealtimeEvent[] = [];
  readonly #subscribers = new Set<Subscriber>();
  #nextSequence = 1;

  constructor(dependencies: Readonly<{ capacity?: number; clock: Clock }>) {
    const capacity = dependencies.capacity ?? 1_000;
    if (!Number.isSafeInteger(capacity) || capacity < 10 || capacity > 10_000) {
      throw new Error('Realtime buffer capacity must be from 10 through 10,000.');
    }
    this.#capacity = capacity;
    this.#clock = dependencies.clock;
  }

  publish(topic: Exclude<RealtimeTopic, 'system.resync-required'>, payload: unknown) {
    const event: RealtimeEvent = Object.freeze({
      emittedAtMs: this.#clock.nowMs(),
      id: String(this.#nextSequence),
      payload: toJsonValue(payload),
      topic,
    });
    this.#nextSequence += 1;
    this.#events.push(event);
    if (this.#events.length > this.#capacity) this.#events.shift();
    for (const subscriber of [...this.#subscribers]) {
      try {
        subscriber(event);
      } catch {
        this.#subscribers.delete(subscriber);
      }
    }
    return event;
  }

  subscribe(input: Readonly<{ afterId?: string; onEvent: Subscriber }>): () => void {
    if (input.afterId !== undefined) {
      const after = sequence(input.afterId);
      const oldest = this.#events[0] ? sequence(this.#events[0].id) : this.#nextSequence;
      if (after < oldest - 1) {
        input.onEvent({
          emittedAtMs: this.#clock.nowMs(),
          id: String(this.#nextSequence - 1),
          payload: { oldestAvailableId: String(oldest) },
          topic: 'system.resync-required',
        });
      } else {
        for (const event of this.#events) {
          if (sequence(event.id) > after) input.onEvent(event);
        }
      }
    }
    this.#subscribers.add(input.onEvent);
    return () => this.#subscribers.delete(input.onEvent);
  }

  snapshot(): Readonly<{
    bufferedEventCount: number;
    latestEventId: string | null;
    subscriberCount: number;
  }> {
    return {
      bufferedEventCount: this.#events.length,
      latestEventId: this.#events.at(-1)?.id ?? null,
      subscriberCount: this.#subscribers.size,
    };
  }
}
