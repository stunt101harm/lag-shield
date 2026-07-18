# Production readiness and fault model

LagShield fails closed around market execution and fails visibly around dependencies. This
runbook is the engineering gate for unattended operation; it does not claim multi-region
availability or real-money certification.

## Safety invariants

1. Persisted TxLINE input commits before strategy dispatch. Duplicate source messages cannot
   create duplicate domain events, decisions, receipts, or simulated orders.
2. A process never resumes an in-memory replay clock after restart. Startup locks every
   `pending`, `running`, or `paused` replay and terminalizes it as `failed`, preserving its
   exact progress. A fresh run requires a new run ID.
3. Market state is durable. Admission checks and state transitions serialize under the same
   PostgreSQL advisory lock, so an order cannot race through a pause.
4. Missing or failed proof is explicit and never rendered as verified. A protective pause
   does not wait for Solana RPC availability.
5. Historical raw payload expiry removes only the upstream payload body. Canonical derived
   events, hashes, manifests, decisions, receipts, and evaluation reports remain durable.

## Dependency failure matrix

| Failure                             | Bounded behavior                                                                                | Visible evidence                                                             | Safety choice                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| TxLINE connection/heartbeat outage  | Independent stream abort, exponential backoff with jitter capped at 30 s, no unbounded queue    | `/metrics/streams` state, reconnect count, lag, retry delay, safe diagnostic | Existing market state remains durable; stale-data features can widen or pause |
| TxLINE 401                          | One coalesced guest-JWT renewal, then reconnect with the unchanged subscription token           | Stream reconnect and authentication diagnostic                               | No fabricated events                                                          |
| TxLINE 403                          | Capped retry with `subscription_denied` diagnostic                                              | `/metrics/streams`                                                           | No fallback to an unlicensed or mismatched network                            |
| Malformed or oversized stream event | 1 MiB parser cap; malformed records enter durable quarantine                                    | Quarantine counter and raw-ingest status                                     | Invalid input never reaches projections or strategy                           |
| Solana RPC/proof outage             | Verification run records bounded error/unavailable state and retries on the worker interval     | `/metrics/proofs` and receipt lifecycle                                      | No verified claim; market protection continues                                |
| PostgreSQL unavailable              | Requests fail with a request ID; `/ready` returns 503; pool connection attempts time out        | `/ready`, `/metrics/operations`, structured error log                        | No in-memory substitute for durable execution                                 |
| Agent terminated during replay      | Graceful signals drain in-flight work; ungraceful restart reconciles the orphan under a DB lock | Startup recovery snapshot and terminal `failed` replay                       | Never auto-resume or duplicate the abandoned run                              |
| Retention purge failure             | One bounded batch, no overlapping jobs, error retained for the next interval                    | `/metrics/operations` maintenance snapshot                                   | Ingestion continues; operator sees cleanup degradation                        |

## Public boundary

- Request bodies default to 64 KiB and list/timeline inputs have explicit upper bounds.
- Public requests default to 300 per source per minute; the realtime SSE endpoint has its own
  bounded replay buffer and heartbeat lifecycle.
- CORS is an exact origin allowlist. Production responses add HSTS; API responses add CSP,
  frame denial, MIME sniffing denial, referrer, permissions, and no-store policies.
- Every response carries a generated request ID. Structured replay, decision, proof, event,
  and order logs carry the relevant fixture, market, replay, decision, receipt, and event IDs.
- Logger redaction covers authorization, cookies, TxLINE subscription headers, JWTs, private
  keys, and wallet secret fields. Operational endpoints never return environment values.

## Operations

```bash
# Liveness and dependency readiness
curl -fsS https://agent.example.com/health
curl -fsS https://agent.example.com/ready

# Stream/proof/realtime and process/maintenance evidence
curl -fsS https://agent.example.com/metrics/streams
curl -fsS https://agent.example.com/metrics/proofs
curl -fsS https://agent.example.com/metrics/operations

# Bounded 100-request deployment smoke (10 concurrent workers)
LAGSHIELD_API_URL=https://agent.example.com pnpm load:smoke
```

The load smoke requires `/health`, `/ready`, `/metrics/operations`, and the seeded evaluation
to return success. It caps concurrency at 50, requests at 1,000, and each fetch at five
seconds. Its JSON result reports failure count and p50/p95/maximum latency without response
bodies or secrets.

## Executable evidence

| Scenario                                                                         | Evidence                                                                               |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Forced SSE disconnect, resume cursor, heartbeat and connection timeouts, 401/403 | `packages/txline/src/live.integration.test.ts` and `client.stream.integration.test.ts` |
| Bounded backpressure, durable quarantine, dispatch-after-commit                  | `apps/agent/src/ingest/live-txline.test.ts`                                            |
| RPC/proof failure is explicit and the worker survives                            | `apps/agent/src/proof/decision-proof-service.test.ts`                                  |
| Database dependency returns not-ready                                            | `apps/agent/src/app.test.ts`                                                           |
| Restart during replay is terminalized once and cannot run again                  | `apps/agent/src/db/domain-store.integration.test.ts`                                   |
| Retention is bounded, coalesced, and failure-tolerant                            | `apps/agent/src/operations/maintenance.test.ts`                                        |
| Headers, body cap, CORS, rate limit, and secret-free telemetry                   | `apps/agent/src/app.test.ts`                                                           |
| Tracked and untracked source has no known credential token signature             | `pnpm security:scan`                                                                   |
| Production dependency vulnerability audit                                        | `pnpm security:audit`                                                                  |

## Release gate

- [x] Strict environment schema with bounded numeric configuration
- [x] Liveness, database readiness, and secret-free operational telemetry
- [x] Graceful drain of retention, proof, ingestion, HTTP, and database resources
- [x] Transactional startup reconciliation with an idempotence integration test
- [x] Bounded external timeouts, SSE memory, reconnect backoff, public bodies, and queries
- [x] Scheduled bounded retention with failure visibility
- [x] Structured correlation and central logger redaction
- [x] Security headers, CORS allowlist, public rate limiting, and generic errors
- [x] Repository secret scan and production dependency audit commands
- [x] Fault-injection tests for stream, proof, database-readiness, malformed input, and restart
- [ ] Public HTTPS cold-start, load smoke, and credential-gated TxLINE smoke (deployment #15)

The remaining unchecked item requires the public deployment rather than a code change and is
tracked by issue #15.
