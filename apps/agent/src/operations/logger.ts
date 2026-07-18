export const secretRedactionPaths = Object.freeze([
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-token"]',
  'res.headers["set-cookie"]',
  'apiToken',
  'guestToken',
  'jwt',
  'privateKey',
  'secretKey',
  'wallet.privateKey',
  'wallet.secretKey',
]);

export function createAgentLoggerOptions(level: string) {
  return {
    level,
    redact: {
      censor: '[REDACTED]',
      paths: [...secretRedactionPaths],
    },
  };
}
