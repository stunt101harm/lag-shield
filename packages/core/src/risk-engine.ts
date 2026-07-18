import type { NormalizedDomainEvent } from './events.js';
import { stableHash, toJsonValue } from './json.js';
import type { BookmakerReactionLatency, ConsensusSnapshot } from './market-consensus.js';
import {
  createStrategyDecision,
  type MarketControlState,
  type StrategyDecision,
} from './models.js';

export const riskPolicyVersion = 'lag-shield-soccer-risk-v1';

export type RiskPolicyConfiguration = Readonly<{
  criticalShockHoldMs: number;
  minimumFreshBookmakers: number;
  minimumPauseMs: number;
  minimumWidenedMs: number;
  pauseDispersionMicros: number;
  pauseQuoteAgeMs: number;
  pauseReactionLatencyMs: number;
  pauseStaleBookmakerFractionPpm: number;
  pauseVelocityMicrosPerSecond: number;
  recoveryCooldownMs: number;
  recoveryDispersionMicros: number;
  recoveryQuoteAgeMs: number;
  recoveryStableUpdates: number;
  recoveryStaleBookmakerFractionPpm: number;
  recoveryVelocityMicrosPerSecond: number;
  reversalShockHoldMs: number;
  widenDispersionMicros: number;
  widenQuoteAgeMs: number;
  widenReactionLatencyMs: number;
  widenStaleBookmakerFractionPpm: number;
  widenVelocityMicrosPerSecond: number;
}>;

export const defaultRiskPolicyConfiguration: RiskPolicyConfiguration = Object.freeze({
  criticalShockHoldMs: 8_000,
  minimumFreshBookmakers: 1,
  minimumPauseMs: 2_000,
  minimumWidenedMs: 2_000,
  pauseDispersionMicros: 50_000,
  pauseQuoteAgeMs: 5_000,
  pauseReactionLatencyMs: 4_000,
  pauseStaleBookmakerFractionPpm: 500_000,
  pauseVelocityMicrosPerSecond: 60_000,
  recoveryCooldownMs: 3_000,
  recoveryDispersionMicros: 15_000,
  recoveryQuoteAgeMs: 1_500,
  recoveryStableUpdates: 3,
  recoveryStaleBookmakerFractionPpm: 0,
  recoveryVelocityMicrosPerSecond: 10_000,
  reversalShockHoldMs: 2_000,
  widenDispersionMicros: 20_000,
  widenQuoteAgeMs: 2_000,
  widenReactionLatencyMs: 1_500,
  widenStaleBookmakerFractionPpm: 250_000,
  widenVelocityMicrosPerSecond: 20_000,
});

export type SoccerSignalConfirmation =
  'amendment' | 'confirmed' | 'not_applicable' | 'reversal' | 'unconfirmed' | 'unknown';

export type SoccerSignalKind =
  | 'action_amended'
  | 'action_discarded'
  | 'coverage_recovered'
  | 'coverage_unreliable'
  | 'goal'
  | 'match_finalised'
  | 'normal'
  | 'penalty'
  | 'penalty_missed'
  | 'penalty_scored'
  | 'phase_change'
  | 'phase_unsafe'
  | 'possible_goal'
  | 'possible_penalty'
  | 'possible_red_card'
  | 'possible_var'
  | 'red_card'
  | 'score_adjusted'
  | 'var_overturned'
  | 'var_started'
  | 'var_stands';

export type SoccerRiskSignal = Readonly<{
  confirmation: SoccerSignalConfirmation;
  kind: SoccerSignalKind;
  protectiveAction: 'none' | 'pause' | 'widen';
  reasonCode: string;
  severity: 'critical' | 'high' | 'low' | 'none';
}>;

const normalSignal: SoccerRiskSignal = Object.freeze({
  confirmation: 'not_applicable',
  kind: 'normal',
  protectiveAction: 'none',
  reasonCode: 'SCORE_EVENT_NORMAL',
  severity: 'none',
});

function canonicalAction(action: string): string {
  return action
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

const varReviewReasonCodes: Readonly<Record<string, string>> = Object.freeze({
  cornerkick: 'EVENT_VAR_CORNER_KICK',
  goal: 'EVENT_VAR_GOAL',
  mistakenidentity: 'EVENT_VAR_MISTAKEN_IDENTITY',
  other: 'EVENT_VAR_OTHER',
  penalty: 'EVENT_VAR_PENALTY',
  redcard: 'EVENT_VAR_RED_CARD',
  secondyellowcard: 'EVENT_VAR_SECOND_YELLOW_CARD',
});

function eventConfirmation(
  event: Extract<NormalizedDomainEvent, { kind: 'score.observed' }>,
): SoccerSignalConfirmation {
  if (event.payloadVersion !== 2 || event.payload.confirmed === null) return 'unknown';
  return event.payload.confirmed ? 'confirmed' : 'unconfirmed';
}

function signal(
  input: Omit<SoccerRiskSignal, 'confirmation'> &
    Readonly<{ confirmation?: SoccerSignalConfirmation }>,
  fallbackConfirmation: SoccerSignalConfirmation,
): SoccerRiskSignal {
  return { ...input, confirmation: input.confirmation ?? fallbackConfirmation };
}

export function classifySoccerScoreEvent(
  event: Extract<NormalizedDomainEvent, { kind: 'score.observed' }>,
): SoccerRiskSignal {
  const confirmation = eventConfirmation(event);
  const action = canonicalAction(event.payload.action);
  const details = event.payloadVersion === 2 ? event.payload.details : null;

  if (action === 'possible') {
    if (details?.possible.goal === true) {
      return signal(
        {
          kind: 'possible_goal',
          protectiveAction: 'pause',
          reasonCode: 'EVENT_POSSIBLE_GOAL',
          severity: 'critical',
        },
        'unconfirmed',
      );
    }
    if (details?.possible.penalty === true) {
      return signal(
        {
          kind: 'possible_penalty',
          protectiveAction: 'pause',
          reasonCode: 'EVENT_POSSIBLE_PENALTY',
          severity: 'critical',
        },
        'unconfirmed',
      );
    }
    if (details?.possible.redCard === true) {
      return signal(
        {
          kind: 'possible_red_card',
          protectiveAction: 'pause',
          reasonCode: 'EVENT_POSSIBLE_RED_CARD',
          severity: 'critical',
        },
        'unconfirmed',
      );
    }
    if (details?.possible.review === true) {
      return signal(
        {
          kind: 'possible_var',
          protectiveAction: 'pause',
          reasonCode: 'EVENT_POSSIBLE_VAR',
          severity: 'critical',
        },
        'unconfirmed',
      );
    }
  }

  if (action === 'goal') {
    return signal(
      {
        kind: 'goal',
        protectiveAction: 'pause',
        reasonCode:
          confirmation === 'unconfirmed' ? 'EVENT_GOAL_UNCONFIRMED' : 'EVENT_GOAL',
        severity: 'critical',
      },
      confirmation,
    );
  }
  if (action === 'penalty') {
    return signal(
      {
        kind: 'penalty',
        protectiveAction: 'pause',
        reasonCode:
          confirmation === 'unconfirmed' ? 'EVENT_PENALTY_UNCONFIRMED' : 'EVENT_PENALTY',
        severity: 'critical',
      },
      confirmation,
    );
  }
  if (action === 'penalty_outcome') {
    const outcome = details?.outcome?.toLowerCase();
    if (outcome === 'scored') {
      return signal(
        {
          kind: 'penalty_scored',
          protectiveAction: 'pause',
          reasonCode: 'EVENT_PENALTY_SCORED',
          severity: 'critical',
        },
        confirmation,
      );
    }
    if (outcome === 'missed') {
      return signal(
        {
          kind: 'penalty_missed',
          protectiveAction: 'pause',
          reasonCode: 'EVENT_PENALTY_MISSED',
          severity: 'high',
        },
        confirmation,
      );
    }
    return signal(
      {
        kind: 'penalty',
        protectiveAction: 'pause',
        reasonCode:
          outcome === 'retake' ? 'EVENT_PENALTY_RETAKE' : 'EVENT_PENALTY_OUTCOME',
        severity: 'critical',
      },
      confirmation,
    );
  }
  if (action === 'red_card') {
    return signal(
      {
        kind: 'red_card',
        protectiveAction: 'pause',
        reasonCode:
          confirmation === 'unconfirmed'
            ? 'EVENT_RED_CARD_UNCONFIRMED'
            : 'EVENT_RED_CARD',
        severity: 'critical',
      },
      confirmation,
    );
  }
  if (action === 'var') {
    const reviewType = details?.reviewType ? canonicalAction(details.reviewType) : null;
    return signal(
      {
        kind: 'var_started',
        protectiveAction: 'pause',
        reasonCode:
          (reviewType ? varReviewReasonCodes[reviewType] : null) ?? 'EVENT_VAR_REVIEW',
        severity: 'critical',
      },
      confirmation,
    );
  }
  if (action === 'var_end') {
    const outcome = details?.outcome?.toLowerCase();
    if (outcome === 'overturned') {
      return signal(
        {
          confirmation: 'reversal',
          kind: 'var_overturned',
          protectiveAction: 'pause',
          reasonCode: 'EVENT_VAR_OVERTURNED',
          severity: 'high',
        },
        confirmation,
      );
    }
    return signal(
      {
        kind: 'var_stands',
        protectiveAction: 'pause',
        reasonCode: outcome === 'stands' ? 'EVENT_VAR_STANDS' : 'EVENT_VAR_ENDED',
        severity: 'high',
      },
      confirmation,
    );
  }
  if (action === 'action_discarded') {
    return signal(
      {
        confirmation: 'reversal',
        kind: 'action_discarded',
        protectiveAction: 'pause',
        reasonCode: 'EVENT_ACTION_DISCARDED',
        severity: 'high',
      },
      confirmation,
    );
  }
  if (action === 'action_amend') {
    return signal(
      {
        confirmation: 'amendment',
        kind: 'action_amended',
        protectiveAction: 'pause',
        reasonCode: 'EVENT_ACTION_AMENDED',
        severity: 'high',
      },
      confirmation,
    );
  }
  if (action === 'score_adjustment') {
    return signal(
      {
        kind: 'score_adjusted',
        protectiveAction: 'pause',
        reasonCode: 'EVENT_SCORE_ADJUSTMENT',
        severity: 'critical',
      },
      'confirmed',
    );
  }
  if (action === 'suspend') {
    if (details?.reliable === true) {
      return signal(
        {
          kind: 'coverage_recovered',
          protectiveAction: 'none',
          reasonCode: 'FEED_RELIABILITY_RESTORED',
          severity: 'low',
        },
        'confirmed',
      );
    }
    return signal(
      {
        kind: 'coverage_unreliable',
        protectiveAction: 'pause',
        reasonCode: 'FEED_UNRELIABLE',
        severity: 'critical',
      },
      'confirmed',
    );
  }
  if (action === 'disconnected') {
    return signal(
      {
        kind: 'coverage_unreliable',
        protectiveAction: 'pause',
        reasonCode: 'SCOUT_DISCONNECTED',
        severity: 'critical',
      },
      confirmation,
    );
  }
  if (action === 'game_finalised') {
    return signal(
      {
        kind: 'match_finalised',
        protectiveAction: 'pause',
        reasonCode: 'MATCH_FINALISED',
        severity: 'critical',
      },
      'confirmed',
    );
  }
  if (action === 'status') {
    if (
      event.payload.statusId !== null &&
      [14, 15, 16, 17, 18, 19].includes(event.payload.statusId)
    ) {
      return signal(
        {
          kind: 'phase_unsafe',
          protectiveAction: 'pause',
          reasonCode: 'MATCH_PHASE_UNSAFE',
          severity: 'critical',
        },
        confirmation,
      );
    }
    return signal(
      {
        kind: 'phase_change',
        protectiveAction: 'widen',
        reasonCode: 'MATCH_PHASE_CHANGED',
        severity: 'low',
      },
      confirmation,
    );
  }
  return normalSignal;
}

export type MarketRiskFeatures = Readonly<{
  consensusStatus: 'insufficient' | 'ready';
  freshBookmakerCount: number;
  maxAbsVelocityMicrosPerSecond: number | null;
  maxDispersionMadMicros: number | null;
  maxReactionLatencyMs: number | null;
  oldestFreshQuoteAgeMs: number | null;
  staleBookmakerFractionPpm: number;
  unreactedBookmakerCount: number;
}>;

function maximumOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

export function marketRiskFeaturesFromConsensus(
  consensus: ConsensusSnapshot,
  reactionLatencies: readonly BookmakerReactionLatency[] = [],
): MarketRiskFeatures {
  return {
    consensusStatus: consensus.status,
    freshBookmakerCount: consensus.freshBookmakerCount,
    maxAbsVelocityMicrosPerSecond: maximumOrNull(
      consensus.outcomes.flatMap(({ velocityMicrosPerSecond }) =>
        velocityMicrosPerSecond === null ? [] : [Math.abs(velocityMicrosPerSecond)],
      ),
    ),
    maxDispersionMadMicros: maximumOrNull(
      consensus.outcomes.map(({ dispersionMadMicros }) => dispersionMadMicros),
    ),
    maxReactionLatencyMs: maximumOrNull(
      reactionLatencies.flatMap(({ latencyMs }) =>
        latencyMs === null ? [] : [latencyMs],
      ),
    ),
    oldestFreshQuoteAgeMs: consensus.oldestFreshQuoteAgeMs,
    staleBookmakerFractionPpm: consensus.staleBookmakerFractionPpm,
    unreactedBookmakerCount: reactionLatencies.filter(
      ({ latencyMs }) => latencyMs === null,
    ).length,
  };
}

export type ProofAvailability = 'failed' | 'pending' | 'unavailable' | 'verified';

export type RiskEvaluationInput = Readonly<{
  evidenceEventIds?: readonly string[];
  features: MarketRiskFeatures;
  fixtureId: string;
  logicalTimestampMs: number;
  marketId: string;
  proofStatus: ProofAvailability;
  scoreEvent?: Extract<NormalizedDomainEvent, { kind: 'score.observed' }> | null;
  triggerEventId: string;
}>;

export type MarketRiskState = Readonly<{
  fixtureId: string;
  lastLogicalTimestampMs: number;
  lastStateChangeAtMs: number;
  marketId: string;
  recoveryStableUpdates: number;
  shockUntilMs: number;
  state: MarketControlState;
  stateVersion: number;
}>;

type CompletedRiskEvaluationResult = Readonly<{
  decision: StrategyDecision;
  signal: SoccerRiskSignal;
  state: MarketRiskState;
  status: 'applied' | 'duplicate';
}>;

export type RiskEvaluationResult =
  | CompletedRiskEvaluationResult
  | Readonly<{
      decision: null;
      signal: SoccerRiskSignal;
      state: MarketRiskState;
      status: 'late';
    }>;

function assertNonNegativeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

export function marketRiskStateFromDecision(decision: StrategyDecision): MarketRiskState {
  if (decision.payloadVersion !== 2) {
    throw new Error('Risk state restoration requires a v2 strategy decision.');
  }
  const lastStateChangeAtMs = decision.metrics.lastStateChangeAtMs;
  const recoveryStableUpdates = decision.metrics.recoveryStableUpdates;
  const shockUntilMs = decision.metrics.shockUntilMs;
  for (const [key, value] of [
    ['lastStateChangeAtMs', lastStateChangeAtMs],
    ['recoveryStableUpdates', recoveryStableUpdates],
    ['shockUntilMs', shockUntilMs],
  ] as const) {
    if (value === undefined) {
      throw new Error(`Decision is missing restart metric ${key}.`);
    }
    assertNonNegativeInteger(key, value);
  }
  return {
    fixtureId: decision.fixtureId,
    lastLogicalTimestampMs: decision.logicalTimestampMs,
    lastStateChangeAtMs: lastStateChangeAtMs!,
    marketId: decision.marketId,
    recoveryStableUpdates: recoveryStableUpdates!,
    shockUntilMs: shockUntilMs!,
    state: decision.nextState,
    stateVersion: decision.expectedStateVersion + 1,
  };
}

function validatePolicy(policy: RiskPolicyConfiguration): void {
  for (const [key, value] of Object.entries(policy)) {
    assertNonNegativeInteger(key, value);
  }
  if (policy.minimumFreshBookmakers < 1 || policy.recoveryStableUpdates < 1) {
    throw new Error('Quorum and recovery update thresholds must be at least one.');
  }
  if (
    policy.widenQuoteAgeMs >= policy.pauseQuoteAgeMs ||
    policy.widenDispersionMicros >= policy.pauseDispersionMicros ||
    policy.widenReactionLatencyMs >= policy.pauseReactionLatencyMs ||
    policy.widenStaleBookmakerFractionPpm >= policy.pauseStaleBookmakerFractionPpm ||
    policy.widenVelocityMicrosPerSecond >= policy.pauseVelocityMicrosPerSecond
  ) {
    throw new Error('Every widening threshold must be lower than its pause threshold.');
  }
  if (
    policy.recoveryQuoteAgeMs > policy.widenQuoteAgeMs ||
    policy.recoveryDispersionMicros > policy.widenDispersionMicros ||
    policy.recoveryStaleBookmakerFractionPpm > policy.widenStaleBookmakerFractionPpm ||
    policy.recoveryVelocityMicrosPerSecond > policy.widenVelocityMicrosPerSecond ||
    policy.pauseStaleBookmakerFractionPpm > 1_000_000
  ) {
    throw new Error('Recovery thresholds must be inside widening thresholds.');
  }
}

function validateFeatures(features: MarketRiskFeatures): void {
  for (const [key, value] of Object.entries(features)) {
    if (key === 'consensusStatus' || value === null) continue;
    assertNonNegativeInteger(key, value as number);
  }
  if (features.staleBookmakerFractionPpm > 1_000_000) {
    throw new Error('staleBookmakerFractionPpm cannot exceed one million.');
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function severityMetric(severity: SoccerRiskSignal['severity']): number {
  return { critical: 3, high: 2, low: 1, none: 0 }[severity];
}

function proofMetric(status: ProofAvailability): number {
  return { failed: 3, pending: 1, unavailable: 0, verified: 2 }[status];
}

function metric(value: number | null): number {
  return value ?? -1;
}

function marketReasons(
  features: MarketRiskFeatures,
  policy: RiskPolicyConfiguration,
  proofStatus: ProofAvailability,
): Readonly<{ pause: string[]; widen: string[] }> {
  const pause: string[] = [];
  const widen: string[] = [];
  if (
    features.consensusStatus !== 'ready' ||
    features.freshBookmakerCount < policy.minimumFreshBookmakers ||
    features.oldestFreshQuoteAgeMs === null
  ) {
    pause.push('MARKET_DATA_UNAVAILABLE');
  } else if (features.oldestFreshQuoteAgeMs >= policy.pauseQuoteAgeMs) {
    pause.push('QUOTE_AGE_PAUSE');
  } else if (features.oldestFreshQuoteAgeMs >= policy.widenQuoteAgeMs) {
    widen.push('QUOTE_AGE_WIDEN');
  }
  if (features.staleBookmakerFractionPpm >= policy.pauseStaleBookmakerFractionPpm) {
    pause.push('STALE_BOOKMAKER_QUORUM');
  } else if (
    features.staleBookmakerFractionPpm >= policy.widenStaleBookmakerFractionPpm
  ) {
    widen.push('STALE_BOOKMAKER_WARNING');
  }
  if (
    features.maxAbsVelocityMicrosPerSecond !== null &&
    features.maxAbsVelocityMicrosPerSecond >= policy.pauseVelocityMicrosPerSecond
  ) {
    pause.push('CONSENSUS_VELOCITY_PAUSE');
  } else if (
    features.maxAbsVelocityMicrosPerSecond !== null &&
    features.maxAbsVelocityMicrosPerSecond >= policy.widenVelocityMicrosPerSecond
  ) {
    widen.push('CONSENSUS_VELOCITY_WIDEN');
  }
  if (
    features.maxDispersionMadMicros !== null &&
    features.maxDispersionMadMicros >= policy.pauseDispersionMicros
  ) {
    pause.push('CONSENSUS_DISPERSION_PAUSE');
  } else if (
    features.maxDispersionMadMicros !== null &&
    features.maxDispersionMadMicros >= policy.widenDispersionMicros
  ) {
    widen.push('CONSENSUS_DISPERSION_WIDEN');
  }
  if (
    features.maxReactionLatencyMs !== null &&
    features.maxReactionLatencyMs >= policy.pauseReactionLatencyMs
  ) {
    pause.push('BOOKMAKER_REACTION_SLOW');
  } else if (
    features.maxReactionLatencyMs !== null &&
    features.maxReactionLatencyMs >= policy.widenReactionLatencyMs
  ) {
    widen.push('BOOKMAKER_REACTION_WARNING');
  }
  if (proofStatus === 'failed') pause.push('PROOF_VERIFICATION_FAILED');
  if (features.unreactedBookmakerCount > 0) {
    widen.push('BOOKMAKER_REACTION_UNOBSERVED');
  }
  return { pause, widen };
}

function recoveryHealthy(
  features: MarketRiskFeatures,
  policy: RiskPolicyConfiguration,
  proofStatus: ProofAvailability,
): boolean {
  return (
    proofStatus !== 'failed' &&
    features.consensusStatus === 'ready' &&
    features.freshBookmakerCount >= policy.minimumFreshBookmakers &&
    features.oldestFreshQuoteAgeMs !== null &&
    features.oldestFreshQuoteAgeMs <= policy.recoveryQuoteAgeMs &&
    features.staleBookmakerFractionPpm <= policy.recoveryStaleBookmakerFractionPpm &&
    (features.maxAbsVelocityMicrosPerSecond ?? 0) <=
      policy.recoveryVelocityMicrosPerSecond &&
    (features.maxDispersionMadMicros ?? 0) <= policy.recoveryDispersionMicros &&
    features.unreactedBookmakerCount === 0
  );
}

function initialState(input: RiskEvaluationInput): MarketRiskState {
  return {
    fixtureId: input.fixtureId,
    lastLogicalTimestampMs: 0,
    lastStateChangeAtMs: input.logicalTimestampMs,
    marketId: input.marketId,
    recoveryStableUpdates: 0,
    shockUntilMs: 0,
    state: 'OPEN',
    stateVersion: 0,
  };
}

export class DeterministicRiskEngine {
  readonly #decisions = new Map<string, CompletedRiskEvaluationResult>();
  readonly #policy: RiskPolicyConfiguration;
  readonly #policyConfigurationHash: string;
  readonly #states = new Map<string, MarketRiskState>();

  constructor(
    policy: RiskPolicyConfiguration = defaultRiskPolicyConfiguration,
    initialStates: readonly MarketRiskState[] = [],
  ) {
    validatePolicy(policy);
    this.#policy = Object.freeze({ ...policy });
    this.#policyConfigurationHash = stableHash(toJsonValue(this.#policy));
    for (const state of initialStates) {
      if (this.#states.has(state.marketId)) {
        throw new Error(`Duplicate initial market state: ${state.marketId}`);
      }
      this.#states.set(state.marketId, Object.freeze({ ...state }));
    }
  }

  get configuration(): RiskPolicyConfiguration {
    return this.#policy;
  }

  snapshot(marketId: string): MarketRiskState | null {
    return this.#states.get(marketId) ?? null;
  }

  evaluate(input: RiskEvaluationInput): RiskEvaluationResult {
    assertNonNegativeInteger('logicalTimestampMs', input.logicalTimestampMs);
    validateFeatures(input.features);
    const evaluationKey = `${input.marketId}|${input.triggerEventId}`;
    const duplicate = this.#decisions.get(evaluationKey);
    if (duplicate) return { ...duplicate, status: 'duplicate' };

    const previous = this.#states.get(input.marketId) ?? initialState(input);
    if (previous.fixtureId !== input.fixtureId) {
      throw new Error('A market risk state cannot move between fixtures.');
    }
    if (input.scoreEvent && input.scoreEvent.fixtureId !== input.fixtureId) {
      throw new Error('Score evidence must belong to the evaluated fixture.');
    }
    const scoreSignal = input.scoreEvent
      ? classifySoccerScoreEvent(input.scoreEvent)
      : normalSignal;
    if (input.logicalTimestampMs < previous.lastLogicalTimestampMs) {
      return { decision: null, signal: scoreSignal, state: previous, status: 'late' };
    }

    let shockUntilMs = previous.shockUntilMs;
    if (scoreSignal.protectiveAction === 'pause') {
      const holdMs =
        scoreSignal.confirmation === 'reversal'
          ? this.#policy.reversalShockHoldMs
          : this.#policy.criticalShockHoldMs;
      shockUntilMs =
        scoreSignal.confirmation === 'reversal'
          ? input.logicalTimestampMs + holdMs
          : Math.max(shockUntilMs, input.logicalTimestampMs + holdMs);
    }

    const reasons = marketReasons(input.features, this.#policy, input.proofStatus);
    const pauseReasons = [...reasons.pause];
    const widenReasons = [...reasons.widen];
    if (scoreSignal.protectiveAction === 'pause')
      pauseReasons.unshift(scoreSignal.reasonCode);
    if (scoreSignal.protectiveAction === 'widen')
      widenReasons.unshift(scoreSignal.reasonCode);
    if (shockUntilMs > input.logicalTimestampMs) {
      pauseReasons.push('EVENT_SHOCK_HOLD');
    }
    if (input.proofStatus === 'pending' || input.proofStatus === 'unavailable') {
      widenReasons.push('PROOF_NOT_READY_NON_BLOCKING');
    }

    const healthy = recoveryHealthy(input.features, this.#policy, input.proofStatus);
    const elapsedInStateMs = input.logicalTimestampMs - previous.lastStateChangeAtMs;
    let action: StrategyDecision['action'] = 'none';
    let nextState: MarketControlState = previous.state;
    let recoveryStableUpdates = previous.recoveryStableUpdates;

    if (previous.state === 'OPEN') {
      if (pauseReasons.length > 0) {
        action = 'pause';
        nextState = 'PAUSED';
        recoveryStableUpdates = 0;
      } else if (
        widenReasons.some((reason) => reason !== 'PROOF_NOT_READY_NON_BLOCKING')
      ) {
        action = 'widen';
        nextState = 'WIDENED';
        recoveryStableUpdates = 0;
      }
    } else if (previous.state === 'WIDENED') {
      if (pauseReasons.length > 0) {
        action = 'pause';
        nextState = 'PAUSED';
        recoveryStableUpdates = 0;
      } else if (healthy && elapsedInStateMs >= this.#policy.minimumWidenedMs) {
        action = 'begin_recovery';
        nextState = 'RECOVERY';
        recoveryStableUpdates = 1;
      }
    } else if (previous.state === 'PAUSED') {
      if (
        pauseReasons.length === 0 &&
        healthy &&
        elapsedInStateMs >= this.#policy.minimumPauseMs
      ) {
        action = 'begin_recovery';
        nextState = 'RECOVERY';
        recoveryStableUpdates = 1;
      } else {
        recoveryStableUpdates = 0;
      }
    } else if (pauseReasons.length > 0) {
      action = 'pause';
      nextState = 'PAUSED';
      recoveryStableUpdates = 0;
    } else if (healthy) {
      recoveryStableUpdates += 1;
      if (
        recoveryStableUpdates >= this.#policy.recoveryStableUpdates &&
        elapsedInStateMs >= this.#policy.recoveryCooldownMs
      ) {
        action = 'reopen';
        nextState = 'OPEN';
        recoveryStableUpdates = 0;
      }
    } else {
      recoveryStableUpdates = 0;
    }

    const transitionReasons = unique([
      ...pauseReasons,
      ...widenReasons,
      ...(input.scoreEvent ? [scoreSignal.reasonCode] : []),
      action === 'begin_recovery' ? 'RECOVERY_CONVERGENCE_STARTED' : '',
      action === 'reopen' ? 'RECOVERY_QUORUM_SATISFIED' : '',
      action === 'none' && pauseReasons.length === 0 && widenReasons.length === 0
        ? 'NO_RISK_THRESHOLD_CROSSED'
        : '',
    ]).filter(Boolean);
    const evidenceEventIds = unique([
      input.triggerEventId,
      ...(input.evidenceEventIds ?? []),
      ...(input.scoreEvent ? [input.scoreEvent.eventId] : []),
    ]).sort();
    const inputFeatureHash = stableHash(
      toJsonValue({
        evidenceEventIds,
        features: input.features,
        fixtureId: input.fixtureId,
        logicalTimestampMs: input.logicalTimestampMs,
        marketId: input.marketId,
        previous,
        proofStatus: input.proofStatus,
        scoreSignal,
        triggerEventId: input.triggerEventId,
      }),
    );
    const nextLastStateChangeAtMs =
      nextState === previous.state
        ? previous.lastStateChangeAtMs
        : input.logicalTimestampMs;
    const decision = createStrategyDecision({
      action,
      evidenceEventIds,
      expectedStateVersion: previous.stateVersion,
      fixtureId: input.fixtureId,
      inputFeatureHash,
      logicalTimestampMs: input.logicalTimestampMs,
      marketId: input.marketId,
      metrics: {
        activeShockRemainingMs: Math.max(0, shockUntilMs - input.logicalTimestampMs),
        freshBookmakerCount: input.features.freshBookmakerCount,
        maxAbsVelocityMicrosPerSecond: metric(
          input.features.maxAbsVelocityMicrosPerSecond,
        ),
        maxDispersionMadMicros: metric(input.features.maxDispersionMadMicros),
        maxReactionLatencyMs: metric(input.features.maxReactionLatencyMs),
        lastStateChangeAtMs: nextLastStateChangeAtMs,
        oldestFreshQuoteAgeMs: metric(input.features.oldestFreshQuoteAgeMs),
        proofStatus: proofMetric(input.proofStatus),
        recoveryStableUpdates,
        scoreSeverity: severityMetric(scoreSignal.severity),
        shockUntilMs,
        staleBookmakerFractionPpm: input.features.staleBookmakerFractionPpm,
        unreactedBookmakerCount: input.features.unreactedBookmakerCount,
      },
      nextState,
      payloadVersion: 2,
      policyConfigurationHash: this.#policyConfigurationHash,
      policyVersion: riskPolicyVersion,
      previousState: previous.state,
      reasonCodes: transitionReasons,
      thresholds: { ...this.#policy },
      triggerEventId: input.triggerEventId,
    });
    const state: MarketRiskState = Object.freeze({
      fixtureId: input.fixtureId,
      lastLogicalTimestampMs: input.logicalTimestampMs,
      lastStateChangeAtMs: nextLastStateChangeAtMs,
      marketId: input.marketId,
      recoveryStableUpdates,
      shockUntilMs,
      state: nextState,
      stateVersion: previous.stateVersion + 1,
    });
    const result: CompletedRiskEvaluationResult = {
      decision,
      signal: scoreSignal,
      state,
      status: 'applied',
    };
    this.#states.set(input.marketId, state);
    this.#decisions.set(evaluationKey, result);
    return result;
  }
}
