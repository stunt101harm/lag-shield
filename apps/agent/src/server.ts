import { parseAgentEnvironment } from '@lagshield/shared';
import { config as loadEnvironment } from 'dotenv';
import { fileURLToPath } from 'node:url';

import { buildApp } from './app.js';

loadEnvironment({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});

const environment = parseAgentEnvironment(process.env);
const app = buildApp({ logger: { level: environment.LOG_LEVEL } });

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, 'Shutting down LagShield agent');
  await app.close();
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await app.listen({ host: environment.HOST, port: environment.PORT });
} catch (error) {
  app.log.error(error, 'Failed to start LagShield agent');
  process.exitCode = 1;
}
