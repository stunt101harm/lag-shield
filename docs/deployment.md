# Public deployment and judge runbook

LagShield deploys from one Render Blueprint into three resources:

| Resource                       | Render type                | Runtime contract                                                                     |
| ------------------------------ | -------------------------- | ------------------------------------------------------------------------------------ |
| `lagshield-agent-stunt101harm` | Starter web service        | One continuously running Fastify/SSE agent, one process owner, `/ready` health check |
| `lagshield-web-stunt101harm`   | Free global static site    | Exported Next.js command center with the agent hostname embedded at build time       |
| `lagshield-postgres`           | Basic 256 MB PostgreSQL 17 | Private-network-only database, 15 GB disk, release-time Drizzle migrations           |

The agent uses Starter because free dynamic services spin down after an idle window, which is
incompatible with unattended TxLINE streaming. The browser application has no runtime server
state, so it is exported to Render's free static CDN and cannot cold-start. The Blueprint is
still billable and must be approved by the repository owner before resources are created.

At Render's July 2026 list prices, the baseline is approximately **$17.50/month**, prorated:
$7 for one Starter agent, $6 for Basic-256mb PostgreSQL compute, and $4.50 for 15 GB database
storage at $0.30/GB. The Hobby workspace and static site are $0. Bandwidth or build overages
can add cost; verify the provider review screen before approval. See Render's
[current pricing](https://render.com/pricing) and
[flexible Postgres storage pricing](https://render.com/docs/postgresql-refresh).

The root [`.node-version`](../.node-version) pins Node.js 24.18.0 LTS and `packageManager`
pins pnpm 11.9.0. The agent also has a portable multi-stage
[`Dockerfile`](../apps/agent/Dockerfile), built by CI even though the primary Blueprint uses
Render's native Node runtime for faster releases.

## First deployment

1. Confirm the complete stack is present on `main` and its GitHub quality gate is green.
2. In Render, create a **Blueprint** from `stunt101harm/lag-shield`, select
   `main`, and use the repository-root `render.yaml`.
3. Review the Starter agent, free static site, and Basic PostgreSQL instance, then explicitly
   approve the recurring compute/storage cost. The agent and database remain in `ohio`; the
   static site is distributed globally.
4. Wait for PostgreSQL, the agent pre-deploy migration, agent `/ready`, and the static-site
   publish to become green.
5. Record the generated HTTPS URLs. Do not add a token or wallet value to Git, a build
   command, or a URL.

The agent boots with `TXLINE_LIVE_ENABLED=false`, persists the hash-addressed seeded manifest
and evaluation report, and remains fully judge-testable even when no match is live. Enabling
TxLINE is a separate secret-store operation after the activated subscription is available.

## Enable live TxLINE input

The Blueprint selects `TXLINE_CREDENTIALS_SOURCE=environment`. Add these variables in the
agent's Render environment settings:

| Variable                   | Visibility      | Value                                 |
| -------------------------- | --------------- | ------------------------------------- |
| `TXLINE_API_TOKEN`         | Secret          | Activated TxLINE subscription token   |
| `TXLINE_WALLET_PUBLIC_KEY` | Plain or secret | Public key that owns the subscription |
| `TXLINE_LIVE_ENABLED`      | Plain           | `true` only after both values exist   |

Keep `TXLINE_NETWORK=devnet` unless the subscription was activated on mainnet. A mismatch
fails startup. The API token remains provider-managed, is covered by logger redaction, and is
never included in the browser bundle or public API.

After the restart, confirm `/ready` reports credentials/live ingestion as configured and
`/metrics/streams` reports both independent supervisors. A quiet stream with a successful
connection is valid; never fabricate activity for the demo.

## Post-deploy proof

Use the exact agent URL returned by Render:

```bash
export LAGSHIELD_API_URL=https://lagshield-agent-stunt101harm.onrender.com

curl -fsS "$LAGSHIELD_API_URL/health"
curl -fsS "$LAGSHIELD_API_URL/ready"
pnpm load:smoke
pnpm judge:smoke
```

`load:smoke` performs 100 bounded reads by default. `judge:smoke` performs the state-changing
proof: seeded replay, `PAUSED`, rejected paper order, automatic recovery to `OPEN`, persisted
order, and linked receipt retrieval. Save both JSON outputs and a UTC timestamp in the issue
#15 evidence comment.

Set the repository Actions variable `LAGSHIELD_API_URL` to the agent URL. The
`Production smoke` workflow then runs 20 read-only checks hourly. Its manual dispatch accepts
an override URL and an explicit `full_judge_flow` switch; the scheduled job never grows the
database with replay runs.

After the demo video is hosted, run the stricter final gate with the exact public web, agent,
and video URLs:

```bash
LAGSHIELD_WEB_URL=https://web.example.com \
LAGSHIELD_API_URL=https://agent.example.com \
LAGSHIELD_DEMO_VIDEO_URL=https://video.example.com/demo \
pnpm submission:preflight
```

The final run must use no skip variables. It additionally proves exact CORS, connected TxLINE
odds and score supervisors, enabled proof processing, public documentation/repository/video,
and the complete state-changing judge flow. Save its secret-free JSON output with the
submission evidence described in the [five-minute demo runbook](demo-script.md).

## Incognito judge check

Open the web URL in a private browser with developer tools visible:

1. Confirm the command center loads without authentication or console/CORS errors.
2. Run the seeded story and observe `OPEN → PAUSED → RECOVERY → OPEN` without refreshing.
3. Submit the paper order during `PAUSED` and confirm `ORDER_REJECTED_PAUSED`.
4. Open the receipt and confirm exact message IDs/hash plus an honest proof state.
5. Reload the page and confirm the persisted replay, order, and receipt remain visible.
6. Open the agent `/docs`, `/ready`, and `/v1/evaluations/seeded` URLs directly.

## Monitoring and failure response

- Render probes agent `/ready`; enable agent service-unhealthy plus agent/static-site
  deploy-failed email notifications.
- GitHub's hourly read-only smoke provides an independent public-path check.
- `/metrics/operations`, `/metrics/streams`, `/metrics/proofs`, and structured logs distinguish
  database, TxLINE, Solana RPC, retention, and request failures without secret values.
- If `/ready` is red, do not restart repeatedly. Inspect its dependency state and the latest
  bounded diagnostic first; the seeded UI remains the fallback only when the database is ready.

## Redeploy and rollback

Every successful push after CI triggers an automatic deploy. The agent build runs
`pnpm db:migrate` before traffic moves to the new instance; Drizzle records applied migrations,
so rerunning the release command is safe. Render sends `SIGTERM` and allows up to 60 seconds
for the agent to drain workers and close PostgreSQL.

To redeploy, select the last successful commit in the service's Render **Deploys** tab and
choose **Redeploy**. To roll back application code, choose **Rollback** on the previous healthy
deploy for both agent and web. Current migrations are additive; never roll back PostgreSQL by
deleting tables. If a future release requires a destructive schema reversal, restore or fork a
database backup first and point a separately deployed agent at it.

After any redeploy or rollback, run `pnpm load:smoke`; run `pnpm judge:smoke` once before
handing the environment back to judges.
