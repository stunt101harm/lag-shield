import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import HomePage from './page.js';

describe('LagShield command center', () => {
  it('renders an honest, actionable no-live-data state before the agent responds', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('SYNCING');
    expect(markup).toContain('Run winning demo');
    expect(markup).toContain('SIMULATION');
    expect(markup).toContain('Never real money');
    expect(markup).toContain('not yet verified');
  });

  it('exposes keyboard-native controls for every judge interaction', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('<button');
    expect(markup).toContain('Replay speed');
    expect(markup).toContain('Pause');
    expect(markup).toContain('Resume');
    expect(markup).toContain('Test order now');
    expect(markup).toContain('Circuit breaker progression');
  });
});
