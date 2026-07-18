import { Keypair } from '@solana/web3.js';
import { z } from 'zod';

import { readPrivateFile } from './files.js';

const secretKeySchema = z.array(z.number().int().min(0).max(255)).length(64);

export async function loadKeypairFile(path: string): Promise<Keypair> {
  const contents = await readPrivateFile(path, 'Solana wallet file');
  const secretKey = secretKeySchema.parse(JSON.parse(contents) as unknown);
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}
