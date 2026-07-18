# Documentation assets

`command-center-paused.png` is generated from the deterministic Playwright judge scenario:

```bash
CAPTURE_DOCS_SCREENSHOT=1 pnpm --filter @lagshield/web exec playwright test \
  e2e/command-center.spec.ts --project chromium-1080p --grep "runs the judge story"
```

The screenshot uses a mocked transport only to make the UI state byte-stable; its visible
values match the committed seeded evaluation and are labelled as a seeded simulation.
