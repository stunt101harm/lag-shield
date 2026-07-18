import {
  consensusFormulaVersion,
  createConsensusSnapshot,
  decisionReceiptSchema,
  replayRunSchema,
  simulatedOrderSchema,
  strategyDecisionSchema,
  type BookmakerQuoteVector,
  type Clock,
  type ConsensusSnapshot,
  type DecisionReceipt,
  type ReplayRun,
  type SimulatedOrder,
  type StrategyDecision,
} from '@lagshield/core';

import type { DatabaseClient } from './client.js';

function assertLimit(limit: number, maximum = 100): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`API query limit must be an integer from 1 through ${maximum}.`);
  }
}

export type FixtureSummary = Readonly<{
  competition: string;
  competitionId: string;
  fixtureId: string;
  participants: unknown;
  scheduledAtMs: number;
  score: Readonly<{
    action: string;
    awayScore: number | null;
    confirmed: boolean | null;
    homeScore: number | null;
    period: number | null;
    sourceTimestampMs: number;
  }> | null;
  status: string;
  updatedAtMs: number;
}>;

export type MarketSummary = Readonly<{
  consensus: ConsensusSnapshot | null;
  fixtureId: string;
  gameState: string | null;
  inRunning: boolean;
  marketId: string;
  marketType: string;
  parameters: string | null;
  period: string | null;
  state: Readonly<{
    lastDecisionId: string;
    logicalTimestampMs: number;
    state: string;
    stateVersion: number;
  }> | null;
  status: string;
  updatedAtMs: number;
}>;

export type TimelineItem =
  | Readonly<{
      atMs: number;
      id: string;
      kind: 'decision';
      payload: StrategyDecision;
    }>
  | Readonly<{
      atMs: number;
      id: string;
      kind: 'score';
      payload: unknown;
    }>;

export type JudgeOverview = Readonly<{
  counts: Readonly<{
    decisions: number;
    fixtures: number;
    orders: number;
    pendingProofs: number;
    replayRuns: number;
  }>;
  latestDecision: StrategyDecision | null;
  latestOrder: SimulatedOrder | null;
}>;

export class PostgresJudgeReadStore {
  constructor(
    private readonly sql: DatabaseClient,
    private readonly clock: Clock,
  ) {}

  async readiness(): Promise<Readonly<{ database: 'ready' }>> {
    await this.sql`SELECT 1 AS ready`;
    return { database: 'ready' };
  }

  async overview(): Promise<JudgeOverview> {
    const counts = await this.sql<
      {
        decisions: number;
        fixtures: number;
        orders: number;
        pending_proofs: number;
        replay_runs: number;
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM fixtures) AS fixtures,
        (SELECT count(*)::int FROM strategy_decisions) AS decisions,
        (SELECT count(*)::int FROM simulated_orders) AS orders,
        (SELECT count(*)::int FROM decision_receipts WHERE status = 'pending') AS pending_proofs,
        (SELECT count(*)::int FROM replay_runs) AS replay_runs
    `;
    const decisions = await this.listDecisions({ limit: 1 });
    const orders = await this.listOrders({ limit: 1 });
    return {
      counts: {
        decisions: counts[0]?.decisions ?? 0,
        fixtures: counts[0]?.fixtures ?? 0,
        orders: counts[0]?.orders ?? 0,
        pendingProofs: counts[0]?.pending_proofs ?? 0,
        replayRuns: counts[0]?.replay_runs ?? 0,
      },
      latestDecision: decisions[0] ?? null,
      latestOrder: orders[0] ?? null,
    };
  }

  async listFixtures(
    input: Readonly<{ limit: number; status?: string }>,
  ): Promise<readonly FixtureSummary[]> {
    assertLimit(input.limit);
    const rows = await this.sql<
      {
        action: string | null;
        away_score: number | null;
        competition: string;
        competition_id: string;
        confirmed: boolean | null;
        fixture_id: string;
        home_score: number | null;
        participants: unknown;
        period: number | null;
        scheduled_at_ms: number | string;
        score_timestamp_ms: number | string | null;
        status: string;
        updated_at_ms: number | string;
      }[]
    >`
      SELECT
        fixtures.fixture_id,
        fixtures.competition_id,
        fixtures.competition,
        fixtures.participants,
        fixtures.scheduled_at_ms,
        fixtures.status,
        fixtures.updated_at_ms,
        score.action,
        score.home_score,
        score.away_score,
        score.period,
        score.confirmed,
        score.last_source_timestamp_ms AS score_timestamp_ms
      FROM fixtures
      LEFT JOIN fixture_score_state AS score USING (fixture_id)
      WHERE (${input.status ?? null}::text IS NULL OR fixtures.status::text = ${input.status ?? null})
      ORDER BY fixtures.scheduled_at_ms, fixtures.fixture_id
      LIMIT ${input.limit}
    `;
    return rows.map((row) => ({
      competition: row.competition,
      competitionId: row.competition_id,
      fixtureId: row.fixture_id,
      participants: row.participants,
      scheduledAtMs: Number(row.scheduled_at_ms),
      score:
        row.score_timestamp_ms === null
          ? null
          : {
              action: row.action!,
              awayScore: row.away_score,
              confirmed: row.confirmed,
              homeScore: row.home_score,
              period: row.period,
              sourceTimestampMs: Number(row.score_timestamp_ms),
            },
      status: row.status,
      updatedAtMs: Number(row.updated_at_ms),
    }));
  }

  async loadFixture(fixtureId: string): Promise<Readonly<{
    fixture: FixtureSummary;
    markets: readonly MarketSummary[];
  }> | null> {
    const fixtures = await this.sql<
      {
        action: string | null;
        away_score: number | null;
        competition: string;
        competition_id: string;
        confirmed: boolean | null;
        fixture_id: string;
        home_score: number | null;
        participants: unknown;
        period: number | null;
        scheduled_at_ms: number | string;
        score_timestamp_ms: number | string | null;
        status: string;
        updated_at_ms: number | string;
      }[]
    >`
      SELECT
        fixtures.fixture_id,
        fixtures.competition_id,
        fixtures.competition,
        fixtures.participants,
        fixtures.scheduled_at_ms,
        fixtures.status,
        fixtures.updated_at_ms,
        score.action,
        score.home_score,
        score.away_score,
        score.period,
        score.confirmed,
        score.last_source_timestamp_ms AS score_timestamp_ms
      FROM fixtures
      LEFT JOIN fixture_score_state AS score USING (fixture_id)
      WHERE fixtures.fixture_id = ${fixtureId}
    `;
    const row = fixtures[0];
    if (!row) return null;
    const fixture: FixtureSummary = {
      competition: row.competition,
      competitionId: row.competition_id,
      fixtureId: row.fixture_id,
      participants: row.participants,
      scheduledAtMs: Number(row.scheduled_at_ms),
      score:
        row.score_timestamp_ms === null
          ? null
          : {
              action: row.action!,
              awayScore: row.away_score,
              confirmed: row.confirmed,
              homeScore: row.home_score,
              period: row.period,
              sourceTimestampMs: Number(row.score_timestamp_ms),
            },
      status: row.status,
      updatedAtMs: Number(row.updated_at_ms),
    };
    return { fixture, markets: await this.listMarkets({ fixtureId, limit: 100 }) };
  }

  async listMarkets(
    input: Readonly<{ fixtureId?: string; limit: number }>,
  ): Promise<readonly MarketSummary[]> {
    assertLimit(input.limit);
    const rows = await this.sql<
      {
        fixture_id: string;
        game_state: string | null;
        in_running: boolean;
        last_decision_id: string | null;
        logical_timestamp_ms: number | string | null;
        market_id: string;
        market_type: string;
        parameters: string | null;
        period: string | null;
        state: string | null;
        state_version: number | null;
        status: string;
        updated_at_ms: number | string;
      }[]
    >`
      SELECT
        markets.market_id,
        markets.fixture_id,
        markets.market_type,
        markets.period,
        markets.parameters,
        markets.game_state,
        markets.in_running,
        markets.status,
        markets.updated_at_ms,
        control.state,
        control.state_version,
        control.last_decision_id,
        control.logical_timestamp_ms
      FROM markets
      LEFT JOIN market_control_states AS control USING (market_id)
      WHERE (${input.fixtureId ?? null}::text IS NULL OR markets.fixture_id = ${input.fixtureId ?? null})
      ORDER BY markets.updated_at_ms DESC, markets.market_id
      LIMIT ${input.limit}
    `;
    const output: MarketSummary[] = [];
    for (const row of rows) {
      output.push({
        consensus: await this.marketConsensus(row.market_id),
        fixtureId: row.fixture_id,
        gameState: row.game_state,
        inRunning: row.in_running,
        marketId: row.market_id,
        marketType: row.market_type,
        parameters: row.parameters,
        period: row.period,
        state:
          row.state === null
            ? null
            : {
                lastDecisionId: row.last_decision_id!,
                logicalTimestampMs: Number(row.logical_timestamp_ms),
                state: row.state,
                stateVersion: row.state_version!,
              },
        status: row.status,
        updatedAtMs: Number(row.updated_at_ms),
      });
    }
    return output;
  }

  async marketConsensus(marketId: string): Promise<ConsensusSnapshot | null> {
    const rows = await this.sql<
      {
        bookmaker_id: string;
        bookmaker_name: string;
        event_id: string;
        outcome_id: string;
        outcome_name: string;
        reported_probability_micros: number | null;
        source_timestamp_ms: number | string;
      }[]
    >`
      SELECT
        bookmaker_id,
        bookmaker_name,
        event_id,
        outcome_id,
        outcome_name,
        reported_probability_micros,
        source_timestamp_ms
      FROM outcome_quote_observations
      WHERE market_id = ${marketId}
      ORDER BY source_timestamp_ms DESC, event_id DESC, outcome_id
      LIMIT 500
    `;
    if (rows.length === 0) return null;
    const grouped = new Map<string, BookmakerQuoteVector>();
    for (const row of rows) {
      const existing = grouped.get(row.event_id);
      const outcome = {
        name: row.outcome_name,
        outcomeId: row.outcome_id,
        reportedProbabilityMicros: row.reported_probability_micros,
      };
      grouped.set(
        row.event_id,
        existing
          ? { ...existing, outcomes: [...existing.outcomes, outcome] }
          : {
              bookmakerId: row.bookmaker_id,
              bookmakerName: row.bookmaker_name,
              eventId: row.event_id,
              marketId,
              observedAtMs: Number(row.source_timestamp_ms),
              outcomes: [outcome],
            },
      );
    }
    return createConsensusSnapshot({
      configuration: {
        formulaVersion: consensusFormulaVersion,
        minFreshBookmakers: 1,
        staleAfterMs: 5_000,
      },
      logicalTimestampMs: this.clock.nowMs(),
      marketId,
      quotes: [...grouped.values()],
    });
  }

  async listTimeline(
    input: Readonly<{
      beforeMs?: number;
      fixtureId: string;
      limit: number;
    }>,
  ): Promise<readonly TimelineItem[]> {
    assertLimit(input.limit, 200);
    const events = await this.sql<
      { event_id: string; payload: unknown; source_timestamp_ms: number | string }[]
    >`
      SELECT event_id, source_timestamp_ms, payload
      FROM domain_events
      WHERE fixture_id = ${input.fixtureId}
        AND kind = 'score.observed'
        AND (${input.beforeMs ?? null}::bigint IS NULL OR source_timestamp_ms < ${input.beforeMs ?? null})
      ORDER BY source_timestamp_ms DESC, event_id DESC
      LIMIT ${input.limit}
    `;
    const decisions = await this.sql<
      { decision_id: string; logical_timestamp_ms: number | string; payload: unknown }[]
    >`
      SELECT decision_id, logical_timestamp_ms, payload
      FROM strategy_decisions
      WHERE fixture_id = ${input.fixtureId}
        AND (${input.beforeMs ?? null}::bigint IS NULL OR logical_timestamp_ms < ${input.beforeMs ?? null})
      ORDER BY logical_timestamp_ms DESC, decision_id DESC
      LIMIT ${input.limit}
    `;
    return [
      ...events.map((row): TimelineItem => ({
        atMs: Number(row.source_timestamp_ms),
        id: row.event_id,
        kind: 'score',
        payload: row.payload,
      })),
      ...decisions.map((row): TimelineItem => ({
        atMs: Number(row.logical_timestamp_ms),
        id: row.decision_id,
        kind: 'decision',
        payload: strategyDecisionSchema.parse(row.payload),
      })),
    ]
      .sort((left, right) => right.atMs - left.atMs || right.id.localeCompare(left.id))
      .slice(0, input.limit);
  }

  async listDecisions(
    input: Readonly<{
      fixtureId?: string;
      limit: number;
      marketId?: string;
    }>,
  ): Promise<readonly StrategyDecision[]> {
    assertLimit(input.limit);
    const rows = await this.sql<{ payload: unknown }[]>`
      SELECT payload
      FROM strategy_decisions
      WHERE (${input.fixtureId ?? null}::text IS NULL OR fixture_id = ${input.fixtureId ?? null})
        AND (${input.marketId ?? null}::text IS NULL OR market_id = ${input.marketId ?? null})
      ORDER BY logical_timestamp_ms DESC, decision_id DESC
      LIMIT ${input.limit}
    `;
    return rows.map(({ payload }) => strategyDecisionSchema.parse(payload));
  }

  async listReceipts(
    input: Readonly<{
      fixtureId?: string;
      limit: number;
      status?: string;
    }>,
  ): Promise<readonly DecisionReceipt[]> {
    assertLimit(input.limit);
    const rows = await this.sql<{ payload: unknown }[]>`
      SELECT receipts.payload
      FROM decision_receipts AS receipts
      JOIN strategy_decisions AS decisions USING (decision_id)
      WHERE (${input.fixtureId ?? null}::text IS NULL OR decisions.fixture_id = ${input.fixtureId ?? null})
        AND (${input.status ?? null}::text IS NULL OR receipts.status::text = ${input.status ?? null})
      ORDER BY decisions.logical_timestamp_ms DESC, receipts.receipt_id DESC
      LIMIT ${input.limit}
    `;
    return rows.map(({ payload }) => decisionReceiptSchema.parse(payload));
  }

  async listOrders(
    input: Readonly<{
      fixtureId?: string;
      limit: number;
      namespace?: string;
      status?: string;
    }>,
  ): Promise<readonly SimulatedOrder[]> {
    assertLimit(input.limit);
    const rows = await this.sql<{ payload: unknown }[]>`
      SELECT payload
      FROM simulated_orders
      WHERE (${input.fixtureId ?? null}::text IS NULL OR fixture_id = ${input.fixtureId ?? null})
        AND (${input.namespace ?? null}::text IS NULL OR namespace = ${input.namespace ?? null})
        AND (${input.status ?? null}::text IS NULL OR status::text = ${input.status ?? null})
      ORDER BY created_at_ms DESC, order_id DESC
      LIMIT ${input.limit}
    `;
    return rows.map(({ payload }) => simulatedOrderSchema.parse(payload));
  }

  async listReplayRuns(
    input: Readonly<{ limit: number }>,
  ): Promise<readonly ReplayRun[]> {
    assertLimit(input.limit);
    const rows = await this.sql<{ payload: unknown }[]>`
      SELECT payload
      FROM replay_runs
      ORDER BY started_at_ms DESC, run_id DESC
      LIMIT ${input.limit}
    `;
    return rows.map(({ payload }) => replayRunSchema.parse(payload));
  }
}
