#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { Connection } from '@solana/web3.js';

import { txLineSubscriptionArtifact } from './artifact.js';
import { TxLineApiClient } from './client.js';
import { getTxLineConfig, parseTxLineNetwork } from './config.js';
import { readCredentialsFile, writeCredentialsFile } from './credentials.js';
import { assertRpcNetwork } from './network.js';
import { safeErrorMessage } from './redact.js';
import { summarizeFixture } from './schemas.js';
import { loadKeypairFile } from './wallet.js';

const help = `LagShield TxLINE operator CLI

Usage:
  pnpm txline -- doctor [--network devnet|mainnet] [--rpc-url URL]
  pnpm txline -- subscribe --wallet FILE [options]
  pnpm txline -- activate --wallet FILE --tx-signature SIGNATURE [options]
  pnpm txline -- fixtures [options]
  pnpm txline -- smoke [options]

Options:
  --network NETWORK          Defaults to TXLINE_NETWORK or devnet
  --rpc-url URL              Defaults to TXLINE_RPC_URL or canonical RPC
  --credentials FILE         Defaults to TXLINE_CREDENTIALS_FILE or .txline/<network>.credentials.json
  --wallet FILE              chmod 600 Solana keypair required by subscribe
  --service-level NUMBER     Defaults to documented network free tier
  --duration-weeks NUMBER    Defaults to 4; must be a multiple of 4 through 48
  --tx-signature SIGNATURE   Confirmed subscribe transaction for activation recovery
  --limit NUMBER             Maximum fixture summaries to print (default: 12)
  --force                    Explicitly replace an existing credentials file
  --help                     Show this text

Secrets are accepted only through chmod 600 files; tokens are never printed.
`;

type CliValues = {
  readonly credentials?: string;
  readonly 'duration-weeks'?: string;
  readonly force?: boolean;
  readonly help?: boolean;
  readonly limit?: string;
  readonly network?: string;
  readonly 'rpc-url'?: string;
  readonly 'service-level'?: string;
  readonly 'tx-signature'?: string;
  readonly wallet?: string;
};

function parseInteger(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }
  return parsed;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function required(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`${flag} is required.`);
  }
  return value;
}

async function run(): Promise<void> {
  const processArguments = process.argv.slice(2);
  const cliArguments =
    processArguments[0] === '--' ? processArguments.slice(1) : processArguments;
  const { positionals, values } = parseArgs({
    args: cliArguments,
    allowPositionals: true,
    options: {
      credentials: { type: 'string' },
      'duration-weeks': { type: 'string' },
      force: { type: 'boolean' },
      help: { short: 'h', type: 'boolean' },
      limit: { type: 'string' },
      network: { type: 'string' },
      'rpc-url': { type: 'string' },
      'service-level': { type: 'string' },
      'tx-signature': { type: 'string' },
      wallet: { type: 'string' },
    },
    strict: true,
  });
  const cliValues: CliValues = values;

  if (cliValues.help || positionals.length === 0) {
    process.stdout.write(help);
    return;
  }

  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    !['activate', 'doctor', 'subscribe', 'fixtures', 'smoke'].includes(command!)
  ) {
    throw new Error(`Unknown command: ${positionals.join(' ')}`);
  }

  const network = parseTxLineNetwork(cliValues.network ?? process.env.TXLINE_NETWORK);
  const rpcUrl = cliValues['rpc-url'] ?? process.env.TXLINE_RPC_URL;
  const config = getTxLineConfig(network, rpcUrl ? { rpcUrl } : {});
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const credentialsPath =
    cliValues.credentials ??
    process.env.TXLINE_CREDENTIALS_FILE ??
    `.txline/${network}.credentials.json`;

  if (command === 'doctor') {
    await assertRpcNetwork(connection, config);
    const apiClient = new TxLineApiClient({ config });
    await apiClient.renewGuestSession();
    output({
      apiAuthStatus: 'ok',
      apiOrigin: config.apiOrigin,
      artifact: {
        idlVersion: txLineSubscriptionArtifact.idlVersion,
        sourceCommit: txLineSubscriptionArtifact.sourceCommit,
      },
      genesisHash: config.genesisHash,
      network,
      programId: config.programId,
      rpcUrl: config.rpcUrl,
      status: 'ok',
      tokenMint: config.tokenMint,
    });
    return;
  }

  if (command === 'subscribe' || command === 'activate') {
    const { activateConfirmedSubscription, subscribeAndActivate } =
      await import('./subscription.js');
    await assertRpcNetwork(connection, config);
    const walletPath = required(cliValues.wallet, '--wallet');
    const wallet = await loadKeypairFile(walletPath);
    const serviceLevelId = parseInteger(
      cliValues['service-level'],
      config.defaultServiceLevelId,
      '--service-level',
    );
    const durationWeeks = parseInteger(
      cliValues['duration-weeks'],
      4,
      '--duration-weeks',
    );
    const apiClient = new TxLineApiClient({ config });
    const credentials =
      command === 'subscribe'
        ? await subscribeAndActivate({
            apiClient,
            config,
            connection,
            durationWeeks,
            serviceLevelId,
            wallet,
          })
        : await activateConfirmedSubscription({
            apiClient,
            config,
            durationWeeks,
            serviceLevelId,
            txSig: required(cliValues['tx-signature'], '--tx-signature'),
            wallet,
          });
    await writeCredentialsFile(
      credentialsPath,
      credentials,
      cliValues.force === undefined ? {} : { force: cliValues.force },
    );
    output({
      credentialsPath,
      network,
      serviceLevelId,
      status: command === 'activate' ? 'activation-recovered' : 'activated',
      subscriptionTxSignature: credentials.subscriptionTxSignature,
      tokenStored: true,
      walletPublicKey: credentials.walletPublicKey,
    });
    return;
  }

  const credentials = await readCredentialsFile(credentialsPath);
  if (credentials.network !== network) {
    throw new Error(
      `Credentials are for ${credentials.network}, but the selected network is ${network}.`,
    );
  }
  const apiClient = new TxLineApiClient({ apiToken: credentials.apiToken, config });
  const fixtures = await apiClient.discoverWorldCupFixtures();
  const limit = parseInteger(cliValues.limit, 12, '--limit');
  if (limit < 1 || limit > 100) {
    throw new Error('--limit must be between 1 and 100.');
  }

  output({
    discovered: fixtures.length,
    fixtures: fixtures.slice(0, limit).map(summarizeFixture),
    network,
    status: command === 'smoke' ? 'live-smoke-ok' : 'ok',
    tokenLoaded: true,
  });
}

run().catch((error: unknown) => {
  process.stderr.write(`TxLINE CLI error: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
