import { z } from 'zod';

import { runJudgeApiSmoke } from './judge-api-smoke.js';

const booleanEnvironmentSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');
const urlSchema = z
  .string()
  .url()
  .transform((value) => value.replace(/\/$/u, ''));

export const submissionPreflightEnvironmentSchema = z
  .object({
    LAGSHIELD_API_URL: urlSchema,
    LAGSHIELD_DEMO_VIDEO_URL: urlSchema.optional(),
    LAGSHIELD_PREFLIGHT_SKIP_JUDGE_FLOW: booleanEnvironmentSchema,
    LAGSHIELD_PREFLIGHT_SKIP_LIVE_TXLINE: booleanEnvironmentSchema,
    LAGSHIELD_PREFLIGHT_SKIP_VIDEO: booleanEnvironmentSchema,
    LAGSHIELD_REPOSITORY_URL: urlSchema.default(
      'https://github.com/stunt101harm/lag-shield',
    ),
    LAGSHIELD_WEB_URL: urlSchema,
  })
  .superRefine((environment, context) => {
    if (
      !environment.LAGSHIELD_PREFLIGHT_SKIP_VIDEO &&
      !environment.LAGSHIELD_DEMO_VIDEO_URL
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Required unless LAGSHIELD_PREFLIGHT_SKIP_VIDEO=true.',
        path: ['LAGSHIELD_DEMO_VIDEO_URL'],
      });
    }
  });

export type SubmissionPreflightEnvironment = z.infer<
  typeof submissionPreflightEnvironmentSchema
>;

type Fetch = typeof fetch;

type PreflightCheck = Readonly<{
  name: string;
  status: 'ok';
  url: string;
}>;

const healthSchema = z.object({
  service: z.literal('lagshield-agent'),
  status: z.literal('ok'),
});
const readinessSchema = z.object({
  dependencies: z
    .object({
      credentials: z.enum(['configured', 'disabled']),
      database: z.literal('ready'),
      liveIngestion: z.enum(['configured', 'disabled']),
    })
    .passthrough(),
  status: z.literal('ready'),
});
const streamStateSchema = z.enum([
  'idle',
  'connecting',
  'connected',
  'backoff',
  'stopped',
]);
const streamsSchema = z.object({
  enabled: z.boolean(),
  odds: z.object({ state: streamStateSchema }).optional(),
  scores: z.object({ state: streamStateSchema }).optional(),
});
const proofsSchema = z.object({ enabled: z.boolean() });
const openApiSchema = z.object({ openapi: z.string().startsWith('3.') });
const evaluationSchema = z.object({
  dataMode: z.literal('seeded-simulation'),
  evaluationHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

function requestHeaders(webOrigin: string): Record<string, string> {
  return {
    Accept: 'application/json, text/html;q=0.9',
    Origin: webOrigin,
    'User-Agent': 'LagShield-Submission-Preflight/1.0',
  };
}

async function fetchChecked(
  fetchImplementation: Fetch,
  url: string,
  webOrigin: string,
): Promise<Response> {
  const response = await fetchImplementation(url, {
    headers: requestHeaders(webOrigin),
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${url} returned HTTP ${response.status}.`);
  }
  return response;
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > 2_000_000) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${response.url || 'Response'} exceeded the 2 MB preflight limit.`);
  }
  const text = await response.text();
  if (text.length > 2_000_000) {
    throw new Error(`${response.url || 'Response'} exceeded the 2 MB preflight limit.`);
  }
  return text;
}

async function readJson(
  fetchImplementation: Fetch,
  url: string,
  webOrigin: string,
): Promise<{ body: unknown; response: Response }> {
  const response = await fetchChecked(fetchImplementation, url, webOrigin);
  const text = await readBoundedText(response);
  try {
    return { body: JSON.parse(text) as unknown, response };
  } catch {
    throw new Error(`${url} did not return JSON.`);
  }
}

export async function runSubmissionPreflight(
  environment: SubmissionPreflightEnvironment,
  dependencies: Readonly<{
    fetch?: Fetch;
    judgeFlow?: typeof runJudgeApiSmoke;
  }> = {},
): Promise<
  Readonly<{
    checks: readonly PreflightCheck[];
    judgeFlow: Awaited<ReturnType<typeof runJudgeApiSmoke>> | null;
    ok: true;
  }>
> {
  const fetchImplementation = dependencies.fetch ?? fetch;
  const judgeFlow = dependencies.judgeFlow ?? runJudgeApiSmoke;
  const webOrigin = new URL(environment.LAGSHIELD_WEB_URL).origin;
  const checks: PreflightCheck[] = [];
  const record = (name: string, url: string) => checks.push({ name, status: 'ok', url });

  const webResponse = await fetchChecked(
    fetchImplementation,
    environment.LAGSHIELD_WEB_URL,
    webOrigin,
  );
  if (!(await readBoundedText(webResponse)).includes('LagShield')) {
    throw new Error('Public command center does not identify LagShield.');
  }
  record('public-command-center', environment.LAGSHIELD_WEB_URL);

  const healthUrl = `${environment.LAGSHIELD_API_URL}/health`;
  const health = await readJson(fetchImplementation, healthUrl, webOrigin);
  healthSchema.parse(health.body);
  if (health.response.headers.get('access-control-allow-origin') !== webOrigin) {
    throw new Error(
      `Agent CORS does not allow the exact public web origin ${webOrigin}.`,
    );
  }
  record('agent-health-and-cors', healthUrl);

  const readyUrl = `${environment.LAGSHIELD_API_URL}/ready`;
  const ready = readinessSchema.parse(
    (await readJson(fetchImplementation, readyUrl, webOrigin)).body,
  );
  if (!environment.LAGSHIELD_PREFLIGHT_SKIP_LIVE_TXLINE) {
    if (
      ready.dependencies.credentials !== 'configured' ||
      ready.dependencies.liveIngestion !== 'configured'
    ) {
      throw new Error(
        'Public agent is ready but live TxLINE credentials/ingestion are disabled.',
      );
    }
  }
  record('agent-readiness', readyUrl);

  const streamsUrl = `${environment.LAGSHIELD_API_URL}/metrics/streams`;
  const streams = streamsSchema.parse(
    (await readJson(fetchImplementation, streamsUrl, webOrigin)).body,
  );
  if (!environment.LAGSHIELD_PREFLIGHT_SKIP_LIVE_TXLINE) {
    if (
      !streams.enabled ||
      streams.odds?.state !== 'connected' ||
      streams.scores?.state !== 'connected'
    ) {
      throw new Error(
        `TxLINE supervisors are not both connected (odds=${streams.odds?.state ?? 'missing'}, scores=${streams.scores?.state ?? 'missing'}).`,
      );
    }
  }
  record('txline-stream-supervisors', streamsUrl);

  const proofsUrl = `${environment.LAGSHIELD_API_URL}/metrics/proofs`;
  const proofs = proofsSchema.parse(
    (await readJson(fetchImplementation, proofsUrl, webOrigin)).body,
  );
  if (!environment.LAGSHIELD_PREFLIGHT_SKIP_LIVE_TXLINE && !proofs.enabled) {
    throw new Error('TxLINE/Solana proof worker is disabled.');
  }
  record('proof-worker', proofsUrl);

  const openApiUrl = `${environment.LAGSHIELD_API_URL}/openapi.json`;
  openApiSchema.parse((await readJson(fetchImplementation, openApiUrl, webOrigin)).body);
  record('openapi-contract', openApiUrl);

  const docsUrl = `${environment.LAGSHIELD_API_URL}/docs`;
  const docsResponse = await fetchChecked(fetchImplementation, docsUrl, webOrigin);
  if (!/text\/html/iu.test(docsResponse.headers.get('content-type') ?? '')) {
    await docsResponse.body?.cancel().catch(() => undefined);
    throw new Error('Swagger UI did not return HTML.');
  }
  await docsResponse.body?.cancel().catch(() => undefined);
  record('swagger-ui', docsUrl);

  const evaluationUrl = `${environment.LAGSHIELD_API_URL}/v1/evaluations/seeded`;
  evaluationSchema.parse(
    (await readJson(fetchImplementation, evaluationUrl, webOrigin)).body,
  );
  record('seeded-evaluation', evaluationUrl);

  const repositoryResponse = await fetchChecked(
    fetchImplementation,
    environment.LAGSHIELD_REPOSITORY_URL,
    webOrigin,
  );
  await repositoryResponse.body?.cancel().catch(() => undefined);
  record('public-repository', environment.LAGSHIELD_REPOSITORY_URL);

  if (!environment.LAGSHIELD_PREFLIGHT_SKIP_VIDEO) {
    const videoUrl = environment.LAGSHIELD_DEMO_VIDEO_URL!;
    const videoResponse = await fetchChecked(fetchImplementation, videoUrl, webOrigin);
    await videoResponse.body?.cancel().catch(() => undefined);
    record('public-demo-video', videoUrl);
  }

  const judgeResult = environment.LAGSHIELD_PREFLIGHT_SKIP_JUDGE_FLOW
    ? null
    : await judgeFlow(environment.LAGSHIELD_API_URL);

  return { checks, judgeFlow: judgeResult, ok: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const environment = submissionPreflightEnvironmentSchema.parse(process.env);
  runSubmissionPreflight(environment)
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
