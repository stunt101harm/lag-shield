# TxLINE integration feedback

This feedback is based on implementing LagShield's activation CLI, fixture discovery, two
live SSE supervisors, historical hydration, normalized odds/score schemas, and exact Solana
proof simulation. Credential-gated production evidence is tracked separately; we do not claim
support conversations or live match observations that did not occur.

## What worked especially well

### One normalized product boundary

The fixture, odds, and score surfaces let us keep competition discovery outside the strategy.
LagShield searches the current fixture snapshot for World Cup competitions instead of baking
in a tournament ID. That is the architectural benefit we most wanted from TxLINE: the agent's
policy can remain sport-specific without its transport becoming competition-specific.

### StablePrice plus raw event semantics

StablePrice gives the agent a defensively filtered consensus input, while the soccer feed
retains low-latency possible/confirmed/amended event semantics. That combination is unusually
useful for a safety controller: score events can trigger immediate protection, and the odds
stream can measure when the market actually converges.

### Verifiability is attached to useful data

The validation APIs expose the full Merkle paths and summaries required to exercise the
public Solana program, rather than returning only an opaque attestation. Program-address and
PDA documentation made it possible to fail closed on network, account owner, proof identity,
and program return data.

### Runnable network-specific documentation

The World Cup guide now puts mainnet/devnet hosts, program IDs, mints, free service levels,
activation message, and request headers in one path. The explicit standard-bundle message
`${txSig}::${jwt}` and the reminder to use a real observed score sequence prevent subtle
activation and proof mistakes.

## Friction we encountered

### Network coupling is correct but easy to misconfigure

Subscription activation joins a Solana RPC, program ID, mint, transaction signature, guest
JWT host, activation host, wallet, service level, and league bundle. Mixing any one value can
fail after the user has already paid a transaction fee. We built a `doctor` command and pinned
network matrix specifically to protect this boundary.

**Suggestion:** publish an official small SDK function that returns a typed, immutable
network configuration and verifies RPC genesis, program ID, mint, API origin, and activated
token metadata together before signing.

### Schema units and versioning need to be maximally explicit

The odds contract documents `Pct` precisely enough for exact conversion, but native integer
`Prices` should not be reinterpreted without a normative unit formula. Score payload examples
also appear in lowercase current wire form and uppercase compatibility form. LagShield retains
native prices as opaque diagnostics, accepts both score casings, versions normalized payloads,
and refuses to invent missing semantics.

**Suggestion:** add a version/discriminator to every streamed record, publish normative units
for every numeric field beside the OpenAPI schema, and maintain a concise payload changelog
with representative JSON fixtures.

### Historical replay requires careful time-bucket planning

Odds history uses epoch-day/hour/five-minute interval coordinates, while score history is
fixture-based and limited to a moving availability window. Correct hydration requires UTC
bucket math, boundary filtering, bounded concurrency, and awareness that an empty old fixture
is not necessarily an authentication failure.

**Suggestion:** add a fixture-scoped replay-manifest endpoint, or an official iterator that
accepts `fixtureId + start/end` and yields ordered odds and scores with explicit retention
metadata. That would make deterministic agent evaluation much easier and less error-prone.

### Proof integration has a high correctness surface

Safe proof verification must bind API response identity to the observed source event, derive
the correct daily PDA from the proof timestamp, encode nested Borsh structures in exact IDL
order, confirm account ownership, use the matching program, and validate typed return data.
This is valuable rigor, but it is a large amount of security-sensitive client code.

**Suggestion:** ship a maintained TypeScript verification package with pinned IDL versions,
typed API responses, PDA helpers, instruction encoders, golden vectors, and explicit
`verified/rejected/error` results. Keep the raw primitives available for independent audits.

### Quiet-stream diagnostics are inherently ambiguous

Outside a covered live window, a healthy SSE connection may produce no sports messages. We
separated connection health, last activity, last sports timestamp, fixture discovery, and lag
so operators do not confuse quiet with broken.

**Suggestion:** publish a lightweight authenticated heartbeat/status event or a subscription
coverage endpoint showing current authorized competitions and next covered fixture window.

## Developer-support experience

We completed the implementation from the public documentation, OpenAPI contract, official
program/IDL repository, and runnable examples. We did not rely on a private Discord or
Telegram exchange, so there is no support-response experience to report honestly. A public,
searchable troubleshooting knowledge base is preferable for future production teams because
network/activation/proof answers then remain auditable and reusable.

## Bottom line

TxLINE made a genuinely new product possible: the same provider supplies low-latency sports
semantics, consensus pricing, history, and independently verifiable roots. The strongest next
step would be to reduce correctness work at the edges—network configuration, versioned wire
contracts, replay iteration, and proof encoding—while keeping the current transparent raw API
and on-chain validation model.
