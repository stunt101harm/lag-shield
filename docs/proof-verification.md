# Decision receipts and TxLINE Solana proofs

LagShield produces two related but deliberately different cryptographic claims:

1. a deterministic SHA-256 receipt over the complete strategy decision and the exact
   persisted TxLINE events that informed it; and
2. an asynchronous verification of one of those source updates against TxLINE's daily
   Merkle root on Solana.

The first claim proves what LagShield decided and which input identities it used. The second
proves that the selected odds or score update belongs to the TxLINE data committed by the
configured on-chain program. LagShield never describes its own receipt hash as an on-chain
transaction.

## Atomic receipt identity

The decision, its versioned market-control state, and a pending receipt are inserted in one
PostgreSQL transaction under the market advisory lock. A version-2 receipt hashes this
canonical payload:

```text
{
  decision: <complete versioned StrategyDecision>,
  evidence: [
    { eventId, kind, scoreStatKey, source, sourceMessageId, sourceTimestampMs }, ...
  ]
}
```

Evidence is loaded from `domain_events`, must include every event ID referenced by the
decision, and is sorted by event ID before hashing. The payload hash and derived receipt ID
never change. Proof status and explorer metadata live outside that hashed payload, so an
asynchronous verification cannot rewrite history or change an order's
`circuitBreakerReceiptId`.

The public endpoint `GET /v1/decision-receipts/:receiptId` returns the canonical receipt,
exact provenance, proof lifecycle, and retained proof material. `GET /metrics/proofs` exposes
only worker status and aggregate counts; it never returns credentials.

## Pinned on-chain contract

LagShield implements the official TxLINE IDL at commit
`3a1d6f0cfc34ce173f0778023d2332161359196d`, IDL version `1.5.6`.

| Network | TxLINE program                                 |
| ------- | ---------------------------------------------- |
| Devnet  | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` |
| Mainnet | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` |

Before every simulation, the RPC genesis hash must match the selected network. The derived
daily root account must exist and be owned by the configured TxLINE program. Instruction
return data must come from that same program and decode to one Borsh boolean.

### Odds

- API: `GET /api/odds/validation?messageId={id}&ts={milliseconds}`
- Instruction: `validate_odds`
- Discriminator: `c0135b8a6864d456`
- PDA: `daily_batch_roots` plus `floor(odds.Ts / 86_400_000)` encoded as `u16` little-endian
- Identity binding: response `MessageId` and `Ts` must equal the receipt evidence exactly

The encoder includes the full `Odds`, `OddsBatchSummary`, subtree proof, and main-tree proof
in pinned-IDL field order.

### Score stat

- API: `GET /api/scores/stat-validation?fixtureId={id}&seq={sequence}&statKey={key}`
- Instruction: `validate_stat`
- Discriminator: `6bc5e85abf8869b9`
- PDA: `daily_scores_roots` plus the summary minimum timestamp's epoch day as `u16`
  little-endian
- Identity binding: the normalized score source ID supplies fixture and sequence, while the
  response fixture, source timestamp, and selected persisted-event stat key must match
  exactly

The on-chain predicate is equality to the value contained in the proved stat leaf. It is
therefore true only when the leaf and its event, fixture, and daily Merkle paths validate.
The simulation requests the official example's 1,400,000-compute-unit ceiling.

## Lifecycle and failure semantics

| Status        | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `pending`     | Receipt committed; proof work has not completed.                                 |
| `verified`    | The exact TxLINE program returned Borsh `true`.                                  |
| `rejected`    | The program executed successfully and returned Borsh `false`.                    |
| `unavailable` | The decision contains no usable TxLINE odds or score proof coordinates.          |
| `error`       | API, RPC, network, account, owner, simulation, or return-data validation failed. |

`rejected`, `unavailable`, and `error` are never displayed as verified. Error records retain
a bounded safe diagnostic, attempted proof reference, program, network, root address, and
the proof-material hash when the API response was available. The worker processes receipts
after the safety decision commits, prevents overlapping runs, and never delays an immediate
pause.

## Run and verify

Live proof processing starts with live ingestion and uses the public key already stored in
the private TxLINE credentials file as the unsigned simulation payer:

```bash
export TXLINE_LIVE_ENABLED=true
export TXLINE_NETWORK=devnet
export TXLINE_CREDENTIALS_FILE=.txline/devnet.credentials.json
export TXLINE_PROOF_INTERVAL_MS=10000
pnpm db:migrate
pnpm --filter @lagshield/agent dev
```

`TXLINE_RPC_URL` may select a production RPC, but its genesis hash must match
`TXLINE_NETWORK`.

Unit tests pin discriminator bytes, complete instruction SHA-256 golden vectors, PDA golden
addresses, response identity checks, ownership checks, and true/false return handling. The
PostgreSQL integration suite verifies atomic creation, immutable proof material, lifecycle
updates, and order linkage.

A real-network integration test is intentionally credential-gated and skips in public CI.
It reads the token only from the mode-`600` credentials file and prints neither the token nor
proof payload:

```bash
TXLINE_PROOF_CREDENTIALS_FILE=.txline/devnet.credentials.json \
TXLINE_PROOF_MESSAGE_ID=<captured-message-id> \
TXLINE_PROOF_TIMESTAMP_MS=<captured-source-timestamp> \
pnpm --filter @lagshield/txline exec vitest run src/proof.integration.test.ts
```

Score verification uses `TXLINE_SCORE_PROOF_FIXTURE_ID`,
`TXLINE_SCORE_PROOF_SEQUENCE`, `TXLINE_SCORE_PROOF_TIMESTAMP_MS`, and optional
`TXLINE_SCORE_PROOF_STAT_KEY` instead. A passing real test requires `status: verified` from
the pinned program; the repository does not substitute a mock result when credentials or
captured proof coordinates are absent.

Primary references:

- [TxLINE on-chain validation](https://txline.txodds.com/documentation/examples/onchain-validation)
- [TxLINE World Cup documentation](https://txline.txodds.com/documentation/worldcup)
- [TxLINE devnet program](https://txline.txodds.com/documentation/programs/devnet)
- [TxLINE mainnet program](https://txline.txodds.com/documentation/programs/mainnet)
- [TxLINE OpenAPI contract](https://txline.txodds.com/docs/docs.yaml)
