import { PublicKey, type Connection } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { TxLineApiClient, type TxLineFetch } from './client.js';
import { getTxLineConfig } from './config.js';
import {
  deriveDailyOddsRootAddress,
  deriveDailyScoresRootAddress,
  encodeValidateOddsInstruction,
  encodeValidateScoreStatInstruction,
  txLineOddsValidationSchema,
  txLineScoreStatValidationSchema,
  verifyTxLineOddsProof,
  verifyTxLineScoreStatProof,
  type TxLineOddsValidation,
  type TxLineScoreStatValidation,
} from './proof.js';

const timestampMs = 1_700_000_000_000;
const zeroHash = `0x${'00'.repeat(32)}`;
const oneHashBase64 = Buffer.alloc(32, 1).toString('base64');

function rawValidation() {
  return {
    odds: {
      Bookmaker: 'TxODDS Consensus',
      BookmakerId: 7,
      FixtureId: 42,
      GameState: 'in_play',
      InRunning: true,
      MarketParameters: null,
      MarketPeriod: 'full_time',
      MessageId: 'odds-message-1',
      PriceNames: ['Home', 'Draw', 'Away'],
      Prices: [2100, 3200, 2900],
      SuperOddsType: '1X2',
      Ts: timestampMs,
    },
    summary: {
      fixtureId: 42,
      oddsSubTreeRoot: zeroHash,
      updateStats: {
        maxTimestamp: timestampMs + 1_000,
        minTimestamp: timestampMs - 1_000,
        updateCount: 3,
      },
    },
    subTreeProof: [{ hash: oneHashBase64, isRightSibling: true }],
    mainTreeProof: [{ hash: Array(32).fill(2), isRightSibling: false }],
  };
}

function validation(): TxLineOddsValidation {
  return txLineOddsValidationSchema.parse(rawValidation());
}

function rawScoreValidation() {
  return {
    eventStatRoot: zeroHash,
    mainTreeProof: [{ hash: Array(32).fill(2), isRightSibling: false }],
    statProof: [{ hash: oneHashBase64, isRightSibling: true }],
    statToProve: { key: 1, period: 0, value: 2 },
    subTreeProof: [{ hash: zeroHash, isRightSibling: false }],
    summary: {
      eventStatsSubTreeRoot: oneHashBase64,
      fixtureId: 42,
      updateStats: {
        maxTimestamp: timestampMs + 1_000,
        minTimestamp: timestampMs - 1_000,
        updateCount: 3,
      },
    },
    ts: timestampMs,
  };
}

function scoreValidation(): TxLineScoreStatValidation {
  return txLineScoreStatValidationSchema.parse(rawScoreValidation());
}

function connection(
  options: Readonly<{
    genesisHash?: string;
    owner?: PublicKey;
    returnValue?: 0 | 1;
  }> = {},
): Pick<Connection, 'getAccountInfo' | 'getGenesisHash' | 'simulateTransaction'> {
  const config = getTxLineConfig('devnet');
  return {
    getAccountInfo: async () => ({
      data: Buffer.alloc(0),
      executable: false,
      lamports: 1,
      owner: options.owner ?? new PublicKey(config.programId),
      rentEpoch: 0,
    }),
    getGenesisHash: async () => options.genesisHash ?? config.genesisHash,
    simulateTransaction: async () => ({
      context: { apiVersion: '1.18', slot: 123 },
      value: {
        accounts: null,
        err: null,
        innerInstructions: null,
        loadedAccountsDataSize: 0,
        logs: [],
        replacementBlockhash: null,
        returnData: {
          data: [Buffer.from([options.returnValue ?? 1]).toString('base64'), 'base64'],
          programId: config.programId,
        },
        unitsConsumed: 10_000,
      },
    }),
  } as unknown as Pick<
    Connection,
    'getAccountInfo' | 'getGenesisHash' | 'simulateTransaction'
  >;
}

describe('TxLINE proof contracts', () => {
  it('normalizes all documented bytes32 encodings and rejects malformed proof values', () => {
    const parsed = validation();
    expect(parsed.summary.oddsSubTreeRoot).toBe('00'.repeat(32));
    expect(parsed.subTreeProof[0]?.hash).toBe('01'.repeat(32));
    expect(parsed.mainTreeProof[0]?.hash).toBe('02'.repeat(32));
    expect(() =>
      txLineOddsValidationSchema.parse({
        ...rawValidation(),
        mainTreeProof: [{ hash: 'not-base64', isRightSibling: false }],
      }),
    ).toThrow(/32-byte|base64/);
  });

  it('encodes the pinned IDL 1.5.6 validate_odds instruction byte-for-byte', () => {
    const encoded = encodeValidateOddsInstruction(validation());
    expect(encoded.subarray(0, 8).toString('hex')).toBe('c0135b8a6864d456');
    expect(encoded.length).toBe(287);
    expect(createHash('sha256').update(encoded).digest('hex')).toBe(
      '7d6a89e31c8d04eb877895a2abd257d4a8794c53b6e34fffa33c18ea20a3577c',
    );
  });

  it('derives the documented daily_batch_roots PDA from a u16-le epoch day', () => {
    const config = getTxLineConfig('devnet');
    expect(deriveDailyOddsRootAddress(config, timestampMs).toBase58()).toBe(
      'CMJYEEF8tYH4emUzr3V34Q5jFnhUG1VwqQhnzxQLDtcT',
    );
  });

  it('encodes the pinned validate_stat contract and derives daily_scores_roots', () => {
    const encoded = encodeValidateScoreStatInstruction(scoreValidation());
    expect(encoded.subarray(0, 8).toString('hex')).toBe('6bc5e85abf8869b9');
    expect(createHash('sha256').update(encoded).digest('hex')).toBe(
      'a97a354755fc5be25f76281bf480dc959e6642426814fa41c087d895d34f858e',
    );
    expect(
      deriveDailyScoresRootAddress(
        getTxLineConfig('devnet'),
        timestampMs - 1_000,
      ).toBase58(),
    ).toBe('FyLytXEGvCCgYTfwi8QC7DrVCbv37ecWCqvdC2AJWe5R');
  });

  it('simulates validate_odds and exposes matching program/account provenance', async () => {
    const config = getTxLineConfig('devnet');
    const result = await verifyTxLineOddsProof({
      config,
      connection: connection(),
      expectedMessageId: 'odds-message-1',
      expectedTimestampMs: timestampMs,
      simulationPayer: new PublicKey('11111111111111111111111111111111'),
      validation: validation(),
    });

    expect(result).toMatchObject({
      network: 'devnet',
      programId: config.programId,
      simulationSlot: 123,
      sourceMessageId: 'odds-message-1',
      status: 'verified',
    });
    expect(result.explorerAccountUrl).toContain('cluster=devnet');
    expect(result.proofMaterialHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps cryptographic rejection distinct from network and ownership errors', async () => {
    const config = getTxLineConfig('devnet');
    const common = {
      config,
      expectedMessageId: 'odds-message-1',
      expectedTimestampMs: timestampMs,
      simulationPayer: PublicKey.default,
      validation: validation(),
    } as const;
    await expect(
      verifyTxLineOddsProof({ ...common, connection: connection({ returnValue: 0 }) }),
    ).resolves.toMatchObject({ status: 'rejected' });
    await expect(
      verifyTxLineOddsProof({
        ...common,
        connection: connection({ genesisHash: 'wrong-network' }),
      }),
    ).rejects.toThrow(/genesis hash does not match/);
    await expect(
      verifyTxLineOddsProof({
        ...common,
        connection: connection({ owner: PublicKey.default }),
      }),
    ).rejects.toMatchObject({
      code: 'PROOF_ACCOUNT_OWNER_MISMATCH',
    });
    await expect(
      verifyTxLineOddsProof({
        ...common,
        connection: connection(),
        expectedMessageId: 'wrong-message',
      }),
    ).rejects.toMatchObject({
      code: 'PROOF_IDENTITY_MISMATCH',
    });
  });

  it('simulates validate_stat for the exact fixture, sequence, stat, and source timestamp', async () => {
    const config = getTxLineConfig('devnet');
    const result = await verifyTxLineScoreStatProof({
      config,
      connection: connection(),
      expectedFixtureId: 42,
      expectedSequence: 7,
      expectedStatKey: 1,
      expectedTimestampMs: timestampMs,
      simulationPayer: PublicKey.default,
      validation: scoreValidation(),
    });

    expect(result).toMatchObject({
      sourceFixtureId: 42,
      sourceSequence: 7,
      sourceStatKey: 1,
      sourceTimestampMs: timestampMs,
      status: 'verified',
    });
    await expect(
      verifyTxLineScoreStatProof({
        config,
        connection: connection(),
        expectedFixtureId: 99,
        expectedSequence: 7,
        expectedStatKey: 1,
        expectedTimestampMs: timestampMs,
        simulationPayer: PublicKey.default,
        validation: scoreValidation(),
      }),
    ).rejects.toMatchObject({ code: 'PROOF_IDENTITY_MISMATCH' });
  });

  it('requests typed odds and score proof paths with both authentication headers', async () => {
    const requests: URL[] = [];
    const fetch: TxLineFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push(url);
      if (url.pathname === '/auth/guest/start') {
        return Response.json({ token: 'header.payload.signature' });
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer header.payload.signature',
      );
      expect(new Headers(init?.headers).get('X-Api-Token')).toBe('api-token');
      if (url.pathname === '/api/odds/validation') {
        return Response.json(rawValidation());
      }
      return Response.json({
        eventStatRoot: zeroHash,
        mainTreeProof: [],
        statProof: [],
        statToProve: { key: 1, period: 0, value: 2 },
        subTreeProof: [],
        summary: {
          eventStatsSubTreeRoot: zeroHash,
          fixtureId: 42,
          updateStats: {
            maxTimestamp: timestampMs,
            minTimestamp: timestampMs,
            updateCount: 1,
          },
        },
        ts: timestampMs,
      });
    };
    const client = new TxLineApiClient({
      apiToken: 'api-token',
      config: getTxLineConfig('devnet'),
      fetch,
    });

    await client.fetchOddsValidation({
      messageId: 'odds-message-1',
      timestampMs,
    });
    await client.fetchScoreStatValidation({
      fixtureId: 42,
      sequence: 7,
      statKey: 1,
      statKey2: 2,
    });

    expect(requests[1]?.pathname).toBe('/api/odds/validation');
    expect(requests[1]?.searchParams.get('messageId')).toBe('odds-message-1');
    expect(requests[1]?.searchParams.get('ts')).toBe(String(timestampMs));
    expect(requests[2]?.pathname).toBe('/api/scores/stat-validation');
    expect(requests[2]?.searchParams.get('seq')).toBe('7');
    expect(requests[2]?.searchParams.get('statKey2')).toBe('2');
  });
});
