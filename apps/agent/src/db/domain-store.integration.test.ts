import {
  FixedClock,
  createReplayManifest,
  createReplayRun,
  createStrategyDecision,
  replayRunSchema,
  type NormalizedDomainEvent,
} from '@lagshield/core';
import { normalizeTxLinePayload, planHistoricalOddsIntervals } from '@lagshield/txline';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseClient } from './client.js';
import {
  ConcurrentStateError,
  IdempotencyConflictError,
  PostgresDomainStore,
} from './domain-store.js';
import { PostgresReplayStore } from './replay-store.js';
import { ingestTxLinePayload } from '../ingest/txline-ingest.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const clock = new FixedClock(1_800_000_000_000);
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

let client: DatabaseClient | undefined;
let store: PostgresDomainStore | undefined;

function requireStore(): PostgresDomainStore {
  if (!store) throw new Error('Integration store is not initialized.');
  return store;
}

function normalizeOdds(overrides: Record<string, unknown> = {}) {
  const normalized = normalizeTxLinePayload(
    {
      payloadKind: 'odds',
      rawPayload: {
        Bookmaker: 'TxODDS Consensus',
        BookmakerId: 7,
        FixtureId: 42,
        InRunning: true,
        MessageId: 'odds-1',
        PriceNames: ['Home', 'Draw', 'Away'],
        Prices: [2100, 3200, 2900],
        SuperOddsType: '1X2',
        Ts: 1_700_000_000_000,
        ...overrides,
      },
      source: 'txline-live',
    },
    clock,
  );
  if (!normalized.ok) throw new Error(normalized.quarantine.issues.join('; '));
  return normalized;
}

function normalizeScore(input: {
  readonly away: number;
  readonly home: number;
  readonly seq: number;
  readonly source: 'txline-historical' | 'txline-live';
}) {
  const normalized = normalizeTxLinePayload(
    {
      payloadKind: 'score',
      rawPayload: {
        Action: 'score_update',
        FixtureId: 42,
        Seq: input.seq,
        Stats: [
          { Key: 1, Period: 0, Value: input.home },
          { Key: 2, Period: 0, Value: input.away },
        ],
        Ts: 1_700_000_000_000,
      },
      source: input.source,
    },
    clock,
  );
  if (!normalized.ok) throw new Error(normalized.quarantine.issues.join('; '));
  return normalized;
}

describe.skipIf(!databaseUrl)('PostgresDomainStore', () => {
  beforeAll(async () => {
    if (!databaseUrl) return;
    const database = createDatabase(databaseUrl);
    client = database.client;
    store = new PostgresDomainStore(client);
    await migrate(database.database, { migrationsFolder });
  });

  beforeEach(async () => {
    await client?.unsafe(`
      TRUNCATE TABLE
        decision_receipts,
        simulated_orders,
        market_control_states,
        strategy_decisions,
        replay_runs,
        replay_manifests,
        fixture_score_state,
        score_events,
        outcome_quote_observations,
        markets,
        fixtures,
        domain_events,
        raw_ingest_records,
        system_metadata
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    client = undefined;
    store = undefined;
  });

  it('atomically deduplicates events, preserves quotes, and quarantines invalid input', async () => {
    const normalized = normalizeOdds();

    await expect(
      requireStore().appendEvent({ event: normalized.event, raw: normalized.raw }),
    ).resolves.toMatchObject({ status: 'inserted' });
    await expect(
      requireStore().appendEvent({ event: normalized.event, raw: normalized.raw }),
    ).resolves.toMatchObject({ status: 'duplicate' });

    const counts = await client!<
      { domain_count: number; quote_count: number; raw_count: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM raw_ingest_records) AS raw_count,
        (SELECT count(*)::int FROM domain_events) AS domain_count,
        (SELECT count(*)::int FROM outcome_quote_observations) AS quote_count
    `;
    expect(counts[0]).toEqual({ domain_count: 1, quote_count: 3, raw_count: 1 });

    const conflicting = normalizeOdds({ Prices: [9999, 3200, 2900] });
    await expect(
      requireStore().appendEvent({ event: conflicting.event, raw: conflicting.raw }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const malformedInput = {
      payloadKind: 'odds',
      rawPayload: { FixtureId: 42, MessageId: 'bad-odds', Prices: [] },
      source: 'txline-live' as const,
    };
    await expect(
      ingestTxLinePayload({ clock, store: requireStore() }, malformedInput),
    ).resolves.toMatchObject({ status: 'quarantined' });
    await expect(
      ingestTxLinePayload({ clock, store: requireStore() }, malformedInput),
    ).resolves.toMatchObject({ status: 'duplicate' });
    const quarantined = await client!<{ count: number }[]>`
      SELECT count(*)::int AS count FROM raw_ingest_records WHERE status = 'quarantined'
    `;
    expect(quarantined[0]?.count).toBe(1);
  });

  it('uses identical ordering for append-only history and restart-safe score projection', async () => {
    const live = normalizeScore({ away: 1, home: 2, seq: 10, source: 'txline-live' });
    const historical = normalizeScore({
      away: 0,
      home: 1,
      seq: 10,
      source: 'txline-historical',
    });

    await requireStore().appendEvent({ event: live.event, raw: live.raw });
    await requireStore().appendEvent({ event: historical.event, raw: historical.raw });

    const state = await client!<
      { away_score: number; home_score: number; last_event_id: string }[]
    >`
      SELECT away_score, home_score, last_event_id
      FROM fixture_score_state
      WHERE fixture_id = '42'
    `;
    expect(state[0]).toEqual({
      away_score: 1,
      home_score: 2,
      last_event_id: live.event.eventId,
    });

    const firstPage = await requireStore().listFixtureEvents({
      fixtureId: '42',
      limit: 1,
    });
    expect(firstPage.events.map(({ source }) => source)).toEqual(['txline-historical']);
    expect(firstPage.nextCursor).toBe(firstPage.events[0]?.eventId);
    const secondPage = await requireStore().listFixtureEvents({
      afterEventId: firstPage.nextCursor!,
      fixtureId: '42',
      limit: 1,
    });
    expect(secondPage.events.map(({ source }) => source)).toEqual(['txline-live']);
    expect(secondPage.nextCursor).toBeNull();
    await expect(
      requireStore().listFixtureEvents({ fixtureId: '42', limit: 501 }),
    ).rejects.toThrow('between 1 and 500');
  });

  it('expires retained historical payloads without losing identity or mutating live projections', async () => {
    const historical = normalizeScore({
      away: 0,
      home: 1,
      seq: 77,
      source: 'txline-historical',
    });
    const retentionExpiresAtMs = clock.nowMs() + 10_000;
    const raw = { ...historical.raw, retentionExpiresAtMs };

    await expect(
      requireStore().appendEvent({ event: historical.event, raw }),
    ).resolves.toMatchObject({ status: 'inserted' });
    const projections = await client!<{ count: number }[]>`
      SELECT count(*)::int AS count FROM fixture_score_state WHERE fixture_id = '42'
    `;
    expect(projections[0]?.count).toBe(0);
    await expect(
      requireStore().purgeExpiredRawPayloads({
        limit: 100,
        nowMs: retentionExpiresAtMs - 1,
      }),
    ).resolves.toBe(0);
    await expect(
      requireStore().purgeExpiredRawPayloads({
        limit: 100,
        nowMs: retentionExpiresAtMs,
      }),
    ).resolves.toBe(1);
    const retained = await client!<
      { payload_retained: boolean; raw_payload: unknown; raw_payload_hash: string }[]
    >`
      SELECT payload_retained, raw_payload, raw_payload_hash
      FROM raw_ingest_records
      WHERE ingest_id = ${raw.ingestId}
    `;
    expect(retained[0]).toMatchObject({
      payload_retained: false,
      raw_payload: null,
    });
    expect(retained[0]?.raw_payload_hash).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      requireStore().appendEvent({ event: historical.event, raw }),
    ).resolves.toMatchObject({ status: 'duplicate' });
  });

  it('persists deterministic replay manifests and enforces run namespaces and transitions', async () => {
    const historical = normalizeScore({
      away: 0,
      home: 1,
      seq: 78,
      source: 'txline-historical',
    });
    const manifest = createReplayManifest({
      events: [historical.event],
      fixture: {
        competitionId: '72',
        fixtureId: historical.event.fixtureId,
        scheduledAtMs: 1_699_999_000_000,
      },
      normalizerVersion: 'txline-normalizer-v1',
      oddsIntervals: [
        ...planHistoricalOddsIntervals({
          endMs: historical.event.sourceTimestampMs,
          startMs: historical.event.sourceTimestampMs,
        }),
      ],
      orderingVersion: 'event-order-v1',
      sourceEndMs: historical.event.sourceTimestampMs,
      sourceStartMs: historical.event.sourceTimestampMs,
      strategyConfiguration: { lagPauseMs: 5_000 },
      strategyVersion: 'lag-shield-v1',
    });
    const replayStore = new PostgresReplayStore(client!);
    const storedManifest = {
      createdAtMs: clock.nowMs(),
      manifest,
      retentionExpiresAtMs: clock.nowMs() + 60_000,
    };
    await expect(replayStore.saveReplayManifest(storedManifest)).resolves.toMatchObject({
      status: 'inserted',
    });
    await expect(replayStore.saveReplayManifest(storedManifest)).resolves.toMatchObject({
      status: 'duplicate',
    });

    const pending = createReplayRun({
      manifest,
      runId: 'integration-run-1',
      speed: 'maximum',
      startedAtMs: clock.nowMs(),
    });
    await expect(replayStore.createReplayRun(pending)).resolves.toMatchObject({
      status: 'inserted',
    });
    await expect(replayStore.createReplayRun(pending)).resolves.toMatchObject({
      status: 'duplicate',
    });
    const running = replayRunSchema.parse({ ...pending, status: 'running' });
    await expect(replayStore.updateReplayRun(running)).resolves.toMatchObject({
      status: 'inserted',
    });
    const completed = replayRunSchema.parse({
      ...running,
      completedAtMs: clock.nowMs() + 1,
      eventCount: 1,
      lastEventId: historical.event.eventId,
      status: 'completed',
    });
    await expect(replayStore.updateReplayRun(completed)).resolves.toMatchObject({
      status: 'inserted',
    });
    await expect(replayStore.updateReplayRun(running)).rejects.toThrow(
      'cannot move from completed to running',
    );
    const rows = await client!<{ namespace: string; status: string }[]>`
      SELECT namespace, status FROM replay_runs WHERE run_id = ${completed.runId}
    `;
    expect(rows[0]).toEqual({
      namespace: 'replay:integration-run-1',
      status: 'completed',
    });
  });

  it('restores decision state after reconnect and rejects stale state versions', async () => {
    const normalized = normalizeOdds();
    await requireStore().appendEvent({ event: normalized.event, raw: normalized.raw });
    const event = normalized.event as Extract<
      NormalizedDomainEvent,
      { kind: 'odds.observed' }
    >;
    const marketId = event.payload.market.marketId;
    const pause = createStrategyDecision({
      action: 'pause',
      expectedStateVersion: 0,
      fixtureId: event.fixtureId,
      logicalTimestampMs: event.sourceTimestampMs,
      marketId,
      metrics: { lagMs: 5000 },
      nextState: 'PAUSED',
      payloadVersion: 1,
      policyVersion: 'policy-v1',
      previousState: 'OPEN',
      reasonCodes: ['SCORE_ODDS_DIVERGENCE'],
      triggerEventId: event.eventId,
    });

    await expect(requireStore().appendDecision(pause)).resolves.toMatchObject({
      status: 'inserted',
    });
    await expect(requireStore().appendDecision(pause)).resolves.toMatchObject({
      status: 'duplicate',
    });

    await client!.end({ timeout: 5 });
    const restarted = createDatabase(databaseUrl!);
    client = restarted.client;
    store = new PostgresDomainStore(client);
    await expect(requireStore().loadMarketControlState(marketId)).resolves.toEqual({
      fixtureId: event.fixtureId,
      lastDecisionId: pause.decisionId,
      logicalTimestampMs: event.sourceTimestampMs,
      marketId,
      state: 'PAUSED',
      stateVersion: 1,
    });

    const stale = createStrategyDecision({
      action: 'begin_recovery',
      expectedStateVersion: 0,
      fixtureId: event.fixtureId,
      logicalTimestampMs: event.sourceTimestampMs + 1,
      marketId,
      metrics: { stableUpdates: 3 },
      nextState: 'RECOVERY',
      payloadVersion: 1,
      policyVersion: 'policy-v2-stale',
      previousState: 'PAUSED',
      reasonCodes: ['RECOVERY_WINDOW'],
      triggerEventId: event.eventId,
    });
    await expect(requireStore().appendDecision(stale)).rejects.toBeInstanceOf(
      ConcurrentStateError,
    );

    const recovery = createStrategyDecision({
      ...stale,
      expectedStateVersion: 1,
      policyVersion: 'policy-v2',
    });
    await expect(requireStore().appendDecision(recovery)).resolves.toMatchObject({
      status: 'inserted',
    });
    await expect(requireStore().loadMarketControlState(marketId)).resolves.toMatchObject({
      state: 'RECOVERY',
      stateVersion: 2,
    });
  });

  it('installs the bounded dashboard query indexes', async () => {
    const rows = await client!<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
    `;
    const names = new Set(rows.map(({ indexname }) => indexname));
    for (const requiredIndex of [
      'domain_events_fixture_order_idx',
      'quotes_market_outcome_time_idx',
      'strategy_decisions_fixture_time_idx',
      'simulated_orders_fixture_time_idx',
      'raw_ingest_status_received_idx',
    ]) {
      expect(names.has(requiredIndex), `missing index ${requiredIndex}`).toBe(true);
    }
  });

  it('rejects forged deterministic-order metadata at the database boundary', async () => {
    const normalized = normalizeOdds();
    await requireStore().appendEvent({ event: normalized.event, raw: normalized.raw });

    await expect(
      client!`
        UPDATE domain_events
        SET source_priority = 999
        WHERE event_id = ${normalized.event.eventId}
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });
});
