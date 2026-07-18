export type OperationalMetricsSnapshot = Readonly<{
  process: Readonly<{
    heapUsedBytes: number;
    residentSetBytes: number;
    uptimeMs: number;
  }>;
  requests: Readonly<{
    active: number;
    clientErrors: number;
    maximumDurationMs: number;
    serverErrors: number;
    total: number;
    totalDurationMs: number;
  }>;
  startedAtMs: number;
}>;

export interface OperationalMetricsPort {
  snapshot(): OperationalMetricsSnapshot;
  startRequest(): (statusCode: number) => void;
}

export class OperationalMetrics implements OperationalMetricsPort {
  readonly #nowMs: () => number;
  readonly #startedAtMs: number;
  #active = 0;
  #clientErrors = 0;
  #maximumDurationMs = 0;
  #serverErrors = 0;
  #total = 0;
  #totalDurationMs = 0;

  constructor(nowMs: () => number = Date.now) {
    this.#nowMs = nowMs;
    this.#startedAtMs = nowMs();
  }

  startRequest(): (statusCode: number) => void {
    const startedAtMs = this.#nowMs();
    let finished = false;
    this.#active += 1;
    this.#total += 1;

    return (statusCode) => {
      if (finished) return;
      finished = true;
      this.#active = Math.max(0, this.#active - 1);
      const durationMs = Math.max(0, this.#nowMs() - startedAtMs);
      this.#totalDurationMs += durationMs;
      this.#maximumDurationMs = Math.max(this.#maximumDurationMs, durationMs);
      if (statusCode >= 500) this.#serverErrors += 1;
      else if (statusCode >= 400) this.#clientErrors += 1;
    };
  }

  snapshot(): OperationalMetricsSnapshot {
    const memory = process.memoryUsage();
    return {
      process: {
        heapUsedBytes: memory.heapUsed,
        residentSetBytes: memory.rss,
        uptimeMs: Math.max(0, this.#nowMs() - this.#startedAtMs),
      },
      requests: {
        active: this.#active,
        clientErrors: this.#clientErrors,
        maximumDurationMs: this.#maximumDurationMs,
        serverErrors: this.#serverErrors,
        total: this.#total,
        totalDurationMs: this.#totalDurationMs,
      },
      startedAtMs: this.#startedAtMs,
    };
  }
}
