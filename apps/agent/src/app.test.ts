import { afterEach, describe, expect, it } from 'vitest';

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
});
