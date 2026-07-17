import { describe, expect, it } from 'vitest';

import {
  createPendingDecisionReceipt,
  decisionReceiptSchema,
  updateDecisionReceiptVerification,
  type ProofVerification,
  type ReceiptEvidence,
} from './decision-receipt.js';
import { createStrategyDecision } from './models.js';

const decision = createStrategyDecision({
  action: 'pause',
  evidenceEventIds: ['event-odds', 'event-score'],
  expectedStateVersion: 4,
  fixtureId: 'fixture-1',
  inputFeatureHash: '1'.repeat(64),
  logicalTimestampMs: 1_800_000_000_000,
  marketId: 'market-1',
  metrics: { quoteAgeMs: 4_500 },
  nextState: 'PAUSED',
  payloadVersion: 2,
  policyConfigurationHash: '2'.repeat(64),
  policyVersion: 'policy-v1',
  previousState: 'OPEN',
  reasonCodes: ['EVENT_GOAL_UNCONFIRMED', 'BOOKMAKER_REACTION_SLOW'],
  thresholds: { pauseQuoteAgeMs: 5_000 },
  triggerEventId: 'event-score',
});

const evidence: readonly ReceiptEvidence[] = [
  {
    eventId: 'event-score',
    kind: 'score.observed',
    scoreStatKey: 1,
    source: 'txline-live',
    sourceMessageId: 'score-message-7',
    sourceTimestampMs: 1_800_000_000_000,
  },
  {
    eventId: 'event-odds',
    kind: 'odds.observed',
    scoreStatKey: null,
    source: 'txline-live',
    sourceMessageId: 'odds-message-9',
    sourceTimestampMs: 1_799_999_999_500,
  },
];

function verified(attemptCount = 1): ProofVerification {
  return {
    attemptCount,
    attemptedAtMs: 1_800_000_001_000,
    completedAtMs: 1_800_000_001_200,
    errorCode: null,
    errorMessage: null,
    explorerAccountUrl: 'https://explorer.solana.com/address/root-account?cluster=devnet',
    explorerProgramUrl: 'https://explorer.solana.com/address/program?cluster=devnet',
    kind: 'odds',
    network: 'devnet',
    programId: 'program',
    proofMaterialHash: '3'.repeat(64),
    proofReference: '/api/odds/validation?messageId=odds-message-9&ts=1799999999500',
    rootAccount: 'root-account',
    simulationSlot: 123,
    sourceEventId: 'event-odds',
    sourceMessageId: 'odds-message-9',
    sourceTimestampMs: 1_799_999_999_500,
    status: 'verified',
    summary: 'TxLINE odds proof returned true from the matching devnet program.',
    updatedAtMs: 1_800_000_001_200,
  };
}

describe('canonical decision receipts', () => {
  it('is stable across evidence input ordering and captures all decision provenance', () => {
    const first = createPendingDecisionReceipt(decision, evidence);
    const second = createPendingDecisionReceipt(decision, [...evidence].reverse());

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      canonicalPayload: {
        decision: {
          action: 'pause',
          inputFeatureHash: '1'.repeat(64),
          nextState: 'PAUSED',
          policyVersion: 'policy-v1',
          previousState: 'OPEN',
        },
        evidence: [
          { eventId: 'event-odds', sourceMessageId: 'odds-message-9' },
          { eventId: 'event-score', sourceMessageId: 'score-message-7' },
        ],
      },
      createdAtMs: decision.logicalTimestampMs,
      decisionId: decision.decisionId,
      payloadVersion: 2,
      verification: { attemptCount: 0, status: 'pending' },
    });
    expect(first.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.receiptId).toBe(`rcpt_${first.payloadHash.slice(0, 40)}`);
  });

  it('rejects forged hashes, receipt IDs, and unrelated evidence', () => {
    const receipt = createPendingDecisionReceipt(decision, evidence);
    expect(() =>
      decisionReceiptSchema.parse({ ...receipt, payloadHash: '0'.repeat(64) }),
    ).toThrow(/identity is not canonical/);
    expect(() =>
      createPendingDecisionReceipt(decision, [
        { ...evidence[0]!, eventId: 'unrelated-event' },
      ]),
    ).toThrow(/not referenced/);
  });

  it('updates only the mutable proof lifecycle while preserving receipt identity', () => {
    const pending = createPendingDecisionReceipt(decision, evidence);
    const completed = updateDecisionReceiptVerification(pending, verified());

    expect(completed.canonicalPayload).toEqual(pending.canonicalPayload);
    expect(completed.payloadHash).toBe(pending.payloadHash);
    expect(completed.receiptId).toBe(pending.receiptId);
    expect(completed.verification.status).toBe('verified');
    expect(() =>
      updateDecisionReceiptVerification(completed, {
        ...verified(0),
        updatedAtMs: completed.verification.updatedAtMs,
      }),
    ).toThrow(/attempt count cannot move backwards/);
  });

  it('never permits a verified label without complete on-chain evidence', () => {
    const pending = createPendingDecisionReceipt(decision, evidence);
    expect(() =>
      updateDecisionReceiptVerification(pending, {
        ...verified(),
        rootAccount: null,
      }),
    ).toThrow(/rootAccount is required/);
  });
});
