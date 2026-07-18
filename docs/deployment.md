# Public deployment and judge runbook

LagShield deploys as one Cloudflare application plus one external PostgreSQL database:

| Resource                              | Runtime contract                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| Cloudflare Workers Static Assets      | Globally cached, statically exported Next.js command center                         |
| Cloudflare Worker                     | Same-origin router, one-minute watchdog, secrets boundary, and Durable Object owner |
| Cloudflare Container `LagShieldAgent` | One continuously running 1 GiB Node/Fastify agent in Eastern North America          |
| Neon PostgreSQL                       | Durable event, market, replay, order, receipt, and evaluation state                 |

The Worker serves static files without invoking JavaScript, while `/health`, `/ready`,
`/docs`, `/openapi.json`, `/metrics/*`, and `/v1/*` are proxied to the single named
container. The web application therefore uses relative same-origin requests; there is no
second public hostname or cross-origin failure mode.

The agent intentionally overrides Cloudflare's idle shutdown hook because it owns unattended
TxLINE odds and score streams. A Cron Trigger also starts/checks the same named instance every
minute, so an open browser is never required. `max_instances = 1` preserves the strategy's
single-writer contract. Container disk is treated as ephemeral; all durable state is in
PostgreSQL, and migrations run idempotently before every container start.

Cloudflare does not provide hosted PostgreSQL. Hyperdrive accelerates an **existing**
PostgreSQL or MySQL database, while D1 is a different SQLite-based database. Replacing the
current PostgreSQL store with D1 would require rewriting and re-proving the atomic market lock,
order gate, replay ownership, and migration behavior. The hackathon deployment therefore uses
Neon, an officially documented Cloudflare-compatible PostgreSQL provider, through a direct TLS
connection.

## Cost envelope

The repository selects Cloudflare's `basic` container (1 GiB memory, 1/4 vCPU, 4 GB ephemeral
disk) for demo stability. At 730 continuously running hours, the provisioned memory and disk
overage is approximately **$7.03/month** after the Workers Paid included allotments; active CPU,
Durable Object requests, logs, and unusual network use are variable. The Workers Paid minimum is
$5/month if the account is not already paid. Static asset requests and asset storage are free.

Neon Free currently includes 100 CU-hours and 0.5 GB per project, which is enough for the
submission window and seeded demo. Monitor usage and move to Neon Launch if live proof polling or
event volume approaches those limits. Current source pricing:

- [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Neon pricing](https://neon.com/pricing)

## Prerequisites

- Cloudflare Workers Paid account with Containers enabled.
- Docker running locally; Wrangler builds a `linux/amd64` image.
- A Neon project in an Eastern North America region. Copy its TLS PostgreSQL connection string;
  never paste it into Git, an issue, or a command argument recorded in shell history.
- Node.js and pnpm versions pinned by `.node-version` and `packageManager`.

## First deployment

1. Authenticate interactively and confirm the intended Cloudflare account:

   ```bash
   pnpm exec wrangler login
   pnpm exec wrangler whoami
   docker info
   ```

2. Deploy the Worker, static assets, and container definition:

   ```bash
   pnpm install --frozen-lockfile
   pnpm cloudflare:check
   pnpm cloudflare:deploy
   ```

   Record the generated URL, normally
   `https://lag-shield.<workers-subdomain>.workers.dev`. The static command center is available
   immediately; the container will remain unavailable until its required secrets exist and may
   take several minutes to provision on the first deployment.

3. Add the required runtime secrets using the interactive prompts. Wrangler reads each value
   without placing it in the repository:

   ```bash
   pnpm exec wrangler secret put DATABASE_URL
   pnpm exec wrangler secret put PUBLIC_WEB_ORIGIN
   ```

   `DATABASE_URL` is the Neon TLS connection string. `PUBLIC_WEB_ORIGIN` is the exact public URL
   from the previous step, with no trailing slash.

   Rebuild once with the final origin so Open Graph and X card URLs are also exact:

   ```bash
   NEXT_PUBLIC_LAGSHIELD_WEB_URL=https://lag-shield.<workers-subdomain>.workers.dev \
   pnpm cloudflare:deploy
   ```

4. Verify provisioning and the seeded, credential-free mode:

   ```bash
   pnpm exec wrangler containers list
   curl -fsS https://lag-shield.<workers-subdomain>.workers.dev/health
   curl -fsS https://lag-shield.<workers-subdomain>.workers.dev/ready
   ```

   The entrypoint runs the checked-in Drizzle migrations before starting Fastify, persists the
   seeded manifest and evaluation report, and remains judge-testable even when no match is live.

## Enable live TxLINE input

Add the activated subscription and wallet public key through Worker Secrets:

```bash
pnpm exec wrangler secret put TXLINE_API_TOKEN
pnpm exec wrangler secret put TXLINE_WALLET_PUBLIC_KEY
pnpm exec wrangler secret put TXLINE_LIVE_ENABLED
```

Enter `true` for `TXLINE_LIVE_ENABLED`. Keep the committed network at `devnet` unless the
subscription was activated on mainnet. If a dedicated Solana endpoint is needed, also run
`pnpm exec wrangler secret put TXLINE_RPC_URL`.

After the new version rolls out, `/ready` must report credentials and live ingestion as
configured, and `/metrics/streams` must show both independent supervisors. A connected, quiet
stream is valid; never fabricate sports activity. Use `pnpm cloudflare:tail` for secret-redacted
container and Worker logs.

## Post-deploy proof

Use the single public origin for both variables:

```bash
export LAGSHIELD_WEB_URL=https://lag-shield.<workers-subdomain>.workers.dev
export LAGSHIELD_API_URL="$LAGSHIELD_WEB_URL"

curl -fsS "$LAGSHIELD_API_URL/health"
curl -fsS "$LAGSHIELD_API_URL/ready"
pnpm load:smoke
pnpm judge:smoke
```

`load:smoke` performs 100 bounded reads by default. `judge:smoke` performs the state-changing
proof: seeded replay, `PAUSED`, rejected paper order, automatic recovery to `OPEN`, persisted
order, and linked receipt retrieval. Save both secret-free JSON outputs and a UTC timestamp in
issue #15.

Set the repository Actions variables `LAGSHIELD_API_URL` and `LAGSHIELD_WEB_URL` to the public
origin. The
`Production smoke` workflow then runs 20 read-only checks hourly. Its manual dispatch accepts an
override URL and an explicit `full_judge_flow` switch; the scheduled job never grows the database
with replay runs.

For automatic releases, add GitHub Actions secrets `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`, using Cloudflare's account-scoped **Edit Cloudflare Workers** token
template. Then set the repository variable `CLOUDFLARE_DEPLOY_ENABLED=true`. The deployment
workflow publishes only a protected `main` revision whose CI workflow passed.

After the demo video is hosted, run the strict final gate:

```bash
LAGSHIELD_WEB_URL="$LAGSHIELD_WEB_URL" \
LAGSHIELD_API_URL="$LAGSHIELD_API_URL" \
LAGSHIELD_DEMO_VIDEO_URL=https://video.example.com/demo \
pnpm submission:preflight
```

The final run must use no skip variables. It proves exact CORS, connected TxLINE odds and score
supervisors, enabled proof processing, public documentation/repository/video, and the complete
state-changing judge flow.

## Incognito judge check

1. Confirm the command center loads without authentication or console errors.
2. Run the seeded story and observe `OPEN → PAUSED → RECOVERY → OPEN` without refreshing.
3. Submit the paper order during `PAUSED` and confirm `ORDER_REJECTED_PAUSED`.
4. Open the receipt and confirm exact message IDs/hash plus an honest proof state.
5. Reload and confirm the persisted replay, order, and receipt remain visible.
6. Open `/docs`, `/ready`, and `/v1/evaluations/seeded` directly on the same origin.

## Monitoring and failure response

- The one-minute Cron Trigger prewarms or restarts the named container; GitHub's hourly smoke is
  an independent public-path check.
- `/metrics/operations`, `/metrics/streams`, `/metrics/proofs`, Cloudflare Observability, and
  structured logs distinguish database, TxLINE, Solana RPC, retention, and request failures.
- If `/ready` is red, inspect its dependency state and bounded diagnostics before restarting.
- Use `pnpm exec wrangler containers list` to distinguish image rollout from runtime failure.
- Neon storage/compute usage and Cloudflare container memory/CPU should have billing alerts.

## Redeploy and rollback

`pnpm cloudflare:deploy` builds the static export, builds/pushes the container, and deploys the
Worker as one release. The container receives `SIGTERM`; LagShield drains workers, stops both SSE
readers, and closes PostgreSQL. Migrations are additive and idempotent.

Use Cloudflare's Workers **Deployments** page or Wrangler's deployment commands to roll back the
Worker version. Container rollouts follow the version and retain PostgreSQL state because local
disk is never authoritative. Never roll back by deleting tables. After any redeploy or rollback,
run `pnpm load:smoke`; run `pnpm judge:smoke` once before handing the environment back to judges.
