import { Container, getContainer, type StopParams } from '@cloudflare/containers';
import type { DurableObject } from 'cloudflare:workers';

interface Bindings {
  ASSETS: Fetcher;
  DATABASE_URL?: string;
  LAGSHIELD_AGENT: DurableObjectNamespace<LagShieldAgent>;
  PUBLIC_WEB_ORIGIN?: string;
  TXLINE_API_TOKEN?: string;
  TXLINE_LIVE_ENABLED?: string;
  TXLINE_RPC_URL?: string;
  TXLINE_WALLET_PUBLIC_KEY?: string;
}

const instanceName = 'primary';

function requireSecret(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required Cloudflare Worker secret: ${name}`);
  }
  return value;
}

function optionalEnvironment(
  values: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
}

/**
 * One named instance owns every TxLINE stream and market transition. Running multiple
 * instances would violate the single-writer ingestion contract, so max_instances is one.
 */
export class LagShieldAgent extends Container<Bindings> {
  override defaultPort = 4000;
  override requiredPorts = [4000];
  override sleepAfter = '5m';
  override pingEndpoint = 'localhost/health';

  constructor(ctx: DurableObject['ctx'], env: Bindings) {
    super(ctx, env);
    this.envVars = {
      DATABASE_URL: requireSecret(env.DATABASE_URL, 'DATABASE_URL'),
      HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
      NODE_ENV: 'production',
      PORT: '4000',
      PUBLIC_WEB_ORIGIN: requireSecret(env.PUBLIC_WEB_ORIGIN, 'PUBLIC_WEB_ORIGIN'),
      RETENTION_PURGE_INTERVAL_MS: '3600000',
      TXLINE_CREDENTIALS_SOURCE: 'environment',
      TXLINE_LIVE_ENABLED: env.TXLINE_LIVE_ENABLED ?? 'false',
      TXLINE_NETWORK: 'devnet',
      ...optionalEnvironment({
        TXLINE_API_TOKEN: env.TXLINE_API_TOKEN,
        TXLINE_RPC_URL: env.TXLINE_RPC_URL,
        TXLINE_WALLET_PUBLIC_KEY: env.TXLINE_WALLET_PUBLIC_KEY,
      }),
    };
  }

  /** The agent is an autonomous stream processor, so inactivity must not put it to sleep. */
  override onActivityExpired(): Promise<void> {
    return Promise.resolve();
  }

  override onError(error: unknown): void {
    console.error('LagShield container error', error);
  }

  override onStop({ exitCode, reason }: StopParams): void {
    if (exitCode !== 0) {
      console.error('LagShield container stopped unexpectedly', { exitCode, reason });
    }
  }
}

const worker: ExportedHandler<Bindings> = {
  async fetch(request, env): Promise<Response> {
    return getContainer(env.LAGSHIELD_AGENT, instanceName).fetch(request);
  },

  async scheduled(_controller, env): Promise<void> {
    await getContainer(env.LAGSHIELD_AGENT, instanceName).startAndWaitForPorts({
      cancellationOptions: { portReadyTimeoutMS: 120_000 },
      ports: [4000],
    });
  },
};

export default worker;
