import type { NormalizedDomainEvent } from './events.js';
import { stableHash, type JsonValue } from './json.js';

export const probabilityScale = 1_000_000;
export const consensusFormulaVersion = 'reported-pct-proportional-median-v1';

export type ReportedProbabilityOutcome = Readonly<{
  name: string;
  outcomeId: string;
  reportedProbabilityMicros: number | null;
}>;

export type BookmakerQuoteVector = Readonly<{
  bookmakerId: string;
  bookmakerName: string;
  eventId: string;
  marketId: string;
  observedAtMs: number;
  outcomes: readonly ReportedProbabilityOutcome[];
}>;

export type NormalizedProbabilityOutcome = Readonly<{
  name: string;
  outcomeId: string;
  probabilityMicros: number;
  reportedProbabilityMicros: number;
}>;

export type NormalizedProbabilityVector = Readonly<{
  bookmakerId: string;
  bookmakerName: string;
  eventId: string;
  marketId: string;
  normalizedOutcomes: readonly NormalizedProbabilityOutcome[];
  observedAtMs: number;
  reportedSumMicros: number;
  residualOverroundMicros: number;
}>;

export type ProbabilityVectorDiagnosticCode =
  | 'duplicate_outcome'
  | 'empty_outcome_vector'
  | 'future_quote'
  | 'missing_reported_probability'
  | 'nonpositive_probability_sum'
  | 'outcome_set_mismatch'
  | 'stale_quote';

export type ProbabilityVectorDiagnostic = Readonly<{
  bookmakerId: string;
  code: ProbabilityVectorDiagnosticCode;
  eventId: string;
}>;

export type ConsensusOutcome = Readonly<{
  deltaMicros: number | null;
  dispersionMadMicros: number;
  name: string;
  outcomeId: string;
  probabilityMicros: number;
  velocityMicrosPerSecond: number | null;
}>;

export type ConsensusSnapshot = Readonly<{
  consensusId: string;
  diagnostics: readonly ProbabilityVectorDiagnostic[];
  formulaVersion: typeof consensusFormulaVersion;
  freshBookmakerCount: number;
  freshestQuoteAgeMs: number | null;
  logicalTimestampMs: number;
  marketId: string;
  oldestFreshQuoteAgeMs: number | null;
  outcomes: readonly ConsensusOutcome[];
  staleBookmakerCount: number;
  staleBookmakerFractionPpm: number;
  status: 'insufficient' | 'ready';
  totalBookmakerCount: number;
  validBookmakerCount: number;
}>;

export type ConsensusConfiguration = Readonly<{
  formulaVersion: typeof consensusFormulaVersion;
  minFreshBookmakers: number;
  staleAfterMs: number;
}>;

export function bookmakerQuoteVectorFromEvent(
  event: Extract<NormalizedDomainEvent, { kind: 'odds.observed' }>,
): BookmakerQuoteVector | null {
  if (event.payloadVersion !== 2) return null;
  return {
    bookmakerId: event.payload.bookmaker.id,
    bookmakerName: event.payload.bookmaker.name,
    eventId: event.eventId,
    marketId: event.payload.market.marketId,
    observedAtMs: event.sourceTimestampMs,
    outcomes: event.payload.outcomes.map(
      ({ name, outcomeId, reportedProbabilityMicros }) => ({
        name,
        outcomeId,
        reportedProbabilityMicros,
      }),
    ),
  };
}

function assertSafeNonNegative(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function assertIdentifier(label: string, value: string): void {
  if (value.length < 1 || value.length > 512) {
    throw new Error(`${label} must contain between 1 and 512 characters.`);
  }
}

function ratioRounded(numerator: number, denominator: number, scale: number): number {
  if (denominator <= 0) return 0;
  return Math.floor((numerator * scale + denominator / 2) / denominator);
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('Median requires at least one value.');
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]!
    : Math.floor((ordered[middle - 1]! + ordered[middle]!) / 2);
}

function signedVelocity(deltaMicros: number, elapsedMs: number): number | null {
  if (elapsedMs <= 0) return null;
  return Number((BigInt(deltaMicros) * 1_000n) / BigInt(elapsedMs));
}

function normalizeProbabilityOutcomes(
  outcomes: readonly Readonly<{
    name: string;
    outcomeId: string;
    reportedProbabilityMicros: number;
  }>[],
): readonly NormalizedProbabilityOutcome[] {
  const ordered = [...outcomes].sort((left, right) =>
    left.outcomeId.localeCompare(right.outcomeId),
  );
  const sum = ordered.reduce(
    (total, outcome) => total + outcome.reportedProbabilityMicros,
    0,
  );
  if (sum <= 0) throw new Error('Probability sum must be positive.');
  const allocated = ordered.map((outcome) => {
    const numerator =
      BigInt(outcome.reportedProbabilityMicros) * BigInt(probabilityScale);
    return {
      ...outcome,
      probabilityMicros: Number(numerator / BigInt(sum)),
      remainder: numerator % BigInt(sum),
    };
  });
  let residual =
    probabilityScale -
    allocated.reduce((total, outcome) => total + outcome.probabilityMicros, 0);
  const remainderOrder = [...allocated].sort((left, right) => {
    if (left.remainder !== right.remainder)
      return left.remainder > right.remainder ? -1 : 1;
    return left.outcomeId.localeCompare(right.outcomeId);
  });
  for (let index = 0; residual > 0; index += 1, residual -= 1) {
    remainderOrder[index]!.probabilityMicros += 1;
  }
  return allocated
    .sort((left, right) => left.outcomeId.localeCompare(right.outcomeId))
    .map((outcome) => ({
      name: outcome.name,
      outcomeId: outcome.outcomeId,
      probabilityMicros: outcome.probabilityMicros,
      reportedProbabilityMicros: outcome.reportedProbabilityMicros,
    }));
}

function outcomeSignature(outcomes: readonly Readonly<{ outcomeId: string }>[]): string {
  return [...outcomes]
    .map(({ outcomeId }) => outcomeId)
    .sort()
    .join('|');
}

export function normalizeReportedProbabilityVector(
  quote: BookmakerQuoteVector,
):
  | Readonly<{ diagnostic: ProbabilityVectorDiagnostic; ok: false }>
  | Readonly<{ ok: true; vector: NormalizedProbabilityVector }> {
  for (const [label, value] of [
    ['bookmakerId', quote.bookmakerId],
    ['eventId', quote.eventId],
    ['marketId', quote.marketId],
  ] as const) {
    assertIdentifier(label, value);
  }
  assertSafeNonNegative('observedAtMs', quote.observedAtMs);
  const diagnostic = (code: ProbabilityVectorDiagnosticCode) =>
    ({ bookmakerId: quote.bookmakerId, code, eventId: quote.eventId }) as const;
  if (quote.outcomes.length < 2) {
    return { diagnostic: diagnostic('empty_outcome_vector'), ok: false };
  }
  if (
    new Set(quote.outcomes.map(({ outcomeId }) => outcomeId)).size !==
    quote.outcomes.length
  ) {
    return { diagnostic: diagnostic('duplicate_outcome'), ok: false };
  }
  const complete: Array<{
    name: string;
    outcomeId: string;
    reportedProbabilityMicros: number;
  }> = [];
  for (const outcome of quote.outcomes) {
    assertIdentifier('outcomeId', outcome.outcomeId);
    if (outcome.reportedProbabilityMicros === null) {
      return { diagnostic: diagnostic('missing_reported_probability'), ok: false };
    }
    assertSafeNonNegative('reportedProbabilityMicros', outcome.reportedProbabilityMicros);
    if (outcome.reportedProbabilityMicros > probabilityScale) {
      throw new Error('reportedProbabilityMicros must not exceed 1,000,000.');
    }
    complete.push({
      ...outcome,
      reportedProbabilityMicros: outcome.reportedProbabilityMicros,
    });
  }
  const reportedSumMicros = complete.reduce(
    (sum, outcome) => sum + outcome.reportedProbabilityMicros,
    0,
  );
  if (reportedSumMicros <= 0) {
    return { diagnostic: diagnostic('nonpositive_probability_sum'), ok: false };
  }
  return {
    ok: true,
    vector: {
      bookmakerId: quote.bookmakerId,
      bookmakerName: quote.bookmakerName,
      eventId: quote.eventId,
      marketId: quote.marketId,
      normalizedOutcomes: normalizeProbabilityOutcomes(complete),
      observedAtMs: quote.observedAtMs,
      reportedSumMicros,
      residualOverroundMicros: reportedSumMicros - probabilityScale,
    },
  };
}

function latestByBookmaker(
  quotes: readonly BookmakerQuoteVector[],
): readonly BookmakerQuoteVector[] {
  const latest = new Map<string, BookmakerQuoteVector>();
  for (const quote of quotes) {
    const existing = latest.get(quote.bookmakerId);
    if (
      !existing ||
      quote.observedAtMs > existing.observedAtMs ||
      (quote.observedAtMs === existing.observedAtMs &&
        quote.eventId.localeCompare(existing.eventId) > 0)
    ) {
      latest.set(quote.bookmakerId, quote);
    }
  }
  return [...latest.values()].sort((left, right) =>
    left.bookmakerId.localeCompare(right.bookmakerId),
  );
}

function preferredOutcomeGroup(
  vectors: readonly NormalizedProbabilityVector[],
): readonly NormalizedProbabilityVector[] {
  const groups = new Map<string, NormalizedProbabilityVector[]>();
  for (const vector of vectors) {
    const signature = outcomeSignature(vector.normalizedOutcomes);
    const group = groups.get(signature) ?? [];
    group.push(vector);
    groups.set(signature, group);
  }
  return (
    [...groups.entries()].sort(([leftSignature, left], [rightSignature, right]) => {
      if (left.length !== right.length) return right.length - left.length;
      return leftSignature.localeCompare(rightSignature);
    })[0]?.[1] ?? []
  );
}

export function createConsensusSnapshot(
  input: Readonly<{
    configuration: ConsensusConfiguration;
    logicalTimestampMs: number;
    marketId: string;
    previous?: ConsensusSnapshot;
    quotes: readonly BookmakerQuoteVector[];
  }>,
): ConsensusSnapshot {
  assertIdentifier('marketId', input.marketId);
  assertSafeNonNegative('logicalTimestampMs', input.logicalTimestampMs);
  assertSafeNonNegative('staleAfterMs', input.configuration.staleAfterMs);
  if (
    !Number.isSafeInteger(input.configuration.minFreshBookmakers) ||
    input.configuration.minFreshBookmakers < 1
  ) {
    throw new Error('minFreshBookmakers must be a positive safe integer.');
  }
  if (input.configuration.formulaVersion !== consensusFormulaVersion) {
    throw new Error(
      `Unsupported consensus formula ${input.configuration.formulaVersion}.`,
    );
  }
  if (input.quotes.some(({ marketId }) => marketId !== input.marketId)) {
    throw new Error('Every quote must match the requested marketId.');
  }

  const diagnostics: ProbabilityVectorDiagnostic[] = [];
  const latest = latestByBookmaker(input.quotes);
  const freshVectors: NormalizedProbabilityVector[] = [];
  const freshAges: number[] = [];
  let staleBookmakerCount = 0;
  for (const quote of latest) {
    if (quote.observedAtMs > input.logicalTimestampMs) {
      diagnostics.push({
        bookmakerId: quote.bookmakerId,
        code: 'future_quote',
        eventId: quote.eventId,
      });
      continue;
    }
    const age = input.logicalTimestampMs - quote.observedAtMs;
    if (age > input.configuration.staleAfterMs) {
      staleBookmakerCount += 1;
      diagnostics.push({
        bookmakerId: quote.bookmakerId,
        code: 'stale_quote',
        eventId: quote.eventId,
      });
      continue;
    }
    const normalized = normalizeReportedProbabilityVector(quote);
    if (!normalized.ok) diagnostics.push(normalized.diagnostic);
    else {
      freshVectors.push(normalized.vector);
      freshAges.push(age);
    }
  }

  const preferred = preferredOutcomeGroup(freshVectors);
  const preferredIds = new Set(preferred.map(({ eventId }) => eventId));
  for (const vector of freshVectors) {
    if (!preferredIds.has(vector.eventId)) {
      diagnostics.push({
        bookmakerId: vector.bookmakerId,
        code: 'outcome_set_mismatch',
        eventId: vector.eventId,
      });
    }
  }
  const ready = preferred.length >= input.configuration.minFreshBookmakers;
  let outcomes: ConsensusOutcome[] = [];
  if (ready) {
    const template = preferred[0]!.normalizedOutcomes;
    const componentMedians = template.map((templateOutcome) => {
      const probabilities = preferred.map(
        (vector) =>
          vector.normalizedOutcomes.find(
            ({ outcomeId }) => outcomeId === templateOutcome.outcomeId,
          )!.probabilityMicros,
      );
      return {
        name: templateOutcome.name,
        outcomeId: templateOutcome.outcomeId,
        reportedProbabilityMicros: median(probabilities),
        sourceProbabilities: probabilities,
      };
    });
    const normalizedMedians = normalizeProbabilityOutcomes(componentMedians);
    const elapsedMs = input.previous
      ? input.logicalTimestampMs - input.previous.logicalTimestampMs
      : 0;
    outcomes = normalizedMedians.map((outcome) => {
      const component = componentMedians.find(
        ({ outcomeId }) => outcomeId === outcome.outcomeId,
      )!;
      const previous = input.previous?.outcomes.find(
        ({ outcomeId }) => outcomeId === outcome.outcomeId,
      );
      const deltaMicros = previous
        ? outcome.probabilityMicros - previous.probabilityMicros
        : null;
      return {
        deltaMicros,
        dispersionMadMicros: median(
          component.sourceProbabilities.map((probability) =>
            Math.abs(probability - component.reportedProbabilityMicros),
          ),
        ),
        name: outcome.name,
        outcomeId: outcome.outcomeId,
        probabilityMicros: outcome.probabilityMicros,
        velocityMicrosPerSecond:
          deltaMicros === null ? null : signedVelocity(deltaMicros, elapsedMs),
      };
    });
  }

  diagnostics.sort((left, right) => {
    const code = left.code.localeCompare(right.code);
    if (code !== 0) return code;
    const bookmaker = left.bookmakerId.localeCompare(right.bookmakerId);
    return bookmaker !== 0 ? bookmaker : left.eventId.localeCompare(right.eventId);
  });
  outcomes.sort((left, right) => left.outcomeId.localeCompare(right.outcomeId));
  const totalBookmakerCount = latest.length;
  const identity = {
    configuration: input.configuration,
    diagnostics,
    formulaVersion: consensusFormulaVersion,
    logicalTimestampMs: input.logicalTimestampMs,
    marketId: input.marketId,
    quoteEventIds: preferred.map(({ eventId }) => eventId).sort(),
    outcomes,
    status: ready ? 'ready' : 'insufficient',
  } satisfies JsonValue;
  return {
    consensusId: `cns_${stableHash(identity).slice(0, 40)}`,
    diagnostics,
    formulaVersion: consensusFormulaVersion,
    freshBookmakerCount: freshVectors.length,
    freshestQuoteAgeMs: freshAges.length > 0 ? Math.min(...freshAges) : null,
    logicalTimestampMs: input.logicalTimestampMs,
    marketId: input.marketId,
    oldestFreshQuoteAgeMs: freshAges.length > 0 ? Math.max(...freshAges) : null,
    outcomes,
    staleBookmakerCount,
    staleBookmakerFractionPpm: ratioRounded(
      staleBookmakerCount,
      totalBookmakerCount,
      probabilityScale,
    ),
    status: ready ? 'ready' : 'insufficient',
    totalBookmakerCount,
    validBookmakerCount: preferred.length,
  };
}

export type BookmakerReactionLatency = Readonly<{
  bookmakerId: string;
  firstReactionEventId: string | null;
  latencyMs: number | null;
}>;

export function measureBookmakerReactionLatencies(
  input: Readonly<{
    baseline: ConsensusSnapshot;
    eventTimestampMs: number;
    quotes: readonly BookmakerQuoteVector[];
    reactionThresholdMicros: number;
  }>,
): readonly BookmakerReactionLatency[] {
  assertSafeNonNegative('eventTimestampMs', input.eventTimestampMs);
  assertSafeNonNegative('reactionThresholdMicros', input.reactionThresholdMicros);
  if (input.baseline.status !== 'ready') {
    throw new Error('Reaction latency requires a ready baseline consensus.');
  }
  const baselineSignature = outcomeSignature(input.baseline.outcomes);
  const byBookmaker = new Map<string, BookmakerQuoteVector[]>();
  for (const quote of input.quotes) {
    if (quote.marketId !== input.baseline.marketId) continue;
    const list = byBookmaker.get(quote.bookmakerId) ?? [];
    list.push(quote);
    byBookmaker.set(quote.bookmakerId, list);
  }
  return [...byBookmaker.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([bookmakerId, quotes]) => {
      const ordered = [...quotes].sort((left, right) => {
        if (left.observedAtMs !== right.observedAtMs)
          return left.observedAtMs - right.observedAtMs;
        return left.eventId.localeCompare(right.eventId);
      });
      for (const quote of ordered) {
        if (quote.observedAtMs < input.eventTimestampMs) continue;
        const normalized = normalizeReportedProbabilityVector(quote);
        if (
          !normalized.ok ||
          outcomeSignature(normalized.vector.normalizedOutcomes) !== baselineSignature
        ) {
          continue;
        }
        const maximumDelta = Math.max(
          ...normalized.vector.normalizedOutcomes.map((outcome) => {
            const baseline = input.baseline.outcomes.find(
              ({ outcomeId }) => outcomeId === outcome.outcomeId,
            )!;
            return Math.abs(outcome.probabilityMicros - baseline.probabilityMicros);
          }),
        );
        if (maximumDelta >= input.reactionThresholdMicros) {
          return {
            bookmakerId,
            firstReactionEventId: quote.eventId,
            latencyMs: quote.observedAtMs - input.eventTimestampMs,
          };
        }
      }
      return { bookmakerId, firstReactionEventId: null, latencyMs: null };
    });
}

export type CoreMarketCandidate = Readonly<{
  consensus: ConsensusSnapshot;
  inRunning: boolean;
  marketId: string;
  marketType: string;
  outcomeCount: number;
  parameters: string | null;
  period: string | null;
}>;

export type CoreMarketSelection = Readonly<{
  eligibleMarketIds: readonly string[];
  selected: CoreMarketCandidate | null;
  selectionVersion: 'covered-market-selection-v1';
}>;

export function selectCoveredCoreMarket(
  input: Readonly<{
    candidates: readonly CoreMarketCandidate[];
    minValidBookmakers: number;
    preferredMarketTypes: readonly string[];
    requireInRunning: boolean;
  }>,
): CoreMarketSelection {
  if (!Number.isSafeInteger(input.minValidBookmakers) || input.minValidBookmakers < 1) {
    throw new Error('minValidBookmakers must be a positive safe integer.');
  }
  if (new Set(input.preferredMarketTypes).size !== input.preferredMarketTypes.length) {
    throw new Error('preferredMarketTypes must not contain duplicates.');
  }
  const preference = new Map(
    input.preferredMarketTypes.map((marketType, index) => [marketType, index]),
  );
  const fallbackRank = input.preferredMarketTypes.length;
  const eligible = input.candidates
    .filter(
      (candidate) =>
        candidate.consensus.status === 'ready' &&
        candidate.consensus.marketId === candidate.marketId &&
        candidate.consensus.validBookmakerCount >= input.minValidBookmakers &&
        candidate.outcomeCount >= 2 &&
        (!input.requireInRunning || candidate.inRunning),
    )
    .sort((left, right) => {
      const preferenceDifference =
        (preference.get(left.marketType) ?? fallbackRank) -
        (preference.get(right.marketType) ?? fallbackRank);
      if (preferenceDifference !== 0) return preferenceDifference;
      if (left.consensus.validBookmakerCount !== right.consensus.validBookmakerCount) {
        return right.consensus.validBookmakerCount - left.consensus.validBookmakerCount;
      }
      if (
        left.consensus.staleBookmakerFractionPpm !==
        right.consensus.staleBookmakerFractionPpm
      ) {
        return (
          left.consensus.staleBookmakerFractionPpm -
          right.consensus.staleBookmakerFractionPpm
        );
      }
      return left.marketId.localeCompare(right.marketId);
    });
  return {
    eligibleMarketIds: eligible.map(({ marketId }) => marketId),
    selected: eligible[0] ?? null,
    selectionVersion: 'covered-market-selection-v1',
  };
}

export class DeterministicMarketFeatureEngine {
  readonly #configuration: ConsensusConfiguration;
  readonly #latestQuotes = new Map<string, Map<string, BookmakerQuoteVector>>();
  readonly #snapshots = new Map<string, ConsensusSnapshot>();
  #logicalTimestampMs = 0;

  constructor(configuration: ConsensusConfiguration) {
    if (configuration.formulaVersion !== consensusFormulaVersion) {
      throw new Error(`Unsupported consensus formula ${configuration.formulaVersion}.`);
    }
    assertSafeNonNegative('staleAfterMs', configuration.staleAfterMs);
    if (
      !Number.isSafeInteger(configuration.minFreshBookmakers) ||
      configuration.minFreshBookmakers < 1
    ) {
      throw new Error('minFreshBookmakers must be a positive safe integer.');
    }
    this.#configuration = Object.freeze({ ...configuration });
  }

  observe(
    event: NormalizedDomainEvent,
    logicalTimestampMs: number,
  ): ConsensusSnapshot | null {
    assertSafeNonNegative('logicalTimestampMs', logicalTimestampMs);
    if (logicalTimestampMs < this.#logicalTimestampMs) {
      throw new Error('Market feature engine logical time cannot move backwards.');
    }
    this.#logicalTimestampMs = logicalTimestampMs;
    if (event.kind !== 'odds.observed') return null;
    const quote = bookmakerQuoteVectorFromEvent(event);
    if (!quote) return null;
    const byBookmaker = this.#latestQuotes.get(quote.marketId) ?? new Map();
    const previousQuote = byBookmaker.get(quote.bookmakerId);
    if (
      previousQuote &&
      (quote.observedAtMs < previousQuote.observedAtMs ||
        (quote.observedAtMs === previousQuote.observedAtMs &&
          quote.eventId.localeCompare(previousQuote.eventId) <= 0))
    ) {
      return this.#snapshots.get(quote.marketId) ?? null;
    }
    byBookmaker.set(quote.bookmakerId, quote);
    this.#latestQuotes.set(quote.marketId, byBookmaker);
    const previous = this.#snapshots.get(quote.marketId);
    const snapshot = createConsensusSnapshot({
      configuration: this.#configuration,
      logicalTimestampMs,
      marketId: quote.marketId,
      ...(previous?.status === 'ready' ? { previous } : {}),
      quotes: [...byBookmaker.values()],
    });
    this.#snapshots.set(quote.marketId, snapshot);
    return snapshot;
  }

  snapshot(marketId: string): ConsensusSnapshot | null {
    return this.#snapshots.get(marketId) ?? null;
  }
}
