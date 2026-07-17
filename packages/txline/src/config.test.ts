import { describe, expect, it } from 'vitest';

import {
  assertFreeServiceLevel,
  assertSubscriptionDuration,
  getTxLineConfig,
  parseTxLineNetwork,
  supportedTxLineNetworks,
} from './config.js';

describe('TxLINE network configuration', () => {
  it('uses explicit canonical network constants', () => {
    expect(supportedTxLineNetworks).toEqual(['devnet', 'mainnet']);
    expect(getTxLineConfig('devnet')).toMatchObject({
      apiOrigin: 'https://txline-dev.txodds.com',
      genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      programId: '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J',
      tokenMint: '4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG',
    });
    expect(getTxLineConfig('mainnet')).toMatchObject({
      apiOrigin: 'https://txline.txodds.com',
      genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      programId: '9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA',
      tokenMint: 'Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL',
    });
  });

  it('rejects implicit or unsupported networks and tiers', () => {
    expect(() => parseTxLineNetwork('testnet')).toThrow('Unsupported TxLINE network');
    expect(() => assertFreeServiceLevel(getTxLineConfig('devnet'), 12)).toThrow(
      'not a documented devnet World Cup free tier',
    );
    expect(() => assertFreeServiceLevel(getTxLineConfig('mainnet'), 12)).not.toThrow();
  });

  it.each([0, 3, 5, 52, 4.5])('rejects invalid duration %s', (duration) => {
    expect(() => assertSubscriptionDuration(duration)).toThrow('multiple of 4 weeks');
  });
});
