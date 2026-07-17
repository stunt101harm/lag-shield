# Domain model and event store

LagShield treats every TxLINE record as an immutable fact. Strategy decisions and current
market state are derived from that fact log, so a live run and a historical replay exercise
the same code and produce the same result.

## Ingest contract

The transport adapter validates TxLINE fixture, odds, and score payloads before creating a
versioned normalized envelope:

```text
eventId, idempotencyKey, kind, payloadVersion
fixtureId, source, sourceId, sourceTimestampMs
sequence, sourcePriority, receivedAtMs, payload
```

`source` is one of `txline-live`, `txline-snapshot`, `txline-historical`, or `simulation`.
The three TxLINE paths produce the same payload contract. `receivedAtMs` is operational
metadata and never participates in identity or replay order.

Raw odds remain in TxLINE's native signed-integer representation and are tagged
`txline-native-i32-v1`. A later pricing layer must decode them from an explicitly verified
TxLINE specification; the ingest layer does not guess a scale.

Malformed, unknown, and unsupported-version records do not crash the agent. They enter
`raw_ingest_records` with `status = quarantined`, a stable identity, the untouched JSON
payload, an error code, and validation issues.

## Determinism and idempotency

Event identity is derived from length-prefixed key parts, avoiding ambiguous string
concatenation:

```text
event idempotency = source + kind + sourceId + payloadVersion
eventId           = "evt_" + first 40 hex characters of SHA-256(idempotency)
raw ingestId      = "raw_" + first 40 hex characters of SHA-256(raw idempotency)
decision identity = triggerEventId + marketId + policyVersion
```

Re-receiving the same upstream fact at a different wall-clock time therefore produces the
same identity. Reusing an identity for different raw JSON raises an
`IdempotencyConflictError`; it is never silently accepted.

Every replay and projection uses this ascending total order:

```text
(sourceTimestampMs, sequence, sourcePriority, sourceId, idempotencyKey, eventId)
```

Source priority is deterministic: simulation `0`, historical `10`, snapshot `20`, and live
`30`. PostgreSQL check constraints prevent code or operators from writing a priority that
does not match its source.

## Transaction boundary

```mermaid
flowchart LR
  A["TxLINE raw record"] --> B["Validate and normalize"]
  B -->|invalid| Q["Durable quarantine"]
  B -->|valid| T["Single PostgreSQL transaction"]
  T --> R["Immutable raw record"]
  T --> E["Immutable domain event"]
  T -->|live / snapshot only| P["Latest-state projections"]
  E --> D["Deterministic strategy decision"]
  D --> S["Versioned market control state"]
  D --> C["Receipt / simulated order"]
```

The raw record and normalized event commit together. Only `txline-live` and
`txline-snapshot` inputs may update operational live projections. Historical and simulation
facts remain replayable in the immutable event lake but cannot mutate live state. Projection
upserts compare the full event-order tuple, so out-of-order real-time records cannot overwrite
newer live state.

Decision writes take a transaction-scoped PostgreSQL advisory lock per market. The caller
supplies `expectedStateVersion`, and stale writers fail with `ConcurrentStateError`.
`market_control_states` can be loaded after process restart, while the append-only
`strategy_decisions` table retains the audit trail.

## Storage layout

| Data               | Tables                                                                                     | Purpose                                                         |
| ------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Source facts       | `raw_ingest_records`, `domain_events`                                                      | Untouched input, quarantine evidence, normalized replay log     |
| Sports projections | `fixtures`, `markets`, `outcome_quote_observations`, `score_events`, `fixture_score_state` | Current fixture/market/score state plus quote and score history |
| Agent output       | `strategy_decisions`, `market_control_states`, `decision_receipts`                         | Auditable actions, restart state, and proof lifecycle           |
| Evaluation         | `replay_manifests`, `replay_runs`, `simulated_orders`                                      | Reproducible, namespaced simulations and paper execution        |

Historical raw payloads may carry `retention_expires_at_ms`. A bounded purge nulls expired
JSON but preserves its canonical SHA-256 hash, normalized event, and ingest identity, so a
later retry is still deduplicated without retaining redistributable source payloads.

Dashboard reads must be bounded. `listFixtureEvents` accepts 1–500 rows and uses a stable
cursor; its ordering columns are covered by `domain_events_fixture_order_idx`. Quote,
decision, order, quarantine, and fixture views have corresponding composite indexes.

## Schema and payload evolution

- SQL migrations are forward-only, reviewed artifacts under `apps/agent/drizzle/`; deployed
  environments run `pnpm db:migrate`, never `db:generate`.
- Authors change `schema.ts`, run `pnpm db:generate`, inspect the SQL and snapshot, then run
  the PostgreSQL integration suite before committing.
- Normalized payloads and decisions carry a `payloadVersion`. Existing raw records and
  domain events are never rewritten to disguise a contract change.
- A breaking contract gets a new versioned schema and an explicit deterministic upcaster.
  The prior reader remains available until all recorded runs can still be replayed.
- Retrying a quarantined record under changed parsing logic requires the new payload version;
  this preserves the original failure and prevents identity collision.
- Production migration procedure: back up, apply migrations once, run readiness checks, and
  roll application code forward. A corrective forward migration is preferred to editing an
  already-deployed migration.

## Verification

Unit tests cover valid, partial, unknown, and malformed TxLINE fixtures, canonical identity,
forged metadata rejection, and all permutations of the tie-break sample. The PostgreSQL
suite migrates a real database and verifies atomic deduplication, conflict detection,
quarantine, projection ordering, cursor bounds, index installation, check constraints, and
state recovery after reconnect.

```bash
docker compose up -d postgres
TEST_DATABASE_URL=postgresql://lagshield:lagshield@localhost:5432/lagshield \
  pnpm --filter @lagshield/agent test
```
