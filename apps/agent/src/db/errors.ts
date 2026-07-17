export class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was reused for a different payload.`);
    this.name = 'IdempotencyConflictError';
  }
}

export class ConcurrentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentStateError';
  }
}
