import {
  DeterministicMarketFeatureEngine,
  DeterministicReplayRunner,
  DeterministicRiskEngine,
  VirtualReplayClock,
  buildRawIngestId,
  consensusFormulaVersion,
  createReplayRun,
  marketRiskFeaturesFromConsensus,
  namespaceResource,
  replayRunSchema,
  toJsonValue,
  type Clock,
  type ConsensusSnapshot,
  type DomainStore,
  type MarketRiskState,
  type NormalizedDomainEvent,
  type ReplayRun,
  type ReplaySpeed,
  type ReplayStore,
  type StrategyDecision,
} from '@lagshield/core';

import type { RealtimeEventHub } from '../realtime/event-hub.js';
import { createSeededDemoBundle } from './seeded-demo.js';

export type ReplayControlAction = 'pause' | 'resume' | 'stop';

export class ReplayControlConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayControlConflictError';
  }
}

export type ControlledReplaySnapshot = Readonly<{
  consensus: ConsensusSnapshot | null;
  currentEvent: NormalizedDomainEvent | null;
  dataMode: 'seeded-simulation';
  latestDecision: StrategyDecision | null;
  marketState: MarketRiskState | null;
  progress: number;
  run: ReplayRun;
  totalEvents: number;
}>;

type ActiveReplay = {
  clock: VirtualReplayClock;
  consensus: ConsensusSnapshot | null;
  currentEvent: NormalizedDomainEvent | null;
  featureEngine: DeterministicMarketFeatureEngine;
  latestDecision: StrategyDecision | null;
  marketState: MarketRiskState | null;
  riskEngine: DeterministicRiskEngine;
  run: ReplayRun;
  runner: DeterministicReplayRunner | null;
  totalEvents: number;
};

type StructuredLogger = Readonly<{
  error(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
}>;

const silentLogger: StructuredLogger = {
  error: () => undefined,
  info: () => undefined,
};

function rawFor(event: NormalizedDomainEvent) {
  return {
    fixtureId: event.fixtureId,
    idempotencyKey: event.idempotencyKey,
    ingestId: buildRawIngestId(event.idempotencyKey),
    payloadKind:
      event.kind === 'fixture.observed'
        ? 'fixture'
        : event.kind === 'odds.observed'
          ? 'odds'
          : 'score',
    payloadVersion: event.payloadVersion,
    rawPayload: toJsonValue(event.payload),
    receivedAtMs: event.receivedAtMs,
    retentionExpiresAtMs: null,
    source: event.source,
    sourceId: event.sourceId,
    sourceTimestampMs: event.sourceTimestampMs,
  } as const;
}

export class ReplayControlService {
  readonly #clock: Clock;
  readonly #domainStore: DomainStore;
  readonly #logger: StructuredLogger;
  readonly #realtime: RealtimeEventHub;
  readonly #replayClockFactory: (speed: ReplaySpeed) => VirtualReplayClock;
  readonly #replayStore: ReplayStore;
  #active: ActiveReplay | null = null;

  constructor(
    dependencies: Readonly<{
      clock: Clock;
      domainStore: DomainStore;
      logger?: StructuredLogger;
      realtime: RealtimeEventHub;
      replayClockFactory?: (speed: ReplaySpeed) => VirtualReplayClock;
      replayStore: ReplayStore;
    }>,
  ) {
    this.#clock = dependencies.clock;
    this.#domainStore = dependencies.domainStore;
    this.#logger = dependencies.logger ?? silentLogger;
    this.#realtime = dependencies.realtime;
    this.#replayClockFactory =
      dependencies.replayClockFactory ?? ((speed) => new VirtualReplayClock({ speed }));
    this.#replayStore = dependencies.replayStore;
  }

  async startSeeded(
    input: Readonly<{ runId: string; speed: ReplaySpeed }>,
  ): Promise<ControlledReplaySnapshot> {
    if (
      this.#active &&
      ['pending', 'running', 'paused'].includes(this.#active.run.status)
    ) {
      throw new ReplayControlConflictError(
        `Replay ${this.#active.run.runId} already owns the in-process runner.`,
      );
    }
    const bundle = createSeededDemoBundle();
    await this.#replayStore.saveReplayManifest({
      createdAtMs: this.#clock.nowMs(),
      manifest: bundle.manifest,
      retentionExpiresAtMs: null,
    });
    const pending = createReplayRun({
      manifest: bundle.manifest,
      runId: input.runId,
      speed: input.speed,
      startedAtMs: this.#clock.nowMs(),
    });
    const created = await this.#replayStore.createReplayRun(pending);
    if (created.status !== 'inserted') {
      throw new ReplayControlConflictError(
        `Replay run ID ${input.runId} already exists.`,
      );
    }
    const clock = this.#replayClockFactory(input.speed);
    const featureEngine = new DeterministicMarketFeatureEngine({
      formulaVersion: consensusFormulaVersion,
      minFreshBookmakers: 1,
      staleAfterMs: 5_000,
    });
    const riskEngine = new DeterministicRiskEngine();
    const running = replayRunSchema.parse({ ...pending, status: 'running' });
    await this.#replayStore.updateReplayRun(running);
    this.#logger.info(
      {
        fixtureId: running.inputFixtureId,
        manifestId: running.manifestId,
        replayRunId: running.runId,
      },
      'Deterministic replay started',
    );

    const active: ActiveReplay = {
      clock,
      consensus: null,
      currentEvent: null,
      featureEngine,
      latestDecision: null,
      marketState: null,
      riskEngine,
      run: running,
      runner: null,
      totalEvents: bundle.events.length,
    };
    const runner = new DeterministicReplayRunner({
      clock,
      events: bundle.events,
      manifest: bundle.manifest,
      onEvent: async (dispatch) => {
        const { context, event, index, logicalTimestampMs } = dispatch;
        await this.#domainStore.appendEvent({ event, raw: rawFor(event) });
        this.#realtime.publish('domain-event.committed', {
          context,
          event,
          logicalTimestampMs,
        });

        const observed = featureEngine.observe(event, logicalTimestampMs);
        if (observed) active.consensus = observed;
        const originalMarketId =
          event.kind === 'odds.observed'
            ? event.payload.market.marketId
            : active.consensus?.marketId;
        if (originalMarketId && active.consensus) {
          const marketId = namespaceResource(context, originalMarketId);
          const evaluation = riskEngine.evaluate({
            evidenceEventIds: [event.eventId],
            features: marketRiskFeaturesFromConsensus(active.consensus),
            fixtureId: event.fixtureId,
            logicalTimestampMs,
            marketId,
            proofStatus: 'unavailable',
            ...(event.kind === 'score.observed' ? { scoreEvent: event } : {}),
            triggerEventId: event.eventId,
          });
          if (evaluation.decision) {
            await this.#domainStore.appendDecision(evaluation.decision);
            active.latestDecision = evaluation.decision;
            active.marketState = evaluation.state;
            this.#realtime.publish('decision.committed', {
              context,
              decision: evaluation.decision,
              state: evaluation.state,
            });
            this.#logger.info(
              {
                decisionId: evaluation.decision.decisionId,
                fixtureId: evaluation.decision.fixtureId,
                marketId: evaluation.decision.marketId,
                nextState: evaluation.decision.nextState,
                previousState: evaluation.decision.previousState,
                replayRunId: input.runId,
                triggerEventId: evaluation.decision.triggerEventId,
              },
              'Strategy decision committed',
            );
          }
        }

        active.currentEvent = event;
        active.run = replayRunSchema.parse({
          ...active.run,
          eventCount: index + 1,
          lastEventId: event.eventId,
          status: 'running',
        });
        await this.#replayStore.updateReplayRun(active.run);
        this.#realtime.publish('replay.progress', this.snapshot(input.runId));
      },
      runId: input.runId,
    });
    active.runner = runner;
    this.#active = active;
    this.#realtime.publish('replay.status', this.snapshot(input.runId));
    void this.#execute(active);
    return this.snapshot(input.runId);
  }

  async control(
    runId: string,
    action: ReplayControlAction,
  ): Promise<ControlledReplaySnapshot> {
    const active = this.#requireActive(runId);
    if (action === 'pause') {
      if (active.run.status !== 'running') {
        throw new ReplayControlConflictError(
          `Replay ${runId} cannot pause from ${active.run.status}.`,
        );
      }
      active.clock.pause();
      active.run = replayRunSchema.parse({ ...active.run, status: 'paused' });
    } else if (action === 'resume') {
      if (active.run.status !== 'paused') {
        throw new ReplayControlConflictError(
          `Replay ${runId} cannot resume from ${active.run.status}.`,
        );
      }
      active.run = replayRunSchema.parse({ ...active.run, status: 'running' });
      active.clock.resume();
    } else {
      if (!['running', 'paused'].includes(active.run.status)) {
        throw new ReplayControlConflictError(
          `Replay ${runId} cannot stop from ${active.run.status}.`,
        );
      }
      active.run = replayRunSchema.parse({
        ...active.run,
        completedAtMs: this.#clock.nowMs(),
        status: 'stopped',
      });
      active.clock.stop();
    }
    await this.#replayStore.updateReplayRun(active.run);
    this.#logger.info(
      {
        action,
        eventCount: active.run.eventCount,
        replayRunId: runId,
        status: active.run.status,
      },
      'Replay control applied',
    );
    const snapshot = this.snapshot(runId);
    this.#realtime.publish('replay.status', snapshot);
    return snapshot;
  }

  snapshot(runId: string): ControlledReplaySnapshot {
    return this.#snapshotActive(this.#requireActive(runId));
  }

  #snapshotActive(active: ActiveReplay): ControlledReplaySnapshot {
    return {
      consensus: active.consensus,
      currentEvent: active.currentEvent,
      dataMode: 'seeded-simulation',
      latestDecision: active.latestDecision,
      marketState: active.marketState,
      progress: active.run.eventCount,
      run: active.run,
      totalEvents: active.totalEvents,
    };
  }

  activeSnapshot(): ControlledReplaySnapshot | null {
    return this.#active ? this.#snapshotActive(this.#active) : null;
  }

  async #execute(active: ActiveReplay): Promise<void> {
    try {
      if (!active.runner) throw new Error('Replay runner was not initialized.');
      await active.runner.run();
      if (active.run.status !== 'stopped') {
        active.run = replayRunSchema.parse({
          ...active.run,
          completedAtMs: this.#clock.nowMs(),
          eventCount: active.totalEvents,
          status: 'completed',
        });
        await this.#replayStore.updateReplayRun(active.run);
        this.#logger.info(
          {
            eventCount: active.run.eventCount,
            replayRunId: active.run.runId,
            status: active.run.status,
          },
          'Deterministic replay completed',
        );
      }
    } catch (error) {
      if (active.run.status !== 'stopped') {
        active.run = replayRunSchema.parse({
          ...active.run,
          completedAtMs: this.#clock.nowMs(),
          status: 'failed',
        });
        await this.#replayStore.updateReplayRun(active.run).catch(() => undefined);
      }
      if (active.run.status !== 'stopped') {
        this.#logger.error(
          {
            errorMessage:
              error instanceof Error
                ? error.message.slice(0, 500)
                : 'Unknown replay error.',
            eventCount: active.run.eventCount,
            replayRunId: active.run.runId,
          },
          'Deterministic replay failed closed',
        );
        this.#realtime.publish('replay.status', {
          ...this.#snapshotActive(active),
          error: error instanceof Error ? error.message : 'Unknown replay error.',
        });
        return;
      }
    }
    this.#realtime.publish('replay.status', this.#snapshotActive(active));
  }

  #requireActive(runId: string): ActiveReplay {
    if (!this.#active || this.#active.run.runId !== runId) {
      throw new ReplayControlConflictError(
        `Replay ${runId} is not active in this process.`,
      );
    }
    return this.#active;
  }
}
