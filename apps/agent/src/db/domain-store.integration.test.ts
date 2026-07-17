import {
  DeterministicRiskEngine,
  FixedClock,
  createReplayManifest,
  createReplayRun,
  createStrategyDecision,
  decisionReceiptMaterialHash,
  marketOrderRequestSchema,
  replayRunSchema,
  toJsonValue,
  type MarketOrderRequest,
  type MarketRiskFeatures,
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
import {
  MarketNotInitializedError,
  PostgresSimulatedMarketControl,
} from './market-control.js';
import { PostgresReplayStore } from './replay-store.js';
import { PostgresDecisionReceiptStore } from './receipt-store.js';
import { ingestTxLinePayload } from '../ingest/txline-ingest.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const clock = new FixedClock(1_800_000_000_000);
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

const healthyRiskFeatures: MarketRiskFeatures = {
  consensusStatus: 'ready',
  freshBookmakerCount: 3,
  maxAbsVelocityMicrosPerSecond: 1_000,
  maxDispersionMadMicros: 1_000,
  maxReactionLatencyMs: 100,
  oldestFreshQuoteAgeMs: 100,
  staleBookmakerFractionPpm: 0,
  unreactedBookmakerCount: 0,
};

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
        Pct: ['40.000', '30.000', '30.000'],
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
        Action: 'goal',
        Confirmed: false,
        Data: { Goal: true },
        FixtureId: 42,
        Id: input.seq,
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

function orderRequest(
  input: Readonly<{
    decisionId: string;
    idempotencyKey: string;
    marketId: string;
    namespace?: `replay:${string}` | 'live';
    stateVersion: number;
  }>,
  overrides: Partial<MarketOrderRequest> = {},
): MarketOrderRequest {
  return marketOrderRequestSchema.parse({
    expectedDecisionId: input.decisionId,
    expectedStateVersion: input.stateVersion,
    fixtureId: '42',
    idempotencyKey: input.idempotencyKey,
    marketId: input.marketId,
    namespace: input.namespace ?? 'live',
    outcomeId: 'outcome-home',
    payloadVersion: 1,
    price: 2100,
    quoteObservedAtMs: clock.nowMs() - 100,
    requestedAtMs: clock.nowMs(),
    side: 'back',
    stakeMicros: 1_000_000,
    ...overrides,
  });
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
      {
        domain_count: number;
        probability_count: number;
        quote_count: number;
        raw_count: number;
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM raw_ingest_records) AS raw_count,
        (SELECT count(*)::int FROM domain_events) AS domain_count,
        (SELECT count(*)::int FROM outcome_quote_observations) AS quote_count,
        (SELECT count(reported_probability_micros)::int FROM outcome_quote_observations) AS probability_count
    `;
    expect(counts[0]).toEqual({
      domain_count: 1,
      probability_count: 3,
      quote_count: 3,
      raw_count: 1,
    });

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
      {
        action_id: string;
        away_score: number;
        confirmed: boolean;
        details: { possible: { goal: boolean } };
        home_score: number;
        last_event_id: string;
      }[]
    >`
      SELECT action_id, away_score, confirmed, details, home_score, last_event_id
      FROM fixture_score_state
      WHERE fixture_id = '42'
    `;
    expect(state[0]).toEqual({
      action_id: '10',
      away_score: 1,
      confirmed: false,
      details: {
        amendedAction: null,
        outcome: null,
        possible: { goal: true, penalty: null, redCard: null, review: null },
        referencedActionId: null,
        reliable: null,
        reviewType: null,
      },
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
      normalizerVersion: 'txline-normalizer-v3-score-semantics',
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

  it('persists v2 risk thresholds and reproducibility hashes in the decision payload', async () => {
    const normalized = normalizeOdds();
    await requireStore().appendEvent({ event: normalized.event, raw: normalized.raw });
    if (normalized.event.kind !== 'odds.observed') return;
    const engine = new DeterministicRiskEngine();
    const evaluation = engine.evaluate({
      features: {
        consensusStatus: 'insufficient',
        freshBookmakerCount: 0,
        maxAbsVelocityMicrosPerSecond: null,
        maxDispersionMadMicros: null,
        maxReactionLatencyMs: null,
        oldestFreshQuoteAgeMs: null,
        staleBookmakerFractionPpm: 1_000_000,
        unreactedBookmakerCount: 0,
      },
      fixtureId: normalized.event.fixtureId,
      logicalTimestampMs: normalized.event.sourceTimestampMs,
      marketId: normalized.event.payload.market.marketId,
      proofStatus: 'pending',
      triggerEventId: normalized.event.eventId,
    });
    if (!evaluation.decision || evaluation.decision.payloadVersion !== 2) return;

    await expect(
      requireStore().appendDecision(evaluation.decision),
    ).resolves.toMatchObject({ status: 'inserted' });
    const rows = await client!<
      {
        input_hash: string;
        policy_hash: string;
        recovery_updates: number;
      }[]
    >`
      SELECT
        payload ->> 'inputFeatureHash' AS input_hash,
        payload ->> 'policyConfigurationHash' AS policy_hash,
        (payload -> 'thresholds' ->> 'recoveryStableUpdates')::int AS recovery_updates
      FROM strategy_decisions
      WHERE decision_id = ${evaluation.decision.decisionId}
    `;
    expect(rows[0]).toEqual({
      input_hash: evaluation.decision.inputFeatureHash,
      policy_hash: evaluation.decision.policyConfigurationHash,
      recovery_updates: 3,
    });
  });

  it('atomically persists the simulated admission matrix, explanations, and receipts', async () => {
    const normalized = normalizeOdds();
    await requireStore().appendEvent({ event: normalized.event, raw: normalized.raw });
    if (normalized.event.kind !== 'odds.observed') return;
    const marketId = normalized.event.payload.market.marketId;
    const gate = new PostgresSimulatedMarketControl(client!, { clock });

    await expect(
      gate.submitOrder(
        orderRequest({
          decisionId: 'missing',
          idempotencyKey: 'missing-market',
          marketId: 'missing-market',
          stateVersion: 1,
        }),
      ),
    ).rejects.toBeInstanceOf(MarketNotInitializedError);

    const open = createStrategyDecision({
      action: 'none',
      expectedStateVersion: 0,
      fixtureId: normalized.event.fixtureId,
      logicalTimestampMs: normalized.event.sourceTimestampMs,
      marketId,
      metrics: {},
      nextState: 'OPEN',
      payloadVersion: 1,
      policyVersion: 'order-open',
      previousState: 'OPEN',
      reasonCodes: ['HEALTHY'],
      triggerEventId: normalized.event.eventId,
    });
    await requireStore().appendDecision(open);
    const openRequest = orderRequest({
      decisionId: open.decisionId,
      idempotencyKey: 'open-order',
      marketId,
      stateVersion: 1,
    });
    const accepted = await gate.submitOrder(openRequest);
    const duplicate = await gate.submitOrder(openRequest);
    expect(accepted).toMatchObject({
      decisionReceipt: {
        decisionId: open.decisionId,
        verification: { status: 'pending' },
      },
      order: {
        admissionReasonCode: 'ORDER_ACCEPTED_OPEN',
        marketStateVersion: 1,
        status: 'accepted',
      },
      persistenceStatus: 'inserted',
    });
    expect(duplicate).toEqual({ ...accepted, persistenceStatus: 'duplicate' });
    await expect(
      gate.submitOrder({ ...openRequest, price: 9999 }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const widened = createStrategyDecision({
      ...open,
      action: 'widen',
      expectedStateVersion: 1,
      nextState: 'WIDENED',
      policyVersion: 'order-widened',
    });
    await requireStore().appendDecision(widened);
    await expect(
      gate.submitOrder(
        orderRequest({
          decisionId: widened.decisionId,
          idempotencyKey: 'widened-order',
          marketId,
          stateVersion: 2,
        }),
      ),
    ).resolves.toMatchObject({
      order: {
        admissionReasonCode: 'ORDER_STALE_WIDENED_REQUOTE_REQUIRED',
        status: 'stale',
      },
    });

    const paused = createStrategyDecision({
      ...open,
      action: 'pause',
      expectedStateVersion: 2,
      nextState: 'PAUSED',
      policyVersion: 'order-paused',
      previousState: 'WIDENED',
    });
    await requireStore().appendDecision(paused);
    await expect(
      gate.submitOrder(
        orderRequest({
          decisionId: paused.decisionId,
          idempotencyKey: 'paused-order',
          marketId,
          stateVersion: 3,
        }),
      ),
    ).resolves.toMatchObject({
      order: {
        admissionReasonCode: 'ORDER_REJECTED_PAUSED',
        status: 'rejected',
      },
    });

    const recovering = createStrategyDecision({
      ...open,
      action: 'begin_recovery',
      expectedStateVersion: 3,
      nextState: 'RECOVERY',
      policyVersion: 'order-recovery',
      previousState: 'PAUSED',
    });
    await requireStore().appendDecision(recovering);
    await expect(
      gate.submitOrder(
        orderRequest({
          decisionId: recovering.decisionId,
          idempotencyKey: 'recovery-order',
          marketId,
          stateVersion: 4,
        }),
      ),
    ).resolves.toMatchObject({
      order: {
        admissionReasonCode: 'ORDER_REJECTED_RECOVERY',
        status: 'rejected',
      },
    });

    const rows = await client!<
      {
        admission_reason_code: string;
        decision_receipt_id: string;
        payload_version: number;
        status: string;
      }[]
    >`
      SELECT
        admission_reason_code,
        circuit_breaker_receipt_id AS decision_receipt_id,
        payload_version,
        status
      FROM simulated_orders
      ORDER BY created_at_ms, order_id
    `;
    expect(rows).toHaveLength(4);
    expect(rows.every(({ decision_receipt_id }) => decision_receipt_id.length > 0)).toBe(
      true,
    );
    expect(rows.every(({ payload_version }) => payload_version === 2)).toBe(true);
  });

  it('atomically binds each decision receipt to exact persisted TxLINE provenance', async () => {
    const normalized = normalizeOdds({ MessageId: 'receipt-proof-message' });
    await requireStore().appendEvent({ event: normalized.event, raw: normalized.raw });
    if (normalized.event.kind !== 'odds.observed') return;
    const decision = createStrategyDecision({
      action: 'none',
      expectedStateVersion: 0,
      fixtureId: normalized.event.fixtureId,
      logicalTimestampMs: normalized.event.sourceTimestampMs,
      marketId: normalized.event.payload.market.marketId,
      metrics: {},
      nextState: 'OPEN',
      payloadVersion: 1,
      policyVersion: 'receipt-integration',
      previousState: 'OPEN',
      reasonCodes: ['HEALTHY'],
      triggerEventId: normalized.event.eventId,
    });

    await requireStore().appendDecision(decision);
    const receiptStore = new PostgresDecisionReceiptStore(client!);
    const stored = await receiptStore.loadByDecisionId(decision.decisionId);

    expect(stored?.receipt).toMatchObject({
      canonicalPayload: {
        decision: { decisionId: decision.decisionId },
        evidence: [
          {
            eventId: normalized.event.eventId,
            kind: 'odds.observed',
            source: 'txline-live',
            sourceMessageId: 'receipt-proof-message',
            sourceTimestampMs: normalized.event.sourceTimestampMs,
          },
        ],
      },
      decisionId: decision.decisionId,
      payloadVersion: 2,
      verification: { attemptCount: 0, status: 'pending' },
    });
    expect(stored?.proofMaterial).toBeNull();
    await expect(receiptStore.listPending(10)).resolves.toHaveLength(1);

    if (!stored || !('verification' in stored.receipt)) {
      throw new Error('Expected a version 2 decision receipt.');
    }
    const proofMaterial = toJsonValue({
      messageId: 'receipt-proof-message',
      proof: ['aa'.repeat(32)],
      timestampMs: normalized.event.sourceTimestampMs,
    });
    const verified = await receiptStore.updateVerification({
      expectedAttemptCount: 0,
      proofMaterial,
      receiptId: stored.receipt.receiptId,
      verification: {
        ...stored.receipt.verification,
        attemptCount: 1,
        attemptedAtMs: clock.nowMs(),
        completedAtMs: clock.nowMs(),
        explorerAccountUrl: 'https://explorer.solana.com/address/root?cluster=devnet',
        explorerProgramUrl: 'https://explorer.solana.com/address/program?cluster=devnet',
        kind: 'odds',
        network: 'devnet',
        programId: 'program',
        proofMaterialHash: decisionReceiptMaterialHash(proofMaterial),
        proofReference:
          '/api/odds/validation?messageId=receipt-proof-message&ts=1700000000000',
        rootAccount: 'root',
        simulationSlot: 123,
        sourceEventId: normalized.event.eventId,
        sourceMessageId: 'receipt-proof-message',
        sourceTimestampMs: normalized.event.sourceTimestampMs,
        status: 'verified',
        summary: 'Verified in integration test.',
        updatedAtMs: clock.nowMs(),
      },
    });
    expect(verified).toMatchObject({
      payloadHash: stored.receipt.payloadHash,
      receiptId: stored.receipt.receiptId,
      verification: { attemptCount: 1, status: 'verified' },
    });
    await expect(receiptStore.listPending(10)).resolves.toHaveLength(0);
    await expect(
      receiptStore.updateVerification({
        expectedAttemptCount: 1,
        proofMaterial: toJsonValue({ forged: true }),
        receiptId: stored.receipt.receiptId,
        verification: verified.verification,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('serializes a concurrent pause and order admission on the same market lock', async () => {
    const normalized = normalizeOdds();
    await requireStore().appendEvent({ event: normalized.event, raw: normalized.raw });
    if (normalized.event.kind !== 'odds.observed') return;
    const marketId = normalized.event.payload.market.marketId;
    const open = createStrategyDecision({
      action: 'none',
      expectedStateVersion: 0,
      fixtureId: normalized.event.fixtureId,
      logicalTimestampMs: normalized.event.sourceTimestampMs,
      marketId,
      metrics: {},
      nextState: 'OPEN',
      payloadVersion: 1,
      policyVersion: 'race-open',
      previousState: 'OPEN',
      reasonCodes: ['HEALTHY'],
      triggerEventId: normalized.event.eventId,
    });
    await requireStore().appendDecision(open);
    const pause = createStrategyDecision({
      ...open,
      action: 'pause',
      expectedStateVersion: 1,
      logicalTimestampMs: open.logicalTimestampMs + 1,
      nextState: 'PAUSED',
      policyVersion: 'race-pause',
      reasonCodes: ['EVENT_GOAL_UNCONFIRMED'],
    });
    const gate = new PostgresSimulatedMarketControl(client!, { clock });
    const request = orderRequest({
      decisionId: open.decisionId,
      idempotencyKey: 'racing-order',
      marketId,
      stateVersion: 1,
    });

    const [pauseWrite, admission] = await Promise.all([
      requireStore().appendDecision(pause),
      gate.submitOrder(request),
    ]);
    expect(pauseWrite.status).toBe('inserted');
    expect([
      ['accepted', open.decisionId],
      ['rejected', pause.decisionId],
    ]).toContainEqual([admission.order.status, admission.order.decisionId]);
    expect(admission.order.status === 'accepted').toBe(
      admission.order.marketState === 'OPEN',
    );
    await expect(requireStore().loadMarketControlState(marketId)).resolves.toMatchObject({
      lastDecisionId: pause.decisionId,
      state: 'PAUSED',
    });
  });

  it('replays a risk window from accepted to rejected and back to accepted', async () => {
    const initialOdds = normalizeOdds({ MessageId: 'replay-open' });
    const score = normalizeScore({ away: 0, home: 1, seq: 2, source: 'txline-live' });
    await requireStore().appendEvent({
      event: initialOdds.event,
      raw: initialOdds.raw,
    });
    await requireStore().appendEvent({ event: score.event, raw: score.raw });
    if (
      initialOdds.event.kind !== 'odds.observed' ||
      score.event.kind !== 'score.observed'
    )
      return;
    const marketId = initialOdds.event.payload.market.marketId;
    const baseMs = initialOdds.event.sourceTimestampMs;
    const engine = new DeterministicRiskEngine();
    const gate = new PostgresSimulatedMarketControl(client!, { clock });
    const open = engine.evaluate({
      features: healthyRiskFeatures,
      fixtureId: initialOdds.event.fixtureId,
      logicalTimestampMs: baseMs,
      marketId,
      proofStatus: 'verified',
      triggerEventId: initialOdds.event.eventId,
    });
    if (!open.decision) return;
    await requireStore().appendDecision(open.decision);
    const before = await gate.submitOrder(
      orderRequest({
        decisionId: open.decision.decisionId,
        idempotencyKey: 'replay-before-shock',
        marketId,
        namespace: 'replay:unsafe-recovery',
        stateVersion: open.state.stateVersion,
      }),
    );

    const shock = engine.evaluate({
      features: healthyRiskFeatures,
      fixtureId: score.event.fixtureId,
      logicalTimestampMs: baseMs + 1_000,
      marketId,
      proofStatus: 'verified',
      scoreEvent: score.event,
      triggerEventId: score.event.eventId,
    });
    if (!shock.decision) return;
    await requireStore().appendDecision(shock.decision);
    const during = await gate.submitOrder(
      orderRequest({
        decisionId: shock.decision.decisionId,
        idempotencyKey: 'replay-during-shock',
        marketId,
        namespace: 'replay:unsafe-recovery',
        stateVersion: shock.state.stateVersion,
      }),
    );

    let latestDecision = shock.decision;
    let latestState = shock.state;
    for (const [offsetMs, messageId] of [
      [9_000, 'recovery-1'],
      [12_000, 'recovery-2'],
      [13_000, 'recovery-3'],
    ] as const) {
      const odds = normalizeOdds({ MessageId: messageId, Ts: baseMs + offsetMs });
      await requireStore().appendEvent({ event: odds.event, raw: odds.raw });
      const recovery = engine.evaluate({
        features: healthyRiskFeatures,
        fixtureId: initialOdds.event.fixtureId,
        logicalTimestampMs: baseMs + offsetMs,
        marketId,
        proofStatus: 'verified',
        triggerEventId: odds.event.eventId,
      });
      if (!recovery.decision) return;
      latestDecision = recovery.decision;
      latestState = recovery.state;
      await requireStore().appendDecision(recovery.decision);
    }
    const after = await gate.submitOrder(
      orderRequest({
        decisionId: latestDecision.decisionId,
        idempotencyKey: 'replay-after-recovery',
        marketId,
        namespace: 'replay:unsafe-recovery',
        stateVersion: latestState.stateVersion,
      }),
    );

    expect([before.order.status, during.order.status, after.order.status]).toEqual([
      'accepted',
      'rejected',
      'accepted',
    ]);
    expect([open.state.state, shock.state.state, latestState.state]).toEqual([
      'OPEN',
      'PAUSED',
      'OPEN',
    ]);
    expect(
      [before, during, after].every(
        ({ order }) => order.namespace === 'replay:unsafe-recovery',
      ),
    ).toBe(true);
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
