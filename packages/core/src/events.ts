import { z } from 'zod';

import { stableHash, type JsonValue } from './json.js';

export const domainEventSources = [
  'txline-historical',
  'txline-snapshot',
  'txline-live',
  'simulation',
] as const;
export const domainEventSourceSchema = z.enum(domainEventSources);
export type DomainEventSource = z.infer<typeof domainEventSourceSchema>;

export const sourcePriorities = {
  simulation: 0,
  'txline-historical': 10,
  'txline-snapshot': 20,
  'txline-live': 30,
} as const satisfies Record<DomainEventSource, number>;

const identifierSchema = z.string().min(1).max(512);
const epochMillisecondsSchema = z.number().int().nonnegative().safe();
const participantSchema = z
  .object({
    id: identifierSchema,
    name: z.string().min(1).max(200),
    role: z.enum(['home', 'away']),
  })
  .strict();

export const fixtureObservedPayloadSchema = z
  .object({
    competition: z.string().min(1).max(200),
    competitionId: identifierSchema,
    fixtureId: identifierSchema,
    participants: z.tuple([participantSchema, participantSchema]),
    scheduledAtMs: epochMillisecondsSchema,
    status: z.enum(['scheduled', 'live', 'finished', 'cancelled', 'unknown']),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.participants[0].role === payload.participants[1].role) {
      context.addIssue({
        code: 'custom',
        message: 'Fixture requires one home and one away team.',
      });
    }
  });

const outcomeQuoteSchema = z
  .object({
    name: z.string().min(1).max(200),
    outcomeId: identifierSchema,
    price: z.number().int().safe(),
  })
  .strict();

const outcomeQuoteV2Schema = outcomeQuoteSchema.extend({
  reportedProbabilityMicros: z.number().int().min(0).max(1_000_000).nullable(),
});

export const oddsObservedPayloadSchema = z
  .object({
    bookmaker: z
      .object({ id: identifierSchema, name: z.string().min(1).max(200) })
      .strict(),
    fixtureId: identifierSchema,
    market: z
      .object({
        gameState: z.string().max(100).nullable(),
        inRunning: z.boolean(),
        marketId: identifierSchema,
        parameters: z.string().max(500).nullable(),
        period: z.string().max(100).nullable(),
        status: z.enum(['open', 'suspended']),
        type: z.string().min(1).max(200),
      })
      .strict(),
    outcomes: z.array(outcomeQuoteSchema).max(100),
    priceEncoding: z.literal('txline-native-i32-v1'),
  })
  .strict();

export const oddsObservedPayloadV2Schema = oddsObservedPayloadSchema.extend({
  outcomes: z.array(outcomeQuoteV2Schema).max(100),
  probabilityEncoding: z.literal('txline-pct-percent-3dp-v1'),
});

const scoreStatSchema = z
  .object({
    key: z.number().int().nonnegative(),
    period: z.number().int(),
    value: z.number().int(),
  })
  .strict();

export const scoreObservedPayloadSchema = z
  .object({
    action: z.string().min(1).max(200),
    awayScore: z.number().int().nonnegative().nullable(),
    fixtureId: identifierSchema,
    homeScore: z.number().int().nonnegative().nullable(),
    period: z.number().int().nullable(),
    stats: z.array(scoreStatSchema).max(1_000),
    statusId: z.number().int().nullable(),
  })
  .strict();

const envelopeFields = {
  eventId: identifierSchema,
  fixtureId: identifierSchema,
  idempotencyKey: z.string().min(1).max(2_048),
  receivedAtMs: epochMillisecondsSchema,
  sequence: z.number().int().nonnegative().safe(),
  source: domainEventSourceSchema,
  sourceId: identifierSchema,
  sourcePriority: z.number().int().nonnegative(),
  sourceTimestampMs: epochMillisecondsSchema,
} as const;

const eventUnionSchema = z.union([
  z
    .object({
      ...envelopeFields,
      kind: z.literal('fixture.observed'),
      payload: fixtureObservedPayloadSchema,
      payloadVersion: z.literal(1),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      kind: z.literal('odds.observed'),
      payload: oddsObservedPayloadSchema,
      payloadVersion: z.literal(1),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      kind: z.literal('odds.observed'),
      payload: oddsObservedPayloadV2Schema,
      payloadVersion: z.literal(2),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      kind: z.literal('score.observed'),
      payload: scoreObservedPayloadSchema,
      payloadVersion: z.literal(1),
    })
    .strict(),
]);

export type NormalizedDomainEvent = z.infer<typeof eventUnionSchema>;

export function encodeKeyParts(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

export function buildEventIdempotencyKey(input: {
  readonly kind: NormalizedDomainEvent['kind'];
  readonly payloadVersion: number;
  readonly source: DomainEventSource;
  readonly sourceId: string;
}): string {
  return `event|${encodeKeyParts([
    input.source,
    input.kind,
    input.sourceId,
    String(input.payloadVersion),
  ])}`;
}

export function buildRawIngestId(idempotencyKey: string): string {
  return `raw_${stableHash(idempotencyKey).slice(0, 40)}`;
}

export function buildEventId(idempotencyKey: string): string {
  return `evt_${stableHash(idempotencyKey).slice(0, 40)}`;
}

type DerivedEnvelopeKeys = 'eventId' | 'idempotencyKey' | 'sourcePriority';
export type NormalizedEventInput = NormalizedDomainEvent extends infer Event
  ? Event extends NormalizedDomainEvent
    ? Omit<Event, DerivedEnvelopeKeys>
    : never
  : never;

export const normalizedDomainEventSchema = eventUnionSchema.superRefine(
  (event, context) => {
    if (event.fixtureId !== event.payload.fixtureId) {
      context.addIssue({
        code: 'custom',
        message: 'Envelope fixtureId must match payload fixtureId.',
        path: ['fixtureId'],
      });
    }
    if (event.sourcePriority !== sourcePriorities[event.source]) {
      context.addIssue({
        code: 'custom',
        message: 'sourcePriority does not match the canonical source priority.',
        path: ['sourcePriority'],
      });
    }
    const expectedKey = buildEventIdempotencyKey(event);
    if (
      event.idempotencyKey !== expectedKey ||
      event.eventId !== buildEventId(expectedKey)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Event identity is not canonical.',
        path: ['idempotencyKey'],
      });
    }
  },
);

export function createNormalizedEvent(
  input: NormalizedEventInput,
): NormalizedDomainEvent {
  const idempotencyKey = buildEventIdempotencyKey(input);
  return normalizedDomainEventSchema.parse({
    ...input,
    eventId: buildEventId(idempotencyKey),
    idempotencyKey,
    sourcePriority: sourcePriorities[input.source],
  });
}

export type EventOrder = Pick<
  NormalizedDomainEvent,
  | 'eventId'
  | 'idempotencyKey'
  | 'sequence'
  | 'sourceId'
  | 'sourcePriority'
  | 'sourceTimestampMs'
>;

export function compareEventOrder(left: EventOrder, right: EventOrder): number {
  const numbers: Array<readonly [number, number]> = [
    [left.sourceTimestampMs, right.sourceTimestampMs],
    [left.sequence, right.sequence],
    [left.sourcePriority, right.sourcePriority],
  ];
  for (const [leftValue, rightValue] of numbers) {
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
  }
  const strings: Array<readonly [string, string]> = [
    [left.sourceId, right.sourceId],
    [left.idempotencyKey, right.idempotencyKey],
    [left.eventId, right.eventId],
  ];
  for (const [leftValue, rightValue] of strings) {
    const comparison = leftValue.localeCompare(rightValue);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

export function eventPayloadAsJson(event: NormalizedDomainEvent): JsonValue {
  return event.payload as JsonValue;
}
