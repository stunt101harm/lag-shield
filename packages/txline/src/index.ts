export const supportedTxLineNetworks = ['devnet', 'mainnet'] as const;

export type TxLineNetwork = (typeof supportedTxLineNetworks)[number];
