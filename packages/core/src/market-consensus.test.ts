import { describe, expect, it } from 'vitest';

import {
  buildMarketId,
  bookmakerQuoteVectorFromEvent,
  consensusFormulaVersion,
  createNormalizedEvent,
  createConsensusSnapshot,
  DeterministicMarketFeatureEngine,
  measureBookmakerReactionLatencies,
  normalizeReportedProbabilityVector,
  probabilityScale,
  selectCoveredCoreMarket,
  type BookmakerQuoteVector,
  type ConsensusConfiguration,
} from './index.js';

const configuration: ConsensusConfiguration = {
  formulaVersion: consensusFormulaVersion,
  minFreshBookmakers: 2,
  staleAfterMs: 5_000,
};

function quote(
  bookmakerId: string,
  probabilities: readonly [number | null, number | null, number | null],
  observedAtMs = 10_000,
  eventId = `event-${bookmakerId}-${observedAtMs}`,
): BookmakerQuoteVector {
  return {
    bookmakerId,
    bookmakerName: bookmakerId,
    eventId,
    marketId: 'market-1',
    observedAtMs,
    outcomes: [
      { name: 'Home', outcomeId: 'home', reportedProbabilityMicros: probabilities[0] },
      { name: 'Draw', outcomeId: 'draw', reportedProbabilityMicros: probabilities[1] },
      { name: 'Away', outcomeId: 'away', reportedProbabilityMicros: probabilities[2] },
    ],
  };
}

function normalizedOddsEvent(
  sourceId: string,
  probabilities: readonly [number, number, number],
  timestampMs: number,
) {
  return createNormalizedEvent({
    fixtureId: 'fixture-1',
    kind: 'odds.observed',
    payload: {
      bookmaker: { id: 'book-a', name: 'Book A' },
      fixtureId: 'fixture-1',
      market: {
        gameState: 'live',
        inRunning: true,
        marketId: 'market-1',
        parameters: null,
        period: 'full_time',
        status: 'open',
        type: 'result',
      },
      outcomes: quote('book-a', probabilities).outcomes.map((outcome) => ({
        ...outcome,
        price: 0,
      })),
      priceEncoding: 'txline-native-i32-v1',
      probabilityEncoding: 'txline-pct-percent-3dp-v1',
    },
    payloadVersion: 2,
    receivedAtMs: timestampMs,
    sequence: 1,
    source: 'txline-live',
    sourceId,
    sourceTimestampMs: timestampMs,
  });
}

describe('market identity', () => {
  const market = {
    fixtureId: 'fixture-1',
    inRunning: true,
    outcomeNames: ['Home', 'Draw', 'Away'],
    parameters: null,
    period: 'full_time',
    type: 'result',
  } as const;

  it('is outcome-order invariant but separates line-defining fields', () => {
    expect(buildMarketId(market)).toBe(
      buildMarketId({ ...market, outcomeNames: ['Away', 'Home', 'Draw'] }),
    );
    expect(buildMarketId(market)).not.toBe(
      buildMarketId({ ...market, inRunning: false }),
    );
    expect(buildMarketId(market)).not.toBe(
      buildMarketId({ ...market, period: 'first_half' }),
    );
    expect(buildMarketId(market)).not.toBe(
      buildMarketId({ ...market, outcomeNames: ['Yes', 'No'] }),
    );
  });
});

describe('reported probability normalization', () => {
  it('adapts a normalized v2 odds event without reading wall-clock time', () => {
    const event = normalizedOddsEvent('odds-1', [500_000, 300_000, 200_000], 10_000);

    expect(event.kind).toBe('odds.observed');
    if (event.kind !== 'odds.observed') return;
    expect(bookmakerQuoteVectorFromEvent(event)).toMatchObject({
      bookmakerId: 'book-a',
      observedAtMs: 10_000,
    });
  });

  it('removes residual overround with deterministic largest-remainder allocation', () => {
    const result = normalizeReportedProbabilityVector(
      quote('book-1', [500_000, 300_000, 300_000]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vector.reportedSumMicros).toBe(1_100_000);
    expect(result.vector.residualOverroundMicros).toBe(100_000);
    expect(
      result.vector.normalizedOutcomes.reduce(
        (sum, { probabilityMicros }) => sum + probabilityMicros,
        0,
      ),
    ).toBe(probabilityScale);
    expect(
      Object.fromEntries(
        result.vector.normalizedOutcomes.map(({ outcomeId, probabilityMicros }) => [
          outcomeId,
          probabilityMicros,
        ]),
      ),
    ).toEqual({ away: 272_727, draw: 272_727, home: 454_546 });
  });

  it('rejects incomplete vectors while preserving a diagnostic', () => {
    expect(
      normalizeReportedProbabilityVector(quote('book-1', [500_000, null, 500_000])),
    ).toEqual({
      diagnostic: {
        bookmakerId: 'book-1',
        code: 'missing_reported_probability',
        eventId: 'event-book-1-10000',
      },
      ok: false,
    });
  });

  it('stays normalized and bounded across a broad integer input table', () => {
    for (let home = 1; home <= 1_000_000; home += 99_991) {
      for (let away = 1; away <= 1_000_000; away += 199_999) {
        const result = normalizeReportedProbabilityVector(
          quote('property', [home, Math.max(1, probabilityScale - home), away]),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        const probabilities = result.vector.normalizedOutcomes.map(
          ({ probabilityMicros }) => probabilityMicros,
        );
        expect(probabilities.reduce((sum, value) => sum + value, 0)).toBe(
          probabilityScale,
        );
        expect(
          probabilities.every((value) => value >= 0 && value <= probabilityScale),
        ).toBe(true);
      }
    }
  });
});

describe('robust deterministic consensus features', () => {
  it('uses a component median, ignores stale books, and resists one extreme book', () => {
    const quotes = [
      quote('book-a', [500_000, 300_000, 200_000], 10_000),
      quote('book-b', [500_000, 300_000, 200_000], 10_100),
      quote('book-outlier', [900_000, 50_000, 50_000], 10_200),
      quote('book-stale', [100_000, 100_000, 800_000], 1_000),
    ];
    const snapshot = createConsensusSnapshot({
      configuration,
      logicalTimestampMs: 11_000,
      marketId: 'market-1',
      quotes,
    });

    expect(snapshot.status).toBe('ready');
    expect(snapshot.outcomes.map(({ probabilityMicros }) => probabilityMicros)).toEqual([
      200_000, 300_000, 500_000,
    ]);
    expect(snapshot.staleBookmakerCount).toBe(1);
    expect(snapshot.staleBookmakerFractionPpm).toBe(250_000);
    expect(snapshot.validBookmakerCount).toBe(3);
    expect(snapshot.diagnostics).toContainEqual({
      bookmakerId: 'book-stale',
      code: 'stale_quote',
      eventId: 'event-book-stale-1000',
    });
    expect(snapshot).toMatchInlineSnapshot(`
      {
        "consensusId": "cns_897d552d0329ca94fcf31a7a941083dc66fff419",
        "diagnostics": [
          {
            "bookmakerId": "book-stale",
            "code": "stale_quote",
            "eventId": "event-book-stale-1000",
          },
        ],
        "formulaVersion": "reported-pct-proportional-median-v1",
        "freshBookmakerCount": 3,
        "freshestQuoteAgeMs": 800,
        "logicalTimestampMs": 11000,
        "marketId": "market-1",
        "oldestFreshQuoteAgeMs": 1000,
        "outcomes": [
          {
            "deltaMicros": null,
            "dispersionMadMicros": 0,
            "name": "Away",
            "outcomeId": "away",
            "probabilityMicros": 200000,
            "velocityMicrosPerSecond": null,
          },
          {
            "deltaMicros": null,
            "dispersionMadMicros": 0,
            "name": "Draw",
            "outcomeId": "draw",
            "probabilityMicros": 300000,
            "velocityMicrosPerSecond": null,
          },
          {
            "deltaMicros": null,
            "dispersionMadMicros": 0,
            "name": "Home",
            "outcomeId": "home",
            "probabilityMicros": 500000,
            "velocityMicrosPerSecond": null,
          },
        ],
        "staleBookmakerCount": 1,
        "staleBookmakerFractionPpm": 250000,
        "status": "ready",
        "totalBookmakerCount": 4,
        "validBookmakerCount": 3,
      }
    `);
  });

  it('is invariant to quote and outcome permutations', () => {
    const original = [
      quote('book-a', [500_000, 300_000, 200_000]),
      quote('book-b', [510_000, 290_000, 200_000]),
      quote('book-c', [490_000, 310_000, 200_000]),
    ];
    const permuted = [...original]
      .reverse()
      .map((value) => ({ ...value, outcomes: [...value.outcomes].reverse() }));
    const left = createConsensusSnapshot({
      configuration,
      logicalTimestampMs: 11_000,
      marketId: 'market-1',
      quotes: original,
    });
    const right = createConsensusSnapshot({
      configuration,
      logicalTimestampMs: 11_000,
      marketId: 'market-1',
      quotes: permuted,
    });

    expect(right).toEqual(left);
  });

  it('calculates deterministic deltas, velocity, age, and median absolute deviation', () => {
    const previous = createConsensusSnapshot({
      configuration: { ...configuration, minFreshBookmakers: 1 },
      logicalTimestampMs: 10_000,
      marketId: 'market-1',
      quotes: [quote('book-a', [500_000, 300_000, 200_000], 10_000)],
    });
    const current = createConsensusSnapshot({
      configuration,
      logicalTimestampMs: 12_000,
      marketId: 'market-1',
      previous,
      quotes: [
        quote('book-a', [520_000, 280_000, 200_000], 11_500),
        quote('book-b', [520_000, 280_000, 200_000], 11_000),
      ],
    });
    const home = current.outcomes.find(({ outcomeId }) => outcomeId === 'home');

    expect(current).toMatchObject({
      freshestQuoteAgeMs: 500,
      oldestFreshQuoteAgeMs: 1_000,
      status: 'ready',
    });
    expect(home).toMatchObject({
      deltaMicros: 20_000,
      dispersionMadMicros: 0,
      velocityMicrosPerSecond: 10_000,
    });
  });

  it('selects the largest matching outcome set and surfaces mismatches', () => {
    const mismatch = {
      ...quote('book-c', [600_000, 200_000, 200_000]),
      outcomes: quote('book-c', [600_000, 200_000, 200_000]).outcomes.slice(0, 2),
    };
    const snapshot = createConsensusSnapshot({
      configuration,
      logicalTimestampMs: 11_000,
      marketId: 'market-1',
      quotes: [
        quote('book-a', [500_000, 300_000, 200_000]),
        quote('book-b', [510_000, 290_000, 200_000]),
        mismatch,
      ],
    });

    expect(snapshot.status).toBe('ready');
    expect(snapshot.diagnostics).toContainEqual({
      bookmakerId: 'book-c',
      code: 'outcome_set_mismatch',
      eventId: mismatch.eventId,
    });
  });

  it('measures the first material post-event reaction for each bookmaker', () => {
    const baseline = createConsensusSnapshot({
      configuration: { ...configuration, minFreshBookmakers: 1 },
      logicalTimestampMs: 10_000,
      marketId: 'market-1',
      quotes: [quote('baseline', [500_000, 300_000, 200_000], 10_000)],
    });
    const latencies = measureBookmakerReactionLatencies({
      baseline,
      eventTimestampMs: 20_000,
      quotes: [
        quote('book-a', [500_000, 300_000, 200_000], 21_000),
        quote('book-a', [550_000, 270_000, 180_000], 22_500),
        quote('book-b', [510_000, 295_000, 195_000], 23_000),
      ],
      reactionThresholdMicros: 30_000,
    });

    expect(latencies).toEqual([
      {
        bookmakerId: 'book-a',
        firstReactionEventId: 'event-book-a-22500',
        latencyMs: 2_500,
      },
      { bookmakerId: 'book-b', firstReactionEventId: null, latencyMs: null },
    ]);
  });

  it('prefers a configured covered market but retains unknown types as fallbacks', () => {
    const consensus = createConsensusSnapshot({
      configuration,
      logicalTimestampMs: 11_000,
      marketId: 'market-1',
      quotes: [
        quote('book-a', [500_000, 300_000, 200_000]),
        quote('book-b', [510_000, 290_000, 200_000]),
      ],
    });
    const unknown = {
      consensus: { ...consensus, marketId: 'market-unknown', validBookmakerCount: 5 },
      inRunning: true,
      marketId: 'market-unknown',
      marketType: 'unclassified-returned-type',
      outcomeCount: 3,
      parameters: null,
      period: null,
    } as const;
    const preferred = {
      consensus,
      inRunning: true,
      marketId: 'market-1',
      marketType: 'verified-full-time-result',
      outcomeCount: 3,
      parameters: null,
      period: 'full_time',
    } as const;
    const selection = selectCoveredCoreMarket({
      candidates: [unknown, preferred],
      minValidBookmakers: 2,
      preferredMarketTypes: ['verified-full-time-result'],
      requireInRunning: true,
    });

    expect(selection.eligibleMarketIds).toEqual(['market-1', 'market-unknown']);
    expect(selection.selected?.marketId).toBe('market-1');
    expect(
      selectCoveredCoreMarket({
        candidates: [unknown],
        minValidBookmakers: 2,
        preferredMarketTypes: ['not-returned'],
        requireInRunning: true,
      }).selected?.marketId,
    ).toBe('market-unknown');
  });

  it('runs the same idempotent stateful feature path with explicit logical time', () => {
    const engine = new DeterministicMarketFeatureEngine({
      ...configuration,
      minFreshBookmakers: 1,
    });
    const firstEvent = normalizedOddsEvent(
      'engine-1',
      [500_000, 300_000, 200_000],
      10_000,
    );
    const secondEvent = normalizedOddsEvent(
      'engine-2',
      [550_000, 270_000, 180_000],
      12_000,
    );
    const first = engine.observe(firstEvent, 10_000);

    expect(engine.observe(firstEvent, 10_000)).toEqual(first);
    expect(engine.observe(secondEvent, 12_000)?.outcomes).toContainEqual(
      expect.objectContaining({
        deltaMicros: 50_000,
        outcomeId: 'home',
        velocityMicrosPerSecond: 25_000,
      }),
    );
    expect(engine.snapshot('market-1')?.logicalTimestampMs).toBe(12_000);
    expect(() => engine.observe(secondEvent, 11_999)).toThrow('cannot move backwards');
  });
});
