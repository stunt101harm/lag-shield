import { describe, expect, it } from 'vitest';

import { foundationStatus } from './foundation';

describe('foundationStatus', () => {
  it('captures the workspace readiness contract', () => {
    expect(foundationStatus).toEqual({
      agent: 'ready',
      ci: 'configured',
      database: 'configured',
      workspace: 'ready',
    });
  });
});
