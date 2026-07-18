import {
  DeterministicReplayRunner,
  VirtualReplayClock,
  createReplayRun,
  replayRunSchema,
  type Clock,
  type ReplayDispatch,
  type ReplayManifest,
  type ReplayResult,
  type ReplaySpeed,
  type ReplayStore,
  type NormalizedDomainEvent,
} from '@lagshield/core';

export class HistoricalReplayService {
  constructor(
    private readonly dependencies: Readonly<{
      clock: Clock;
      replayStore: ReplayStore;
    }>,
  ) {}

  async run(
    input: Readonly<{
      events: readonly NormalizedDomainEvent[];
      manifest: ReplayManifest;
      onEvent: (dispatch: ReplayDispatch) => Promise<void>;
      runId: string;
      speed: ReplaySpeed;
    }>,
  ): Promise<ReplayResult> {
    const pending = createReplayRun({
      manifest: input.manifest,
      runId: input.runId,
      speed: input.speed,
      startedAtMs: this.dependencies.clock.nowMs(),
    });
    const creation = await this.dependencies.replayStore.createReplayRun(pending);
    if (creation.status !== 'inserted') {
      throw new Error(`Replay run ID ${input.runId} already exists.`);
    }
    let progressCount = 0;
    let lastEventId: string | null = null;
    const running = replayRunSchema.parse({ ...pending, status: 'running' });
    await this.dependencies.replayStore.updateReplayRun(running);
    const runner = new DeterministicReplayRunner({
      clock: new VirtualReplayClock({ speed: input.speed }),
      events: input.events,
      manifest: input.manifest,
      onEvent: async (dispatch) => {
        await input.onEvent(dispatch);
        progressCount += 1;
        lastEventId = dispatch.event.eventId;
      },
      runId: input.runId,
    });

    try {
      const result = await runner.run();
      const completed = replayRunSchema.parse({
        ...running,
        completedAtMs: this.dependencies.clock.nowMs(),
        eventCount: result.eventCount,
        lastEventId: result.finalEventId,
        status: 'completed',
      });
      await this.dependencies.replayStore.updateReplayRun(completed);
      return result;
    } catch (error) {
      const failed = replayRunSchema.parse({
        ...running,
        completedAtMs: this.dependencies.clock.nowMs(),
        eventCount: progressCount,
        lastEventId,
        status: 'failed',
      });
      await this.dependencies.replayStore.updateReplayRun(failed).catch(() => undefined);
      throw error;
    }
  }
}
