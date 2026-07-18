# Historical hydration and deterministic replay

LagShield can hydrate a supported completed fixture from TxLINE, preserve the normalized
facts, and replay them through the same ordered dispatch boundary used by live strategy
evaluation. A replay is always identified by both a unique `runId` and a storage namespace
of `replay:<runId>`.

## TxLINE inputs

The hydrator uses these authenticated endpoints:

- `GET /api/scores/historical/{fixtureId}` for the fixture's score history.
- `GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}?fixtureId={fixtureId}` for every
  intersecting five-minute odds bucket.

Intervals are derived in UTC. `epochDay` is the number of complete days since the Unix
epoch, `hourOfDay` is `0`–`23`, and `interval` is `0`–`11`. Boundary buckets are included,
then records outside the exact requested timestamp range are discarded. Requests use a
bounded concurrency of four by default, and the planner rejects ranges above 10,000
intervals.

TxLINE's historical-score contract currently limits supported fixtures to its documented
availability window (fixtures starting between roughly two weeks and six hours ago). Pick a
completed fixture within the current window; do not treat an empty response for an old
fixture as evidence that the ingestion code is broken.

## Hydrate and replay a real fixture

First activate TxLINE, apply database migrations, and keep the resulting API token in the
mode-`600` credentials file described in [TxLINE onboarding](txline-onboarding.md). Then run:

```bash
pnpm db:migrate

pnpm replay:hydrate -- \
  --fixture-id 18241006 \
  --competition-id 72 \
  --scheduled-at-ms 1784311200000 \
  --source-start-ms 1784311200000 \
  --source-end-ms 1784318400000 \
  --speed maximum
```

The numeric fixture and timestamps above illustrate the command shape; replace them with a
currently supported completed fixture. `DATABASE_URL` and `TXLINE_CREDENTIALS_FILE` are
required. Optional speed is a positive multiplier (`1`, `4`, and so on) or `maximum`.

The command prints only counts, manifest metadata, and deterministic hashes. It never prints
the API token or cached source payloads. Its event callback is the shared replay dispatch
boundary; the risk strategy attaches to that boundary in the strategy increment.

## Determinism contract

Score and odds events use the global event-store order:

```text
(sourceTimestampMs, sequence, sourcePriority, sourceId, idempotencyKey, eventId)
```

Each persisted `replay_manifest` records the fixture, exact source range, requested odds
intervals, data mode, strategy configuration and version, ordered event count, input hash,
and event-sequence hash. Operational `receivedAtMs` does not participate in the input hash.
The same facts and configuration therefore yield the same manifest ID and hashes regardless
of HTTP completion or array order.

The virtual clock supports `start`, `pause`, `resume`, `stop`, positive speed multipliers,
and maximum-throughput mode. Its tests use a controllable timer and contain no wall-clock
sleeps.

## Live-state isolation

- Historical and simulated events are retained in the immutable fact lake but are forbidden
  from updating live fixture, score, market, or quote projections.
- Only `txline-live` and `txline-snapshot` events may mutate operational live projections.
- Every replay dispatch carries `mode: replay`, its `runId`, and namespace
  `replay:<runId>`. Strategy-owned market or order keys must pass through
  `namespaceResource` before persistence.
- `replay_runs.namespace` is unique and protected by a database check deriving it from the
  run ID. The manifest foreign key, input hash, configuration hash, and speed are stored on
  the run record.

## Retention and redistribution

Historical raw payloads default to a 24-hour retention period. The CLI accepts one to 168
hours. `purgeExpiredRawPayloads` removes the JSON in bounded, concurrency-safe batches while
retaining its SHA-256 hash, identity, status, normalized domain event, and replay manifest.
This preserves deduplication and auditability without keeping redistributable source data
indefinitely.

Do not expose a raw-history download endpoint, commit payload captures, include source dumps
in demo assets, or redistribute TxLINE data. Confirm the current TxLINE event terms before
changing retention. Manifests, derived decisions, aggregate metrics, and hashes should be
preferred in public evidence.

## Reliable no-live-match demo

```bash
pnpm replay:seeded
```

This emits a fixed five-event scenario, its manifest, ordered trace, and final hashes through
the real replay runner. It is deliberately and visibly labeled `seeded-simulation`; every
event source is `simulation`, the score path is `null`, and the namespace is
`replay:seeded-demo`. It is a demo fallback, not a substitute for the submission's required
live TxLINE integration.
