# Simulated market control and order admission

LagShield does more than emit alerts: every strategy decision controls an executable order
gate. The included adapter is deliberately a paper-execution environment. It never holds
funds, places a bet, or implies a connection to a real sportsbook.

The transport-independent `MarketControlPort` is the boundary a licensed market operator
could replace with its own exchange or sportsbook adapter. The demo implementation uses
PostgreSQL and returns `lag-shield-simulated-market-v1` plus `realMoney: false` on its public
API.

## Admission policy

| Latest committed state | Result     | Reason code                            | Policy                                                                  |
| ---------------------- | ---------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `OPEN`                 | `accepted` | `ORDER_ACCEPTED_OPEN`                  | Admit only a fresh quote against the exact current decision/version.    |
| `WIDENED`              | `stale`    | `ORDER_STALE_WIDENED_REQUOTE_REQUIRED` | Force a downstream requote; TxLINE native prices are not reinterpreted. |
| `PAUSED`               | `rejected` | `ORDER_REJECTED_PAUSED`                | Reject immediately.                                                     |
| `RECOVERY`             | `rejected` | `ORDER_REJECTED_RECOVERY`              | Remain fail-closed until the risk engine explicitly returns to `OPEN`.  |

An `OPEN` request is also marked `stale` when its expected decision ID or state version no
longer matches, or when its quote is older than 2,000ms. `PAUSED` and `RECOVERY` take
precedence over stale-client diagnostics so unsafe orders are always described as rejected.

LagShield does not apply an invented percentage or basis-point spread to `WIDENED`. TxLINE
odds remain tagged as the opaque, native signed-integer encoding described in the feed
contract. A professional downstream adapter can map `WIDENED` to venue-specific quoting
rules without weakening the core safety boundary.

## Atomic transaction boundary

Every order submission takes two transaction-scoped PostgreSQL advisory locks in a stable
order: its replay-scoped idempotency identity, then its market ID. Strategy decisions take
the same market lock. Under that lock the adapter:

1. returns the byte-identical result for an existing request or raises an idempotency
   conflict when the payload changed;
2. reads the latest market state, exact strategy-decision payload, and receipt that committed
   atomically with that decision;
3. computes the deterministic admission outcome;
4. verifies that the receipt belongs to the exact committed decision; and
5. writes the complete order audit record with that receipt ID before committing.

This serialization produces only two valid outcomes during a pause-versus-order race: the
order commits first against the preceding `OPEN` decision, or it observes the committed
`PAUSED` decision and is rejected. An order cannot be accepted against a pause that won the
lock.

Each version-2 order stores its admission latency, reason and explanation, request hash,
market state/version, decision ID, circuit-breaker receipt ID, and replay namespace. The
receipt is created with the decision—not on first order arrival—and contains the canonical
SHA-256 hash of the complete strategy decision plus its exact persisted event provenance. It
initially has `pending` proof status. The proof worker can later upgrade that same receipt to
`verified` without changing the order or decision identity. See
[decision receipts and TxLINE Solana proofs](proof-verification.md).

## Request and API

The agent exposes capability discovery at `GET /v1/simulated-market-control` and admission
at `POST /v1/simulated-orders`. The database migrations must be applied before enabling the
agent.

```json
{
  "payloadVersion": 1,
  "namespace": "replay:judge-demo",
  "idempotencyKey": "judge-order-001",
  "fixtureId": "42",
  "marketId": "market_...",
  "outcomeId": "home",
  "side": "back",
  "price": 2100,
  "stakeMicros": 1000000,
  "quoteObservedAtMs": 1800000000000,
  "requestedAtMs": 1800000000100,
  "expectedDecisionId": "dec_...",
  "expectedStateVersion": 7
}
```

An inserted order returns HTTP `201`; an identical replay returns the byte-identical order
and receipt with HTTP `200` and `persistenceStatus: "duplicate"`. Invalid input returns
`400`, while a changed payload under the same namespaced idempotency key or an uninitialized
market returns `409`. A disabled adapter returns `503`. Every response is explicitly marked
`realMoney: false`.

Order IDs hash the tuple `(namespace, idempotencyKey)`. Consequently the same scripted
client key can be reused in `replay:run-a` and `replay:run-b` without collision, while a retry
inside one run remains idempotent.

## Verification

The unit suite exhausts all four states, quote-age and state-version failures, canonical
identities, malformed timestamps, and replay isolation. The PostgreSQL suite migrates a
fresh database and verifies the full matrix, receipt linkage, conflict behavior, the
pause-versus-order race, and an end-to-end risk replay with this trace:

```text
market: OPEN -> PAUSED -> RECOVERY -> OPEN
order:  accepted -> rejected           -> accepted
```

```bash
TEST_DATABASE_URL=postgresql://lagshield:lagshield@localhost:5432/lagshield \
  pnpm --filter @lagshield/agent test
```
