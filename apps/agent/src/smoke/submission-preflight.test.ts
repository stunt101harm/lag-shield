import { describe, expect, it, vi } from 'vitest';

import {
  runSubmissionPreflight,
  submissionPreflightEnvironmentSchema,
} from './submission-preflight.js';

const apiUrl = 'https://agent.example.com';
const webUrl = 'https://app.example.com';
const videoUrl = 'https://video.example.com/watch';
const repositoryUrl = 'https://github.com/stunt101harm/lag-shield';

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status: 200,
  });
}

function successfulFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  void init;
  const url = String(input);
  if (url === webUrl) {
    return Promise.resolve(
      new Response('<html><title>LagShield</title></html>', {
        headers: { 'content-type': 'text/html' },
      }),
    );
  }
  if (url === `${apiUrl}/health`) {
    return Promise.resolve(
      json(
        { service: 'lagshield-agent', status: 'ok' },
        { 'access-control-allow-origin': webUrl },
      ),
    );
  }
  if (url === `${apiUrl}/ready`) {
    return Promise.resolve(
      json({
        dependencies: {
          credentials: 'configured',
          database: 'ready',
          liveIngestion: 'configured',
        },
        status: 'ready',
      }),
    );
  }
  if (url === `${apiUrl}/metrics/streams`) {
    return Promise.resolve(
      json({
        enabled: true,
        odds: { state: 'connected' },
        scores: { state: 'connected' },
      }),
    );
  }
  if (url === `${apiUrl}/metrics/proofs`) {
    return Promise.resolve(json({ enabled: true }));
  }
  if (url === `${apiUrl}/openapi.json`) {
    return Promise.resolve(json({ openapi: '3.0.3' }));
  }
  if (url === `${apiUrl}/docs`) {
    return Promise.resolve(
      new Response('<html>Swagger UI</html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
  }
  if (url === `${apiUrl}/v1/evaluations/seeded`) {
    return Promise.resolve(
      json({ dataMode: 'seeded-simulation', evaluationHash: 'a'.repeat(64) }),
    );
  }
  if (url === repositoryUrl || url === videoUrl) {
    return Promise.resolve(new Response(null, { status: 200 }));
  }
  return Promise.resolve(new Response(null, { status: 404 }));
}

const environment = submissionPreflightEnvironmentSchema.parse({
  LAGSHIELD_API_URL: apiUrl,
  LAGSHIELD_DEMO_VIDEO_URL: videoUrl,
  LAGSHIELD_WEB_URL: webUrl,
});

describe('submission preflight', () => {
  it('checks every public artifact, live TxLINE, CORS, and the judge flow', async () => {
    const judgeFlow = vi.fn().mockResolvedValue({
      finalState: 'OPEN',
      orderId: 'order-1',
      orderStatus: 'rejected',
      progress: 8,
      receiptId: 'receipt-1',
      runId: 'judge-1',
    });

    const result = await runSubmissionPreflight(environment, {
      fetch: successfulFetch as typeof fetch,
      judgeFlow,
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map(({ name }) => name)).toEqual([
      'public-command-center',
      'agent-health-and-cors',
      'agent-readiness',
      'txline-stream-supervisors',
      'proof-worker',
      'openapi-contract',
      'swagger-ui',
      'seeded-evaluation',
      'public-repository',
      'public-demo-video',
    ]);
    expect(result.judgeFlow).toMatchObject({
      finalState: 'OPEN',
      orderStatus: 'rejected',
    });
    expect(judgeFlow).toHaveBeenCalledWith(apiUrl);
  });

  it('fails when live TxLINE is configured but both supervisors are not connected', async () => {
    const fetchWithBackoff = (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === `${apiUrl}/metrics/streams`) {
        return Promise.resolve(
          json({
            enabled: true,
            odds: { state: 'connected' },
            scores: { state: 'backoff' },
          }),
        );
      }
      return successfulFetch(input, init);
    };

    await expect(
      runSubmissionPreflight(environment, {
        fetch: fetchWithBackoff as typeof fetch,
        judgeFlow: vi.fn(),
      }),
    ).rejects.toThrow('odds=connected, scores=backoff');
  });

  it('requires the exact public web origin in CORS', async () => {
    const fetchWithBadCors = (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === `${apiUrl}/health`) {
        return Promise.resolve(
          json(
            { service: 'lagshield-agent', status: 'ok' },
            { 'access-control-allow-origin': 'https://wrong.example.com' },
          ),
        );
      }
      return successfulFetch(input, init);
    };

    await expect(
      runSubmissionPreflight(environment, {
        fetch: fetchWithBadCors as typeof fetch,
        judgeFlow: vi.fn(),
      }),
    ).rejects.toThrow('exact public web origin');
  });
});
