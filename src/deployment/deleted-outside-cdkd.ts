/**
 * Failed UPDATEs whose resource AWS reports gone (go-to-k/cdkd#6106).
 *
 * An update of a resource deleted outside cdkd fails on AWS's not-found, and
 * `cdkd rollback --revert-failed` re-applies the previous properties through
 * the same `update()`, so it fails the same way and the journal asks for a
 * re-run forever. Such an op is no `--revert-failed` target: the deploy's
 * rollback settle and `cdkd rollback` name the resource as deleted outside
 * cdkd instead, with the remedy `cdkd drift` prints for it.
 */
import { DELETED_RESOURCE_REMEDY } from './deleted-resource-remedy.js';
import type { ProviderRegistry } from '../provisioning/provider-registry.js';
import { RESOURCE_NOT_FOUND } from '../types/resource.js';
import { safeMsg } from '../utils/display-safe.js';
import type { FailedOperation } from './rollback-executor/types.js';

/** How long one existence read may take before it counts as unanswered. */
export const DELETED_OUTSIDE_READ_TIMEOUT_MS = 30_000;

/** What the existence read needs from its caller. */
export interface DeletedOutsideReadDeps {
  providerRegistry: Pick<ProviderRegistry, 'getProviderFor'>;
  /**
   * Runs the read under the op's printing bag, as `cdkd drift`'s read runs
   * (a provider's log line may name a secret-derived physical id).
   */
  withPrinting?: <T>(logicalId: string, read: () => Promise<T>) => Promise<T>;
}

/**
 * Whether AWS reports the resource of a failed UPDATE gone. Only the
 * provider's own `RESOURCE_NOT_FOUND` answer counts; no read path, a read
 * that throws, times out or returns anything else is `false`, so the op keeps
 * its `--revert-failed` record. A replacement that deleted the old resource
 * itself is excluded: cdkd, not someone outside it, removed what the record
 * names. The error is dropped, never printed: its message could echo a
 * resolved value.
 */
export async function failedUpdateResourceIsGone(
  deps: DeletedOutsideReadDeps,
  op: FailedOperation
): Promise<boolean> {
  const record = op.previousState;
  if (op.changeType !== 'UPDATE' || record === undefined) return false;
  if (op.oldDeletedBeforeCreate === true || op.replacementOrphaned !== undefined) return false;
  if (typeof record.physicalId !== 'string' || record.physicalId === '') return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { provider } = deps.providerRegistry.getProviderFor({
      resourceType: record.resourceType,
      provisionedBy: record.provisionedBy,
    });
    if (provider.readCurrentState === undefined) return false;
    const read = provider.readCurrentState.bind(provider);
    const readOnce = (): Promise<unknown> =>
      Promise.resolve().then(() =>
        read(record.physicalId, op.logicalId, record.resourceType, record.properties ?? {})
      );
    const result = await Promise.race([
      deps.withPrinting !== undefined ? deps.withPrinting(op.logicalId, readOnce) : readOnce(),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), DELETED_OUTSIDE_READ_TIMEOUT_MS);
      }),
    ]);
    return result === RESOURCE_NOT_FOUND;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Splits `ops` into those whose resource AWS reports gone (`gone`, failed
 * UPDATEs only) and the rest (`kept`), each in input order. The reads run
 * concurrently, on the failure path only.
 */
export async function partitionDeletedOutsideCdkd(
  deps: DeletedOutsideReadDeps,
  ops: readonly FailedOperation[]
): Promise<{ gone: FailedOperation[]; kept: FailedOperation[] }> {
  const verdicts = await Promise.all(ops.map((op) => failedUpdateResourceIsGone(deps, op)));
  return {
    gone: ops.filter((_, i) => verdicts[i]),
    kept: ops.filter((_, i) => !verdicts[i]),
  };
}

/**
 * The line naming one op's resource as deleted outside cdkd. `recordDropped`
 * says whether the caller dropped the op's journal record (the clean settle,
 * `cdkd rollback`) or a kept segment still holds it (a partial rollback, whose
 * `cdkd rollback --revert-failed` drops it the same way).
 */
export function deletedOutsideCdkdMessage(op: FailedOperation, recordDropped: boolean): string {
  return (
    safeMsg`${op.logicalId} (${op.resourceType}): AWS reports this resource no longer exists ` +
    `(deleted outside cdkd), so its failed update has nothing to revert` +
    (recordDropped
      ? ` and no rollback record is kept for it.`
      : ` and 'cdkd rollback --revert-failed' drops its record.`) +
    safeMsg` ${DELETED_RESOURCE_REMEDY}`
  );
}

/** The `ROLLBACK_RESOURCE_SKIPPED` reason of a force-revert whose resource is gone. */
export const DELETED_OUTSIDE_SKIP_CAUSE =
  'AWS reports the resource no longer exists (deleted outside cdkd), so its failed update ' +
  'has nothing to revert; the rollback dropped its record from the journal.';
