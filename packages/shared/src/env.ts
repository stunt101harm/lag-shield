import { z } from 'zod';

const nodeEnvironmentSchema = z.enum(['development', 'test', 'production']);
const logLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

export const agentEnvironmentSchema = z.object({
  NODE_ENV: nodeEnvironmentSchema.default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: logLevelSchema.default('info'),
  DATABASE_URL: z.string().url().startsWith('postgres'),
  PUBLIC_WEB_ORIGIN: z
    .string()
    .min(1)
    .default('http://localhost:3000')
    .transform((value) => value.split(',').map((origin) => origin.trim()))
    .pipe(z.array(z.string().url()).min(1).max(10)),
  TXLINE_CREDENTIALS_FILE: z.string().min(1).default('.txline/devnet.credentials.json'),
  TXLINE_LIVE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  TXLINE_NETWORK: z.enum(['devnet', 'mainnet']).default('devnet'),
  TXLINE_PROOF_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(10_000),
  TXLINE_RPC_URL: z.string().url().optional(),
});

export type AgentEnvironment = z.infer<typeof agentEnvironmentSchema>;

export function parseAgentEnvironment(
  input: NodeJS.ProcessEnv | Record<string, string | undefined>,
): AgentEnvironment {
  const result = agentEnvironmentSchema.safeParse(input);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ');

    throw new Error(`Invalid agent environment: ${details}`);
  }

  return result.data;
}
