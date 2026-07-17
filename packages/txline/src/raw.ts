import {
  buildRawIngestId,
  createNormalizedEvent,
  encodeKeyParts,
  stableHash,
  toJsonValue,
  type Clock,
  type DomainEventSource,
  type NormalizedDomainEvent,
  type QuarantineInput,
  type RawIngestInput,
} from '@lagshield/core';
import { z } from 'zod';

import { fixtureSchema } from './schemas.js';

const txLineSourceSchema = z.enum([
  'txline-historical',
  'txline-snapshot',
  'txline-live',
]);

export const rawTxLineOddsSchema = z
  .object({
    Bookmaker: z.string().min(1),
    BookmakerId: z.number().int(),
    FixtureId: z.number().int(),
    GameState: z.string().nullable().optional(),
    InRunning: z.boolean(),
    MarketParameters: z.string().nullable().optional(),
    MarketPeriod: z.string().nullable().optional(),
    MessageId: z.string().min(1),
    PriceNames: z.array(z.string().min(1)),
    Prices: z.array(z.number().int()),
    SuperOddsType: z.string().min(1),
    Ts: z.number().int().nonnegative(),
  })
  .loose()
  .superRefine((value, context) => {
    if (value.PriceNames.length !== value.Prices.length) {
      context.addIssue({
        code: 'custom',
        message: 'PriceNames and Prices must have the same length.',
        path: ['Prices'],
      });
    }
  });

const upperScoreStatSchema = z
  .object({ Key: z.number().int(), Period: z.number().int(), Value: z.number().int() })
  .loose()
  .transform(({ Key: key, Period: period, Value: value }) => ({ key, period, value }));
const lowerScoreStatSchema = z
  .object({ key: z.number().int(), period: z.number().int(), value: z.number().int() })
  .loose();

export const rawTxLineScoreSchema = z
  .object({
    Action: z.string().min(1),
    FixtureId: z.number().int(),
    Period: z.number().int().nullable().optional(),
    Seq: z.number().int().nonnegative(),
    Stats: z.array(z.union([upperScoreStatSchema, lowerScoreStatSchema])).default([]),
    StatusId: z.number().int().nullable().optional(),
    Ts: z.number().int().nonnegative(),
  })
  .loose();

export type TxLinePayloadKind = 'fixture' | 'odds' | 'score';
type TxLineSource = Exclude<DomainEventSource, 'simulation'>;

export type NormalizeTxLineInput = Readonly<{
  payloadKind: string;
  payloadVersion?: number;
  rawPayload: unknown;
  receivedAtMs?: number;
  sequence?: number;
  source: TxLineSource;
}>;

export type NormalizeTxLineResult =
  | Readonly<{ event: NormalizedDomainEvent; ok: true; raw: RawIngestInput }>
  | Readonly<{ ok: false; quarantine: QuarantineInput }>;

function rawIdempotencyKey(input: {
  readonly payloadKind: string;
  readonly payloadVersion: number;
  readonly source: TxLineSource;
  readonly sourceId: string;
}): string {
  return `raw|${encodeKeyParts([
    input.source,
    input.payloadKind,
    input.sourceId,
    String(input.payloadVersion),
  ])}`;
}

function validationIssues(error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`,
  );
}

function extractCandidateNumber(raw: unknown, key: string): number | null {
  if (!raw || typeof raw !== 'object' || !(key in raw)) return null;
  const candidate = (raw as Record<string, unknown>)[key];
  return typeof candidate === 'number' && Number.isSafeInteger(candidate)
    ? candidate
    : null;
}

function extractCandidateString(raw: unknown, key: string): string | null {
  if (!raw || typeof raw !== 'object' || !(key in raw)) return null;
  const candidate = (raw as Record<string, unknown>)[key];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function safeRawPayload(raw: unknown) {
  try {
    return toJsonValue(raw);
  } catch {
    return { unserializablePayloadType: typeof raw };
  }
}

function createRawInput(input: {
  readonly fixtureId: string | null;
  readonly payloadKind: string;
  readonly payloadVersion: number;
  readonly rawPayload: ReturnType<typeof safeRawPayload>;
  readonly receivedAtMs: number;
  readonly source: TxLineSource;
  readonly sourceId: string;
  readonly sourceTimestampMs: number | null;
}): RawIngestInput {
  const idempotencyKey = rawIdempotencyKey(input);
  return {
    ...input,
    idempotencyKey,
    ingestId: buildRawIngestId(idempotencyKey),
  };
}

function quarantine(input: {
  readonly code: QuarantineInput['code'];
  readonly issues: readonly string[];
  readonly normalizeInput: NormalizeTxLineInput;
  readonly payloadVersion: number;
  readonly receivedAtMs: number;
  readonly rawPayload: ReturnType<typeof safeRawPayload>;
}): NormalizeTxLineResult {
  const candidateFixture = extractCandidateNumber(
    input.normalizeInput.rawPayload,
    'FixtureId',
  );
  const candidateSourceId =
    extractCandidateString(input.normalizeInput.rawPayload, 'MessageId') ??
    (candidateFixture === null
      ? null
      : `${candidateFixture}:${extractCandidateNumber(input.normalizeInput.rawPayload, 'Seq') ?? 0}`) ??
    `sha256:${stableHash(input.rawPayload)}`;
  const raw = createRawInput({
    fixtureId: candidateFixture === null ? null : String(candidateFixture),
    payloadKind: input.normalizeInput.payloadKind,
    payloadVersion: input.payloadVersion,
    rawPayload: input.rawPayload,
    receivedAtMs: input.receivedAtMs,
    source: input.normalizeInput.source,
    sourceId: candidateSourceId,
    sourceTimestampMs: extractCandidateNumber(input.normalizeInput.rawPayload, 'Ts'),
  });
  return {
    ok: false,
    quarantine: { ...raw, code: input.code, issues: input.issues },
  };
}

function marketId(raw: z.infer<typeof rawTxLineOddsSchema>): string {
  const identity = {
    fixtureId: raw.FixtureId,
    parameters: raw.MarketParameters ?? null,
    period: raw.MarketPeriod ?? null,
    type: raw.SuperOddsType,
  };
  return `mkt_${stableHash(identity).slice(0, 40)}`;
}

function outcomeId(market: string, name: string): string {
  return `out_${stableHash({ market, name }).slice(0, 40)}`;
}

export function normalizeTxLinePayload(
  input: NormalizeTxLineInput,
  clock: Clock,
): NormalizeTxLineResult {
  txLineSourceSchema.parse(input.source);
  const payloadVersion = input.payloadVersion ?? 1;
  const receivedAtMs = input.receivedAtMs ?? clock.nowMs();
  const rawPayload = safeRawPayload(input.rawPayload);

  if (payloadVersion !== 1) {
    return quarantine({
      code: 'unsupported_payload_version',
      issues: [`Unsupported payload version: ${payloadVersion}`],
      normalizeInput: input,
      payloadVersion,
      rawPayload,
      receivedAtMs,
    });
  }

  if (!['fixture', 'odds', 'score'].includes(input.payloadKind)) {
    return quarantine({
      code: 'unknown_payload_kind',
      issues: [`Unknown TxLINE payload kind: ${input.payloadKind}`],
      normalizeInput: input,
      payloadVersion,
      rawPayload,
      receivedAtMs,
    });
  }

  if (input.payloadKind === 'fixture') {
    const parsed = fixtureSchema.safeParse(input.rawPayload);
    if (!parsed.success) {
      return quarantine({
        code: 'malformed_payload',
        issues: validationIssues(parsed.error),
        normalizeInput: input,
        payloadVersion,
        rawPayload,
        receivedAtMs,
      });
    }
    const fixture = parsed.data;
    const gameState = fixture.GameState ?? fixture.gameState;
    const sourceId = `fixture:${fixture.FixtureId}:${fixture.Ts}`;
    const raw = createRawInput({
      fixtureId: String(fixture.FixtureId),
      payloadKind: input.payloadKind,
      payloadVersion,
      rawPayload,
      receivedAtMs,
      source: input.source,
      sourceId,
      sourceTimestampMs: fixture.Ts,
    });
    const participants: [
      { id: string; name: string; role: 'home' },
      { id: string; name: string; role: 'away' },
    ] = fixture.Participant1IsHome
      ? [
          {
            id: String(fixture.Participant1Id),
            name: fixture.Participant1,
            role: 'home',
          },
          {
            id: String(fixture.Participant2Id),
            name: fixture.Participant2,
            role: 'away',
          },
        ]
      : [
          {
            id: String(fixture.Participant2Id),
            name: fixture.Participant2,
            role: 'home',
          },
          {
            id: String(fixture.Participant1Id),
            name: fixture.Participant1,
            role: 'away',
          },
        ];
    const event = createNormalizedEvent({
      fixtureId: String(fixture.FixtureId),
      kind: 'fixture.observed',
      payload: {
        competition: fixture.Competition,
        competitionId: String(fixture.CompetitionId),
        fixtureId: String(fixture.FixtureId),
        participants,
        scheduledAtMs: fixture.StartTime,
        status: gameState === 6 ? 'cancelled' : 'scheduled',
      },
      payloadVersion,
      receivedAtMs,
      sequence: input.sequence ?? 0,
      source: input.source,
      sourceId,
      sourceTimestampMs: fixture.Ts,
    });
    return { event, ok: true, raw };
  }

  if (input.payloadKind === 'odds') {
    const parsed = rawTxLineOddsSchema.safeParse(input.rawPayload);
    if (!parsed.success) {
      return quarantine({
        code: 'malformed_payload',
        issues: validationIssues(parsed.error),
        normalizeInput: input,
        payloadVersion,
        rawPayload,
        receivedAtMs,
      });
    }
    const odds = parsed.data;
    const normalizedMarketId = marketId(odds);
    const raw = createRawInput({
      fixtureId: String(odds.FixtureId),
      payloadKind: input.payloadKind,
      payloadVersion,
      rawPayload,
      receivedAtMs,
      source: input.source,
      sourceId: odds.MessageId,
      sourceTimestampMs: odds.Ts,
    });
    const event = createNormalizedEvent({
      fixtureId: String(odds.FixtureId),
      kind: 'odds.observed',
      payload: {
        bookmaker: { id: String(odds.BookmakerId), name: odds.Bookmaker },
        fixtureId: String(odds.FixtureId),
        market: {
          gameState: odds.GameState ?? null,
          inRunning: odds.InRunning,
          marketId: normalizedMarketId,
          parameters: odds.MarketParameters ?? null,
          period: odds.MarketPeriod ?? null,
          status: odds.Prices.length === 0 ? 'suspended' : 'open',
          type: odds.SuperOddsType,
        },
        outcomes: odds.PriceNames.map((name, index) => ({
          name,
          outcomeId: outcomeId(normalizedMarketId, name),
          price: odds.Prices[index]!,
        })),
        priceEncoding: 'txline-native-i32-v1',
      },
      payloadVersion,
      receivedAtMs,
      sequence: input.sequence ?? 0,
      source: input.source,
      sourceId: odds.MessageId,
      sourceTimestampMs: odds.Ts,
    });
    return { event, ok: true, raw };
  }

  const parsed = rawTxLineScoreSchema.safeParse(input.rawPayload);
  if (!parsed.success) {
    return quarantine({
      code: 'malformed_payload',
      issues: validationIssues(parsed.error),
      normalizeInput: input,
      payloadVersion,
      rawPayload,
      receivedAtMs,
    });
  }
  const score = parsed.data;
  const sourceId = `${score.FixtureId}:${score.Seq}`;
  const raw = createRawInput({
    fixtureId: String(score.FixtureId),
    payloadKind: input.payloadKind,
    payloadVersion,
    rawPayload,
    receivedAtMs,
    source: input.source,
    sourceId,
    sourceTimestampMs: score.Ts,
  });
  const totalHome = score.Stats.find((stat) => stat.key === 1 && stat.period === 0);
  const totalAway = score.Stats.find((stat) => stat.key === 2 && stat.period === 0);
  const event = createNormalizedEvent({
    fixtureId: String(score.FixtureId),
    kind: 'score.observed',
    payload: {
      action: score.Action,
      awayScore: totalAway?.value ?? null,
      fixtureId: String(score.FixtureId),
      homeScore: totalHome?.value ?? null,
      period: score.Period ?? null,
      stats: score.Stats,
      statusId: score.StatusId ?? null,
    },
    payloadVersion,
    receivedAtMs,
    sequence: score.Seq,
    source: input.source,
    sourceId,
    sourceTimestampMs: score.Ts,
  });
  return { event, ok: true, raw };
}
