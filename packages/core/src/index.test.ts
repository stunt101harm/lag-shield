import { describe, expect, it } from 'vitest';

import { lagShieldIdentity } from './index.js';

describe('lagShieldIdentity', () => {
  it('exposes a stable strategy identity', () => {
    expect(lagShieldIdentity).toEqual({
      name: 'LagShield',
      strategy: 'proof-backed-market-circuit-breaker',
      version: '0.1.0',
    });
  });
});
