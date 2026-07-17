import fastify, { type FastifyInstance } from 'fastify';

import type { LiveIngestionSnapshot } from './ingest/live-txline.js';

export type BuildAppOptions = Readonly<{
  getLiveIngestionSnapshot?: () => LiveIngestionSnapshot | null;
  logger?: boolean | { level: string };
}>;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = fastify({
    logger: options.logger ?? false,
  });

  app.get('/health', async () => ({
    service: 'lagshield-agent',
    status: 'ok',
    version: '0.1.0',
  }));

  app.get('/metrics/streams', async () => {
    const snapshot = options.getLiveIngestionSnapshot?.() ?? null;
    return snapshot ? { enabled: true, ...snapshot } : { enabled: false };
  });

  return app;
}
