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

export const agentEnvironmentSchema = z
  .object({
    NODE_ENV: nodeEnvironmentSchema.default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    LOG_LEVEL: logLevelSchema.default('info'),
    HTTP_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(1_048_576)
      .default(65_536),
    HTTP_RATE_LIMIT_MAX: z.coerce.number().int().min(10).max(10_000).default(300),
    DATABASE_URL: z.string().url().startsWith('postgres'),
    PUBLIC_WEB_ORIGIN: z
      .string()
      .min(1)
      .default('http://localhost:3000')
      .transform((value) => value.split(',').map((origin) => origin.trim()))
      .pipe(z.array(z.string().url()).min(1).max(10)),
    PUBLIC_WEB_HOST: z
      .string()
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i)
      .optional(),
    TXLINE_API_TOKEN: z.string().min(1).optional(),
    TXLINE_CREDENTIALS_FILE: z.string().min(1).default('.txline/devnet.credentials.json'),
    TXLINE_CREDENTIALS_SOURCE: z.enum(['file', 'environment']).default('file'),
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
    TXLINE_WALLET_PUBLIC_KEY: z.string().min(32).max(64).optional(),
    RETENTION_PURGE_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(1_000),
    RETENTION_PURGE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(300_000),
  })
  .superRefine((environment, context) => {
    if (
      environment.TXLINE_LIVE_ENABLED &&
      environment.TXLINE_CREDENTIALS_SOURCE === 'environment'
    ) {
      if (!environment.TXLINE_API_TOKEN) {
        context.addIssue({
          code: 'custom',
          message:
            'Required when live ingestion uses provider-managed environment secrets.',
          path: ['TXLINE_API_TOKEN'],
        });
      }
      if (!environment.TXLINE_WALLET_PUBLIC_KEY) {
        context.addIssue({
          code: 'custom',
          message:
            'Required when live ingestion uses provider-managed environment secrets.',
          path: ['TXLINE_WALLET_PUBLIC_KEY'],
        });
      }
    }
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
