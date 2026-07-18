import { renderStrategyEvaluationMarkdown } from '@lagshield/core';

import { createSeededEvaluationReport } from './strategy-evaluation.js';

const formatIndex = process.argv.indexOf('--format');
const format = formatIndex === -1 ? 'json' : process.argv[formatIndex + 1];
if (format !== 'json' && format !== 'markdown') {
  throw new Error('Usage: pnpm evaluation:seeded -- --format json|markdown');
}
const report = createSeededEvaluationReport();
process.stdout.write(
  format === 'markdown'
    ? renderStrategyEvaluationMarkdown(report)
    : `${JSON.stringify(report, null, 2)}\n`,
);
