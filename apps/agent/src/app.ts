import fastify, { type FastifyInstance } from 'fastify';

export type BuildAppOptions = Readonly<{
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

  return app;
}
