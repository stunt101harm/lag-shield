# TxLINE onboarding and live smoke test

LagShield treats network selection and signing as a fail-closed operation. The Solana RPC,
TxLINE API host, program ID, token mint, service level, and audited subscription artifact
must all agree before the CLI constructs or signs a transaction.

## Canonical configuration

| Network | Solana RPC                            | TxLINE API origin               | Program                                        | TXLINE mint                                    | Free World Cup tiers               |
| ------- | ------------------------------------- | ------------------------------- | ---------------------------------------------- | ---------------------------------------------- | ---------------------------------- |
| Devnet  | `https://api.devnet.solana.com`       | `https://txline-dev.txodds.com` | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` | `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` | `1`                                |
| Mainnet | `https://api.mainnet-beta.solana.com` | `https://txline.txodds.com`     | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` | `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL`  | `1` (60 seconds), `12` (real time) |

The defaults come from the official [World Cup documentation](https://txline.txodds.com/documentation/worldcup).
A custom RPC is supported through `--rpc-url` or `TXLINE_RPC_URL`, but its genesis hash must
match the selected network. The API host, program, and mint cannot be overridden at runtime.

The subscription encoder is pinned to official IDL version `1.5.6` at
[`txodds/tx-on-chain@3a1d6f0`](https://github.com/txodds/tx-on-chain/commit/3a1d6f0cfc34ce173f0778023d2332161359196d).
LagShield stores only the audited `subscribe` discriminator, argument layout, account order,
PDA seeds, and per-network program IDs. A program mismatch aborts before signing.

## 1. Prepare a wallet

Use a Solana CLI keypair on the network you selected. Devnet requires devnet SOL for the
transaction fee and possible account rent; the free tier itself does not require TXLINE
payment. Restrict the wallet file before use:

```bash
chmod 600 /absolute/path/to/keypair.json
pnpm txline -- doctor --network devnet
```

`doctor` calls `getGenesisHash`, acquires a guest session from the selected TxLINE API host,
and prints only public configuration. The JWT remains in memory and is never printed. Do not
proceed unless it reports both `"status": "ok"` and `"apiAuthStatus": "ok"`.

## 2. Subscribe and activate

Devnet:

```bash
pnpm txline -- subscribe \
  --network devnet \
  --wallet /absolute/path/to/keypair.json \
  --service-level 1 \
  --duration-weeks 4
```

Mainnet real-time World Cup tier:

```bash
pnpm txline -- subscribe \
  --network mainnet \
  --wallet /absolute/path/to/keypair.json \
  --service-level 12 \
  --duration-weeks 4
```

The command performs this deterministic sequence:

1. Validate the RPC genesis hash and audited program artifact.
2. Validate the documented free service level and subscription duration.
3. Idempotently create the wallet's Token-2022 associated token account and submit the
   on-chain `subscribe(u16 serviceLevelId, u8 weeks)` instruction.
4. Acquire a guest JWT with `POST /auth/guest/start`.
5. Sign the exact activation message `${txSig}:${leagues.join(",")}:${jwt}` with the wallet.
   The standard empty league bundle therefore includes the double separator: `${txSig}::${jwt}`.
6. Activate with `POST /api/token/activate` and write the API token to
   `.txline/<network>.credentials.json` with mode `600`.

The command refuses to overwrite an existing credentials file unless `--force` is explicit.
It prints the public wallet and transaction signature, but never prints the JWT, wallet secret,
wallet signature, or API token.

If the Solana transaction confirms but the activation request is interrupted, the error prints
the public transaction signature. Recover without submitting another transaction:

```bash
pnpm txline -- activate \
  --network devnet \
  --wallet /absolute/path/to/keypair.json \
  --tx-signature <CONFIRMED_SUBSCRIBE_SIGNATURE>
```

## 3. Discover fixtures and smoke-test access

```bash
pnpm txline -- fixtures --network devnet --limit 20
pnpm txline -- smoke --network devnet --limit 5
```

Both commands load the existing API token from the private credentials file, acquire a fresh
guest JWT, and call `GET /api/fixtures/snapshot`. `smoke` is intentionally judge-safe: it
returns only typed, non-secret fixture summaries plus `"status": "live-smoke-ok"`.

Fixture discovery does not hard-code a competition ID. It fetches the current snapshot and
selects competitions whose names contain `World Cup`, allowing TxLINE's current normalized
catalog to remain the source of truth. Zero fixtures is a valid response outside coverage
windows; it still proves authentication and endpoint access.

## Authentication behavior

- The API token is long-lived and reused from the credentials file.
- Guest JWTs are held only in memory and are never persisted.
- Concurrent requests share one JWT-renewal operation.
- An authenticated request that receives HTTP 401 renews once and retries once.
- HTTP 403 produces a diagnostic covering token, network, subscription, and league-bundle
  mismatch without reading or logging the response body.
- Error rendering redacts bearer headers, JWT-shaped values, API-token headers, and known
  secret values.

## Environment variables

The CLI also understands:

```dotenv
TXLINE_NETWORK=devnet
TXLINE_RPC_URL=https://api.devnet.solana.com
TXLINE_CREDENTIALS_FILE=.txline/devnet.credentials.json
```

Do not put an API token or wallet secret in `.env`, shell history, CI output, issue comments,
or demo recordings. In deployment, mount the credentials file as a secret with mode `600`.

## Troubleshooting

| Symptom                   | Safe action                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| RPC genesis mismatch      | Select the correct network/RPC; the CLI will not sign.                                                             |
| Artifact/program mismatch | Update and re-audit the official IDL before changing the pinned artifact.                                          |
| HTTP 401 after retry      | Re-run after confirming the matching TxLINE API host is healthy.                                                   |
| HTTP 403                  | Confirm credentials network, subscription status, service level, and league access.                                |
| Unsafe file permissions   | Run `chmod 600 <file>`; do not bypass the check.                                                                   |
| Existing credentials file | Reuse it for `fixtures`/`smoke`, choose another path, or explicitly use `--force`.                                 |
| No World Cup fixtures     | The endpoint is healthy but no current snapshot name matched; retain the smoke output and check TxLINE's schedule. |

## TxLINE endpoints used in this increment

- `POST /auth/guest/start` — short-lived guest JWT
- `POST /api/token/activate` — exchange a confirmed subscription plus wallet proof for an API token
- `GET /api/fixtures/snapshot` — live, dynamic fixture and competition discovery
- Solana JSON-RPC `getGenesisHash` — network guard before signing
- Solana program `subscribe` — on-chain access registration

Live ingestion now adds `GET /api/odds/stream` and `GET /api/scores/stream` behind the same
network and authentication boundary. See [live ingestion operations](live-ingestion.md).
Historical replay and on-chain proof validation remain separate increments.
