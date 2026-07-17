import { describe, expect, it } from 'vitest';

import { supportedTxLineNetworks } from './index.js';

describe('supportedTxLineNetworks', () => {
  it('requires an explicit Solana network', () => {
    expect(supportedTxLineNetworks).toEqual(['devnet', 'mainnet']);
  });
});
