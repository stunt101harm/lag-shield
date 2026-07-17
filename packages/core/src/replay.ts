import { z } from 'zod';

import { compareEventOrder, type NormalizedDomainEvent } from './events.js';
import { stableHash, type JsonValue } from './json.js';
import { replayRunSchema, type ReplayRun } from './models.js';
import type { ReplaySpeed } from './replay-clock.js';

const identifierSchema = z.string().min(1).max(512);
const timestampSchema = z.number().int().nonnegative().safe();

const replayIntervalSchema = z
  .object({
    endMs: timestampSchema,
    epochDay: z.number().int().nonnegative(),
    hourOfDay: z.number().int().min(0).max(23),
    interval: z.number().int().min(0).max(11),
    startMs: timestampSchema,
  })
  .strict();

const replayManifestObjectSchema = z
  .object({
    configuration: z
      .object({
        normalizerVersion: z.string().min(1).max(100),
        orderingVersion: z.string().min(1).max(100),
        strategy: z.json(),
        strategyHash: z.string().regex(/^[a-f0-9]{64}$/),
        strategyVersion: z.string().min(1).max(100),
      })
      .strict(),
    eventCount: z.number().int().nonnegative(),
    eventSequenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    fixture: z
      .object({
        competitionId: identifierSchema,
        fixtureId: identifierSchema,
        scheduledAtMs: timestampSchema,
      })
      .strict(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    manifestId: identifierSchema,
    manifestVersion: z.literal(1),
    source: z
      .object({
        dataMode: z.enum(['txline-historical', 'seeded-simulation']),
        endMs: timestampSchema,
        oddsIntervals: z.array(replayIntervalSchema).max(10_000),
        scorePath: z.string().min(1).max(1_000).nullable(),
        startMs: timestampSchema,
      })
      .strict(),
  })
  .strict();

export type ReplayManifest = z.infer<typeof replayManifestObjectSchema>;

type ReplayManifestIdentity = Omit<ReplayManifest, 'manifestId'>;

function manifestId(identity: ReplayManifestIdentity): string {
  return `rplm_${stableHash(identity as JsonValue).slice(0, 40)}`;
}

export const replayManifestSchema = replayManifestObjectSchema.superRefine(
  (manifest, context) => {
    const { manifestId: candidate, ...identity } = manifest;
    if (candidate !== manifestId(identity)) {
      context.addIssue({
        code: 'custom',
        message: 'Replay manifest identity is not canonical.',
      });
    }
    if (manifest.source.endMs < manifest.source.startMs) {
      context.addIssue({
        code: 'custom',
        message: 'Replay source end must not be before its start.',
        path: ['source', 'endMs'],
      });
    }
  },
);

function eventFact(event: NormalizedDomainEvent): JsonValue {
  return {
    eventId: event.eventId,
    fixtureId: event.fixtureId,
    idempotencyKey: event.idempotencyKey,
    kind: event.kind,
    payload: event.payload as JsonValue,
    payloadVersion: event.payloadVersion,
    sequence: event.sequence,
    source: event.source,
    sourceId: event.sourceId,
    sourcePriority: event.sourcePriority,
    sourceTimestampMs: event.sourceTimestampMs,
  };
}

export function replayInputHash(events: readonly NormalizedDomainEvent[]): string {
  return stableHash([...events].sort(compareEventOrder).map(eventFact));
}

export function replayEventSequenceHash(
  events: readonly NormalizedDomainEvent[],
): string {
  return stableHash([...events].sort(compareEventOrder).map(({ eventId }) => eventId));
}

export function createReplayManifest(
  input: Readonly<{
    events: readonly NormalizedDomainEvent[];
    dataMode?: ReplayManifest['source']['dataMode'];
    fixture: ReplayManifest['fixture'];
    normalizerVersion: string;
    oddsIntervals: ReplayManifest['source']['oddsIntervals'];
    orderingVersion: string;
    sourceEndMs: number;
    sourceStartMs: number;
    strategyConfiguration: JsonValue;
    strategyVersion: string;
  }>,
): ReplayManifest {
  const events = [...input.events].sort(compareEventOrder);
  const strategyHash = stableHash(input.strategyConfiguration);
  const identity: ReplayManifestIdentity = {
    configuration: {
      normalizerVersion: input.normalizerVersion,
      orderingVersion: input.orderingVersion,
      strategy: input.strategyConfiguration,
      strategyHash,
      strategyVersion: input.strategyVersion,
    },
    eventCount: events.length,
    eventSequenceHash: replayEventSequenceHash(events),
    fixture: input.fixture,
    inputHash: replayInputHash(events),
    manifestVersion: 1,
    source: {
      dataMode: input.dataMode ?? 'txline-historical',
      endMs: input.sourceEndMs,
      oddsIntervals: input.oddsIntervals,
      scorePath:
        (input.dataMode ?? 'txline-historical') === 'txline-historical'
          ? `/api/scores/historical/${input.fixture.fixtureId}`
          : null,
      startMs: input.sourceStartMs,
    },
  };
  return replayManifestSchema.parse({ ...identity, manifestId: manifestId(identity) });
}

export type ExecutionContext =
  | Readonly<{ mode: 'live'; namespace: 'live' }>
  | Readonly<{ mode: 'replay'; namespace: string; runId: string }>;

export const liveExecutionContext: ExecutionContext = Object.freeze({
  mode: 'live',
  namespace: 'live',
});

export function createReplayExecutionContext(runId: string): ExecutionContext {
  const parsedRunId = identifierSchema.parse(runId);
  return { mode: 'replay', namespace: `replay:${parsedRunId}`, runId: parsedRunId };
}

export function namespaceResource(context: ExecutionContext, resourceId: string): string {
  const parsedResource = identifierSchema.parse(resourceId);
  return context.mode === 'live'
    ? parsedResource
    : `${context.namespace}:${parsedResource}`;
}

export function createReplayRun(
  input: Readonly<{
    manifest: ReplayManifest;
    runId: string;
    speed: ReplaySpeed;
    startedAtMs: number;
  }>,
): ReplayRun {
  const manifest = replayManifestSchema.parse(input.manifest);
  const context = createReplayExecutionContext(input.runId);
  if (context.mode !== 'replay') throw new Error('Replay context is required.');
  return replayRunSchema.parse({
    completedAtMs: null,
    configHash: manifest.configuration.strategyHash,
    eventCount: 0,
    inputFixtureId: manifest.fixture.fixtureId,
    inputHash: manifest.inputHash,
    lastEventId: null,
    manifestId: manifest.manifestId,
    namespace: context.namespace,
    runId: context.runId,
    speed: input.speed,
    startedAtMs: input.startedAtMs,
    status: 'pending',
  });
}
