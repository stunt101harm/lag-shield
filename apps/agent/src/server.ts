import { SystemClock } from '@lagshield/core';
import { Connection, PublicKey } from '@solana/web3.js';
import { parseAgentEnvironment } from '@lagshield/shared';
import { getTxLineConfig, readCredentialsFile, TxLineApiClient } from '@lagshield/txline';
import { config as loadEnvironment } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from './app.js';
import { createDatabase } from './db/client.js';
import { PostgresDomainStore } from './db/domain-store.js';
import { PostgresEvaluationStore } from './db/evaluation-store.js';
import { PostgresJudgeReadStore } from './db/judge-read-store.js';
import { PostgresSimulatedMarketControl } from './db/market-control.js';
import { PostgresDecisionReceiptStore } from './db/receipt-store.js';
import { PostgresReplayStore } from './db/replay-store.js';
import { createSeededEvaluationReport } from './evaluation/strategy-evaluation.js';
import { LiveTxLineIngestion } from './ingest/live-txline.js';
import { createAgentLoggerOptions } from './operations/logger.js';
import {
  PostgresStartupRecovery,
  RetentionWorker,
  type StartupRecoverySnapshot,
} from './operations/maintenance.js';
import { OperationalMetrics } from './operations/operational-metrics.js';
import {
  DecisionProofService,
  DecisionProofWorker,
} from './proof/decision-proof-service.js';
import { RealtimeEventHub } from './realtime/event-hub.js';
import { ReplayControlService } from './replay/replay-control.js';
import { createSeededDemoBundle } from './replay/seeded-demo.js';

loadEnvironment({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});

const environment = parseAgentEnvironment(process.env);
const clock = new SystemClock();
const database = createDatabase(environment.DATABASE_URL);
const domainStore = new PostgresDomainStore(database.client);
const evaluationStore = new PostgresEvaluationStore(database.client);
const replayStore = new PostgresReplayStore(database.client);
const receiptStore = new PostgresDecisionReceiptStore(database.client);
const realtime = new RealtimeEventHub({ clock });
let structuredLoggerTarget: Readonly<{
  error(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
}> | null = null;
const structuredLoggerProxy = {
  error: (fields: Record<string, unknown>, message: string) =>
    structuredLoggerTarget?.error(fields, message),
  info: (fields: Record<string, unknown>, message: string) =>
    structuredLoggerTarget?.info(fields, message),
};
const replayControl = new ReplayControlService({
  clock,
  domainStore,
  logger: structuredLoggerProxy,
  realtime,
  replayStore,
});
const seededEvaluationReport = createSeededEvaluationReport();
const seededDemoBundle = createSeededDemoBundle();
const operationalMetrics = new OperationalMetrics();
const retentionWorker = new RetentionWorker({
  batchSize: environment.RETENTION_PURGE_BATCH_SIZE,
  clock,
  intervalMs: environment.RETENTION_PURGE_INTERVAL_MS,
  store: domainStore,
});
let liveIngestion: LiveTxLineIngestion | null = null;
let proofWorker: DecisionProofWorker | null = null;
let startupRecoverySnapshot: StartupRecoverySnapshot | null = null;
const app = buildApp({
  bodyLimitBytes: environment.HTTP_BODY_LIMIT_BYTES,
  corsOrigin: environment.PUBLIC_WEB_ORIGIN,
  evaluationReport: seededEvaluationReport,
  getLiveIngestionSnapshot: () => liveIngestion?.snapshot() ?? null,
  getMaintenanceSnapshot: () => ({
    retention: retentionWorker.snapshot(),
    startupRecovery: startupRecoverySnapshot,
  }),
  getOperationalReadiness: () => ({
    credentials: environment.TXLINE_LIVE_ENABLED ? 'configured' : 'disabled',
    liveIngestion: environment.TXLINE_LIVE_ENABLED ? 'configured' : 'disabled',
    network: environment.TXLINE_NETWORK,
  }),
  getProofVerificationSnapshot: () => proofWorker?.snapshot() ?? null,
  judgeRead: new PostgresJudgeReadStore(database.client, clock),
  logger: createAgentLoggerOptions(environment.LOG_LEVEL),
  marketControl: new PostgresSimulatedMarketControl(database.client, { clock }),
  operationalMetrics,
  productionMode: environment.NODE_ENV === 'production',
  rateLimitMax: environment.HTTP_RATE_LIMIT_MAX,
  realtime,
  receiptReader: receiptStore,
  replayControl,
});
structuredLoggerTarget = app.log;
let shutdownPromise: Promise<void> | null = null;

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      app.log.info({ signal }, 'Shutting down LagShield agent');
      await retentionWorker.stop();
      await proofWorker?.stop();
      await liveIngestion?.stop();
      await app.close();
      await database.client.end({ timeout: 5 });
    })();
  }
  await shutdownPromise;
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  startupRecoverySnapshot = await new PostgresStartupRecovery({
    clock,
    sql: database.client,
  }).reconcile();
  app.log.info(startupRecoverySnapshot, 'Startup recovery reconciled replay ownership');
  await replayStore.saveReplayManifest({
    createdAtMs: clock.nowMs(),
    manifest: seededDemoBundle.manifest,
    retentionExpiresAtMs: null,
  });
  await evaluationStore.save(seededEvaluationReport, clock.nowMs());
  await app.listen({ host: environment.HOST, port: environment.PORT });
  retentionWorker.start();
  if (environment.TXLINE_LIVE_ENABLED) {
    const credentials = await readCredentialsFile(
      resolve(environment.TXLINE_CREDENTIALS_FILE),
    );
    if (credentials.network !== environment.TXLINE_NETWORK) {
      throw new Error(
        `TxLINE credential network ${credentials.network} does not match configured network ${environment.TXLINE_NETWORK}.`,
      );
    }
    const txLineConfig = getTxLineConfig(environment.TXLINE_NETWORK, {
      ...(environment.TXLINE_RPC_URL ? { rpcUrl: environment.TXLINE_RPC_URL } : {}),
    });
    const client = new TxLineApiClient({
      apiToken: credentials.apiToken,
      config: txLineConfig,
    });
    liveIngestion = new LiveTxLineIngestion({
      client,
      clock,
      onPersistedEvent: async (event) => {
        realtime.publish('domain-event.committed', event);
        app.log.info(
          {
            eventId: event.eventId,
            fixtureId: event.fixtureId,
            kind: event.kind,
            sourceId: event.sourceId,
          },
          'TxLINE domain event committed',
        );
      },
      store: domainStore,
    });
    await liveIngestion.start();
    proofWorker = new DecisionProofWorker({
      clock,
      intervalMs: environment.TXLINE_PROOF_INTERVAL_MS,
      service: new DecisionProofService({
        client,
        clock,
        config: txLineConfig,
        connection: new Connection(txLineConfig.rpcUrl, 'confirmed'),
        onReceiptUpdated: (receipt) => {
          realtime.publish('proof.updated', receipt);
          app.log.info(
            {
              decisionId: receipt.decisionId,
              fixtureId: receipt.canonicalPayload.decision.fixtureId,
              receiptId: receipt.receiptId,
              verificationStatus: receipt.verification.status,
            },
            'Decision proof lifecycle updated',
          );
        },
        receiptStore,
        simulationPayer: new PublicKey(credentials.walletPublicKey),
      }),
    });
    proofWorker.start();
    app.log.info(
      { network: environment.TXLINE_NETWORK },
      'TxLINE live ingestion and proof verification started',
    );
  }
} catch (error) {
  app.log.error(error, 'Failed to start LagShield agent');
  process.exitCode = 1;
  await retentionWorker.stop().catch(() => undefined);
  await proofWorker?.stop().catch(() => undefined);
  await liveIngestion?.stop().catch(() => undefined);
  await app.close().catch(() => undefined);
  await database.client.end({ timeout: 5 }).catch(() => undefined);
}
