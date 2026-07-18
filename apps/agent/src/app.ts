import fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  decisionReceiptSchema,
  marketOrderRequestSchema,
  simulatedMarketControlAdapter,
  type JsonValue,
  type MarketControlPort,
  type StrategyEvaluationReport,
} from '@lagshield/core';
import { z, ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import type { OutgoingHttpHeaders } from 'node:http';

import { IdempotencyConflictError } from './db/domain-store.js';
import { MarketNotInitializedError } from './db/market-control.js';
import type { PostgresJudgeReadStore } from './db/judge-read-store.js';
import type { LiveIngestionSnapshot } from './ingest/live-txline.js';
import type {
  RetentionWorkerSnapshot,
  StartupRecoverySnapshot,
} from './operations/maintenance.js';
import type { OperationalMetricsPort } from './operations/operational-metrics.js';
import type { DecisionProofWorkerSnapshot } from './proof/decision-proof-service.js';
import type { RealtimeEventHub } from './realtime/event-hub.js';
import {
  ReplayControlConflictError,
  type ReplayControlService,
} from './replay/replay-control.js';

export interface DecisionReceiptReader {
  load(receiptId: string): Promise<Readonly<{
    proofMaterial: JsonValue | null;
    receipt: unknown;
  }> | null>;
}

export type JudgeReadPort = Pick<
  PostgresJudgeReadStore,
  | 'listDecisions'
  | 'listFixtures'
  | 'listMarkets'
  | 'listOrders'
  | 'listReceipts'
  | 'listReplayRuns'
  | 'listTimeline'
  | 'loadFixture'
  | 'marketConsensus'
  | 'overview'
  | 'readiness'
>;

export type ReplayControlPort = Pick<
  ReplayControlService,
  'activeSnapshot' | 'control' | 'snapshot' | 'startSeeded'
>;

export type BuildAppOptions = Readonly<{
  bodyLimitBytes?: number;
  corsOrigin?: boolean | string | readonly string[];
  evaluationReport?: StrategyEvaluationReport;
  getLiveIngestionSnapshot?: () => LiveIngestionSnapshot | null;
  getMaintenanceSnapshot?: () => Readonly<{
    retention: RetentionWorkerSnapshot | null;
    startupRecovery: StartupRecoverySnapshot | null;
  }>;
  getOperationalReadiness?: () => Readonly<{
    credentials: 'configured' | 'disabled';
    liveIngestion: 'configured' | 'disabled';
    network: 'devnet' | 'mainnet';
  }>;
  getProofVerificationSnapshot?: () => DecisionProofWorkerSnapshot | null;
  judgeRead?: JudgeReadPort;
  logger?:
    | boolean
    | {
        level: string;
        redact?: { censor: string; paths: string[] };
      };
  marketControl?: MarketControlPort;
  operationalMetrics?: OperationalMetricsPort;
  productionMode?: boolean;
  rateLimitMax?: number;
  realtime?: RealtimeEventHub;
  receiptReader?: DecisionReceiptReader;
  replayControl?: ReplayControlPort;
}>;

const identifierSchema = z.string().min(1).max(512);
const limitSchema = z.coerce.number().int().min(1).max(100).default(50);
const listQuerySchema = z.object({
  fixtureId: identifierSchema.optional(),
  limit: limitSchema,
  marketId: identifierSchema.optional(),
  namespace: z.string().min(1).max(1_024).optional(),
  status: z.string().min(1).max(100).optional(),
});
const identifierParameterJsonSchema = {
  additionalProperties: false,
  properties: { id: { maxLength: 512, minLength: 1, type: 'string' } },
  required: ['id'],
  type: 'object',
} as const;
const receiptParameterJsonSchema = {
  additionalProperties: false,
  properties: { receiptId: { maxLength: 512, minLength: 1, type: 'string' } },
  required: ['receiptId'],
  type: 'object',
} as const;
const listQueryJsonSchema = {
  additionalProperties: false,
  properties: {
    fixtureId: { maxLength: 512, minLength: 1, type: 'string' },
    limit: { default: 50, maximum: 100, minimum: 1, type: 'integer' },
    marketId: { maxLength: 512, minLength: 1, type: 'string' },
    namespace: { maxLength: 1_024, minLength: 1, type: 'string' },
    status: { maxLength: 100, minLength: 1, type: 'string' },
  },
  type: 'object',
} as const;
const timelineQueryJsonSchema = {
  additionalProperties: false,
  properties: {
    beforeMs: { minimum: 0, type: 'integer' },
    limit: { default: 100, maximum: 200, minimum: 1, type: 'integer' },
  },
  type: 'object',
} as const;
const simulatedOrderJsonSchema = {
  additionalProperties: false,
  properties: {
    expectedDecisionId: { minLength: 1, type: 'string' },
    expectedStateVersion: { minimum: 0, type: 'integer' },
    fixtureId: { minLength: 1, type: 'string' },
    idempotencyKey: { maxLength: 2_048, minLength: 1, type: 'string' },
    marketId: { minLength: 1, type: 'string' },
    namespace: {
      anyOf: [
        { const: 'live' },
        { pattern: '^replay:[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$', type: 'string' },
      ],
    },
    outcomeId: { minLength: 1, type: 'string' },
    payloadVersion: { const: 1 },
    price: { type: 'integer' },
    quoteObservedAtMs: { minimum: 0, type: 'integer' },
    requestedAtMs: { minimum: 0, type: 'integer' },
    side: { enum: ['back', 'lay'] },
    stakeMicros: { exclusiveMinimum: 0, type: 'integer' },
  },
  required: [
    'expectedDecisionId',
    'expectedStateVersion',
    'fixtureId',
    'idempotencyKey',
    'marketId',
    'namespace',
    'outcomeId',
    'payloadVersion',
    'price',
    'quoteObservedAtMs',
    'requestedAtMs',
    'side',
    'stakeMicros',
  ],
  type: 'object',
} as const;

function sseFrame(
  event: Readonly<{
    id: string;
    payload: JsonValue;
    topic: string;
  }>,
): string {
  return `id: ${event.id}\nevent: ${event.topic}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = fastify({
    ajv: { customOptions: { removeAdditional: false } },
    bodyLimit: options.bodyLimitBytes ?? 65_536,
    logger: options.logger ?? false,
  });
  const corsOrigin =
    typeof options.corsOrigin === 'object'
      ? [...options.corsOrigin]
      : (options.corsOrigin ?? false);

  void app.register(cors, {
    origin: corsOrigin,
  });
  void app.register(rateLimit, {
    max: options.rateLimitMax ?? 300,
    timeWindow: '1 minute',
  });
  void app.register(swagger, {
    openapi: {
      info: {
        description:
          'Judge-testable API for LagShield live ingestion, deterministic replay, market control, and TxLINE proof receipts.',
        title: 'LagShield Agent API',
        version: '0.1.0',
      },
      tags: [
        { name: 'system' },
        { name: 'markets' },
        { name: 'decisions' },
        { name: 'evaluation' },
        { name: 'replay' },
      ],
    },
  });
  void app.register(swaggerUi, {
    routePrefix: '/docs',
    staticCSP: true,
  });

  app.after(() => {
    const requestFinishes = new WeakMap<object, (statusCode: number) => void>();

    app.addHook('onRequest', async (request) => {
      const finish = options.operationalMetrics?.startRequest();
      if (!finish) return;
      requestFinishes.set(request.raw, finish);
      request.raw.once('aborted', () => {
        finish(499);
        requestFinishes.delete(request.raw);
      });
    });

    app.addHook('onResponse', async (request, reply) => {
      requestFinishes.get(request.raw)?.(reply.statusCode);
      requestFinishes.delete(request.raw);
    });

    app.addHook('onSend', async (request, reply, payload) => {
      void reply.header('x-request-id', request.id);
      void reply.header('x-content-type-options', 'nosniff');
      void reply.header('x-frame-options', 'DENY');
      void reply.header('referrer-policy', 'no-referrer');
      void reply.header('permissions-policy', 'camera=(), geolocation=(), microphone=()');
      if (!request.url.startsWith('/docs')) {
        void reply.header(
          'content-security-policy',
          "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        );
        void reply.header('cache-control', 'no-store');
      }
      if (options.productionMode) {
        void reply.header(
          'strict-transport-security',
          'max-age=31536000; includeSubDomains',
        );
      }
      return payload;
    });

    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ZodError) {
        void reply.code(400).send({
          code: 'INVALID_REQUEST',
          issues: error.issues.map(({ message, path }) => ({ message, path })),
          requestId: request.id,
        });
        return;
      }
      if (error instanceof ReplayControlConflictError) {
        void reply.code(409).send({
          code: 'REPLAY_CONFLICT',
          message: error.message,
          requestId: request.id,
        });
        return;
      }
      const statusCode =
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        typeof error.statusCode === 'number'
          ? error.statusCode
          : 500;
      if (statusCode >= 500) {
        request.log.error(
          { err: error, requestId: request.id },
          'Agent API request failed',
        );
      }
      const invalidRequest = statusCode >= 400 && statusCode < 500 && statusCode !== 429;
      void reply.code(statusCode).send({
        code:
          statusCode === 429
            ? 'RATE_LIMITED'
            : invalidRequest
              ? 'INVALID_REQUEST'
              : 'INTERNAL_ERROR',
        message:
          statusCode === 429
            ? 'Public API rate limit exceeded.'
            : invalidRequest
              ? 'The request does not match the public API contract.'
              : 'The agent could not complete this request.',
        requestId: request.id,
      });
    });

    app.setNotFoundHandler((request, reply) =>
      reply.code(404).send({
        code: 'NOT_FOUND',
        requestId: request.id,
      }),
    );

    app.get(
      '/health',
      { schema: { summary: 'Process liveness', tags: ['system'] } },
      async () => ({
        service: 'lagshield-agent',
        status: 'ok',
        version: '0.1.0',
      }),
    );

    app.get(
      '/ready',
      { schema: { summary: 'Dependency readiness', tags: ['system'] } },
      async (_request, reply) => {
        if (!options.judgeRead) {
          return reply.code(503).send({
            dependencies: { database: 'disabled' },
            status: 'not-ready',
          });
        }
        try {
          const database = await options.judgeRead.readiness();
          return {
            dependencies: {
              ...database,
              ...(options.getOperationalReadiness?.() ?? {
                credentials: 'disabled',
                liveIngestion: 'disabled',
                network: 'devnet',
              }),
              proofs: options.getProofVerificationSnapshot?.() ?? null,
              streams: options.getLiveIngestionSnapshot?.() ?? null,
            },
            status: 'ready',
          };
        } catch {
          return reply.code(503).send({
            dependencies: { database: 'unavailable' },
            status: 'not-ready',
          });
        }
      },
    );

    app.get(
      '/openapi.json',
      { schema: { summary: 'OpenAPI 3.0 contract', tags: ['system'] } },
      async () => app.swagger(),
    );

    app.get('/metrics/streams', async () => {
      const snapshot = options.getLiveIngestionSnapshot?.() ?? null;
      return snapshot ? { enabled: true, ...snapshot } : { enabled: false };
    });

    app.get('/metrics/proofs', async () => {
      const snapshot = options.getProofVerificationSnapshot?.() ?? null;
      return snapshot ? { enabled: true, ...snapshot } : { enabled: false };
    });

    app.get('/metrics/realtime', async () => ({
      enabled: options.realtime !== undefined,
      ...(options.realtime?.snapshot() ?? {}),
    }));

    app.get(
      '/metrics/operations',
      {
        schema: {
          summary: 'Secret-free process, request, and maintenance telemetry',
          tags: ['system'],
        },
      },
      async () => ({
        maintenance: options.getMaintenanceSnapshot?.() ?? {
          retention: null,
          startupRecovery: null,
        },
        process: options.operationalMetrics?.snapshot() ?? null,
      }),
    );

    app.get(
      '/v1/overview',
      { schema: { summary: 'Operator overview', tags: ['system'] } },
      async (_request, reply) => {
        if (!options.judgeRead) {
          return reply.code(503).send({ code: 'READ_MODEL_DISABLED' });
        }
        return options.judgeRead.overview();
      },
    );

    app.get<{ Querystring: Record<string, string | undefined> }>(
      '/v1/fixtures',
      {
        schema: {
          querystring: listQueryJsonSchema,
          summary: 'List World Cup fixtures',
          tags: ['markets'],
        },
      },
      async (request, reply) => {
        if (!options.judgeRead) {
          return reply.code(503).send({ code: 'READ_MODEL_DISABLED' });
        }
        const query = listQuerySchema.parse(request.query);
        const items = await options.judgeRead.listFixtures({
          limit: query.limit,
          ...(query.status ? { status: query.status } : {}),
        });
        return { items };
      },
    );

    app.get<{ Params: { id: string } }>(
      '/v1/fixtures/:id',
      {
        schema: {
          params: identifierParameterJsonSchema,
          summary: 'Load fixture command-center snapshot',
          tags: ['markets'],
        },
      },
      async (request, reply) => {
        if (!options.judgeRead) {
          return reply.code(503).send({ code: 'READ_MODEL_DISABLED' });
        }
        const { id } = z.object({ id: identifierSchema }).parse(request.params);
        const fixture = await options.judgeRead.loadFixture(id);
        return fixture ?? reply.code(404).send({ code: 'FIXTURE_NOT_FOUND', id });
      },
    );

    app.get<{
      Params: { id: string };
      Querystring: Record<string, string | undefined>;
    }>(
      '/v1/fixtures/:id/timeline',
      {
        schema: {
          params: identifierParameterJsonSchema,
          querystring: timelineQueryJsonSchema,
          summary: 'List score and decision timeline',
          tags: ['markets', 'decisions'],
        },
      },
      async (request, reply) => {
        if (!options.judgeRead) {
          return reply.code(503).send({ code: 'READ_MODEL_DISABLED' });
        }
        const { id } = z.object({ id: identifierSchema }).parse(request.params);
        const query = z
          .object({
            beforeMs: z.coerce.number().int().nonnegative().safe().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(100),
          })
          .parse(request.query);
        return {
          items: await options.judgeRead.listTimeline({
            fixtureId: id,
            limit: query.limit,
            ...(query.beforeMs === undefined ? {} : { beforeMs: query.beforeMs }),
          }),
        };
      },
    );

    app.get<{ Params: { id: string } }>(
      '/v1/markets/:id/consensus',
      {
        schema: {
          params: identifierParameterJsonSchema,
          summary: 'Compute current deterministic consensus',
          tags: ['markets'],
        },
      },
      async (request, reply) => {
        if (!options.judgeRead) {
          return reply.code(503).send({ code: 'READ_MODEL_DISABLED' });
        }
        const { id } = z.object({ id: identifierSchema }).parse(request.params);
        const consensus = await options.judgeRead.marketConsensus(id);
        return consensus ?? reply.code(404).send({ code: 'MARKET_NOT_FOUND', id });
      },
    );

    app.get<{ Querystring: Record<string, string | undefined> }>(
      '/v1/decisions',
      {
        schema: {
          querystring: listQueryJsonSchema,
          summary: 'List strategy decisions',
          tags: ['decisions'],
        },
      },
      async (request, reply) => {
        if (!options.judgeRead) {
          return reply.code(503).send({ code: 'READ_MODEL_DISABLED' });
        }
        const query = listQuerySchema.parse(request.query);
        return {
          items: await options.judgeRead.listDecisions({
            limit: query.limit,
            ...(query.fixtureId ? { fixtureId: query.fixtureId } : {}),
            ...(query.marketId ? { marketId: query.marketId } : {}),
          }),
        };
      },
    );

    app.get<{ Querystring: Record<string, string | undefined> }>(
      '/v1/decision-receipts',
      {
        schema: {
          querystring: listQueryJsonSchema,
          summary: 'List decision receipt proof states',
          tags: ['decisions'],
        },
      },
      async (request, reply) => {
        if (!options.judgeRead) {
          return reply.code(503).send({ code: 'READ_MODEL_DISABLED' });
        }
        const query = listQuerySchema.parse(request.query);
        return {
          items: await options.judgeRead.listReceipts({
            limit: query.limit,
            ...(query.fixtureId ? { fixtureId: query.fixtureId } : {}),
            ...(query.status ? { status: query.status } : {}),
          }),
        };
      },
    );

    app.get<{ Params: { receiptId: string } }>(
      '/v1/decision-receipts/:receiptId',
      {
        schema: {
          params: receiptParameterJsonSchema,
          summary: 'Load canonical decision evidence and TxLINE proof state',
          tags: ['decisions'],
        },
      },
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

    app.get<{ Querystring: Record<string, string | undefined> }>(
      '/v1/simulated-orders',
      {
        schema: {
          querystring: listQueryJsonSchema,
          summary: 'List simulated order admissions',
          tags: ['decisions'],
        },
      },
      async (request, reply) => {
        if (!options.judgeRead) {
          return reply.code(503).send({ code: 'READ_MODEL_DISABLED' });
        }
        const query = listQuerySchema.parse(request.query);
        return {
          items: await options.judgeRead.listOrders({
            limit: query.limit,
            ...(query.fixtureId ? { fixtureId: query.fixtureId } : {}),
            ...(query.namespace ? { namespace: query.namespace } : {}),
            ...(query.status ? { status: query.status } : {}),
          }),
        };
      },
    );

    app.get<{ Querystring: Record<string, string | undefined> }>(
      '/v1/replays',
      {
        schema: {
          querystring: listQueryJsonSchema,
          summary: 'List deterministic replay runs',
          tags: ['replay'],
        },
      },
      async (request, reply) => {
        if (!options.judgeRead) {
          return reply.code(503).send({ code: 'READ_MODEL_DISABLED' });
        }
        const { limit } = listQuerySchema.parse(request.query);
        return { items: await options.judgeRead.listReplayRuns({ limit }) };
      },
    );

    app.get(
      '/v1/evaluations/seeded',
      {
        schema: {
          summary: 'Load the deterministic seeded strategy evaluation',
          tags: ['evaluation'],
        },
      },
      async (_request, reply) =>
        options.evaluationReport ??
        reply.code(503).send({ code: 'EVALUATION_REPORT_DISABLED' }),
    );

    app.get(
      '/v1/replays/active',
      { schema: { summary: 'Load active replay state', tags: ['replay'] } },
      async (_request, reply) => {
        const snapshot = options.replayControl?.activeSnapshot() ?? null;
        return snapshot ?? reply.code(404).send({ code: 'NO_ACTIVE_REPLAY' });
      },
    );

    app.post(
      '/v1/replays/seeded',
      {
        schema: {
          body: {
            additionalProperties: false,
            properties: {
              runId: { maxLength: 512, minLength: 1, type: 'string' },
              speed: {
                anyOf: [
                  { exclusiveMinimum: 0, type: 'number' },
                  { const: 'maximum', type: 'string' },
                ],
              },
            },
            type: 'object',
          },
          summary: 'Start the deterministic seeded judge replay',
          tags: ['replay'],
        },
      },
      async (request, reply) => {
        if (!options.replayControl) {
          return reply.code(503).send({ code: 'REPLAY_CONTROL_DISABLED' });
        }
        const body = z
          .object({
            runId: identifierSchema.optional(),
            speed: z
              .union([z.number().positive().finite(), z.literal('maximum')])
              .default(10),
          })
          .strict()
          .parse(request.body ?? {});
        const snapshot = await options.replayControl.startSeeded({
          runId: body.runId ?? `judge-${randomUUID()}`,
          speed: body.speed,
        });
        return reply.code(202).send(snapshot);
      },
    );

    app.post<{ Params: { id: string } }>(
      '/v1/replays/:id/actions',
      {
        schema: {
          body: {
            additionalProperties: false,
            properties: { action: { enum: ['pause', 'resume', 'stop'] } },
            required: ['action'],
            type: 'object',
          },
          params: identifierParameterJsonSchema,
          summary: 'Pause, resume, or stop the active replay',
          tags: ['replay'],
        },
      },
      async (request, reply) => {
        if (!options.replayControl) {
          return reply.code(503).send({ code: 'REPLAY_CONTROL_DISABLED' });
        }
        const { id } = z.object({ id: identifierSchema }).parse(request.params);
        const { action } = z
          .object({ action: z.enum(['pause', 'resume', 'stop']) })
          .strict()
          .parse(request.body);
        return options.replayControl.control(id, action);
      },
    );

    app.get<{ Querystring: { after?: string } }>(
      '/v1/realtime',
      {
        config: { rateLimit: false },
        schema: {
          querystring: {
            additionalProperties: false,
            properties: { after: { pattern: '^\\d+$', type: 'string' } },
            type: 'object',
          },
          summary: 'Resumable realtime decision and replay stream',
          tags: ['system'],
        },
      },
      async (request, reply) => {
        if (!options.realtime) {
          return reply.code(503).send({ code: 'REALTIME_DISABLED' });
        }
        const header = request.headers['last-event-id'];
        const afterId = z
          .string()
          .regex(/^\d+$/)
          .optional()
          .parse(typeof header === 'string' ? header : request.query.after);
        const responseHeaders: OutgoingHttpHeaders = {
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Content-Security-Policy':
            "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
          'Referrer-Policy': 'no-referrer',
          'X-Accel-Buffering': 'no',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'X-Request-Id': request.id,
        };
        if (options.productionMode) {
          responseHeaders['Strict-Transport-Security'] =
            'max-age=31536000; includeSubDomains';
        }
        for (const name of [
          'access-control-allow-credentials',
          'access-control-allow-origin',
          'access-control-expose-headers',
          'vary',
        ]) {
          const value = reply.getHeader(name);
          if (value !== undefined) responseHeaders[name] = value;
        }
        reply.hijack();
        reply.raw.writeHead(200, responseHeaders);
        reply.raw.write(': lagshield-realtime\n\n');
        const unsubscribe = options.realtime.subscribe({
          ...(afterId ? { afterId } : {}),
          onEvent: (event) => reply.raw.write(sseFrame(event)),
        });
        const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
        heartbeat.unref();
        request.raw.once('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return reply;
      },
    );

    app.get(
      '/v1/simulated-market-control',
      {
        schema: {
          summary: 'Describe the fail-closed simulated execution adapter',
          tags: ['decisions'],
        },
      },
      async () => ({
        adapter: simulatedMarketControlAdapter,
        enabled: options.marketControl !== undefined,
        realMoney: false,
      }),
    );

    app.post(
      '/v1/simulated-orders',
      {
        schema: {
          body: simulatedOrderJsonSchema,
          summary: 'Submit an order to the deterministic simulated market gate',
          tags: ['decisions'],
        },
      },
      async (request, reply) => {
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
          if (result.persistenceStatus === 'inserted') {
            options.realtime?.publish('order.committed', result);
            request.log.info(
              {
                admissionReasonCode: result.order.admissionReasonCode,
                decisionId: result.order.decisionId,
                fixtureId: result.order.fixtureId,
                marketId: result.order.marketId,
                orderId: result.order.orderId,
                requestId: request.id,
                status: result.order.status,
              },
              'Simulated order decision committed',
            );
          }
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
      },
    );
  });
  return app;
}
