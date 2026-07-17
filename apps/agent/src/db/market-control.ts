import {
  createMarketControlAdmission,
  decisionReceiptSchema,
  defaultMarketControlPolicyConfiguration,
  hashMarketOrderRequest,
  marketControlPolicyConfigurationSchema,
  marketOrderRequestSchema,
  simulatedOrderV2Schema,
  strategyDecisionSchema,
  toJsonValue,
  type Clock,
  type DecisionReceipt,
  type MarketControlPolicyConfiguration,
  type MarketControlPort,
  type MarketControlSnapshot,
  type MarketControlSubmission,
  type MarketOrderRequest,
  type SimulatedOrderV2,
} from '@lagshield/core';
import type postgres from 'postgres';

import type { DatabaseClient } from './client.js';
import { IdempotencyConflictError } from './errors.js';

function jsonParameter(value: unknown): string {
  return JSON.stringify(toJsonValue(value));
}

export class MarketNotInitializedError extends Error {
  constructor(readonly marketId: string) {
    super(`Market ${marketId} has no committed circuit-breaker decision.`);
    this.name = 'MarketNotInitializedError';
  }
}

type OrderRow = Readonly<{
  payload: unknown;
}>;

type ReceiptRow = Readonly<{
  payload: unknown;
}>;
type Transaction = postgres.TransactionSql;

export class PostgresSimulatedMarketControl implements MarketControlPort {
  readonly #clock: Clock;
  readonly #policy: MarketControlPolicyConfiguration;

  constructor(
    private readonly sql: DatabaseClient,
    dependencies: Readonly<{
      clock: Clock;
      policy?: MarketControlPolicyConfiguration;
    }>,
  ) {
    this.#clock = dependencies.clock;
    this.#policy = marketControlPolicyConfigurationSchema.parse(
      dependencies.policy ?? defaultMarketControlPolicyConfiguration,
    );
  }

  async submitOrder(input: MarketOrderRequest): Promise<MarketControlSubmission> {
    const request = marketOrderRequestSchema.parse(input);
    const requestHash = hashMarketOrderRequest(request);
    const evaluatedAtMs = this.#clock.nowMs();

    return this.sql.begin(async (transaction) => {
      await transaction`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${'order|' + request.namespace + '|' + request.idempotencyKey}, 0)
        )
      `;
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${request.marketId}, 0))
      `;

      const duplicates = await transaction<OrderRow[]>`
        SELECT payload
        FROM simulated_orders
        WHERE namespace = ${request.namespace}
          AND idempotency_key = ${request.idempotencyKey}
      `;
      const duplicate = duplicates[0];
      if (duplicate) {
        const order = simulatedOrderV2Schema.parse(duplicate.payload);
        if (order.requestHash !== requestHash) {
          throw new IdempotencyConflictError(
            `${request.namespace}|${request.idempotencyKey}`,
          );
        }
        const receipt = await this.#loadReceipt(transaction, order);
        return {
          decisionReceipt: receipt,
          order,
          persistenceStatus: 'duplicate',
        } as const;
      }

      const stateRows = await transaction<
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
        WHERE market_id = ${request.marketId}
        FOR UPDATE
      `;
      const state = stateRows[0];
      if (!state) throw new MarketNotInitializedError(request.marketId);
      const snapshot: MarketControlSnapshot = {
        fixtureId: state.fixture_id,
        lastDecisionId: state.last_decision_id,
        logicalTimestampMs: Number(state.logical_timestamp_ms),
        marketId: state.market_id,
        state: state.state,
        stateVersion: state.state_version,
      };
      const decisionRows = await transaction<{ payload: unknown }[]>`
        SELECT payload
        FROM strategy_decisions
        WHERE decision_id = ${snapshot.lastDecisionId}
      `;
      const decision = strategyDecisionSchema.parse(decisionRows[0]?.payload);
      const receiptRows = await transaction<ReceiptRow[]>`
        SELECT payload
        FROM decision_receipts
        WHERE decision_id = ${decision.decisionId}
      `;
      const decisionReceipt = decisionReceiptSchema.parse(receiptRows[0]?.payload);
      const admission = createMarketControlAdmission({
        decision,
        decisionReceipt,
        evaluatedAtMs,
        policy: this.#policy,
        request,
        snapshot,
      });
      const receipt = await this.#loadReceipt(transaction, admission.order);
      if (receipt.receiptId !== admission.order.circuitBreakerReceiptId) {
        throw new Error('Committed decision receipt identity is not canonical.');
      }

      const order = admission.order;
      await transaction`
        INSERT INTO simulated_orders (
          order_id,
          idempotency_key,
          namespace,
          fixture_id,
          market_id,
          outcome_id,
          side,
          price,
          stake_micros,
          status,
          decision_id,
          circuit_breaker_receipt_id,
          market_state,
          market_state_version,
          admission_latency_ms,
          admission_reason_code,
          requested_at_ms,
          request_hash,
          payload_version,
          created_at_ms,
          settled_at_ms,
          settlement,
          payload
        ) VALUES (
          ${order.orderId},
          ${order.idempotencyKey},
          ${order.namespace},
          ${order.fixtureId},
          ${order.marketId},
          ${order.outcomeId},
          ${order.side},
          ${order.price},
          ${order.stakeMicros},
          ${order.status},
          ${order.decisionId},
          ${order.circuitBreakerReceiptId},
          ${order.marketState},
          ${order.marketStateVersion},
          ${order.admissionLatencyMs},
          ${order.admissionReasonCode},
          ${order.requestedAtMs},
          ${order.requestHash},
          ${order.payloadVersion},
          ${order.createdAtMs},
          ${order.settledAtMs},
          ${order.settlement},
          ${jsonParameter(order)}::jsonb
        )
      `;
      return {
        decisionReceipt: receipt,
        order,
        persistenceStatus: 'inserted',
      } as const;
    });
  }

  async #loadReceipt(
    transaction: Transaction,
    order: SimulatedOrderV2,
  ): Promise<DecisionReceipt> {
    const rows = await transaction<ReceiptRow[]>`
      SELECT payload
      FROM decision_receipts
      WHERE receipt_id = ${order.circuitBreakerReceiptId}
    `;
    if (!rows[0]) {
      throw new Error(`Decision receipt ${order.circuitBreakerReceiptId} is missing.`);
    }
    return decisionReceiptSchema.parse(rows[0].payload);
  }
}
