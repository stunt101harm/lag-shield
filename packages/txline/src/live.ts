import type { Clock } from '@lagshield/core';

import { TxLineApiError } from './errors.js';
import { readSseMessages, SseLimitError, type SseMessage } from './sse.js';
import type { TxLineApiClient, TxLineStreamKind } from './client.js';

export type StreamIngestObservation = Readonly<{
  fixtureId: string | null;
  sourceTimestampMs: number | null;
  status: 'inserted' | 'duplicate' | 'quarantined';
}>;

export type StreamConnectionState =
  'idle' | 'connecting' | 'connected' | 'backoff' | 'stopped';

export type StreamSnapshot = Readonly<{
  acceptedCount: number;
  connectedAtMs: number | null;
  duplicateCount: number;
  kind: TxLineStreamKind;
  lastActivityAtMs: number | null;
  lastDiagnostic: string | null;
  lastEventAtMs: number | null;
  lastEventId: string | null;
  lastSourceTimestampMs: number | null;
  quarantineCount: number;
  reconnectCount: number;
  retryDelayMs: number | null;
  state: StreamConnectionState;
  streamLagMs: number | null;
  trackedFixtureIds: readonly string[];
}>;

export type StreamSupervisorConfig = Readonly<{
  backoffBaseMs: number;
  backoffJitterRatio: number;
  backoffMaximumMs: number;
  connectionTimeoutMs: number;
  heartbeatTimeoutMs: number;
  maximumEventCharacters: number;
}>;

const defaultConfig: StreamSupervisorConfig = {
  backoffBaseMs: 500,
  backoffJitterRatio: 0.2,
  backoffMaximumMs: 30_000,
  connectionTimeoutMs: 15_000,
  heartbeatTimeoutMs: 45_000,
  maximumEventCharacters: 1_048_576,
};

class StreamTimeoutError extends Error {
  constructor(readonly phase: 'connection' | 'heartbeat') {
    super(`TxLINE stream ${phase} timeout.`);
    this.name = 'StreamTimeoutError';
  }
}

class StreamDisconnectedError extends Error {
  constructor() {
    super('TxLINE stream connection ended.');
    this.name = 'StreamDisconnectedError';
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function resolveConfig(input: Partial<StreamSupervisorConfig>): StreamSupervisorConfig {
  const config = { ...defaultConfig, ...input };
  for (const key of [
    'backoffBaseMs',
    'backoffMaximumMs',
    'connectionTimeoutMs',
    'heartbeatTimeoutMs',
    'maximumEventCharacters',
  ] as const) {
    assertPositiveInteger(key, config[key]);
  }
  if (config.backoffMaximumMs < config.backoffBaseMs) {
    throw new Error('backoffMaximumMs must be at least backoffBaseMs.');
  }
  if (config.backoffJitterRatio < 0 || config.backoffJitterRatio > 1) {
    throw new Error('backoffJitterRatio must be between 0 and 1.');
  }
  return config;
}

function diagnosticFor(error: unknown): string {
  if (error instanceof TxLineApiError && error.status === 403) {
    return 'subscription_denied: verify API token, network, subscription, and league bundle';
  }
  if (error instanceof TxLineApiError && error.status === 401) {
    return 'guest_authentication_failed_after_renewal';
  }
  if (error instanceof StreamTimeoutError) return `${error.phase}_timeout`;
  if (error instanceof SseLimitError) return 'sse_event_limit_exceeded';
  if (error instanceof StreamDisconnectedError) return 'stream_disconnected';
  if (error instanceof SyntaxError) return 'invalid_sse_json';
  return 'stream_error';
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

type MutableMetrics = {
  acceptedCount: number;
  connectedAtMs: number | null;
  duplicateCount: number;
  lastActivityAtMs: number | null;
  lastDiagnostic: string | null;
  lastEventAtMs: number | null;
  lastEventId: string | null;
  lastSourceTimestampMs: number | null;
  quarantineCount: number;
  reconnectCount: number;
  retryDelayMs: number | null;
  state: StreamConnectionState;
};

export class TxLineStreamSupervisor {
  readonly #client: Pick<TxLineApiClient, 'openDataStream'>;
  readonly #clock: Clock;
  readonly #config: StreamSupervisorConfig;
  readonly #controller = new AbortController();
  readonly #kind: TxLineStreamKind;
  readonly #onMessage: (
    message: SseMessage,
  ) => Promise<readonly StreamIngestObservation[]>;
  readonly #random: () => number;
  readonly #trackedFixtureIds = new Set<string>();
  readonly #metrics: MutableMetrics = {
    acceptedCount: 0,
    connectedAtMs: null,
    duplicateCount: 0,
    lastActivityAtMs: null,
    lastDiagnostic: null,
    lastEventAtMs: null,
    lastEventId: null,
    lastSourceTimestampMs: null,
    quarantineCount: 0,
    reconnectCount: 0,
    retryDelayMs: null,
    state: 'idle',
  };
  #consecutiveFailures = 0;
  #runPromise: Promise<void> | null = null;
  #serverRetryMs: number | null = null;

  constructor(
    options: Readonly<{
      client: Pick<TxLineApiClient, 'openDataStream'>;
      clock: Clock;
      config?: Partial<StreamSupervisorConfig>;
      kind: TxLineStreamKind;
      onMessage: (message: SseMessage) => Promise<readonly StreamIngestObservation[]>;
      random?: () => number;
    }>,
  ) {
    this.#client = options.client;
    this.#clock = options.clock;
    this.#config = resolveConfig(options.config ?? {});
    this.#kind = options.kind;
    this.#onMessage = options.onMessage;
    this.#random = options.random ?? Math.random;
  }

  start(): void {
    if (this.#runPromise)
      throw new Error(`${this.#kind} stream supervisor is already started.`);
    if (this.#controller.signal.aborted) {
      throw new Error(`${this.#kind} stream supervisor cannot be restarted after stop.`);
    }
    this.#runPromise = this.#run();
  }

  trackFixtures(fixtureIds: readonly string[]): void {
    for (const fixtureId of fixtureIds) {
      if (fixtureId.length > 0) this.#trackedFixtureIds.add(fixtureId);
    }
  }

  async stop(): Promise<void> {
    this.#controller.abort();
    await this.#runPromise;
    this.#metrics.state = 'stopped';
  }

  snapshot(): StreamSnapshot {
    const now = this.#clock.nowMs();
    return {
      ...this.#metrics,
      kind: this.#kind,
      streamLagMs:
        this.#metrics.lastSourceTimestampMs === null
          ? null
          : Math.max(0, now - this.#metrics.lastSourceTimestampMs),
      trackedFixtureIds: [...this.#trackedFixtureIds].sort(),
    };
  }

  async #run(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      try {
        await this.#consumeConnection();
        throw new StreamDisconnectedError();
      } catch (error) {
        if (this.#controller.signal.aborted) break;
        this.#consecutiveFailures += 1;
        this.#metrics.reconnectCount += 1;
        this.#metrics.lastDiagnostic = diagnosticFor(error);
        this.#metrics.state = 'backoff';
        const retryDelayMs = this.#nextRetryDelay();
        this.#metrics.retryDelayMs = retryDelayMs;
        await abortableDelay(retryDelayMs, this.#controller.signal);
      }
    }
    this.#metrics.state = 'stopped';
    this.#metrics.retryDelayMs = null;
  }

  async #consumeConnection(): Promise<void> {
    this.#metrics.state = 'connecting';
    this.#metrics.retryDelayMs = null;
    const connectionController = new AbortController();
    const forwardAbort = () => connectionController.abort(this.#controller.signal.reason);
    this.#controller.signal.addEventListener('abort', forwardAbort, { once: true });
    const connectionTimer = setTimeout(
      () => connectionController.abort(new StreamTimeoutError('connection')),
      this.#config.connectionTimeoutMs,
    );

    try {
      const response = await this.#client.openDataStream(this.#kind, {
        ...(this.#metrics.lastEventId ? { lastEventId: this.#metrics.lastEventId } : {}),
        signal: connectionController.signal,
      });
      clearTimeout(connectionTimer);
      this.#metrics.connectedAtMs = this.#clock.nowMs();
      this.#metrics.lastActivityAtMs = this.#clock.nowMs();
      this.#metrics.lastDiagnostic = null;
      this.#metrics.state = 'connected';

      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      const armHeartbeat = () => {
        this.#metrics.lastActivityAtMs = this.#clock.nowMs();
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        heartbeatTimer = setTimeout(
          () => connectionController.abort(new StreamTimeoutError('heartbeat')),
          this.#config.heartbeatTimeoutMs,
        );
      };
      armHeartbeat();

      try {
        for await (const message of readSseMessages(response.body!, {
          ...(this.#metrics.lastEventId
            ? { initialLastEventId: this.#metrics.lastEventId }
            : {}),
          maximumEventCharacters: this.#config.maximumEventCharacters,
          onActivity: armHeartbeat,
          onLastEventId: (id) => {
            this.#metrics.lastEventId = id || null;
          },
          onRetry: (milliseconds) => {
            this.#serverRetryMs = milliseconds;
          },
        })) {
          if (this.#controller.signal.aborted) break;
          const observations = await this.#onMessage(message);
          if (observations.length > 0) this.#metrics.lastEventAtMs = this.#clock.nowMs();
          for (const observation of observations) this.#recordObservation(observation);
          if (this.#controller.signal.aborted) break;
        }
      } finally {
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
      }
    } catch (error) {
      if (connectionController.signal.reason instanceof StreamTimeoutError) {
        throw connectionController.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(connectionTimer);
      connectionController.abort();
      this.#controller.signal.removeEventListener('abort', forwardAbort);
    }
  }

  #recordObservation(observation: StreamIngestObservation): void {
    if (observation.fixtureId) this.#trackedFixtureIds.add(observation.fixtureId);
    if (observation.sourceTimestampMs !== null) {
      this.#metrics.lastSourceTimestampMs = Math.max(
        this.#metrics.lastSourceTimestampMs ?? 0,
        observation.sourceTimestampMs,
      );
    }
    if (observation.status === 'inserted') {
      this.#metrics.acceptedCount += 1;
      this.#consecutiveFailures = 0;
    } else if (observation.status === 'duplicate') {
      this.#metrics.duplicateCount += 1;
    } else {
      this.#metrics.quarantineCount += 1;
    }
  }

  #nextRetryDelay(): number {
    const exponent = Math.min(this.#consecutiveFailures - 1, 20);
    const exponential = Math.min(
      this.#config.backoffMaximumMs,
      this.#config.backoffBaseMs * 2 ** exponent,
    );
    const requested = this.#serverRetryMs ?? exponential;
    const bounded = Math.min(
      this.#config.backoffMaximumMs,
      Math.max(this.#config.backoffBaseMs, requested),
    );
    const random = this.#random();
    if (!Number.isFinite(random) || random < 0 || random > 1) {
      throw new Error('Stream supervisor random() must return a number between 0 and 1.');
    }
    const jitter = 1 + (random * 2 - 1) * this.#config.backoffJitterRatio;
    return Math.max(1, Math.round(bounded * jitter));
  }
}
