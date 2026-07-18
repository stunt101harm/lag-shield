import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readPrivateFile(path: string, label: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`${label} must be a regular, non-symlink file: ${path}`);
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`${label} has unsafe permissions. Run: chmod 600 ${path}`);
    }

    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function writePrivateFile(
  path: string,
  contents: string,
  options: { readonly force?: boolean } = {},
): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    (options.force ? constants.O_TRUNC : constants.O_EXCL);
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
