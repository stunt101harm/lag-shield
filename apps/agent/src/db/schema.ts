import type {
  DecisionReceipt,
  JsonValue,
  NormalizedDomainEvent,
  ReplayManifest,
  ReplayRun,
  SimulatedOrder,
  StrategyDecision,
} from '@lagshield/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const ingestStatus = pgEnum('ingest_status', ['accepted', 'quarantined']);
export const eventSource = pgEnum('event_source', [
  'txline-historical',
  'txline-snapshot',
  'txline-live',
  'simulation',
]);
export const eventKind = pgEnum('event_kind', [
  'fixture.observed',
  'odds.observed',
  'score.observed',
]);
export const fixtureStatus = pgEnum('fixture_status', [
  'scheduled',
  'live',
  'finished',
  'cancelled',
  'unknown',
]);
export const marketStatus = pgEnum('market_status', ['open', 'suspended']);
export const marketControlState = pgEnum('market_control_state', [
  'OPEN',
  'WIDENED',
  'PAUSED',
  'RECOVERY',
]);
export const decisionAction = pgEnum('decision_action', [
  'none',
  'widen',
  'pause',
  'begin_recovery',
  'reopen',
]);
export const receiptStatus = pgEnum('receipt_status', ['pending', 'verified', 'failed']);
export const replayStatus = pgEnum('replay_status', [
  'pending',
  'running',
  'completed',
  'failed',
]);
export const orderSide = pgEnum('order_side', ['back', 'lay']);
export const orderStatus = pgEnum('order_status', [
  'accepted',
  'rejected',
  'stale',
  'settled',
  'cancelled',
]);
export const orderSettlement = pgEnum('order_settlement', ['won', 'lost', 'void']);

export const systemMetadata = pgTable('system_metadata', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<JsonValue>().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rawIngestRecords = pgTable(
  'raw_ingest_records',
  {
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    fixtureId: text('fixture_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    ingestId: text('ingest_id').primaryKey(),
    payloadKind: text('payload_kind').notNull(),
    payloadRetained: boolean('payload_retained').notNull().default(true),
    payloadVersion: integer('payload_version').notNull(),
    quarantineCode: text('quarantine_code'),
    quarantineIssues: jsonb('quarantine_issues').$type<readonly string[]>(),
    rawPayload: jsonb('raw_payload').$type<JsonValue>(),
    rawPayloadHash: text('raw_payload_hash'),
    receivedAtMs: bigint('received_at_ms', { mode: 'number' }).notNull(),
    retentionExpiresAtMs: bigint('retention_expires_at_ms', { mode: 'number' }),
    source: eventSource('source').notNull(),
    sourceId: text('source_id').notNull(),
    sourceTimestampMs: bigint('source_timestamp_ms', { mode: 'number' }),
    status: ingestStatus('status').notNull(),
  },
  (table) => [
    check('raw_ingest_payload_version_check', sql`${table.payloadVersion} > 0`),
    check('raw_ingest_received_at_check', sql`${table.receivedAtMs} >= 0`),
    check(
      'raw_ingest_payload_retention_check',
      sql`(${table.payloadRetained} AND ${table.rawPayload} IS NOT NULL)
        OR (NOT ${table.payloadRetained} AND ${table.rawPayload} IS NULL AND ${table.rawPayloadHash} IS NOT NULL)`,
    ),
    check(
      'raw_ingest_payload_hash_check',
      sql`${table.rawPayloadHash} IS NULL OR ${table.rawPayloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'raw_ingest_retention_expiry_check',
      sql`${table.retentionExpiresAtMs} IS NULL OR ${table.retentionExpiresAtMs} >= ${table.receivedAtMs}`,
    ),
    check(
      'raw_ingest_source_timestamp_check',
      sql`${table.sourceTimestampMs} IS NULL OR ${table.sourceTimestampMs} >= 0`,
    ),
    uniqueIndex('raw_ingest_idempotency_uidx').on(table.idempotencyKey),
    index('raw_ingest_status_received_idx').on(table.status, table.receivedAtMs),
    index('raw_ingest_fixture_received_idx').on(table.fixtureId, table.receivedAtMs),
    index('raw_ingest_retention_idx').on(
      table.payloadRetained,
      table.retentionExpiresAtMs,
    ),
  ],
);

export const domainEvents = pgTable(
  'domain_events',
  {
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    eventId: text('event_id').primaryKey(),
    fixtureId: text('fixture_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    kind: eventKind('kind').notNull(),
    payload: jsonb('payload').$type<NormalizedDomainEvent['payload']>().notNull(),
    payloadVersion: integer('payload_version').notNull(),
    rawIngestId: text('raw_ingest_id')
      .notNull()
      .references(() => rawIngestRecords.ingestId, { onDelete: 'restrict' }),
    receivedAtMs: bigint('received_at_ms', { mode: 'number' }).notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    source: eventSource('source').notNull(),
    sourceId: text('source_id').notNull(),
    sourcePriority: integer('source_priority').notNull(),
    sourceTimestampMs: bigint('source_timestamp_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check('domain_events_payload_version_check', sql`${table.payloadVersion} > 0`),
    check('domain_events_received_at_check', sql`${table.receivedAtMs} >= 0`),
    check('domain_events_sequence_check', sql`${table.sequence} >= 0`),
    check('domain_events_source_timestamp_check', sql`${table.sourceTimestampMs} >= 0`),
    check(
      'domain_events_source_priority_check',
      sql`(${table.source} = 'simulation' AND ${table.sourcePriority} = 0)
        OR (${table.source} = 'txline-historical' AND ${table.sourcePriority} = 10)
        OR (${table.source} = 'txline-snapshot' AND ${table.sourcePriority} = 20)
        OR (${table.source} = 'txline-live' AND ${table.sourcePriority} = 30)`,
    ),
    uniqueIndex('domain_events_idempotency_uidx').on(table.idempotencyKey),
    uniqueIndex('domain_events_raw_ingest_uidx').on(table.rawIngestId),
    index('domain_events_fixture_order_idx').on(
      table.fixtureId,
      table.sourceTimestampMs,
      table.sequence,
      table.sourcePriority,
      table.sourceId,
      table.idempotencyKey,
      table.eventId,
    ),
    index('domain_events_kind_received_idx').on(table.kind, table.receivedAtMs),
  ],
);

export const fixtures = pgTable(
  'fixtures',
  {
    competition: text('competition').notNull(),
    competitionId: text('competition_id').notNull(),
    fixtureId: text('fixture_id').primaryKey(),
    lastEventId: text('last_event_id')
      .notNull()
      .references(() => domainEvents.eventId, { onDelete: 'restrict' }),
    lastIdempotencyKey: text('last_idempotency_key').notNull(),
    lastSequence: bigint('last_sequence', { mode: 'number' }).notNull(),
    lastSourceId: text('last_source_id').notNull(),
    lastSourcePriority: integer('last_source_priority').notNull(),
    lastSourceTimestampMs: bigint('last_source_timestamp_ms', {
      mode: 'number',
    }).notNull(),
    participants: jsonb('participants')
      .$type<
        Extract<
          NormalizedDomainEvent,
          { kind: 'fixture.observed' }
        >['payload']['participants']
      >()
      .notNull(),
    scheduledAtMs: bigint('scheduled_at_ms', { mode: 'number' }).notNull(),
    status: fixtureStatus('status').notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check('fixtures_scheduled_at_check', sql`${table.scheduledAtMs} >= 0`),
    check('fixtures_updated_at_check', sql`${table.updatedAtMs} >= 0`),
    index('fixtures_status_scheduled_idx').on(table.status, table.scheduledAtMs),
    index('fixtures_competition_scheduled_idx').on(
      table.competitionId,
      table.scheduledAtMs,
    ),
  ],
);

export const markets = pgTable(
  'markets',
  {
    fixtureId: text('fixture_id').notNull(),
    gameState: text('game_state'),
    inRunning: boolean('in_running').notNull(),
    lastEventId: text('last_event_id')
      .notNull()
      .references(() => domainEvents.eventId, { onDelete: 'restrict' }),
    lastIdempotencyKey: text('last_idempotency_key').notNull(),
    lastSequence: bigint('last_sequence', { mode: 'number' }).notNull(),
    lastSourceId: text('last_source_id').notNull(),
    lastSourcePriority: integer('last_source_priority').notNull(),
    lastSourceTimestampMs: bigint('last_source_timestamp_ms', {
      mode: 'number',
    }).notNull(),
    marketId: text('market_id').primaryKey(),
    marketType: text('market_type').notNull(),
    parameters: text('parameters'),
    period: text('period'),
    status: marketStatus('status').notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check('markets_updated_at_check', sql`${table.updatedAtMs} >= 0`),
    index('markets_fixture_status_idx').on(table.fixtureId, table.status),
    index('markets_fixture_updated_idx').on(table.fixtureId, table.updatedAtMs),
  ],
);

export const outcomeQuoteObservations = pgTable(
  'outcome_quote_observations',
  {
    bookmakerId: text('bookmaker_id').notNull(),
    bookmakerName: text('bookmaker_name').notNull(),
    eventId: text('event_id')
      .notNull()
      .references(() => domainEvents.eventId, { onDelete: 'restrict' }),
    fixtureId: text('fixture_id').notNull(),
    marketId: text('market_id').notNull(),
    outcomeId: text('outcome_id').notNull(),
    outcomeName: text('outcome_name').notNull(),
    price: integer('price').notNull(),
    priceEncoding: text('price_encoding').notNull(),
    probabilityEncoding: text('probability_encoding'),
    receivedAtMs: bigint('received_at_ms', { mode: 'number' }).notNull(),
    reportedProbabilityMicros: integer('reported_probability_micros'),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    source: eventSource('source').notNull(),
    sourceId: text('source_id').notNull(),
    sourcePriority: integer('source_priority').notNull(),
    sourceTimestampMs: bigint('source_timestamp_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check('quotes_received_at_check', sql`${table.receivedAtMs} >= 0`),
    check(
      'quotes_reported_probability_check',
      sql`${table.reportedProbabilityMicros} IS NULL OR (${table.reportedProbabilityMicros} >= 0 AND ${table.reportedProbabilityMicros} <= 1000000)`,
    ),
    check('quotes_sequence_check', sql`${table.sequence} >= 0`),
    check('quotes_source_timestamp_check', sql`${table.sourceTimestampMs} >= 0`),
    primaryKey({ columns: [table.eventId, table.outcomeId] }),
    index('quotes_market_outcome_time_idx').on(
      table.marketId,
      table.outcomeId,
      table.sourceTimestampMs.desc(),
    ),
    index('quotes_fixture_time_idx').on(table.fixtureId, table.sourceTimestampMs.desc()),
    index('quotes_bookmaker_time_idx').on(
      table.bookmakerId,
      table.sourceTimestampMs.desc(),
    ),
  ],
);

export const scoreEvents = pgTable(
  'score_events',
  {
    action: text('action').notNull(),
    actionId: text('action_id'),
    awayScore: integer('away_score'),
    confirmed: boolean('confirmed'),
    details: jsonb('details').$type<JsonValue>(),
    eventId: text('event_id')
      .primaryKey()
      .references(() => domainEvents.eventId, { onDelete: 'restrict' }),
    fixtureId: text('fixture_id').notNull(),
    homeScore: integer('home_score'),
    period: integer('period'),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    sourcePriority: integer('source_priority').notNull(),
    sourceTimestampMs: bigint('source_timestamp_ms', { mode: 'number' }).notNull(),
    stats: jsonb('stats')
      .$type<
        Extract<NormalizedDomainEvent, { kind: 'score.observed' }>['payload']['stats']
      >()
      .notNull(),
    statusId: integer('status_id'),
  },
  (table) => [
    check(
      'score_events_home_score_check',
      sql`${table.homeScore} IS NULL OR ${table.homeScore} >= 0`,
    ),
    check(
      'score_events_away_score_check',
      sql`${table.awayScore} IS NULL OR ${table.awayScore} >= 0`,
    ),
    check('score_events_sequence_check', sql`${table.sequence} >= 0`),
    check('score_events_source_timestamp_check', sql`${table.sourceTimestampMs} >= 0`),
    index('score_events_fixture_order_idx').on(
      table.fixtureId,
      table.sourceTimestampMs,
      table.sequence,
      table.eventId,
    ),
    index('score_events_fixture_action_idx').on(table.fixtureId, table.action),
  ],
);

export const fixtureScoreState = pgTable(
  'fixture_score_state',
  {
    action: text('action').notNull(),
    actionId: text('action_id'),
    awayScore: integer('away_score'),
    confirmed: boolean('confirmed'),
    details: jsonb('details').$type<JsonValue>(),
    fixtureId: text('fixture_id').primaryKey(),
    homeScore: integer('home_score'),
    lastEventId: text('last_event_id')
      .notNull()
      .references(() => domainEvents.eventId, { onDelete: 'restrict' }),
    lastIdempotencyKey: text('last_idempotency_key').notNull(),
    lastSequence: bigint('last_sequence', { mode: 'number' }).notNull(),
    lastSourceId: text('last_source_id').notNull(),
    lastSourcePriority: integer('last_source_priority').notNull(),
    lastSourceTimestampMs: bigint('last_source_timestamp_ms', {
      mode: 'number',
    }).notNull(),
    period: integer('period'),
    statusId: integer('status_id'),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check(
      'fixture_score_home_check',
      sql`${table.homeScore} IS NULL OR ${table.homeScore} >= 0`,
    ),
    check(
      'fixture_score_away_check',
      sql`${table.awayScore} IS NULL OR ${table.awayScore} >= 0`,
    ),
    check('fixture_score_updated_at_check', sql`${table.updatedAtMs} >= 0`),
  ],
);

export const strategyDecisions = pgTable(
  'strategy_decisions',
  {
    action: decisionAction('action').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    decisionId: text('decision_id').primaryKey(),
    expectedStateVersion: integer('expected_state_version').notNull(),
    fixtureId: text('fixture_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    logicalTimestampMs: bigint('logical_timestamp_ms', { mode: 'number' }).notNull(),
    marketId: text('market_id').notNull(),
    metrics: jsonb('metrics').$type<Record<string, number>>().notNull(),
    nextState: marketControlState('next_state').notNull(),
    payload: jsonb('payload').$type<StrategyDecision>().notNull(),
    payloadVersion: integer('payload_version').notNull(),
    policyVersion: text('policy_version').notNull(),
    previousState: marketControlState('previous_state').notNull(),
    reasonCodes: text('reason_codes').array().notNull(),
    triggerEventId: text('trigger_event_id')
      .notNull()
      .references(() => domainEvents.eventId, { onDelete: 'restrict' }),
  },
  (table) => [
    check(
      'strategy_decisions_state_version_check',
      sql`${table.expectedStateVersion} >= 0`,
    ),
    check(
      'strategy_decisions_logical_timestamp_check',
      sql`${table.logicalTimestampMs} >= 0`,
    ),
    check('strategy_decisions_payload_version_check', sql`${table.payloadVersion} > 0`),
    uniqueIndex('strategy_decisions_idempotency_uidx').on(table.idempotencyKey),
    index('strategy_decisions_fixture_time_idx').on(
      table.fixtureId,
      table.logicalTimestampMs.desc(),
    ),
    index('strategy_decisions_market_time_idx').on(
      table.marketId,
      table.logicalTimestampMs.desc(),
    ),
    index('strategy_decisions_trigger_idx').on(table.triggerEventId),
  ],
);

export const marketControlStates = pgTable(
  'market_control_states',
  {
    fixtureId: text('fixture_id').notNull(),
    lastDecisionId: text('last_decision_id')
      .notNull()
      .references(() => strategyDecisions.decisionId, { onDelete: 'restrict' }),
    logicalTimestampMs: bigint('logical_timestamp_ms', { mode: 'number' }).notNull(),
    marketId: text('market_id').primaryKey(),
    state: marketControlState('state').notNull(),
    stateVersion: integer('state_version').notNull(),
  },
  (table) => [
    check('market_control_state_version_check', sql`${table.stateVersion} > 0`),
    check(
      'market_control_logical_timestamp_check',
      sql`${table.logicalTimestampMs} >= 0`,
    ),
    index('market_control_fixture_state_idx').on(table.fixtureId, table.state),
  ],
);

export const decisionReceipts = pgTable(
  'decision_receipts',
  {
    anchoredAtMs: bigint('anchored_at_ms', { mode: 'number' }),
    decisionId: text('decision_id')
      .notNull()
      .references(() => strategyDecisions.decisionId, { onDelete: 'restrict' }),
    payload: jsonb('payload').$type<DecisionReceipt>().notNull(),
    payloadHash: text('payload_hash').notNull(),
    proofReference: text('proof_reference'),
    receiptId: text('receipt_id').primaryKey(),
    status: receiptStatus('status').notNull(),
  },
  (table) => [
    check(
      'decision_receipts_anchored_at_check',
      sql`${table.anchoredAtMs} IS NULL OR ${table.anchoredAtMs} >= 0`,
    ),
    uniqueIndex('decision_receipts_decision_uidx').on(table.decisionId),
    index('decision_receipts_status_idx').on(table.status),
  ],
);

export const replayManifests = pgTable(
  'replay_manifests',
  {
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    eventCount: bigint('event_count', { mode: 'number' }).notNull(),
    eventSequenceHash: text('event_sequence_hash').notNull(),
    fixtureId: text('fixture_id').notNull(),
    inputHash: text('input_hash').notNull(),
    manifestId: text('manifest_id').primaryKey(),
    payload: jsonb('payload').$type<ReplayManifest>().notNull(),
    retentionExpiresAtMs: bigint('retention_expires_at_ms', { mode: 'number' }),
    sourceEndMs: bigint('source_end_ms', { mode: 'number' }).notNull(),
    sourceStartMs: bigint('source_start_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check('replay_manifests_created_at_check', sql`${table.createdAtMs} >= 0`),
    check('replay_manifests_event_count_check', sql`${table.eventCount} >= 0`),
    check(
      'replay_manifests_hashes_check',
      sql`${table.inputHash} ~ '^[a-f0-9]{64}$' AND ${table.eventSequenceHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'replay_manifests_source_range_check',
      sql`${table.sourceStartMs} >= 0 AND ${table.sourceEndMs} >= ${table.sourceStartMs}`,
    ),
    check(
      'replay_manifests_retention_check',
      sql`${table.retentionExpiresAtMs} IS NULL OR ${table.retentionExpiresAtMs} >= ${table.createdAtMs}`,
    ),
    index('replay_manifests_fixture_source_idx').on(table.fixtureId, table.sourceStartMs),
  ],
);

export const replayRuns = pgTable(
  'replay_runs',
  {
    completedAtMs: bigint('completed_at_ms', { mode: 'number' }),
    configHash: text('config_hash').notNull(),
    eventCount: bigint('event_count', { mode: 'number' }).notNull(),
    inputFixtureId: text('input_fixture_id').notNull(),
    inputHash: text('input_hash').notNull(),
    lastEventId: text('last_event_id'),
    manifestId: text('manifest_id')
      .notNull()
      .references(() => replayManifests.manifestId, { onDelete: 'restrict' }),
    namespace: text('namespace').notNull(),
    payload: jsonb('payload').$type<ReplayRun>().notNull(),
    runId: text('run_id').primaryKey(),
    speed: text('speed').notNull(),
    startedAtMs: bigint('started_at_ms', { mode: 'number' }).notNull(),
    status: replayStatus('status').notNull(),
  },
  (table) => [
    check('replay_runs_event_count_check', sql`${table.eventCount} >= 0`),
    check(
      'replay_runs_hashes_check',
      sql`${table.configHash} ~ '^[a-f0-9]{64}$' AND ${table.inputHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'replay_runs_namespace_check',
      sql`${table.namespace} = 'replay:' || ${table.runId}`,
    ),
    check(
      'replay_runs_speed_check',
      sql`${table.speed} = 'maximum' OR ${table.speed} ~ '^[0-9]+(\\.[0-9]+)?$'`,
    ),
    check('replay_runs_started_at_check', sql`${table.startedAtMs} >= 0`),
    check(
      'replay_runs_completed_at_check',
      sql`${table.completedAtMs} IS NULL OR ${table.completedAtMs} >= ${table.startedAtMs}`,
    ),
    index('replay_runs_fixture_started_idx').on(
      table.inputFixtureId,
      table.startedAtMs.desc(),
    ),
    index('replay_runs_status_started_idx').on(table.status, table.startedAtMs),
    uniqueIndex('replay_runs_namespace_uidx').on(table.namespace),
  ],
);

export const simulatedOrders = pgTable(
  'simulated_orders',
  {
    admissionLatencyMs: bigint('admission_latency_ms', { mode: 'number' }),
    admissionReasonCode: text('admission_reason_code'),
    circuitBreakerReceiptId: text('circuit_breaker_receipt_id').references(
      () => decisionReceipts.receiptId,
      { onDelete: 'restrict' },
    ),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    decisionId: text('decision_id')
      .notNull()
      .references(() => strategyDecisions.decisionId, { onDelete: 'restrict' }),
    fixtureId: text('fixture_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    marketId: text('market_id').notNull(),
    marketState: marketControlState('market_state'),
    marketStateVersion: integer('market_state_version'),
    namespace: text('namespace').notNull().default('legacy'),
    orderId: text('order_id').primaryKey(),
    outcomeId: text('outcome_id').notNull(),
    payload: jsonb('payload').$type<SimulatedOrder>().notNull(),
    payloadVersion: integer('payload_version').notNull().default(1),
    price: integer('price').notNull(),
    requestHash: text('request_hash'),
    requestedAtMs: bigint('requested_at_ms', { mode: 'number' }),
    settledAtMs: bigint('settled_at_ms', { mode: 'number' }),
    settlement: orderSettlement('settlement'),
    side: orderSide('side').notNull(),
    stakeMicros: bigint('stake_micros', { mode: 'number' }).notNull(),
    status: orderStatus('status').notNull(),
  },
  (table) => [
    check('simulated_orders_created_at_check', sql`${table.createdAtMs} >= 0`),
    check(
      'simulated_orders_admission_latency_check',
      sql`${table.admissionLatencyMs} IS NULL OR ${table.admissionLatencyMs} >= 0`,
    ),
    check(
      'simulated_orders_market_state_version_check',
      sql`${table.marketStateVersion} IS NULL OR ${table.marketStateVersion} > 0`,
    ),
    check('simulated_orders_payload_version_check', sql`${table.payloadVersion} > 0`),
    check(
      'simulated_orders_v2_audit_fields_check',
      sql`${table.payloadVersion} < 2 OR (
        ${table.admissionLatencyMs} IS NOT NULL AND
        ${table.admissionReasonCode} IS NOT NULL AND
        ${table.circuitBreakerReceiptId} IS NOT NULL AND
        ${table.marketState} IS NOT NULL AND
        ${table.marketStateVersion} IS NOT NULL AND
        ${table.requestHash} IS NOT NULL AND
        ${table.requestedAtMs} IS NOT NULL
      )`,
    ),
    check('simulated_orders_stake_check', sql`${table.stakeMicros} > 0`),
    check(
      'simulated_orders_settled_at_check',
      sql`${table.settledAtMs} IS NULL OR ${table.settledAtMs} >= ${table.createdAtMs}`,
    ),
    check(
      'simulated_orders_requested_at_check',
      sql`${table.requestedAtMs} IS NULL OR ${table.requestedAtMs} <= ${table.createdAtMs}`,
    ),
    uniqueIndex('simulated_orders_namespace_idempotency_uidx').on(
      table.namespace,
      table.idempotencyKey,
    ),
    index('simulated_orders_fixture_time_idx').on(
      table.fixtureId,
      table.createdAtMs.desc(),
    ),
    index('simulated_orders_market_time_idx').on(
      table.marketId,
      table.createdAtMs.desc(),
    ),
    index('simulated_orders_status_time_idx').on(table.status, table.createdAtMs),
  ],
);
