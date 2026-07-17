import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { assertSubscriptionArtifact, txLineSubscriptionArtifact } from './artifact.js';
import { TxLineApiClient, type TxLineFetch } from './client.js';
import { getTxLineConfig } from './config.js';
import { assertRpcNetwork } from './network.js';
import {
  activateConfirmedSubscription,
  createActivationMessage,
  createSubscriptionInstruction,
  signActivationMessage,
} from './subscription.js';

describe('TxLINE subscription safety', () => {
  it('encodes the audited discriminator and arguments in the expected account order', () => {
    const wallet = Keypair.generate();
    const { instruction } = createSubscriptionInstruction({
      config: getTxLineConfig('devnet'),
      durationWeeks: 4,
      serviceLevelId: 1,
      user: wallet.publicKey,
    });

    expect([...instruction.data.subarray(0, 8)]).toEqual(
      txLineSubscriptionArtifact.discriminator,
    );
    expect(instruction.data.readUInt16LE(8)).toBe(1);
    expect(instruction.data.readUInt8(10)).toBe(4);
    expect(instruction.keys).toHaveLength(txLineSubscriptionArtifact.accountNames.length);
    expect(instruction.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
  });

  it('fails closed on artifact/program or RPC/network mismatch', async () => {
    const devnet = getTxLineConfig('devnet');
    expect(() =>
      assertSubscriptionArtifact({
        ...devnet,
        programId: getTxLineConfig('mainnet').programId,
      }),
    ).toThrow('artifact/program mismatch');
    await expect(
      assertRpcNetwork({ getGenesisHash: async () => 'wrong-network' }, devnet),
    ).rejects.toThrow('RPC genesis hash does not match');
  });

  it('signs the documented activation payload including the empty league separator', () => {
    const wallet = Keypair.generate();
    const message = createActivationMessage('tx-sig', [], 'guest-jwt');
    const signature = Buffer.from(
      signActivationMessage('tx-sig', [], 'guest-jwt', wallet),
      'base64',
    );

    expect(new TextDecoder().decode(message)).toBe('tx-sig::guest-jwt');
    expect(
      nacl.sign.detached.verify(message, signature, wallet.publicKey.toBytes()),
    ).toBe(true);
  });

  it('renews, re-signs, and retries activation once after HTTP 401', async () => {
    const responses = [
      new Response(JSON.stringify({ token: 'first-jwt' })),
      new Response('{}', { status: 401 }),
      new Response(JSON.stringify({ token: 'second-jwt' })),
      new Response(JSON.stringify({ token: 'private-api-token' })),
    ];
    const fetchMock: TxLineFetch = async () => {
      const response = responses.shift();
      if (!response) throw new Error('Unexpected request');
      return response;
    };
    const config = getTxLineConfig('devnet');
    const apiClient = new TxLineApiClient({ config, fetch: fetchMock });
    const wallet = Keypair.generate();

    const recovered = await activateConfirmedSubscription({
      apiClient,
      config,
      durationWeeks: 4,
      serviceLevelId: 1,
      txSig: 'confirmed-transaction',
      wallet,
    });

    expect(recovered).toMatchObject({
      apiToken: 'private-api-token',
      subscriptionTxSignature: 'confirmed-transaction',
      walletPublicKey: wallet.publicKey.toBase58(),
    });
    expect(responses).toHaveLength(0);
  });
});
