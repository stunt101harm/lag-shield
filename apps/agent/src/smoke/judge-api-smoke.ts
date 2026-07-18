import { z } from 'zod';

const replaySnapshotSchema = z.object({
  latestDecision: z
    .object({
      decisionId: z.string(),
      fixtureId: z.string(),
      marketId: z.string(),
    })
    .nullable(),
  marketState: z
    .object({
      state: z.enum(['OPEN', 'WIDENED', 'PAUSED', 'RECOVERY']),
      stateVersion: z.number().int().nonnegative(),
    })
    .nullable(),
  progress: z.number().int().nonnegative(),
  run: z.object({
    namespace: z.string(),
    runId: z.string(),
    status: z.enum(['pending', 'running', 'paused', 'completed', 'stopped', 'failed']),
  }),
  totalEvents: z.number().int().positive(),
});

const orderResponseSchema = z.object({
  decisionReceipt: z.object({ receiptId: z.string() }),
  order: z.object({
    admissionReasonCode: z.string(),
    orderId: z.string(),
    status: z.enum(['accepted', 'rejected', 'stale', 'settled', 'cancelled']),
  }),
  realMoney: z.literal(false),
});

async function requestJson(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(
      `${init.method ?? 'GET'} ${path} returned ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function waitForSnapshot(
  baseUrl: string,
  predicate: (snapshot: z.infer<typeof replaySnapshotSchema>) => boolean,
  timeoutMs: number,
): Promise<z.infer<typeof replaySnapshotSchema>> {
  const deadline = Date.now() + timeoutMs;
  let last: z.infer<typeof replaySnapshotSchema> | null = null;
  while (Date.now() < deadline) {
    last = replaySnapshotSchema.parse(await requestJson(baseUrl, '/v1/replays/active'));
    if (predicate(last)) return last;
    if (['completed', 'failed', 'stopped'].includes(last.run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for replay state; last snapshot: ${JSON.stringify(last)}`,
  );
}

async function stopActiveReplay(baseUrl: string): Promise<void> {
  const path = '/v1/replays/active';
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await response.json()) as unknown;
  if (response.status === 404) return;
  if (!response.ok) {
    throw new Error(`GET ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  const active = replaySnapshotSchema.parse(body);
  if (['running', 'paused'].includes(active.run.status)) {
    await requestJson(
      baseUrl,
      `/v1/replays/${encodeURIComponent(active.run.runId)}/actions`,
      {
        body: JSON.stringify({ action: 'stop' }),
        method: 'POST',
      },
    );
  } else if (active.run.status === 'pending') {
    throw new Error(
      `Active replay ${active.run.runId} is still pending; retry preflight.`,
    );
  }
}

export async function runJudgeApiSmoke(
  baseUrl = process.env.LAGSHIELD_API_URL ?? 'http://127.0.0.1:4000',
): Promise<
  Readonly<{
    finalState: 'OPEN';
    orderId: string;
    orderStatus: 'rejected';
    progress: number;
    receiptId: string;
    runId: string;
  }>
> {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  await requestJson(normalizedBaseUrl, '/health');
  await requestJson(normalizedBaseUrl, '/ready');
  await stopActiveReplay(normalizedBaseUrl);

  const runId = `judge-smoke-${Date.now()}`;
  await requestJson(normalizedBaseUrl, '/v1/replays/seeded', {
    body: JSON.stringify({ runId, speed: 10 }),
    method: 'POST',
  });
  const paused = await waitForSnapshot(
    normalizedBaseUrl,
    (snapshot) => snapshot.marketState?.state === 'PAUSED',
    15_000,
  );
  if (!paused.latestDecision || !paused.marketState) {
    throw new Error('PAUSED replay snapshot is missing its committed decision state.');
  }

  const requestedAtMs = Date.now();
  const order = orderResponseSchema.parse(
    await requestJson(normalizedBaseUrl, '/v1/simulated-orders', {
      body: JSON.stringify({
        expectedDecisionId: paused.latestDecision.decisionId,
        expectedStateVersion: paused.marketState.stateVersion,
        fixtureId: paused.latestDecision.fixtureId,
        idempotencyKey: `${runId}:paused-order`,
        marketId: paused.latestDecision.marketId,
        namespace: paused.run.namespace,
        outcomeId: 'seeded-canada',
        payloadVersion: 1,
        price: 2_100,
        quoteObservedAtMs: requestedAtMs,
        requestedAtMs,
        side: 'back',
        stakeMicros: 1_000_000,
      }),
      method: 'POST',
    }),
  );
  if (
    order.order.status !== 'rejected' ||
    order.order.admissionReasonCode !== 'ORDER_REJECTED_PAUSED'
  ) {
    throw new Error(
      `Circuit breaker did not reject the PAUSED order: ${JSON.stringify(order)}`,
    );
  }

  const completed = await waitForSnapshot(
    normalizedBaseUrl,
    (snapshot) =>
      snapshot.run.status === 'completed' && snapshot.marketState?.state === 'OPEN',
    15_000,
  );
  await requestJson(
    normalizedBaseUrl,
    `/v1/decision-receipts/${encodeURIComponent(order.decisionReceipt.receiptId)}`,
  );
  const orders = z
    .object({ items: z.array(z.object({ orderId: z.string() })) })
    .parse(
      await requestJson(
        normalizedBaseUrl,
        `/v1/simulated-orders?namespace=${encodeURIComponent(completed.run.namespace)}`,
      ),
    );
  if (!orders.items.some(({ orderId }) => orderId === order.order.orderId)) {
    throw new Error('Rejected order is missing from the persisted judge read model.');
  }
  if (completed.progress !== completed.totalEvents) {
    throw new Error('Completed replay progress does not match the seeded manifest.');
  }

  return {
    finalState: 'OPEN',
    orderId: order.order.orderId,
    orderStatus: 'rejected',
    progress: completed.progress,
    receiptId: order.decisionReceipt.receiptId,
    runId,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runJudgeApiSmoke()
    .then((result) =>
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`),
    )
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
