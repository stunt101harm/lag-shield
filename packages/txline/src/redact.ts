const jwtPattern = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const authorizationPattern = /(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/gi;
const apiTokenPattern = /(x-api-token\s*[:=]\s*)[^\s,}]+/gi;

export function redactSecrets(value: string, secrets: readonly string[] = []): string {
  let result = value
    .replace(authorizationPattern, '$1[REDACTED]')
    .replace(apiTokenPattern, '$1[REDACTED]')
    .replace(jwtPattern, '[REDACTED_JWT]');

  for (const secret of secrets) {
    if (secret.length >= 8) {
      result = result.replaceAll(secret, '[REDACTED]');
    }
  }

  return result;
}

export function safeErrorMessage(
  error: unknown,
  secrets: readonly string[] = [],
): string {
  return redactSecrets(error instanceof Error ? error.message : String(error), secrets);
}
