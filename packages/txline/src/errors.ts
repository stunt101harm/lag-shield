export class TxLineApiError extends Error {
  readonly operation: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(options: {
    readonly message: string;
    readonly operation: string;
    readonly retryable?: boolean;
    readonly status: number;
  }) {
    super(options.message);
    this.name = 'TxLineApiError';
    this.operation = options.operation;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export function txLineHttpError(response: Response, operation: string): TxLineApiError {
  if (response.status === 401) {
    return new TxLineApiError({
      message: `TxLINE rejected ${operation} after guest-session renewal (HTTP 401).`,
      operation,
      status: response.status,
    });
  }

  if (response.status === 403) {
    return new TxLineApiError({
      message:
        `TxLINE denied ${operation} (HTTP 403). Verify the API token, network, ` +
        'subscription status, and league bundle.',
      operation,
      status: response.status,
    });
  }

  return new TxLineApiError({
    message: `TxLINE ${operation} failed with HTTP ${response.status}.`,
    operation,
    retryable: response.status === 429 || response.status >= 500,
    status: response.status,
  });
}
