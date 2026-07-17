import type { DomainEventSource, NormalizedDomainEvent } from './events.js';
import type { JsonValue } from './json.js';
import type { MarketControlSnapshot, StrategyDecision } from './models.js';

export type RawIngestInput = Readonly<{
  fixtureId: string | null;
  idempotencyKey: string;
  ingestId: string;
  payloadKind: string;
  payloadVersion: number;
  rawPayload: JsonValue;
  receivedAtMs: number;
  source: DomainEventSource;
  sourceId: string;
  sourceTimestampMs: number | null;
}>;

export type QuarantineInput = RawIngestInput &
  Readonly<{
    code: 'malformed_payload' | 'unknown_payload_kind' | 'unsupported_payload_version';
    issues: readonly string[];
  }>;

export type AppendResult = Readonly<{
  recordId: string;
  status: 'inserted' | 'duplicate' | 'quarantined';
}>;

export type FixtureEventPage = Readonly<{
  events: readonly NormalizedDomainEvent[];
  nextCursor: string | null;
}>;

export interface DomainStore {
  appendDecision(decision: StrategyDecision): Promise<AppendResult>;
  appendEvent(
    input: Readonly<{ event: NormalizedDomainEvent; raw: RawIngestInput }>,
  ): Promise<AppendResult>;
  loadMarketControlState(marketId: string): Promise<MarketControlSnapshot | null>;
  listFixtureEvents(
    input: Readonly<{
      afterEventId?: string;
      fixtureId: string;
      limit: number;
    }>,
  ): Promise<FixtureEventPage>;
  quarantine(input: QuarantineInput): Promise<AppendResult>;
}

export function assertBoundedQueryLimit(limit: number, maximum = 500): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`Query limit must be an integer between 1 and ${maximum}.`);
  }
}
