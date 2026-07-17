import { describe, expect, it } from 'vitest';

import {
  ReplayStoppedError,
  VirtualReplayClock,
  type ReplayTimer,
} from './replay-clock.js';

class ImmediateTimer implements ReplayTimer {
  now = 0;
  readonly sleeps: number[] = [];

  nowMs(): number {
    return this.now;
  }

  async sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    this.sleeps.push(milliseconds);
    this.now += milliseconds;
  }
}

class ControlledTimer implements ReplayTimer {
  now = 0;
  pending:
    | Readonly<{
        reject: (error: unknown) => void;
        resolve: () => void;
      }>
    | undefined;

  nowMs(): number {
    return this.now;
  }

  sleep(_milliseconds: number, signal: AbortSignal): Promise<void> {
    void _milliseconds;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending = undefined;
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.pending = {
        reject,
        resolve: () => {
          signal.removeEventListener('abort', abort);
          this.pending = undefined;
          resolve();
        },
      };
    });
  }

  advanceBy(milliseconds: number): void {
    this.now += milliseconds;
  }

  complete(): void {
    this.pending?.resolve();
  }
}

async function flushUntil(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !assertion(); attempt += 1) {
    await Promise.resolve();
  }
  if (!assertion()) throw new Error('Expected replay-clock microtask was not scheduled.');
}

describe('VirtualReplayClock', () => {
  it.each([
    { expectedWallMs: 600, speed: 1 },
    { expectedWallMs: 150, speed: 4 },
  ])(
    'advances at $speed x without a wall-clock sleep',
    async ({ expectedWallMs, speed }) => {
      const timer = new ImmediateTimer();
      const clock = new VirtualReplayClock({ speed, timer });
      clock.start(1_000);

      await clock.advanceTo(1_600);

      expect(timer.sleeps).toEqual([expectedWallMs]);
      expect(clock.snapshot()).toEqual({
        logicalNowMs: 1_600,
        speed,
        state: 'running',
      });
    },
  );

  it('runs maximum-throughput mode without consulting a timer', async () => {
    const timer = new ImmediateTimer();
    const clock = new VirtualReplayClock({ speed: 'maximum', timer });
    clock.start(10);

    await clock.advanceTo(5_000);

    expect(timer.sleeps).toEqual([]);
    expect(clock.snapshot().logicalNowMs).toBe(5_000);
  });

  it('pauses an active delay and resumes from the exact logical point', async () => {
    const timer = new ControlledTimer();
    const clock = new VirtualReplayClock({ speed: 1, timer });
    clock.start(0);
    const advance = clock.advanceTo(1_000);
    await flushUntil(() => timer.pending !== undefined);
    timer.advanceBy(200);

    clock.pause();
    await Promise.resolve();
    await Promise.resolve();
    expect(clock.snapshot()).toMatchObject({ logicalNowMs: 200, state: 'paused' });

    clock.resume();
    await flushUntil(() => timer.pending !== undefined);
    timer.advanceBy(800);
    timer.complete();
    await advance;
    expect(clock.snapshot()).toMatchObject({ logicalNowMs: 1_000, state: 'running' });
  });

  it('stops a paused replay without leaving a waiter behind', async () => {
    const clock = new VirtualReplayClock({ speed: 'maximum' });
    clock.start(0);
    clock.pause();
    const advance = clock.advanceTo(1);
    clock.stop();

    await expect(advance).rejects.toBeInstanceOf(ReplayStoppedError);
    expect(clock.snapshot().state).toBe('stopped');
  });
});
