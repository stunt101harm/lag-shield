import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

let app: ReturnType<typeof buildApp> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('agent health endpoint', () => {
  it('reports a stable service identity', async () => {
    app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: 'lagshield-agent',
      status: 'ok',
      version: '0.1.0',
    });
  });
});
