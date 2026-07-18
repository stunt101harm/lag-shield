import { z } from 'zod';

import { domainEventSourceSchema } from './events.js';
import { stableHash, toJsonValue, type JsonValue } from './json.js';
import {
  decisionReceiptV1Schema,
  strategyDecisionSchema,
  type StrategyDecision,
} from './models.js';

const identifierSchema = z.string().min(1).max(512);
const epochMillisecondsSchema = z.number().int().nonnegative().safe();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const receiptEvidenceSchema = z
  .object({
    eventId: identifierSchema,
    kind: z.enum(['fixture.observed', 'odds.observed', 'score.observed']),
    scoreStatKey: z.number().int().min(0).max(4_294_967_295).nullable(),
    source: domainEventSourceSchema,
    sourceMessageId: identifierSchema,
    sourceTimestampMs: epochMillisecondsSchema.nullable(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.kind !== 'score.observed' && evidence.scoreStatKey !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Only score evidence may carry a score stat key.',
        path: ['scoreStatKey'],
      });
    }
  });
export type ReceiptEvidence = z.infer<typeof receiptEvidenceSchema>;

export const decisionReceiptPayloadSchema = z
  .object({
    decision: strategyDecisionSchema,
    evidence: z.array(receiptEvidenceSchema).max(100),
  })
  .strict()
  .superRefine((payload, context) => {
    const ids = payload.evidence.map(({ eventId }) => eventId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'Receipt evidence must be unique.' });
    }
    if (ids.some((eventId, index) => index > 0 && eventId < ids[index - 1]!)) {
      context.addIssue({
        code: 'custom',
        message: 'Receipt evidence must be sorted by event ID.',
      });
    }
    const allowedIds = new Set(
      payload.decision.payloadVersion === 2
        ? payload.decision.evidenceEventIds
        : [payload.decision.triggerEventId],
    );
    for (const [index, evidence] of payload.evidence.entries()) {
      if (!allowedIds.has(evidence.eventId)) {
        context.addIssue({
          code: 'custom',
          message: 'Receipt evidence is not referenced by its strategy decision.',
          path: ['evidence', index, 'eventId'],
        });
      }
    }
  });
export type DecisionReceiptPayload = z.infer<typeof decisionReceiptPayloadSchema>;

export const proofVerificationStatuses = [
  'pending',
  'verified',
  'rejected',
  'unavailable',
  'error',
] as const;
export const proofVerificationStatusSchema = z.enum(proofVerificationStatuses);
export type ProofVerificationStatus = z.infer<typeof proofVerificationStatusSchema>;

export const proofVerificationSchema = z
  .object({
    attemptCount: z.number().int().nonnegative(),
    attemptedAtMs: epochMillisecondsSchema.nullable(),
    completedAtMs: epochMillisecondsSchema.nullable(),
    errorCode: z.string().min(1).max(100).nullable(),
    errorMessage: z.string().min(1).max(1_000).nullable(),
    explorerAccountUrl: z.string().url().max(1_000).nullable(),
    explorerProgramUrl: z.string().url().max(1_000).nullable(),
    kind: z.enum(['odds', 'score']).nullable(),
    network: z.enum(['devnet', 'mainnet']).nullable(),
    programId: identifierSchema.nullable(),
    proofMaterialHash: hashSchema.nullable(),
    proofReference: z.string().min(1).max(1_000).nullable(),
    rootAccount: identifierSchema.nullable(),
    simulationSlot: z.number().int().nonnegative().safe().nullable(),
    sourceEventId: identifierSchema.nullable(),
    sourceMessageId: identifierSchema.nullable(),
    sourceTimestampMs: epochMillisecondsSchema.nullable(),
    status: proofVerificationStatusSchema,
    summary: z.string().min(1).max(500),
    updatedAtMs: epochMillisecondsSchema,
  })
  .strict()
  .superRefine((verification, context) => {
    if (verification.status === 'pending') {
      if (verification.completedAtMs !== null) {
        context.addIssue({
          code: 'custom',
          message: 'Pending verification cannot be completed.',
          path: ['completedAtMs'],
        });
      }
      return;
    }
    if (verification.completedAtMs === null) {
      context.addIssue({
        code: 'custom',
        message: 'Terminal verification requires completedAtMs.',
        path: ['completedAtMs'],
      });
    }
    if (verification.status === 'verified' || verification.status === 'rejected') {
      for (const field of [
        'attemptedAtMs',
        'explorerAccountUrl',
        'explorerProgramUrl',
        'kind',
        'network',
        'programId',
        'proofMaterialHash',
        'proofReference',
        'rootAccount',
        'simulationSlot',
        'sourceEventId',
        'sourceMessageId',
        'sourceTimestampMs',
      ] as const) {
        if (verification[field] === null) {
          context.addIssue({
            code: 'custom',
            message: `${field} is required for an on-chain verification result.`,
            path: [field],
          });
        }
      }
    }
    if (verification.status === 'error' && verification.errorCode === null) {
      context.addIssue({
        code: 'custom',
        message: 'Errored verification requires an error code.',
        path: ['errorCode'],
      });
    }
  });
export type ProofVerification = z.infer<typeof proofVerificationSchema>;

export const decisionReceiptV2Schema = z
  .object({
    canonicalPayload: decisionReceiptPayloadSchema,
    createdAtMs: epochMillisecondsSchema,
    decisionId: identifierSchema,
    payloadHash: hashSchema,
    payloadVersion: z.literal(2),
    receiptId: identifierSchema,
    verification: proofVerificationSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    const payloadHash = stableHash(toJsonValue(receipt.canonicalPayload));
    if (
      receipt.decisionId !== receipt.canonicalPayload.decision.decisionId ||
      receipt.payloadHash !== payloadHash ||
      receipt.receiptId !== `rcpt_${payloadHash.slice(0, 40)}`
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Decision receipt identity is not canonical.',
      });
    }
  });
export type DecisionReceiptV2 = z.infer<typeof decisionReceiptV2Schema>;

export const decisionReceiptSchema = z.union([
  decisionReceiptV1Schema,
  decisionReceiptV2Schema,
]);
export type DecisionReceipt = z.infer<typeof decisionReceiptSchema>;

function canonicalEvidence(evidence: readonly ReceiptEvidence[]): ReceiptEvidence[] {
  return [...evidence]
    .map((item) => receiptEvidenceSchema.parse(item))
    .sort((left, right) => left.eventId.localeCompare(right.eventId));
}

export function createPendingDecisionReceipt(
  decisionInput: StrategyDecision,
  evidence: readonly ReceiptEvidence[] = [],
): DecisionReceiptV2 {
  const decision = strategyDecisionSchema.parse(decisionInput);
  const canonicalPayload = decisionReceiptPayloadSchema.parse({
    decision,
    evidence: canonicalEvidence(evidence),
  });
  const payloadHash = stableHash(toJsonValue(canonicalPayload));
  return decisionReceiptV2Schema.parse({
    canonicalPayload,
    createdAtMs: decision.logicalTimestampMs,
    decisionId: decision.decisionId,
    payloadHash,
    payloadVersion: 2,
    receiptId: `rcpt_${payloadHash.slice(0, 40)}`,
    verification: {
      attemptCount: 0,
      attemptedAtMs: null,
      completedAtMs: null,
      errorCode: null,
      errorMessage: null,
      explorerAccountUrl: null,
      explorerProgramUrl: null,
      kind: null,
      network: null,
      programId: null,
      proofMaterialHash: null,
      proofReference: null,
      rootAccount: null,
      simulationSlot: null,
      sourceEventId: null,
      sourceMessageId: null,
      sourceTimestampMs: null,
      status: 'pending',
      summary: 'Awaiting asynchronous TxLINE proof verification.',
      updatedAtMs: decision.logicalTimestampMs,
    },
  });
}

export function updateDecisionReceiptVerification(
  receiptInput: DecisionReceiptV2,
  verificationInput: ProofVerification,
): DecisionReceiptV2 {
  const receipt = decisionReceiptV2Schema.parse(receiptInput);
  const verification = proofVerificationSchema.parse(verificationInput);
  if (verification.attemptCount < receipt.verification.attemptCount) {
    throw new Error('Receipt verification attempt count cannot move backwards.');
  }
  if (verification.updatedAtMs < receipt.verification.updatedAtMs) {
    throw new Error('Receipt verification timestamp cannot move backwards.');
  }
  return decisionReceiptV2Schema.parse({ ...receipt, verification });
}

export function decisionReceiptMaterialHash(material: JsonValue): string {
  return stableHash(material);
}
