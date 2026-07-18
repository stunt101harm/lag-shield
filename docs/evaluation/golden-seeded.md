# LagShield deterministic evaluation

- Evaluation hash: `867f36f2180a5dd54ebced5025350f1b22d103cee882716dc2a2444283ac748f`
- Replay manifest: `rplm_f32d358ef3561cd30dc9cec2f2cea5a6818cacb2`
- Fixture: `seeded-world-cup-canada-japan`
- Data mode: `seeded-simulation`
- Policy: `lag-shield-soccer-risk-v1` / `f807f4f5396190944732aa7f944c0223368546e6f35c01bcf2dceb5f189d441b`

## Result

LagShield entered PAUSED at the protective signal. The first material consensus move arrived **8,000 ms** later. The market spent **12,000 ms** in PAUSED and reopened after **18,000 ms**, with **0** recovery flaps.

The rejected paper-order sample had an absolute post-convergence probability-distance proxy of **20.0 pp**. This is explicitly **not P&L** and does not claim causal profit protection.

## Bookmaker reaction latency

| Bookmaker | First material reaction |
| --------- | ----------------------: |
| consensus |                8,000 ms |

## Normal-play control

The pre-signal control window covered **59,000 ms**, contained **1** decision, and produced **0** restrictive transitions.

## Sensitivity

| Variant                         | Pause duration | Time to reopen | Final state | Recovery flaps |
| ------------------------------- | -------------: | -------------: | ----------- | -------------: |
| conservative-recovery-4-updates |      12,000 ms |   not observed | RECOVERY    |              0 |
| faster-recovery-2-updates       |      12,000 ms |      15,000 ms | OPEN        |              0 |
| longer-critical-hold-16s        |      18,000 ms |   not observed | RECOVERY    |              0 |

## Parameters

- Material consensus move: 5.0 pp
- Stable convergence window: 10,000 ms
- Convergence tolerance: 0.5 pp
- Critical shock hold: 8,000 ms
- Recovery quorum: 3 stable updates

## Limitations

- The avoided-price-error value is an absolute probability-distance proxy, not P&L, profit, or causal attribution.
- An unconfirmed event without a later confirmation or reversal remains indeterminate; it is not labelled a false positive.
- Reaction latency is limited to bookmakers and reported probabilities present in the evaluated feed.
- A seeded-simulation report demonstrates deterministic behavior, not historical production performance.
