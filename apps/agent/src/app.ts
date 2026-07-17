import fastify, { type FastifyInstance } from 'fastify';
import {
  decisionReceiptSchema,
  marketOrderRequestSchema,
  simulatedMarketControlAdapter,
  type JsonValue,
  type MarketControlPort,
} from '@lagshield/core';
import { z, ZodError } from 'zod';

import { IdempotencyConflictError } from './db/domain-store.js';
import { MarketNotInitializedError } from './db/market-control.js';
import type { LiveIngestionSnapshot } from './ingest/live-txline.js';
import type { DecisionProofWorkerSnapshot } from './proof/decision-proof-service.js';

export interface DecisionReceiptReader {
  load(receiptId: string): Promise<Readonly<{
    proofMaterial: JsonValue | null;
    receipt: unknown;
  }> | null>;
}

export type BuildAppOptions = Readonly<{
  getLiveIngestionSnapshot?: () => LiveIngestionSnapshot | null;
  getProofVerificationSnapshot?: () => DecisionProofWorkerSnapshot | null;
  logger?: boolean | { level: string };
  marketControl?: MarketControlPort;
  receiptReader?: DecisionReceiptReader;
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

  app.get('/metrics/proofs', async () => {
    const snapshot = options.getProofVerificationSnapshot?.() ?? null;
    return snapshot ? { enabled: true, ...snapshot } : { enabled: false };
  });

  app.get<{ Params: { receiptId: string } }>(
    '/v1/decision-receipts/:receiptId',
    async (request, reply) => {
      if (!options.receiptReader) {
        return reply.code(503).send({
          code: 'DECISION_RECEIPTS_DISABLED',
        });
      }
      const { receiptId } = z
        .object({ receiptId: z.string().min(1).max(512) })
        .parse(request.params);
      const stored = await options.receiptReader.load(receiptId);
      if (!stored) {
        return reply.code(404).send({
          code: 'DECISION_RECEIPT_NOT_FOUND',
          receiptId,
        });
      }
      const receipt = decisionReceiptSchema.parse(stored.receipt);
      return {
        decisionAnchor: {
          algorithm: 'sha256',
          payloadHash: receipt.payloadHash,
          receiptId: receipt.receiptId,
          scope:
            'LagShield strategy decision and its exact persisted TxLINE event provenance',
        },
        proofMaterial: stored.proofMaterial,
        receipt,
        txlineAnchor:
          'verification' in receipt
            ? receipt.verification
            : {
                anchoredAtMs: receipt.anchoredAtMs,
                proofReference: receipt.proofReference,
                status: receipt.status,
              },
      };
    },
  );

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
