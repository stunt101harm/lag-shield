import { describe, expect, it } from 'vitest';

import {
  buildDecisionIdempotencyKey,
  canonicalJson,
  compareEventOrder,
  createNormalizedEvent,
  FixedClock,
  normalizedDomainEventSchema,
  SequenceIdGenerator,
  stableHash,
  type NormalizedEventInput,
} from './index.js';

type ScoreEventInput = Extract<NormalizedEventInput, { kind: 'score.observed' }>;
type ScoreEventOverrides = Partial<
  Pick<
    ScoreEventInput,
    'receivedAtMs' | 'sequence' | 'source' | 'sourceId' | 'sourceTimestampMs'
  >
>;

function scoreEvent(overrides: ScoreEventOverrides = {}) {
  return createNormalizedEvent({
    fixtureId: 'fixture-1',
    kind: 'score.observed',
    payload: {
      action: 'goal',
      awayScore: 0,
      fixtureId: 'fixture-1',
      homeScore: 1,
      period: 2,
      stats: [
        { key: 1, period: 0, value: 1 },
        { key: 2, period: 0, value: 0 },
      ],
      statusId: 2,
    },
    payloadVersion: 1,
    receivedAtMs: 2_000,
    sequence: 7,
    source: 'txline-live',
    sourceId: 'fixture-1:7',
    sourceTimestampMs: 1_000,
    ...overrides,
  });
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((tail) => [
      item,
      ...tail,
    ]),
  );
}

describe('deterministic domain events', () => {
  it('canonicalizes object keys and hashes equal JSON identically', () => {
    const left = { alpha: [1, true], beta: { x: 'value' } };
    const right = { beta: { x: 'value' }, alpha: [1, true] };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(stableHash(left)).toBe(stableHash(right));
  });

  it('reprocessing a source record keeps identity stable across receive times', () => {
    const first = scoreEvent();
    const replayed = scoreEvent({ receivedAtMs: 9_999 });

    expect(replayed.eventId).toBe(first.eventId);
    expect(replayed.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('uses a total tie-break order for every input permutation', () => {
    const events = [
      scoreEvent({ source: 'txline-snapshot', sourceId: 'b' }),
      scoreEvent({ sequence: 8, sourceId: 'c' }),
      scoreEvent({ sourceId: 'a' }),
      scoreEvent({ source: 'txline-historical', sourceId: 'd' }),
    ];
    const expected = [...events].sort(compareEventOrder).map(({ eventId }) => eventId);

    for (const permutation of permutations(events)) {
      expect(permutation.sort(compareEventOrder).map(({ eventId }) => eventId)).toEqual(
        expected,
      );
    }
    expect(new Set(expected)).toHaveLength(events.length);
  });

  it('rejects forged priority and non-canonical identity', () => {
    const valid = scoreEvent();
    expect(() =>
      normalizedDomainEventSchema.parse({
        ...valid,
        eventId: 'forged',
        sourcePriority: 999,
      }),
    ).toThrow();
  });

  it('provides injectable deterministic clocks and ID generation', () => {
    const clock = new FixedClock(123_456);
    const ids = new SequenceIdGenerator(7);

    expect(clock.nowMs()).toBe(123_456);
    expect(ids.nextId('replay')).toBe('replay_000000000007');
    expect(ids.nextId('replay')).toBe('replay_000000000008');
  });

  it('builds an unambiguous decision identity', () => {
    expect(
      buildDecisionIdempotencyKey({
        marketId: 'c',
        policyVersion: 'd',
        triggerEventId: 'ab',
      }),
    ).not.toBe(
      buildDecisionIdempotencyKey({
        marketId: 'bc',
        policyVersion: 'd',
        triggerEventId: 'a',
      }),
    );
  });
});
