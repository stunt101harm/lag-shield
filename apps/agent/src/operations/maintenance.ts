import { replayRunSchema, type Clock, type DomainStore } from '@lagshield/core';

import type { DatabaseClient } from '../db/client.js';

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown maintenance error.';
  return message.slice(0, 500);
}

export type StartupRecoverySnapshot = Readonly<{
  completedAtMs: number;
  recoveredReplayCount: number;
  recoveredReplayIds: readonly string[];
}>;

export class PostgresStartupRecovery {
  constructor(
    private readonly dependencies: Readonly<{
      clock: Clock;
      sql: DatabaseClient;
    }>,
  ) {}

  async reconcile(): Promise<StartupRecoverySnapshot> {
    const completedAtMs = this.dependencies.clock.nowMs();
    const recoveredReplayIds = await this.dependencies.sql.begin(async (transaction) => {
      const candidates = await transaction<
        {
          payload: unknown;
          run_id: string;
        }[]
      >`
        SELECT run_id, payload
        FROM replay_runs
        WHERE status IN ('pending', 'running', 'paused')
        ORDER BY started_at_ms, run_id
        FOR UPDATE
      `;
      const ids: string[] = [];
      for (const candidate of candidates) {
        const previous = replayRunSchema.parse(candidate.payload);
        const terminalAtMs = Math.max(completedAtMs, previous.startedAtMs);
        const payload = replayRunSchema.parse({
          ...previous,
          completedAtMs: terminalAtMs,
          status: 'failed',
        });
        await transaction`
          UPDATE replay_runs
          SET
            status = 'failed',
            completed_at_ms = ${terminalAtMs},
            payload = ${JSON.stringify(payload)}::jsonb
          WHERE run_id = ${candidate.run_id}
        `;
        ids.push(candidate.run_id);
      }
      return ids;
    });

    return {
      completedAtMs,
      recoveredReplayCount: recoveredReplayIds.length,
      recoveredReplayIds,
    };
  }
}

export type RetentionWorkerSnapshot = Readonly<{
  lastError: string | null;
  lastFinishedAtMs: number | null;
  lastPurgedCount: number;
  running: boolean;
  totalPurgedCount: number;
}>;

export class RetentionWorker {
  readonly #batchSize: number;
  readonly #clock: Clock;
  readonly #intervalMs: number;
  readonly #store: Pick<DomainStore, 'purgeExpiredRawPayloads'>;
  #inFlight: Promise<void> | null = null;
  #lastError: string | null = null;
  #lastFinishedAtMs: number | null = null;
  #lastPurgedCount = 0;
  #timer: NodeJS.Timeout | null = null;
  #totalPurgedCount = 0;

  constructor(
    dependencies: Readonly<{
      batchSize: number;
      clock: Clock;
      intervalMs: number;
      store: Pick<DomainStore, 'purgeExpiredRawPayloads'>;
    }>,
  ) {
    if (!Number.isSafeInteger(dependencies.batchSize) || dependencies.batchSize < 1) {
      throw new Error('Retention worker batch size must be a positive safe integer.');
    }
    if (
      !Number.isSafeInteger(dependencies.intervalMs) ||
      dependencies.intervalMs < 1_000
    ) {
      throw new Error('Retention worker interval must be at least 1,000ms.');
    }
    this.#batchSize = dependencies.batchSize;
    this.#clock = dependencies.clock;
    this.#intervalMs = dependencies.intervalMs;
    this.#store = dependencies.store;
  }

  start(): void {
    if (this.#timer) throw new Error('Retention worker is already started.');
    void this.runNow();
    this.#timer = setInterval(() => void this.runNow(), this.#intervalMs);
    this.#timer.unref();
  }

  async runNow(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#run().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#inFlight;
  }

  snapshot(): RetentionWorkerSnapshot {
    return {
      lastError: this.#lastError,
      lastFinishedAtMs: this.#lastFinishedAtMs,
      lastPurgedCount: this.#lastPurgedCount,
      running: this.#timer !== null,
      totalPurgedCount: this.#totalPurgedCount,
    };
  }

  async #run(): Promise<void> {
    try {
      this.#lastPurgedCount = await this.#store.purgeExpiredRawPayloads({
        limit: this.#batchSize,
        nowMs: this.#clock.nowMs(),
      });
      this.#totalPurgedCount += this.#lastPurgedCount;
      this.#lastError = null;
    } catch (error) {
      this.#lastPurgedCount = 0;
      this.#lastError = boundedErrorMessage(error);
    } finally {
      this.#lastFinishedAtMs = this.#clock.nowMs();
    }
  }
}
