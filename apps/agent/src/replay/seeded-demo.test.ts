import { describe, expect, it } from 'vitest';

import { createSeededDemoBundle, runSeededDemo } from './seeded-demo.js';

describe('seeded replay demo', () => {
  it('is byte-for-byte deterministic and clearly labeled as simulation', () => {
    expect(createSeededDemoBundle()).toEqual(createSeededDemoBundle());
    const bundle = createSeededDemoBundle();
    expect(bundle.manifest.source).toMatchObject({
      dataMode: 'seeded-simulation',
      scorePath: null,
    });
    expect(bundle.events.every(({ source }) => source === 'simulation')).toBe(true);
  });

  it('runs the normal replay path in canonical order and an isolated namespace', async () => {
    const { result, trace } = await runSeededDemo({ runId: 'judge-demo' });

    expect(result).toMatchObject({
      eventCount: 5,
      namespace: 'replay:judge-demo',
      runId: 'judge-demo',
    });
    expect(trace.map(({ logicalTimestampMs }) => logicalTimestampMs)).toEqual(
      [...trace.map(({ logicalTimestampMs }) => logicalTimestampMs)].sort(
        (left, right) => left - right,
      ),
    );
    expect(trace.every(({ namespace }) => namespace === 'replay:judge-demo')).toBe(true);
  });
});
