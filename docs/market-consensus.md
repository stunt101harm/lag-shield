# Market identity and consensus mathematics

LagShield converts TxLINE's reported probability percentages into deterministic integer
features. It does not guess undocumented price units.

## Source contract and an important boundary

The current [TxLINE odds overview](https://txline.txodds.com/documentation/odds/overview)
describes StablePrice as an upstream consensus engine with built-in de-margining, stale-line
filtering, and outlier defense. The current
[OpenAPI source](https://txline.txodds.com/docs/docs.yaml) defines:

- `Prices` as an array of signed 32-bit integers, without specifying its scale or conversion
  formula.
- `Pct` as strings formatted to exactly three decimal places, with `NA` allowed for quarter
  handicap lines. Its example is `52.632`.

Consequently, formula version `reported-pct-proportional-median-v1` uses `Pct` and retains
`Prices` unchanged as `txline-native-i32-v1` diagnostic/source values. It never assumes that
`2100` means decimal odds `2.100`, American odds, basis points, or another encoding. A future
official price-unit contract must ship as a new payload and formula version.

The World Cup feed commonly identifies the upstream source as the de-margined StablePrice
product rather than exposing its constituent bookmakers. LagShield's estimator supports
multiple distinct `BookmakerId` vectors if TxLINE actually returns them, but the product and
demo must not claim to reconstruct private constituent-book prices from one StablePrice
record.

## Exact percentage representation

Probabilities use integer millionths:

```text
probabilityScale = 1,000,000
reportedProbabilityMicros = wholePercent * 10,000 + decimalThousandths * 10
```

Thus `52.632` becomes `526,320` exactly, with no binary floating-point conversion.
`0.001` becomes `10`, and `100.000` becomes `1,000,000`. `NA`, missing `Pct`, an empty
vector, duplicate outcome IDs, and non-positive sums remain visible diagnostics and are not
used in consensus.

## Residual normalization

Even de-margined percentages can differ slightly from 100% because of rounding. For a
complete vector with reported values `r_i` and sum `R > 0`, LagShield applies proportional
normalization:

```text
q_i = r_i / R
```

The integer implementation calculates `floor(r_i * 1,000,000 / R)`, then assigns remaining
millionths by descending division remainder with `outcomeId` as the tie-break. The output
therefore sums to exactly `1,000,000` and is invariant to input order.

Worked example:

| Outcome | Reported | Reported micros | Normalized micros |
| ------- | -------: | --------------: | ----------------: |
| Home    |  50.000% |         500,000 |           454,546 |
| Draw    |  30.000% |         300,000 |           272,727 |
| Away    |  30.000% |         300,000 |           272,727 |

The reported sum is 1,100,000, so `residualOverroundMicros = 100,000`. This calculation is a
rounding/compatibility guard; it does not claim that LagShield can reverse StablePrice's
private upstream consensus process.

## Market identity

`marketId` hashes this canonical identity:

```text
fixtureId, SuperOddsType, MarketPeriod, MarketParameters,
InRunning, sorted returned outcome names
```

Outcome order does not change identity, while a different period, line parameter, live state,
or outcome set does. Empty suspended vectors are retained as distinct diagnostic markets.
Unknown `SuperOddsType` values remain unchanged and are never silently classified.

## Robust multi-source consensus

At an explicitly supplied logical timestamp:

1. Select the latest quote per `BookmakerId`, breaking timestamp ties by `eventId`.
2. Mark quotes older than `staleAfterMs` as stale and reject future-dated quotes.
3. Validate and normalize only complete probability vectors.
4. Select the outcome-set signature with the most fresh valid books; break count ties by its
   lexical signature and surface other sets as mismatches.
5. Take the component-wise median probability across books, then normalize that median vector
   to exactly one million using the same largest-remainder rule.

The component median has a 50% breakdown point and prevents one extreme book from dragging a
three-or-more-book consensus. If TxLINE returns only its normal StablePrice source, this layer
acts as deterministic feature extraction rather than pretending to add unavailable
bookmaker diversity.

Reported features and units:

| Feature                     | Formula / unit                                                       |
| --------------------------- | -------------------------------------------------------------------- |
| Quote age                   | `logicalTimestampMs - sourceTimestampMs`, milliseconds               |
| Stale-book fraction         | stale latest books / all latest books, integer parts per million     |
| Dispersion                  | median absolute deviation per outcome, probability millionths        |
| Probability delta           | current minus prior consensus, probability millionths                |
| Consensus velocity          | `deltaMicros * 1000 / elapsedMs`, millionths per second, toward zero |
| Per-book reaction latency   | first post-event vector crossing configured max-outcome delta, ms    |
| Residual reported overround | reported vector sum minus 1,000,000, probability millionths          |

All time is passed as logical input. No consensus calculation reads the wall clock.

## Dynamic core-market selection

Market selection considers only ready, sufficiently covered, at-least-two-outcome candidates.
The configuration may list exact, empirically verified preferred `SuperOddsType` values. A
preferred full-time result market wins only if it was actually returned and met coverage;
otherwise the best covered unknown market remains eligible and visible. Ties use valid-book
coverage, stale fraction, and then `marketId`.

Do not add a guessed alias to the preferred list. Capture a real TxLINE World Cup payload,
record the returned type/period/parameters, and version the audited configuration first.
