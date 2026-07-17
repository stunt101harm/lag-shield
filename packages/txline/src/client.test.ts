import { describe, expect, it, vi } from 'vitest';

import { TxLineApiClient, type TxLineFetch } from './client.js';
import { getTxLineConfig } from './config.js';
import { TxLineApiError } from './errors.js';

const fixture = {
  Competition: 'FIFA World Cup',
  CompetitionId: 72,
  FixtureGroupId: 10,
  FixtureId: 123,
  GameState: 1,
  Participant1: 'Canada',
  Participant1Id: 1,
  Participant1IsHome: true,
  Participant2: 'Japan',
  Participant2Id: 2,
  StartTime: 1_800_000_000_000,
  Ts: 1_799_000_000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

describe('TxLineApiClient', () => {
  it('gets one guest session for concurrent callers', async () => {
    const fetchMock = vi
      .fn<TxLineFetch>()
      .mockResolvedValue(jsonResponse({ token: 'guest-jwt' }));
    const client = new TxLineApiClient({
      config: getTxLineConfig('devnet'),
      fetch: fetchMock,
    });

    await Promise.all([client.renewGuestSession(), client.renewGuestSession()]);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('renews once after 401 and returns typed World Cup fixtures', async () => {
    const fetchMock = vi
      .fn<TxLineFetch>()
      .mockResolvedValueOnce(jsonResponse({ token: 'first-jwt' }))
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ token: 'second-jwt' }))
      .mockResolvedValueOnce(
        jsonResponse([
          fixture,
          { ...fixture, Competition: 'International Friendlies', FixtureId: 124 },
        ]),
      );
    const client = new TxLineApiClient({
      apiToken: 'private-api-token',
      config: getTxLineConfig('devnet'),
      fetch: fetchMock,
    });

    const fixtures = await client.discoverWorldCupFixtures();

    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]?.FixtureId).toBe(123);
    const finalRequest = fetchMock.mock.calls[3];
    expect(new Headers(finalRequest?.[1]?.headers).get('Authorization')).toBe(
      'Bearer second-jwt',
    );
    expect(new Headers(finalRequest?.[1]?.headers).get('X-Api-Token')).toBe(
      'private-api-token',
    );
  });

  it('turns 403 into an actionable error without reading the response body', async () => {
    const fetchMock = vi
      .fn<TxLineFetch>()
      .mockResolvedValueOnce(jsonResponse({ token: 'guest-jwt' }))
      .mockResolvedValueOnce(jsonResponse({ apiToken: 'must-not-leak' }, 403));
    const client = new TxLineApiClient({
      apiToken: 'private-api-token',
      config: getTxLineConfig('mainnet'),
      fetch: fetchMock,
    });

    const error = await client.fetchFixtures().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TxLineApiError);
    expect(error).toMatchObject({ status: 403 });
    expect(String(error)).not.toContain('must-not-leak');
    expect(String(error)).not.toContain('private-api-token');
  });

  it('activates with the signed guest session and does not send an API token', async () => {
    const fetchMock = vi
      .fn<TxLineFetch>()
      .mockResolvedValueOnce(jsonResponse({ token: 'guest-jwt' }))
      .mockResolvedValueOnce(new Response('new-api-token'));
    const client = new TxLineApiClient({
      config: getTxLineConfig('devnet'),
      fetch: fetchMock,
    });

    await client.renewGuestSession();
    const token = await client.activateSubscription({
      leagues: [],
      txSig: 'transaction-signature',
      walletSignature: 'wallet-signature',
    });

    expect(token).toBe('new-api-token');
    const activationRequest = fetchMock.mock.calls[1];
    const headers = new Headers(activationRequest?.[1]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer guest-jwt');
    expect(headers.has('X-Api-Token')).toBe(false);
  });
});
