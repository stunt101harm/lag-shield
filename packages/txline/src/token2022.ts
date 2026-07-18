import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);

export function deriveToken2022AssociatedAddress(input: {
  readonly allowOwnerOffCurve?: boolean;
  readonly mint: PublicKey;
  readonly owner: PublicKey;
}): PublicKey {
  if (!input.allowOwnerOffCurve && !PublicKey.isOnCurve(input.owner.toBytes())) {
    throw new Error('Token-2022 associated account owner is off curve.');
  }

  return PublicKey.findProgramAddressSync(
    [input.owner.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), input.mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** Encodes Associated Token Program CreateIdempotent (instruction discriminator 1). */
export function createIdempotentToken2022AssociatedAccountInstruction(input: {
  readonly associatedAccount: PublicKey;
  readonly mint: PublicKey;
  readonly owner: PublicKey;
  readonly payer: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    data: Buffer.from([1]),
    keys: [
      { isSigner: true, isWritable: true, pubkey: input.payer },
      { isSigner: false, isWritable: true, pubkey: input.associatedAccount },
      { isSigner: false, isWritable: false, pubkey: input.owner },
      { isSigner: false, isWritable: false, pubkey: input.mint },
      { isSigner: false, isWritable: false, pubkey: SystemProgram.programId },
      { isSigner: false, isWritable: false, pubkey: TOKEN_2022_PROGRAM_ID },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
  });
}
