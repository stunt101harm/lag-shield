import { describe, expect, it } from 'vitest';
import {
  renderStrategyEvaluationMarkdown,
  verifyStrategyEvaluationReport,
} from '@lagshield/core';
import { readFileSync } from 'node:fs';

import { createSeededEvaluationReport } from './strategy-evaluation.js';

describe('deterministic strategy evaluation', () => {
  it('measures the seeded lag window, protection lifecycle, control, and proxy', () => {
    const report = createSeededEvaluationReport();

    expect(report.metrics).toMatchObject({
      avoidedPriceErrorProxy: {
        evaluatedOrderCount: 1,
        label: 'absolute-probability-distance-proxy-not-pnl',
        maxErrorMicros: 200_000,
        meanErrorMicros: 200_000,
        rejectedOrderCount: 1,
      },
      eventToFirstConsensusMoveLatencyMs: 8_000,
      flappingCount: 0,
      normalPlayControl: {
        decisionCount: 1,
        durationMs: 59_000,
        restrictiveTransitionCount: 0,
      },
      pauseDurationMs: 12_000,
      protectiveSignalCount: 1,
      staleExposureDurationMs: 8_000,
      stateTransitionCount: 3,
      timeToReopenMs: 18_000,
    });
    expect(report.diagnostics).toMatchObject({
      falsePauseStatus: 'indeterminate_unconfirmed',
      overlongPauseMs: 0,
      signalKind: 'goal',
    });
    expect(report.metrics.bookmakerReactionLatencies).toEqual([
      {
        bookmakerId: 'consensus',
        firstReactionEventId: report.diagnostics.firstMaterialMoveEventId,
        latencyMs: 8_000,
      },
    ]);
  });

  it('is byte-stable across repeated runs and reports threshold sensitivity', () => {
    const first = createSeededEvaluationReport();
    const second = createSeededEvaluationReport();

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.evaluationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.sensitivity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          finalState: 'OPEN',
          label: 'faster-recovery-2-updates',
          timeToReopenMs: 15_000,
        }),
        expect.objectContaining({
          finalState: 'RECOVERY',
          label: 'conservative-recovery-4-updates',
          timeToReopenMs: null,
        }),
      ]),
    );
    const golden = JSON.parse(
      readFileSync(
        new URL('../../../../docs/evaluation/golden-seeded.json', import.meta.url),
        'utf8',
      ),
    );
    expect(first).toEqual(golden);
    expect(() =>
      verifyStrategyEvaluationReport({ ...first, fixtureId: 'tampered-fixture' }),
    ).toThrow('hash is not canonical');
  });

  it('renders a judge-readable report without profitability claims', () => {
    const markdown = renderStrategyEvaluationMarkdown(createSeededEvaluationReport());

    expect(markdown).toContain('8,000 ms');
    expect(markdown).toContain('20.0 pp');
    expect(markdown).toContain('not P&L');
    expect(markdown).toContain('seeded-simulation');
    expect(markdown).not.toContain('profit protected');
  });
});
