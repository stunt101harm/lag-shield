import {
  compareEventOrder,
  createReplayManifest,
  type Clock,
  type DomainStore,
  type JsonValue,
  type NormalizedDomainEvent,
  type ReplayManifest,
  type ReplayStore,
} from '@lagshield/core';
import {
  normalizeTxLinePayload,
  planHistoricalOddsIntervals,
  type HistoricalOddsInterval,
  type TxLineApiClient,
} from '@lagshield/txline';

type HistoricalClient = Pick<
  TxLineApiClient,
  'fetchHistoricalOddsInterval' | 'fetchHistoricalScores'
>;

export type HistoricalHydrationResult = Readonly<{
  duplicateCount: number;
  events: readonly NormalizedDomainEvent[];
  insertedCount: number;
  manifest: ReplayManifest;
  quarantineCount: number;
  retentionExpiresAtMs: number;
}>;

export type HistoricalFixtureSelection = Readonly<{
  competitionId: string;
  fixtureId: number;
  scheduledAtMs: number;
  sourceEndMs: number;
  sourceStartMs: number;
}>;

function sourceTimestamp(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const candidate = record.Ts ?? record.ts;
  return typeof candidate === 'number' &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0
    ? candidate
    : null;
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('Historical fetch concurrency must be between 1 and 32.');
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

function assertSelection(selection: HistoricalFixtureSelection): void {
  if (!Number.isSafeInteger(selection.fixtureId) || selection.fixtureId < 0) {
    throw new Error('Historical fixtureId must be a non-negative safe integer.');
  }
  if (selection.competitionId.length === 0) {
    throw new Error('Historical competitionId is required.');
  }
  for (const [label, value] of [
    ['scheduledAtMs', selection.scheduledAtMs],
    ['sourceStartMs', selection.sourceStartMs],
    ['sourceEndMs', selection.sourceEndMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative safe integer timestamp.`);
    }
  }
  if (selection.sourceEndMs < selection.sourceStartMs) {
    throw new Error('Historical sourceEndMs must not be before sourceStartMs.');
  }
}

export class TxLineHistoricalHydrator {
  readonly #client: HistoricalClient;
  readonly #clock: Clock;
  readonly #fetchConcurrency: number;
  readonly #rawRetentionMs: number;
  readonly #replayStore: Pick<ReplayStore, 'saveReplayManifest'>;
  readonly #store: DomainStore;

  constructor(
    options: Readonly<{
      client: HistoricalClient;
      clock: Clock;
      fetchConcurrency?: number;
      rawRetentionMs?: number;
      replayStore: Pick<ReplayStore, 'saveReplayManifest'>;
      store: DomainStore;
    }>,
  ) {
    this.#client = options.client;
    this.#clock = options.clock;
    this.#fetchConcurrency = options.fetchConcurrency ?? 4;
    this.#rawRetentionMs = options.rawRetentionMs ?? 24 * 60 * 60 * 1_000;
    this.#replayStore = options.replayStore;
    this.#store = options.store;
    if (
      !Number.isSafeInteger(this.#rawRetentionMs) ||
      this.#rawRetentionMs < 60 * 1_000
    ) {
      throw new Error('Historical raw retention must be at least one minute.');
    }
  }

  async hydrate(
    input: Readonly<{
      fixture: HistoricalFixtureSelection;
      strategyConfiguration: JsonValue;
      strategyVersion: string;
    }>,
  ): Promise<HistoricalHydrationResult> {
    assertSelection(input.fixture);
    const intervals = planHistoricalOddsIntervals({
      endMs: input.fixture.sourceEndMs,
      startMs: input.fixture.sourceStartMs,
    });
    const [scores, oddsByInterval] = await Promise.all([
      this.#client.fetchHistoricalScores(input.fixture.fixtureId),
      mapConcurrent(intervals, this.#fetchConcurrency, (interval) =>
        this.#client.fetchHistoricalOddsInterval(interval, {
          fixtureId: input.fixture.fixtureId,
        }),
      ),
    ]);
    const hydratedAtMs = this.#clock.nowMs();
    if (input.fixture.sourceEndMs > hydratedAtMs) {
      throw new Error('Historical source range must not end in the future.');
    }
    const retentionExpiresAtMs = hydratedAtMs + this.#rawRetentionMs;
    if (!Number.isSafeInteger(retentionExpiresAtMs)) {
      throw new Error('Historical retention expiry exceeds the safe timestamp range.');
    }
    const events = new Map<string, NormalizedDomainEvent>();
    let duplicateCount = 0;
    let insertedCount = 0;
    let quarantineCount = 0;

    const ingest = async (payloadKind: 'odds' | 'score', rawPayload: unknown) => {
      const timestamp = sourceTimestamp(rawPayload);
      if (
        timestamp !== null &&
        (timestamp < input.fixture.sourceStartMs || timestamp > input.fixture.sourceEndMs)
      ) {
        return;
      }
      const normalized = normalizeTxLinePayload(
        {
          payloadKind,
          rawPayload,
          ...(timestamp === null ? {} : { receivedAtMs: timestamp }),
          source: 'txline-historical',
        },
        this.#clock,
      );
      if (!normalized.ok) {
        const result = await this.#store.quarantine({
          ...normalized.quarantine,
          retentionExpiresAtMs,
        });
        if (result.status === 'duplicate') duplicateCount += 1;
        else quarantineCount += 1;
        return;
      }
      if (normalized.event.fixtureId !== String(input.fixture.fixtureId)) {
        throw new Error(
          'Historical TxLINE payload fixture does not match the selection.',
        );
      }
      const result = await this.#store.appendEvent({
        event: normalized.event,
        raw: { ...normalized.raw, retentionExpiresAtMs },
      });
      events.set(normalized.event.eventId, normalized.event);
      if (result.status === 'duplicate') duplicateCount += 1;
      else insertedCount += 1;
    };

    for (const score of scores) await ingest('score', score);
    for (const odds of oddsByInterval.flat()) await ingest('odds', odds);

    const orderedEvents = [...events.values()].sort(compareEventOrder);
    const manifest = createReplayManifest({
      events: orderedEvents,
      fixture: {
        competitionId: input.fixture.competitionId,
        fixtureId: String(input.fixture.fixtureId),
        scheduledAtMs: input.fixture.scheduledAtMs,
      },
      normalizerVersion: 'txline-normalizer-v2-pct',
      oddsIntervals: [...intervals],
      orderingVersion: 'event-order-v1',
      sourceEndMs: input.fixture.sourceEndMs,
      sourceStartMs: input.fixture.sourceStartMs,
      strategyConfiguration: input.strategyConfiguration,
      strategyVersion: input.strategyVersion,
    });
    await this.#replayStore.saveReplayManifest({
      createdAtMs: hydratedAtMs,
      manifest,
      retentionExpiresAtMs,
    });

    return {
      duplicateCount,
      events: orderedEvents,
      insertedCount,
      manifest,
      quarantineCount,
      retentionExpiresAtMs,
    };
  }
}

export function replayIntervalIdentity(interval: HistoricalOddsInterval): string {
  return `${interval.epochDay}/${interval.hourOfDay}/${interval.interval}`;
}
