import {
  canonicalJson,
  toJsonValue,
  verifyStrategyEvaluationReport,
  type AppendResult,
  type StrategyEvaluationReport,
} from '@lagshield/core';

import type { DatabaseClient } from './client.js';

export class EvaluationPersistenceConflictError extends Error {
  constructor(readonly evaluationHash: string) {
    super(
      `Evaluation report ${evaluationHash} conflicts with the stored deterministic payload.`,
    );
    this.name = 'EvaluationPersistenceConflictError';
  }
}

function assertCreatedAt(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Evaluation createdAtMs must be a non-negative safe integer.');
  }
}

export class PostgresEvaluationStore {
  constructor(private readonly sql: DatabaseClient) {}

  async save(
    report: StrategyEvaluationReport,
    createdAtMs: number,
  ): Promise<AppendResult> {
    assertCreatedAt(createdAtMs);
    verifyStrategyEvaluationReport(report);
    const inserted = await this.sql<{ evaluation_hash: string }[]>`
      INSERT INTO evaluation_reports (
        evaluation_hash,
        manifest_id,
        fixture_id,
        policy_version,
        policy_configuration_hash,
        created_at_ms,
        payload
      ) VALUES (
        ${report.evaluationHash},
        ${report.generatedFrom.manifestId},
        ${report.fixtureId},
        ${report.policy.version},
        ${report.policy.configurationHash},
        ${createdAtMs},
        ${JSON.stringify(report)}::jsonb
      )
      ON CONFLICT (evaluation_hash) DO NOTHING
      RETURNING evaluation_hash
    `;
    if (inserted.length > 0) {
      return { recordId: report.evaluationHash, status: 'inserted' };
    }
    const existing = await this.sql<{ payload: unknown }[]>`
      SELECT payload
      FROM evaluation_reports
      WHERE evaluation_hash = ${report.evaluationHash}
    `;
    if (
      !existing[0] ||
      canonicalJson(toJsonValue(existing[0].payload)) !==
        canonicalJson(toJsonValue(report))
    ) {
      throw new EvaluationPersistenceConflictError(report.evaluationHash);
    }
    return { recordId: report.evaluationHash, status: 'duplicate' };
  }

  async load(evaluationHash: string): Promise<StrategyEvaluationReport | null> {
    const rows = await this.sql<{ payload: StrategyEvaluationReport }[]>`
      SELECT payload
      FROM evaluation_reports
      WHERE evaluation_hash = ${evaluationHash}
    `;
    return rows[0] ? verifyStrategyEvaluationReport(rows[0].payload) : null;
  }
}
