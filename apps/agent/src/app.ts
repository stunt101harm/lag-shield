import fastify, { type FastifyInstance } from 'fastify';
import {
  marketOrderRequestSchema,
  simulatedMarketControlAdapter,
  type MarketControlPort,
} from '@lagshield/core';
import { ZodError } from 'zod';

import { IdempotencyConflictError } from './db/domain-store.js';
import { MarketNotInitializedError } from './db/market-control.js';
import type { LiveIngestionSnapshot } from './ingest/live-txline.js';

export type BuildAppOptions = Readonly<{
  getLiveIngestionSnapshot?: () => LiveIngestionSnapshot | null;
  logger?: boolean | { level: string };
  marketControl?: MarketControlPort;
}>;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = fastify({
    logger: options.logger ?? false,
  });

  app.get('/health', async () => ({
    service: 'lagshield-agent',
    status: 'ok',
    version: '0.1.0',
  }));

  app.get('/metrics/streams', async () => {
    const snapshot = options.getLiveIngestionSnapshot?.() ?? null;
    return snapshot ? { enabled: true, ...snapshot } : { enabled: false };
  });

  app.get('/v1/simulated-market-control', async () => ({
    adapter: simulatedMarketControlAdapter,
    enabled: options.marketControl !== undefined,
    realMoney: false,
  }));

  app.post('/v1/simulated-orders', async (request, reply) => {
    if (!options.marketControl) {
      return reply.code(503).send({
        adapter: simulatedMarketControlAdapter,
        code: 'SIMULATED_MARKET_CONTROL_DISABLED',
        realMoney: false,
      });
    }
    try {
      const order = marketOrderRequestSchema.parse(request.body);
      const result = await options.marketControl.submitOrder(order);
      return reply.code(result.persistenceStatus === 'inserted' ? 201 : 200).send({
        adapter: simulatedMarketControlAdapter,
        realMoney: false,
        ...result,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({
          code: 'INVALID_SIMULATED_ORDER',
          issues: error.issues.map(({ message, path }) => ({ message, path })),
          realMoney: false,
        });
      }
      if (error instanceof IdempotencyConflictError) {
        return reply.code(409).send({
          code: 'IDEMPOTENCY_CONFLICT',
          message: error.message,
          realMoney: false,
        });
      }
      if (error instanceof MarketNotInitializedError) {
        return reply.code(409).send({
          code: 'MARKET_NOT_INITIALIZED',
          message: error.message,
          realMoney: false,
        });
      }
      throw error;
    }
  });

  return app;
}
