import {
  FixedClock,
  canonicalJson,
  type AppendResult,
  type DomainStore,
  type FixtureEventPage,
  type MarketControlSnapshot,
  type NormalizedDomainEvent,
  type QuarantineInput,
  type RawIngestInput,
  type ReplayManifest,
} from '@lagshield/core';
import { type HistoricalOddsInterval } from '@lagshield/txline';
import { describe, expect, it } from 'vitest';

import {
  TxLineHistoricalHydrator,
  replayIntervalIdentity,
  type HistoricalFixtureSelection,
} from './historical-hydrator.js';

const fixtureId = 18_241_006;
const sourceStartMs = Date.UTC(2026, 6, 17, 12, 1);
const sourceEndMs = Date.UTC(2026, 6, 17, 12, 9);
const clock = new FixedClock(Date.UTC(2026, 6, 17, 14));
const fixture: HistoricalFixtureSelection = {
  competitionId: '72',
  fixtureId,
  scheduledAtMs: sourceStartMs - 60 * 60 * 1_000,
  sourceEndMs,
  sourceStartMs,
};

function odds(messageId: string, timestampMs: number, prices = [2100, 3300, 2900]) {
  return {
    Bookmaker: 'TxODDS Consensus',
    BookmakerId: 7,
    FixtureId: fixtureId,
    InRunning: true,
    MessageId: messageId,
    PriceNames: ['Canada', 'Draw', 'Japan'],
    Prices: prices,
    SuperOddsType: '1X2',
    Ts: timestampMs,
  };
}

function score(sequence: number, timestampMs: number) {
  return {
    action: 'goal',
    fixtureId,
    seq: sequence,
    stats: { '1': 1, '2': 0 },
    ts: timestampMs,
  };
}

class MemoryDomainStore implements DomainStore {
  readonly events = new Map<
    string,
    Readonly<{ event: NormalizedDomainEvent; raw: RawIngestInput }>
  >();
  readonly quarantines = new Map<string, QuarantineInput>();
  readonly replayManifests = new Map<
    string,
    Readonly<{
      createdAtMs: number;
      manifest: ReplayManifest;
      retentionExpiresAtMs: number | null;
    }>
  >();

  async appendDecision(): Promise<AppendResult> {
    throw new Error('Not used by historical hydration tests.');
  }

  async appendEvent(
    input: Readonly<{ event: NormalizedDomainEvent; raw: RawIngestInput }>,
  ): Promise<AppendResult> {
    const existing = this.events.get(input.event.idempotencyKey);
    if (existing) {
      if (
        canonicalJson(existing.raw.rawPayload) !== canonicalJson(input.raw.rawPayload)
      ) {
        throw new Error('Conflicting replay test payload.');
      }
      return { recordId: existing.event.eventId, status: 'duplicate' };
    }
    this.events.set(input.event.idempotencyKey, input);
    return { recordId: input.event.eventId, status: 'inserted' };
  }

  async loadMarketControlState(): Promise<MarketControlSnapshot | null> {
    return null;
  }

  async listFixtureEvents(): Promise<FixtureEventPage> {
    return { events: [], nextCursor: null };
  }

  async purgeExpiredRawPayloads(): Promise<number> {
    return 0;
  }

  async quarantine(input: QuarantineInput): Promise<AppendResult> {
    if (this.quarantines.has(input.idempotencyKey)) {
      return { recordId: input.ingestId, status: 'duplicate' };
    }
    this.quarantines.set(input.idempotencyKey, input);
    return { recordId: input.ingestId, status: 'quarantined' };
  }

  async saveReplayManifest(
    input: Readonly<{
      createdAtMs: number;
      manifest: ReplayManifest;
      retentionExpiresAtMs: number | null;
    }>,
  ): Promise<AppendResult> {
    if (this.replayManifests.has(input.manifest.manifestId)) {
      return { recordId: input.manifest.manifestId, status: 'duplicate' };
    }
    this.replayManifests.set(input.manifest.manifestId, input);
    return { recordId: input.manifest.manifestId, status: 'inserted' };
  }
}

function historicalClient(
  options: Readonly<{ reverse?: boolean; crossFixture?: boolean }> = {},
) {
  const requestedIntervals: string[] = [];
  return {
    requestedIntervals,
    client: {
      async fetchHistoricalScores(requestedFixtureId: number) {
        expect(requestedFixtureId).toBe(fixtureId);
        if (options.crossFixture) {
          return [{ ...score(1, sourceStartMs + 1_000), fixtureId: fixtureId + 1 }];
        }
        return [
          score(2, sourceStartMs + 90_000),
          score(1, sourceStartMs + 30_000),
          score(99, sourceEndMs + 1),
        ];
      },
      async fetchHistoricalOddsInterval(
        interval: HistoricalOddsInterval,
        request: Readonly<{ fixtureId?: number }>,
      ) {
        expect(request.fixtureId).toBe(fixtureId);
        requestedIntervals.push(replayIntervalIdentity(interval));
        const first = odds('odds-1', sourceStartMs + 60_000);
        const second = odds('odds-2', sourceStartMs + 6 * 60_000, [2000, 3400, 3000]);
        const malformed = {
          FixtureId: fixtureId,
          MessageId: 'bad',
          Ts: sourceStartMs + 2 * 60_000,
        };
        const records =
          interval.interval === 0 ? [second, first, malformed] : [first, second];
        return options.reverse ? [...records].reverse() : records;
      },
    },
  };
}

async function hydrate(reverse = false) {
  const store = new MemoryDomainStore();
  const fake = historicalClient({ reverse });
  const result = await new TxLineHistoricalHydrator({
    client: fake.client,
    clock,
    fetchConcurrency: 2,
    rawRetentionMs: 60 * 60 * 1_000,
    replayStore: store,
    store,
  }).hydrate({
    fixture,
    strategyConfiguration: { lagPauseMs: 5_000, stableWindow: 3 },
    strategyVersion: 'lag-shield-v1',
  });
  return { fake, result, store };
}

describe('TxLineHistoricalHydrator', () => {
  it('hydrates every interval, filters the selected range, deduplicates, and quarantines bad input', async () => {
    const { fake, result, store } = await hydrate();

    expect(fake.requestedIntervals).toEqual([
      `${Math.floor(sourceStartMs / 86_400_000)}/12/0`,
      `${Math.floor(sourceStartMs / 86_400_000)}/12/1`,
    ]);
    expect(result.events).toHaveLength(4);
    expect(result.insertedCount).toBe(4);
    expect(result.duplicateCount).toBe(2);
    expect(result.quarantineCount).toBe(1);
    expect(result.events.map(({ sourceTimestampMs }) => sourceTimestampMs)).toEqual([
      sourceStartMs + 30_000,
      sourceStartMs + 60_000,
      sourceStartMs + 90_000,
      sourceStartMs + 6 * 60_000,
    ]);
    expect(
      result.events.every(
        ({ receivedAtMs, sourceTimestampMs }) => receivedAtMs === sourceTimestampMs,
      ),
    ).toBe(true);
    expect(result.retentionExpiresAtMs).toBe(clock.nowMs() + 60 * 60 * 1_000);
    expect(
      [...store.events.values()].every(
        ({ raw }) => raw.retentionExpiresAtMs === result.retentionExpiresAtMs,
      ),
    ).toBe(true);
    expect([...store.quarantines.values()][0]?.retentionExpiresAtMs).toBe(
      result.retentionExpiresAtMs,
    );
    expect(result.manifest).toMatchObject({
      eventCount: 4,
      fixture: { fixtureId: String(fixtureId) },
      source: { startMs: sourceStartMs, endMs: sourceEndMs },
    });
    expect(store.replayManifests.get(result.manifest.manifestId)?.manifest).toEqual(
      result.manifest,
    );
  });

  it('produces an identical manifest and event order regardless of response order', async () => {
    const forward = await hydrate(false);
    const reverse = await hydrate(true);

    expect(reverse.result.events).toEqual(forward.result.events);
    expect(reverse.result.manifest).toEqual(forward.result.manifest);
  });

  it('rejects a payload from a fixture outside the selected replay namespace', async () => {
    const fake = historicalClient({ crossFixture: true });
    const hydrator = new TxLineHistoricalHydrator({
      client: fake.client,
      clock,
      replayStore: new MemoryDomainStore(),
      store: new MemoryDomainStore(),
    });

    await expect(
      hydrator.hydrate({
        fixture,
        strategyConfiguration: {},
        strategyVersion: 'lag-shield-v1',
      }),
    ).rejects.toThrow('fixture does not match');
  });
});
