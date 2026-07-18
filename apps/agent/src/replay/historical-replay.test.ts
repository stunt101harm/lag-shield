import {
  FixedClock,
  type AppendResult,
  type ReplayRun,
  type ReplayStore,
  type StoredReplayManifest,
} from '@lagshield/core';
import { describe, expect, it } from 'vitest';

import { HistoricalReplayService } from './historical-replay.js';
import { createSeededDemoBundle } from './seeded-demo.js';

class RecordingReplayStore implements ReplayStore {
  readonly runs: ReplayRun[] = [];

  async createReplayRun(run: ReplayRun): Promise<AppendResult> {
    this.runs.push(run);
    return { recordId: run.runId, status: 'inserted' };
  }

  async saveReplayManifest(input: StoredReplayManifest): Promise<AppendResult> {
    return { recordId: input.manifest.manifestId, status: 'inserted' };
  }

  async updateReplayRun(run: ReplayRun): Promise<AppendResult> {
    this.runs.push(run);
    return { recordId: run.runId, status: 'inserted' };
  }
}

describe('HistoricalReplayService', () => {
  it('persists the isolated lifecycle around the exact replay dispatch path', async () => {
    const bundle = createSeededDemoBundle();
    const replayStore = new RecordingReplayStore();
    const namespaces: string[] = [];
    const result = await new HistoricalReplayService({
      clock: new FixedClock(Date.UTC(2026, 6, 17, 20)),
      replayStore,
    }).run({
      events: bundle.events,
      manifest: bundle.manifest,
      onEvent: async ({ context }) => {
        namespaces.push(context.namespace);
      },
      runId: 'service-test',
      speed: 'maximum',
    });

    expect(result.eventCount).toBe(bundle.events.length);
    expect(replayStore.runs.map(({ status }) => status)).toEqual([
      'pending',
      'running',
      'completed',
    ]);
    expect(replayStore.runs.at(-1)).toMatchObject({
      eventCount: bundle.events.length,
      namespace: 'replay:service-test',
    });
    expect(namespaces.every((namespace) => namespace === 'replay:service-test')).toBe(
      true,
    );
  });

  it('records failed progress without swallowing the strategy-path error', async () => {
    const bundle = createSeededDemoBundle();
    const replayStore = new RecordingReplayStore();
    const service = new HistoricalReplayService({
      clock: new FixedClock(Date.UTC(2026, 6, 17, 20)),
      replayStore,
    });

    await expect(
      service.run({
        events: bundle.events,
        manifest: bundle.manifest,
        onEvent: async ({ index }) => {
          if (index === 2) throw new Error('strategy failed closed');
        },
        runId: 'failed-test',
        speed: 'maximum',
      }),
    ).rejects.toThrow('strategy failed closed');
    expect(replayStore.runs.at(-1)).toMatchObject({
      eventCount: 2,
      status: 'failed',
    });
  });
});
