import { describe, expect, it } from 'vitest';

import { RetentionWorker } from './maintenance.js';

describe('RetentionWorker', () => {
  it('coalesces overlapping runs and exposes bounded purge progress', async () => {
    let complete: ((value: number) => void) | undefined;
    let calls = 0;
    const worker = new RetentionWorker({
      batchSize: 250,
      clock: { nowMs: () => 1_800_000_000_000 },
      intervalMs: 60_000,
      store: {
        purgeExpiredRawPayloads: async (input) => {
          calls += 1;
          expect(input).toEqual({ limit: 250, nowMs: 1_800_000_000_000 });
          return new Promise<number>((resolve) => {
            complete = resolve;
          });
        },
      },
    });

    const first = worker.runNow();
    const second = worker.runNow();
    expect(calls).toBe(1);
    complete?.(17);
    await Promise.all([first, second]);

    expect(worker.snapshot()).toEqual({
      lastError: null,
      lastFinishedAtMs: 1_800_000_000_000,
      lastPurgedCount: 17,
      running: false,
      totalPurgedCount: 17,
    });
  });

  it('records a bounded diagnostic and keeps the periodic worker alive after failure', async () => {
    const worker = new RetentionWorker({
      batchSize: 1,
      clock: { nowMs: () => 2_000 },
      intervalMs: 1_000,
      store: {
        purgeExpiredRawPayloads: async () => {
          throw new Error('database unavailable '.repeat(100));
        },
      },
    });

    await expect(worker.runNow()).resolves.toBeUndefined();
    expect(worker.snapshot()).toMatchObject({
      lastFinishedAtMs: 2_000,
      lastPurgedCount: 0,
      totalPurgedCount: 0,
    });
    expect(worker.snapshot().lastError?.length).toBe(500);
  });
});
