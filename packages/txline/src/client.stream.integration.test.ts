import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { TxLineApiClient } from './client.js';
import { getTxLineConfig } from './config.js';
import { readSseMessages } from './sse.js';

const servers: ReturnType<typeof createServer>[] = [];

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
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('TxLINE stream client with a local SSE server', () => {
  it('renews a 401 guest JWT, preserves the API token, and opens both streams', async () => {
    const requests: Array<
      Readonly<{ authorization?: string; path?: string; token?: string }>
    > = [];
    let guestRequests = 0;
    const apiOrigin = await startServer((request, response) => {
      if (request.url === '/auth/guest/start') {
        guestRequests += 1;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ token: `guest-${guestRequests}` }));
        return;
      }

      requests.push({
        ...(request.headers.authorization
          ? { authorization: request.headers.authorization }
          : {}),
        ...(request.url ? { path: request.url } : {}),
        ...(typeof request.headers['x-api-token'] === 'string'
          ? { token: request.headers['x-api-token'] }
          : {}),
      });
      if (request.url === '/api/odds/stream' && guestRequests === 1) {
        response.statusCode = 401;
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      response.write(': heartbeat\n\n');
      response.end(
        `event: ${request.url?.includes('odds') ? 'odds' : 'scores'}\n` + 'data: {}\n\n',
      );
    });
    const client = new TxLineApiClient({
      apiToken: 'activated-token',
      config: { ...getTxLineConfig('devnet'), apiOrigin },
    });

    for (const kind of ['odds', 'scores'] as const) {
      const response = await client.openDataStream(kind);
      const messages = [];
      for await (const message of readSseMessages(response.body!)) messages.push(message);
      expect(messages).toEqual([{ data: '{}', event: kind, id: '' }]);
    }

    expect(guestRequests).toBe(2);
    expect(requests.map(({ path }) => path)).toEqual([
      '/api/odds/stream',
      '/api/odds/stream',
      '/api/scores/stream',
    ]);
    expect(requests.map(({ authorization }) => authorization)).toEqual([
      'Bearer guest-1',
      'Bearer guest-2',
      'Bearer guest-2',
    ]);
    expect(requests.every(({ token }) => token === 'activated-token')).toBe(true);
  });

  it('sends Last-Event-ID when resuming a stream', async () => {
    let resumedId: string | undefined;
    const apiOrigin = await startServer((request, response) => {
      if (request.url === '/auth/guest/start') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ token: 'guest' }));
        return;
      }
      resumedId =
        typeof request.headers['last-event-id'] === 'string'
          ? request.headers['last-event-id']
          : undefined;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {}\n\n');
    });
    const client = new TxLineApiClient({
      apiToken: 'activated-token',
      config: { ...getTxLineConfig('devnet'), apiOrigin },
    });

    const response = await client.openDataStream('scores', { lastEventId: 'score-99' });
    await response.body!.cancel();

    expect(resumedId).toBe('score-99');
  });
});
