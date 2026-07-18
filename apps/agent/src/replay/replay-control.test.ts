import {
  FixedClock,
  VirtualReplayClock,
  type AppendResult,
  type DomainStore,
  type MarketControlSnapshot,
  type NormalizedDomainEvent,
  type QuarantineInput,
  type RawIngestInput,
  type ReplayRun,
  type ReplayStore,
  type ReplayTimer,
  type StoredReplayManifest,
  type StrategyDecision,
} from '@lagshield/core';
import { describe, expect, it } from 'vitest';

import { RealtimeEventHub } from '../realtime/event-hub.js';
import { ReplayControlService } from './replay-control.js';

class MemoryDomainStore implements DomainStore {
  readonly decisions: StrategyDecision[] = [];
  readonly events: NormalizedDomainEvent[] = [];

  async appendDecision(decision: StrategyDecision): Promise<AppendResult> {
    this.decisions.push(decision);
    return { recordId: decision.decisionId, status: 'inserted' };
  }

  async appendEvent(input: {
    event: NormalizedDomainEvent;
    raw: RawIngestInput;
  }): Promise<AppendResult> {
    void input.raw;
    this.events.push(input.event);
    return { recordId: input.event.eventId, status: 'inserted' };
  }

  async loadMarketControlState(_marketId: string): Promise<MarketControlSnapshot | null> {
    void _marketId;
    return null;
  }

  async listFixtureEvents() {
    return { events: [], nextCursor: null };
  }

  async purgeExpiredRawPayloads(): Promise<number> {
    return 0;
  }

  async quarantine(input: QuarantineInput): Promise<AppendResult> {
    return { recordId: input.ingestId, status: 'quarantined' };
  }
}

class MemoryReplayStore implements ReplayStore {
  readonly runs = new Map<string, ReplayRun>();

  async createReplayRun(run: ReplayRun): Promise<AppendResult> {
    if (this.runs.has(run.runId)) return { recordId: run.runId, status: 'duplicate' };
    this.runs.set(run.runId, run);
    return { recordId: run.runId, status: 'inserted' };
  }

  async saveReplayManifest(input: StoredReplayManifest): Promise<AppendResult> {
    return { recordId: input.manifest.manifestId, status: 'inserted' };
  }

  async updateReplayRun(run: ReplayRun): Promise<AppendResult> {
    this.runs.set(run.runId, run);
    return { recordId: run.runId, status: 'inserted' };
  }
}

class HeldTimer implements ReplayTimer {
  nowMs(): number {
    return 0;
  }

  sleep(_milliseconds: number, signal: AbortSignal): Promise<void> {
    void _milliseconds;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
}

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for replay state.');
}

function harness(options: { held?: boolean } = {}) {
  const clock = new FixedClock(1_800_000_000_000);
  const domainStore = new MemoryDomainStore();
  const replayStore = new MemoryReplayStore();
  const realtime = new RealtimeEventHub({ clock });
  const service = new ReplayControlService({
    clock,
    domainStore,
    realtime,
    ...(options.held
      ? {
          replayClockFactory: (speed) =>
            new VirtualReplayClock({ speed, timer: new HeldTimer() }),
        }
      : {}),
    replayStore,
  });
  return { domainStore, realtime, replayStore, service };
}

describe('ReplayControlService', () => {
  it('runs the seeded winning path from open through pause and recovery to reopen', async () => {
    const test = harness();
    await test.service.startSeeded({ runId: 'winning-path', speed: 'maximum' });
    await waitFor(() => test.service.snapshot('winning-path').run.status === 'completed');

    const snapshot = test.service.snapshot('winning-path');
    expect(snapshot).toMatchObject({
      dataMode: 'seeded-simulation',
      marketState: { state: 'OPEN' },
      progress: 8,
      run: { namespace: 'replay:winning-path', status: 'completed' },
      totalEvents: 8,
    });
    expect(test.domainStore.events).toHaveLength(8);
    expect(test.domainStore.decisions.map(({ nextState }) => nextState)).toEqual([
      'OPEN',
      'PAUSED',
      'PAUSED',
      'PAUSED',
      'RECOVERY',
      'RECOVERY',
      'OPEN',
    ]);
    expect(test.realtime.snapshot().bufferedEventCount).toBeGreaterThan(8);
  });

  it('supports conflict-safe pause, resume, and stop control', async () => {
    const test = harness({ held: true });
    await test.service.startSeeded({ runId: 'controlled', speed: 1 });
    await waitFor(() => test.service.snapshot('controlled').progress === 1);

    await expect(test.service.control('controlled', 'pause')).resolves.toMatchObject({
      run: { status: 'paused' },
    });
    await expect(test.service.control('controlled', 'pause')).rejects.toThrow(
      'cannot pause from paused',
    );
    await expect(test.service.control('controlled', 'resume')).resolves.toMatchObject({
      run: { status: 'running' },
    });
    await expect(test.service.control('controlled', 'stop')).resolves.toMatchObject({
      run: { status: 'stopped' },
    });
    await expect(test.service.control('another', 'stop')).rejects.toThrow('not active');
  });

  it('prevents two active replay owners and replay ID reuse', async () => {
    const test = harness({ held: true });
    await test.service.startSeeded({ runId: 'first', speed: 1 });
    await expect(test.service.startSeeded({ runId: 'second', speed: 1 })).rejects.toThrow(
      'already owns',
    );
    await test.service.control('first', 'stop');
    await expect(
      test.service.startSeeded({ runId: 'first', speed: 'maximum' }),
    ).rejects.toThrow('already exists');
  });

  it('can replace a stopped active replay without the old runner publishing through the new owner', async () => {
    const test = harness({ held: true });
    await test.service.startSeeded({ runId: 'first', speed: 1 });
    await waitFor(() => test.service.snapshot('first').progress === 1);
    await test.service.control('first', 'stop');

    await test.service.startSeeded({ runId: 'second', speed: 'maximum' });
    await waitFor(() => test.service.snapshot('second').run.status === 'completed');

    expect(test.service.activeSnapshot()).toMatchObject({
      progress: 8,
      run: { runId: 'second', status: 'completed' },
    });
    expect(test.replayStore.runs.get('first')).toMatchObject({ status: 'stopped' });
  });
});
