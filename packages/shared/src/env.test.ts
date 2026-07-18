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
      HTTP_BODY_LIMIT_BYTES: 65_536,
      HTTP_RATE_LIMIT_MAX: 300,
      DATABASE_URL: 'postgresql://lagshield:lagshield@localhost:5432/lagshield',
      PUBLIC_WEB_ORIGIN: ['http://localhost:3000'],
      RETENTION_PURGE_BATCH_SIZE: 1_000,
      RETENTION_PURGE_INTERVAL_MS: 300_000,
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

  it('accepts bounded public API and retention controls', () => {
    expect(
      parseAgentEnvironment({
        DATABASE_URL: 'postgresql://localhost/lagshield',
        HTTP_BODY_LIMIT_BYTES: '32768',
        HTTP_RATE_LIMIT_MAX: '120',
        RETENTION_PURGE_BATCH_SIZE: '250',
        RETENTION_PURGE_INTERVAL_MS: '60000',
      }),
    ).toMatchObject({
      HTTP_BODY_LIMIT_BYTES: 32_768,
      HTTP_RATE_LIMIT_MAX: 120,
      RETENTION_PURGE_BATCH_SIZE: 250,
      RETENTION_PURGE_INTERVAL_MS: 60_000,
    });

    expect(() =>
      parseAgentEnvironment({
        DATABASE_URL: 'postgresql://localhost/lagshield',
        HTTP_BODY_LIMIT_BYTES: '10000000',
      }),
    ).toThrow('Invalid agent environment');
  });

  it('coerces a valid port', () => {
    const environment = parseAgentEnvironment({
      DATABASE_URL: 'postgresql://localhost/lagshield',
      PORT: '4100',
    });

    expect(environment.PORT).toBe(4100);
  });

  it('accepts a bounded comma-separated web origin allowlist', () => {
    expect(
      parseAgentEnvironment({
        DATABASE_URL: 'postgresql://localhost/lagshield',
        PUBLIC_WEB_ORIGIN: 'https://lagshield.example, http://localhost:3000',
      }).PUBLIC_WEB_ORIGIN,
    ).toEqual(['https://lagshield.example', 'http://localhost:3000']);
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
