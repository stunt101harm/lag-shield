import {
  compareEventOrder,
  normalizedDomainEventSchema,
  type NormalizedDomainEvent,
} from './events.js';
import {
  createReplayExecutionContext,
  replayEventSequenceHash,
  replayInputHash,
  type ExecutionContext,
  type ReplayManifest,
} from './replay.js';
import type { VirtualReplayClock } from './replay-clock.js';

export type ReplayDispatch = Readonly<{
  context: ExecutionContext;
  event: NormalizedDomainEvent;
  index: number;
  logicalTimestampMs: number;
}>;

export type ReplayResult = Readonly<{
  eventCount: number;
  eventSequenceHash: string;
  finalEventId: string | null;
  inputHash: string;
  manifestId: string;
  namespace: string;
  runId: string;
}>;

export class DeterministicReplayRunner {
  readonly #clock: VirtualReplayClock;
  readonly #context: ExecutionContext;
  readonly #events: readonly NormalizedDomainEvent[];
  readonly #manifest: ReplayManifest;
  readonly #onEvent: (dispatch: ReplayDispatch) => Promise<void>;
  #started = false;

  constructor(
    options: Readonly<{
      clock: VirtualReplayClock;
      events: readonly NormalizedDomainEvent[];
      manifest: ReplayManifest;
      onEvent: (dispatch: ReplayDispatch) => Promise<void>;
      runId: string;
    }>,
  ) {
    this.#clock = options.clock;
    this.#context = createReplayExecutionContext(options.runId);
    this.#events = options.events
      .map((event) => normalizedDomainEventSchema.parse(event))
      .sort(compareEventOrder);
    this.#manifest = options.manifest;
    this.#onEvent = options.onEvent;
    if (
      new Set(this.#events.map(({ eventId }) => eventId)).size !== this.#events.length
    ) {
      throw new Error('Replay input contains duplicate event IDs.');
    }
    if (
      this.#events.some(
        ({ fixtureId }) => fixtureId !== options.manifest.fixture.fixtureId,
      )
    ) {
      throw new Error('Replay event fixture does not match its manifest.');
    }
    if (
      options.manifest.eventCount !== this.#events.length ||
      options.manifest.inputHash !== replayInputHash(this.#events) ||
      options.manifest.eventSequenceHash !== replayEventSequenceHash(this.#events)
    ) {
      throw new Error('Replay events do not match the deterministic manifest.');
    }
  }

  pause(): void {
    this.#clock.pause();
  }

  resume(): void {
    this.#clock.resume();
  }

  stop(): void {
    this.#clock.stop();
  }

  async run(): Promise<ReplayResult> {
    if (this.#started) throw new Error('Replay runner can only execute once.');
    this.#started = true;
    const firstTimestamp =
      this.#events[0]?.sourceTimestampMs ?? this.#manifest.source.startMs;
    this.#clock.start(firstTimestamp);
    for (const [index, event] of this.#events.entries()) {
      await this.#clock.advanceTo(event.sourceTimestampMs);
      await this.#onEvent({
        context: this.#context,
        event,
        index,
        logicalTimestampMs: event.sourceTimestampMs,
      });
    }
    return {
      eventCount: this.#events.length,
      eventSequenceHash: replayEventSequenceHash(this.#events),
      finalEventId: this.#events.at(-1)?.eventId ?? null,
      inputHash: replayInputHash(this.#events),
      manifestId: this.#manifest.manifestId,
      namespace: this.#context.namespace,
      runId: this.#context.mode === 'replay' ? this.#context.runId : '',
    };
  }
}
