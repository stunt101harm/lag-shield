import { afterEach, describe, expect, it } from 'vitest';
import {
  createMarketControlAdmission,
  createPendingDecisionReceipt,
  createStrategyDecision,
  marketOrderRequestSchema,
  type MarketControlPort,
} from '@lagshield/core';

import { buildApp, type JudgeReadPort } from './app.js';

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

  it('exposes proof worker health without credentials or proof material', async () => {
    app = buildApp({
      getProofVerificationSnapshot: () => ({
        lastError: null,
        lastFinishedAtMs: 123,
        lastResult: {
          error: 0,
          processed: 2,
          rejected: 0,
          unavailable: 1,
          verified: 1,
        },
        running: true,
      }),
    });

    const response = await app.inject({ method: 'GET', url: '/metrics/proofs' });

    expect(response.json()).toMatchObject({
      enabled: true,
      lastResult: { processed: 2, verified: 1 },
      running: true,
    });
    expect(response.body).not.toContain('apiToken');
  });

  it('labels the order gateway as simulated and fails closed when disabled', async () => {
    app = buildApp();

    const capability = await app.inject({
      method: 'GET',
      url: '/v1/simulated-market-control',
    });
    const order = await app.inject({
      method: 'POST',
      payload: {
        expectedDecisionId: 'decision-1',
        expectedStateVersion: 1,
        fixtureId: 'fixture-1',
        idempotencyKey: 'disabled-order-1',
        marketId: 'market-1',
        namespace: 'live',
        outcomeId: 'home',
        payloadVersion: 1,
        price: 2_100,
        quoteObservedAtMs: 1_000,
        requestedAtMs: 1_100,
        side: 'back',
        stakeMicros: 1_000_000,
      },
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
      decisionReceipt: {
        decisionId: decision.decisionId,
        verification: { status: 'pending' },
      },
      order: {
        admissionReasonCode: 'ORDER_ACCEPTED_OPEN',
        circuitBreakerReceiptId: admission.decisionReceipt.receiptId,
        status: 'accepted',
      },
      persistenceStatus: 'inserted',
      realMoney: false,
    });
  });

  it('returns a canonical receipt, exact provenance, and proof lifecycle', async () => {
    const decision = createStrategyDecision({
      action: 'pause',
      expectedStateVersion: 0,
      fixtureId: 'fixture-1',
      logicalTimestampMs: 1_000,
      marketId: 'market-1',
      metrics: {},
      nextState: 'PAUSED',
      payloadVersion: 1,
      policyVersion: 'receipt-api-test',
      previousState: 'OPEN',
      reasonCodes: ['SCORE_SHOCK'],
      triggerEventId: 'event-1',
    });
    const receipt = createPendingDecisionReceipt(decision, [
      {
        eventId: 'event-1',
        kind: 'score.observed',
        scoreStatKey: 1,
        source: 'txline-live',
        sourceMessageId: 'score-message-1',
        sourceTimestampMs: 999,
      },
    ]);
    app = buildApp({
      receiptReader: {
        load: async () => ({ proofMaterial: null, receipt }),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/decision-receipts/${receipt.receiptId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      decisionAnchor: {
        algorithm: 'sha256',
        payloadHash: receipt.payloadHash,
        receiptId: receipt.receiptId,
      },
      receipt: {
        canonicalPayload: {
          evidence: [{ sourceMessageId: 'score-message-1' }],
        },
      },
      txlineAnchor: { status: 'pending' },
    });
  });

  it('returns 404 for an unknown receipt', async () => {
    app = buildApp({ receiptReader: { load: async () => null } });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/decision-receipts/missing',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: 'DECISION_RECEIPT_NOT_FOUND',
      receiptId: 'missing',
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
    expect(response.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(response.headers['x-request-id']).toBeTruthy();
  });
});

describe('judge API contract', () => {
  function judgeRead(overrides: Partial<JudgeReadPort> = {}): JudgeReadPort {
    return {
      listDecisions: async () => [],
      listFixtures: async () => [],
      listMarkets: async () => [],
      listOrders: async () => [],
      listReceipts: async () => [],
      listReplayRuns: async () => [],
      listTimeline: async () => [],
      loadFixture: async () => null,
      marketConsensus: async () => null,
      overview: async () => ({
        counts: {
          decisions: 0,
          fixtures: 0,
          orders: 0,
          pendingProofs: 0,
          replayRuns: 0,
        },
        latestDecision: null,
        latestOrder: null,
      }),
      readiness: async () => ({ database: 'ready' }),
      ...overrides,
    };
  }

  it('distinguishes liveness from dependency readiness', async () => {
    app = buildApp();
    const unavailable = await app.inject({ method: 'GET', url: '/ready' });
    await app.close();

    app = buildApp({ judgeRead: judgeRead() });
    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ status: 'not-ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      dependencies: { database: 'ready', network: 'devnet' },
      status: 'ready',
    });
    expect(ready.headers['x-request-id']).toBeTruthy();
  });

  it('publishes a secret-free OpenAPI contract for every judge workflow', async () => {
    app = buildApp({ judgeRead: judgeRead() });

    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    const contract = response.json();

    expect(response.statusCode).toBe(200);
    expect(Object.keys(contract.paths)).toEqual(
      expect.arrayContaining([
        '/health',
        '/ready',
        '/v1/fixtures',
        '/v1/fixtures/{id}/timeline',
        '/v1/markets/{id}/consensus',
        '/v1/decisions',
        '/v1/decision-receipts/{receiptId}',
        '/v1/simulated-orders',
        '/v1/replays/seeded',
        '/v1/realtime',
      ]),
    );
    expect(response.body).not.toContain('apiToken');
    expect(response.body).not.toContain('DATABASE_URL');
  });

  it('accepts bounded timeline pagination and rejects unknown query fields', async () => {
    let received: unknown;
    app = buildApp({
      judgeRead: judgeRead({
        listTimeline: async (input) => {
          received = input;
          return [];
        },
      }),
    });

    const timeline = await app.inject({
      method: 'GET',
      url: '/v1/fixtures/fixture-1/timeline?beforeMs=123&limit=5',
    });
    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/fixtures?unknown=true',
    });

    expect(timeline.statusCode).toBe(200);
    expect(received).toEqual({ beforeMs: 123, fixtureId: 'fixture-1', limit: 5 });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('applies the configured browser origin allowlist', async () => {
    app = buildApp({ corsOrigin: ['https://lagshield.example'] });

    const allowed = await app.inject({
      headers: { origin: 'https://lagshield.example' },
      method: 'GET',
      url: '/health',
    });
    const denied = await app.inject({
      headers: { origin: 'https://malicious.example' },
      method: 'GET',
      url: '/health',
    });

    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://lagshield.example',
    );
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
