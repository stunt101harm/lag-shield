import type { AppendResult, Clock, DomainStore } from '@lagshield/core';
import { normalizeTxLinePayload, type NormalizeTxLineInput } from '@lagshield/txline';

export async function ingestTxLinePayload(
  dependencies: Readonly<{ clock: Clock; store: DomainStore }>,
  input: NormalizeTxLineInput,
): Promise<AppendResult> {
  const normalized = normalizeTxLinePayload(input, dependencies.clock);
  return normalized.ok
    ? dependencies.store.appendEvent({ event: normalized.event, raw: normalized.raw })
    : dependencies.store.quarantine(normalized.quarantine);
}
