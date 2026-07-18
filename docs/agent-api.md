# Judge API and realtime control plane

LagShield exposes one public, rate-limited HTTP API for the operator command center,
automated judging, and production integrations. It contains no API-token or database
credentials. Swagger UI is served at `/docs` and the OpenAPI 3 contract at
`/openapi.json`.

## Runtime contract

- `GET /health` is process liveness. It does not imply PostgreSQL or TxLINE is ready.
- `GET /ready` checks PostgreSQL and reports whether live TxLINE ingestion, credentials,
  proof verification, and the selected Solana network are configured.
- Every response includes `x-request-id` for correlation.
- Browser access is denied unless its exact origin appears in the comma-separated
  `PUBLIC_WEB_ORIGIN` allowlist.
- The public API is limited to 300 requests per minute per client. The long-lived SSE
  stream is exempt after connection.
- Invalid parameters, replay conflicts, missing resources, rate limits, and internal
  failures use bounded JSON error envelopes. Unknown query fields are rejected.

## Read endpoints

| Endpoint                               | Purpose                                                         |
| -------------------------------------- | --------------------------------------------------------------- |
| `GET /v1/overview`                     | Counts and latest agent activity                                |
| `GET /v1/fixtures`                     | Bounded World Cup fixture list                                  |
| `GET /v1/fixtures/:id`                 | Fixture, market, score, consensus, and circuit-breaker snapshot |
| `GET /v1/fixtures/:id/timeline`        | Interleaved score/decision timeline with `beforeMs` pagination  |
| `GET /v1/markets/:id/consensus`        | Current deterministic de-vig consensus                          |
| `GET /v1/decisions`                    | Strategy decisions filtered by fixture or market                |
| `GET /v1/decision-receipts`            | Receipt and TxLINE proof lifecycle list                         |
| `GET /v1/decision-receipts/:receiptId` | Canonical decision evidence and proof material                  |
| `GET /v1/simulated-orders`             | Persisted admissions filtered by fixture, namespace, or status  |
| `GET /v1/replays`                      | Persisted replay runs                                           |

List endpoints accept `limit` and enforce endpoint-specific maximums. The read model is
computed from PostgreSQL evidence; it does not rely on process memory.

## Deterministic judge replay

The seeded replay is always labeled `seeded-simulation`. It uses the same normalizer,
consensus engine, risk policy, atomic decision receipt write, simulated market gate, and
realtime stream as a live run.

```bash
curl -sS -X POST http://localhost:4000/v1/replays/seeded \
  -H 'content-type: application/json' \
  -d '{"runId":"judge-demo","speed":10}'

curl -sS http://localhost:4000/v1/replays/active

curl -sS -X POST http://localhost:4000/v1/replays/judge-demo/actions \
  -H 'content-type: application/json' \
  -d '{"action":"pause"}'
```

Only one replay owns the in-process virtual clock at a time. Duplicate run IDs and invalid
pause/resume/stop transitions return `409 REPLAY_CONFLICT`. Replay decisions and markets
are isolated under `replay:<run-id>`.

## Resumable realtime events

`GET /v1/realtime` is a Server-Sent Events stream for:

- persisted domain events;
- committed strategy decisions;
- simulated order admissions;
- proof lifecycle updates;
- replay progress and status.

Each frame has a monotonic decimal ID. Reconnect with `Last-Event-ID` or `?after=<id>`;
LagShield replays buffered events strictly after that ID without duplicates. If the cursor
has fallen outside the bounded 1,000-event buffer, the stream emits
`system.resync-required` and the client reloads the HTTP read model.

```bash
curl -N http://localhost:4000/v1/realtime
curl -N -H 'Last-Event-ID: 42' http://localhost:4000/v1/realtime
```

## Automated judge smoke test

With a migrated database and the agent running, this command proves the public product
loop through HTTP:

```bash
LAGSHIELD_API_URL=http://localhost:4000 pnpm judge:smoke
```

It starts the eight-event replay, waits for the risk engine to enter `PAUSED`, submits a
paper order, verifies `ORDER_REJECTED_PAUSED`, waits for deterministic recovery to `OPEN`,
then verifies the persisted order and linked decision receipt. A successful result is safe
to paste into deployment logs; it contains identifiers but no credentials.

The order endpoint is deliberately simulated and always returns `realMoney: false`.
LagShield does not submit real-money bets or custody funds.
