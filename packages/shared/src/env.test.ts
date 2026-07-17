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
});
