import type { AppendResult } from './store.js';
import type { ReplayRun } from './models.js';
import type { ReplayManifest } from './replay.js';

export type StoredReplayManifest = Readonly<{
  createdAtMs: number;
  manifest: ReplayManifest;
  retentionExpiresAtMs: number | null;
}>;

export interface ReplayStore {
  createReplayRun(run: ReplayRun): Promise<AppendResult>;
  saveReplayManifest(input: StoredReplayManifest): Promise<AppendResult>;
  updateReplayRun(run: ReplayRun): Promise<AppendResult>;
}
