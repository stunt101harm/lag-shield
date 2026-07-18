import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

const fixtureId = 'seeded-world-cup-canada-japan';
const marketId = 'replay:browser-demo:mkt-seeded';
const decisionId = 'dec_browser_demo_pause';
const now = Date.UTC(2026, 6, 17, 18, 1);

const decision = {
  action: 'pause',
  decisionId,
  fixtureId,
  logicalTimestampMs: now,
  marketId,
  metrics: {
    maxDispersionMadMicros: 20_000,
    oldestFreshQuoteAgeMs: 5_900,
  },
  nextState: 'PAUSED',
  policyVersion: 'lag-shield-soccer-risk-v1',
  previousState: 'OPEN',
  reasonCodes: ['EVENT_GOAL_UNCONFIRMED', 'QUOTE_REACTION_LAG'],
  triggerEventId: 'evt_possible_goal',
};
const evaluation = {
  dataMode: 'seeded-simulation',
  evaluationHash: 'e'.repeat(64),
  metrics: {
    avoidedPriceErrorProxy: {
      label: 'absolute-probability-distance-proxy-not-pnl',
      meanErrorMicros: 200_000,
    },
    eventToFirstConsensusMoveLatencyMs: 8_000,
    flappingCount: 0,
    normalPlayControl: {
      durationMs: 59_000,
      restrictiveTransitionCount: 0,
    },
    pauseDurationMs: 12_000,
    timeToReopenMs: 18_000,
  },
};

function snapshot(state: 'OPEN' | 'PAUSED') {
  return {
    consensus: {
      diagnostics: [],
      freshBookmakerCount: 1,
      freshestQuoteAgeMs: 100,
      marketId,
      oldestFreshQuoteAgeMs: state === 'PAUSED' ? 5_900 : 100,
      outcomes: [
        {
          deltaMicros: 200_000,
          dispersionMadMicros: 20_000,
          name: 'Canada',
          outcomeId: 'seeded-canada',
          probabilityMicros: 600_000,
          velocityMicrosPerSecond: 66_667,
        },
        {
          deltaMicros: -70_000,
          dispersionMadMicros: 10_000,
          name: 'Draw',
          outcomeId: 'seeded-draw',
          probabilityMicros: 250_000,
          velocityMicrosPerSecond: -23_333,
        },
        {
          deltaMicros: -130_000,
          dispersionMadMicros: 15_000,
          name: 'Japan',
          outcomeId: 'seeded-japan',
          probabilityMicros: 150_000,
          velocityMicrosPerSecond: -43_334,
        },
      ],
      staleBookmakerCount: state === 'PAUSED' ? 1 : 0,
      staleBookmakerFractionPpm: state === 'PAUSED' ? 1_000_000 : 0,
      status: 'ready',
      totalBookmakerCount: 1,
    },
    currentEvent: { kind: 'score.observed', sourceTimestampMs: now },
    dataMode: 'seeded-simulation',
    latestDecision: { ...decision, nextState: state },
    marketState: { state, stateVersion: state === 'PAUSED' ? 2 : 7 },
    progress: state === 'PAUSED' ? 3 : 8,
    run: {
      namespace: 'replay:browser-demo',
      runId: 'browser-demo',
      speed: 2,
      status: state === 'PAUSED' ? 'running' : 'completed',
    },
    totalEvents: 8,
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    status,
  });
}

async function installAgentMock(page: Page) {
  let started = false;
  let recovered = false;
  await page.route('http://localhost:4000/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/v1/realtime') {
      return route.fulfill({
        body: ': mocked stream\n\n',
        contentType: 'text/event-stream',
        headers: { 'Access-Control-Allow-Origin': '*' },
        status: 200,
      });
    }
    if (path === '/metrics/streams') return json(route, { enabled: false });
    if (path === '/v1/evaluations/seeded') return json(route, evaluation);
    if (path === '/v1/fixtures') return json(route, { items: [] });
    if (path === '/v1/replays/active') {
      return started
        ? json(route, snapshot(recovered ? 'OPEN' : 'PAUSED'))
        : json(route, { code: 'NO_ACTIVE_REPLAY' }, 404);
    }
    if (path === '/v1/replays/seeded' && request.method() === 'POST') {
      started = true;
      return json(route, snapshot('PAUSED'), 202);
    }
    if (path === '/v1/decisions') return json(route, { items: [decision] });
    if (path === '/v1/decision-receipts') {
      return json(route, {
        items: [
          {
            canonicalPayload: {
              evidence: [
                {
                  kind: 'score.observed',
                  sourceMessageId: 'score-message-possible-goal',
                  sourceTimestampMs: now,
                },
              ],
            },
            decisionId,
            payloadHash: 'a'.repeat(64),
            receiptId: 'rcpt_browser_demo',
            verification: {
              explorerAccountUrl: null,
              network: null,
              status: 'pending',
              summary: 'Awaiting exact TxLINE validation coordinates.',
            },
          },
        ],
      });
    }
    if (path.endsWith('/timeline')) {
      return json(route, {
        items: [
          { atMs: now, id: decisionId, kind: 'decision', payload: decision },
          {
            atMs: now - 1,
            id: 'evt_possible_goal',
            kind: 'score',
            payload: {
              action: 'possible_goal',
              awayScore: 0,
              confirmed: false,
              homeScore: 1,
            },
          },
        ],
      });
    }
    if (path === '/v1/simulated-orders' && request.method() === 'POST') {
      recovered = true;
      return json(
        route,
        {
          decisionReceipt: { receiptId: 'rcpt_browser_demo' },
          order: {
            admissionReasonCode: 'ORDER_REJECTED_PAUSED',
            explanation: 'Rejected because market control is PAUSED.',
            orderId: 'ord_browser_demo',
            status: 'rejected',
          },
          realMoney: false,
        },
        201,
      );
    }
    return json(route, { items: [] });
  });
}

test.beforeEach(async ({ page }) => {
  await installAgentMock(page);
});

test('runs the judge story without a browser refresh', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('STANDBY');
  await expect(page.getByText('Never real money')).toBeVisible();
  await expect(page.getByText('Measured protection, not a profit claim')).toBeVisible();
  await expect(page.getByText('20.0 pp')).toBeVisible();

  await page.getByRole('button', { name: 'Run winning demo' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('PAUSED');
  await expect(
    page.getByText('The match moved before the market caught up.'),
  ).toBeVisible();
  await expect(page.getByText('possible goal')).toBeVisible();
  await expect(page.getByText('pending').first()).toBeVisible();

  if (process.env.CAPTURE_DOCS_SCREENSHOT === '1') {
    await page.screenshot({
      animations: 'disabled',
      fullPage: true,
      path: '../../docs/assets/command-center-paused.png',
    });
  }

  await page.getByRole('button', { name: 'Test order now' }).click();
  await expect(page.getByText('Exposure blocked')).toBeVisible();
  await expect(page.getByText('order rejected paused')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('OPEN');
  await expect(page.getByText('8 / 8')).toBeVisible();
});

test('has no serious or critical automated accessibility violations', async ({
  page,
}) => {
  await page.goto('/');
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(({ impact }) =>
    ['critical', 'serious'].includes(impact ?? ''),
  );

  expect(blocking).toEqual([]);
});
