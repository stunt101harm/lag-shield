import {
  FixedClock,
  type AppendResult,
  type DomainStore,
  type FixtureEventPage,
  type MarketControlSnapshot,
  type NormalizedDomainEvent,
  type QuarantineInput,
  type RawIngestInput,
  type StrategyDecision,
} from '@lagshield/core';
import type { TxLineStreamKind } from '@lagshield/txline';
import { describe, expect, it } from 'vitest';

import { LiveTxLineIngestion } from './live-txline.js';

const encoder = new TextEncoder();
const clock = new FixedClock(1_800_000_000_000);

class RecordingStore implements DomainStore {
  readonly events: NormalizedDomainEvent[] = [];
  readonly operationLog: string[] = [];
  readonly quarantines: QuarantineInput[] = [];
  readonly #eventIds = new Set<string>();
  readonly #quarantineIds = new Set<string>();

  async appendDecision(_decision: StrategyDecision): Promise<AppendResult> {
    void _decision;
    throw new Error('Not used by live ingestion.');
  }

  async appendEvent(
    input: Readonly<{
      event: NormalizedDomainEvent;
      raw: RawIngestInput;
    }>,
  ): Promise<AppendResult> {
    void input.raw;
    const duplicate = this.#eventIds.has(input.event.eventId);
    this.#eventIds.add(input.event.eventId);
    this.operationLog.push(`persist:${input.event.eventId}`);
    if (!duplicate) this.events.push(input.event);
    return {
      recordId: input.event.eventId,
      status: duplicate ? 'duplicate' : 'inserted',
    };
  }

  async loadMarketControlState(_marketId: string): Promise<MarketControlSnapshot | null> {
    void _marketId;
    return null;
  }

  async listFixtureEvents(
    _input: Readonly<{
      afterEventId?: string;
      fixtureId: string;
      limit: number;
    }>,
  ): Promise<FixtureEventPage> {
    void _input;
    return { events: this.events, nextCursor: null };
  }

  async purgeExpiredRawPayloads(
    _input: Readonly<{
      limit: number;
      nowMs: number;
    }>,
  ): Promise<number> {
    void _input;
    return 0;
  }

  async quarantine(input: QuarantineInput): Promise<AppendResult> {
    const duplicate = this.#quarantineIds.has(input.ingestId);
    this.#quarantineIds.add(input.ingestId);
    if (!duplicate) this.quarantines.push(input);
    return {
      recordId: input.ingestId,
      status: duplicate ? 'duplicate' : 'quarantined',
    };
  }
}

async function waitFor(
  assertion: () => boolean,
  timeoutMs = 1_000,
  diagnostics: () => unknown = () => ({}),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ingestion: ${JSON.stringify(diagnostics())}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('LiveTxLineIngestion', () => {
  it('discovers quiet fixtures, persists before dispatch, deduplicates, and surfaces quarantine', async () => {
    const controllers = new Map<
      TxLineStreamKind,
      ReadableStreamDefaultController<Uint8Array>
    >();
    const client = {
      discoverWorldCupFixtures: async () => [
        {
          Competition: 'FIFA World Cup',
          CompetitionId: 72,
          FixtureGroupId: 1,
          FixtureId: 42,
          GameState: 1,
          Participant1: 'Canada',
          Participant1Id: 10,
          Participant1IsHome: true,
          Participant2: 'Japan',
          Participant2Id: 20,
          StartTime: 1_900_000_000_000,
          Ts: 1_799_999_000_000,
        },
      ],
      openDataStream: async (
        kind: TxLineStreamKind,
        options: Readonly<{ signal?: AbortSignal }> = {},
      ) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.set(kind, controller);
              options.signal?.addEventListener(
                'abort',
                () => controller.error(new DOMException('Aborted', 'AbortError')),
                { once: true },
              );
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    };
    const store = new RecordingStore();
    const ingestion = new LiveTxLineIngestion({
      client,
      clock,
      onPersistedEvent: async (event) => {
        store.operationLog.push(`dispatch:${event.eventId}`);
      },
      random: () => 0.5,
      store,
      streamConfig: {
        backoffBaseMs: 1,
        backoffJitterRatio: 0,
        backoffMaximumMs: 2,
        connectionTimeoutMs: 100,
        heartbeatTimeoutMs: 1_000,
      },
    });

    await ingestion.start();
    await waitFor(() => controllers.size === 2);
    expect(ingestion.snapshot().discoveredFixtureIds).toEqual(['42']);
    expect(ingestion.snapshot().odds.trackedFixtureIds).toEqual(['42']);
    expect(ingestion.snapshot().scores.trackedFixtureIds).toEqual(['42']);

    const odds = {
      Bookmaker: 'TxODDS Consensus',
      BookmakerId: 7,
      FixtureId: 42,
      InRunning: true,
      MessageId: 'odds-live-1',
      PriceNames: ['Canada', 'Draw', 'Japan'],
      Prices: [2100, 3300, 2900],
      SuperOddsType: '1X2',
      Ts: 1_799_999_999_000,
    };
    controllers
      .get('odds')!
      .enqueue(
        encoder.encode(
          `event: heartbeat\ndata: ping\n\nid: odds-1\ndata: ${JSON.stringify(odds)}\n\n` +
            `id: odds-1\ndata: ${JSON.stringify(odds)}\n\n` +
            'id: bad\ndata: not-json\n\n',
        ),
      );
    controllers.get('scores')!.enqueue(
      encoder.encode(
        `id: score-1\ndata: ${JSON.stringify({
          action: 'score_update',
          fixtureId: 42,
          seq: 7,
          stats: { '1': 1, '2': 0 },
          ts: 1_799_999_999_100,
        })}\n\n`,
      ),
    );

    await waitFor(
      () =>
        ingestion.snapshot().odds.acceptedCount === 1 &&
        ingestion.snapshot().odds.duplicateCount === 1 &&
        ingestion.snapshot().odds.quarantineCount === 1 &&
        ingestion.snapshot().scores.acceptedCount === 1,
      1_000,
      () => ({
        events: store.events.map(({ kind }) => kind),
        quarantines: store.quarantines.length,
        snapshot: ingestion.snapshot(),
      }),
    );
    await ingestion.stop();

    expect(store.events.map(({ kind }) => kind)).toHaveLength(3);
    expect(store.events.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(['fixture.observed', 'odds.observed', 'score.observed']),
    );
    expect(store.quarantines).toHaveLength(1);
    for (const event of store.events) {
      const persist = store.operationLog.indexOf(`persist:${event.eventId}`);
      const dispatch = store.operationLog.indexOf(`dispatch:${event.eventId}`);
      expect(persist).toBeGreaterThanOrEqual(0);
      expect(dispatch).toBeGreaterThan(persist);
      expect(
        store.operationLog.filter((entry) => entry === `dispatch:${event.eventId}`),
      ).toHaveLength(1);
    }
  });
});
