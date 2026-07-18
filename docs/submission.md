# Hackathon submission brief

This file is the copy source for the TxLINE hackathon submission form. Replace only the
explicit pending links after deployment and recording; do not inflate or reinterpret the
measured claims.

## Submission metadata

| Field                | Value                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| Project name         | LagShield                                                                                            |
| One-line description | Autonomous, proof-backed circuit breaker for stale in-play sports markets, powered by TxLINE.        |
| Repository           | https://github.com/stunt101harm/lag-shield                                                           |
| Public application   | Pending Cloudflare provisioning in [issue #15](https://github.com/stunt101harm/lag-shield/issues/15) |
| Public API           | Pending deployment; `/docs`, `/openapi.json`, and `/ready` are public                                |
| Demo video           | Pending final recording in [issue #17](https://github.com/stunt101harm/lag-shield/issues/17)         |
| Owner / team         | `stunt101harm`                                                                                       |
| License              | MIT                                                                                                  |

## Short description

LagShield watches TxLINE odds and score streams for the moment a match changes faster than
the market. It deterministically widens or pauses quoting, rejects unsafe paper orders, and
reopens only after measured convergence. Every action produces an auditable receipt tied to
the exact TxLINE messages and their Solana proof lifecycle.

## Problem and product

An in-play market can remain quotable for seconds after a possible goal, penalty, red card,
or VAR event. A dashboard alert still leaves a human in the loop during the most dangerous
window. LagShield is an autonomous B2B safety layer: it consumes the score event and market
reaction together, controls an executable admission gate, and records why every transition
happened.

The included adapter is a paper market so judges can test the control contract safely. A
licensed sportsbook, exchange, market maker, or odds intermediary can replace that adapter
without changing the deterministic policy, evidence model, or TxLINE integration.

## Technical highlights

- **Autonomous operation:** independent TxLINE odds/scores supervisors, bounded reconnects,
  JWT renewal, durable quarantine, graceful shutdown, restart reconciliation, and readiness.
- **Defensible strategy:** integer probability math, exact de-vig residual normalization,
  median/MAD consensus, quote freshness, velocity, reaction latency, explicit thresholds,
  hysteresis, and a complete state-transition table.
- **Executable control:** `OPEN`, `WIDENED`, `PAUSED`, and `RECOVERY` drive a simulated order
  gate under the same PostgreSQL market lock as the decision.
- **Auditability:** immutable facts, versioned policy/config hashes, canonical SHA-256 decision
  receipts, exact source identities, and explicit proof lifecycle states.
- **TxLINE/Solana verification:** exact odds or score proof material is identity-bound and
  checked through the pinned TxLINE program in read-only Solana simulation.
- **Live/replay parity:** live, historical, and seeded inputs share normalization, consensus,
  strategy, gate, receipt, API, and UI code while remaining visibly namespaced.
- **Production posture:** strict configuration, migrations, retention, rate/body bounds,
  secret redaction/scanning, security headers, load smoke, container build, and repeatable
  public deployment.

## Business value

LagShield is a deployable risk primitive for professional trading teams and market operators:

- reduce stale-quote exposure around match-changing information;
- make automated suspension/reopen behavior consistent across competitions;
- give risk, compliance, and counterparties a reproducible decision trail;
- separate venue-specific execution from a portable safety policy; and
- use TxLINE's normalized cross-competition schema and Solana anchoring without placing
  credentials or proof complexity in the browser.

The initial soccer policy targets World Cup in-play markets. The event schema and adapter
boundaries are versioned so other sports and competitions can add audited policies without
rewriting the ingestion or evidence layer.

## TxLINE endpoints used

All data requests use a guest JWT in `Authorization` plus the activated subscription token
in `X-Api-Token`. The host, program, mint, RPC network, subscription, and proof must remain on
the same selected network.

| Method | TxLINE endpoint                                                     | LagShield use                                                | Primary code path               |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------- |
| POST   | `/auth/guest/start`                                                 | Acquire/renew the short-lived guest JWT                      | `packages/txline/src/client.ts` |
| POST   | `/api/token/activate`                                               | Exchange confirmed subscription + wallet proof for API token | `packages/txline/src/client.ts` |
| GET    | `/api/fixtures/snapshot`                                            | Discover World Cup competitions and live/upcoming fixtures   | `packages/txline/src/client.ts` |
| GET    | `/api/odds/stream`                                                  | Supervise live StablePrice odds SSE                          | `packages/txline/src/live.ts`   |
| GET    | `/api/scores/stream`                                                | Supervise live score/event SSE                               | `packages/txline/src/live.ts`   |
| GET    | `/api/scores/historical/{fixtureId}`                                | Hydrate completed-fixture score history                      | `packages/txline/src/client.ts` |
| GET    | `/api/odds/updates/{epochDay}/{hourOfDay}/{interval}?fixtureId=...` | Hydrate bounded five-minute odds buckets                     | `packages/txline/src/client.ts` |
| GET    | `/api/odds/validation?messageId=...&ts=...`                         | Fetch exact odds Merkle proof material                       | `packages/txline/src/client.ts` |
| GET    | `/api/scores/stat-validation?fixtureId=...&seq=...&statKey=...`     | Fetch exact score-stat Merkle proof material                 | `packages/txline/src/client.ts` |

Solana integration additionally uses JSON-RPC to verify genesis/network, load the derived
program-owned daily-root account, and simulate the pinned `validate_odds` or `validate_stat`
instruction. Subscription activation submits the official on-chain `subscribe` instruction.

Primary TxLINE references:

- [Quickstart and credential lifecycle](https://txline.txodds.com/documentation/quickstart)
- [World Cup free tier](https://txline.txodds.com/documentation/worldcup)
- [Streaming data](https://txline.txodds.com/documentation/examples/streaming-data)
- [Odds and StablePrice overview](https://txline.txodds.com/documentation/odds/overview)
- [Soccer feed semantics](https://txline.txodds.com/documentation/scores/soccer-feed)
- [On-chain validation](https://txline.txodds.com/documentation/examples/onchain-validation)
- [Program addresses and validation accounts](https://txline.txodds.com/documentation/programs/addresses)

## Proof and execution claim boundary

LagShield deliberately makes three distinct claims:

1. the canonical receipt hash proves the exact persisted decision/evidence payload;
2. a `verified` proof means the selected source fact validated against a daily root owned by
   the configured TxLINE program; and
3. the included order gate proves the control action in a simulated execution environment.

LagShield's decision hash is not written to Solana. Validation uses a read-only simulation,
not a submitted decision transaction. Paper orders do not custody funds, settle positions,
or claim real-money protection. Proof states other than `verified` remain visibly non-verified.

## Evaluation evidence

The fixed Canada–Japan scenario pauses on an unconfirmed goal, eight logical seconds before
the first material consensus move. A deliberately submitted paper order is rejected; its
requested probability is 20.0 percentage points from the later converged probability. The
59-second normal-play control window has zero restrictive transitions and recovery has zero
flaps.

These values are a deterministic demonstration, not historical performance. The 20.0 pp
value is an absolute probability-distance proxy—not P&L, causal impact, or a claim about a
real sportsbook. Every report includes limitations, source/configuration hashes, sensitivity
rows, and a byte-stable evaluation hash.

## Judge requests

```bash
curl -fsS https://AGENT_HOST/ready
curl -fsS https://AGENT_HOST/v1/overview
curl -fsS https://AGENT_HOST/v1/evaluations/seeded

LAGSHIELD_API_URL=https://AGENT_HOST pnpm judge:smoke
```

The final command runs the complete state-changing proof against the public API. The public
Swagger UI is `https://AGENT_HOST/docs`; the machine-readable contract is
`https://AGENT_HOST/openapi.json`.

## Documentation index

- [Architecture and trust boundaries](architecture.md)
- [Strategy policy, thresholds, and transition table](risk-policy.md)
- [Consensus formulas and units](market-consensus.md)
- [Receipt and Solana proof contract](proof-verification.md)
- [Judge API and realtime controls](agent-api.md)
- [Five-minute demo and final preflight](demo-script.md)
- [Deployment and operations](deployment.md)
- [TxLINE integration feedback](txline-feedback.md)

## TxLINE feedback

TxLINE's single fixture/odds/score surface made the application architecture portable, while
StablePrice and the daily Solana roots made it possible to combine immediate automated
control with later cryptographic audit. The main integration cost was not HTTP transport; it
was safely joining network-specific subscription activation, payload semantics, historical
time buckets, and exact proof/IDL identity. Our specific feedback and suggested improvements
are documented in [TxLINE integration feedback](txline-feedback.md).
