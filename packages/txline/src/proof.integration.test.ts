import { Connection, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { TxLineApiClient } from './client.js';
import { getTxLineConfig } from './config.js';
import { readCredentialsFile } from './credentials.js';
import { verifyTxLineOddsProof, verifyTxLineScoreStatProof } from './proof.js';

const credentialsFile = process.env.TXLINE_PROOF_CREDENTIALS_FILE;

async function realHarness() {
  const credentials = await readCredentialsFile(credentialsFile!);
  const config = getTxLineConfig(credentials.network, {
    ...(process.env.TXLINE_PROOF_RPC_URL
      ? { rpcUrl: process.env.TXLINE_PROOF_RPC_URL }
      : {}),
  });
  return {
    client: new TxLineApiClient({ apiToken: credentials.apiToken, config }),
    config,
    connection: new Connection(config.rpcUrl, 'confirmed'),
    payer: new PublicKey(credentials.walletPublicKey),
  };
}

const oddsMessageId = process.env.TXLINE_PROOF_MESSAGE_ID;
const oddsTimestampMs = Number(process.env.TXLINE_PROOF_TIMESTAMP_MS);
const oddsConfigured =
  Boolean(credentialsFile && oddsMessageId) && Number.isSafeInteger(oddsTimestampMs);

const scoreFixtureId = Number(process.env.TXLINE_SCORE_PROOF_FIXTURE_ID);
const scoreSequence = Number(process.env.TXLINE_SCORE_PROOF_SEQUENCE);
const scoreTimestampMs = Number(process.env.TXLINE_SCORE_PROOF_TIMESTAMP_MS);
const scoreStatKey = Number(process.env.TXLINE_SCORE_PROOF_STAT_KEY ?? 1);
const scoreConfigured =
  Boolean(credentialsFile) &&
  Number.isSafeInteger(scoreFixtureId) &&
  Number.isSafeInteger(scoreSequence) &&
  Number.isSafeInteger(scoreTimestampMs) &&
  Number.isSafeInteger(scoreStatKey);

describe('TxLINE real proof verification', () => {
  it.skipIf(!oddsConfigured)(
    'fetches an exact real odds proof and receives true from the pinned on-chain program',
    async () => {
      const { client, config, connection, payer } = await realHarness();
      const validation = await client.fetchOddsValidation({
        messageId: oddsMessageId!,
        timestampMs: oddsTimestampMs,
      });
      const result = await verifyTxLineOddsProof({
        config,
        connection,
        expectedMessageId: oddsMessageId!,
        expectedTimestampMs: oddsTimestampMs,
        simulationPayer: payer,
        validation,
      });

      expect(result).toMatchObject({
        network: config.network,
        programId: config.programId,
        sourceMessageId: oddsMessageId,
        sourceTimestampMs: oddsTimestampMs,
        status: 'verified',
      });
    },
    60_000,
  );

  it.skipIf(!scoreConfigured)(
    'fetches an exact real score stat proof and receives true from the pinned on-chain program',
    async () => {
      const { client, config, connection, payer } = await realHarness();
      const validation = await client.fetchScoreStatValidation({
        fixtureId: scoreFixtureId,
        sequence: scoreSequence,
        statKey: scoreStatKey,
      });
      const result = await verifyTxLineScoreStatProof({
        config,
        connection,
        expectedFixtureId: scoreFixtureId,
        expectedSequence: scoreSequence,
        expectedStatKey: scoreStatKey,
        expectedTimestampMs: scoreTimestampMs,
        simulationPayer: payer,
        validation,
      });

      expect(result).toMatchObject({
        network: config.network,
        programId: config.programId,
        sourceFixtureId: scoreFixtureId,
        sourceSequence: scoreSequence,
        sourceStatKey: scoreStatKey,
        sourceTimestampMs: scoreTimestampMs,
        status: 'verified',
      });
    },
    60_000,
  );
});
