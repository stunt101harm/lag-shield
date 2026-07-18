import { compareEventOrder, type NormalizedDomainEvent } from './events.js';
import {
  bookmakerQuoteVectorFromEvent,
  measureBookmakerReactionLatencies,
  type BookmakerQuoteVector,
  type ConsensusSnapshot,
} from './market-consensus.js';
import type { StrategyDecision } from './models.js';
import type { ReplayManifest } from './replay.js';
import { classifySoccerScoreEvent, type RiskPolicyConfiguration } from './risk-engine.js';
import { stableHash, toJsonValue } from './json.js';

export const strategyEvaluationVersion = 'lagshield-strategy-evaluation-v1';

export type StrategyEvaluationParameters = Readonly<{
  convergenceToleranceMicros: number;
  convergenceWindowMs: number;
  materialMoveThresholdMicros: number;
  overlongPauseGraceMs: number;
}>;

export const defaultStrategyEvaluationParameters: StrategyEvaluationParameters =
  Object.freeze({
    convergenceToleranceMicros: 5_000,
    convergenceWindowMs: 10_000,
    materialMoveThresholdMicros: 50_000,
    overlongPauseGraceMs: 5_000,
  });

export type ConsensusObservation = Readonly<{
  snapshot: ConsensusSnapshot;
  triggerEventId: string;
}>;

export type RejectedEvaluationQuote = Readonly<{
  orderId: string;
  outcomeId: string;
  requestedAtMs: number;
  requestedProbabilityMicros: number;
}>;

export type EvaluationSensitivityResult = Readonly<{
  changedParameters: Readonly<Record<string, number>>;
  evaluationHash: string;
  finalState: StrategyDecision['nextState'] | null;
  flappingCount: number;
  label: string;
  pauseDurationMs: number | null;
  timeToReopenMs: number | null;
}>;

export type StrategyEvaluationReport = Readonly<{
  dataMode: ReplayManifest['source']['dataMode'];
  diagnostics: Readonly<{
    convergenceAtMs: number | null;
    falsePauseStatus:
      | 'confirmed_signal'
      | 'indeterminate_unconfirmed'
      | 'no_protective_signal'
      | 'overturned_signal';
    firstMaterialMoveEventId: string | null;
    overlongPauseMs: number | null;
    pausedAtMs: number | null;
    reopenedAtMs: number | null;
    signalEventId: string | null;
    signalKind: string | null;
  }>;
  evaluationHash: string;
  evaluationVersion: typeof strategyEvaluationVersion;
  fixtureId: string;
  generatedFrom: Readonly<{
    eventSequenceHash: string;
    inputHash: string;
    manifestId: string;
    strategyHash: string;
  }>;
  limitations: readonly string[];
  metrics: Readonly<{
    avoidedPriceErrorProxy: Readonly<{
      evaluatedOrderCount: number;
      label: 'absolute-probability-distance-proxy-not-pnl';
      maxErrorMicros: number | null;
      meanErrorMicros: number | null;
      rejectedOrderCount: number;
    }>;
    bookmakerReactionLatencies: readonly Readonly<{
      bookmakerId: string;
      firstReactionEventId: string | null;
      latencyMs: number | null;
    }>[];
    eventToFirstConsensusMoveLatencyMs: number | null;
    flappingCount: number;
    maxBookmakerReactionLatencyMs: number | null;
    normalPlayControl: Readonly<{
      decisionCount: number;
      durationMs: number | null;
      restrictiveTransitionCount: number;
    }>;
    pauseDurationMs: number | null;
    protectiveSignalCount: number;
    staleExposureDurationMs: number | null;
    stateTransitionCount: number;
    stateTransitionCounts: Readonly<Record<string, number>>;
    timeToReopenMs: number | null;
  }>;
  parameters: StrategyEvaluationParameters;
  policy: Readonly<{
    configuration: RiskPolicyConfiguration;
    configurationHash: string | null;
    version: string;
  }>;
  sensitivity: readonly EvaluationSensitivityResult[];
  timeline: readonly Readonly<{
    atMs: number;
    eventId: string;
    kind:
      | 'consensus_converged'
      | 'consensus_moved'
      | 'market_paused'
      | 'market_reopened'
      | 'normal_control_started'
      | 'paper_order_rejected'
      | 'protective_signal';
    label: string;
  }>[];
}>;

function assertNonNegativeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function maximumOutcomeDelta(
  left: ConsensusSnapshot,
  right: ConsensusSnapshot,
): number | null {
  if (left.status !== 'ready' || right.status !== 'ready') return null;
  const leftIds = left.outcomes.map(({ outcomeId }) => outcomeId).sort();
  const rightIds = right.outcomes.map(({ outcomeId }) => outcomeId).sort();
  if (leftIds.join('|') !== rightIds.join('|')) return null;
  return Math.max(
    ...right.outcomes.map((outcome) => {
      const baseline = left.outcomes.find(
        ({ outcomeId }) => outcomeId === outcome.outcomeId,
      )!;
      return Math.abs(outcome.probabilityMicros - baseline.probabilityMicros);
    }),
  );
}

function convergedObservation(
  observations: readonly ConsensusObservation[],
  baseline: ConsensusSnapshot,
  signalAtMs: number,
  parameters: StrategyEvaluationParameters,
): ConsensusObservation | null {
  const eligible = observations.filter(
    ({ snapshot }) =>
      snapshot.marketId === baseline.marketId &&
      snapshot.logicalTimestampMs >= signalAtMs &&
      (maximumOutcomeDelta(baseline, snapshot) ?? -1) >=
        parameters.materialMoveThresholdMicros,
  );
  for (const candidate of eligible) {
    const windowEnd =
      candidate.snapshot.logicalTimestampMs + parameters.convergenceWindowMs;
    const withinWindow = observations.filter(
      ({ snapshot }) =>
        snapshot.marketId === baseline.marketId &&
        snapshot.logicalTimestampMs >= candidate.snapshot.logicalTimestampMs &&
        snapshot.logicalTimestampMs <= windowEnd,
    );
    if ((withinWindow.at(-1)?.snapshot.logicalTimestampMs ?? -1) < windowEnd) continue;
    if (
      withinWindow.every(
        ({ snapshot }) =>
          (maximumOutcomeDelta(candidate.snapshot, snapshot) ??
            Number.MAX_SAFE_INTEGER) <= parameters.convergenceToleranceMicros,
      )
    ) {
      return candidate;
    }
  }
  return null;
}

function orderedDecisions(decisions: readonly StrategyDecision[]): StrategyDecision[] {
  return [...decisions].sort((left, right) => {
    if (left.logicalTimestampMs !== right.logicalTimestampMs) {
      return left.logicalTimestampMs - right.logicalTimestampMs;
    }
    return left.decisionId.localeCompare(right.decisionId);
  });
}

function falsePauseStatus(
  signal: Extract<NormalizedDomainEvent, { kind: 'score.observed' }> | null,
  laterScoreEvents: readonly Extract<NormalizedDomainEvent, { kind: 'score.observed' }>[],
): StrategyEvaluationReport['diagnostics']['falsePauseStatus'] {
  if (!signal) return 'no_protective_signal';
  const classified = classifySoccerScoreEvent(signal);
  if (classified.confirmation === 'confirmed') return 'confirmed_signal';
  if (
    laterScoreEvents.some((event) => {
      const later = classifySoccerScoreEvent(event);
      return later.confirmation === 'reversal' || later.kind === 'var_overturned';
    })
  ) {
    return 'overturned_signal';
  }
  return 'indeterminate_unconfirmed';
}

function meanRounded(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

export function buildStrategyEvaluationReport(
  input: Readonly<{
    consensus: readonly ConsensusObservation[];
    decisions: readonly StrategyDecision[];
    events: readonly NormalizedDomainEvent[];
    manifest: ReplayManifest;
    parameters?: StrategyEvaluationParameters;
    policyConfiguration: RiskPolicyConfiguration;
    rejectedQuotes?: readonly RejectedEvaluationQuote[];
    sensitivity?: readonly EvaluationSensitivityResult[];
  }>,
): StrategyEvaluationReport {
  const parameters = Object.freeze({
    ...defaultStrategyEvaluationParameters,
    ...input.parameters,
  });
  for (const [key, value] of Object.entries(parameters)) {
    assertNonNegativeInteger(key, value);
  }
  if (parameters.materialMoveThresholdMicros === 0) {
    throw new Error('materialMoveThresholdMicros must be positive.');
  }
  const events = [...input.events].sort(compareEventOrder);
  const decisions = orderedDecisions(input.decisions);
  const observations = [...input.consensus].sort((left, right) => {
    if (left.snapshot.logicalTimestampMs !== right.snapshot.logicalTimestampMs) {
      return left.snapshot.logicalTimestampMs - right.snapshot.logicalTimestampMs;
    }
    return left.triggerEventId.localeCompare(right.triggerEventId);
  });
  const scoreEvents = events.filter(
    (event): event is Extract<NormalizedDomainEvent, { kind: 'score.observed' }> =>
      event.kind === 'score.observed',
  );
  const protectiveSignals = scoreEvents.filter(
    (event) => classifySoccerScoreEvent(event).protectiveAction !== 'none',
  );
  const signal = protectiveSignals[0] ?? null;
  const signalAtMs = signal?.sourceTimestampMs ?? null;
  const baseline = signal
    ? ([...observations]
        .reverse()
        .find(({ snapshot }) => snapshot.logicalTimestampMs < signal.sourceTimestampMs)
        ?.snapshot ?? null)
    : null;
  const firstMove =
    signal && baseline
      ? (observations.find(
          ({ snapshot }) =>
            snapshot.marketId === baseline.marketId &&
            snapshot.logicalTimestampMs >= signal.sourceTimestampMs &&
            (maximumOutcomeDelta(baseline, snapshot) ?? -1) >=
              parameters.materialMoveThresholdMicros,
        ) ?? null)
      : null;
  const convergence =
    signal && baseline
      ? convergedObservation(observations, baseline, signal.sourceTimestampMs, parameters)
      : null;
  const quotes = events.flatMap((event): BookmakerQuoteVector[] => {
    if (event.kind !== 'odds.observed') return [];
    const quote = bookmakerQuoteVectorFromEvent(event);
    return quote ? [quote] : [];
  });
  const reactionLatencies =
    signal && baseline
      ? measureBookmakerReactionLatencies({
          baseline,
          eventTimestampMs: signal.sourceTimestampMs,
          quotes,
          reactionThresholdMicros: parameters.materialMoveThresholdMicros,
        })
      : [];
  const measuredReactionLatencies = reactionLatencies.flatMap(({ latencyMs }) =>
    latencyMs === null ? [] : [latencyMs],
  );
  const pausedDecision =
    signalAtMs === null
      ? null
      : (decisions.find(
          (decision) =>
            decision.logicalTimestampMs >= signalAtMs && decision.nextState === 'PAUSED',
        ) ?? null);
  const pauseExit = pausedDecision
    ? (decisions.find(
        (decision) =>
          decision.logicalTimestampMs > pausedDecision.logicalTimestampMs &&
          decision.nextState !== 'PAUSED',
      ) ?? null)
    : null;
  const reopened = pausedDecision
    ? (decisions.find(
        (decision) =>
          decision.logicalTimestampMs > pausedDecision.logicalTimestampMs &&
          decision.previousState !== 'OPEN' &&
          decision.nextState === 'OPEN',
      ) ?? null)
    : null;
  const evaluationEndMs = events.at(-1)?.sourceTimestampMs ?? input.manifest.source.endMs;
  const pauseDurationMs = pausedDecision
    ? (pauseExit?.logicalTimestampMs ?? evaluationEndMs) -
      pausedDecision.logicalTimestampMs
    : null;
  const transitions = decisions.filter(
    ({ nextState, previousState }) => nextState !== previousState,
  );
  const transitionCounts: Record<string, number> = {};
  for (const decision of transitions) {
    const transition = `${decision.previousState}->${decision.nextState}`;
    transitionCounts[transition] = (transitionCounts[transition] ?? 0) + 1;
  }
  const flappingCount = transitions.filter(
    ({ nextState, previousState }) =>
      previousState === 'RECOVERY' && (nextState === 'PAUSED' || nextState === 'WIDENED'),
  ).length;
  const convergedOutcomeProbabilities = new Map(
    convergence?.snapshot.outcomes.map(({ outcomeId, probabilityMicros }) => [
      outcomeId,
      probabilityMicros,
    ]) ?? [],
  );
  const rejectedQuotes = [...(input.rejectedQuotes ?? [])].sort((left, right) =>
    left.orderId.localeCompare(right.orderId),
  );
  for (const quote of rejectedQuotes) {
    assertNonNegativeInteger('requestedAtMs', quote.requestedAtMs);
    assertNonNegativeInteger(
      'requestedProbabilityMicros',
      quote.requestedProbabilityMicros,
    );
  }
  const proxyErrors = rejectedQuotes.flatMap((quote) => {
    const convergedProbability = convergedOutcomeProbabilities.get(quote.outcomeId);
    return convergedProbability === undefined
      ? []
      : [Math.abs(convergedProbability - quote.requestedProbabilityMicros)];
  });
  const normalControlStartMs = baseline?.logicalTimestampMs ?? null;
  const normalPlayDecisions =
    normalControlStartMs === null || signalAtMs === null
      ? []
      : decisions.filter(
          ({ logicalTimestampMs }) =>
            logicalTimestampMs >= normalControlStartMs && logicalTimestampMs < signalAtMs,
        );
  const normalRestrictiveTransitions = normalPlayDecisions.filter(
    ({ nextState, previousState }) => nextState !== previousState && nextState !== 'OPEN',
  ).length;
  const overlongPauseMs =
    pauseExit && convergence
      ? Math.max(
          0,
          pauseExit.logicalTimestampMs -
            (convergence.snapshot.logicalTimestampMs + parameters.overlongPauseGraceMs),
        )
      : null;
  const policyDecision = decisions.find(
    (decision): decision is Extract<StrategyDecision, { payloadVersion: 2 }> =>
      decision.payloadVersion === 2,
  );
  const timeline: Array<StrategyEvaluationReport['timeline'][number]> = [];
  if (normalControlStartMs !== null && baseline) {
    timeline.push({
      atMs: normalControlStartMs,
      eventId: baseline.consensusId,
      kind: 'normal_control_started',
      label: 'Normal-play control window opened with a ready consensus.',
    });
  }
  if (signal) {
    timeline.push({
      atMs: signal.sourceTimestampMs,
      eventId: signal.eventId,
      kind: 'protective_signal',
      label: `${classifySoccerScoreEvent(signal).kind} signal observed.`,
    });
  }
  if (pausedDecision) {
    timeline.push({
      atMs: pausedDecision.logicalTimestampMs,
      eventId: pausedDecision.decisionId,
      kind: 'market_paused',
      label: 'Deterministic policy entered PAUSED.',
    });
  }
  if (firstMove) {
    timeline.push({
      atMs: firstMove.snapshot.logicalTimestampMs,
      eventId: firstMove.triggerEventId,
      kind: 'consensus_moved',
      label: 'Consensus crossed the configured material-move threshold.',
    });
  }
  if (convergence) {
    timeline.push({
      atMs: convergence.snapshot.logicalTimestampMs,
      eventId: convergence.triggerEventId,
      kind: 'consensus_converged',
      label: 'Post-event consensus began the stable convergence window.',
    });
  }
  for (const quote of rejectedQuotes) {
    timeline.push({
      atMs: quote.requestedAtMs,
      eventId: quote.orderId,
      kind: 'paper_order_rejected',
      label: 'A simulated paper order was rejected; no real money was involved.',
    });
  }
  if (reopened) {
    timeline.push({
      atMs: reopened.logicalTimestampMs,
      eventId: reopened.decisionId,
      kind: 'market_reopened',
      label: 'Recovery quorum reopened the simulated market.',
    });
  }
  timeline.sort((left, right) => {
    if (left.atMs !== right.atMs) return left.atMs - right.atMs;
    return left.eventId.localeCompare(right.eventId);
  });
  const identity = {
    dataMode: input.manifest.source.dataMode,
    diagnostics: {
      convergenceAtMs: convergence?.snapshot.logicalTimestampMs ?? null,
      falsePauseStatus: falsePauseStatus(
        signal,
        signal
          ? scoreEvents.filter(
              ({ sourceTimestampMs }) => sourceTimestampMs > signal.sourceTimestampMs,
            )
          : [],
      ),
      firstMaterialMoveEventId: firstMove?.triggerEventId ?? null,
      overlongPauseMs,
      pausedAtMs: pausedDecision?.logicalTimestampMs ?? null,
      reopenedAtMs: reopened?.logicalTimestampMs ?? null,
      signalEventId: signal?.eventId ?? null,
      signalKind: signal ? classifySoccerScoreEvent(signal).kind : null,
    },
    evaluationVersion: strategyEvaluationVersion,
    fixtureId: input.manifest.fixture.fixtureId,
    generatedFrom: {
      eventSequenceHash: input.manifest.eventSequenceHash,
      inputHash: input.manifest.inputHash,
      manifestId: input.manifest.manifestId,
      strategyHash: input.manifest.configuration.strategyHash,
    },
    limitations: [
      'The avoided-price-error value is an absolute probability-distance proxy, not P&L, profit, or causal attribution.',
      'An unconfirmed event without a later confirmation or reversal remains indeterminate; it is not labelled a false positive.',
      'Reaction latency is limited to bookmakers and reported probabilities present in the evaluated feed.',
      'A seeded-simulation report demonstrates deterministic behavior, not historical production performance.',
    ],
    metrics: {
      avoidedPriceErrorProxy: {
        evaluatedOrderCount: proxyErrors.length,
        label: 'absolute-probability-distance-proxy-not-pnl' as const,
        maxErrorMicros: proxyErrors.length > 0 ? Math.max(...proxyErrors) : null,
        meanErrorMicros: meanRounded(proxyErrors),
        rejectedOrderCount: rejectedQuotes.length,
      },
      bookmakerReactionLatencies: reactionLatencies,
      eventToFirstConsensusMoveLatencyMs:
        signal && firstMove
          ? firstMove.snapshot.logicalTimestampMs - signal.sourceTimestampMs
          : null,
      flappingCount,
      maxBookmakerReactionLatencyMs:
        measuredReactionLatencies.length > 0
          ? Math.max(...measuredReactionLatencies)
          : null,
      normalPlayControl: {
        decisionCount: normalPlayDecisions.length,
        durationMs:
          normalControlStartMs !== null && signalAtMs !== null
            ? signalAtMs - normalControlStartMs
            : null,
        restrictiveTransitionCount: normalRestrictiveTransitions,
      },
      pauseDurationMs,
      protectiveSignalCount: protectiveSignals.length,
      staleExposureDurationMs:
        signal && firstMove
          ? firstMove.snapshot.logicalTimestampMs - signal.sourceTimestampMs
          : null,
      stateTransitionCount: transitions.length,
      stateTransitionCounts: Object.fromEntries(
        Object.entries(transitionCounts).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      timeToReopenMs:
        signal && reopened
          ? reopened.logicalTimestampMs - signal.sourceTimestampMs
          : null,
    },
    parameters,
    policy: {
      configuration: input.policyConfiguration,
      configurationHash: policyDecision?.policyConfigurationHash ?? null,
      version:
        policyDecision?.policyVersion ?? input.manifest.configuration.strategyVersion,
    },
    sensitivity: [...(input.sensitivity ?? [])].sort((left, right) =>
      left.label.localeCompare(right.label),
    ),
    timeline,
  } as const;
  return Object.freeze({
    ...identity,
    evaluationHash: stableHash(toJsonValue(identity)),
  });
}

function milliseconds(value: number | null): string {
  return value === null ? 'not observed' : `${value.toLocaleString('en-US')} ms`;
}

function probabilityPoints(value: number | null): string {
  return value === null ? 'not evaluable' : `${(value / 10_000).toFixed(1)} pp`;
}

export function renderStrategyEvaluationMarkdown(
  report: StrategyEvaluationReport,
): string {
  const proxy = report.metrics.avoidedPriceErrorProxy;
  const reactionRows = report.metrics.bookmakerReactionLatencies
    .map(
      ({ bookmakerId, latencyMs }) => `| ${bookmakerId} | ${milliseconds(latencyMs)} |`,
    )
    .join('\n');
  const sensitivityRows = report.sensitivity
    .map(
      (row) =>
        `| ${row.label} | ${milliseconds(row.pauseDurationMs)} | ${milliseconds(row.timeToReopenMs)} | ${row.finalState ?? 'none'} | ${row.flappingCount} |`,
    )
    .join('\n');
  return (
    `# LagShield deterministic evaluation\n\n` +
    `- Evaluation hash: \`${report.evaluationHash}\`\n` +
    `- Replay manifest: \`${report.generatedFrom.manifestId}\`\n` +
    `- Fixture: \`${report.fixtureId}\`\n` +
    `- Data mode: \`${report.dataMode}\`\n` +
    `- Policy: \`${report.policy.version}\` / \`${report.policy.configurationHash ?? 'unavailable'}\`\n\n` +
    `## Result\n\n` +
    `LagShield entered PAUSED at the protective signal. The first material consensus move arrived **${milliseconds(report.metrics.eventToFirstConsensusMoveLatencyMs)}** later. ` +
    `The market spent **${milliseconds(report.metrics.pauseDurationMs)}** in PAUSED and reopened after **${milliseconds(report.metrics.timeToReopenMs)}**, with **${report.metrics.flappingCount}** recovery flaps.\n\n` +
    `The rejected paper-order sample had an absolute post-convergence probability-distance proxy of **${probabilityPoints(proxy.meanErrorMicros)}**. This is explicitly **not P&L** and does not claim causal profit protection.\n\n` +
    `## Bookmaker reaction latency\n\n| Bookmaker | First material reaction |\n| --- | ---: |\n${reactionRows || '| none | not observed |'}\n\n` +
    `## Normal-play control\n\n` +
    `The pre-signal control window covered **${milliseconds(report.metrics.normalPlayControl.durationMs)}**, contained **${report.metrics.normalPlayControl.decisionCount}** decision${report.metrics.normalPlayControl.decisionCount === 1 ? '' : 's'}, and produced **${report.metrics.normalPlayControl.restrictiveTransitionCount}** restrictive transitions.\n\n` +
    `## Sensitivity\n\n| Variant | Pause duration | Time to reopen | Final state | Recovery flaps |\n| --- | ---: | ---: | --- | ---: |\n${sensitivityRows || '| none | not observed | not observed | none | 0 |'}\n\n` +
    `## Parameters\n\n` +
    `- Material consensus move: ${probabilityPoints(report.parameters.materialMoveThresholdMicros)}\n` +
    `- Stable convergence window: ${milliseconds(report.parameters.convergenceWindowMs)}\n` +
    `- Convergence tolerance: ${probabilityPoints(report.parameters.convergenceToleranceMicros)}\n` +
    `- Critical shock hold: ${milliseconds(report.policy.configuration.criticalShockHoldMs)}\n` +
    `- Recovery quorum: ${report.policy.configuration.recoveryStableUpdates} stable updates\n\n` +
    `## Limitations\n\n${report.limitations.map((limitation) => `- ${limitation}`).join('\n')}\n`
  );
}

export function verifyStrategyEvaluationReport(
  report: StrategyEvaluationReport,
): StrategyEvaluationReport {
  const { evaluationHash, ...identity } = report;
  if (stableHash(toJsonValue(identity)) !== evaluationHash) {
    throw new Error('Strategy evaluation report hash is not canonical.');
  }
  return report;
}
