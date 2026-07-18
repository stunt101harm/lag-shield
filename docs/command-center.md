# Operator command center

The LagShield command center is the judge-facing explanation layer for the autonomous
agent. Its first viewport answers three questions without requiring market-structure
knowledge:

1. What happened in the match?
2. What did LagShield do to the market?
3. Which deterministic evidence and policy rule caused it?

It consumes the public agent API and resumable SSE stream documented in
[`agent-api.md`](agent-api.md). Set `NEXT_PUBLIC_LAGSHIELD_API_URL` to the public agent
origin before building the web application and include the web origin in the agent's
`PUBLIC_WEB_ORIGIN` allowlist.

Providers that expose a generated hostname separately can instead set
`NEXT_PUBLIC_LAGSHIELD_API_HOST`; the production build derives its HTTPS origin without
hardcoding a provider-assigned URL. The agent similarly accepts `PUBLIC_WEB_HOST` for its
exact HTTPS CORS allowlist.

## Five-minute demo path

1. Open the command center. When no match is live, the honest standby state points to the
   seeded scenario.
2. Leave replay speed at **2× demo** and select **Run winning demo**.
3. Narrate the consensus probabilities and freshness signals while the market is `OPEN`.
4. When the possible-goal event arrives, call out the immediate `PAUSED` state, reason
   codes, and the score/decision timeline.
5. Select **Test order now** while paused. The paper-order gate visibly returns
   `ORDER_REJECTED_PAUSED`; it never represents real-money execution.
6. Let three stable updates move the agent through `RECOVERY` to `OPEN`.
7. Open the latest decision evidence. Distinguish the canonical receipt hash from its
   proof lifecycle: pending, unavailable, rejected, and error are never styled as verified.
8. Close on the hash-addressed replay evidence strip: an 8-second observed consensus lag,
   20.0 percentage-point probability-distance proxy explicitly labelled as not P&L, zero
   control-window pauses, and zero recovery flaps.

For a faster deployment check, use 10× or run `pnpm judge:smoke` directly against the
agent.

## Interaction and accessibility

- Controls use native buttons, labels, selects, and progress elements.
- Every focusable element has a high-contrast focus ring.
- State names and action language accompany color, so color is never the only cue.
- `prefers-reduced-motion` disables nonessential transitions and pulse animations.
- The layout has dedicated desktop, tablet, and mobile breakpoints and is optimized for a
  1920×1080 screen recording.
- `pnpm test:e2e` runs the complete judge story and axe scan at 1920×1080 and Pixel 7
  viewports. CI retains the screenshots and traces as `command-center-evidence`.

The generated `public/og.png` social card uses the same graphite, mint, coral, and violet
visual language as the product and is exposed through host-derived Open Graph and X
metadata.
