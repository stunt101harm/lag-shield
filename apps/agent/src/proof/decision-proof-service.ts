import type { Connection, PublicKey } from '@solana/web3.js';
import {
  decisionReceiptMaterialHash,
  decisionReceiptV2Schema,
  toJsonValue,
  type Clock,
  type DecisionReceiptV2,
  type JsonValue,
  type ProofVerification,
  type ReceiptEvidence,
} from '@lagshield/core';
import {
  deriveDailyOddsRootAddress,
  deriveDailyScoresRootAddress,
  oddsProofReference,
  scoreStatProofReference,
  txLineExplorerAddressUrl,
  TxLineProofVerificationError,
  verifyTxLineOddsProof,
  verifyTxLineScoreStatProof,
  type TxLineApiClient,
  type TxLineNetworkConfig,
  type TxLineOddsProofVerificationResult,
  type TxLineOddsValidation,
  type TxLineScoreProofVerificationResult,
  type TxLineScoreStatValidation,
} from '@lagshield/txline';

import type { PostgresDecisionReceiptStore } from '../db/receipt-store.js';

type ReceiptStore = Pick<
  PostgresDecisionReceiptStore,
  'listPending' | 'updateVerification'
>;
type ProofClient = Pick<
  TxLineApiClient,
  'fetchOddsValidation' | 'fetchScoreStatValidation'
>;
type VerifyOddsProof = (input: {
  config: TxLineNetworkConfig;
  connection: Pick<
    Connection,
    'getAccountInfo' | 'getGenesisHash' | 'simulateTransaction'
  >;
  expectedMessageId: string;
  expectedTimestampMs: number;
  simulationPayer: PublicKey;
  validation: TxLineOddsValidation;
}) => Promise<TxLineOddsProofVerificationResult>;
type VerifyScoreProof = (input: {
  config: TxLineNetworkConfig;
  connection: Pick<
    Connection,
    'getAccountInfo' | 'getGenesisHash' | 'simulateTransaction'
  >;
  expectedFixtureId: number;
  expectedSequence: number;
  expectedStatKey: number;
  expectedTimestampMs: number;
  simulationPayer: PublicKey;
  validation: TxLineScoreStatValidation;
}) => Promise<TxLineScoreProofVerificationResult>;

export type DecisionProofRunResult = Readonly<{
  error: number;
  processed: number;
  rejected: number;
  unavailable: number;
  verified: number;
}>;

function verificationTime(receipt: DecisionReceiptV2, clock: Clock): number {
  return Math.max(receipt.verification.updatedAtMs, clock.nowMs());
}

function oddsEvidence(receipt: DecisionReceiptV2): ReceiptEvidence | null {
  const candidates = receipt.canonicalPayload.evidence.filter(
    (evidence) =>
      evidence.kind === 'odds.observed' &&
      evidence.source !== 'simulation' &&
      evidence.sourceTimestampMs !== null,
  );
  const trigger = candidates.find(
    ({ eventId }) => eventId === receipt.canonicalPayload.decision.triggerEventId,
  );
  if (trigger) return trigger;
  return (
    [...candidates].sort(
      (left, right) =>
        right.sourceTimestampMs! - left.sourceTimestampMs! ||
        left.eventId.localeCompare(right.eventId),
    )[0] ?? null
  );
}

type ScoreProofCoordinates = Readonly<{
  evidence: ReceiptEvidence;
  fixtureId: number;
  sequence: number;
  statKey: number;
}>;

function scoreEvidence(receipt: DecisionReceiptV2): ScoreProofCoordinates | null {
  const candidates = receipt.canonicalPayload.evidence.filter(
    (evidence) =>
      evidence.kind === 'score.observed' &&
      evidence.source !== 'simulation' &&
      evidence.sourceTimestampMs !== null,
  );
  const ordered = [...candidates].sort((left, right) => {
    const leftTrigger =
      left.eventId === receipt.canonicalPayload.decision.triggerEventId ? 1 : 0;
    const rightTrigger =
      right.eventId === receipt.canonicalPayload.decision.triggerEventId ? 1 : 0;
    return (
      rightTrigger - leftTrigger ||
      right.sourceTimestampMs! - left.sourceTimestampMs! ||
      left.eventId.localeCompare(right.eventId)
    );
  });
  for (const evidence of ordered) {
    const match = /^(\d+):(\d+)$/.exec(evidence.sourceMessageId);
    if (!match) continue;
    const fixtureId = Number(match[1]);
    const sequence = Number(match[2]);
    if (
      !Number.isSafeInteger(fixtureId) ||
      !Number.isSafeInteger(sequence) ||
      fixtureId < 0 ||
      sequence < 1 ||
      String(fixtureId) !== receipt.canonicalPayload.decision.fixtureId
    ) {
      continue;
    }
    if (evidence.scoreStatKey === null) continue;
    return { evidence, fixtureId, sequence, statKey: evidence.scoreStatKey };
  }
  return null;
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown proof failure.';
  return message.slice(0, 1_000) || 'Unknown proof failure.';
}

function errorCode(error: unknown): string {
  if (error instanceof TxLineProofVerificationError) return error.code;
  if (
    error instanceof Error &&
    error.name === 'TxLineApiError' &&
    'retryable' in error &&
    error.retryable === true
  ) {
    return 'TXLINE_API_RETRYABLE';
  }
  if (error instanceof Error && error.name === 'TxLineApiError') {
    return 'TXLINE_API_ERROR';
  }
  return 'PROOF_VERIFICATION_ERROR';
}

function terminalBase(
  receipt: DecisionReceiptV2,
  completedAtMs: number,
): ProofVerification {
  return {
    ...receipt.verification,
    attemptCount: receipt.verification.attemptCount + 1,
    attemptedAtMs: completedAtMs,
    completedAtMs,
    errorCode: null,
    errorMessage: null,
    updatedAtMs: completedAtMs,
  };
}

export class DecisionProofService {
  readonly #client: ProofClient;
  readonly #clock: Clock;
  readonly #config: TxLineNetworkConfig;
  readonly #connection: Pick<
    Connection,
    'getAccountInfo' | 'getGenesisHash' | 'simulateTransaction'
  >;
  readonly #receiptStore: ReceiptStore;
  readonly #simulationPayer: PublicKey;
  readonly #verifyOddsProof: VerifyOddsProof;
  readonly #verifyScoreProof: VerifyScoreProof;

  constructor(
    dependencies: Readonly<{
      client: ProofClient;
      clock: Clock;
      config: TxLineNetworkConfig;
      connection: Pick<
        Connection,
        'getAccountInfo' | 'getGenesisHash' | 'simulateTransaction'
      >;
      receiptStore: ReceiptStore;
      simulationPayer: PublicKey;
      verifyOddsProof?: VerifyOddsProof;
      verifyScoreProof?: VerifyScoreProof;
    }>,
  ) {
    this.#client = dependencies.client;
    this.#clock = dependencies.clock;
    this.#config = dependencies.config;
    this.#connection = dependencies.connection;
    this.#receiptStore = dependencies.receiptStore;
    this.#simulationPayer = dependencies.simulationPayer;
    this.#verifyOddsProof = dependencies.verifyOddsProof ?? verifyTxLineOddsProof;
    this.#verifyScoreProof = dependencies.verifyScoreProof ?? verifyTxLineScoreStatProof;
  }

  async runPending(limit = 20): Promise<DecisionProofRunResult> {
    const receipts = await this.#receiptStore.listPending(limit);
    const result = {
      error: 0,
      processed: 0,
      rejected: 0,
      unavailable: 0,
      verified: 0,
    };
    for (const receipt of receipts) {
      const verified = await this.verify(receipt);
      result.processed += 1;
      if (verified.verification.status === 'pending') {
        throw new Error('Proof verification returned a non-terminal result.');
      }
      result[verified.verification.status] += 1;
    }
    return result;
  }

  async verify(receiptInput: DecisionReceiptV2): Promise<DecisionReceiptV2> {
    const receipt = decisionReceiptV2Schema.parse(receiptInput);
    const evidence = oddsEvidence(receipt);
    const completedAtMs = verificationTime(receipt, this.#clock);
    if (!evidence || evidence.sourceTimestampMs === null) {
      const score = scoreEvidence(receipt);
      if (score) return this.#verifyScore(receipt, score, completedAtMs);
      return this.#receiptStore.updateVerification({
        expectedAttemptCount: receipt.verification.attemptCount,
        proofMaterial: null,
        receiptId: receipt.receiptId,
        verification: {
          ...terminalBase(receipt, completedAtMs),
          status: 'unavailable',
          summary:
            'No exact TxLINE odds or score proof coordinates are present in this decision receipt.',
        },
      });
    }

    let material: JsonValue | null = null;
    try {
      const validation = await this.#client.fetchOddsValidation({
        messageId: evidence.sourceMessageId,
        timestampMs: evidence.sourceTimestampMs,
      });
      material = toJsonValue(validation);
      const result = await this.#verifyOddsProof({
        config: this.#config,
        connection: this.#connection,
        expectedMessageId: evidence.sourceMessageId,
        expectedTimestampMs: evidence.sourceTimestampMs,
        simulationPayer: this.#simulationPayer,
        validation,
      });
      if (result.proofMaterialHash !== decisionReceiptMaterialHash(material)) {
        throw new Error('Verifier proof material hash does not match its API response.');
      }
      return this.#receiptStore.updateVerification({
        expectedAttemptCount: receipt.verification.attemptCount,
        proofMaterial: material,
        receiptId: receipt.receiptId,
        verification: {
          ...terminalBase(receipt, completedAtMs),
          errorCode: null,
          errorMessage: null,
          explorerAccountUrl: result.explorerAccountUrl,
          explorerProgramUrl: result.explorerProgramUrl,
          kind: 'odds',
          network: result.network,
          programId: result.programId,
          proofMaterialHash: result.proofMaterialHash,
          proofReference: result.proofReference,
          rootAccount: result.rootAccount,
          simulationSlot: result.simulationSlot,
          sourceEventId: evidence.eventId,
          sourceMessageId: result.sourceMessageId,
          sourceTimestampMs: result.sourceTimestampMs,
          status: result.status,
          summary: result.summary,
        },
      });
    } catch (error) {
      const proofTimestamp = evidence.sourceTimestampMs;
      const rootAccount = deriveDailyOddsRootAddress(
        this.#config,
        proofTimestamp,
      ).toBase58();
      return this.#receiptStore.updateVerification({
        expectedAttemptCount: receipt.verification.attemptCount,
        proofMaterial: material,
        receiptId: receipt.receiptId,
        verification: {
          ...terminalBase(receipt, completedAtMs),
          errorCode: errorCode(error),
          errorMessage: boundedErrorMessage(error),
          explorerAccountUrl: txLineExplorerAddressUrl(rootAccount, this.#config.network),
          explorerProgramUrl: txLineExplorerAddressUrl(
            this.#config.programId,
            this.#config.network,
          ),
          kind: 'odds',
          network: this.#config.network,
          programId: this.#config.programId,
          proofMaterialHash:
            material === null ? null : decisionReceiptMaterialHash(material),
          proofReference: oddsProofReference(evidence.sourceMessageId, proofTimestamp),
          rootAccount,
          simulationSlot: null,
          sourceEventId: evidence.eventId,
          sourceMessageId: evidence.sourceMessageId,
          sourceTimestampMs: proofTimestamp,
          status: 'error',
          summary:
            'TxLINE proof verification failed explicitly; no verified claim was made.',
        },
      });
    }
  }

  async #verifyScore(
    receipt: DecisionReceiptV2,
    coordinates: ScoreProofCoordinates,
    completedAtMs: number,
  ): Promise<DecisionReceiptV2> {
    const { evidence, fixtureId, sequence, statKey } = coordinates;
    if (evidence.sourceTimestampMs === null) {
      throw new Error('Score proof evidence is missing its source timestamp.');
    }
    let validation: TxLineScoreStatValidation | null = null;
    let material: JsonValue | null = null;
    try {
      validation = await this.#client.fetchScoreStatValidation({
        fixtureId,
        sequence,
        statKey,
      });
      material = toJsonValue(validation);
      const result = await this.#verifyScoreProof({
        config: this.#config,
        connection: this.#connection,
        expectedFixtureId: fixtureId,
        expectedSequence: sequence,
        expectedStatKey: statKey,
        expectedTimestampMs: evidence.sourceTimestampMs,
        simulationPayer: this.#simulationPayer,
        validation,
      });
      if (result.proofMaterialHash !== decisionReceiptMaterialHash(material)) {
        throw new Error('Verifier proof material hash does not match its API response.');
      }
      return this.#receiptStore.updateVerification({
        expectedAttemptCount: receipt.verification.attemptCount,
        proofMaterial: material,
        receiptId: receipt.receiptId,
        verification: {
          ...terminalBase(receipt, completedAtMs),
          explorerAccountUrl: result.explorerAccountUrl,
          explorerProgramUrl: result.explorerProgramUrl,
          kind: 'score',
          network: result.network,
          programId: result.programId,
          proofMaterialHash: result.proofMaterialHash,
          proofReference: result.proofReference,
          rootAccount: result.rootAccount,
          simulationSlot: result.simulationSlot,
          sourceEventId: evidence.eventId,
          sourceMessageId: evidence.sourceMessageId,
          sourceTimestampMs: result.sourceTimestampMs,
          status: result.status,
          summary: result.summary,
        },
      });
    } catch (error) {
      const rootTimestamp =
        validation?.summary.updateStats.minTimestamp ?? evidence.sourceTimestampMs;
      const rootAccount = deriveDailyScoresRootAddress(
        this.#config,
        rootTimestamp,
      ).toBase58();
      return this.#receiptStore.updateVerification({
        expectedAttemptCount: receipt.verification.attemptCount,
        proofMaterial: material,
        receiptId: receipt.receiptId,
        verification: {
          ...terminalBase(receipt, completedAtMs),
          errorCode: errorCode(error),
          errorMessage: boundedErrorMessage(error),
          explorerAccountUrl: txLineExplorerAddressUrl(rootAccount, this.#config.network),
          explorerProgramUrl: txLineExplorerAddressUrl(
            this.#config.programId,
            this.#config.network,
          ),
          kind: 'score',
          network: this.#config.network,
          programId: this.#config.programId,
          proofMaterialHash:
            material === null ? null : decisionReceiptMaterialHash(material),
          proofReference: scoreStatProofReference({ fixtureId, sequence, statKey }),
          rootAccount,
          simulationSlot: null,
          sourceEventId: evidence.eventId,
          sourceMessageId: evidence.sourceMessageId,
          sourceTimestampMs: evidence.sourceTimestampMs,
          status: 'error',
          summary:
            'TxLINE score proof verification failed explicitly; no verified claim was made.',
        },
      });
    }
  }
}

export type DecisionProofWorkerSnapshot = Readonly<{
  lastError: string | null;
  lastFinishedAtMs: number | null;
  lastResult: DecisionProofRunResult | null;
  running: boolean;
}>;

export class DecisionProofWorker {
  readonly #clock: Clock;
  readonly #intervalMs: number;
  readonly #service: Pick<DecisionProofService, 'runPending'>;
  #inFlight: Promise<void> | null = null;
  #lastError: string | null = null;
  #lastFinishedAtMs: number | null = null;
  #lastResult: DecisionProofRunResult | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    dependencies: Readonly<{
      clock: Clock;
      intervalMs?: number;
      service: Pick<DecisionProofService, 'runPending'>;
    }>,
  ) {
    const intervalMs = dependencies.intervalMs ?? 10_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
      throw new Error('Proof worker interval must be at least 1,000ms.');
    }
    this.#clock = dependencies.clock;
    this.#intervalMs = intervalMs;
    this.#service = dependencies.service;
  }

  start(): void {
    if (this.#timer) throw new Error('Decision proof worker is already started.');
    void this.runNow();
    this.#timer = setInterval(() => void this.runNow(), this.#intervalMs);
    this.#timer.unref();
  }

  async runNow(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#run().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#inFlight;
  }

  snapshot(): DecisionProofWorkerSnapshot {
    return {
      lastError: this.#lastError,
      lastFinishedAtMs: this.#lastFinishedAtMs,
      lastResult: this.#lastResult,
      running: this.#timer !== null,
    };
  }

  async #run(): Promise<void> {
    try {
      this.#lastResult = await this.#service.runPending();
      this.#lastError = null;
    } catch (error) {
      this.#lastError = boundedErrorMessage(error);
    } finally {
      this.#lastFinishedAtMs = this.#clock.nowMs();
    }
  }
}
