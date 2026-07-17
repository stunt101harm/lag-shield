import { afterEach, describe, expect, it } from 'vitest';
import {
  createMarketControlAdmission,
  createStrategyDecision,
  marketOrderRequestSchema,
  type MarketControlPort,
} from '@lagshield/core';

import { buildApp } from './app.js';

let app: ReturnType<typeof buildApp> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('agent health endpoint', () => {
  it('reports a stable service identity', async () => {
    app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: 'lagshield-agent',
      status: 'ok',
      version: '0.1.0',
    });
  });

  it('reports live ingestion as explicitly disabled when it is not configured', async () => {
    app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/metrics/streams' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: false });
  });

  it('exposes secret-free live stream freshness and counters', async () => {
    const stream = {
      acceptedCount: 4,
      connectedAtMs: 100,
      duplicateCount: 1,
      kind: 'odds' as const,
      lastActivityAtMs: 200,
      lastDiagnostic: null,
      lastEventAtMs: 190,
      lastEventId: 'event-4',
      lastSourceTimestampMs: 180,
      quarantineCount: 2,
      reconnectCount: 3,
      retryDelayMs: null,
      state: 'connected' as const,
      streamLagMs: 20,
      trackedFixtureIds: ['42'],
    };
    app = buildApp({
      getLiveIngestionSnapshot: () => ({
        discoveredFixtureIds: ['42'],
        fixtureDiscoveryAtMs: 90,
        fixtureDiscoveryDiagnostic: null,
        odds: stream,
        scores: { ...stream, kind: 'scores' },
      }),
    });

    const response = await app.inject({ method: 'GET', url: '/metrics/streams' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: true,
      odds: { acceptedCount: 4, state: 'connected', streamLagMs: 20 },
      scores: { kind: 'scores' },
    });
    expect(response.body).not.toContain('apiToken');
    expect(response.body).not.toContain('Authorization');
  });

  it('labels the order gateway as simulated and fails closed when disabled', async () => {
    app = buildApp();

    const capability = await app.inject({
      method: 'GET',
      url: '/v1/simulated-market-control',
    });
    const order = await app.inject({
      method: 'POST',
      payload: {},
      url: '/v1/simulated-orders',
    });

    expect(capability.json()).toEqual({
      adapter: 'lag-shield-simulated-market-v1',
      enabled: false,
      realMoney: false,
    });
    expect(order.statusCode).toBe(503);
    expect(order.json()).toMatchObject({
      code: 'SIMULATED_MARKET_CONTROL_DISABLED',
      realMoney: false,
    });
  });

  it('submits a validated order and returns its linked circuit-breaker receipt', async () => {
    const decision = createStrategyDecision({
      action: 'none',
      expectedStateVersion: 0,
      fixtureId: 'fixture-1',
      logicalTimestampMs: 1_000,
      marketId: 'market-1',
      metrics: {},
      nextState: 'OPEN',
      payloadVersion: 1,
      policyVersion: 'api-test',
      previousState: 'OPEN',
      reasonCodes: ['HEALTHY'],
      triggerEventId: 'event-1',
    });
    const request = marketOrderRequestSchema.parse({
      expectedDecisionId: decision.decisionId,
      expectedStateVersion: 1,
      fixtureId: 'fixture-1',
      idempotencyKey: 'api-order-1',
      marketId: 'market-1',
      namespace: 'replay:api-test',
      outcomeId: 'home',
      payloadVersion: 1,
      price: 2100,
      quoteObservedAtMs: 1_900,
      requestedAtMs: 2_000,
      side: 'back',
      stakeMicros: 1_000_000,
    });
    const admission = createMarketControlAdmission({
      decision,
      evaluatedAtMs: 2_100,
      request,
      snapshot: {
        fixtureId: 'fixture-1',
        lastDecisionId: decision.decisionId,
        logicalTimestampMs: 1_000,
        marketId: 'market-1',
        state: 'OPEN',
        stateVersion: 1,
      },
    });
    const marketControl: MarketControlPort = {
      submitOrder: async () => ({ ...admission, persistenceStatus: 'inserted' }),
    };
    app = buildApp({ marketControl });

    const response = await app.inject({
      method: 'POST',
      payload: request,
      url: '/v1/simulated-orders',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      adapter: 'lag-shield-simulated-market-v1',
      decisionReceipt: { decisionId: decision.decisionId, status: 'pending' },
      order: {
        admissionReasonCode: 'ORDER_ACCEPTED_OPEN',
        circuitBreakerReceiptId: admission.decisionReceipt.receiptId,
        status: 'accepted',
      },
      persistenceStatus: 'inserted',
      realMoney: false,
    });
  });

  it('returns bounded validation details for malformed simulated orders', async () => {
    const marketControl: MarketControlPort = {
      submitOrder: async () => {
        throw new Error('should not execute');
      },
    };
    app = buildApp({ marketControl });

    const response = await app.inject({
      method: 'POST',
      payload: { stakeMicros: 0 },
      url: '/v1/simulated-orders',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'INVALID_SIMULATED_ORDER',
      realMoney: false,
    });
    expect(response.json().issues.length).toBeGreaterThan(0);
  });
});
