import { describe, expect, it } from 'vitest';

import { OperationalMetrics } from './operational-metrics.js';

describe('OperationalMetrics', () => {
  it('counts requests, errors, latency, and active work without high-cardinality labels', () => {
    let nowMs = 1_000;
    const metrics = new OperationalMetrics(() => nowMs);
    const finishClientError = metrics.startRequest();
    const finishServerError = metrics.startRequest();

    expect(metrics.snapshot().requests.active).toBe(2);
    nowMs = 1_025;
    finishClientError(404);
    finishClientError(500);
    nowMs = 1_060;
    finishServerError(503);

    expect(metrics.snapshot()).toMatchObject({
      process: { uptimeMs: 60 },
      requests: {
        active: 0,
        clientErrors: 1,
        maximumDurationMs: 60,
        serverErrors: 1,
        total: 2,
        totalDurationMs: 85,
      },
      startedAtMs: 1_000,
    });
  });
});
