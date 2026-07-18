import { Keypair } from '@solana/web3.js';
import {
  createPendingDecisionReceipt,
  createStrategyDecision,
  decisionReceiptMaterialHash,
  FixedClock,
  toJsonValue,
  type DecisionReceiptV2,
  type JsonValue,
  type ProofVerification,
} from '@lagshield/core';
import {
  getTxLineConfig,
  TxLineProofVerificationError,
  type TxLineOddsProofVerificationResult,
  type TxLineOddsValidation,
  type TxLineScoreProofVerificationResult,
  type TxLineScoreStatValidation,
} from '@lagshield/txline';
import { describe, expect, it, vi } from 'vitest';

import { DecisionProofService, DecisionProofWorker } from './decision-proof-service.js';

const timestampMs = 1_700_000_000_000;
const hash = '11'.repeat(32);
const validation: TxLineOddsValidation = {
  mainTreeProof: [],
  odds: {
    Bookmaker: 'Proof Book',
    BookmakerId: 7,
    FixtureId: 42,
    GameState: null,
    InRunning: true,
    MarketParameters: null,
    MarketPeriod: null,
    MessageId: 'message-42',
    PriceNames: ['home'],
    Prices: [2100],
    SuperOddsType: 'match-winner',
    Ts: timestampMs,
  },
  subTreeProof: [],
  summary: {
    fixtureId: 42,
    oddsSubTreeRoot: hash,
    updateStats: {
      maxTimestamp: timestampMs,
      minTimestamp: timestampMs,
      updateCount: 1,
    },
  },
};
const scoreValidation: TxLineScoreStatValidation = {
  eventStatRoot: hash,
  mainTreeProof: [],
  statProof: [],
  statToProve: { key: 1, period: 0, value: 2 },
  subTreeProof: [],
  summary: {
    eventStatsSubTreeRoot: hash,
    fixtureId: 42,
    updateStats: {
      maxTimestamp: timestampMs,
      minTimestamp: timestampMs,
      updateCount: 1,
    },
  },
  ts: timestampMs,
};

function receipt(kind: 'odds.observed' | 'score.observed' = 'odds.observed') {
  const decision = createStrategyDecision({
    action: 'none',
    expectedStateVersion: 0,
    fixtureId: '42',
    logicalTimestampMs: timestampMs,
    marketId: 'market-42',
    metrics: {},
    nextState: 'OPEN',
    payloadVersion: 1,
    policyVersion: 'proof-test',
    previousState: 'OPEN',
    reasonCodes: ['HEALTHY'],
    triggerEventId: 'event-42',
  });
  return createPendingDecisionReceipt(decision, [
    {
      eventId: 'event-42',
      kind,
      scoreStatKey: null,
      source: 'txline-live',
      sourceMessageId: 'message-42',
      sourceTimestampMs: timestampMs,
    },
  ]);
}

function scoreReceipt() {
  const base = receipt('score.observed');
  return createPendingDecisionReceipt(base.canonicalPayload.decision, [
    {
      ...base.canonicalPayload.evidence[0]!,
      scoreStatKey: 1,
      sourceMessageId: '42:7',
    },
  ]);
}

function harness(options: {
  input?: DecisionReceiptV2;
  verify?: () => Promise<TxLineOddsProofVerificationResult>;
  verifyScore?: () => Promise<TxLineScoreProofVerificationResult>;
}) {
  const input = options.input ?? receipt();
  let stored = input;
  let proofMaterial: JsonValue | null = null;
  const updateVerification = vi.fn(
    async (update: {
      expectedAttemptCount: number;
      proofMaterial: JsonValue | null;
      receiptId: string;
      verification: ProofVerification;
    }) => {
      expect(update.expectedAttemptCount).toBe(stored.verification.attemptCount);
      stored = { ...stored, verification: update.verification };
      proofMaterial = update.proofMaterial;
      return stored;
    },
  );
  const fetchOddsValidation = vi.fn(async () => validation);
  const fetchScoreStatValidation = vi.fn(async () => scoreValidation);
  const verifyOddsProof = vi.fn(
    options.verify ??
      (async (): Promise<TxLineOddsProofVerificationResult> => ({
        explorerAccountUrl: 'https://explorer.solana.com/address/root?cluster=devnet',
        explorerProgramUrl: 'https://explorer.solana.com/address/program?cluster=devnet',
        network: 'devnet',
        programId: getTxLineConfig('devnet').programId,
        proofMaterialHash: decisionReceiptMaterialHash(toJsonValue(validation)),
        proofReference: '/api/odds/validation?messageId=message-42&ts=1700000000000',
        rootAccount: 'root',
        simulationSlot: 99,
        sourceMessageId: 'message-42',
        sourceTimestampMs: timestampMs,
        status: 'verified',
        summary: 'verified',
      })),
  );
  const verifyScoreProof = vi.fn(
    options.verifyScore ??
      (async (): Promise<TxLineScoreProofVerificationResult> => ({
        explorerAccountUrl:
          'https://explorer.solana.com/address/score-root?cluster=devnet',
        explorerProgramUrl: 'https://explorer.solana.com/address/program?cluster=devnet',
        network: 'devnet',
        programId: getTxLineConfig('devnet').programId,
        proofMaterialHash: decisionReceiptMaterialHash(toJsonValue(scoreValidation)),
        proofReference: '/api/scores/stat-validation?fixtureId=42&seq=7&statKey=1',
        rootAccount: 'score-root',
        simulationSlot: 100,
        sourceFixtureId: 42,
        sourceSequence: 7,
        sourceStatKey: 1,
        sourceTimestampMs: timestampMs,
        status: 'verified',
        summary: 'score verified',
      })),
  );
  const service = new DecisionProofService({
    client: { fetchOddsValidation, fetchScoreStatValidation },
    clock: new FixedClock(timestampMs + 1_000),
    config: getTxLineConfig('devnet'),
    connection: {} as never,
    receiptStore: {
      listPending: async () => [input],
      updateVerification,
    },
    simulationPayer: Keypair.generate().publicKey,
    verifyOddsProof,
    verifyScoreProof,
  });
  return {
    fetchOddsValidation,
    fetchScoreStatValidation,
    get proofMaterial() {
      return proofMaterial;
    },
    input,
    service,
    updateVerification,
    verifyOddsProof,
    verifyScoreProof,
  };
}

describe('DecisionProofService', () => {
  it('stores exact proof material and a verified on-chain result without changing receipt identity', async () => {
    const test = harness({});
    const result = await test.service.verify(test.input);

    expect(result.receiptId).toBe(test.input.receiptId);
    expect(result.payloadHash).toBe(test.input.payloadHash);
    expect(result.verification).toMatchObject({
      attemptCount: 1,
      simulationSlot: 99,
      sourceEventId: 'event-42',
      sourceMessageId: 'message-42',
      status: 'verified',
    });
    expect(test.fetchOddsValidation).toHaveBeenCalledWith({
      messageId: 'message-42',
      timestampMs,
    });
    expect(test.proofMaterial).toEqual(validation);
  });

  it('makes non-verifiable score-only provenance explicitly unavailable', async () => {
    const input = receipt('score.observed');
    const test = harness({ input });
    const result = await test.service.verify(input);

    expect(result.verification.status).toBe('unavailable');
    expect(result.verification.summary).toContain(
      'No exact TxLINE odds or score proof coordinates',
    );
    expect(test.fetchOddsValidation).not.toHaveBeenCalled();
    expect(test.verifyOddsProof).not.toHaveBeenCalled();
  });

  it('verifies a score-triggered decision through its exact fixture, sequence, stat, and timestamp', async () => {
    const input = scoreReceipt();
    const test = harness({ input });
    const result = await test.service.verify(input);

    expect(test.fetchScoreStatValidation).toHaveBeenCalledWith({
      fixtureId: 42,
      sequence: 7,
      statKey: 1,
    });
    expect(result.verification).toMatchObject({
      kind: 'score',
      simulationSlot: 100,
      sourceMessageId: '42:7',
      sourceTimestampMs: timestampMs,
      status: 'verified',
    });
    expect(test.proofMaterial).toEqual(scoreValidation);
  });

  it('records verification failures without presenting them as verified', async () => {
    const test = harness({
      verify: async () => {
        throw new TxLineProofVerificationError(
          'PROOF_ACCOUNT_MISSING',
          'daily root is not available',
        );
      },
    });
    const result = await test.service.verify(test.input);

    expect(result.verification).toMatchObject({
      errorCode: 'PROOF_ACCOUNT_MISSING',
      errorMessage: 'daily root is not available',
      proofMaterialHash: decisionReceiptMaterialHash(toJsonValue(validation)),
      status: 'error',
    });
    expect(test.proofMaterial).toEqual(validation);
  });

  it('runs bounded pending work and reports terminal outcomes', async () => {
    const test = harness({});
    await expect(test.service.runPending(7)).resolves.toEqual({
      error: 0,
      processed: 1,
      rejected: 0,
      unavailable: 0,
      verified: 1,
    });
  });
});

describe('DecisionProofWorker', () => {
  it('prevents overlapping runs and exposes secret-free diagnostics', async () => {
    let resolveRun: (() => void) | undefined;
    const runPending = vi.fn(
      () =>
        new Promise<{
          error: number;
          processed: number;
          rejected: number;
          unavailable: number;
          verified: number;
        }>((resolve) => {
          resolveRun = () =>
            resolve({
              error: 0,
              processed: 0,
              rejected: 0,
              unavailable: 0,
              verified: 0,
            });
        }),
    );
    const worker = new DecisionProofWorker({
      clock: new FixedClock(timestampMs),
      service: { runPending },
    });

    const first = worker.runNow();
    const second = worker.runNow();
    expect(runPending).toHaveBeenCalledTimes(1);
    resolveRun?.();
    await Promise.all([first, second]);
    expect(worker.snapshot()).toEqual({
      lastError: null,
      lastFinishedAtMs: timestampMs,
      lastResult: {
        error: 0,
        processed: 0,
        rejected: 0,
        unavailable: 0,
        verified: 0,
      },
      running: false,
    });
  });
});
