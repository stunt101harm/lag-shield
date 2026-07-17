import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js';
import { stableHash, toJsonValue } from '@lagshield/core';
import { z } from 'zod';

import type { TxLineNetworkConfig } from './config.js';
import { assertRpcNetwork } from './network.js';

const int32Schema = z.number().int().min(-2_147_483_648).max(2_147_483_647);
const uint32Schema = z.number().int().min(0).max(4_294_967_295);
const safeIntegerSchema = z.number().int().safe();
const timestampSchema = z.number().int().nonnegative().safe();

function decodeBytes32(value: unknown): string {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (Array.isArray(value)) {
    if (
      value.some(
        (byte) =>
          !Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255,
      )
    ) {
      throw new Error('Byte arrays may contain only integers from 0 through 255.');
    }
    bytes = Uint8Array.from(value as number[]);
  } else if (typeof value === 'string') {
    if (/^(?:0x)?[a-fA-F0-9]{64}$/.test(value)) {
      bytes = Buffer.from(value.startsWith('0x') ? value.slice(2) : value, 'hex');
    } else {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw new Error('Proof hashes must use base64, 0x-prefixed hex, or byte arrays.');
      }
      bytes = Buffer.from(value, 'base64');
    }
  } else {
    throw new Error('Proof hashes must use base64, 0x-prefixed hex, or byte arrays.');
  }
  if (bytes.length !== 32) {
    throw new Error(`Expected a 32-byte proof value; received ${bytes.length} bytes.`);
  }
  return Buffer.from(bytes).toString('hex');
}

export const bytes32Schema = z.unknown().transform((value, context) => {
  try {
    return decodeBytes32(value);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid 32-byte value.',
    });
    return z.NEVER;
  }
});

export const txLineProofNodeSchema = z
  .object({
    hash: bytes32Schema,
    isRightSibling: z.boolean(),
  })
  .strip();

const proofNodesSchema = z.array(txLineProofNodeSchema).max(128);

export const txLineOddsValidationSchema = z
  .object({
    odds: z
      .object({
        Bookmaker: z.string(),
        BookmakerId: int32Schema,
        FixtureId: safeIntegerSchema,
        GameState: z
          .string()
          .nullish()
          .transform((value) => value ?? null),
        InRunning: z.boolean(),
        MarketParameters: z
          .string()
          .nullish()
          .transform((value) => value ?? null),
        MarketPeriod: z
          .string()
          .nullish()
          .transform((value) => value ?? null),
        MessageId: z.string().min(1),
        PriceNames: z.array(z.string()).max(100).optional().default([]),
        Prices: z.array(int32Schema).max(100).optional().default([]),
        SuperOddsType: z.string(),
        Ts: timestampSchema,
      })
      .strip(),
    summary: z
      .object({
        fixtureId: safeIntegerSchema,
        oddsSubTreeRoot: bytes32Schema,
        updateStats: z
          .object({
            maxTimestamp: timestampSchema,
            minTimestamp: timestampSchema,
            updateCount: uint32Schema,
          })
          .strip(),
      })
      .strip(),
    subTreeProof: proofNodesSchema,
    mainTreeProof: proofNodesSchema,
  })
  .strip()
  .superRefine((validation, context) => {
    if (validation.odds.FixtureId !== validation.summary.fixtureId) {
      context.addIssue({
        code: 'custom',
        message: 'Odds proof fixture does not match its batch summary.',
      });
    }
    if (
      validation.odds.Ts < validation.summary.updateStats.minTimestamp ||
      validation.odds.Ts > validation.summary.updateStats.maxTimestamp
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Odds proof timestamp is outside its batch summary range.',
      });
    }
  });
export type TxLineOddsValidation = z.infer<typeof txLineOddsValidationSchema>;

const scoreStatSchema = z
  .object({ key: uint32Schema, period: int32Schema, value: int32Schema })
  .strip();
const scoresBatchSummarySchema = z
  .object({
    eventStatsSubTreeRoot: bytes32Schema,
    fixtureId: int32Schema,
    updateStats: z
      .object({
        maxTimestamp: timestampSchema,
        minTimestamp: timestampSchema,
        updateCount: int32Schema,
      })
      .strip(),
  })
  .strip();

export const txLineScoreStatValidationSchema = z
  .object({
    eventStatRoot: bytes32Schema,
    mainTreeProof: proofNodesSchema,
    statProof: proofNodesSchema,
    statProof2: proofNodesSchema.optional(),
    statToProve: scoreStatSchema,
    statToProve2: scoreStatSchema.optional(),
    subTreeProof: proofNodesSchema,
    summary: scoresBatchSummarySchema,
    ts: timestampSchema,
  })
  .strip()
  .superRefine((validation, context) => {
    if (validation.summary.fixtureId < 0) {
      context.addIssue({
        code: 'custom',
        message: 'Score proof fixture must be non-negative.',
      });
    }
    if (
      validation.ts < validation.summary.updateStats.minTimestamp ||
      validation.ts > validation.summary.updateStats.maxTimestamp
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Score proof timestamp is outside its batch summary range.',
      });
    }
  });
export type TxLineScoreStatValidation = z.infer<typeof txLineScoreStatValidationSchema>;

export const txLineProofArtifact = Object.freeze({
  commit: '3a1d6f0cfc34ce173f0778023d2332161359196d',
  dailyOddsRootSeed: 'daily_batch_roots',
  dailyScoresRootSeed: 'daily_scores_roots',
  idlVersion: '1.5.6',
  validateOddsDiscriminator: [192, 19, 91, 138, 104, 100, 212, 86] as const,
  validateStatDiscriminator: [107, 197, 232, 90, 191, 136, 105, 185] as const,
});

function epochDayBytes(timestampMs: number): Buffer {
  const timestamp = timestampSchema.parse(timestampMs);
  const epochDay = Math.floor(timestamp / 86_400_000);
  if (epochDay > 0xffff) {
    throw new Error('Proof timestamp is outside the u16 epoch-day range.');
  }
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(epochDay);
  return bytes;
}

export function deriveDailyOddsRootAddress(
  config: TxLineNetworkConfig,
  proofTimestampMs: number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(txLineProofArtifact.dailyOddsRootSeed), epochDayBytes(proofTimestampMs)],
    new PublicKey(config.programId),
  )[0];
}

export function deriveDailyScoresRootAddress(
  config: TxLineNetworkConfig,
  batchTimestampMs: number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(txLineProofArtifact.dailyScoresRootSeed),
      epochDayBytes(batchTimestampMs),
    ],
    new PublicKey(config.programId),
  )[0];
}

class BorshWriter {
  readonly #parts: Buffer[] = [];

  bytes(value: Uint8Array): void {
    this.#parts.push(Buffer.from(value));
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  i32(value: number): void {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32LE(int32Schema.parse(value));
    this.#parts.push(buffer);
  }

  i64(value: number): void {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64LE(BigInt(safeIntegerSchema.parse(value)));
    this.#parts.push(buffer);
  }

  optionString(value: string | null): void {
    if (value === null) this.u8(0);
    else {
      this.u8(1);
      this.string(value);
    }
  }

  string(value: string): void {
    const bytes = Buffer.from(value, 'utf8');
    this.u32(bytes.length);
    this.bytes(bytes);
  }

  u8(value: number): void {
    const buffer = Buffer.alloc(1);
    buffer.writeUInt8(value);
    this.#parts.push(buffer);
  }

  u32(value: number): void {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(uint32Schema.parse(value));
    this.#parts.push(buffer);
  }

  value(): Buffer {
    return Buffer.concat(this.#parts);
  }
}

function writeProofNodes(
  writer: BorshWriter,
  nodes: TxLineOddsValidation['subTreeProof'],
) {
  writer.u32(nodes.length);
  for (const node of nodes) {
    writer.bytes(Buffer.from(node.hash, 'hex'));
    writer.bool(node.isRightSibling);
  }
}

function writeScoreStat(
  writer: BorshWriter,
  stat: TxLineScoreStatValidation['statToProve'],
): void {
  writer.u32(stat.key);
  writer.i32(stat.value);
  writer.i32(stat.period);
}

export function encodeValidateOddsInstruction(
  validationInput: TxLineOddsValidation,
): Buffer {
  const validation = txLineOddsValidationSchema.parse(validationInput);
  const { odds, summary } = validation;
  const writer = new BorshWriter();
  writer.bytes(Uint8Array.from(txLineProofArtifact.validateOddsDiscriminator));
  writer.i64(odds.Ts);
  writer.i64(odds.FixtureId);
  writer.string(odds.MessageId);
  writer.i64(odds.Ts);
  writer.string(odds.Bookmaker);
  writer.i32(odds.BookmakerId);
  writer.string(odds.SuperOddsType);
  writer.optionString(odds.GameState);
  writer.bool(odds.InRunning);
  writer.optionString(odds.MarketParameters);
  writer.optionString(odds.MarketPeriod);
  writer.u32(odds.PriceNames.length);
  for (const priceName of odds.PriceNames) writer.string(priceName);
  writer.u32(odds.Prices.length);
  for (const price of odds.Prices) writer.i32(price);
  writer.i64(summary.fixtureId);
  writer.u32(summary.updateStats.updateCount);
  writer.i64(summary.updateStats.minTimestamp);
  writer.i64(summary.updateStats.maxTimestamp);
  writer.bytes(Buffer.from(summary.oddsSubTreeRoot, 'hex'));
  writeProofNodes(writer, validation.subTreeProof);
  writeProofNodes(writer, validation.mainTreeProof);
  return writer.value();
}

export function encodeValidateScoreStatInstruction(
  validationInput: TxLineScoreStatValidation,
): Buffer {
  const validation = txLineScoreStatValidationSchema.parse(validationInput);
  const writer = new BorshWriter();
  writer.bytes(Uint8Array.from(txLineProofArtifact.validateStatDiscriminator));
  writer.i64(validation.summary.updateStats.minTimestamp);
  writer.i64(validation.summary.fixtureId);
  writer.i32(validation.summary.updateStats.updateCount);
  writer.i64(validation.summary.updateStats.minTimestamp);
  writer.i64(validation.summary.updateStats.maxTimestamp);
  writer.bytes(Buffer.from(validation.summary.eventStatsSubTreeRoot, 'hex'));
  writeProofNodes(writer, validation.subTreeProof);
  writeProofNodes(writer, validation.mainTreeProof);

  // A tautological equality predicate makes the instruction return true exactly when
  // the supplied stat leaf and its fixture/daily Merkle path are valid.
  writer.i32(validation.statToProve.value);
  writer.u8(2); // Comparison::EqualTo in the pinned IDL.
  writeScoreStat(writer, validation.statToProve);
  writer.bytes(Buffer.from(validation.eventStatRoot, 'hex'));
  writeProofNodes(writer, validation.statProof);
  writer.u8(0); // stat_b: None
  writer.u8(0); // op: None
  return writer.value();
}

export function txLineExplorerAddressUrl(
  address: string,
  network: TxLineNetworkConfig['network'],
): string {
  const url = new URL(`https://explorer.solana.com/address/${address}`);
  if (network === 'devnet') url.searchParams.set('cluster', 'devnet');
  return url.toString();
}

export function oddsProofReference(messageId: string, timestampMs: number): string {
  const parameters = new URLSearchParams({ messageId, ts: String(timestampMs) });
  return `/api/odds/validation?${parameters.toString()}`;
}

export function scoreStatProofReference(
  input: Readonly<{
    fixtureId: number;
    sequence: number;
    statKey: number;
  }>,
): string {
  const parameters = new URLSearchParams({
    fixtureId: String(input.fixtureId),
    seq: String(input.sequence),
    statKey: String(input.statKey),
  });
  return `/api/scores/stat-validation?${parameters.toString()}`;
}

export class TxLineProofVerificationError extends Error {
  constructor(
    readonly code:
      | 'PROOF_ACCOUNT_MISSING'
      | 'PROOF_ACCOUNT_OWNER_MISMATCH'
      | 'PROOF_IDENTITY_MISMATCH'
      | 'PROOF_RETURN_DATA_INVALID'
      | 'PROOF_SIMULATION_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'TxLineProofVerificationError';
  }
}

export type TxLineOddsProofVerificationResult = Readonly<{
  explorerAccountUrl: string;
  explorerProgramUrl: string;
  network: TxLineNetworkConfig['network'];
  programId: string;
  proofMaterialHash: string;
  proofReference: string;
  rootAccount: string;
  simulationSlot: number;
  sourceMessageId: string;
  sourceTimestampMs: number;
  status: 'rejected' | 'verified';
  summary: string;
}>;

export type TxLineScoreProofVerificationResult = Readonly<{
  explorerAccountUrl: string;
  explorerProgramUrl: string;
  network: TxLineNetworkConfig['network'];
  programId: string;
  proofMaterialHash: string;
  proofReference: string;
  rootAccount: string;
  simulationSlot: number;
  sourceFixtureId: number;
  sourceSequence: number;
  sourceStatKey: number;
  sourceTimestampMs: number;
  status: 'rejected' | 'verified';
  summary: string;
}>;

export async function verifyTxLineOddsProof(
  input: Readonly<{
    config: TxLineNetworkConfig;
    connection: Pick<
      Connection,
      'getAccountInfo' | 'getGenesisHash' | 'simulateTransaction'
    >;
    expectedMessageId: string;
    expectedTimestampMs: number;
    simulationPayer: PublicKey;
    validation: TxLineOddsValidation;
  }>,
): Promise<TxLineOddsProofVerificationResult> {
  const validation = txLineOddsValidationSchema.parse(input.validation);
  if (
    validation.odds.MessageId !== input.expectedMessageId ||
    validation.odds.Ts !== input.expectedTimestampMs
  ) {
    throw new TxLineProofVerificationError(
      'PROOF_IDENTITY_MISMATCH',
      'Proof response does not match the requested TxLINE message ID and timestamp.',
    );
  }
  await assertRpcNetwork(input.connection, input.config);
  const programId = new PublicKey(input.config.programId);
  const rootAccount = deriveDailyOddsRootAddress(input.config, validation.odds.Ts);
  const account = await input.connection.getAccountInfo(rootAccount, 'confirmed');
  if (!account) {
    throw new TxLineProofVerificationError(
      'PROOF_ACCOUNT_MISSING',
      'The derived TxLINE daily odds root account is not yet available on-chain.',
    );
  }
  if (!account.owner.equals(programId)) {
    throw new TxLineProofVerificationError(
      'PROOF_ACCOUNT_OWNER_MISMATCH',
      'The derived odds root account is not owned by the configured TxLINE program.',
    );
  }

  const instruction = new TransactionInstruction({
    data: encodeValidateOddsInstruction(validation),
    keys: [{ isSigner: false, isWritable: false, pubkey: rootAccount }],
    programId,
  });
  const message = new TransactionMessage({
    instructions: [instruction],
    payerKey: input.simulationPayer,
    recentBlockhash: PublicKey.default.toBase58(),
  }).compileToV0Message();
  const simulation = await input.connection.simulateTransaction(
    new VersionedTransaction(message),
    {
      commitment: 'confirmed',
      replaceRecentBlockhash: true,
      sigVerify: false,
    },
  );
  if (simulation.value.err) {
    throw new TxLineProofVerificationError(
      'PROOF_SIMULATION_ERROR',
      'The configured TxLINE program could not simulate this proof.',
    );
  }
  const returnData = simulation.value.returnData;
  if (!returnData || returnData.programId !== programId.toBase58()) {
    throw new TxLineProofVerificationError(
      'PROOF_RETURN_DATA_INVALID',
      'The proof simulation did not return data from the configured TxLINE program.',
    );
  }
  const returnBytes = Buffer.from(returnData.data[0], returnData.data[1]);
  if (returnBytes.length !== 1 || (returnBytes[0] !== 0 && returnBytes[0] !== 1)) {
    throw new TxLineProofVerificationError(
      'PROOF_RETURN_DATA_INVALID',
      'The TxLINE validation return value is not a Borsh boolean.',
    );
  }
  const status = returnBytes[0] === 1 ? 'verified' : 'rejected';
  const rootAddress = rootAccount.toBase58();
  return {
    explorerAccountUrl: txLineExplorerAddressUrl(rootAddress, input.config.network),
    explorerProgramUrl: txLineExplorerAddressUrl(
      programId.toBase58(),
      input.config.network,
    ),
    network: input.config.network,
    programId: programId.toBase58(),
    proofMaterialHash: stableHash(toJsonValue(validation)),
    proofReference: oddsProofReference(validation.odds.MessageId, validation.odds.Ts),
    rootAccount: rootAddress,
    simulationSlot: simulation.context.slot,
    sourceMessageId: validation.odds.MessageId,
    sourceTimestampMs: validation.odds.Ts,
    status,
    summary:
      status === 'verified'
        ? `TxLINE ${input.config.network} validate_odds returned true for the exact message and timestamp.`
        : `TxLINE ${input.config.network} validate_odds returned false for the exact message and timestamp.`,
  };
}

export async function verifyTxLineScoreStatProof(
  input: Readonly<{
    config: TxLineNetworkConfig;
    connection: Pick<
      Connection,
      'getAccountInfo' | 'getGenesisHash' | 'simulateTransaction'
    >;
    expectedFixtureId: number;
    expectedSequence: number;
    expectedStatKey: number;
    expectedTimestampMs: number;
    simulationPayer: PublicKey;
    validation: TxLineScoreStatValidation;
  }>,
): Promise<TxLineScoreProofVerificationResult> {
  const validation = txLineScoreStatValidationSchema.parse(input.validation);
  if (
    validation.summary.fixtureId !== input.expectedFixtureId ||
    validation.statToProve.key !== input.expectedStatKey ||
    validation.ts !== input.expectedTimestampMs
  ) {
    throw new TxLineProofVerificationError(
      'PROOF_IDENTITY_MISMATCH',
      'Score proof response does not match the requested fixture, stat, and timestamp.',
    );
  }
  if (!Number.isSafeInteger(input.expectedSequence) || input.expectedSequence < 1) {
    throw new TxLineProofVerificationError(
      'PROOF_IDENTITY_MISMATCH',
      'Score proof sequence must be a positive safe integer.',
    );
  }
  await assertRpcNetwork(input.connection, input.config);
  const programId = new PublicKey(input.config.programId);
  const rootAccount = deriveDailyScoresRootAddress(
    input.config,
    validation.summary.updateStats.minTimestamp,
  );
  const account = await input.connection.getAccountInfo(rootAccount, 'confirmed');
  if (!account) {
    throw new TxLineProofVerificationError(
      'PROOF_ACCOUNT_MISSING',
      'The derived TxLINE daily scores root account is not yet available on-chain.',
    );
  }
  if (!account.owner.equals(programId)) {
    throw new TxLineProofVerificationError(
      'PROOF_ACCOUNT_OWNER_MISMATCH',
      'The derived scores root account is not owned by the configured TxLINE program.',
    );
  }

  const instruction = new TransactionInstruction({
    data: encodeValidateScoreStatInstruction(validation),
    keys: [{ isSigner: false, isWritable: false, pubkey: rootAccount }],
    programId,
  });
  const message = new TransactionMessage({
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      instruction,
    ],
    payerKey: input.simulationPayer,
    recentBlockhash: PublicKey.default.toBase58(),
  }).compileToV0Message();
  const simulation = await input.connection.simulateTransaction(
    new VersionedTransaction(message),
    {
      commitment: 'confirmed',
      replaceRecentBlockhash: true,
      sigVerify: false,
    },
  );
  if (simulation.value.err) {
    throw new TxLineProofVerificationError(
      'PROOF_SIMULATION_ERROR',
      'The configured TxLINE program could not simulate this score proof.',
    );
  }
  const returnData = simulation.value.returnData;
  if (!returnData || returnData.programId !== programId.toBase58()) {
    throw new TxLineProofVerificationError(
      'PROOF_RETURN_DATA_INVALID',
      'The score proof simulation did not return data from the configured TxLINE program.',
    );
  }
  const returnBytes = Buffer.from(returnData.data[0], returnData.data[1]);
  if (returnBytes.length !== 1 || (returnBytes[0] !== 0 && returnBytes[0] !== 1)) {
    throw new TxLineProofVerificationError(
      'PROOF_RETURN_DATA_INVALID',
      'The TxLINE score validation return value is not a Borsh boolean.',
    );
  }
  const status = returnBytes[0] === 1 ? 'verified' : 'rejected';
  const rootAddress = rootAccount.toBase58();
  return {
    explorerAccountUrl: txLineExplorerAddressUrl(rootAddress, input.config.network),
    explorerProgramUrl: txLineExplorerAddressUrl(
      programId.toBase58(),
      input.config.network,
    ),
    network: input.config.network,
    programId: programId.toBase58(),
    proofMaterialHash: stableHash(toJsonValue(validation)),
    proofReference: scoreStatProofReference({
      fixtureId: input.expectedFixtureId,
      sequence: input.expectedSequence,
      statKey: input.expectedStatKey,
    }),
    rootAccount: rootAddress,
    simulationSlot: simulation.context.slot,
    sourceFixtureId: input.expectedFixtureId,
    sourceSequence: input.expectedSequence,
    sourceStatKey: input.expectedStatKey,
    sourceTimestampMs: validation.ts,
    status,
    summary:
      status === 'verified'
        ? `TxLINE ${input.config.network} validate_stat returned true for the exact score update and stat leaf.`
        : `TxLINE ${input.config.network} validate_stat returned false for the exact score update and stat leaf.`,
  };
}
