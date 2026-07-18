import { describe, expect, it } from 'vitest';

import {
  historicalOddsIntervalAt,
  historicalOddsIntervalMs,
  planHistoricalOddsIntervals,
} from './historical.js';

describe('historical odds interval planning', () => {
  it('maps UTC timestamps to TxLINE epoch-day/hour/five-minute coordinates', () => {
    const timestamp = Date.parse('2026-07-15T23:58:30.000Z');

    expect(historicalOddsIntervalAt(timestamp)).toEqual({
      endMs: Date.parse('2026-07-16T00:00:00.000Z'),
      epochDay: Math.floor(timestamp / 86_400_000),
      hourOfDay: 23,
      interval: 11,
      startMs: Date.parse('2026-07-15T23:55:00.000Z'),
    });
  });

  it('plans every intersecting bucket across a UTC day boundary', () => {
    const intervals = planHistoricalOddsIntervals({
      endMs: Date.parse('2026-07-16T00:02:00.000Z'),
      startMs: Date.parse('2026-07-15T23:58:00.000Z'),
    });

    expect(intervals).toHaveLength(2);
    expect(intervals.map(({ hourOfDay, interval }) => [hourOfDay, interval])).toEqual([
      [23, 11],
      [0, 0],
    ]);
    expect(intervals[1]!.startMs - intervals[0]!.startMs).toBe(historicalOddsIntervalMs);
  });

  it('rejects reversed and unbounded source ranges', () => {
    expect(() => planHistoricalOddsIntervals({ endMs: 1, startMs: 2 })).toThrow(
      'endMs must not be before startMs',
    );
    expect(() =>
      planHistoricalOddsIntervals({
        endMs: 10_001 * historicalOddsIntervalMs,
        startMs: 0,
      }),
    ).toThrow('10,000-interval safety limit');
  });
});
