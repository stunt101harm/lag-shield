import { describe, expect, it } from 'vitest';

import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('removes authorization headers, JWTs, API headers, and known values', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature';
    const apiToken = 'secret-api-token';
    const redacted = redactSecrets(
      `Authorization: Bearer ${jwt}, X-Api-Token=${apiToken}, raw=${apiToken}`,
      [apiToken],
    );

    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain(apiToken);
    expect(redacted).toContain('[REDACTED]');
  });
});
