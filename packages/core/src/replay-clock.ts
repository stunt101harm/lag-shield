export type ReplaySpeed = number | 'maximum';
export type ReplayClockState = 'idle' | 'running' | 'paused' | 'stopped';

export interface ReplayTimer {
  nowMs(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export class SystemReplayTimer implements ReplayTimer {
  nowMs(): number {
    return Date.now();
  }

  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(finish, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      function finish() {
        signal.removeEventListener('abort', abort);
        resolve();
      }
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}

export class ReplayStoppedError extends Error {
  constructor() {
    super('Replay clock was stopped.');
    this.name = 'ReplayStoppedError';
  }
}

export type ReplayClockSnapshot = Readonly<{
  logicalNowMs: number | null;
  speed: ReplaySpeed;
  state: ReplayClockState;
}>;

export class VirtualReplayClock {
  readonly #speed: ReplaySpeed;
  readonly #timer: ReplayTimer;
  readonly #resumeWaiters = new Set<() => void>();
  #logicalNowMs: number | null = null;
  #state: ReplayClockState = 'idle';
  #transition = new AbortController();

  constructor(options: Readonly<{ speed: ReplaySpeed; timer?: ReplayTimer }>) {
    if (
      options.speed !== 'maximum' &&
      (!Number.isFinite(options.speed) || options.speed <= 0)
    ) {
      throw new Error('Replay speed must be a positive finite number or maximum.');
    }
    this.#speed = options.speed;
    this.#timer = options.timer ?? new SystemReplayTimer();
  }

  start(sourceTimestampMs: number): void {
    if (this.#state !== 'idle') throw new Error('Replay clock can only be started once.');
    assertTimestamp(sourceTimestampMs);
    this.#logicalNowMs = sourceTimestampMs;
    this.#state = 'running';
  }

  pause(): void {
    if (this.#state !== 'running') return;
    this.#state = 'paused';
    this.#transition.abort(new Error('Replay paused.'));
  }

  resume(): void {
    if (this.#state !== 'paused') return;
    this.#transition = new AbortController();
    this.#state = 'running';
    for (const resume of this.#resumeWaiters) resume();
    this.#resumeWaiters.clear();
  }

  stop(): void {
    if (this.#state === 'stopped') return;
    this.#state = 'stopped';
    this.#transition.abort(new ReplayStoppedError());
    for (const resume of this.#resumeWaiters) resume();
    this.#resumeWaiters.clear();
  }

  snapshot(): ReplayClockSnapshot {
    return {
      logicalNowMs: this.#logicalNowMs === null ? null : Math.floor(this.#logicalNowMs),
      speed: this.#speed,
      state: this.#state,
    };
  }

  async advanceTo(sourceTimestampMs: number): Promise<void> {
    assertTimestamp(sourceTimestampMs);
    if (this.#logicalNowMs === null)
      throw new Error('Replay clock has not been started.');
    if (sourceTimestampMs < this.#logicalNowMs) {
      throw new Error('Replay clock cannot move backwards.');
    }

    while (this.#logicalNowMs < sourceTimestampMs) {
      await this.#waitUntilRunning();
      if (this.#speed === 'maximum') {
        this.#logicalNowMs = sourceTimestampMs;
        return;
      }

      const remainingSourceMs = sourceTimestampMs - this.#logicalNowMs;
      const requestedWallMs = remainingSourceMs / this.#speed;
      const wallStartedAtMs = this.#timer.nowMs();
      const signal = this.#transition.signal;
      try {
        await this.#timer.sleep(requestedWallMs, signal);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
      const elapsedWallMs = Math.max(0, this.#timer.nowMs() - wallStartedAtMs);
      this.#logicalNowMs += Math.min(remainingSourceMs, elapsedWallMs * this.#speed);
    }
  }

  async #waitUntilRunning(): Promise<void> {
    this.#throwIfStopped();
    if (this.#state === 'idle') throw new Error('Replay clock has not been started.');
    if (this.#state === 'running') return;
    await new Promise<void>((resolve) => this.#resumeWaiters.add(resolve));
    this.#throwIfStopped();
  }

  #throwIfStopped(): void {
    if (this.#state === 'stopped') throw new ReplayStoppedError();
  }
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Replay timestamp must be a non-negative safe integer.');
  }
}
