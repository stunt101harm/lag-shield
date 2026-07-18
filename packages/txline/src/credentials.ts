import { z } from 'zod';

import { readPrivateFile, writePrivateFile } from './files.js';

const credentialsSchema = z
  .object({
    activatedAt: z.string().datetime(),
    apiToken: z.string().min(1),
    durationWeeks: z.number().int().min(4),
    network: z.enum(['devnet', 'mainnet']),
    serviceLevelId: z.number().int().positive(),
    subscriptionTxSignature: z.string().min(1),
    version: z.literal(1),
    walletPublicKey: z.string().min(1),
  })
  .strict()
  .superRefine((credentials, context) => {
    if (credentials.durationWeeks > 48 || credentials.durationWeeks % 4 !== 0) {
      context.addIssue({
        code: 'custom',
        message: 'durationWeeks must be a multiple of 4 through 48',
        path: ['durationWeeks'],
      });
    }
    const validServiceLevel =
      credentials.network === 'devnet'
        ? credentials.serviceLevelId === 1
        : credentials.serviceLevelId === 1 || credentials.serviceLevelId === 12;
    if (!validServiceLevel) {
      context.addIssue({
        code: 'custom',
        message: 'serviceLevelId is not a documented free tier for this network',
        path: ['serviceLevelId'],
      });
    }
  });

export type TxLineCredentials = z.infer<typeof credentialsSchema>;

export async function readCredentialsFile(path: string): Promise<TxLineCredentials> {
  const contents = await readPrivateFile(path, 'TxLINE credentials file');
  return credentialsSchema.parse(JSON.parse(contents) as unknown);
}

export async function writeCredentialsFile(
  path: string,
  credentials: TxLineCredentials,
  options: { readonly force?: boolean } = {},
): Promise<void> {
  const parsed = credentialsSchema.parse(credentials);
  await writePrivateFile(path, `${JSON.stringify(parsed, null, 2)}\n`, options);
}
