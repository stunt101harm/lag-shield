const target = new URL(process.env.LAGSHIELD_API_URL ?? 'http://127.0.0.1:4000');
if (target.username || target.password || target.search || target.hash) {
  throw new Error('LAGSHIELD_API_URL must not contain credentials, query, or fragment.');
}

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

const concurrency = boundedInteger('LOAD_SMOKE_CONCURRENCY', 10, 1, 50);
const requestCount = boundedInteger('LOAD_SMOKE_REQUESTS', 100, 1, 1_000);
const paths = ['/health', '/ready', '/metrics/operations', '/v1/evaluations/seeded'];
const durationsMs: number[] = [];
const failures: { path: string; reason: string }[] = [];
let nextIndex = 0;

async function worker(): Promise<void> {
  while (nextIndex < requestCount) {
    const index = nextIndex;
    nextIndex += 1;
    const path = paths[index % paths.length]!;
    const startedAt = performance.now();
    try {
      const response = await fetch(new URL(path, target), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      await response.arrayBuffer();
      durationsMs.push(performance.now() - startedAt);
      if (!response.ok) {
        failures.push({ path, reason: `http_${response.status}` });
      }
    } catch (error) {
      durationsMs.push(performance.now() - startedAt);
      failures.push({
        path,
        reason: error instanceof Error ? error.name : 'unknown_error',
      });
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
const sorted = durationsMs.toSorted((left, right) => left - right);
const percentile = (fraction: number): number => {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
};
const report = {
  concurrency,
  failureCount: failures.length,
  failures: failures.slice(0, 10),
  latencyMs: {
    maximum: Number((sorted.at(-1) ?? 0).toFixed(2)),
    p50: Number(percentile(0.5).toFixed(2)),
    p95: Number(percentile(0.95).toFixed(2)),
  },
  requestCount,
  target: target.origin,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 1;
