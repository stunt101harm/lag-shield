import {
  canonicalJson,
  replayManifestSchema,
  replayRunSchema,
  toJsonValue,
  type AppendResult,
  type ReplayRun,
  type ReplayStore,
  type StoredReplayManifest,
} from '@lagshield/core';

import type { DatabaseClient } from './client.js';

export class ReplayPersistenceConflictError extends Error {
  constructor(readonly recordId: string) {
    super(`Replay record ${recordId} conflicts with the stored deterministic payload.`);
    this.name = 'ReplayPersistenceConflictError';
  }
}

function jsonParameter(value: unknown): string {
  return JSON.stringify(value);
}

function assertTimestamp(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer timestamp.`);
  }
}

function databaseInteger(label: string, value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} from PostgreSQL is not a non-negative safe integer.`);
  }
  return parsed;
}

export class PostgresReplayStore implements ReplayStore {
  constructor(private readonly sql: DatabaseClient) {}

  async saveReplayManifest(input: StoredReplayManifest): Promise<AppendResult> {
    const manifest = replayManifestSchema.parse(input.manifest);
    assertTimestamp('Replay manifest createdAtMs', input.createdAtMs);
    if (input.retentionExpiresAtMs !== null) {
      assertTimestamp('Replay manifest retentionExpiresAtMs', input.retentionExpiresAtMs);
      if (input.retentionExpiresAtMs < input.createdAtMs) {
        throw new Error('Replay manifest retention expiry must not precede creation.');
      }
    }
    const inserted = await this.sql<{ manifest_id: string }[]>`
      INSERT INTO replay_manifests (
        manifest_id,
        fixture_id,
        input_hash,
        event_sequence_hash,
        event_count,
        source_start_ms,
        source_end_ms,
        retention_expires_at_ms,
        created_at_ms,
        payload
      ) VALUES (
        ${manifest.manifestId},
        ${manifest.fixture.fixtureId},
        ${manifest.inputHash},
        ${manifest.eventSequenceHash},
        ${manifest.eventCount},
        ${manifest.source.startMs},
        ${manifest.source.endMs},
        ${input.retentionExpiresAtMs},
        ${input.createdAtMs},
        ${jsonParameter(manifest)}::jsonb
      )
      ON CONFLICT (manifest_id) DO NOTHING
      RETURNING manifest_id
    `;
    if (inserted.length > 0) {
      return { recordId: manifest.manifestId, status: 'inserted' };
    }
    const existing = await this.sql<{ payload: unknown }[]>`
      SELECT payload FROM replay_manifests WHERE manifest_id = ${manifest.manifestId}
    `;
    if (
      !existing[0] ||
      canonicalJson(toJsonValue(existing[0].payload)) !==
        canonicalJson(toJsonValue(manifest))
    ) {
      throw new ReplayPersistenceConflictError(manifest.manifestId);
    }
    return { recordId: manifest.manifestId, status: 'duplicate' };
  }

  async createReplayRun(input: ReplayRun): Promise<AppendResult> {
    const run = replayRunSchema.parse(input);
    if (
      run.status !== 'pending' ||
      run.completedAtMs !== null ||
      run.eventCount !== 0 ||
      run.lastEventId !== null
    ) {
      throw new Error('A new replay run must begin as pending with zero progress.');
    }
    const manifests = await this.sql<
      {
        event_count: string | number;
        fixture_id: string;
        input_hash: string;
        payload: unknown;
      }[]
    >`
      SELECT event_count, fixture_id, input_hash, payload
      FROM replay_manifests
      WHERE manifest_id = ${run.manifestId}
    `;
    const manifest = manifests[0];
    if (!manifest) throw new Error(`Replay manifest ${run.manifestId} does not exist.`);
    const manifestPayload = replayManifestSchema.parse(manifest.payload);
    if (
      run.configHash !== manifestPayload.configuration.strategyHash ||
      run.inputFixtureId !== manifest.fixture_id ||
      run.inputHash !== manifest.input_hash ||
      run.eventCount >
        databaseInteger('Replay manifest event_count', manifest.event_count)
    ) {
      throw new Error('Replay run does not match its deterministic manifest.');
    }
    const speed = String(run.speed);
    const inserted = await this.sql<{ run_id: string }[]>`
      INSERT INTO replay_runs (
        run_id,
        manifest_id,
        namespace,
        input_fixture_id,
        input_hash,
        config_hash,
        speed,
        status,
        started_at_ms,
        completed_at_ms,
        event_count,
        last_event_id,
        payload
      ) VALUES (
        ${run.runId},
        ${run.manifestId},
        ${run.namespace},
        ${run.inputFixtureId},
        ${run.inputHash},
        ${run.configHash},
        ${speed},
        ${run.status},
        ${run.startedAtMs},
        ${run.completedAtMs},
        ${run.eventCount},
        ${run.lastEventId},
        ${jsonParameter(run)}::jsonb
      )
      ON CONFLICT (run_id) DO NOTHING
      RETURNING run_id
    `;
    if (inserted.length > 0) return { recordId: run.runId, status: 'inserted' };
    const existing = await this.sql<{ payload: unknown }[]>`
      SELECT payload FROM replay_runs WHERE run_id = ${run.runId}
    `;
    if (
      !existing[0] ||
      canonicalJson(toJsonValue(existing[0].payload)) !== canonicalJson(toJsonValue(run))
    ) {
      throw new ReplayPersistenceConflictError(run.runId);
    }
    return { recordId: run.runId, status: 'duplicate' };
  }

  async updateReplayRun(input: ReplayRun): Promise<AppendResult> {
    const run = replayRunSchema.parse(input);
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<
        { manifest_event_count: string | number; payload: unknown }[]
      >`
        SELECT runs.payload, manifests.event_count AS manifest_event_count
        FROM replay_runs AS runs
        JOIN replay_manifests AS manifests
          ON manifests.manifest_id = runs.manifest_id
        WHERE runs.run_id = ${run.runId}
        FOR UPDATE OF runs
      `;
      if (!rows[0]) throw new Error(`Replay run ${run.runId} does not exist.`);
      const previous = replayRunSchema.parse(rows[0].payload);
      const immutableKeys = [
        'configHash',
        'inputFixtureId',
        'inputHash',
        'manifestId',
        'namespace',
        'runId',
        'speed',
        'startedAtMs',
      ] as const;
      if (immutableKeys.some((key) => previous[key] !== run[key])) {
        throw new ReplayPersistenceConflictError(run.runId);
      }
      const allowed: Record<ReplayRun['status'], readonly ReplayRun['status'][]> = {
        completed: ['completed'],
        failed: ['failed'],
        paused: ['paused', 'running', 'stopped', 'failed'],
        pending: ['pending', 'running', 'stopped', 'failed'],
        running: ['running', 'paused', 'completed', 'stopped', 'failed'],
        stopped: ['stopped'],
      };
      if (!allowed[previous.status].includes(run.status)) {
        throw new Error(
          `Replay run status cannot move from ${previous.status} to ${run.status}.`,
        );
      }
      if (run.eventCount < previous.eventCount) {
        throw new Error('Replay run eventCount cannot move backwards.');
      }
      const manifestEventCount = databaseInteger(
        'Replay manifest event_count',
        rows[0].manifest_event_count,
      );
      if (run.eventCount > manifestEventCount) {
        throw new Error('Replay run eventCount exceeds its manifest.');
      }
      if (
        run.status === 'completed' &&
        (run.eventCount !== manifestEventCount ||
          (run.eventCount > 0 && run.lastEventId === null))
      ) {
        throw new Error('Completed replay run does not match its manifest event count.');
      }
      if (canonicalJson(toJsonValue(previous)) === canonicalJson(toJsonValue(run))) {
        return { recordId: run.runId, status: 'duplicate' } as const;
      }
      await transaction`
        UPDATE replay_runs
        SET
          status = ${run.status},
          completed_at_ms = ${run.completedAtMs},
          event_count = ${run.eventCount},
          last_event_id = ${run.lastEventId},
          payload = ${jsonParameter(run)}::jsonb
        WHERE run_id = ${run.runId}
      `;
      return { recordId: run.runId, status: 'inserted' } as const;
    });
  }
}
