import {
  assertBoundedQueryLimit,
  buildRawIngestId,
  canonicalJson,
  normalizedDomainEventSchema,
  strategyDecisionSchema,
  toJsonValue,
  type AppendResult,
  type DomainStore,
  type FixtureEventPage,
  type JsonValue,
  type MarketControlSnapshot,
  type NormalizedDomainEvent,
  type QuarantineInput,
  type RawIngestInput,
  type StrategyDecision,
} from '@lagshield/core';
import type postgres from 'postgres';

import type { DatabaseClient } from './client.js';

type Transaction = postgres.TransactionSql;

export class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was reused for a different payload.`);
    this.name = 'IdempotencyConflictError';
  }
}

export class ConcurrentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentStateError';
  }
}

function jsonParameter(value: JsonValue): string {
  return JSON.stringify(value);
}

function assertRawIdentity(raw: RawIngestInput): void {
  if (buildRawIngestId(raw.idempotencyKey) !== raw.ingestId) {
    throw new Error('Raw ingest identity is not canonical.');
  }
}

function assertEventMatchesRaw(event: NormalizedDomainEvent, raw: RawIngestInput): void {
  const mismatches = [
    event.fixtureId !== raw.fixtureId,
    event.payloadVersion !== raw.payloadVersion,
    event.receivedAtMs !== raw.receivedAtMs,
    event.source !== raw.source,
    event.sourceId !== raw.sourceId,
    event.sourceTimestampMs !== raw.sourceTimestampMs,
  ];
  if (mismatches.some(Boolean)) {
    throw new Error('Normalized event metadata does not match its raw ingest record.');
  }
}

async function existingRawMatches(
  sql: Transaction,
  raw: RawIngestInput,
): Promise<boolean> {
  const rows = await sql<{ raw_payload: unknown }[]>`
    SELECT raw_payload
    FROM raw_ingest_records
    WHERE idempotency_key = ${raw.idempotencyKey}
  `;
  const existing = rows[0];
  if (!existing) return false;
  return (
    canonicalJson(toJsonValue(existing.raw_payload)) === canonicalJson(raw.rawPayload)
  );
}

async function insertRaw(
  sql: Transaction,
  raw: RawIngestInput,
  options:
    | Readonly<{ status: 'accepted' }>
    | Readonly<{
        code: QuarantineInput['code'];
        issues: readonly string[];
        status: 'quarantined';
      }>,
): Promise<boolean> {
  const quarantineCode = options.status === 'quarantined' ? options.code : null;
  const quarantineIssues =
    options.status === 'quarantined' ? jsonParameter([...options.issues]) : null;
  const inserted = await sql<{ ingest_id: string }[]>`
    INSERT INTO raw_ingest_records (
      ingest_id,
      idempotency_key,
      source,
      source_id,
      fixture_id,
      payload_kind,
      payload_version,
      source_timestamp_ms,
      received_at_ms,
      raw_payload,
      status,
      quarantine_code,
      quarantine_issues
    ) VALUES (
      ${raw.ingestId},
      ${raw.idempotencyKey},
      ${raw.source},
      ${raw.sourceId},
      ${raw.fixtureId},
      ${raw.payloadKind},
      ${raw.payloadVersion},
      ${raw.sourceTimestampMs},
      ${raw.receivedAtMs},
      ${jsonParameter(raw.rawPayload)}::jsonb,
      ${options.status},
      ${quarantineCode},
      ${quarantineIssues}::jsonb
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING ingest_id
  `;
  if (inserted.length > 0) return true;
  if (!(await existingRawMatches(sql, raw))) {
    throw new IdempotencyConflictError(raw.idempotencyKey);
  }
  return false;
}

function orderColumns(event: NormalizedDomainEvent) {
  return {
    eventId: event.eventId,
    idempotencyKey: event.idempotencyKey,
    sequence: event.sequence,
    sourceId: event.sourceId,
    sourcePriority: event.sourcePriority,
    sourceTimestampMs: event.sourceTimestampMs,
  };
}

async function applyFixtureProjection(
  sql: Transaction,
  event: Extract<NormalizedDomainEvent, { kind: 'fixture.observed' }>,
): Promise<void> {
  const order = orderColumns(event);
  await sql`
    INSERT INTO fixtures (
      fixture_id,
      competition_id,
      competition,
      participants,
      scheduled_at_ms,
      status,
      last_event_id,
      last_source_timestamp_ms,
      last_sequence,
      last_source_priority,
      last_source_id,
      last_idempotency_key,
      updated_at_ms
    ) VALUES (
      ${event.fixtureId},
      ${event.payload.competitionId},
      ${event.payload.competition},
      ${jsonParameter(event.payload.participants)}::jsonb,
      ${event.payload.scheduledAtMs},
      ${event.payload.status},
      ${event.eventId},
      ${order.sourceTimestampMs},
      ${order.sequence},
      ${order.sourcePriority},
      ${order.sourceId},
      ${order.idempotencyKey},
      ${event.receivedAtMs}
    )
    ON CONFLICT (fixture_id) DO UPDATE SET
      competition_id = EXCLUDED.competition_id,
      competition = EXCLUDED.competition,
      participants = EXCLUDED.participants,
      scheduled_at_ms = EXCLUDED.scheduled_at_ms,
      status = EXCLUDED.status,
      last_event_id = EXCLUDED.last_event_id,
      last_source_timestamp_ms = EXCLUDED.last_source_timestamp_ms,
      last_sequence = EXCLUDED.last_sequence,
      last_source_priority = EXCLUDED.last_source_priority,
      last_source_id = EXCLUDED.last_source_id,
      last_idempotency_key = EXCLUDED.last_idempotency_key,
      updated_at_ms = EXCLUDED.updated_at_ms
    WHERE (
      EXCLUDED.last_source_timestamp_ms,
      EXCLUDED.last_sequence,
      EXCLUDED.last_source_priority,
      EXCLUDED.last_source_id,
      EXCLUDED.last_idempotency_key,
      EXCLUDED.last_event_id
    ) > (
      fixtures.last_source_timestamp_ms,
      fixtures.last_sequence,
      fixtures.last_source_priority,
      fixtures.last_source_id,
      fixtures.last_idempotency_key,
      fixtures.last_event_id
    )
  `;
}

async function applyOddsProjection(
  sql: Transaction,
  event: Extract<NormalizedDomainEvent, { kind: 'odds.observed' }>,
): Promise<void> {
  const order = orderColumns(event);
  const market = event.payload.market;
  await sql`
    INSERT INTO markets (
      market_id,
      fixture_id,
      market_type,
      period,
      parameters,
      game_state,
      in_running,
      status,
      last_event_id,
      last_source_timestamp_ms,
      last_sequence,
      last_source_priority,
      last_source_id,
      last_idempotency_key,
      updated_at_ms
    ) VALUES (
      ${market.marketId},
      ${event.fixtureId},
      ${market.type},
      ${market.period},
      ${market.parameters},
      ${market.gameState},
      ${market.inRunning},
      ${market.status},
      ${event.eventId},
      ${order.sourceTimestampMs},
      ${order.sequence},
      ${order.sourcePriority},
      ${order.sourceId},
      ${order.idempotencyKey},
      ${event.receivedAtMs}
    )
    ON CONFLICT (market_id) DO UPDATE SET
      fixture_id = EXCLUDED.fixture_id,
      market_type = EXCLUDED.market_type,
      period = EXCLUDED.period,
      parameters = EXCLUDED.parameters,
      game_state = EXCLUDED.game_state,
      in_running = EXCLUDED.in_running,
      status = EXCLUDED.status,
      last_event_id = EXCLUDED.last_event_id,
      last_source_timestamp_ms = EXCLUDED.last_source_timestamp_ms,
      last_sequence = EXCLUDED.last_sequence,
      last_source_priority = EXCLUDED.last_source_priority,
      last_source_id = EXCLUDED.last_source_id,
      last_idempotency_key = EXCLUDED.last_idempotency_key,
      updated_at_ms = EXCLUDED.updated_at_ms
    WHERE (
      EXCLUDED.last_source_timestamp_ms,
      EXCLUDED.last_sequence,
      EXCLUDED.last_source_priority,
      EXCLUDED.last_source_id,
      EXCLUDED.last_idempotency_key,
      EXCLUDED.last_event_id
    ) > (
      markets.last_source_timestamp_ms,
      markets.last_sequence,
      markets.last_source_priority,
      markets.last_source_id,
      markets.last_idempotency_key,
      markets.last_event_id
    )
  `;

  for (const outcome of event.payload.outcomes) {
    await sql`
      INSERT INTO outcome_quote_observations (
        event_id,
        fixture_id,
        market_id,
        bookmaker_id,
        bookmaker_name,
        outcome_id,
        outcome_name,
        price,
        price_encoding,
        source,
        source_id,
        source_timestamp_ms,
        received_at_ms,
        sequence,
        source_priority
      ) VALUES (
        ${event.eventId},
        ${event.fixtureId},
        ${market.marketId},
        ${event.payload.bookmaker.id},
        ${event.payload.bookmaker.name},
        ${outcome.outcomeId},
        ${outcome.name},
        ${outcome.price},
        ${event.payload.priceEncoding},
        ${event.source},
        ${event.sourceId},
        ${event.sourceTimestampMs},
        ${event.receivedAtMs},
        ${event.sequence},
        ${event.sourcePriority}
      )
      ON CONFLICT (event_id, outcome_id) DO NOTHING
    `;
  }
}

async function applyScoreProjection(
  sql: Transaction,
  event: Extract<NormalizedDomainEvent, { kind: 'score.observed' }>,
): Promise<void> {
  const order = orderColumns(event);
  const payload = event.payload;
  await sql`
    INSERT INTO score_events (
      event_id,
      fixture_id,
      action,
      period,
      status_id,
      home_score,
      away_score,
      stats,
      source_timestamp_ms,
      sequence,
      source_priority
    ) VALUES (
      ${event.eventId},
      ${event.fixtureId},
      ${payload.action},
      ${payload.period},
      ${payload.statusId},
      ${payload.homeScore},
      ${payload.awayScore},
      ${jsonParameter(payload.stats)}::jsonb,
      ${event.sourceTimestampMs},
      ${event.sequence},
      ${event.sourcePriority}
    )
    ON CONFLICT (event_id) DO NOTHING
  `;
  await sql`
    INSERT INTO fixture_score_state (
      fixture_id,
      action,
      period,
      status_id,
      home_score,
      away_score,
      last_event_id,
      last_source_timestamp_ms,
      last_sequence,
      last_source_priority,
      last_source_id,
      last_idempotency_key,
      updated_at_ms
    ) VALUES (
      ${event.fixtureId},
      ${payload.action},
      ${payload.period},
      ${payload.statusId},
      ${payload.homeScore},
      ${payload.awayScore},
      ${event.eventId},
      ${order.sourceTimestampMs},
      ${order.sequence},
      ${order.sourcePriority},
      ${order.sourceId},
      ${order.idempotencyKey},
      ${event.receivedAtMs}
    )
    ON CONFLICT (fixture_id) DO UPDATE SET
      action = EXCLUDED.action,
      period = EXCLUDED.period,
      status_id = EXCLUDED.status_id,
      home_score = EXCLUDED.home_score,
      away_score = EXCLUDED.away_score,
      last_event_id = EXCLUDED.last_event_id,
      last_source_timestamp_ms = EXCLUDED.last_source_timestamp_ms,
      last_sequence = EXCLUDED.last_sequence,
      last_source_priority = EXCLUDED.last_source_priority,
      last_source_id = EXCLUDED.last_source_id,
      last_idempotency_key = EXCLUDED.last_idempotency_key,
      updated_at_ms = EXCLUDED.updated_at_ms
    WHERE (
      EXCLUDED.last_source_timestamp_ms,
      EXCLUDED.last_sequence,
      EXCLUDED.last_source_priority,
      EXCLUDED.last_source_id,
      EXCLUDED.last_idempotency_key,
      EXCLUDED.last_event_id
    ) > (
      fixture_score_state.last_source_timestamp_ms,
      fixture_score_state.last_sequence,
      fixture_score_state.last_source_priority,
      fixture_score_state.last_source_id,
      fixture_score_state.last_idempotency_key,
      fixture_score_state.last_event_id
    )
  `;
}

async function applyProjection(
  sql: Transaction,
  event: NormalizedDomainEvent,
): Promise<void> {
  switch (event.kind) {
    case 'fixture.observed':
      await applyFixtureProjection(sql, event);
      return;
    case 'odds.observed':
      await applyOddsProjection(sql, event);
      return;
    case 'score.observed':
      await applyScoreProjection(sql, event);
      return;
  }
}

type EventRow = {
  event_id: string;
  fixture_id: string;
  idempotency_key: string;
  kind: NormalizedDomainEvent['kind'];
  payload: unknown;
  payload_version: number;
  received_at_ms: string | number;
  sequence: string | number;
  source: NormalizedDomainEvent['source'];
  source_id: string;
  source_priority: number;
  source_timestamp_ms: string | number;
};

function eventFromRow(row: EventRow): NormalizedDomainEvent {
  return normalizedDomainEventSchema.parse({
    eventId: row.event_id,
    fixtureId: row.fixture_id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    payload: row.payload,
    payloadVersion: row.payload_version,
    receivedAtMs: Number(row.received_at_ms),
    sequence: Number(row.sequence),
    source: row.source,
    sourceId: row.source_id,
    sourcePriority: row.source_priority,
    sourceTimestampMs: Number(row.source_timestamp_ms),
  });
}

export class PostgresDomainStore implements DomainStore {
  constructor(private readonly sql: DatabaseClient) {}

  async appendEvent(
    input: Readonly<{
      event: NormalizedDomainEvent;
      raw: RawIngestInput;
    }>,
  ): Promise<AppendResult> {
    const event = normalizedDomainEventSchema.parse(input.event);
    assertRawIdentity(input.raw);
    assertEventMatchesRaw(event, input.raw);

    return this.sql.begin(async (transaction) => {
      const rawInserted = await insertRaw(transaction, input.raw, { status: 'accepted' });
      if (!rawInserted) {
        return { recordId: event.eventId, status: 'duplicate' } as const;
      }

      const inserted = await transaction<{ event_id: string }[]>`
        INSERT INTO domain_events (
          event_id,
          idempotency_key,
          raw_ingest_id,
          fixture_id,
          kind,
          source,
          source_id,
          source_timestamp_ms,
          received_at_ms,
          sequence,
          source_priority,
          payload_version,
          payload
        ) VALUES (
          ${event.eventId},
          ${event.idempotencyKey},
          ${input.raw.ingestId},
          ${event.fixtureId},
          ${event.kind},
          ${event.source},
          ${event.sourceId},
          ${event.sourceTimestampMs},
          ${event.receivedAtMs},
          ${event.sequence},
          ${event.sourcePriority},
          ${event.payloadVersion},
          ${jsonParameter(toJsonValue(event.payload))}::jsonb
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING event_id
      `;
      if (inserted.length === 0) {
        throw new IdempotencyConflictError(event.idempotencyKey);
      }

      await applyProjection(transaction, event);
      return { recordId: event.eventId, status: 'inserted' } as const;
    });
  }

  async quarantine(input: QuarantineInput): Promise<AppendResult> {
    assertRawIdentity(input);
    return this.sql.begin(async (transaction) => {
      const inserted = await insertRaw(transaction, input, {
        code: input.code,
        issues: input.issues,
        status: 'quarantined',
      });
      return {
        recordId: input.ingestId,
        status: inserted ? 'quarantined' : 'duplicate',
      } as const;
    });
  }

  async appendDecision(input: StrategyDecision): Promise<AppendResult> {
    const decision = strategyDecisionSchema.parse(input);
    return this.sql.begin(async (transaction) => {
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${decision.marketId}, 0))
      `;
      const duplicate = await transaction<{ decision_id: string; payload: unknown }[]>`
        SELECT decision_id, payload
        FROM strategy_decisions
        WHERE idempotency_key = ${decision.idempotencyKey}
      `;
      if (duplicate[0]) {
        if (
          canonicalJson(toJsonValue(duplicate[0].payload)) !==
          canonicalJson(toJsonValue(decision))
        ) {
          throw new IdempotencyConflictError(decision.idempotencyKey);
        }
        return { recordId: duplicate[0].decision_id, status: 'duplicate' } as const;
      }

      const states = await transaction<
        { state: StrategyDecision['previousState']; state_version: number }[]
      >`
        SELECT state, state_version
        FROM market_control_states
        WHERE market_id = ${decision.marketId}
        FOR UPDATE
      `;
      const current = states[0];
      const currentState = current?.state ?? 'OPEN';
      const currentVersion = current?.state_version ?? 0;
      if (
        decision.previousState !== currentState ||
        decision.expectedStateVersion !== currentVersion
      ) {
        throw new ConcurrentStateError(
          `Expected ${decision.previousState}@${decision.expectedStateVersion}, ` +
            `found ${currentState}@${currentVersion}.`,
        );
      }

      await transaction`
        INSERT INTO strategy_decisions (
          decision_id,
          idempotency_key,
          fixture_id,
          market_id,
          trigger_event_id,
          policy_version,
          payload_version,
          action,
          previous_state,
          next_state,
          reason_codes,
          metrics,
          logical_timestamp_ms,
          expected_state_version,
          payload
        ) VALUES (
          ${decision.decisionId},
          ${decision.idempotencyKey},
          ${decision.fixtureId},
          ${decision.marketId},
          ${decision.triggerEventId},
          ${decision.policyVersion},
          ${decision.payloadVersion},
          ${decision.action},
          ${decision.previousState},
          ${decision.nextState},
          ${transaction.array(decision.reasonCodes)},
          ${jsonParameter(decision.metrics)}::jsonb,
          ${decision.logicalTimestampMs},
          ${decision.expectedStateVersion},
          ${jsonParameter(toJsonValue(decision))}::jsonb
        )
      `;
      const nextVersion = currentVersion + 1;
      await transaction`
        INSERT INTO market_control_states (
          market_id,
          fixture_id,
          state,
          state_version,
          last_decision_id,
          logical_timestamp_ms
        ) VALUES (
          ${decision.marketId},
          ${decision.fixtureId},
          ${decision.nextState},
          ${nextVersion},
          ${decision.decisionId},
          ${decision.logicalTimestampMs}
        )
        ON CONFLICT (market_id) DO UPDATE SET
          fixture_id = EXCLUDED.fixture_id,
          state = EXCLUDED.state,
          state_version = EXCLUDED.state_version,
          last_decision_id = EXCLUDED.last_decision_id,
          logical_timestamp_ms = EXCLUDED.logical_timestamp_ms
      `;
      return { recordId: decision.decisionId, status: 'inserted' } as const;
    });
  }

  async loadMarketControlState(marketId: string): Promise<MarketControlSnapshot | null> {
    const rows = await this.sql<
      {
        fixture_id: string;
        last_decision_id: string;
        logical_timestamp_ms: string | number;
        market_id: string;
        state: MarketControlSnapshot['state'];
        state_version: number;
      }[]
    >`
      SELECT
        fixture_id,
        last_decision_id,
        logical_timestamp_ms,
        market_id,
        state,
        state_version
      FROM market_control_states
      WHERE market_id = ${marketId}
    `;
    const row = rows[0];
    return row
      ? {
          fixtureId: row.fixture_id,
          lastDecisionId: row.last_decision_id,
          logicalTimestampMs: Number(row.logical_timestamp_ms),
          marketId: row.market_id,
          state: row.state,
          stateVersion: row.state_version,
        }
      : null;
  }

  async listFixtureEvents(
    input: Readonly<{
      afterEventId?: string;
      fixtureId: string;
      limit: number;
    }>,
  ): Promise<FixtureEventPage> {
    assertBoundedQueryLimit(input.limit);
    let rows: EventRow[];
    if (input.afterEventId) {
      const cursors = await this.sql<EventRow[]>`
        SELECT
          event_id,
          fixture_id,
          idempotency_key,
          kind,
          payload,
          payload_version,
          received_at_ms,
          sequence,
          source,
          source_id,
          source_priority,
          source_timestamp_ms
        FROM domain_events
        WHERE event_id = ${input.afterEventId} AND fixture_id = ${input.fixtureId}
      `;
      const cursor = cursors[0];
      if (!cursor) throw new Error('Fixture event cursor does not exist.');
      rows = await this.sql<EventRow[]>`
        SELECT
          event_id,
          fixture_id,
          idempotency_key,
          kind,
          payload,
          payload_version,
          received_at_ms,
          sequence,
          source,
          source_id,
          source_priority,
          source_timestamp_ms
        FROM domain_events
        WHERE fixture_id = ${input.fixtureId}
          AND (
            source_timestamp_ms,
            sequence,
            source_priority,
            source_id,
            idempotency_key,
            event_id
          ) > (
            ${cursor.source_timestamp_ms},
            ${cursor.sequence},
            ${cursor.source_priority},
            ${cursor.source_id},
            ${cursor.idempotency_key},
            ${cursor.event_id}
          )
        ORDER BY
          source_timestamp_ms,
          sequence,
          source_priority,
          source_id,
          idempotency_key,
          event_id
        LIMIT ${input.limit + 1}
      `;
    } else {
      rows = await this.sql<EventRow[]>`
        SELECT
          event_id,
          fixture_id,
          idempotency_key,
          kind,
          payload,
          payload_version,
          received_at_ms,
          sequence,
          source,
          source_id,
          source_priority,
          source_timestamp_ms
        FROM domain_events
        WHERE fixture_id = ${input.fixtureId}
        ORDER BY
          source_timestamp_ms,
          sequence,
          source_priority,
          source_id,
          idempotency_key,
          event_id
        LIMIT ${input.limit + 1}
      `;
    }
    const hasMore = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit);
    const events = pageRows.map(eventFromRow);
    return {
      events,
      nextCursor: hasMore ? (events.at(-1)?.eventId ?? null) : null,
    };
  }
}
