import { PublicKey } from '@solana/web3.js';

import type { TxLineNetworkConfig } from './config.js';

/**
 * Minimal audited artifact for the only on-chain instruction LagShield signs.
 * Source: txodds/tx-on-chain@3a1d6f0, IDL v1.5.6 (2026-07-17).
 */
export const txLineSubscriptionArtifact = {
  accountNames: [
    'user',
    'pricing_matrix',
    'token_mint',
    'user_token_account',
    'token_treasury_vault',
    'token_treasury_pda',
    'token_program',
    'system_program',
    'associated_token_program',
  ],
  discriminator: [254, 28, 191, 138, 156, 179, 183, 53],
  idlVersion: '1.5.6',
  pricingMatrixSeed: 'pricing_matrix',
  programIds: {
    devnet: '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J',
    mainnet: '9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA',
  },
  sourceCommit: '3a1d6f0cfc34ce173f0778023d2332161359196d',
  sourceUrl: 'https://github.com/txodds/tx-on-chain',
  tokenTreasurySeed: 'token_treasury_v2',
} as const;

export function assertSubscriptionArtifact(config: TxLineNetworkConfig): void {
  const artifactProgram = new PublicKey(
    txLineSubscriptionArtifact.programIds[config.network],
  );
  const configuredProgram = new PublicKey(config.programId);

  if (!artifactProgram.equals(configuredProgram)) {
    throw new Error(
      `TxLINE subscription artifact/program mismatch for ${config.network}; refusing to sign.`,
    );
  }
}
