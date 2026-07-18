import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Connection,
  type Keypair,
} from '@solana/web3.js';
import nacl from 'tweetnacl';

import { assertSubscriptionArtifact, txLineSubscriptionArtifact } from './artifact.js';
import type { TxLineApiClient } from './client.js';
import {
  assertFreeServiceLevel,
  assertSubscriptionDuration,
  type TxLineNetworkConfig,
} from './config.js';
import type { TxLineCredentials } from './credentials.js';
import { TxLineApiError } from './errors.js';
import { assertRpcNetwork } from './network.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createIdempotentToken2022AssociatedAccountInstruction,
  deriveToken2022AssociatedAddress,
} from './token2022.js';

export function createSubscriptionInstruction(input: {
  readonly config: TxLineNetworkConfig;
  readonly durationWeeks: number;
  readonly serviceLevelId: number;
  readonly user: PublicKey;
}): {
  readonly instruction: TransactionInstruction;
  readonly userTokenAccount: PublicKey;
} {
  const { config, durationWeeks, serviceLevelId, user } = input;
  assertSubscriptionArtifact(config);
  assertFreeServiceLevel(config, serviceLevelId);
  assertSubscriptionDuration(durationWeeks);

  const programId = new PublicKey(config.programId);
  const tokenMint = new PublicKey(config.tokenMint);
  const [pricingMatrix] = PublicKey.findProgramAddressSync(
    [Buffer.from(txLineSubscriptionArtifact.pricingMatrixSeed)],
    programId,
  );
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(txLineSubscriptionArtifact.tokenTreasurySeed)],
    programId,
  );
  const userTokenAccount = deriveToken2022AssociatedAddress({
    mint: tokenMint,
    owner: user,
  });
  const tokenTreasuryVault = deriveToken2022AssociatedAddress({
    allowOwnerOffCurve: true,
    mint: tokenMint,
    owner: tokenTreasuryPda,
  });
  const data = Buffer.alloc(11);
  Buffer.from(txLineSubscriptionArtifact.discriminator).copy(data, 0);
  data.writeUInt16LE(serviceLevelId, 8);
  data.writeUInt8(durationWeeks, 10);

  return {
    instruction: new TransactionInstruction({
      data,
      keys: [
        { isSigner: true, isWritable: true, pubkey: user },
        { isSigner: false, isWritable: false, pubkey: pricingMatrix },
        { isSigner: false, isWritable: false, pubkey: tokenMint },
        { isSigner: false, isWritable: true, pubkey: userTokenAccount },
        { isSigner: false, isWritable: true, pubkey: tokenTreasuryVault },
        { isSigner: false, isWritable: false, pubkey: tokenTreasuryPda },
        { isSigner: false, isWritable: false, pubkey: TOKEN_2022_PROGRAM_ID },
        { isSigner: false, isWritable: false, pubkey: SystemProgram.programId },
        { isSigner: false, isWritable: false, pubkey: ASSOCIATED_TOKEN_PROGRAM_ID },
      ],
      programId,
    }),
    userTokenAccount,
  };
}

export function createActivationMessage(
  txSig: string,
  leagues: readonly number[],
  jwt: string,
): Uint8Array {
  return new TextEncoder().encode(`${txSig}:${leagues.join(',')}:${jwt}`);
}

export function signActivationMessage(
  txSig: string,
  leagues: readonly number[],
  jwt: string,
  wallet: Keypair,
): string {
  const message = createActivationMessage(txSig, leagues, jwt);
  return Buffer.from(nacl.sign.detached(message, wallet.secretKey)).toString('base64');
}

export async function subscribeAndActivate(input: {
  readonly apiClient: TxLineApiClient;
  readonly config: TxLineNetworkConfig;
  readonly connection: Connection;
  readonly durationWeeks: number;
  readonly leagues?: readonly number[];
  readonly serviceLevelId: number;
  readonly wallet: Keypair;
}): Promise<TxLineCredentials> {
  await assertRpcNetwork(input.connection, input.config);
  const { instruction, userTokenAccount } = createSubscriptionInstruction({
    config: input.config,
    durationWeeks: input.durationWeeks,
    serviceLevelId: input.serviceLevelId,
    user: input.wallet.publicKey,
  });
  const tokenMint = new PublicKey(input.config.tokenMint);
  const createUserTokenAccount = createIdempotentToken2022AssociatedAccountInstruction({
    associatedAccount: userTokenAccount,
    mint: tokenMint,
    owner: input.wallet.publicKey,
    payer: input.wallet.publicKey,
  });
  const transaction = new Transaction().add(createUserTokenAccount, instruction);
  const txSig = await sendAndConfirmTransaction(
    input.connection,
    transaction,
    [input.wallet],
    {
      commitment: 'confirmed',
    },
  );

  try {
    return await activateConfirmedSubscription({ ...input, txSig });
  } catch {
    throw new Error(
      `Subscription transaction ${txSig} is confirmed, but activation failed. ` +
        'Re-run the activate command with this transaction signature.',
    );
  }
}

export async function activateConfirmedSubscription(input: {
  readonly apiClient: TxLineApiClient;
  readonly config: TxLineNetworkConfig;
  readonly durationWeeks: number;
  readonly leagues?: readonly number[];
  readonly serviceLevelId: number;
  readonly txSig: string;
  readonly wallet: Keypair;
}): Promise<TxLineCredentials> {
  assertSubscriptionArtifact(input.config);
  assertFreeServiceLevel(input.config, input.serviceLevelId);
  assertSubscriptionDuration(input.durationWeeks);
  const leagues = input.leagues ?? [];
  let jwt = await input.apiClient.renewGuestSession();
  let walletSignature = signActivationMessage(input.txSig, leagues, jwt, input.wallet);
  let apiToken: string;
  try {
    apiToken = await input.apiClient.activateSubscription({
      leagues,
      txSig: input.txSig,
      walletSignature,
    });
  } catch (error) {
    if (!(error instanceof TxLineApiError) || error.status !== 401) {
      throw error;
    }

    jwt = await input.apiClient.renewGuestSession();
    walletSignature = signActivationMessage(input.txSig, leagues, jwt, input.wallet);
    apiToken = await input.apiClient.activateSubscription({
      leagues,
      txSig: input.txSig,
      walletSignature,
    });
  }

  return {
    activatedAt: new Date().toISOString(),
    apiToken,
    durationWeeks: input.durationWeeks,
    network: input.config.network,
    serviceLevelId: input.serviceLevelId,
    subscriptionTxSignature: input.txSig,
    version: 1,
    walletPublicKey: input.wallet.publicKey.toBase58(),
  };
}
