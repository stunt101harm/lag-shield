export const validOddsPayload = {
  Bookmaker: 'TxODDS Consensus',
  BookmakerId: 7,
  FixtureId: 18_241_006,
  InRunning: true,
  MessageId: 'odds-message-42',
  Pct: ['52.632', '25.000', '22.368'],
  PriceNames: ['Canada', 'Draw', 'Japan'],
  Prices: [2100, 3300, 2900],
  SuperOddsType: '1X2',
  Ts: 1_799_999_999_000,
} as const;

// Optional market metadata is deliberately absent to exercise partial upstream records.
export const partialOddsPayload = {
  ...validOddsPayload,
  MessageId: 'odds-message-partial',
} as const;

export const unknownPayload = {
  FixtureId: 18_241_006,
  Kind: 'weather_delay',
  Ts: 1_799_999_999_000,
} as const;

export const malformedOddsPayload = {
  ...validOddsPayload,
  MessageId: 'odds-message-malformed',
  Prices: [2100],
} as const;
