'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type MarketState = 'OPEN' | 'WIDENED' | 'PAUSED' | 'RECOVERY';
type Decision = {
  action: string;
  decisionId: string;
  fixtureId: string;
  logicalTimestampMs: number;
  marketId: string;
  metrics: Record<string, number>;
  nextState: MarketState;
  policyVersion: string;
  previousState: MarketState;
  reasonCodes: string[];
  triggerEventId: string;
};
type Consensus = {
  diagnostics: Array<{ code: string }>;
  freshBookmakerCount: number;
  freshestQuoteAgeMs: number | null;
  marketId: string;
  oldestFreshQuoteAgeMs: number | null;
  outcomes: Array<{
    deltaMicros: number | null;
    dispersionMadMicros: number;
    name: string;
    outcomeId: string;
    probabilityMicros: number;
    velocityMicrosPerSecond: number | null;
  }>;
  staleBookmakerCount: number;
  staleBookmakerFractionPpm: number;
  status: 'insufficient' | 'ready';
  totalBookmakerCount: number;
};
type ReplaySnapshot = {
  consensus: Consensus | null;
  currentEvent: {
    kind: string;
    sourceTimestampMs: number;
  } | null;
  dataMode: 'seeded-simulation';
  latestDecision: Decision | null;
  marketState: { state: MarketState; stateVersion: number } | null;
  progress: number;
  run: {
    namespace: string;
    runId: string;
    speed: number | 'maximum';
    status: 'pending' | 'running' | 'paused' | 'completed' | 'stopped' | 'failed';
  };
  totalEvents: number;
};
type TimelineItem = {
  atMs: number;
  id: string;
  kind: 'decision' | 'score';
  payload: Decision & {
    action?: string;
    awayScore?: number | null;
    confirmed?: boolean | null;
    homeScore?: number | null;
  };
};
type Receipt = {
  canonicalPayload?: {
    evidence: Array<{
      kind: string;
      sourceMessageId: string;
      sourceTimestampMs: number | null;
    }>;
  };
  decisionId: string;
  payloadHash: string;
  receiptId: string;
  status?: string;
  verification?: {
    explorerAccountUrl: string | null;
    network: string | null;
    status: 'pending' | 'verified' | 'rejected' | 'unavailable' | 'error';
    summary: string;
  };
};
type OrderResult = {
  decisionReceipt: { receiptId: string };
  order: {
    admissionReasonCode: string;
    explanation: string;
    orderId: string;
    status: string;
  };
  realMoney: false;
};
type StreamMetrics = {
  enabled: boolean;
  odds?: { state: string; streamLagMs: number | null };
  scores?: { state: string; streamLagMs: number | null };
};
type EvaluationReport = {
  dataMode: 'seeded-simulation' | 'txline-historical';
  evaluationHash: string;
  metrics: {
    avoidedPriceErrorProxy: {
      label: 'absolute-probability-distance-proxy-not-pnl';
      meanErrorMicros: number | null;
    };
    eventToFirstConsensusMoveLatencyMs: number | null;
    flappingCount: number;
    normalPlayControl: {
      durationMs: number | null;
      restrictiveTransitionCount: number;
    };
    pauseDurationMs: number | null;
    timeToReopenMs: number | null;
  };
};

const agentUrl = (
  process.env.NEXT_PUBLIC_LAGSHIELD_API_URL ?? 'http://localhost:4000'
).replace(/\/$/, '');

const stateCopy: Record<MarketState, { eyebrow: string; narrative: string }> = {
  OPEN: {
    eyebrow: 'Quoting permitted',
    narrative: 'Prices are fresh, the market is synchronized, and paper orders may pass.',
  },
  WIDENED: {
    eyebrow: 'Requote required',
    narrative: 'Risk is elevated. New orders wait for a wider, freshly observed quote.',
  },
  PAUSED: {
    eyebrow: 'Protection engaged',
    narrative:
      'The match moved before the market caught up. LagShield blocked stale exposure.',
  },
  RECOVERY: {
    eyebrow: 'Proving stability',
    narrative:
      'Quotes are converging, but the market stays protected until recovery holds.',
  },
};

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${agentUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok) {
    throw new Error(body.message ?? `${path} returned ${response.status}`);
  }
  return body;
}

async function optionalJson<T>(path: string): Promise<T | null> {
  const response = await fetch(`${agentUrl}${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404) return null;
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok)
    throw new Error(body.message ?? `${path} returned ${response.status}`);
  return body;
}

function percent(micros: number): string {
  return `${(micros / 10_000).toFixed(1)}%`;
}

function duration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || milliseconds < 0) return '—';
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

function compactReason(reason: string): string {
  return reason
    .replace(/^EVENT_/, '')
    .replace(/^COVERAGE_/, '')
    .replaceAll('_', ' ')
    .toLowerCase();
}

function proofState(receipt: Receipt | undefined): string {
  return receipt?.verification?.status ?? receipt?.status ?? 'pending';
}

export default function HomePage() {
  const [snapshot, setSnapshot] = useState<ReplaySnapshot | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [fixtures, setFixtures] = useState<Array<{ fixtureId: string }>>([]);
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<'connecting' | 'live' | 'offline'>(
    'connecting',
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [speed, setSpeed] = useState('2');
  const [orderResult, setOrderResult] = useState<OrderResult | null>(null);
  const [streams, setStreams] = useState<StreamMetrics>({ enabled: false });
  const [evaluation, setEvaluation] = useState<EvaluationReport | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextSnapshot, fixtureResponse, streamResponse, evaluationResponse] =
        await Promise.all([
          optionalJson<ReplaySnapshot>('/v1/replays/active'),
          readJson<{ items: Array<{ fixtureId: string }> }>('/v1/fixtures?limit=20'),
          readJson<StreamMetrics>('/metrics/streams'),
          readJson<EvaluationReport>('/v1/evaluations/seeded'),
        ]);
      setSnapshot(nextSnapshot);
      setFixtures(fixtureResponse.items);
      setStreams(streamResponse);
      setEvaluation(evaluationResponse);
      const fixtureId =
        nextSnapshot?.latestDecision?.fixtureId ?? fixtureResponse.items[0]?.fixtureId;
      if (fixtureId) {
        const [decisionResponse, receiptResponse, timelineResponse] = await Promise.all([
          readJson<{ items: Decision[] }>(
            `/v1/decisions?fixtureId=${encodeURIComponent(fixtureId)}&limit=50`,
          ),
          readJson<{ items: Receipt[] }>(
            `/v1/decision-receipts?fixtureId=${encodeURIComponent(fixtureId)}&limit=50`,
          ),
          readJson<{ items: TimelineItem[] }>(
            `/v1/fixtures/${encodeURIComponent(fixtureId)}/timeline?limit=100`,
          ),
        ]);
        setDecisions(decisionResponse.items);
        setReceipts(receiptResponse.items);
        setTimeline(timelineResponse.items);
        setSelectedDecisionId((current) =>
          decisionResponse.items.some(({ decisionId }) => decisionId === current)
            ? current
            : (decisionResponse.items[0]?.decisionId ?? null),
        );
      } else {
        setDecisions([]);
        setReceipts([]);
        setTimeline([]);
      }
      setError(null);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : 'The command center could not reach the agent.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const source = new EventSource(`${agentUrl}/v1/realtime`);
    const topics = [
      'decision.committed',
      'domain-event.committed',
      'order.committed',
      'proof.updated',
      'replay.progress',
      'replay.status',
      'system.resync-required',
    ];
    let refreshTimer: number | undefined;
    const onUpdate = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void refresh(), 80);
    };
    source.onopen = () => setStreamState('live');
    source.onerror = () => setStreamState('offline');
    for (const topic of topics) source.addEventListener(topic, onUpdate);
    const fallback = window.setInterval(() => void refresh(), 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(fallback);
      window.clearTimeout(refreshTimer);
      for (const topic of topics) source.removeEventListener(topic, onUpdate);
      source.close();
    };
  }, [refresh]);

  const state = snapshot?.marketState?.state ?? null;
  const decision =
    decisions.find(({ decisionId }) => decisionId === selectedDecisionId) ??
    snapshot?.latestDecision ??
    null;
  const receipt = receipts.find(({ decisionId }) => decisionId === decision?.decisionId);
  const consensus = snapshot?.consensus;
  const latestScore = timeline.find(({ kind }) => kind === 'score');
  const outcomes = consensus?.outcomes ?? [];
  const home = outcomes[0]?.name ?? 'Canada';
  const away = outcomes.at(-1)?.name ?? 'Japan';
  const homeScore = latestScore?.payload.homeScore ?? 0;
  const awayScore = latestScore?.payload.awayScore ?? 0;
  const stateDetails = state ? stateCopy[state] : null;
  const progress = snapshot
    ? Math.round((snapshot.progress / snapshot.totalEvents) * 100)
    : 0;
  const eventClock = snapshot?.currentEvent
    ? new Date(snapshot.currentEvent.sourceTimestampMs).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : null;
  const maxDispersion = useMemo(
    () =>
      Math.max(
        0,
        ...(consensus?.outcomes.map(({ dispersionMadMicros }) => dispersionMadMicros) ??
          []),
      ),
    [consensus],
  );
  const maxVelocity = useMemo(
    () =>
      Math.max(
        0,
        ...(consensus?.outcomes.map(({ velocityMicrosPerSecond }) =>
          Math.abs(velocityMicrosPerSecond ?? 0),
        ) ?? []),
      ),
    [consensus],
  );

  const runAction = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await action();
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Agent action failed.');
    } finally {
      setBusy(null);
    }
  };

  const startReplay = () =>
    runAction('start', () =>
      readJson('/v1/replays/seeded', {
        body: JSON.stringify({
          runId: `demo-${Date.now()}`,
          speed: speed === 'maximum' ? 'maximum' : Number(speed),
        }),
        method: 'POST',
      }),
    );

  const controlReplay = (action: 'pause' | 'resume' | 'stop') => {
    if (!snapshot) return Promise.resolve();
    return runAction(action, () =>
      readJson(`/v1/replays/${encodeURIComponent(snapshot.run.runId)}/actions`, {
        body: JSON.stringify({ action }),
        method: 'POST',
      }),
    );
  };

  const submitOrder = () => {
    if (!snapshot?.latestDecision || !snapshot.marketState) return Promise.resolve();
    const requestedAtMs = Date.now();
    return runAction('order', async () => {
      const result = await readJson<OrderResult>('/v1/simulated-orders', {
        body: JSON.stringify({
          expectedDecisionId: snapshot.latestDecision!.decisionId,
          expectedStateVersion: snapshot.marketState!.stateVersion,
          fixtureId: snapshot.latestDecision!.fixtureId,
          idempotencyKey: `${snapshot.run.runId}:ui:${requestedAtMs}`,
          marketId: snapshot.latestDecision!.marketId,
          namespace: snapshot.run.namespace,
          outcomeId: outcomes[0]?.outcomeId ?? 'seeded-canada',
          payloadVersion: 1,
          price: 2_100,
          quoteObservedAtMs: requestedAtMs,
          requestedAtMs,
          side: 'back',
          stakeMicros: 1_000_000,
        }),
        method: 'POST',
      });
      setOrderResult(result);
      return result;
    });
  };

  return (
    <main className="command-center">
      <header className="topbar">
        <a className="brand" href="#command-center" aria-label="LagShield command center">
          <span className="brand-mark" aria-hidden="true">
            L
          </span>
          <span>
            <strong>LagShield</strong>
            <small>Autonomous market protection</small>
          </span>
        </a>
        <div className="system-status" aria-label="System status">
          <span className="mode-badge">{snapshot ? 'Seeded replay' : 'Live watch'}</span>
          <span className={`stream-badge ${streamState}`}>
            <i aria-hidden="true" />
            {streamState === 'live' ? 'Realtime connected' : streamState}
          </span>
          <a href={`${agentUrl}/docs`} target="_blank" rel="noreferrer">
            API docs ↗
          </a>
        </div>
      </header>

      {error ? (
        <div className="error-banner" role="alert">
          <strong>Agent connection needs attention.</strong>
          <span>{error}</span>
          <button type="button" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : null}

      <div id="command-center" className="hero-grid">
        <section
          className={`state-panel ${state ? `state-${state.toLowerCase()}` : 'state-standby'}`}
        >
          <div className="state-heading">
            <div>
              <p className="overline">
                Market control · {stateDetails?.eyebrow ?? 'Awaiting input'}
              </p>
              <h1>{loading ? 'SYNCING' : (state ?? 'STANDBY')}</h1>
            </div>
            <div className="autonomy-seal" aria-label="Autonomous agent is active">
              <span aria-hidden="true">A</span>
              Autonomous
            </div>
          </div>
          <p className="state-narrative">
            {stateDetails?.narrative ??
              'No live match is active. Run the seeded scenario to see LagShield protect a market in real time.'}
          </p>

          <div
            className="match-strip"
            aria-label={`${home} ${homeScore}, ${away} ${awayScore}`}
          >
            <div className="team home-team">
              <span>CAN</span>
              <strong>{home}</strong>
            </div>
            <div className="scoreboard">
              <span>{homeScore}</span>
              <b>–</b>
              <span>{awayScore}</span>
              <small>
                {snapshot ? `${eventClock ?? 'IN PLAY'} · WORLD CUP` : 'NO LIVE MATCH'}
              </small>
            </div>
            <div className="team away-team">
              <span>JPN</span>
              <strong>{away}</strong>
            </div>
          </div>

          <div className="state-rail" aria-label="Circuit breaker progression">
            {(['OPEN', 'WIDENED', 'PAUSED', 'RECOVERY'] as const).map((item, index) => (
              <div key={item} className={state === item ? 'active' : ''}>
                <span>{index + 1}</span>
                <b>{item}</b>
                <small>
                  {item === 'OPEN'
                    ? 'admit'
                    : item === 'WIDENED'
                      ? 'requote'
                      : item === 'PAUSED'
                        ? 'block'
                        : 'observe'}
                </small>
              </div>
            ))}
          </div>
        </section>

        <aside className="demo-panel" aria-labelledby="demo-title">
          <div className="panel-heading">
            <div>
              <p className="overline">Judge control</p>
              <h2 id="demo-title">Winning scenario</h2>
            </div>
            <span className="simulation-label">SIMULATION</span>
          </div>
          <p className="panel-copy">
            A possible goal lands before the consensus price reacts. Watch LagShield
            pause, reject stale exposure, and reopen only after three stable updates.
          </p>
          <label className="speed-control">
            Replay speed
            <select
              value={speed}
              onChange={(event) => setSpeed(event.target.value)}
              disabled={busy !== null}
            >
              <option value="1">1× cinematic</option>
              <option value="2">2× demo</option>
              <option value="4">4× fast</option>
              <option value="10">10× smoke</option>
              <option value="maximum">Maximum</option>
            </select>
          </label>
          <button
            className="primary-action"
            type="button"
            onClick={() => void startReplay()}
            disabled={busy !== null}
          >
            <span aria-hidden="true">▶</span>
            {busy === 'start'
              ? 'Starting agent…'
              : snapshot
                ? 'Run scenario again'
                : 'Run winning demo'}
          </button>
          <div className="replay-progress">
            <div>
              <span>Replay progress</span>
              <strong>
                {snapshot ? `${snapshot.progress} / ${snapshot.totalEvents}` : 'Ready'}
              </strong>
            </div>
            <progress max="100" value={progress}>
              {progress}%
            </progress>
          </div>
          <div className="transport-controls" aria-label="Replay transport controls">
            <button
              type="button"
              disabled={!snapshot || snapshot.run.status !== 'running' || busy !== null}
              onClick={() => void controlReplay('pause')}
            >
              Ⅱ Pause
            </button>
            <button
              type="button"
              disabled={!snapshot || snapshot.run.status !== 'paused' || busy !== null}
              onClick={() => void controlReplay('resume')}
            >
              ▶ Resume
            </button>
            <button
              type="button"
              disabled={
                !snapshot ||
                !['running', 'paused'].includes(snapshot.run.status) ||
                busy !== null
              }
              onClick={() => void controlReplay('stop')}
            >
              ■ Stop
            </button>
          </div>
          <div className="order-test">
            <div>
              <strong>Paper-order gate</strong>
              <span>Never real money</span>
            </div>
            <button
              type="button"
              onClick={() => void submitOrder()}
              disabled={!snapshot?.latestDecision || busy !== null}
            >
              {busy === 'order' ? 'Evaluating…' : 'Test order now'}
            </button>
          </div>
          {orderResult ? (
            <div className={`order-result ${orderResult.order.status}`} role="status">
              <strong>
                {orderResult.order.status === 'rejected'
                  ? 'Exposure blocked'
                  : 'Order evaluated'}
              </strong>
              <span>{compactReason(orderResult.order.admissionReasonCode)}</span>
            </div>
          ) : null}
        </aside>
      </div>

      <section className="signal-grid" aria-label="Market risk signals">
        <article>
          <p>Quote freshness</p>
          <strong>{duration(consensus?.oldestFreshQuoteAgeMs)}</strong>
          <span>
            {consensus?.status === 'ready' ? 'within policy' : 'awaiting quotes'}
          </span>
        </article>
        <article>
          <p>Reaction latency</p>
          <strong>{duration(decision?.metrics.maxReactionLatencyMs)}</strong>
          <span>{percent(maxVelocity)} probability / second</span>
        </article>
        <article>
          <p>Bookmaker dispersion</p>
          <strong>{percent(maxDispersion)}</strong>
          <span>median absolute deviation</span>
        </article>
        <article>
          <p>Coverage</p>
          <strong>
            {consensus
              ? `${consensus.freshBookmakerCount}/${consensus.totalBookmakerCount}`
              : '—'}
          </strong>
          <span>{consensus?.staleBookmakerCount ?? 0} stale books</span>
        </article>
        <article className="proof-metric">
          <p>TxLINE proof</p>
          <strong className={`proof-${proofState(receipt)}`}>
            {proofState(receipt)}
          </strong>
          <span>{receipt?.verification?.network ?? 'not yet verified'}</span>
        </article>
        <article>
          <p>TxLINE streams</p>
          <strong>
            {streams.enabled
              ? `${streams.odds?.state ?? '—'} / ${streams.scores?.state ?? '—'}`
              : 'Replay mode'}
          </strong>
          <span>
            {streams.enabled
              ? `odds ${duration(streams.odds?.streamLagMs)} · scores ${duration(streams.scores?.streamLagMs)}`
              : 'live feed explicitly disabled'}
          </span>
        </article>
      </section>

      {evaluation ? (
        <section className="evaluation-proof" aria-labelledby="evaluation-title">
          <div className="evaluation-story">
            <p className="overline">Replay evidence · hash-addressed</p>
            <h2 id="evaluation-title">Measured protection, not a profit claim</h2>
            <p>
              The score signal arrived{' '}
              <strong>
                {duration(evaluation.metrics.eventToFirstConsensusMoveLatencyMs)}
              </strong>{' '}
              before the first material consensus move. LagShield was already paused.
            </p>
            <span>
              {evaluation.dataMode.replace('-', ' ')} · evaluation{' '}
              <code>{evaluation.evaluationHash.slice(0, 12)}</code>
            </span>
          </div>
          <div className="evaluation-stat">
            <span>Observed lag window</span>
            <strong>
              {duration(evaluation.metrics.eventToFirstConsensusMoveLatencyMs)}
            </strong>
            <small>signal → material move</small>
          </div>
          <div className="evaluation-stat">
            <span>Probability-distance proxy</span>
            <strong>
              {evaluation.metrics.avoidedPriceErrorProxy.meanErrorMicros === null
                ? '—'
                : `${(
                    evaluation.metrics.avoidedPriceErrorProxy.meanErrorMicros / 10_000
                  ).toFixed(1)} pp`}
            </strong>
            <small>absolute distance · not P&amp;L</small>
          </div>
          <div className="evaluation-stat">
            <span>Control / recovery</span>
            <strong>{evaluation.metrics.flappingCount} flaps</strong>
            <small>
              {evaluation.metrics.normalPlayControl.restrictiveTransitionCount} control
              pauses · reopen {duration(evaluation.metrics.timeToReopenMs)}
            </small>
          </div>
        </section>
      ) : null}

      <div className="workspace-grid">
        <section className="consensus-panel" aria-labelledby="consensus-title">
          <div className="panel-heading">
            <div>
              <p className="overline">Normalized market</p>
              <h2 id="consensus-title">Consensus probabilities</h2>
            </div>
            <span className={`quality-badge ${consensus?.status ?? 'insufficient'}`}>
              {consensus?.status ?? 'no data'}
            </span>
          </div>
          {outcomes.length ? (
            <div className="probability-list">
              {outcomes.map((outcome) => (
                <div className="probability-row" key={outcome.outcomeId}>
                  <div>
                    <strong>{outcome.name}</strong>
                    <span>
                      {outcome.velocityMicrosPerSecond === null
                        ? 'baseline'
                        : `${outcome.velocityMicrosPerSecond > 0 ? '+' : ''}${percent(outcome.velocityMicrosPerSecond)}/s`}
                    </span>
                  </div>
                  <div className="probability-track">
                    <i style={{ width: `${outcome.probabilityMicros / 10_000}%` }} />
                  </div>
                  <b>{percent(outcome.probabilityMicros)}</b>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <span aria-hidden="true">≈</span>
              <strong>No active consensus</strong>
              <p>
                The seeded replay supplies deterministic TxLINE-shaped odds even when no
                World Cup match is live.
              </p>
            </div>
          )}
          <div className="consensus-footnotes">
            <span>
              Formula <b>proportional median v1</b>
            </span>
            <span>
              Diagnostics <b>{consensus?.diagnostics.length ?? 0}</b>
            </span>
            <span>
              Source <b>TxLINE</b>
            </span>
          </div>
          <div className="bookmaker-strip">
            <span>
              <i aria-hidden="true" /> Bookmaker vector
            </span>
            <strong>TxODDS Consensus</strong>
            <b>{consensus?.status === 'ready' ? 'fresh' : 'waiting'}</b>
          </div>
        </section>

        <section className="timeline-panel" aria-labelledby="timeline-title">
          <div className="panel-heading">
            <div>
              <p className="overline">Explainable autonomy</p>
              <h2 id="timeline-title">Match → decision timeline</h2>
            </div>
          </div>
          <div className="timeline-list">
            {timeline.length ? (
              timeline.slice(0, 8).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={
                    item.kind === 'decision' && selectedDecisionId === item.id
                      ? 'selected'
                      : ''
                  }
                  onClick={() =>
                    item.kind === 'decision' && setSelectedDecisionId(item.id)
                  }
                >
                  <time>
                    {new Date(item.atMs).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </time>
                  <i className={item.kind} aria-hidden="true" />
                  <span>
                    <strong>
                      {item.kind === 'score'
                        ? `Score event · ${item.payload.action ?? 'update'}`
                        : `${item.payload.previousState} → ${item.payload.nextState}`}
                    </strong>
                    <small>
                      {item.kind === 'score'
                        ? `${item.payload.confirmed ? 'confirmed' : 'unconfirmed'} TxLINE event`
                        : item.payload.reasonCodes?.map(compactReason).join(' · ')}
                    </small>
                  </span>
                </button>
              ))
            ) : (
              <div className="empty-state compact">
                <strong>Timeline waiting</strong>
                <p>Start the scenario to reveal every input and autonomous decision.</p>
              </div>
            )}
          </div>
        </section>

        <aside className="receipt-panel" aria-labelledby="receipt-title">
          <div className="panel-heading">
            <div>
              <p className="overline">Decision evidence</p>
              <h2 id="receipt-title">Why LagShield acted</h2>
            </div>
            <span className={`proof-chip proof-${proofState(receipt)}`}>
              {proofState(receipt)}
            </span>
          </div>
          {decision ? (
            <>
              <div className="decision-transition">
                <span>{decision.previousState}</span>
                <b>→</b>
                <strong>{decision.nextState}</strong>
              </div>
              <div className="reason-list">
                {decision.reasonCodes.map((reason) => (
                  <span key={reason}>{compactReason(reason)}</span>
                ))}
              </div>
              <dl className="decision-facts">
                <div>
                  <dt>Policy</dt>
                  <dd>{decision.policyVersion}</dd>
                </div>
                <div>
                  <dt>State version</dt>
                  <dd>
                    {snapshot?.marketState?.stateVersion ?? decision.logicalTimestampMs}
                  </dd>
                </div>
                <div>
                  <dt>Source message</dt>
                  <dd>
                    {receipt?.canonicalPayload?.evidence[0]?.sourceMessageId ??
                      decision.triggerEventId}
                  </dd>
                </div>
                <div>
                  <dt>Receipt hash</dt>
                  <dd className="hash">
                    {receipt?.payloadHash ?? 'pending receipt load'}
                  </dd>
                </div>
              </dl>
              <div className="proof-callout">
                <strong>
                  {proofState(receipt) === 'verified'
                    ? 'Cryptographically verified'
                    : 'Proof claim is not yet verified'}
                </strong>
                <p>
                  {receipt?.verification?.summary ??
                    'LagShield keeps pending, unavailable, and failed proof states visually distinct from verified evidence.'}
                </p>
                {receipt?.verification?.explorerAccountUrl ? (
                  <a
                    href={receipt.verification.explorerAccountUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Inspect Solana account ↗
                  </a>
                ) : null}
              </div>
            </>
          ) : (
            <div className="empty-state compact">
              <strong>No decision selected</strong>
              <p>
                The first replay odds update will produce a deterministic OPEN decision
                and receipt.
              </p>
            </div>
          )}
        </aside>
      </div>

      <footer>
        <span>LagShield · TxLINE World Cup data · Solana-anchored provenance</span>
        <span>
          {fixtures.length} live fixture record{fixtures.length === 1 ? '' : 's'} ·{' '}
          {decisions.length} decisions
        </span>
      </footer>
    </main>
  );
}
