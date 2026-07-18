import { PublicKey } from '@solana/web3.js';

export const supportedTxLineNetworks = ['devnet', 'mainnet'] as const;

export type TxLineNetwork = (typeof supportedTxLineNetworks)[number];

export type TxLineNetworkConfig = {
  readonly apiOrigin: string;
  readonly defaultServiceLevelId: number;
  readonly freeServiceLevelIds: readonly number[];
  readonly genesisHash: string;
  readonly network: TxLineNetwork;
  readonly programId: string;
  readonly rpcUrl: string;
  readonly tokenMint: string;
};

const networkConfigs = {
  devnet: {
    apiOrigin: 'https://txline-dev.txodds.com',
    defaultServiceLevelId: 1,
    freeServiceLevelIds: [1],
    genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    network: 'devnet',
    programId: '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J',
    rpcUrl: 'https://api.devnet.solana.com',
    tokenMint: '4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG',
  },
  mainnet: {
    apiOrigin: 'https://txline.txodds.com',
    defaultServiceLevelId: 12,
    freeServiceLevelIds: [1, 12],
    genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    network: 'mainnet',
    programId: '9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    tokenMint: 'Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL',
  },
} as const satisfies Record<TxLineNetwork, TxLineNetworkConfig>;

for (const config of Object.values(networkConfigs)) {
  new URL(config.apiOrigin);
  new URL(config.rpcUrl);
  new PublicKey(config.programId);
  new PublicKey(config.tokenMint);
}

export function parseTxLineNetwork(value: string | undefined): TxLineNetwork {
  const candidate = value ?? 'devnet';
  if (!supportedTxLineNetworks.some((network) => network === candidate)) {
    throw new Error(`Unsupported TxLINE network: ${candidate}. Use devnet or mainnet.`);
  }

  return candidate as TxLineNetwork;
}

export function getTxLineConfig(
  network: TxLineNetwork,
  options: { readonly rpcUrl?: string } = {},
): TxLineNetworkConfig {
  const canonical = networkConfigs[network];
  const rpcUrl = options.rpcUrl ?? canonical.rpcUrl;
  new URL(rpcUrl);

  return { ...canonical, rpcUrl };
}

export function assertFreeServiceLevel(
  config: TxLineNetworkConfig,
  serviceLevelId: number,
): void {
  if (
    !Number.isSafeInteger(serviceLevelId) ||
    !config.freeServiceLevelIds.includes(serviceLevelId)
  ) {
    throw new Error(
      `Service level ${serviceLevelId} is not a documented ${config.network} World Cup free tier. ` +
        `Allowed: ${config.freeServiceLevelIds.join(', ')}.`,
    );
  }
}

export function assertSubscriptionDuration(durationWeeks: number): void {
  if (
    !Number.isSafeInteger(durationWeeks) ||
    durationWeeks < 4 ||
    durationWeeks > 48 ||
    durationWeeks % 4 !== 0
  ) {
    throw new Error(
      'Subscription duration must be a multiple of 4 weeks between 4 and 48.',
    );
  }
}
