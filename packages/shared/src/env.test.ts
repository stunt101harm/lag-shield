import { describe, expect, it } from 'vitest';

import { parseAgentEnvironment } from './env.js';

describe('parseAgentEnvironment', () => {
  it('applies safe local defaults', () => {
    expect(
      parseAgentEnvironment({
        DATABASE_URL: 'postgresql://lagshield:lagshield@localhost:5432/lagshield',
      }),
    ).toEqual({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 4000,
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgresql://lagshield:lagshield@localhost:5432/lagshield',
      TXLINE_CREDENTIALS_FILE: '.txline/devnet.credentials.json',
      TXLINE_LIVE_ENABLED: false,
      TXLINE_NETWORK: 'devnet',
      TXLINE_PROOF_INTERVAL_MS: 10_000,
    });
  });

  it('accepts a bounded proof interval and custom Solana RPC', () => {
    expect(
      parseAgentEnvironment({
        DATABASE_URL: 'postgresql://localhost/lagshield',
        TXLINE_PROOF_INTERVAL_MS: '2500',
        TXLINE_RPC_URL: 'https://rpc.example.com',
      }),
    ).toMatchObject({
      TXLINE_PROOF_INTERVAL_MS: 2_500,
      TXLINE_RPC_URL: 'https://rpc.example.com',
    });
  });

  it('coerces a valid port', () => {
    const environment = parseAgentEnvironment({
      DATABASE_URL: 'postgresql://localhost/lagshield',
      PORT: '4100',
    });

    expect(environment.PORT).toBe(4100);
  });

  it('rejects missing database configuration', () => {
    expect(() => parseAgentEnvironment({})).toThrow('Invalid agent environment');
  });

  it('rejects non-PostgreSQL URLs', () => {
    expect(() =>
      parseAgentEnvironment({ DATABASE_URL: 'https://example.com/database' }),
    ).toThrow('Invalid agent environment');
  });

  it('enables live ingestion only from an explicit boolean string', () => {
    expect(
      parseAgentEnvironment({
        DATABASE_URL: 'postgresql://localhost/lagshield',
        TXLINE_LIVE_ENABLED: 'true',
        TXLINE_NETWORK: 'mainnet',
      }),
    ).toMatchObject({ TXLINE_LIVE_ENABLED: true, TXLINE_NETWORK: 'mainnet' });
    expect(() =>
      parseAgentEnvironment({
        DATABASE_URL: 'postgresql://localhost/lagshield',
        TXLINE_LIVE_ENABLED: 'yes',
      }),
    ).toThrow('Invalid agent environment');
  });
});
