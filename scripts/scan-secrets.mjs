import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const listed = spawnSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
);
if (listed.status !== 0) {
  process.stderr.write(listed.stderr || 'Unable to enumerate repository files.\n');
  process.exit(1);
}

const patterns = [
  {
    name: 'private-key-block',
    value: new RegExp(`-----BEGIN (?:RSA |EC |OPENSSH )?${'PRIVATE KEY'}-----`),
  },
  {
    name: 'jwt',
    value: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  { name: 'github-token', value: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'openai-token', value: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
  { name: 'slack-token', value: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: 'aws-access-key', value: /\bAKIA[0-9A-Z]{16}\b/ },
];
const findings = [];

for (const path of listed.stdout.split('\0').filter(Boolean)) {
  let contents;
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 5_000_000 || bytes.includes(0)) continue;
    contents = bytes.toString('utf8');
  } catch {
    continue;
  }
  for (const pattern of patterns) {
    if (pattern.value.test(contents)) findings.push({ path, pattern: pattern.name });
  }
}

if (findings.length > 0) {
  process.stderr.write(
    `Potential committed secrets detected (values suppressed):\n${findings
      .map(({ path, pattern }) => `- ${path}: ${pattern}`)
      .join('\n')}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Secret scan passed across ${listed.stdout.split('\0').filter(Boolean).length} repository files.\n`,
);
