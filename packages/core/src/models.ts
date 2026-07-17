import { createHash } from 'node:crypto';

import { z } from 'zod';

const identifierSchema = z.string().min(1).max(512);
const epochMillisecondsSchema = z.number().int().nonnegative().safe();

export const marketControlStates = ['OPEN', 'WIDENED', 'PAUSED', 'RECOVERY'] as const;
export const marketControlStateSchema = z.enum(marketControlStates);
export type MarketControlState = z.infer<typeof marketControlStateSchema>;

const strategyDecisionFields = {
  action: z.enum(['none', 'widen', 'pause', 'begin_recovery', 'reopen']),
  decisionId: identifierSchema,
  expectedStateVersion: z.number().int().nonnegative(),
  fixtureId: identifierSchema,
  idempotencyKey: z.string().min(1).max(2_048),
  logicalTimestampMs: epochMillisecondsSchema,
  marketId: identifierSchema,
  metrics: z.record(z.string(), z.number().finite()),
  nextState: marketControlStateSchema,
  policyVersion: z.string().min(1).max(100),
  previousState: marketControlStateSchema,
  reasonCodes: z.array(z.string().min(1).max(100)).max(100),
  triggerEventId: identifierSchema,
} as const;

const strategyDecisionV1Schema = z
  .object({
    ...strategyDecisionFields,
    payloadVersion: z.literal(1),
  })
  .strict();

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const strategyDecisionV2Schema = z
  .object({
    ...strategyDecisionFields,
    evidenceEventIds: z.array(identifierSchema).max(100),
    inputFeatureHash: hashSchema,
    payloadVersion: z.literal(2),
    policyConfigurationHash: hashSchema,
    thresholds: z.record(
      z.string().min(1).max(100),
      z.number().int().nonnegative().safe(),
    ),
  })
  .strict();

export const strategyDecisionSchema = z
  .union([strategyDecisionV1Schema, strategyDecisionV2Schema])
  .superRefine((decision, context) => {
    const expectedKey = buildDecisionIdempotencyKey(decision);
    if (
      decision.idempotencyKey !== expectedKey ||
      decision.decisionId !== buildDecisionId(expectedKey)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Decision identity is not canonical.',
      });
    }

    const transition = `${decision.previousState}->${decision.nextState}`;
    const allowedTransitions: Record<typeof decision.action, readonly string[]> = {
      begin_recovery: ['PAUSED->RECOVERY', 'WIDENED->RECOVERY'],
      none: marketControlStates.map((state) => `${state}->${state}`),
      pause: ['OPEN->PAUSED', 'WIDENED->PAUSED', 'RECOVERY->PAUSED'],
      reopen: ['RECOVERY->OPEN'],
      widen: ['OPEN->WIDENED'],
    };
    if (!allowedTransitions[decision.action].includes(transition)) {
      context.addIssue({
        code: 'custom',
        message: `Action ${decision.action} cannot perform transition ${transition}.`,
      });
    }
  });
export type StrategyDecision = z.infer<typeof strategyDecisionSchema>;

export function buildDecisionIdempotencyKey(input: {
  readonly marketId: string;
  readonly policyConfigurationHash?: string;
  readonly policyVersion: string;
  readonly triggerEventId: string;
}): string {
  const parts = [input.triggerEventId, input.marketId, input.policyVersion];
  if (input.policyConfigurationHash) parts.push(input.policyConfigurationHash);
  return `decision|${parts.map((part) => `${part.length}:${part}`).join('|')}`;
}

export function buildDecisionId(idempotencyKey: string): string {
  return `dec_${stableDecisionHash(idempotencyKey).slice(0, 40)}`;
}

function stableDecisionHash(value: string): string {
  // Kept local to make decision identifiers independent of event payload serialization.
  return createHash('sha256').update(value).digest('hex');
}

type DerivedDecisionKeys = 'decisionId' | 'idempotencyKey';
export type StrategyDecisionInput = StrategyDecision extends infer Decision
  ? Decision extends StrategyDecision
    ? Omit<Decision, DerivedDecisionKeys>
    : never
  : never;

export function createStrategyDecision(input: StrategyDecisionInput): StrategyDecision {
  const idempotencyKey = buildDecisionIdempotencyKey(input);
  return strategyDecisionSchema.parse({
    ...input,
    decisionId: buildDecisionId(idempotencyKey),
    idempotencyKey,
  });
}

export const decisionReceiptSchema = z
  .object({
    anchoredAtMs: epochMillisecondsSchema.nullable(),
    decisionId: identifierSchema,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    proofReference: z.string().max(1_000).nullable(),
    receiptId: identifierSchema,
    status: z.enum(['pending', 'verified', 'failed']),
  })
  .strict();
export type DecisionReceipt = z.infer<typeof decisionReceiptSchema>;

export const replayRunSchema = z
  .object({
    completedAtMs: epochMillisecondsSchema.nullable(),
    configHash: z.string().regex(/^[a-f0-9]{64}$/),
    eventCount: z.number().int().nonnegative(),
    inputFixtureId: identifierSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    lastEventId: identifierSchema.nullable(),
    manifestId: identifierSchema,
    namespace: z.string().min(1).max(1_024),
    runId: identifierSchema,
    speed: z.union([z.number().positive().finite(), z.literal('maximum')]),
    startedAtMs: epochMillisecondsSchema,
    status: z.enum(['pending', 'running', 'completed', 'failed']),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.namespace !== `replay:${run.runId}`) {
      context.addIssue({
        code: 'custom',
        message: 'Replay namespace must be derived from its run ID.',
        path: ['namespace'],
      });
    }
    if (run.status === 'completed' && run.completedAtMs === null) {
      context.addIssue({
        code: 'custom',
        message: 'Completed replay runs require completedAtMs.',
        path: ['completedAtMs'],
      });
    }
  });
export type ReplayRun = z.infer<typeof replayRunSchema>;

export const simulatedOrderSchema = z
  .object({
    createdAtMs: epochMillisecondsSchema,
    decisionId: identifierSchema,
    fixtureId: identifierSchema,
    idempotencyKey: z.string().min(1).max(2_048),
    marketId: identifierSchema,
    orderId: identifierSchema,
    outcomeId: identifierSchema,
    price: z.number().int().safe(),
    settledAtMs: epochMillisecondsSchema.nullable(),
    settlement: z.enum(['won', 'lost', 'void']).nullable(),
    side: z.enum(['back', 'lay']),
    stakeMicros: z.number().int().positive().safe(),
    status: z.enum(['accepted', 'rejected', 'settled', 'cancelled']),
  })
  .strict();
export type SimulatedOrder = z.infer<typeof simulatedOrderSchema>;

export type MarketControlSnapshot = Readonly<{
  fixtureId: string;
  lastDecisionId: string;
  logicalTimestampMs: number;
  marketId: string;
  state: MarketControlState;
  stateVersion: number;
}>;
