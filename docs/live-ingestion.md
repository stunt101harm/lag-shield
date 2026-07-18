# Live TxLINE ingestion

LagShield supervises the official `GET /api/odds/stream` and
`GET /api/scores/stream` SSE endpoints independently. Each connection sends the guest JWT
in `Authorization`, the activated subscription in `X-Api-Token`, and
`Accept: text/event-stream`.

## Run it

Activate a matching network subscription first, then enable live ingestion:

```bash
chmod 600 .txline/devnet.credentials.json
export TXLINE_NETWORK=devnet
export TXLINE_CREDENTIALS_FILE=.txline/devnet.credentials.json
export TXLINE_LIVE_ENABLED=true
pnpm db:migrate
pnpm --filter @lagshield/agent dev
```

The agent refuses to start live ingestion if the credential file's network differs from
`TXLINE_NETWORK`. Tokens remain in the private credential file and are never returned by an
API or log message.

On a managed host, set `TXLINE_CREDENTIALS_SOURCE=environment` and inject
`TXLINE_API_TOKEN` plus `TXLINE_WALLET_PUBLIC_KEY` through the provider's secret store before
setting `TXLINE_LIVE_ENABLED=true`. The environment schema requires both values when this
mode is live. Do not place either value in `wrangler.jsonc`, a build argument, or a public URL.

Use the credential-gated operator smoke command to prove that both stream handshakes work.
A quiet stream is a successful result; TxLINE does not guarantee sports updates when no
covered fixture is active.

```bash
pnpm txline -- stream-smoke --network devnet --duration-seconds 10
```

The command reports only connection status and message counts, never payloads or secrets.

## Recovery behavior

- A `401` triggers one coalesced guest-JWT renewal and reconnects with the unchanged API
  token.
- A `403` emits the diagnostic `subscription_denied`, identifying network, token,
  subscription, and league-bundle checks, then retries with bounded exponential backoff.
- Connection and heartbeat timeouts abort a stale response. Jitter prevents two stream
  loops or replicas from reconnecting in lockstep.
- The SSE parser handles split UTF-8 chunks, CR/LF variants, comments, multiline `data`,
  `retry`, and persistent event IDs. Reconnects send `Last-Event-ID` when TxLINE supplied one.
- Event memory is capped at 1 MiB. Persistence is awaited inline, so there is no unbounded
  application queue: transport backpressure propagates to the response reader.
- Normalized raw input, the immutable domain event, and projections commit before a strategy
  callback runs. Replayed messages return `duplicate` and are not dispatched again.
- Malformed JSON and invalid TxLINE records enter durable quarantine and increment the stream
  quarantine counter.
- Score normalization accepts the official lowercase `fixtureId/seq/ts/action/stats` wire
  contract (including encoded stat-key maps) and the uppercase compatibility examples.
- `SIGINT` and `SIGTERM` abort both readers, await in-flight persistence, close the HTTP
  server, and then close PostgreSQL.

## Health and freshness

`GET /metrics/streams` exposes a secret-free snapshot for both streams:

- connection state and connected/activity timestamps;
- last sports-event timestamp, source timestamp, and dynamically calculated lag;
- reconnect, accepted, duplicate, and quarantine counts;
- last safe diagnostic and current backoff;
- last SSE event ID and dynamically discovered/tracked World Cup fixture IDs.

An open connection with no event timestamp can be healthy. Fixture discovery runs before
the streams and its status is reported separately, so an empty live window is not mistaken
for an outage.

## Verification

The test suite uses a disposable local HTTP/SSE server to exercise split frames, comments,
multiline data, forced disconnects, `Last-Event-ID`, 401 renewal, both endpoint paths, and
API-token preservation. Separate fault tests prove bounded backpressure, in-flight drain,
403 diagnostics, durable quarantine visibility, and dispatch-after-persistence ordering.
