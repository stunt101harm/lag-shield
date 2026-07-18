import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readCredentialsFile,
  writeCredentialsFile,
  type TxLineCredentials,
} from './credentials.js';

const temporaryDirectories: string[] = [];
const credentials: TxLineCredentials = {
  activatedAt: '2026-07-17T12:00:00.000Z',
  apiToken: 'private-api-token',
  durationWeeks: 4,
  network: 'devnet',
  serviceLevelId: 1,
  subscriptionTxSignature: 'transaction-signature',
  version: 1,
  walletPublicKey: 'wallet-public-key',
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('TxLINE credential files', () => {
  it('writes mode 600, reads valid data, and refuses accidental replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lagshield-credentials-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'devnet.json');

    await writeCredentialsFile(path, credentials);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(readCredentialsFile(path)).resolves.toEqual(credentials);
    await expect(writeCredentialsFile(path, credentials)).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });

  it('refuses to read group/world-readable secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lagshield-credentials-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'devnet.json');
    await writeCredentialsFile(path, credentials);
    await chmod(path, 0o644);

    await expect(readCredentialsFile(path)).rejects.toThrow('unsafe permissions');
  });

  it('never follows a credentials symlink, including with force enabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lagshield-credentials-'));
    temporaryDirectories.push(directory);
    const target = join(directory, 'target.txt');
    const path = join(directory, 'devnet.json');
    await writeFile(target, 'must-not-change', { mode: 0o600 });
    await symlink(target, path);

    await expect(
      writeCredentialsFile(path, credentials, { force: true }),
    ).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(readCredentialsFile(path)).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(readFile(target, 'utf8')).resolves.toBe('must-not-change');
  });
});
