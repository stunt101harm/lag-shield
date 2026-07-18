import { describe, expect, it } from 'vitest';

import { createNormalizedEvent, type NormalizedDomainEvent } from './events.js';
import { canonicalJson, toJsonValue } from './json.js';
import { createStrategyDecision, marketControlStates } from './models.js';
import {
  DeterministicRiskEngine,
  classifySoccerScoreEvent,
  defaultRiskPolicyConfiguration,
  marketRiskFeaturesFromConsensus,
  marketRiskStateFromDecision,
  type MarketRiskFeatures,
  type RiskEvaluationInput,
} from './risk-engine.js';

const healthyFeatures: MarketRiskFeatures = {
  consensusStatus: 'ready',
  freshBookmakerCount: 3,
  maxAbsVelocityMicrosPerSecond: 4_000,
  maxDispersionMadMicros: 5_000,
  maxReactionLatencyMs: 500,
  oldestFreshQuoteAgeMs: 500,
  staleBookmakerFractionPpm: 0,
  unreactedBookmakerCount: 0,
};

function scoreEvent(
  input: Readonly<{
    action: string;
    confirmed?: boolean | null;
    outcome?: string | null;
    possible?: Partial<{
      goal: boolean | null;
      penalty: boolean | null;
      redCard: boolean | null;
      review: boolean | null;
    }>;
    reliable?: boolean | null;
    reviewType?: string | null;
    sequence?: number;
    sourceId?: string;
    statusId?: number | null;
    timestampMs?: number;
  }>,
): Extract<NormalizedDomainEvent, { kind: 'score.observed' }> {
  const timestampMs = input.timestampMs ?? 1_000;
  const sourceId = input.sourceId ?? `score-${input.action}-${timestampMs}`;
  const event = createNormalizedEvent({
    fixtureId: 'fixture-1',
    kind: 'score.observed',
    payload: {
      action: input.action,
      actionId: `action-${sourceId}`,
      awayScore: 0,
      confirmed: input.confirmed ?? null,
      details: {
        amendedAction: null,
        outcome: input.outcome ?? null,
        possible: {
          goal: input.possible?.goal ?? null,
          penalty: input.possible?.penalty ?? null,
          redCard: input.possible?.redCard ?? null,
          review: input.possible?.review ?? null,
        },
        referencedActionId: null,
        reliable: input.reliable ?? null,
        reviewType: input.reviewType ?? null,
      },
      fixtureId: 'fixture-1',
      homeScore: 1,
      period: 1,
      stats: [
        { key: 1, period: 0, value: 1 },
        { key: 2, period: 0, value: 0 },
      ],
      statusId: input.statusId ?? 2,
    },
    payloadVersion: 2,
    receivedAtMs: timestampMs,
    sequence: input.sequence ?? 1,
    source: 'simulation',
    sourceId,
    sourceTimestampMs: timestampMs,
  });
  if (event.kind !== 'score.observed') throw new Error('Expected score event.');
  return event;
}

function evaluation(
  input: Partial<RiskEvaluationInput> &
    Pick<RiskEvaluationInput, 'logicalTimestampMs' | 'triggerEventId'>,
): RiskEvaluationInput {
  return {
    features: healthyFeatures,
    fixtureId: 'fixture-1',
    marketId: 'market-1',
    proofStatus: 'verified',
    ...input,
  };
}

describe('TxLINE soccer event classification', () => {
  it.each([
    [
      scoreEvent({ action: 'possible', possible: { goal: true } }),
      ['possible_goal', 'EVENT_POSSIBLE_GOAL', 'pause', 'unconfirmed'],
    ],
    [
      scoreEvent({ action: 'goal', confirmed: false }),
      ['goal', 'EVENT_GOAL_UNCONFIRMED', 'pause', 'unconfirmed'],
    ],
    [
      scoreEvent({ action: 'penalty', confirmed: true }),
      ['penalty', 'EVENT_PENALTY', 'pause', 'confirmed'],
    ],
    [
      scoreEvent({ action: 'penalty_outcome', outcome: 'Scored' }),
      ['penalty_scored', 'EVENT_PENALTY_SCORED', 'pause', 'unknown'],
    ],
    [
      scoreEvent({ action: 'red_card', confirmed: false }),
      ['red_card', 'EVENT_RED_CARD_UNCONFIRMED', 'pause', 'unconfirmed'],
    ],
    [
      scoreEvent({ action: 'var', reviewType: 'SecondYellowCard' }),
      ['var_started', 'EVENT_VAR_SECOND_YELLOW_CARD', 'pause', 'unknown'],
    ],
    [
      scoreEvent({ action: 'var_end', outcome: 'Overturned' }),
      ['var_overturned', 'EVENT_VAR_OVERTURNED', 'pause', 'reversal'],
    ],
    [
      scoreEvent({ action: 'action_discarded' }),
      ['action_discarded', 'EVENT_ACTION_DISCARDED', 'pause', 'reversal'],
    ],
    [
      scoreEvent({ action: 'action_amend' }),
      ['action_amended', 'EVENT_ACTION_AMENDED', 'pause', 'amendment'],
    ],
    [
      scoreEvent({ action: 'suspend', reliable: false }),
      ['coverage_unreliable', 'FEED_UNRELIABLE', 'pause', 'confirmed'],
    ],
    [
      scoreEvent({ action: 'suspend', reliable: true }),
      ['coverage_recovered', 'FEED_RELIABILITY_RESTORED', 'none', 'confirmed'],
    ],
    [
      scoreEvent({ action: 'status', statusId: 18 }),
      ['phase_unsafe', 'MATCH_PHASE_UNSAFE', 'pause', 'unknown'],
    ],
  ])('classifies %s from the documented score taxonomy', (event, expected) => {
    const actual = classifySoccerScoreEvent(event);
    expect([
      actual.kind,
      actual.reasonCode,
      actual.protectiveAction,
      actual.confirmation,
    ]).toEqual(expected);
  });
});

describe('deterministic market risk state machine', () => {
  it('accepts every documented transition and rejects every other state/action pair', () => {
    const actions = ['none', 'widen', 'pause', 'begin_recovery', 'reopen'] as const;
    const allowed = new Set([
      'none:OPEN->OPEN',
      'none:WIDENED->WIDENED',
      'none:PAUSED->PAUSED',
      'none:RECOVERY->RECOVERY',
      'widen:OPEN->WIDENED',
      'pause:OPEN->PAUSED',
      'pause:WIDENED->PAUSED',
      'pause:RECOVERY->PAUSED',
      'begin_recovery:PAUSED->RECOVERY',
      'begin_recovery:WIDENED->RECOVERY',
      'reopen:RECOVERY->OPEN',
    ]);

    for (const action of actions) {
      for (const previousState of marketControlStates) {
        for (const nextState of marketControlStates) {
          const key = `${action}:${previousState}->${nextState}`;
          const create = () =>
            createStrategyDecision({
              action,
              expectedStateVersion: 0,
              fixtureId: 'fixture-1',
              logicalTimestampMs: 1,
              marketId: 'market-1',
              metrics: {},
              nextState,
              payloadVersion: 1,
              policyVersion: 'transition-test',
              previousState,
              reasonCodes: ['TRANSITION_TEST'],
              triggerEventId: `trigger-${action}-${previousState}-${nextState}`,
            });
          if (allowed.has(key)) expect(create).not.toThrow();
          else expect(create).toThrow(/cannot perform transition/);
        }
      }
    }
  });

  it('adapts consensus outcomes and reaction measurements into bounded risk inputs', () => {
    const features = marketRiskFeaturesFromConsensus(
      {
        consensusId: 'consensus-1',
        diagnostics: [],
        formulaVersion: 'reported-pct-proportional-median-v1',
        freshBookmakerCount: 2,
        freshestQuoteAgeMs: 100,
        logicalTimestampMs: 10_000,
        marketId: 'market-1',
        oldestFreshQuoteAgeMs: 400,
        outcomes: [
          {
            deltaMicros: 10_000,
            dispersionMadMicros: 4_000,
            name: 'Home',
            outcomeId: 'home',
            probabilityMicros: 600_000,
            velocityMicrosPerSecond: -12_000,
          },
          {
            deltaMicros: -10_000,
            dispersionMadMicros: 6_000,
            name: 'Away',
            outcomeId: 'away',
            probabilityMicros: 400_000,
            velocityMicrosPerSecond: 10_000,
          },
        ],
        staleBookmakerCount: 1,
        staleBookmakerFractionPpm: 333_333,
        status: 'ready',
        totalBookmakerCount: 3,
        validBookmakerCount: 2,
      },
      [
        { bookmakerId: 'a', firstReactionEventId: 'evt-a', latencyMs: 1_200 },
        { bookmakerId: 'b', firstReactionEventId: null, latencyMs: null },
      ],
    );

    expect(features).toEqual({
      consensusStatus: 'ready',
      freshBookmakerCount: 2,
      maxAbsVelocityMicrosPerSecond: 12_000,
      maxDispersionMadMicros: 6_000,
      maxReactionLatencyMs: 1_200,
      oldestFreshQuoteAgeMs: 400,
      staleBookmakerFractionPpm: 333_333,
      unreactedBookmakerCount: 1,
    });
  });

  it('pauses immediately for an unconfirmed critical event without waiting for proof', () => {
    const engine = new DeterministicRiskEngine();
    const goal = scoreEvent({ action: 'goal', confirmed: false, timestampMs: 10_000 });
    const result = engine.evaluate(
      evaluation({
        logicalTimestampMs: 10_000,
        proofStatus: 'unavailable',
        scoreEvent: goal,
        triggerEventId: goal.eventId,
      }),
    );

    expect(result.status).toBe('applied');
    expect(result.decision).toMatchObject({
      action: 'pause',
      nextState: 'PAUSED',
      payloadVersion: 2,
      previousState: 'OPEN',
    });
    expect(result.decision?.reasonCodes).toEqual(
      expect.arrayContaining([
        'EVENT_GOAL_UNCONFIRMED',
        'EVENT_SHOCK_HOLD',
        'PROOF_NOT_READY_NON_BLOCKING',
      ]),
    );
  });

  it('fails safe when consensus is absent or fresh-book quorum is lost', () => {
    const engine = new DeterministicRiskEngine();
    const result = engine.evaluate(
      evaluation({
        features: {
          ...healthyFeatures,
          consensusStatus: 'insufficient',
          freshBookmakerCount: 0,
          oldestFreshQuoteAgeMs: null,
        },
        logicalTimestampMs: 10_000,
        triggerEventId: 'odds-outage',
      }),
    );

    expect(result.decision).toMatchObject({ action: 'pause', nextState: 'PAUSED' });
    expect(result.decision?.reasonCodes).toContain('MARKET_DATA_UNAVAILABLE');
  });

  it('uses WIDENED then RECOVERY and never reopens directly', () => {
    const engine = new DeterministicRiskEngine();
    const widened = engine.evaluate(
      evaluation({
        features: { ...healthyFeatures, oldestFreshQuoteAgeMs: 2_500 },
        logicalTimestampMs: 10_000,
        triggerEventId: 'odds-warning',
      }),
    );
    const held = engine.evaluate(
      evaluation({ logicalTimestampMs: 11_000, triggerEventId: 'odds-healthy-1' }),
    );
    const recovery = engine.evaluate(
      evaluation({ logicalTimestampMs: 12_000, triggerEventId: 'odds-healthy-2' }),
    );
    const converging = engine.evaluate(
      evaluation({ logicalTimestampMs: 13_000, triggerEventId: 'odds-healthy-3' }),
    );
    const reopened = engine.evaluate(
      evaluation({ logicalTimestampMs: 15_000, triggerEventId: 'odds-healthy-4' }),
    );

    expect(widened.decision).toMatchObject({
      action: 'widen',
      nextState: 'WIDENED',
      previousState: 'OPEN',
    });
    expect(held.decision).toMatchObject({
      action: 'none',
      nextState: 'WIDENED',
    });
    expect(recovery.decision).toMatchObject({
      action: 'begin_recovery',
      nextState: 'RECOVERY',
      previousState: 'WIDENED',
    });
    expect(converging.decision).toMatchObject({
      action: 'none',
      nextState: 'RECOVERY',
    });
    expect(reopened.decision).toMatchObject({
      action: 'reopen',
      nextState: 'OPEN',
      previousState: 'RECOVERY',
    });
  });

  it('holds a critical pause, then requires recovery quorum and cooldown', () => {
    const engine = new DeterministicRiskEngine();
    const goal = scoreEvent({ action: 'goal', confirmed: false, timestampMs: 10_000 });
    const paused = engine.evaluate(
      evaluation({
        logicalTimestampMs: 10_000,
        scoreEvent: goal,
        triggerEventId: goal.eventId,
      }),
    );
    const stillPaused = engine.evaluate(
      evaluation({ logicalTimestampMs: 17_999, triggerEventId: 'odds-before-hold' }),
    );
    const recovery = engine.evaluate(
      evaluation({ logicalTimestampMs: 18_000, triggerEventId: 'odds-converged-1' }),
    );
    const stableTwo = engine.evaluate(
      evaluation({ logicalTimestampMs: 19_000, triggerEventId: 'odds-converged-2' }),
    );
    const reopened = engine.evaluate(
      evaluation({ logicalTimestampMs: 21_000, triggerEventId: 'odds-converged-3' }),
    );

    expect(paused.state.state).toBe('PAUSED');
    expect(stillPaused.decision).toMatchObject({ action: 'none', nextState: 'PAUSED' });
    expect(recovery.decision).toMatchObject({
      action: 'begin_recovery',
      nextState: 'RECOVERY',
    });
    expect(stableTwo.decision).toMatchObject({ action: 'none', nextState: 'RECOVERY' });
    expect(reopened.decision).toMatchObject({ action: 'reopen', nextState: 'OPEN' });
  });

  it('uses an overturned VAR to shorten the unresolved shock hold before recovery', () => {
    const engine = new DeterministicRiskEngine();
    const goal = scoreEvent({ action: 'goal', timestampMs: 10_000 });
    engine.evaluate(
      evaluation({
        logicalTimestampMs: 10_000,
        scoreEvent: goal,
        triggerEventId: goal.eventId,
      }),
    );
    const overturned = scoreEvent({
      action: 'var_end',
      outcome: 'Overturned',
      sourceId: 'var-overturned',
      timestampMs: 12_000,
    });
    const reversal = engine.evaluate(
      evaluation({
        logicalTimestampMs: 12_000,
        scoreEvent: overturned,
        triggerEventId: overturned.eventId,
      }),
    );
    const recovery = engine.evaluate(
      evaluation({ logicalTimestampMs: 14_000, triggerEventId: 'post-reversal-quote' }),
    );

    expect(reversal.signal.confirmation).toBe('reversal');
    expect(reversal.state.shockUntilMs).toBe(14_000);
    expect(recovery.decision).toMatchObject({
      action: 'begin_recovery',
      nextState: 'RECOVERY',
    });
  });

  it('resets recovery and returns to PAUSED when risk reappears', () => {
    const engine = new DeterministicRiskEngine();
    const goal = scoreEvent({ action: 'goal', timestampMs: 10_000 });
    engine.evaluate(
      evaluation({
        logicalTimestampMs: 10_000,
        scoreEvent: goal,
        triggerEventId: goal.eventId,
      }),
    );
    engine.evaluate(
      evaluation({ logicalTimestampMs: 18_000, triggerEventId: 'recovery-start' }),
    );
    const relapse = engine.evaluate(
      evaluation({
        features: {
          ...healthyFeatures,
          oldestFreshQuoteAgeMs: defaultRiskPolicyConfiguration.pauseQuoteAgeMs,
        },
        logicalTimestampMs: 19_000,
        triggerEventId: 'recovery-relapse',
      }),
    );

    expect(relapse.decision).toMatchObject({
      action: 'pause',
      nextState: 'PAUSED',
      previousState: 'RECOVERY',
    });
    expect(relapse.state.recoveryStableUpdates).toBe(0);
  });

  it('does not flap when quote age oscillates around the widening boundary', () => {
    const engine = new DeterministicRiskEngine();
    const warning = { ...healthyFeatures, oldestFreshQuoteAgeMs: 2_100 };
    const results = [
      engine.evaluate(
        evaluation({
          features: warning,
          logicalTimestampMs: 10_000,
          triggerEventId: 'oscillate-1',
        }),
      ),
      engine.evaluate(
        evaluation({ logicalTimestampMs: 10_500, triggerEventId: 'oscillate-2' }),
      ),
      engine.evaluate(
        evaluation({
          features: warning,
          logicalTimestampMs: 11_000,
          triggerEventId: 'oscillate-3',
        }),
      ),
      engine.evaluate(
        evaluation({ logicalTimestampMs: 12_000, triggerEventId: 'oscillate-4' }),
      ),
      engine.evaluate(
        evaluation({
          features: warning,
          logicalTimestampMs: 12_500,
          triggerEventId: 'oscillate-5',
        }),
      ),
      engine.evaluate(
        evaluation({ logicalTimestampMs: 13_000, triggerEventId: 'oscillate-6' }),
      ),
      engine.evaluate(
        evaluation({ logicalTimestampMs: 14_000, triggerEventId: 'oscillate-7' }),
      ),
      engine.evaluate(
        evaluation({ logicalTimestampMs: 15_000, triggerEventId: 'oscillate-8' }),
      ),
    ];

    expect(results.map(({ state }) => state.state)).toEqual([
      'WIDENED',
      'WIDENED',
      'WIDENED',
      'RECOVERY',
      'RECOVERY',
      'RECOVERY',
      'RECOVERY',
      'OPEN',
    ]);
    expect(results.at(-1)?.decision).toMatchObject({ action: 'reopen' });
  });

  it('returns a byte-stable cached decision for duplicate triggers', () => {
    const engine = new DeterministicRiskEngine();
    const input = evaluation({ logicalTimestampMs: 10_000, triggerEventId: 'duplicate' });
    const first = engine.evaluate(input);
    const second = engine.evaluate(input);

    expect(second.status).toBe('duplicate');
    expect(canonicalJson(toJsonValue(second.decision))).toBe(
      canonicalJson(toJsonValue(first.decision)),
    );
    expect(second.state).toEqual(first.state);
  });

  it('restores all cooldown and convergence memory from a persisted v2 decision', () => {
    const engine = new DeterministicRiskEngine();
    const result = engine.evaluate(
      evaluation({ logicalTimestampMs: 10_000, triggerEventId: 'restartable' }),
    );
    if (!result.decision) return;

    const restored = marketRiskStateFromDecision(result.decision);
    expect(restored).toEqual(result.state);
    const resumed = new DeterministicRiskEngine(undefined, [restored]);
    expect(resumed.snapshot('market-1')).toEqual(result.state);
  });

  it('uses the policy configuration hash in v2 decision idempotency', () => {
    const input = evaluation({
      logicalTimestampMs: 10_000,
      triggerEventId: 'config-key',
    });
    const baseline = new DeterministicRiskEngine().evaluate(input);
    const changed = new DeterministicRiskEngine({
      ...defaultRiskPolicyConfiguration,
      widenQuoteAgeMs: 2_100,
    }).evaluate(input);
    if (
      !baseline.decision ||
      baseline.decision.payloadVersion !== 2 ||
      !changed.decision ||
      changed.decision.payloadVersion !== 2
    )
      return;

    expect(changed.decision.policyConfigurationHash).not.toBe(
      baseline.decision.policyConfigurationHash,
    );
    expect(changed.decision.decisionId).not.toBe(baseline.decision.decisionId);
    expect(changed.decision.idempotencyKey).not.toBe(baseline.decision.idempotencyKey);
  });

  it('ignores a late input without mutating state or emitting a transition', () => {
    const engine = new DeterministicRiskEngine();
    const current = engine.evaluate(
      evaluation({ logicalTimestampMs: 10_000, triggerEventId: 'current' }),
    );
    const late = engine.evaluate(
      evaluation({ logicalTimestampMs: 9_999, triggerEventId: 'late' }),
    );

    expect(late).toMatchObject({ decision: null, status: 'late' });
    expect(late.state).toEqual(current.state);
    expect(engine.snapshot('market-1')).toEqual(current.state);
  });

  it('emits a stable golden decision with configuration and input hashes', () => {
    const engine = new DeterministicRiskEngine();
    const goal = scoreEvent({
      action: 'possible',
      possible: { goal: true },
      sourceId: 'golden-possible-goal',
      timestampMs: 25_000,
    });
    const result = engine.evaluate(
      evaluation({
        evidenceEventIds: ['evidence-quote-2', 'evidence-quote-1'],
        logicalTimestampMs: 25_000,
        proofStatus: 'pending',
        scoreEvent: goal,
        triggerEventId: goal.eventId,
      }),
    );

    expect(result.decision).toMatchInlineSnapshot(`
      {
        "action": "pause",
        "decisionId": "dec_9d0346d782e4e13af8bda59bb987782106adcde5",
        "evidenceEventIds": [
          "evidence-quote-1",
          "evidence-quote-2",
          "evt_1fe5fdfc09842c8b434b6f86efd1e2dcf128f48b",
        ],
        "expectedStateVersion": 0,
        "fixtureId": "fixture-1",
        "idempotencyKey": "decision|44:evt_1fe5fdfc09842c8b434b6f86efd1e2dcf128f48b|8:market-1|25:lag-shield-soccer-risk-v1|64:f807f4f5396190944732aa7f944c0223368546e6f35c01bcf2dceb5f189d441b",
        "inputFeatureHash": "4e01d32bd7555567d217df5ff47077680b2bdf34563e9aeccb4fc640dd32bedc",
        "logicalTimestampMs": 25000,
        "marketId": "market-1",
        "metrics": {
          "activeShockRemainingMs": 8000,
          "freshBookmakerCount": 3,
          "lastStateChangeAtMs": 25000,
          "maxAbsVelocityMicrosPerSecond": 4000,
          "maxDispersionMadMicros": 5000,
          "maxReactionLatencyMs": 500,
          "oldestFreshQuoteAgeMs": 500,
          "proofStatus": 1,
          "recoveryStableUpdates": 0,
          "scoreSeverity": 3,
          "shockUntilMs": 33000,
          "staleBookmakerFractionPpm": 0,
          "unreactedBookmakerCount": 0,
        },
        "nextState": "PAUSED",
        "payloadVersion": 2,
        "policyConfigurationHash": "f807f4f5396190944732aa7f944c0223368546e6f35c01bcf2dceb5f189d441b",
        "policyVersion": "lag-shield-soccer-risk-v1",
        "previousState": "OPEN",
        "reasonCodes": [
          "EVENT_POSSIBLE_GOAL",
          "EVENT_SHOCK_HOLD",
          "PROOF_NOT_READY_NON_BLOCKING",
        ],
        "thresholds": {
          "criticalShockHoldMs": 8000,
          "minimumFreshBookmakers": 1,
          "minimumPauseMs": 2000,
          "minimumWidenedMs": 2000,
          "pauseDispersionMicros": 50000,
          "pauseQuoteAgeMs": 5000,
          "pauseReactionLatencyMs": 4000,
          "pauseStaleBookmakerFractionPpm": 500000,
          "pauseVelocityMicrosPerSecond": 60000,
          "recoveryCooldownMs": 3000,
          "recoveryDispersionMicros": 15000,
          "recoveryQuoteAgeMs": 1500,
          "recoveryStableUpdates": 3,
          "recoveryStaleBookmakerFractionPpm": 0,
          "recoveryVelocityMicrosPerSecond": 10000,
          "reversalShockHoldMs": 2000,
          "widenDispersionMicros": 20000,
          "widenQuoteAgeMs": 2000,
          "widenReactionLatencyMs": 1500,
          "widenStaleBookmakerFractionPpm": 250000,
          "widenVelocityMicrosPerSecond": 20000,
        },
        "triggerEventId": "evt_1fe5fdfc09842c8b434b6f86efd1e2dcf128f48b",
      }
    `);
  });
});
