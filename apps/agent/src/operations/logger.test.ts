import { describe, expect, it } from 'vitest';

import { createAgentLoggerOptions, secretRedactionPaths } from './logger.js';

describe('agent logger configuration', () => {
  it('redacts transport credentials and wallet material at the structured logger boundary', () => {
    expect(createAgentLoggerOptions('info')).toEqual({
      level: 'info',
      redact: {
        censor: '[REDACTED]',
        paths: [...secretRedactionPaths],
      },
    });
    expect(secretRedactionPaths).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers["x-api-token"]',
        'privateKey',
        'wallet.secretKey',
      ]),
    );
  });
});
