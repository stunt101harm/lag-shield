import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createIdempotentToken2022AssociatedAccountInstruction,
  deriveToken2022AssociatedAddress,
} from './token2022.js';

describe('minimal audited Token-2022 helpers', () => {
  it('matches the official SPL helper for a fixed owner and devnet mint', () => {
    const owner = new PublicKey('GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB');
    const mint = new PublicKey('4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG');

    expect(deriveToken2022AssociatedAddress({ mint, owner }).toBase58()).toBe(
      'FC54YqghhxtXp4kmmH2KbPMsjcqdbyz2mrtqb9gVwQNd',
    );
  });

  it('encodes Associated Token Program CreateIdempotent exactly', () => {
    const payer = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const associatedAccount = deriveToken2022AssociatedAddress({ mint, owner });
    const instruction = createIdempotentToken2022AssociatedAccountInstruction({
      associatedAccount,
      mint,
      owner,
      payer,
    });

    expect(instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect([...instruction.data]).toEqual([1]);
    expect(instruction.keys.map(({ pubkey }) => pubkey.toBase58())).toEqual([
      payer.toBase58(),
      associatedAccount.toBase58(),
      owner.toBase58(),
      mint.toBase58(),
      SystemProgram.programId.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
    ]);
    expect(instruction.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(instruction.keys[1]).toMatchObject({ isSigner: false, isWritable: true });
  });
});
