import { describe, expect, it } from 'vitest';

import {
  createNormalizedEvent,
  createReplayExecutionContext,
  createReplayManifest,
  createReplayRun,
  DeterministicReplayRunner,
  liveExecutionContext,
  namespaceResource,
  replayManifestSchema,
  VirtualReplayClock,
  type NormalizedEventInput,
} from './index.js';

type ScoreInput = Extract<NormalizedEventInput, { kind: 'score.observed' }>;

function event(
  input: Partial<Pick<ScoreInput, 'sequence' | 'sourceId' | 'sourceTimestampMs'>>,
) {
  return createNormalizedEvent({
    fixtureId: 'fixture-42',
    kind: 'score.observed',
    payload: {
      action: 'score_update',
      awayScore: 0,
      fixtureId: 'fixture-42',
      homeScore: 1,
      period: 2,
      stats: [{ key: 1, period: 0, value: 1 }],
      statusId: 2,
    },
    payloadVersion: 1,
    receivedAtMs: 1_000,
    sequence: 1,
    source: 'txline-historical',
    sourceId: 'score-1',
    sourceTimestampMs: 1_000,
    ...input,
  });
}

function manifest(events: readonly ReturnType<typeof event>[]) {
  return createReplayManifest({
    events,
    fixture: {
      competitionId: 'world-cup',
      fixtureId: 'fixture-42',
      scheduledAtMs: 900,
    },
    normalizerVersion: 'txline-v1',
    oddsIntervals: [
      { endMs: 1_300, epochDay: 0, hourOfDay: 0, interval: 0, startMs: 1_000 },
    ],
    orderingVersion: 'event-order-v1',
    sourceEndMs: 1_300,
    sourceStartMs: 900,
    strategyConfiguration: { pauseLagMs: 2_000, stableUpdates: 3 },
    strategyVersion: 'risk-v1',
  });
}

describe('deterministic replay manifests and execution', () => {
  it('produces the same manifest from every input ordering', () => {
    const events = [
      event({ sequence: 2, sourceId: 'score-2', sourceTimestampMs: 1_200 }),
      event({ sequence: 1, sourceId: 'score-1', sourceTimestampMs: 1_000 }),
    ];

    expect(manifest(events)).toEqual(manifest([...events].reverse()));
    expect(replayManifestSchema.parse(manifest(events))).toEqual(manifest(events));
    expect(
      createReplayRun({
        manifest: manifest(events),
        runId: 'demo-001',
        speed: 'maximum',
        startedAtMs: 1_800_000_000_000,
      }),
    ).toMatchObject({
      eventCount: 0,
      namespace: 'replay:demo-001',
      status: 'pending',
    });
  });

  it('runs in canonical order with an unambiguous replay namespace', async () => {
    const events = [
      event({ sequence: 2, sourceId: 'score-2', sourceTimestampMs: 1_200 }),
      event({ sequence: 1, sourceId: 'score-1', sourceTimestampMs: 1_000 }),
    ];
    const dispatches: string[] = [];
    const runner = new DeterministicReplayRunner({
      clock: new VirtualReplayClock({ speed: 'maximum' }),
      events,
      manifest: manifest(events),
      onEvent: async ({ context, event: replayEvent }) => {
        dispatches.push(namespaceResource(context, replayEvent.eventId));
      },
      runId: 'run-7',
    });

    const result = await runner.run();

    expect(dispatches).toHaveLength(2);
    expect(dispatches[0]).toContain('replay:run-7:');
    expect(result).toMatchObject({ eventCount: 2, namespace: 'replay:run-7' });
    expect(namespaceResource(liveExecutionContext, 'market-1')).toBe('market-1');
    expect(namespaceResource(createReplayExecutionContext('run-7'), 'market-1')).toBe(
      'replay:run-7:market-1',
    );
  });

  it('rejects duplicated, cross-fixture, or manifest-mismatched input', () => {
    const first = event({});
    expect(
      () =>
        new DeterministicReplayRunner({
          clock: new VirtualReplayClock({ speed: 'maximum' }),
          events: [first, first],
          manifest: manifest([first]),
          onEvent: async () => undefined,
          runId: 'run-1',
        }),
    ).toThrow('duplicate event IDs');

    expect(() =>
      replayManifestSchema.parse({ ...manifest([first]), manifestId: 'forged' }),
    ).toThrow();
  });
});
