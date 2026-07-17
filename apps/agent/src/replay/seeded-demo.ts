import {
  DeterministicReplayRunner,
  VirtualReplayClock,
  createNormalizedEvent,
  createReplayManifest,
  type JsonValue,
  type NormalizedDomainEvent,
  type ReplayResult,
  type ReplaySpeed,
} from '@lagshield/core';

const fixtureId = 'seeded-world-cup-canada-japan';
const competitionId = 'seeded-world-cup-2026';
const startMs = Date.UTC(2026, 6, 17, 18);

export const seededDemoStrategyConfiguration = Object.freeze({
  pauseLagMs: 5_000,
  recoveryStableUpdates: 3,
  widenLagMs: 2_000,
}) satisfies JsonValue;

function fixtureEvent(): NormalizedDomainEvent {
  return createNormalizedEvent({
    fixtureId,
    kind: 'fixture.observed',
    payload: {
      competition: 'FIFA World Cup (seeded demo)',
      competitionId,
      fixtureId,
      participants: [
        { id: 'can', name: 'Canada', role: 'home' },
        { id: 'jpn', name: 'Japan', role: 'away' },
      ],
      scheduledAtMs: startMs,
      status: 'live',
    },
    payloadVersion: 1,
    receivedAtMs: startMs,
    sequence: 0,
    source: 'simulation',
    sourceId: 'seed-fixture-v1',
    sourceTimestampMs: startMs,
  });
}

function oddsEvent(
  input: Readonly<{
    prices: readonly [number, number, number];
    sequence: number;
    sourceId: string;
    timestampMs: number;
  }>,
): NormalizedDomainEvent {
  return createNormalizedEvent({
    fixtureId,
    kind: 'odds.observed',
    payload: {
      bookmaker: { id: 'consensus', name: 'TxODDS Consensus (seeded)' },
      fixtureId,
      market: {
        gameState: 'in_play',
        inRunning: true,
        marketId: 'seeded-match-winner',
        parameters: null,
        period: 'full_time',
        status: 'open',
        type: '1X2',
      },
      outcomes: [
        { name: 'Canada', outcomeId: 'seeded-canada', price: input.prices[0] },
        { name: 'Draw', outcomeId: 'seeded-draw', price: input.prices[1] },
        { name: 'Japan', outcomeId: 'seeded-japan', price: input.prices[2] },
      ],
      priceEncoding: 'txline-native-i32-v1',
    },
    payloadVersion: 1,
    receivedAtMs: input.timestampMs,
    sequence: input.sequence,
    source: 'simulation',
    sourceId: input.sourceId,
    sourceTimestampMs: input.timestampMs,
  });
}

function scoreEvent(
  input: Readonly<{
    homeScore: number;
    sequence: number;
    sourceId: string;
    timestampMs: number;
  }>,
): NormalizedDomainEvent {
  return createNormalizedEvent({
    fixtureId,
    kind: 'score.observed',
    payload: {
      action: 'goal',
      awayScore: 0,
      fixtureId,
      homeScore: input.homeScore,
      period: 2,
      stats: [
        { key: 1, period: 0, value: input.homeScore },
        { key: 2, period: 0, value: 0 },
      ],
      statusId: 2,
    },
    payloadVersion: 1,
    receivedAtMs: input.timestampMs,
    sequence: input.sequence,
    source: 'simulation',
    sourceId: input.sourceId,
    sourceTimestampMs: input.timestampMs,
  });
}

export function createSeededDemoBundle() {
  const events = [
    fixtureEvent(),
    oddsEvent({
      prices: [2400, 3100, 2800],
      sequence: 1,
      sourceId: 'seed-odds-1',
      timestampMs: startMs + 1_000,
    }),
    scoreEvent({
      homeScore: 1,
      sequence: 2,
      sourceId: 'seed-score-1',
      timestampMs: startMs + 60_000,
    }),
    oddsEvent({
      prices: [2400, 3100, 2800],
      sequence: 3,
      sourceId: 'seed-odds-stale',
      timestampMs: startMs + 63_000,
    }),
    oddsEvent({
      prices: [1650, 3600, 5100],
      sequence: 4,
      sourceId: 'seed-odds-caught-up',
      timestampMs: startMs + 68_000,
    }),
  ];
  const manifest = createReplayManifest({
    dataMode: 'seeded-simulation',
    events,
    fixture: { competitionId, fixtureId, scheduledAtMs: startMs },
    normalizerVersion: 'seeded-demo-v1',
    oddsIntervals: [],
    orderingVersion: 'event-order-v1',
    sourceEndMs: startMs + 68_000,
    sourceStartMs: startMs,
    strategyConfiguration: seededDemoStrategyConfiguration,
    strategyVersion: 'lag-shield-v1',
  });
  return { events, manifest } as const;
}

export async function runSeededDemo(
  options: Readonly<{ runId?: string; speed?: ReplaySpeed }> = {},
): Promise<
  Readonly<{
    result: ReplayResult;
    trace: readonly Readonly<{
      eventId: string;
      kind: NormalizedDomainEvent['kind'];
      logicalTimestampMs: number;
      namespace: string;
    }>[];
  }>
> {
  const bundle = createSeededDemoBundle();
  const trace: Array<{
    eventId: string;
    kind: NormalizedDomainEvent['kind'];
    logicalTimestampMs: number;
    namespace: string;
  }> = [];
  const runner = new DeterministicReplayRunner({
    clock: new VirtualReplayClock({ speed: options.speed ?? 'maximum' }),
    events: bundle.events,
    manifest: bundle.manifest,
    onEvent: async ({ context, event, logicalTimestampMs }) => {
      trace.push({
        eventId: event.eventId,
        kind: event.kind,
        logicalTimestampMs,
        namespace: context.namespace,
      });
    },
    runId: options.runId ?? 'seeded-demo',
  });
  return { result: await runner.run(), trace };
}
