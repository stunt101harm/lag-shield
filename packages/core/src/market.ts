import { z } from 'zod';

import { stableHash } from './json.js';

const marketIdentitySchema = z
  .object({
    fixtureId: z.string().min(1).max(512),
    inRunning: z.boolean(),
    outcomeNames: z.array(z.string().min(1).max(200)).max(100),
    parameters: z.string().max(500).nullable(),
    period: z.string().max(100).nullable(),
    type: z.string().min(1).max(200),
  })
  .strict()
  .superRefine((market, context) => {
    if (new Set(market.outcomeNames).size !== market.outcomeNames.length) {
      context.addIssue({
        code: 'custom',
        message: 'Market outcome names must be unique.',
      });
    }
  });

type ParsedMarketIdentity = z.infer<typeof marketIdentitySchema>;
export type MarketIdentity = Readonly<
  Omit<ParsedMarketIdentity, 'outcomeNames'> & {
    outcomeNames: readonly string[];
  }
>;

export function buildMarketId(input: MarketIdentity): string {
  const market = marketIdentitySchema.parse(input);
  const identity = { ...market, outcomeNames: [...market.outcomeNames].sort() };
  return `mkt_${stableHash(identity).slice(0, 40)}`;
}
