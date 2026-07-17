# LagShield

LagShield is an autonomous, proof-backed circuit breaker for in-play sports markets. It
will consume TxLINE odds and score streams, detect stale or unsafe quoting around
match-changing events, execute deterministic market-control actions, and produce
auditable decision receipts tied to TxLINE's Solana-anchored data.

> The repository is under active hackathon development. The simulated order gateway is
> not a real-money betting product.

## Architecture

| Workspace         | Responsibility                                                           |
| ----------------- | ------------------------------------------------------------------------ |
| `apps/agent`      | Long-running ingestion, strategy execution, replay, API, and persistence |
| `apps/web`        | Operator command center and judge-facing product experience              |
| `packages/core`   | Deterministic domain logic, consensus math, and risk policy              |
| `packages/txline` | TxLINE authentication, API, SSE, replay, and proof integration           |
| `packages/shared` | Runtime schemas, configuration, and shared contracts                     |

Dependencies point inward: apps may use packages; `core` never imports an app or an
external transport. Live and historical sources will implement the same normalized event
contract so recorded inputs can reproduce decisions exactly.

See [the domain model and event-store contract](docs/domain-model.md) for canonical event
identity, replay ordering, PostgreSQL transaction boundaries, and schema evolution rules.

## Quick start

```bash
cp .env.example .env
docker compose up -d postgres
pnpm install
pnpm db:migrate
pnpm dev
```

- Web: http://localhost:3000
- Agent health: http://localhost:4000/health

## TxLINE access

LagShield includes a fail-closed operator CLI for network verification, free-tier activation,
and dynamic World Cup fixture discovery. It never accepts an API token on the command line
or prints one to logs.

```bash
# Verify that the RPC, API host, program, mint, and audited instruction artifact agree.
pnpm txline -- doctor --network devnet

# Activate the devnet free tier. The Solana keypair must have mode 600.
pnpm txline -- subscribe --network devnet --wallet /absolute/path/to/keypair.json

# Exercise guest-JWT renewal and retrieve live World Cup fixtures.
pnpm txline -- smoke --network devnet
```

See [TxLINE onboarding](docs/txline-onboarding.md) for mainnet activation, credential
handling, failure diagnostics, and the exact upstream endpoints and artifacts used.

Once activated, see [live ingestion operations](docs/live-ingestion.md) for unattended odds
and score streams, recovery semantics, metrics, graceful shutdown, and the credential-gated
stream smoke command.

For completed-fixture hydration, deterministic manifests, virtual-clock replay, retention,
and the always-available seeded judge demo, see
[historical replay operations](docs/historical-replay.md).

For exact `Pct` conversion, residual normalization, robust median/MAD features, reaction
latency, and market-key rules, see
[market identity and consensus mathematics](docs/market-consensus.md).

For the score-event classifier, risk thresholds, fail-safe behavior, hysteresis, and complete
state-transition table, see the [deterministic soccer risk policy](docs/risk-policy.md).

## Quality gates

```bash
pnpm check

# Deterministic demo fallback when no match is live
pnpm replay:seeded
```

This runs formatting checks, ESLint, strict TypeScript, unit tests, and production builds
through Turborepo. CI runs the same command from a frozen lockfile with PostgreSQL 17, so
the migration and restart-safety integration tests cannot silently skip.

## Project plan

The implementation is tracked in [the parent epic](https://github.com/stunt101harm/lag-shield/issues/1).

## License

MIT
