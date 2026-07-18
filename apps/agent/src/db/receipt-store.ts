import {
  canonicalJson,
  createPendingDecisionReceipt,
  decisionReceiptSchema,
  decisionReceiptV2Schema,
  scoreObservedPayloadSchema,
  scoreObservedPayloadV2Schema,
  toJsonValue,
  updateDecisionReceiptVerification,
  type DecisionReceipt,
  type DecisionReceiptV2,
  type JsonValue,
  type ProofVerification,
  type ReceiptEvidence,
  type StrategyDecision,
} from '@lagshield/core';
import type postgres from 'postgres';

import type { DatabaseClient } from './client.js';
import { IdempotencyConflictError } from './errors.js';

export type Transaction = postgres.TransactionSql;

function jsonParameter(value: unknown): string {
  return JSON.stringify(toJsonValue(value));
}

function evidenceIds(decision: StrategyDecision): string[] {
  return [
    ...new Set([
      decision.triggerEventId,
      ...(decision.payloadVersion === 2 ? decision.evidenceEventIds : []),
    ]),
  ].sort();
}

export async function createReceiptFromStoredEvidence(
  sql: Transaction,
  decision: StrategyDecision,
): Promise<DecisionReceiptV2> {
  const expectedIds = evidenceIds(decision);
  const rows = await sql<
    {
      event_id: string;
      kind: ReceiptEvidence['kind'];
      payload: unknown;
      source: ReceiptEvidence['source'];
      source_id: string;
      source_timestamp_ms: number | string | null;
    }[]
  >`
    SELECT event_id, kind, payload, source, source_id, source_timestamp_ms
    FROM domain_events
    WHERE event_id = ANY(${sql.array(expectedIds)}::text[])
    ORDER BY event_id
  `;
  if (rows.length !== expectedIds.length) {
    const found = new Set(rows.map(({ event_id }) => event_id));
    const missing = expectedIds.filter((eventId) => !found.has(eventId));
    throw new Error(`Decision evidence is not stored: ${missing.join(', ')}.`);
  }
  return createPendingDecisionReceipt(
    decision,
    rows.map((row) => ({
      eventId: row.event_id,
      kind: row.kind,
      scoreStatKey:
        row.kind === 'score.observed'
          ? (() => {
              const payload = scoreObservedPayloadV2Schema
                .or(scoreObservedPayloadSchema)
                .parse(row.payload);
              const keys = [...new Set(payload.stats.map(({ key }) => key))].sort(
                (left, right) => left - right,
              );
              return keys.includes(1) ? 1 : (keys[0] ?? null);
            })()
          : null,
      source: row.source,
      sourceMessageId: row.source_id,
      sourceTimestampMs:
        row.source_timestamp_ms === null ? null : Number(row.source_timestamp_ms),
    })),
  );
}

export async function insertDecisionReceipt(
  sql: Transaction,
  receiptInput: DecisionReceiptV2,
): Promise<void> {
  const receipt = decisionReceiptV2Schema.parse(receiptInput);
  const verification = receipt.verification;
  await sql`
    INSERT INTO decision_receipts (
      receipt_id,
      decision_id,
      payload_hash,
      payload_version,
      status,
      anchored_at_ms,
      proof_reference,
      proof_kind,
      proof_network,
      program_id,
      root_account,
      simulation_slot,
      proof_material,
      proof_material_hash,
      source_event_id,
      source_message_id,
      source_timestamp_ms,
      attempt_count,
      attempted_at_ms,
      completed_at_ms,
      error_code,
      error_message,
      explorer_account_url,
      explorer_program_url,
      summary,
      created_at_ms,
      updated_at_ms,
      payload
    ) VALUES (
      ${receipt.receiptId},
      ${receipt.decisionId},
      ${receipt.payloadHash},
      ${receipt.payloadVersion},
      ${verification.status},
      ${null},
      ${verification.proofReference},
      ${verification.kind},
      ${verification.network},
      ${verification.programId},
      ${verification.rootAccount},
      ${verification.simulationSlot},
      ${null},
      ${verification.proofMaterialHash},
      ${verification.sourceEventId},
      ${verification.sourceMessageId},
      ${verification.sourceTimestampMs},
      ${verification.attemptCount},
      ${verification.attemptedAtMs},
      ${verification.completedAtMs},
      ${verification.errorCode},
      ${verification.errorMessage},
      ${verification.explorerAccountUrl},
      ${verification.explorerProgramUrl},
      ${verification.summary},
      ${receipt.createdAtMs},
      ${verification.updatedAtMs},
      ${jsonParameter(receipt)}::jsonb
    )
  `;
}

type ReceiptRow = Readonly<{
  payload: unknown;
  proof_material: unknown;
}>;

export type StoredDecisionReceipt = Readonly<{
  proofMaterial: JsonValue | null;
  receipt: DecisionReceipt;
}>;

export class PostgresDecisionReceiptStore {
  constructor(private readonly sql: DatabaseClient) {}

  async loadByDecisionId(decisionId: string): Promise<StoredDecisionReceipt | null> {
    const rows = await this.sql<ReceiptRow[]>`
      SELECT payload, proof_material
      FROM decision_receipts
      WHERE decision_id = ${decisionId}
    `;
    const row = rows[0];
    return row
      ? {
          proofMaterial:
            row.proof_material === null ? null : toJsonValue(row.proof_material),
          receipt: decisionReceiptSchema.parse(row.payload),
        }
      : null;
  }

  async load(receiptId: string): Promise<StoredDecisionReceipt | null> {
    const rows = await this.sql<ReceiptRow[]>`
      SELECT payload, proof_material
      FROM decision_receipts
      WHERE receipt_id = ${receiptId}
    `;
    const row = rows[0];
    return row
      ? {
          proofMaterial:
            row.proof_material === null ? null : toJsonValue(row.proof_material),
          receipt: decisionReceiptSchema.parse(row.payload),
        }
      : null;
  }

  async listPending(limit: number): Promise<readonly DecisionReceiptV2[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Receipt query limit must be an integer from 1 through 100.');
    }
    const rows = await this.sql<{ payload: unknown }[]>`
      SELECT payload
      FROM decision_receipts
      WHERE status = 'pending'
        AND payload_version = 2
      ORDER BY updated_at_ms, receipt_id
      LIMIT ${limit}
    `;
    return rows.map(({ payload }) => decisionReceiptV2Schema.parse(payload));
  }

  async updateVerification(
    input: Readonly<{
      expectedAttemptCount: number;
      proofMaterial: JsonValue | null;
      receiptId: string;
      verification: ProofVerification;
    }>,
  ): Promise<DecisionReceiptV2> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<ReceiptRow[]>`
        SELECT payload, proof_material
        FROM decision_receipts
        WHERE receipt_id = ${input.receiptId}
        FOR UPDATE
      `;
      const row = rows[0];
      if (!row) throw new Error(`Decision receipt ${input.receiptId} is missing.`);
      const current = decisionReceiptV2Schema.parse(row.payload);
      if (current.verification.attemptCount !== input.expectedAttemptCount) {
        throw new Error(
          `Receipt attempt changed from ${input.expectedAttemptCount} to ${current.verification.attemptCount}.`,
        );
      }
      const next = updateDecisionReceiptVerification(current, input.verification);
      const existingMaterial =
        row.proof_material === null ? null : toJsonValue(row.proof_material);
      if (
        existingMaterial !== null &&
        input.proofMaterial !== null &&
        canonicalJson(existingMaterial) !== canonicalJson(input.proofMaterial)
      ) {
        throw new IdempotencyConflictError(`receipt-proof|${input.receiptId}`);
      }
      const proofMaterial = input.proofMaterial ?? existingMaterial;
      await transaction`
        UPDATE decision_receipts
        SET
          status = ${next.verification.status},
          proof_reference = ${next.verification.proofReference},
          proof_kind = ${next.verification.kind},
          proof_network = ${next.verification.network},
          program_id = ${next.verification.programId},
          root_account = ${next.verification.rootAccount},
          simulation_slot = ${next.verification.simulationSlot},
          proof_material = ${proofMaterial === null ? null : jsonParameter(proofMaterial)}::jsonb,
          proof_material_hash = ${next.verification.proofMaterialHash},
          source_event_id = ${next.verification.sourceEventId},
          source_message_id = ${next.verification.sourceMessageId},
          source_timestamp_ms = ${next.verification.sourceTimestampMs},
          attempt_count = ${next.verification.attemptCount},
          attempted_at_ms = ${next.verification.attemptedAtMs},
          completed_at_ms = ${next.verification.completedAtMs},
          error_code = ${next.verification.errorCode},
          error_message = ${next.verification.errorMessage},
          explorer_account_url = ${next.verification.explorerAccountUrl},
          explorer_program_url = ${next.verification.explorerProgramUrl},
          summary = ${next.verification.summary},
          updated_at_ms = ${next.verification.updatedAtMs},
          payload = ${jsonParameter(next)}::jsonb
        WHERE receipt_id = ${next.receiptId}
      `;
      return next;
    });
  }
}
