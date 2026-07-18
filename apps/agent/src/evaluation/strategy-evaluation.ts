import {
  DeterministicMarketFeatureEngine,
  DeterministicRiskEngine,
  buildStrategyEvaluationReport,
  compareEventOrder,
  consensusFormulaVersion,
  createMarketControlAdmission,
  defaultRiskPolicyConfiguration,
  marketOrderRequestSchema,
  marketRiskFeaturesFromConsensus,
  normalizeReportedProbabilityVector,
  bookmakerQuoteVectorFromEvent,
  stableHash,
  type ConsensusConfiguration,
  type ConsensusObservation,
  type NormalizedDomainEvent,
  type ReplayManifest,
  type RejectedEvaluationQuote,
  type RiskPolicyConfiguration,
  type StrategyDecision,
  type StrategyEvaluationReport,
} from '@lagshield/core';

import { createSeededDemoBundle } from '../replay/seeded-demo.js';

type EvaluationTrace = Readonly<{
  consensus: readonly ConsensusObservation[];
  decisions: readonly StrategyDecision[];
}>;

const seededConsensusConfiguration: ConsensusConfiguration = Object.freeze({
  formulaVersion: consensusFormulaVersion,
  minFreshBookmakers: 1,
  staleAfterMs: 5_000,
});

function evaluationMarketId(manifest: ReplayManifest, sourceMarketId: string): string {
  return `evaluation:${manifest.manifestId}:${stableHash(sourceMarketId).slice(0, 32)}`;
}

export function evaluateStrategyTrace(
  input: Readonly<{
    consensusConfiguration?: ConsensusConfiguration;
    events: readonly NormalizedDomainEvent[];
    manifest: ReplayManifest;
    policyConfiguration?: RiskPolicyConfiguration;
  }>,
): EvaluationTrace {
  const featureEngine = new DeterministicMarketFeatureEngine(
    input.consensusConfiguration ?? seededConsensusConfiguration,
  );
  const riskEngine = new DeterministicRiskEngine(
    input.policyConfiguration ?? defaultRiskPolicyConfiguration,
  );
  const observations: ConsensusObservation[] = [];
  const decisions: StrategyDecision[] = [];
  let consensus = null;
  for (const event of [...input.events].sort(compareEventOrder)) {
    const observed = featureEngine.observe(event, event.sourceTimestampMs);
    if (observed) {
      consensus = observed;
      observations.push({ snapshot: observed, triggerEventId: event.eventId });
    }
    const sourceMarketId =
      event.kind === 'odds.observed'
        ? event.payload.market.marketId
        : consensus?.marketId;
    if (!sourceMarketId || !consensus) continue;
    const evaluation = riskEngine.evaluate({
      evidenceEventIds: [event.eventId],
      features: marketRiskFeaturesFromConsensus(consensus),
      fixtureId: event.fixtureId,
      logicalTimestampMs: event.sourceTimestampMs,
      marketId: evaluationMarketId(input.manifest, sourceMarketId),
      proofStatus: 'unavailable',
      ...(event.kind === 'score.observed' ? { scoreEvent: event } : {}),
      triggerEventId: event.eventId,
    });
    if (evaluation.decision) decisions.push(evaluation.decision);
  }
  return { consensus: observations, decisions };
}

function seededRejectedQuote(
  events: readonly NormalizedDomainEvent[],
  decisions: readonly StrategyDecision[],
): RejectedEvaluationQuote {
  const signal = events.find((event) => event.kind === 'score.observed');
  const baselineEvent = [...events]
    .reverse()
    .find(
      (event) =>
        event.kind === 'odds.observed' &&
        signal !== undefined &&
        event.sourceTimestampMs < signal.sourceTimestampMs,
    );
  const paused = decisions.find(
    (decision) =>
      signal !== undefined &&
      decision.logicalTimestampMs >= signal.sourceTimestampMs &&
      decision.nextState === 'PAUSED',
  );
  if (!signal || !baselineEvent || baselineEvent.kind !== 'odds.observed' || !paused) {
    throw new Error('Seeded evaluation is missing its signal, baseline, or pause.');
  }
  const quoteVector = bookmakerQuoteVectorFromEvent(baselineEvent);
  const normalized = quoteVector && normalizeReportedProbabilityVector(quoteVector);
  if (!normalized?.ok) throw new Error('Seeded baseline probability is unavailable.');
  const outcome = normalized.vector.normalizedOutcomes.find(
    ({ outcomeId }) => outcomeId === 'seeded-canada',
  );
  if (!outcome) throw new Error('Seeded evaluation outcome is unavailable.');
  const requestedAtMs = signal.sourceTimestampMs + 3_000;
  const request = marketOrderRequestSchema.parse({
    expectedDecisionId: paused.decisionId,
    expectedStateVersion: paused.expectedStateVersion + 1,
    fixtureId: paused.fixtureId,
    idempotencyKey: 'seeded-evaluation-paused-order',
    marketId: paused.marketId,
    namespace: 'replay:seeded-evaluation',
    outcomeId: outcome.outcomeId,
    payloadVersion: 1,
    price: 2_400,
    quoteObservedAtMs: requestedAtMs,
    requestedAtMs,
    side: 'back',
    stakeMicros: 1_000_000,
  });
  const admission = createMarketControlAdmission({
    decision: paused,
    evaluatedAtMs: requestedAtMs,
    request,
    snapshot: {
      fixtureId: paused.fixtureId,
      lastDecisionId: paused.decisionId,
      logicalTimestampMs: paused.logicalTimestampMs,
      marketId: paused.marketId,
      state: paused.nextState,
      stateVersion: paused.expectedStateVersion + 1,
    },
  });
  if (admission.order.status !== 'rejected') {
    throw new Error('Seeded evaluation paper order must be rejected while PAUSED.');
  }
  return {
    orderId: admission.order.orderId,
    outcomeId: admission.order.outcomeId,
    requestedAtMs: admission.order.requestedAtMs,
    requestedProbabilityMicros: outcome.probabilityMicros,
  };
}

function reportForPolicy(
  events: readonly NormalizedDomainEvent[],
  manifest: ReplayManifest,
  policyConfiguration: RiskPolicyConfiguration,
  rejectedQuote: RejectedEvaluationQuote,
): StrategyEvaluationReport {
  const trace = evaluateStrategyTrace({ events, manifest, policyConfiguration });
  return buildStrategyEvaluationReport({
    ...trace,
    events,
    manifest,
    policyConfiguration,
    rejectedQuotes: [rejectedQuote],
  });
}

export function createSeededEvaluationReport(): StrategyEvaluationReport {
  const bundle = createSeededDemoBundle();
  const baseTrace = evaluateStrategyTrace({
    events: bundle.events,
    manifest: bundle.manifest,
  });
  const rejectedQuote = seededRejectedQuote(bundle.events, baseTrace.decisions);
  const variants = [
    {
      changedParameters: { recoveryStableUpdates: 2 },
      label: 'faster-recovery-2-updates',
      policy: {
        ...defaultRiskPolicyConfiguration,
        recoveryStableUpdates: 2,
      },
    },
    {
      changedParameters: { recoveryStableUpdates: 4 },
      label: 'conservative-recovery-4-updates',
      policy: {
        ...defaultRiskPolicyConfiguration,
        recoveryStableUpdates: 4,
      },
    },
    {
      changedParameters: { criticalShockHoldMs: 16_000 },
      label: 'longer-critical-hold-16s',
      policy: {
        ...defaultRiskPolicyConfiguration,
        criticalShockHoldMs: 16_000,
      },
    },
  ] as const;
  const sensitivity = variants.map((variant) => {
    const report = reportForPolicy(
      bundle.events,
      bundle.manifest,
      variant.policy,
      rejectedQuote,
    );
    return {
      changedParameters: variant.changedParameters,
      evaluationHash: report.evaluationHash,
      finalState: report.timeline.some(({ kind }) => kind === 'market_reopened')
        ? ('OPEN' as const)
        : (evaluateStrategyTrace({
            events: bundle.events,
            manifest: bundle.manifest,
            policyConfiguration: variant.policy,
          }).decisions.at(-1)?.nextState ?? null),
      flappingCount: report.metrics.flappingCount,
      label: variant.label,
      pauseDurationMs: report.metrics.pauseDurationMs,
      timeToReopenMs: report.metrics.timeToReopenMs,
    };
  });
  return buildStrategyEvaluationReport({
    ...baseTrace,
    events: bundle.events,
    manifest: bundle.manifest,
    policyConfiguration: defaultRiskPolicyConfiguration,
    rejectedQuotes: [rejectedQuote],
    sensitivity,
  });
}
