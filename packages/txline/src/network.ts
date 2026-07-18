import type { Connection } from '@solana/web3.js';

import type { TxLineNetworkConfig } from './config.js';

export async function assertRpcNetwork(
  connection: Pick<Connection, 'getGenesisHash'>,
  config: TxLineNetworkConfig,
): Promise<void> {
  const actualGenesisHash = await connection.getGenesisHash();
  if (actualGenesisHash !== config.genesisHash) {
    throw new Error(
      `RPC genesis hash does not match TxLINE ${config.network}; refusing to construct or sign a transaction.`,
    );
  }
}
