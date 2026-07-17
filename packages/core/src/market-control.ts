import { z } from 'zod';

import { stableHash, toJsonValue } from './json.js';
import {
  decisionReceiptSchema,
  marketOrderRequestSchema,
  simulatedOrderV2Schema,
  strategyDecisionSchema,
  type DecisionReceipt,
  type MarketControlSnapshot,
  type MarketOrderAdmissionReasonCode,
  type MarketOrderRequest,
  type SimulatedOrderV2,
  type StrategyDecision,
} from './models.js';

export const simulatedMarketControlAdapter = 'lag-shield-simulated-market-v1';

export const marketControlPolicyConfigurationSchema = z
  .object({
    maxQuoteAgeMs: z.number().int().positive().safe(),
  })
  .strict();
export type MarketControlPolicyConfiguration = z.infer<
  typeof marketControlPolicyConfigurationSchema
>;

export const defaultMarketControlPolicyConfiguration = Object.freeze({
  maxQuoteAgeMs: 2_000,
}) satisfies MarketControlPolicyConfiguration;

export type MarketControlAdmission = Readonly<{
  decisionReceipt: DecisionReceipt;
  order: SimulatedOrderV2;
}>;

export type MarketControlSubmission = MarketControlAdmission &
  Readonly<{ persistenceStatus: 'duplicate' | 'inserted' }>;

export interface MarketControlPort {
  submitOrder(request: MarketOrderRequest): Promise<MarketControlSubmission>;
}

export function hashMarketOrderRequest(request: MarketOrderRequest): string {
  return stableHash(toJsonValue(marketOrderRequestSchema.parse(request)));
}

export function buildSimulatedOrderId(
  input: Pick<MarketOrderRequest, 'idempotencyKey' | 'namespace'>,
): string {
  return `ord_${stableHash(toJsonValue(input)).slice(0, 40)}`;
}

export function buildDecisionReceipt(decisionInput: StrategyDecision): DecisionReceipt {
  const decision = strategyDecisionSchema.parse(decisionInput);
  const payloadHash = stableHash(toJsonValue(decision));
  return decisionReceiptSchema.parse({
    anchoredAtMs: null,
    decisionId: decision.decisionId,
    payloadHash,
    proofReference: null,
    receiptId: `rcpt_${payloadHash.slice(0, 40)}`,
    status: 'pending',
  });
}

type AdmissionOutcome = Readonly<{
  explanation: string;
  reasonCode: MarketOrderAdmissionReasonCode;
  status: 'accepted' | 'rejected' | 'stale';
}>;

function evaluateAdmission(
  request: MarketOrderRequest,
  snapshot: MarketControlSnapshot,
  evaluatedAtMs: number,
  policy: MarketControlPolicyConfiguration,
): AdmissionOutcome {
  if (snapshot.state === 'PAUSED') {
    return {
      explanation:
        'Rejected because the latest committed circuit-breaker state is PAUSED.',
      reasonCode: 'ORDER_REJECTED_PAUSED',
      status: 'rejected',
    };
  }
  if (snapshot.state === 'RECOVERY') {
    return {
      explanation:
        'Rejected while the market proves stable recovery; admission resumes only after OPEN.',
      reasonCode: 'ORDER_REJECTED_RECOVERY',
      status: 'rejected',
    };
  }
  if (snapshot.state === 'WIDENED') {
    return {
      explanation:
        'Marked stale because WIDENED requires a fresh downstream quote before admission.',
      reasonCode: 'ORDER_STALE_WIDENED_REQUOTE_REQUIRED',
      status: 'stale',
    };
  }
  if (
    request.expectedDecisionId !== snapshot.lastDecisionId ||
    request.expectedStateVersion !== snapshot.stateVersion
  ) {
    return {
      explanation:
        'Marked stale because the quoted circuit-breaker version is not the latest committed version.',
      reasonCode: 'ORDER_STALE_STATE_VERSION',
      status: 'stale',
    };
  }
  if (evaluatedAtMs - request.quoteObservedAtMs > policy.maxQuoteAgeMs) {
    return {
      explanation: `Marked stale because quote age exceeds ${policy.maxQuoteAgeMs}ms.`,
      reasonCode: 'ORDER_STALE_QUOTE_AGE',
      status: 'stale',
    };
  }
  return {
    explanation: 'Accepted against the latest committed OPEN circuit-breaker decision.',
    reasonCode: 'ORDER_ACCEPTED_OPEN',
    status: 'accepted',
  };
}

export function createMarketControlAdmission(
  input: Readonly<{
    decision: StrategyDecision;
    evaluatedAtMs: number;
    policy?: MarketControlPolicyConfiguration;
    request: MarketOrderRequest;
    snapshot: MarketControlSnapshot;
  }>,
): MarketControlAdmission {
  const request = marketOrderRequestSchema.parse(input.request);
  const decision = strategyDecisionSchema.parse(input.decision);
  const policy = marketControlPolicyConfigurationSchema.parse(
    input.policy ?? defaultMarketControlPolicyConfiguration,
  );
  if (!Number.isSafeInteger(input.evaluatedAtMs) || input.evaluatedAtMs < 0) {
    throw new Error('Admission time must be a non-negative safe integer.');
  }
  if (input.evaluatedAtMs < request.requestedAtMs) {
    throw new Error('Admission time cannot precede the request timestamp.');
  }
  if (
    request.fixtureId !== input.snapshot.fixtureId ||
    request.marketId !== input.snapshot.marketId
  ) {
    throw new Error('Order request does not belong to the committed market snapshot.');
  }
  if (
    decision.fixtureId !== input.snapshot.fixtureId ||
    decision.marketId !== input.snapshot.marketId ||
    decision.decisionId !== input.snapshot.lastDecisionId ||
    decision.nextState !== input.snapshot.state ||
    decision.expectedStateVersion + 1 !== input.snapshot.stateVersion
  ) {
    throw new Error('Committed market snapshot and strategy decision are inconsistent.');
  }

  const outcome = evaluateAdmission(request, input.snapshot, input.evaluatedAtMs, policy);
  const receipt = buildDecisionReceipt(decision);
  const order = simulatedOrderV2Schema.parse({
    admissionLatencyMs: input.evaluatedAtMs - request.requestedAtMs,
    admissionPolicyVersion: 'lag-shield-market-admission-v1',
    admissionReasonCode: outcome.reasonCode,
    circuitBreakerReceiptId: receipt.receiptId,
    createdAtMs: input.evaluatedAtMs,
    decisionId: decision.decisionId,
    expectedDecisionId: request.expectedDecisionId,
    expectedStateVersion: request.expectedStateVersion,
    explanation: outcome.explanation,
    fixtureId: request.fixtureId,
    idempotencyKey: request.idempotencyKey,
    marketId: request.marketId,
    marketState: input.snapshot.state,
    marketStateVersion: input.snapshot.stateVersion,
    namespace: request.namespace,
    orderId: buildSimulatedOrderId(request),
    outcomeId: request.outcomeId,
    payloadVersion: 2,
    price: request.price,
    quoteAgeMs: input.evaluatedAtMs - request.quoteObservedAtMs,
    quoteObservedAtMs: request.quoteObservedAtMs,
    requestHash: hashMarketOrderRequest(request),
    requestedAtMs: request.requestedAtMs,
    requiresRequote: outcome.status === 'stale',
    settledAtMs: null,
    settlement: null,
    side: request.side,
    stakeMicros: request.stakeMicros,
    status: outcome.status,
  });
  return { decisionReceipt: receipt, order };
}
