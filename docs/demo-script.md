# Five-minute demo and submission preflight

This is the recording source of truth for issue #17. The goal is to prove a running product,
TxLINE ingestion, autonomous control, executed rejection, recovery, and auditability before
discussing architecture. Target **4:35–4:50** so normal pauses never cross the hard five-minute
limit.

## Frozen scenario and fallback order

1. **Primary product story:** committed seeded Canada–Japan manifest
   `rplm_f32d358ef3561cd30dc9cec2f2cea5a6818cacb2` at 2× speed. Its eight events and evaluation
   hash `867f36f2180a5dd54ebced5025350f1b22d103cee882716dc2a2444283ac748f` are immutable.
2. **Live-integration proof:** public `/ready`, `/metrics/streams`, and TxLINE-backed fixture
   list/timestamps. A quiet connected stream is valid; do not wait for or fabricate a match.
3. **Historical backup:** hydrate one completed World Cup fixture inside TxLINE's current
   availability window during the dress rehearsal and record its manifest ID in the evidence
   comment. Do not hard-code a rolling fixture here before it is captured.
4. **Offline backup asset:** the committed
   [paused-state screenshot](assets/command-center-paused.png), golden evaluation, and a local
   `pnpm replay:seeded` run. These are visibly labelled simulation and never replace the required
   proof that the deployed agent accepts live TxLINE input.

## Pre-recording setup

- Use a clean browser profile at 1920×1080, 100% zoom, with notifications and password-manager
  overlays disabled.
- Close wallets, provider dashboards, terminals containing environment variables, personal
  tabs, and messaging applications.
- Open only the public command center, public API docs, `/ready`, `/metrics/streams`, one receipt,
  and the repository architecture section.
- Confirm the command center begins in standby or at a completed run. **Run scenario again** is
  a one-click reset: an active replay is stopped before a fresh namespaced replay starts.
- Record system audio/microphone at 1080p. Keep the cursor deliberate and never select raw JSON
  fields that could expose operational identifiers unnecessarily.

Run the strict production preflight immediately before the dress rehearsal and recording:

```bash
export LAGSHIELD_WEB_URL=https://PUBLIC_WEB_HOST
export LAGSHIELD_API_URL=https://PUBLIC_AGENT_HOST
export LAGSHIELD_DEMO_VIDEO_URL=https://PUBLIC_VIDEO_URL
pnpm submission:preflight
```

Before the video exists, only the recording rehearsal may use
`LAGSHIELD_PREFLIGHT_SKIP_VIDEO=true`. Before live credentials are activated, local development
may use `LAGSHIELD_PREFLIGHT_SKIP_LIVE_TXLINE=true`. Neither bypass is acceptable for final
submission evidence. The default preflight requires:

- public UI, repository, video, Swagger, and OpenAPI access;
- exact production CORS;
- ready PostgreSQL plus configured live TxLINE credentials;
- both TxLINE stream supervisors connected and the proof worker enabled;
- the seeded evaluation hash contract; and
- a state-changing pause → rejected paper order → recovery → persisted receipt flow.

## Timed recording script

| Time      | Screen action                                             | Narration target                                                                                                                                                            | Judging proof                                |
| --------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 0:00–0:22 | Command center standby/hero                               | “A match can change before an in-play market catches up. LagShield is an autonomous TxLINE-powered circuit breaker that blocks stale exposure in that gap.”                 | Problem, product, novelty                    |
| 0:22–0:48 | Briefly show stream status, then architecture diagram     | “Independent TxLINE odds and score streams become durable normalized facts. Deterministic consensus and risk logic control a paper order gate; PostgreSQL is truth.”        | Data ingestion, architecture, autonomy       |
| 0:48–1:05 | Select 2× and **Run winning demo**                        | “Because judges may review between matches, this immutable eight-event simulation exercises the exact live normalization, strategy, gate, receipt, API, and UI path.”       | Honest deterministic fallback                |
| 1:05–1:48 | Point to possible goal, `PAUSED`, reason codes, freshness | “An unconfirmed possible goal is enough to protect. LagShield pauses immediately; it never waits for confirmation, consensus movement, a proof API, or a human.”            | Autonomous defined strategy and execution    |
| 1:48–2:10 | Select **Test order now**                                 | “This is an actual request to the simulated market adapter. The same database lock serializes pause and admission, so the stale order returns `ORDER_REJECTED_PAUSED`.”     | Executed action, atomic architecture         |
| 2:10–2:35 | Watch `RECOVERY → OPEN`; point to progress 8/8            | “There is no direct paused-to-open edge. Three safe updates plus cooldown are required; a new shock fails back to paused.”                                                  | Hysteresis and unattended recovery           |
| 2:35–3:08 | Open decision evidence/receipt                            | “The receipt hashes the full decision and exact source identities. TxLINE proof material is separately checked against its Solana daily root. Non-verified stays visible.”  | Explainability and cryptographic integrity   |
| 3:08–3:35 | Point to the hash-addressed evidence strip/evaluation     | “In this fixed run LagShield paused eight seconds before material consensus movement. The blocked sample is 20 percentage points from convergence—an error proxy, not P&L.” | Defensible evaluation and claim hygiene      |
| 3:35–4:05 | Open `/ready`, `/metrics/streams`, and `/docs`            | “The public agent is independently testable. Live TxLINE is configured, both supervisors are connected, the proof worker is enabled, and the contract is OpenAPI.”          | Required live input and production readiness |
| 4:05–4:30 | Repository architecture/quality evidence                  | “The core is deterministic TypeScript with integer math, replay hashes, migrations, recovery tests, rate limits, secret scanning, a container, and automated smoke.”        | Logic quality and deployment credibility     |
| 4:30–4:48 | Return to open command center                             | “For a sportsbook, exchange, or market maker, LagShield turns TxLINE into a portable safety layer: react now, recover carefully, and prove every decision later.”           | Business value and close                     |

Do not spend recording time scrolling code, reading every threshold, showing provider setup,
or explaining the hackathon. The repository supplies that depth after the video earns attention.

## Claim guardrails

Say:

- “paper order” or “simulated market adapter”;
- “probability-distance proxy, not P&L”;
- “receipt hash plus TxLINE proof lifecycle”;
- “read-only Solana proof simulation”; and
- “seeded simulation through the production decision path.”

Never say:

- “we prevented a $X loss,” “profitable,” or “backtested win rate”;
- “the LagShield decision/order is on-chain”;
- “verified” while the visible proof is pending, unavailable, rejected, or error;
- “live TxLINE event” while showing the seeded scenario; or
- “real bookmaker order,” “settlement,” or “real money.”

## Hosting copy

Suggested title:

> LagShield — Autonomous TxLINE Market Circuit Breaker | World Cup Hackathon Demo

Suggested description:

> LagShield ingests TxLINE odds and scores, detects stale in-play exposure around match-changing events, autonomously controls a simulated order gate, and produces deterministic receipts with TxLINE/Solana proof lifecycle evidence. Built by stunt101harm. Source and public demo links are in the description.

Set visibility to public or unlisted-with-link, disable any login gate, and verify playback in
an incognito window at 1080p before copying the URL into the README and submission brief.

## Final submission checklist

- [ ] `pnpm submission:preflight` passes with no skip variables.
- [ ] Full incognito run reaches `OPEN → PAUSED → RECOVERY → OPEN` and rejects the paper order.
- [ ] Video is ≤5:00, audible, readable at 1080p, and understandable without betting expertise.
- [ ] Video visibly proves raw/live TxLINE configuration, autonomous logic, action, recovery,
      receipt, evaluation, API, and business value.
- [ ] README and submission brief contain exact public UI/API/video URLs.
- [ ] Public repo default branch contains the complete stack and green CI.
- [ ] No secrets, personal notifications, provider dashboards, or owner-only links appear.
- [ ] Backup screenshot, golden evaluation, preflight JSON, and final video file are retained.
- [ ] Submission confirmation page/email is captured with a UTC timestamp.
- [ ] A final independent watch-through maps each judging criterion to a visible timestamp.
