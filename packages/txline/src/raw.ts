import {
  buildRawIngestId,
  buildMarketId,
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
    PriceNames: z.array(z.string().min(1)).default([]),
    Prices: z.array(z.number().int()).default([]),
    Pct: z.array(z.union([z.literal('NA'), z.string().regex(/^\d+\.\d{3}$/)])).optional(),
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
    if (value.Pct && value.Pct.length !== value.PriceNames.length) {
      context.addIssue({
        code: 'custom',
        message: 'Pct and PriceNames must have the same length.',
        path: ['Pct'],
      });
    }
    for (const [index, percentage] of value.Pct?.entries() ?? []) {
      if (percentage !== 'NA' && Number(percentage) > 100) {
        context.addIssue({
          code: 'custom',
          message: 'Pct values must not exceed 100.000.',
          path: ['Pct', index],
        });
      }
    }
  });

const upperScoreStatSchema = z
  .object({ Key: z.number().int(), Period: z.number().int(), Value: z.number().int() })
  .loose()
  .transform(({ Key: key, Period: period, Value: value }) => ({ key, period, value }));
const lowerScoreStatSchema = z
  .object({ key: z.number().int(), period: z.number().int(), value: z.number().int() })
  .loose();

const soccerActionDetailsSchema = z
  .object({
    Action: z.string().min(1).optional(),
    Goal: z.boolean().optional(),
    Id: z.number().int().optional(),
    Outcome: z.string().min(1).optional(),
    Penalty: z.boolean().optional(),
    RedCard: z.boolean().optional(),
    Reliable: z.boolean().optional(),
    Type: z.string().min(1).optional(),
    VAR: z.boolean().optional(),
  })
  .loose();

const soccerPossiblePartyEventSchema = z
  .object({
    Corner: z.boolean().optional(),
    Goal: z.boolean().optional(),
    Penalty: z.boolean().optional(),
  })
  .loose();
const soccerPartyStateSchema = z
  .object({ PossibleEvent: soccerPossiblePartyEventSchema.optional() })
  .loose();
const soccerPossibleNeutralEventSchema = z
  .object({
    RedCard: z.boolean().optional(),
    VAR: z.boolean().optional(),
    YellowCard: z.boolean().optional(),
  })
  .loose();

function mergeSoccerActionDetails(input: {
  readonly data: z.infer<typeof soccerActionDetailsSchema> | undefined;
  readonly neutral: z.infer<typeof soccerPossibleNeutralEventSchema> | undefined;
  readonly participant1: z.infer<typeof soccerPartyStateSchema> | undefined;
  readonly participant2: z.infer<typeof soccerPartyStateSchema> | undefined;
}): z.infer<typeof soccerActionDetailsSchema> | undefined {
  if (!input.data && !input.neutral && !input.participant1 && !input.participant2) {
    return undefined;
  }
  return {
    ...input.data,
    Goal:
      input.data?.Goal ??
      input.participant1?.PossibleEvent?.Goal ??
      input.participant2?.PossibleEvent?.Goal,
    Penalty:
      input.data?.Penalty ??
      input.participant1?.PossibleEvent?.Penalty ??
      input.participant2?.PossibleEvent?.Penalty,
    RedCard: input.data?.RedCard ?? input.neutral?.RedCard,
    VAR: input.data?.VAR ?? input.neutral?.VAR,
  };
}

const soccerPhaseIds = {
  A: 15,
  C: 16,
  ET1: 7,
  ET2: 9,
  F: 5,
  FET: 10,
  FPE: 13,
  H1: 2,
  H2: 4,
  HT: 3,
  HTET: 8,
  I: 14,
  NS: 1,
  P: 19,
  PE: 12,
  TXCC: 17,
  TXCS: 18,
  WET: 6,
  WPE: 11,
} as const;

function soccerPhaseId(value: number | string | undefined): number | undefined {
  if (typeof value === 'number') return value;
  if (value === undefined) return undefined;
  return soccerPhaseIds[value.trim().toUpperCase() as keyof typeof soccerPhaseIds];
}

const upperTxLineScoreSchema = z
  .object({
    Action: z.string().min(1),
    Confirmed: z.boolean().optional(),
    Data: soccerActionDetailsSchema.optional(),
    FixtureId: z.number().int(),
    FollowsAction: z.number().int().optional(),
    Id: z.number().int().optional(),
    Period: z.number().int().nullable().optional(),
    Seq: z.number().int().nonnegative(),
    Stats: z.array(z.union([upperScoreStatSchema, lowerScoreStatSchema])).default([]),
    StatusId: z.number().int().nullable().optional(),
    StatusSoccerId: z.union([z.number().int(), z.string().min(1)]).optional(),
    Ts: z.number().int().nonnegative(),
  })
  .loose();

const lowerTxLineScoreSchema = z
  .object({
    action: z.string().min(1),
    confirmed: z.boolean().optional(),
    dataSoccer: soccerActionDetailsSchema.optional(),
    fixtureId: z.number().int(),
    followsAction: z.number().int().optional(),
    id: z.number().int().optional(),
    parti1StateSoccer: soccerPartyStateSchema.optional(),
    parti2StateSoccer: soccerPartyStateSchema.optional(),
    period: z.number().int().nullable().optional(),
    possibleEventSoccer: soccerPossibleNeutralEventSchema.optional(),
    seq: z.number().int().nonnegative(),
    stats: z
      .record(z.string().regex(/^\d+$/), z.number().int())
      .default({})
      .transform((stats) =>
        Object.entries(stats).map(([encodedKey, value]) => {
          const key = Number(encodedKey);
          return {
            key,
            period: key < 1_000 ? 0 : Math.trunc(key / 1_000),
            value,
          };
        }),
      ),
    statusId: z.number().int().nullable().optional(),
    statusSoccerId: z.union([z.number().int(), z.string().min(1)]).optional(),
    ts: z.number().int().nonnegative(),
  })
  .loose()
  .transform(
    ({
      action,
      confirmed,
      dataSoccer,
      fixtureId,
      followsAction,
      id,
      parti1StateSoccer,
      parti2StateSoccer,
      period,
      possibleEventSoccer,
      seq,
      stats,
      statusId,
      statusSoccerId,
      ts,
    }) => ({
      Action: action,
      Confirmed: confirmed,
      Data: mergeSoccerActionDetails({
        data: dataSoccer,
        neutral: possibleEventSoccer,
        participant1: parti1StateSoccer,
        participant2: parti2StateSoccer,
      }),
      FixtureId: fixtureId,
      FollowsAction: followsAction,
      Id: id,
      Period: period,
      Seq: seq,
      Stats: stats,
      StatusId: statusId ?? soccerPhaseId(statusSoccerId),
      StatusSoccerId: statusSoccerId,
      Ts: ts,
    }),
  );

export const rawTxLineScoreSchema = z.union([
  upperTxLineScoreSchema,
  lowerTxLineScoreSchema,
]);

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
  return buildMarketId({
    fixtureId: String(raw.FixtureId),
    inRunning: raw.InRunning,
    outcomeNames: [...raw.PriceNames].sort(),
    parameters: raw.MarketParameters ?? null,
    period: raw.MarketPeriod ?? null,
    type: raw.SuperOddsType,
  });
}

export function txLinePctToProbabilityMicros(value: string): number | null {
  if (value === 'NA') return null;
  const match = /^(\d+)\.(\d{3})$/.exec(value);
  if (!match) throw new Error(`Invalid TxLINE Pct value: ${value}`);
  const micros = Number(match[1]) * 10_000 + Number(match[2]) * 10;
  if (!Number.isSafeInteger(micros) || micros < 0 || micros > 1_000_000) {
    throw new Error(`TxLINE Pct value is outside 0.000 to 100.000: ${value}`);
  }
  return micros;
}

function outcomeId(market: string, name: string): string {
  return `out_${stableHash({ market, name }).slice(0, 40)}`;
}

export function normalizeTxLinePayload(
  input: NormalizeTxLineInput,
  clock: Clock,
): NormalizeTxLineResult {
  txLineSourceSchema.parse(input.source);
  const payloadVersion =
    input.payloadVersion ??
    (input.payloadKind === 'odds' || input.payloadKind === 'score' ? 2 : 1);
  const receivedAtMs = input.receivedAtMs ?? clock.nowMs();
  const rawPayload = safeRawPayload(input.rawPayload);

  const supportedPayloadVersion =
    payloadVersion === 1 ||
    ((input.payloadKind === 'odds' || input.payloadKind === 'score') &&
      payloadVersion === 2);
  if (!supportedPayloadVersion) {
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
      payloadVersion: 1,
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
    const commonEvent = {
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
      receivedAtMs,
      sequence: input.sequence ?? 0,
      source: input.source,
      sourceId: odds.MessageId,
      sourceTimestampMs: odds.Ts,
    } as const;
    const event =
      payloadVersion === 1
        ? createNormalizedEvent({ ...commonEvent, payloadVersion: 1 })
        : createNormalizedEvent({
            ...commonEvent,
            payload: {
              ...commonEvent.payload,
              outcomes: commonEvent.payload.outcomes.map((outcome, index) => ({
                ...outcome,
                reportedProbabilityMicros: odds.Pct
                  ? txLinePctToProbabilityMicros(odds.Pct[index]!)
                  : null,
              })),
              probabilityEncoding: 'txline-pct-percent-3dp-v1',
            },
            payloadVersion: 2,
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
  const commonEvent = {
    fixtureId: String(score.FixtureId),
    kind: 'score.observed',
    payload: {
      action: score.Action,
      awayScore: totalAway?.value ?? null,
      fixtureId: String(score.FixtureId),
      homeScore: totalHome?.value ?? null,
      period: score.Period ?? null,
      stats: score.Stats,
      statusId: score.StatusId ?? soccerPhaseId(score.StatusSoccerId) ?? null,
    },
    receivedAtMs,
    sequence: score.Seq,
    source: input.source,
    sourceId,
    sourceTimestampMs: score.Ts,
  } as const;
  const event =
    payloadVersion === 1
      ? createNormalizedEvent({ ...commonEvent, payloadVersion: 1 })
      : createNormalizedEvent({
          ...commonEvent,
          payload: {
            ...commonEvent.payload,
            actionId: String(score.Id ?? sourceId),
            confirmed: score.Confirmed ?? null,
            details: {
              amendedAction: score.Data?.Action ?? null,
              outcome: score.Data?.Outcome ?? null,
              possible: {
                goal: score.Data?.Goal ?? null,
                penalty: score.Data?.Penalty ?? null,
                redCard: score.Data?.RedCard ?? null,
                review: score.Data?.VAR ?? null,
              },
              referencedActionId:
                score.Data?.Id === undefined && score.FollowsAction === undefined
                  ? null
                  : String(score.Data?.Id ?? score.FollowsAction),
              reliable: score.Data?.Reliable ?? null,
              reviewType: score.Data?.Type ?? null,
            },
          },
          payloadVersion: 2,
        });
  return { event, ok: true, raw };
}
