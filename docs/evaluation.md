# Deterministic strategy evaluation

LagShield evaluates a safety controller, not a winner-prediction model. Every report is
derived from an ordered replay manifest, the exact risk-policy configuration, and explicit
evaluation parameters. The report hash covers all metrics, diagnostics, sensitivity rows,
limitations, and source hashes.

The committed seeded golden report is available as
[`golden-seeded.json`](evaluation/golden-seeded.json) and
[`golden-seeded.md`](evaluation/golden-seeded.md). It proves reproducibility and the demo
journey; it is not presented as historical production performance.

## Reproduce

```bash
pnpm evaluation:seeded -- --format json
pnpm evaluation:seeded -- --format markdown
```

`pnpm replay:hydrate` also evaluates the hydrated TxLINE historical manifest, persists the
hash-addressed report in `evaluation_reports`, and includes it in its output. The hydration
path persists the exact replay manifest before evaluation, so every historical report can be
regenerated from its `manifestId`, input hash, event-sequence hash, strategy hash, and
policy-configuration hash. Agent startup does the same for the always-available seeded report.

## Formulas and units

Probabilities use millionths (`1,000,000 = 100%`) and time uses milliseconds.

| Metric                                | Formula                                                                                  | Default window / threshold      | Limitation                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| Material consensus move               | `max_outcome(abs(p_t - p_pre_event)) >= threshold`                                       | 50,000 (5.0 pp)                 | Requires matching normalized outcome IDs and a ready pre-event consensus.                |
| Event-to-first-consensus-move latency | `first_material_move_at - protective_event_at`                                           | First post-event observation    | Descriptive timing; it does not prove causality.                                         |
| Per-bookmaker reaction latency        | First normalized bookmaker vector crossing the material-move threshold minus event time  | Same 5.0 pp threshold           | Only books and reported probabilities present in the feed are measurable.                |
| Stale-exposure duration               | Same interval as event-to-first-material-move latency                                    | First post-event move           | Measures a stale-quote window, not realized loss.                                        |
| Pause duration                        | Sum of `PAUSED` intervals, ending at the first non-`PAUSED` decision or replay end       | Replay logical time             | A longer pause may be intentional because velocity, freshness, or quorum remains unsafe. |
| Time to reopen                        | First `RECOVERY -> OPEN` time minus protective-event time                                | Complete replay                 | `null` means the replay ended before recovery quorum, not that the system failed.        |
| State transitions                     | Count of decisions where `previousState != nextState`                                    | Complete replay                 | Safe self-transitions are retained in the trace but not counted here.                    |
| Recovery flapping                     | Count of `RECOVERY -> PAUSED/WIDENED` re-entries                                         | Complete replay                 | Ordinary monotonic recovery is not a flap.                                               |
| Converged consensus                   | First materially moved vector that remains within 5,000 (0.5 pp) of itself for 10,000 ms | 10 s stable window              | Requires observations spanning the full forward window.                                  |
| Avoided-price-error proxy             | `abs(requested_probability - converged_probability)` for a rejected paper order          | Post-event converged vector     | Absolute probability distance only: **not P&L, profit, or causal protection**.           |
| Overlong-pause diagnostic             | `max(0, pause_exit - convergence_start - grace)`                                         | 5 s grace                       | A diagnostic for review, not proof that a pause was wrong.                               |
| Normal-play control                   | Restrictive transitions before the selected protective signal                            | First ready consensus to signal | A within-fixture control window, not a randomized counterfactual.                        |

## False-pause diagnostic

The report never invents event truth:

- a confirmed score action is `confirmed_signal`;
- an explicit later reversal or VAR overturn is `overturned_signal`;
- an unconfirmed signal without later resolution is `indeterminate_unconfirmed`;
- a replay without a protective score signal is `no_protective_signal`.

`indeterminate_unconfirmed` is intentionally not called a false positive. Historical feeds can
omit confirmation/amendment messages, so absence of later evidence is not evidence of error.

## Golden result

For the deterministic Canada–Japan seeded scenario:

- LagShield pauses on the unconfirmed goal at logical time `18:01:00`.
- The consensus first crosses the 5.0 pp material-move threshold 8 seconds later.
- The rejected paper-order sample is 20.0 percentage points from the converged probability.
- `PAUSED` lasts 12 seconds; the system reopens 18 seconds after the signal.
- The 59-second normal-play control window has zero restrictive transitions.
- Recovery has zero flaps.

Sensitivity changes only configuration:

- two stable recovery updates reopen after 15 seconds;
- four stable updates end the bounded replay in `RECOVERY`;
- a 16-second critical hold keeps the replay in `RECOVERY` at its end.

These rows show the safety/availability tradeoff without optimizing against profit.

## Determinism contract

Identical ordered events, manifest, policy, and evaluation parameters produce byte-identical
JSON and the same SHA-256 evaluation hash. Sensitivity variants receive their own hashes.
Wall-clock time, network state, and replay speed are excluded from all calculations.
