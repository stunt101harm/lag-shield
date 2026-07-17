import { FixedClock, normalizedDomainEventSchema } from '@lagshield/core';
import { describe, expect, it } from 'vitest';

import {
  malformedOddsPayload,
  partialOddsPayload,
  unknownPayload,
  validOddsPayload,
} from './__fixtures__/raw-payloads.js';
import { normalizeTxLinePayload } from './raw.js';

const clock = new FixedClock(1_800_000_000_000);

describe('TxLINE raw normalization', () => {
  it('accepts a partial odds payload and preserves native fixed-point values', () => {
    const result = normalizeTxLinePayload(
      { payloadKind: 'odds', rawPayload: partialOddsPayload, source: 'txline-live' },
      clock,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(normalizedDomainEventSchema.parse(result.event)).toEqual(result.event);
    expect(result.event).toMatchObject({
      fixtureId: '18241006',
      kind: 'odds.observed',
      receivedAtMs: 1_800_000_000_000,
      source: 'txline-live',
    });
    if (result.event.kind !== 'odds.observed') return;
    expect(result.event.payload.outcomes.map(({ price }) => price)).toEqual([
      2100, 3300, 2900,
    ]);
    expect(result.event.payload.market).toMatchObject({
      parameters: null,
      period: null,
      status: 'open',
    });
  });

  it('uses the same normalized payload contract for live and historical inputs', () => {
    const live = normalizeTxLinePayload(
      { payloadKind: 'odds', rawPayload: validOddsPayload, source: 'txline-live' },
      clock,
    );
    const historical = normalizeTxLinePayload(
      { payloadKind: 'odds', rawPayload: validOddsPayload, source: 'txline-historical' },
      clock,
    );

    expect(live.ok && historical.ok).toBe(true);
    if (!live.ok || !historical.ok) return;
    expect(historical.event.kind).toBe(live.event.kind);
    expect(historical.event.payload).toEqual(live.event.payload);
    expect(historical.event.source).toBe('txline-historical');
  });

  it('normalizes score stats and total score deterministically', () => {
    const result = normalizeTxLinePayload(
      {
        payloadKind: 'score',
        rawPayload: {
          Action: 'goal',
          FixtureId: 18_241_006,
          Seq: 88,
          Stats: [
            { Key: 1, Period: 0, Value: 2 },
            { key: 2, period: 0, value: 1 },
          ],
          Ts: 1_799_999_999_100,
        },
        source: 'txline-historical',
      },
      clock,
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.event.kind !== 'score.observed') return;
    expect(result.event.payload).toMatchObject({ awayScore: 1, homeScore: 2 });
    expect(result.event.sequence).toBe(88);
  });

  it.each([
    {
      expectedCode: 'unknown_payload_kind',
      payloadKind: 'weather',
      rawPayload: unknownPayload,
    },
    {
      expectedCode: 'malformed_payload',
      payloadKind: 'odds',
      rawPayload: malformedOddsPayload,
    },
    {
      expectedCode: 'malformed_payload',
      payloadKind: 'score',
      rawPayload: { FixtureId: 'not-a-number' },
    },
  ])(
    'quarantines $payloadKind without throwing',
    ({ expectedCode, payloadKind, rawPayload }) => {
      const result = normalizeTxLinePayload(
        { payloadKind, rawPayload, source: 'txline-live' },
        clock,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.quarantine.code).toBe(expectedCode);
      expect(result.quarantine.rawPayload).toEqual(rawPayload);
    },
  );

  it('normalizes dynamic fixtures without a hard-coded competition ID', () => {
    const result = normalizeTxLinePayload(
      {
        payloadKind: 'fixture',
        rawPayload: {
          Competition: 'FIFA World Cup',
          CompetitionId: 72,
          FixtureId: 123,
          FixtureGroupId: 1,
          GameState: 1,
          Participant1: 'Canada',
          Participant1Id: 10,
          Participant1IsHome: false,
          Participant2: 'Japan',
          Participant2Id: 20,
          StartTime: 1_900_000_000_000,
          Ts: 1_800_000_000_000,
        },
        source: 'txline-snapshot',
      },
      clock,
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.event.kind !== 'fixture.observed') return;
    expect(result.event.payload.participants).toEqual([
      { id: '20', name: 'Japan', role: 'home' },
      { id: '10', name: 'Canada', role: 'away' },
    ]);
  });
});
