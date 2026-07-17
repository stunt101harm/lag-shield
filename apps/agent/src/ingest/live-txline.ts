import {
  normalizeTxLinePayload,
  TxLineStreamSupervisor,
  type SseMessage,
  type StreamIngestObservation,
  type StreamSnapshot,
  type StreamSupervisorConfig,
  type TxLineApiClient,
  type TxLineFixture,
  type TxLineStreamKind,
} from '@lagshield/txline';
import type {
  AppendResult,
  Clock,
  DomainStore,
  NormalizedDomainEvent,
} from '@lagshield/core';

export type LiveIngestionSnapshot = Readonly<{
  discoveredFixtureIds: readonly string[];
  fixtureDiscoveryAtMs: number | null;
  fixtureDiscoveryDiagnostic: string | null;
  odds: StreamSnapshot;
  scores: StreamSnapshot;
}>;

type LiveClient = Pick<TxLineApiClient, 'discoverWorldCupFixtures' | 'openDataStream'>;

type PersistedEventHandler = (event: NormalizedDomainEvent) => Promise<void>;

function isHeartbeat(message: SseMessage): boolean {
  const names = ['heartbeat', 'keepalive', 'ping'];
  return (
    names.includes(message.event.toLowerCase()) ||
    names.includes(message.data.trim().toLowerCase())
  );
}

function parseMessagePayload(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

function observationFrom(
  normalized: ReturnType<typeof normalizeTxLinePayload>,
  result: AppendResult,
): StreamIngestObservation {
  return normalized.ok
    ? {
        fixtureId: normalized.event.fixtureId,
        sourceTimestampMs: normalized.event.sourceTimestampMs,
        status: result.status,
      }
    : {
        fixtureId: normalized.quarantine.fixtureId,
        sourceTimestampMs: normalized.quarantine.sourceTimestampMs,
        status: result.status,
      };
}

export class LiveTxLineIngestion {
  readonly #client: LiveClient;
  readonly #clock: Clock;
  readonly #onPersistedEvent: PersistedEventHandler;
  readonly #odds: TxLineStreamSupervisor;
  readonly #scores: TxLineStreamSupervisor;
  readonly #store: DomainStore;
  #discoveredFixtureIds: string[] = [];
  #fixtureDiscoveryAtMs: number | null = null;
  #fixtureDiscoveryDiagnostic: string | null = null;
  #started = false;

  constructor(
    options: Readonly<{
      client: LiveClient;
      clock: Clock;
      onPersistedEvent?: PersistedEventHandler;
      random?: () => number;
      store: DomainStore;
      streamConfig?: Partial<StreamSupervisorConfig>;
    }>,
  ) {
    this.#client = options.client;
    this.#clock = options.clock;
    this.#store = options.store;
    this.#onPersistedEvent = options.onPersistedEvent ?? (async () => undefined);
    const createSupervisor = (kind: TxLineStreamKind) =>
      new TxLineStreamSupervisor({
        client: options.client,
        clock: options.clock,
        ...(options.random ? { random: options.random } : {}),
        ...(options.streamConfig ? { config: options.streamConfig } : {}),
        kind,
        onMessage: (message) => this.#ingestStreamMessage(kind, message),
      });
    this.#odds = createSupervisor('odds');
    this.#scores = createSupervisor('scores');
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('Live TxLINE ingestion is already started.');
    this.#started = true;
    await this.#discoverFixtures();
    this.#odds.start();
    this.#scores.start();
  }

  async stop(): Promise<void> {
    await Promise.all([this.#odds.stop(), this.#scores.stop()]);
  }

  snapshot(): LiveIngestionSnapshot {
    return {
      discoveredFixtureIds: this.#discoveredFixtureIds,
      fixtureDiscoveryAtMs: this.#fixtureDiscoveryAtMs,
      fixtureDiscoveryDiagnostic: this.#fixtureDiscoveryDiagnostic,
      odds: this.#odds.snapshot(),
      scores: this.#scores.snapshot(),
    };
  }

  async #discoverFixtures(): Promise<void> {
    try {
      const fixtures = await this.#client.discoverWorldCupFixtures();
      for (const fixture of fixtures) await this.#ingestFixture(fixture);
      this.#discoveredFixtureIds = fixtures
        .map(({ FixtureId }) => String(FixtureId))
        .sort();
      this.#fixtureDiscoveryAtMs = this.#clock.nowMs();
      this.#fixtureDiscoveryDiagnostic = null;
      this.#odds.trackFixtures(this.#discoveredFixtureIds);
      this.#scores.trackFixtures(this.#discoveredFixtureIds);
    } catch {
      this.#fixtureDiscoveryAtMs = this.#clock.nowMs();
      this.#fixtureDiscoveryDiagnostic = 'fixture_discovery_failed';
    }
  }

  async #ingestFixture(fixture: TxLineFixture): Promise<void> {
    const normalized = normalizeTxLinePayload(
      { payloadKind: 'fixture', rawPayload: fixture, source: 'txline-snapshot' },
      this.#clock,
    );
    const result = normalized.ok
      ? await this.#store.appendEvent({ event: normalized.event, raw: normalized.raw })
      : await this.#store.quarantine(normalized.quarantine);
    if (normalized.ok && result.status === 'inserted') {
      await this.#onPersistedEvent(normalized.event);
    }
  }

  async #ingestStreamMessage(
    kind: TxLineStreamKind,
    message: SseMessage,
  ): Promise<readonly StreamIngestObservation[]> {
    if (isHeartbeat(message)) return [];
    const parsed = parseMessagePayload(message.data);
    const records = Array.isArray(parsed) ? parsed : [parsed];
    const observations: StreamIngestObservation[] = [];
    for (const rawPayload of records) {
      const normalized = normalizeTxLinePayload(
        {
          payloadKind: kind === 'scores' ? 'score' : 'odds',
          rawPayload,
          source: 'txline-live',
        },
        this.#clock,
      );
      const result = normalized.ok
        ? await this.#store.appendEvent({ event: normalized.event, raw: normalized.raw })
        : await this.#store.quarantine(normalized.quarantine);
      if (normalized.ok && result.status === 'inserted') {
        await this.#onPersistedEvent(normalized.event);
      }
      observations.push(observationFrom(normalized, result));
    }
    return observations;
  }
}
