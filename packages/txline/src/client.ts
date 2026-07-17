import type { TxLineNetworkConfig } from './config.js';
import { txLineHttpError } from './errors.js';
import {
  activationResponseSchema,
  fixtureSnapshotSchema,
  guestSessionSchema,
  isWorldCupFixture,
  type TxLineFixture,
} from './schemas.js';

export type TxLineFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type TxLineStreamKind = 'odds' | 'scores';

export class TxLineApiClient {
  readonly #apiToken: string | undefined;
  readonly #config: TxLineNetworkConfig;
  readonly #fetch: TxLineFetch;
  #jwt: string | undefined;
  #refreshPromise: Promise<string> | undefined;

  constructor(options: {
    readonly apiToken?: string;
    readonly config: TxLineNetworkConfig;
    readonly fetch?: TxLineFetch;
  }) {
    if (options.apiToken !== undefined && options.apiToken.trim().length === 0) {
      throw new Error('TxLINE API token cannot be blank when provided.');
    }

    this.#apiToken = options.apiToken;
    this.#config = options.config;
    this.#fetch = options.fetch ?? fetch;
  }

  async renewGuestSession(): Promise<string> {
    if (!this.#refreshPromise) {
      this.#refreshPromise = this.#startGuestSession().finally(() => {
        this.#refreshPromise = undefined;
      });
    }

    return this.#refreshPromise;
  }

  async fetchFixtures(
    options: {
      readonly competitionId?: number;
      readonly startEpochDay?: number;
    } = {},
  ): Promise<readonly TxLineFixture[]> {
    const url = new URL('/api/fixtures/snapshot', this.#config.apiOrigin);
    if (options.competitionId !== undefined) {
      url.searchParams.set('competitionId', String(options.competitionId));
    }
    if (options.startEpochDay !== undefined) {
      url.searchParams.set('startEpochDay', String(options.startEpochDay));
    }

    const payload = await this.#requestJson(url, 'fixture snapshot');
    return fixtureSnapshotSchema
      .parse(payload)
      .sort((left, right) => left.StartTime - right.StartTime);
  }

  async discoverWorldCupFixtures(): Promise<readonly TxLineFixture[]> {
    const fixtures = await this.fetchFixtures();
    return fixtures.filter(isWorldCupFixture);
  }

  async openDataStream(
    kind: TxLineStreamKind,
    options: Readonly<{ lastEventId?: string; signal?: AbortSignal }> = {},
  ): Promise<Response> {
    if (!this.#apiToken) {
      throw new Error(`A TxLINE API token is required for the ${kind} stream.`);
    }
    const url = new URL(`/api/${kind}/stream`, this.#config.apiOrigin);
    const firstJwt = this.#jwt ?? (await this.renewGuestSession());
    let response = await this.#authorizedFetch(url, firstJwt, {
      accept: 'text/event-stream',
      ...(options.lastEventId ? { lastEventId: options.lastEventId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      const renewedJwt = await this.renewGuestSession();
      response = await this.#authorizedFetch(url, renewedJwt, {
        accept: 'text/event-stream',
        ...(options.lastEventId ? { lastEventId: options.lastEventId } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw txLineHttpError(response, `${kind} stream connection`);
    }
    if (!response.body) {
      throw new Error(`TxLINE ${kind} stream response has no body.`);
    }
    const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('text/event-stream')) {
      await response.body.cancel().catch(() => undefined);
      throw new Error(
        `TxLINE ${kind} stream returned unexpected Content-Type ${contentType || '(missing)'}.`,
      );
    }
    return response;
  }

  async activateSubscription(input: {
    readonly leagues: readonly number[];
    readonly txSig: string;
    readonly walletSignature: string;
  }): Promise<string> {
    if (!this.#jwt) {
      throw new Error(
        'Guest session must be acquired before activation-message signing.',
      );
    }

    const url = new URL('/api/token/activate', this.#config.apiOrigin);
    const response = await this.#fetch(url, {
      body: JSON.stringify(input),
      headers: {
        Authorization: `Bearer ${this.#jwt}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw txLineHttpError(response, 'subscription activation');
    }

    const body = await response.text();
    let payload: unknown = body;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      // TxLINE examples document both a JSON { token } response and a raw token string.
    }
    return activationResponseSchema.parse(payload);
  }

  async #startGuestSession(): Promise<string> {
    const response = await this.#fetch(
      new URL('/auth/guest/start', this.#config.apiOrigin),
      {
        headers: { Accept: 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok) {
      throw txLineHttpError(response, 'guest-session renewal');
    }

    const { token } = guestSessionSchema.parse(await response.json());
    this.#jwt = token;
    return token;
  }

  async #requestJson(url: URL, operation: string): Promise<unknown> {
    if (!this.#apiToken) {
      throw new Error(`A TxLINE API token is required for ${operation}.`);
    }

    const firstJwt = this.#jwt ?? (await this.renewGuestSession());
    let response = await this.#authorizedFetch(url, firstJwt, {
      accept: 'application/json',
    });

    if (response.status === 401) {
      const renewedJwt = await this.renewGuestSession();
      response = await this.#authorizedFetch(url, renewedJwt, {
        accept: 'application/json',
      });
    }

    if (!response.ok) {
      throw txLineHttpError(response, operation);
    }

    return response.json() as Promise<unknown>;
  }

  #authorizedFetch(
    url: URL,
    jwt: string,
    options: Readonly<{
      accept: 'application/json' | 'text/event-stream';
      lastEventId?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<Response> {
    if (!this.#apiToken) {
      throw new Error('A TxLINE API token is required for authorized data requests.');
    }

    const headers: Record<string, string> = {
      Accept: options.accept,
      Authorization: `Bearer ${jwt}`,
      'Cache-Control': 'no-cache',
      'X-Api-Token': this.#apiToken,
    };
    if (options.lastEventId) headers['Last-Event-ID'] = options.lastEventId;

    return this.#fetch(url, {
      headers,
      method: 'GET',
      signal: options.signal ?? AbortSignal.timeout(30_000),
    });
  }
}
