import { SystemClock } from '@lagshield/core';
import {
  TxLineApiClient,
  getTxLineConfig,
  parseTxLineNetwork,
  readCredentialsFile,
} from '@lagshield/txline';
import { config as loadEnvironment } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase } from '../db/client.js';
import { PostgresDomainStore } from '../db/domain-store.js';
import { PostgresReplayStore } from '../db/replay-store.js';
import { TxLineHistoricalHydrator } from './historical-hydrator.js';
import { HistoricalReplayService } from './historical-replay.js';
import { seededDemoStrategyConfiguration } from './seeded-demo.js';

loadEnvironment({
  path: fileURLToPath(new URL('../../../../.env', import.meta.url)),
  quiet: true,
});

const usage = `Usage:
  pnpm replay:hydrate -- \\
    --fixture-id 18241006 --competition-id 72 \\
    --scheduled-at-ms 1784311200000 \\
    --source-start-ms 1784311200000 --source-end-ms 1784318400000

Required environment:
  DATABASE_URL, TXLINE_CREDENTIALS_FILE

Optional:
  --network devnet|mainnet  --run-id ID  --speed NUMBER|maximum
  --raw-retention-hours 24
`;

function argumentsByName(values: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(usage);
    }
    if (parsed.has(name)) throw new Error(`Duplicate argument ${name}.\n${usage}`);
    parsed.set(name, value);
  }
  return parsed;
}

function required(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}.\n${usage}`);
  return value;
}

function integer(args: Map<string, string>, name: string): number {
  const value = Number(required(args, name));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

const args = argumentsByName(process.argv.slice(2));
const network = parseTxLineNetwork(args.get('--network') ?? process.env.TXLINE_NETWORK);
const credentialsPath = resolve(
  args.get('--credentials') ??
    process.env.TXLINE_CREDENTIALS_FILE ??
    `.txline/${network}.credentials.json`,
);
const credentials = await readCredentialsFile(credentialsPath);
if (credentials.network !== network) {
  throw new Error(
    `Credential network ${credentials.network} does not match selected ${network}.`,
  );
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error(`DATABASE_URL is required.\n${usage}`);
const speedArgument = args.get('--speed') ?? 'maximum';
const speed = speedArgument === 'maximum' ? 'maximum' : Number(speedArgument);
if (speed !== 'maximum' && (!Number.isFinite(speed) || speed <= 0)) {
  throw new Error('--speed must be a positive number or maximum.');
}
const retentionHours = Number(args.get('--raw-retention-hours') ?? '24');
if (!Number.isFinite(retentionHours) || retentionHours < 1 || retentionHours > 168) {
  throw new Error('--raw-retention-hours must be between 1 and 168.');
}

const database = createDatabase(databaseUrl);
try {
  const clock = new SystemClock();
  const replayStore = new PostgresReplayStore(database.client);
  const hydration = await new TxLineHistoricalHydrator({
    client: new TxLineApiClient({
      apiToken: credentials.apiToken,
      config: getTxLineConfig(network),
    }),
    clock,
    rawRetentionMs: retentionHours * 60 * 60 * 1_000,
    replayStore,
    store: new PostgresDomainStore(database.client),
  }).hydrate({
    fixture: {
      competitionId: required(args, '--competition-id'),
      fixtureId: integer(args, '--fixture-id'),
      scheduledAtMs: integer(args, '--scheduled-at-ms'),
      sourceEndMs: integer(args, '--source-end-ms'),
      sourceStartMs: integer(args, '--source-start-ms'),
    },
    strategyConfiguration: seededDemoStrategyConfiguration,
    strategyVersion: 'lag-shield-v1',
  });
  const runId = args.get('--run-id') ?? `txline-${randomUUID()}`;
  const result = await new HistoricalReplayService({ clock, replayStore }).run({
    events: hydration.events,
    manifest: hydration.manifest,
    onEvent: async () => undefined,
    runId,
    speed,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        hydration: {
          duplicateCount: hydration.duplicateCount,
          eventCount: hydration.events.length,
          insertedCount: hydration.insertedCount,
          quarantineCount: hydration.quarantineCount,
          retentionExpiresAtMs: hydration.retentionExpiresAtMs,
        },
        manifest: hydration.manifest,
        network,
        result,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await database.client.end({ timeout: 5 });
}
