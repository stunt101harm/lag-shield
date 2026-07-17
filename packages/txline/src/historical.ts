export const historicalOddsIntervalMs = 5 * 60 * 1_000;
export const epochDayMs = 24 * 60 * 60 * 1_000;

export type HistoricalOddsInterval = Readonly<{
  endMs: number;
  epochDay: number;
  hourOfDay: number;
  interval: number;
  startMs: number;
}>;

function assertTimestamp(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer timestamp.`);
  }
}

export function historicalOddsIntervalAt(timestampMs: number): HistoricalOddsInterval {
  assertTimestamp('timestampMs', timestampMs);
  const startMs =
    Math.floor(timestampMs / historicalOddsIntervalMs) * historicalOddsIntervalMs;
  const epochDay = Math.floor(startMs / epochDayMs);
  const millisecondsWithinDay = startMs - epochDay * epochDayMs;
  const hourOfDay = Math.floor(millisecondsWithinDay / (60 * 60 * 1_000));
  const interval = Math.floor(
    (millisecondsWithinDay - hourOfDay * 60 * 60 * 1_000) / historicalOddsIntervalMs,
  );
  return {
    endMs: startMs + historicalOddsIntervalMs,
    epochDay,
    hourOfDay,
    interval,
    startMs,
  };
}

export function assertHistoricalOddsInterval(interval: HistoricalOddsInterval): void {
  const canonical = historicalOddsIntervalAt(interval.startMs);
  if (
    canonical.endMs !== interval.endMs ||
    canonical.epochDay !== interval.epochDay ||
    canonical.hourOfDay !== interval.hourOfDay ||
    canonical.interval !== interval.interval
  ) {
    throw new Error('Historical odds interval coordinates are not canonical.');
  }
}

export function planHistoricalOddsIntervals(
  input: Readonly<{
    endMs: number;
    startMs: number;
  }>,
): readonly HistoricalOddsInterval[] {
  assertTimestamp('startMs', input.startMs);
  assertTimestamp('endMs', input.endMs);
  if (input.endMs < input.startMs) throw new Error('endMs must not be before startMs.');
  const first = historicalOddsIntervalAt(input.startMs).startMs;
  const last = historicalOddsIntervalAt(input.endMs).startMs;
  const count = (last - first) / historicalOddsIntervalMs + 1;
  if (count > 10_000) {
    throw new Error('Historical odds range exceeds the 10,000-interval safety limit.');
  }
  return Array.from({ length: count }, (_, index) =>
    historicalOddsIntervalAt(first + index * historicalOddsIntervalMs),
  );
}
