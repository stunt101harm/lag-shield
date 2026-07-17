# Deterministic soccer risk policy

LagShield policy `lag-shield-soccer-risk-v1` is a deterministic safety controller, not an
ML or LLM trading signal. Given the same ordered inputs, logical timestamps, and configuration,
it emits the same byte-stable decision payload.

## Authoritative score semantics

The classifier follows the current [TxLINE soccer feed](https://txline.txodds.com/documentation/scores/soccer-feed)
and its linked [Soccer Feed v1.1 specification](https://txodds.github.io/tx-on-chain/assets/txodds-soccer-feed-v1.1.pdf).
The current OpenAPI `Scores` object supplies `action`, stable action `id`, `confirmed`,
`statusSoccerId`, and `dataSoccer` where available. Normalized score payload version 2 retains:

- action identity and confirmation state;
- possible goal, penalty, red-card, and VAR flags;
- VAR/penalty outcome and VAR review type;
- amendment/discard references and feed reliability.

Some historical or simplified messages omit those optional semantic fields. They remain `null`
and are classified as unknown rather than invented. Explicit payload version 1 remains readable
for older replay manifests.

## Event classification

| TxLINE evidence                                        | Normalized signal                               |         Severity | Immediate action                 |
| ------------------------------------------------------ | ----------------------------------------------- | ---------------: | -------------------------------- |
| `possible` with Goal, Penalty, RedCard, or VAR         | matching possible signal                        |         critical | pause                            |
| unconfirmed or confirmed `goal`                        | goal                                            |         critical | pause                            |
| `penalty`; scored or retaken `penalty_outcome`         | penalty                                         |         critical | pause                            |
| missed `penalty_outcome`                               | penalty missed                                  |             high | pause                            |
| `red_card`                                             | red card                                        |         critical | pause                            |
| `var`                                                  | VAR started, preserving review type             |         critical | pause                            |
| `var_end` with `Stands`                                | VAR stands                                      |             high | pause, then converge             |
| `var_end` with `Overturned`                            | VAR reversal                                    |             high | pause, shortened resolution hold |
| `action_amend`, `action_discarded`, `score_adjustment` | correction/reversal                             | high or critical | pause                            |
| `suspend` unreliable or scout `disconnected`           | feed unreliable                                 |         critical | pause                            |
| `suspend` reliable                                     | feed recovered                                  |              low | no direct reopen                 |
| unsafe status IDs 14-19                                | interrupted/abandoned/cancelled/coverage unsafe |         critical | pause                            |
| ordinary `status` change                               | phase change                                    |              low | widen                            |

TxLINE documents unconfirmed actions as the earlier, lower-latency indication whose final
confirmation may arrive later under the same action ID. LagShield therefore protects on the
unconfirmed message instead of waiting. Amendments and reversals do not directly reopen a
market; quotes must still converge through `RECOVERY`.

## Market risk inputs

All probability units are millionths and all time units are milliseconds unless stated.

| Input            | Definition                                                                 |
| ---------------- | -------------------------------------------------------------------------- |
| quote age        | oldest fresh quote age at the explicit logical timestamp                   |
| stale fraction   | stale latest bookmaker vectors / all latest bookmaker vectors, ppm         |
| velocity         | maximum absolute consensus outcome velocity, probability millionths/second |
| dispersion       | maximum outcome median absolute deviation, probability millionths          |
| reaction latency | maximum measured first material bookmaker response after the event         |
| unreacted books  | tracked books without a material post-event response                       |
| proof status     | unavailable, pending, verified, or failed                                  |

The v1 thresholds are embedded in every v2 decision and covered by a configuration hash:

| Guard                       |       Widen |       Pause |          Recovery maximum |
| --------------------------- | ----------: | ----------: | ------------------------: |
| oldest fresh quote age      |       2,000 |       5,000 |                     1,500 |
| stale bookmaker fraction    | 250,000 ppm | 500,000 ppm |                     0 ppm |
| absolute consensus velocity |    20,000/s |    60,000/s |                  10,000/s |
| dispersion MAD              |      20,000 |      50,000 |                    15,000 |
| reaction latency            |       1,500 |       4,000 | all tracked books reacted |

Additional guards:

- At least one fresh source is required because the World Cup product may expose only the
  upstream `TXStablePriceDemargined` source. The quorum is configurable for feeds that expose
  multiple distinct bookmaker IDs.
- Missing/insufficient consensus, a lost fresh-source quorum, or failed proof verification
  fails safe to `PAUSED`.
- Pending or unavailable proof is recorded but never delays an immediate protective pause.
- Critical shocks hold for 8,000 ms. A documented reversal shortens the unresolved hold to
  2,000 ms so recovery can start after the market absorbs the correction.

## Transition table and hysteresis

| Previous | Guard                                                         | Action         | Next     |
| -------- | ------------------------------------------------------------- | -------------- | -------- |
| OPEN     | any pause guard or active shock                               | PAUSE          | PAUSED   |
| OPEN     | any widen guard                                               | WIDEN          | WIDENED  |
| OPEN     | otherwise                                                     | KEEP_OPEN      | OPEN     |
| WIDENED  | any pause guard                                               | PAUSE          | PAUSED   |
| WIDENED  | recovery-safe after 2,000 ms                                  | ENTER_RECOVERY | RECOVERY |
| WIDENED  | otherwise                                                     | KEEP_WIDENED   | WIDENED  |
| PAUSED   | recovery-safe, shock cleared, paused at least 2,000 ms        | ENTER_RECOVERY | RECOVERY |
| PAUSED   | otherwise                                                     | KEEP_PAUSED    | PAUSED   |
| RECOVERY | any pause guard or new shock                                  | PAUSE          | PAUSED   |
| RECOVERY | three consecutive recovery-safe updates and 3,000 ms cooldown | REOPEN         | OPEN     |
| RECOVERY | otherwise                                                     | KEEP_RECOVERY  | RECOVERY |

There is no `PAUSED -> OPEN` or `WIDENED -> OPEN` edge. A market cannot reopen without
passing through recovery. Any unsafe update resets the convergence count; a new pause guard in
recovery immediately returns to `PAUSED`.

## Decision reproducibility

Every applied input emits a decision, including safe self-transitions. Decision payload v2
stores:

- policy version and the complete threshold table;
- policy-configuration SHA-256 hash;
- previous and next state plus optimistic state version;
- stable trigger and contributing event IDs;
- ordered reason codes and numeric evidence metrics;
- SHA-256 hash of the complete input feature bundle and prior state.

For v2 decisions, the configuration hash is also part of the idempotency key. Two threshold
sets therefore cannot collide under the same trigger, market, and human-readable policy version.
The receipt metrics retain absolute `lastStateChangeAtMs`, `shockUntilMs`, and the recovery
counter so the complete cooldown state can be restored after a process restart.

Duplicate trigger IDs return the cached byte-identical decision and do not advance state. Inputs
older than the last applied logical timestamp emit no decision and do not mutate state. No policy
calculation reads wall-clock time. A metric value of `-1` means the upstream measurement was not
available; the typed feature input uses `null` before receipt serialization.
