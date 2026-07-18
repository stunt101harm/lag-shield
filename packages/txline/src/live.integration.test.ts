import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { TxLineApiClient, type TxLineStreamKind } from './client.js';
import { getTxLineConfig } from './config.js';
import { TxLineApiError } from './errors.js';
import { TxLineStreamSupervisor, type StreamIngestObservation } from './live.js';

const encoder = new TextEncoder();
const servers: ReturnType<typeof createServer>[] = [];
const clock = { nowMs: () => Date.now() };

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function waitFor(assertion: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('TxLineStreamSupervisor', () => {
  it('recovers a forced disconnect, resumes by ID, and never redispatches a duplicate', async () => {
    let streamRequests = 0;
    const resumeHeaders: Array<string | undefined> = [];
    const apiOrigin = await startServer((request, response) => {
      if (request.url === '/auth/guest/start') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ token: 'guest-jwt' }));
        return;
      }
      if (request.url !== '/api/odds/stream') {
        response.statusCode = 404;
        response.end();
        return;
      }
      streamRequests += 1;
      resumeHeaders.push(
        typeof request.headers['last-event-id'] === 'string'
          ? request.headers['last-event-id']
          : undefined,
      );
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(': heartbeat\r\n\r\n');
      if (streamRequests === 1) {
        response.write('id: event-1\r\ndata: {"FixtureId":42,"Ts":');
        response.end(`${Date.now() - 20}}\r\n\r\n`);
        return;
      }
      response.write(`id: event-1\ndata: {"FixtureId":42,"Ts":${Date.now() - 10}}\n\n`);
      response.write('id: malformed\ndata: {not-json}\n\n');
      response.write(`id: event-2\ndata: {"FixtureId":43,"Ts":${Date.now() - 5}}\n\n`);
    });
    const client = new TxLineApiClient({
      apiToken: 'activated-token',
      config: { ...getTxLineConfig('devnet'), apiOrigin },
    });
    const persistedIds = new Set<string>();
    let strategyDispatches = 0;
    const supervisor = new TxLineStreamSupervisor({
      client,
      clock,
      config: {
        backoffBaseMs: 1,
        backoffJitterRatio: 0,
        backoffMaximumMs: 5,
        connectionTimeoutMs: 500,
        heartbeatTimeoutMs: 500,
      },
      kind: 'odds',
      onMessage: async (message) => {
        let payload: { FixtureId: number; Ts: number };
        try {
          payload = JSON.parse(message.data) as { FixtureId: number; Ts: number };
        } catch {
          return [{ fixtureId: null, sourceTimestampMs: null, status: 'quarantined' }];
        }
        const duplicate = persistedIds.has(message.id);
        persistedIds.add(message.id);
        if (!duplicate) strategyDispatches += 1;
        return [
          {
            fixtureId: String(payload.FixtureId),
            sourceTimestampMs: payload.Ts,
            status: duplicate ? 'duplicate' : 'inserted',
          },
        ];
      },
      random: () => 0.5,
    });

    supervisor.start();
    await waitFor(
      () => strategyDispatches === 2 && supervisor.snapshot().quarantineCount >= 1,
    );
    await supervisor.stop();

    expect(streamRequests).toBeGreaterThanOrEqual(2);
    expect(resumeHeaders[0]).toBeUndefined();
    expect(resumeHeaders[1]).toBe('event-1');
    expect(strategyDispatches).toBe(2);
    expect(supervisor.snapshot()).toMatchObject({
      acceptedCount: 2,
      duplicateCount: 1,
      quarantineCount: 1,
      state: 'stopped',
      trackedFixtureIds: ['42', '43'],
    });
    expect(supervisor.snapshot().reconnectCount).toBeGreaterThanOrEqual(1);
    expect(supervisor.snapshot().streamLagMs).not.toBeNull();
  });

  it('exposes an actionable 403 diagnostic while retrying with bounded backoff', async () => {
    const client = {
      openDataStream: async (_kind: TxLineStreamKind) => {
        void _kind;
        throw new TxLineApiError({
          message: 'denied',
          operation: 'scores stream connection',
          status: 403,
        });
      },
    };
    const supervisor = new TxLineStreamSupervisor({
      client,
      clock,
      config: {
        backoffBaseMs: 5,
        backoffJitterRatio: 0,
        backoffMaximumMs: 5,
        connectionTimeoutMs: 100,
        heartbeatTimeoutMs: 100,
      },
      kind: 'scores',
      onMessage: async () => [],
      random: () => 0.5,
    });

    supervisor.start();
    await waitFor(() => supervisor.snapshot().reconnectCount > 0);
    expect(supervisor.snapshot()).toMatchObject({
      lastDiagnostic:
        'subscription_denied: verify API token, network, subscription, and league bundle',
      state: 'backoff',
    });
    await supervisor.stop();
  });

  it('applies zero-length user-space backpressure and drains in-flight persistence on stop', async () => {
    let releasePersistence: (() => void) | undefined;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    let callbackCount = 0;
    let persistenceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      persistenceStarted = resolve;
    });
    const client = {
      openDataStream: async (
        _kind: TxLineStreamKind,
        options: Readonly<{ signal?: AbortSignal }> = {},
      ) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              options.signal?.addEventListener(
                'abort',
                () => controller.error(new DOMException('Aborted', 'AbortError')),
                { once: true },
              );
              controller.enqueue(
                encoder.encode('id: one\ndata: {}\n\nid: two\ndata: {}\n\n'),
              );
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    };
    const observation: StreamIngestObservation = {
      fixtureId: '42',
      sourceTimestampMs: Date.now(),
      status: 'inserted',
    };
    const supervisor = new TxLineStreamSupervisor({
      client,
      clock,
      config: {
        backoffBaseMs: 1,
        backoffJitterRatio: 0,
        backoffMaximumMs: 1,
        connectionTimeoutMs: 100,
        heartbeatTimeoutMs: 1_000,
      },
      kind: 'scores',
      onMessage: async () => {
        callbackCount += 1;
        persistenceStarted?.();
        await persistenceGate;
        return [observation];
      },
    });

    supervisor.start();
    await started;
    expect(callbackCount).toBe(1);
    let stopped = false;
    const stopPromise = supervisor.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    expect(callbackCount).toBe(1);
    releasePersistence?.();
    await stopPromise;
    expect(callbackCount).toBe(1);
  });
});
