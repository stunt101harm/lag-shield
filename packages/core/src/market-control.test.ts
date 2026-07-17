import { describe, expect, it } from 'vitest';

import { toJsonValue } from './json.js';
import {
  buildDecisionReceipt,
  buildSimulatedOrderId,
  createMarketControlAdmission,
  hashMarketOrderRequest,
} from './market-control.js';
import {
  createStrategyDecision,
  marketOrderRequestSchema,
  type MarketControlSnapshot,
  type MarketControlState,
  type MarketOrderRequest,
} from './models.js';

function decision(state: MarketControlState) {
  const transition = {
    OPEN: { action: 'none', expectedStateVersion: 0, previousState: 'OPEN' },
    PAUSED: { action: 'pause', expectedStateVersion: 0, previousState: 'OPEN' },
    RECOVERY: {
      action: 'begin_recovery',
      expectedStateVersion: 1,
      previousState: 'PAUSED',
    },
    WIDENED: { action: 'widen', expectedStateVersion: 0, previousState: 'OPEN' },
  } as const;
  const selected = transition[state];
  return createStrategyDecision({
    action: selected.action,
    expectedStateVersion: selected.expectedStateVersion,
    fixtureId: 'fixture-1',
    logicalTimestampMs: 1_000,
    marketId: 'market-1',
    metrics: {},
    nextState: state,
    payloadVersion: 1,
    policyVersion: `test-${state}`,
    previousState: selected.previousState,
    reasonCodes: ['TEST_STATE'],
    triggerEventId: `event-${state}-${selected.expectedStateVersion + 1}`,
  });
}

function request(overrides: Partial<MarketOrderRequest> = {}): MarketOrderRequest {
  return marketOrderRequestSchema.parse({
    expectedDecisionId: 'placeholder',
    expectedStateVersion: 1,
    fixtureId: 'fixture-1',
    idempotencyKey: 'client-order-1',
    marketId: 'market-1',
    namespace: 'replay:judge-demo',
    outcomeId: 'home',
    payloadVersion: 1,
    price: 2100,
    quoteObservedAtMs: 1_900,
    requestedAtMs: 2_000,
    side: 'back',
    stakeMicros: 1_000_000,
    ...overrides,
  });
}

function snapshot(
  state: MarketControlState,
  lastDecisionId: string,
  stateVersion = 1,
): MarketControlSnapshot {
  return {
    fixtureId: 'fixture-1',
    lastDecisionId,
    logicalTimestampMs: 1_000,
    marketId: 'market-1',
    state,
    stateVersion,
  };
}

describe('simulated market-control admission', () => {
  it.each([
    ['OPEN', 'accepted', 'ORDER_ACCEPTED_OPEN'],
    ['WIDENED', 'stale', 'ORDER_STALE_WIDENED_REQUOTE_REQUIRED'],
    ['PAUSED', 'rejected', 'ORDER_REJECTED_PAUSED'],
    ['RECOVERY', 'rejected', 'ORDER_REJECTED_RECOVERY'],
  ] as const)('applies the documented %s admission policy', (state, status, reason) => {
    const committedDecision = decision(state);
    const stateVersion = committedDecision.expectedStateVersion + 1;
    const committedSnapshot = snapshot(state, committedDecision.decisionId, stateVersion);
    const admission = createMarketControlAdmission({
      decision: committedDecision,
      evaluatedAtMs: 2_100,
      request: request({
        expectedDecisionId: committedDecision.decisionId,
        expectedStateVersion: stateVersion,
      }),
      snapshot: committedSnapshot,
    });

    expect(admission.order).toMatchObject({
      admissionLatencyMs: 100,
      admissionPolicyVersion: 'lag-shield-market-admission-v1',
      admissionReasonCode: reason,
      marketState: state,
      requiresRequote: state === 'WIDENED',
      status,
    });
    expect(admission.order.decisionId).toBe(committedDecision.decisionId);
    expect(admission.order.circuitBreakerReceiptId).toBe(
      admission.decisionReceipt.receiptId,
    );
  });

  it('marks stale OPEN requests when their quote or state expectation is obsolete', () => {
    const committedDecision = decision('OPEN');
    const committedSnapshot = snapshot('OPEN', committedDecision.decisionId);
    const staleState = createMarketControlAdmission({
      decision: committedDecision,
      evaluatedAtMs: 2_100,
      request: request({ expectedDecisionId: 'older-decision' }),
      snapshot: committedSnapshot,
    });
    const staleQuote = createMarketControlAdmission({
      decision: committedDecision,
      evaluatedAtMs: 5_000,
      request: request({ expectedDecisionId: committedDecision.decisionId }),
      snapshot: committedSnapshot,
    });

    expect(staleState.order).toMatchObject({
      admissionReasonCode: 'ORDER_STALE_STATE_VERSION',
      status: 'stale',
    });
    expect(staleQuote.order).toMatchObject({
      admissionReasonCode: 'ORDER_STALE_QUOTE_AGE',
      status: 'stale',
    });
  });

  it('derives byte-stable order and receipt identities from canonical inputs', () => {
    const committedDecision = decision('OPEN');
    const input = request({ expectedDecisionId: committedDecision.decisionId });
    const first = createMarketControlAdmission({
      decision: committedDecision,
      evaluatedAtMs: 2_100,
      request: input,
      snapshot: snapshot('OPEN', committedDecision.decisionId),
    });
    const second = createMarketControlAdmission({
      decision: committedDecision,
      evaluatedAtMs: 2_100,
      request: marketOrderRequestSchema.parse(toJsonValue(input)),
      snapshot: snapshot('OPEN', committedDecision.decisionId),
    });

    expect(second).toEqual(first);
    expect(first.order.orderId).toBe(buildSimulatedOrderId(input));
    expect(first.order.requestHash).toBe(hashMarketOrderRequest(input));
    expect(first.decisionReceipt).toEqual(buildDecisionReceipt(committedDecision));
    expect(first.decisionReceipt.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('isolates identical client keys across deterministic replay namespaces', () => {
    expect(buildSimulatedOrderId(request({ namespace: 'replay:one' }))).not.toBe(
      buildSimulatedOrderId(request({ namespace: 'replay:two' })),
    );
  });

  it('rejects impossible timestamps and mismatched committed evidence', () => {
    const committedDecision = decision('OPEN');
    const committedSnapshot = snapshot('OPEN', committedDecision.decisionId);

    expect(() => request({ quoteObservedAtMs: 2_001, requestedAtMs: 2_000 })).toThrow(
      /Quote observation/,
    );
    expect(() =>
      createMarketControlAdmission({
        decision: committedDecision,
        evaluatedAtMs: 1_999,
        request: request({ expectedDecisionId: committedDecision.decisionId }),
        snapshot: committedSnapshot,
      }),
    ).toThrow(/cannot precede/);
    expect(() =>
      createMarketControlAdmission({
        decision: committedDecision,
        evaluatedAtMs: 2_100,
        request: request({
          expectedDecisionId: committedDecision.decisionId,
          marketId: 'wrong-market',
        }),
        snapshot: committedSnapshot,
      }),
    ).toThrow(/does not belong/);
  });
});
