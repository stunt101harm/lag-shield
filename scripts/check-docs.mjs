import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const listed = spawnSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  {
    encoding: 'utf8',
  },
);
if (listed.status !== 0) {
  process.stderr.write(listed.stderr || 'Unable to enumerate repository files.\n');
  process.exit(1);
}

const markdownFiles = listed.stdout
  .split('\n')
  .filter((path) => path.endsWith('.md'))
  .sort();
const failures = [];
const markdownLink = /!?\[[^\]]*\]\(([^)]+)\)/g;

for (const markdownFile of markdownFiles) {
  const contents = readFileSync(markdownFile, 'utf8');
  for (const match of contents.matchAll(markdownLink)) {
    const rawTarget = match[1]?.trim() ?? '';
    const target =
      rawTarget.startsWith('<') && rawTarget.endsWith('>')
        ? rawTarget.slice(1, -1)
        : (rawTarget.split(/\s+['"]/u, 1)[0] ?? '');
    if (target === '' || target.startsWith('#') || /^(?:https?:|mailto:)/u.test(target)) {
      continue;
    }

    const path = decodeURIComponent(target.split('#', 1)[0] ?? '');
    if (path === '') continue;
    const absolutePath = resolve(dirname(markdownFile), path);
    if (!existsSync(absolutePath)) {
      failures.push(`${markdownFile}: missing local link target ${target}`);
    }
  }
}

const submission = readFileSync('docs/submission.md', 'utf8');
const requiredTxlineEndpoints = [
  '/auth/guest/start',
  '/api/token/activate',
  '/api/fixtures/snapshot',
  '/api/odds/stream',
  '/api/scores/stream',
  '/api/scores/historical/{fixtureId}',
  '/api/odds/updates/{epochDay}/{hourOfDay}/{interval}',
  '/api/odds/validation',
  '/api/scores/stat-validation',
];
for (const endpoint of requiredTxlineEndpoints) {
  if (!submission.includes(endpoint)) {
    failures.push(`docs/submission.md: missing TxLINE endpoint ${endpoint}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Documentation checks failed:\n${failures.map((value) => `- ${value}`).join('\n')}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Documentation checks passed across ${markdownFiles.length} Markdown files and ${requiredTxlineEndpoints.length} TxLINE endpoints.\n`,
);
