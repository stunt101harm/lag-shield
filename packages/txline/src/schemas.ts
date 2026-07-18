import { z } from 'zod';

export const guestSessionSchema = z.object({ token: z.string().min(1) });
export const activationResponseSchema = z.union([
  z.string().min(1),
  z.object({ token: z.string().min(1) }).transform(({ token }) => token),
]);

export const fixtureSchema = z
  .object({
    Competition: z.string().min(1),
    CompetitionId: z.number().int(),
    FixtureGroupId: z.number().int().optional(),
    FixtureId: z.number().int(),
    GameState: z.number().int().optional(),
    Participant1: z.string().min(1),
    Participant1Id: z.number().int(),
    Participant1IsHome: z.boolean(),
    Participant2: z.string().min(1),
    Participant2Id: z.number().int(),
    StartTime: z.number().int(),
    Ts: z.number().int(),
    gameState: z.number().int().optional(),
  })
  .loose();

export const fixtureSnapshotSchema = z.array(fixtureSchema);

export type TxLineFixture = z.infer<typeof fixtureSchema>;

export type FixtureSummary = {
  readonly away: string;
  readonly competition: string;
  readonly competitionId: number;
  readonly fixtureId: number;
  readonly gameState: number | undefined;
  readonly home: string;
  readonly startTime: number;
};

export function isWorldCupFixture(fixture: TxLineFixture): boolean {
  return /\bworld cup\b/i.test(fixture.Competition);
}

export function summarizeFixture(fixture: TxLineFixture): FixtureSummary {
  return {
    away: fixture.Participant1IsHome ? fixture.Participant2 : fixture.Participant1,
    competition: fixture.Competition,
    competitionId: fixture.CompetitionId,
    fixtureId: fixture.FixtureId,
    gameState: fixture.GameState ?? fixture.gameState,
    home: fixture.Participant1IsHome ? fixture.Participant1 : fixture.Participant2,
    startTime: fixture.StartTime,
  };
}
