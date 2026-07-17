export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  nextId(namespace: string): string;
}

export type DeterminismContext = Readonly<{
  clock: Clock;
  ids: IdGenerator;
}>;

export class FixedClock implements Clock {
  constructor(private readonly value: number) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('FixedClock requires a non-negative integer timestamp.');
    }
  }

  nowMs(): number {
    return this.value;
  }
}

export class SequenceIdGenerator implements IdGenerator {
  #next: number;

  constructor(startAt = 1) {
    if (!Number.isSafeInteger(startAt) || startAt < 0) {
      throw new Error('SequenceIdGenerator requires a non-negative integer start.');
    }
    this.#next = startAt;
  }

  nextId(namespace: string): string {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(namespace)) {
      throw new Error(`Invalid ID namespace: ${namespace}`);
    }
    const id = `${namespace}_${String(this.#next).padStart(12, '0')}`;
    this.#next += 1;
    return id;
  }
}
