/**
 * Failed UPDATEs whose resource AWS reports gone (go-to-k/cdkd#6106).
 *
 * An update of a resource deleted outside cdkd fails on AWS's not-found, and
 * `cdkd rollback --revert-failed` re-applies the previous properties through
 * the same `update()`, so it fails the same way and the journal asks for a
 * re-run forever. Such an op is no `--revert-failed` target: the deploy names
 * the resource as deleted outside cdkd instead, with the remedy `cdkd drift`
 * prints for it.
 */
import { DELETED_RESOURCE_REMEDY } from '../../deleted-resource-remedy.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import type { FailedOperation } from '../../rollback-executor.js';
import type { RollbackDeps } from './deps.js';

/** How long one existence read may take before it counts as unanswered. */
export const DELETED_OUTSIDE_READ_TIMEOUT_MS = 30_000;

/**
 * Whether AWS reports the resource of a failed UPDATE gone. Only the
 * provider's own `RESOURCE_NOT_FOUND` answer counts; no read path, a read
 * that throws, times out or returns anything else is `false`, so the op keeps
 * its `--revert-failed` record. The error is dropped, never printed: its
 * message could echo a resolved value.
 */
async function failedUpdateResourceIsGone(
  deps: RollbackDeps,
  op: FailedOperation
): Promise<boolean> {
  const record = op.previousState;
  if (op.changeType !== 'UPDATE' || record === undefined) return false;
  if (typeof record.physicalId !== 'string' || record.physicalId === '') return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { provider } = deps.providerRegistry.getProviderFor({
      resourceType: record.resourceType,
      provisionedBy: record.provisionedBy,
    });
    if (provider.readCurrentState === undefined) return false;
    const read = provider.readCurrentState.bind(provider);
    const result = await Promise.race([
      Promise.resolve().then(() =>
        read(record.physicalId, op.logicalId, record.resourceType, record.properties ?? {})
      ),
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
  deps: RollbackDeps,
  ops: readonly FailedOperation[]
): Promise<{ gone: FailedOperation[]; kept: FailedOperation[] }> {
  const verdicts = await Promise.all(ops.map((op) => failedUpdateResourceIsGone(deps, op)));
  return {
    gone: ops.filter((_, i) => verdicts[i]),
    kept: ops.filter((_, i) => !verdicts[i]),
  };
}

/**
 * Warns, per op, that its resource was deleted outside cdkd. `recordDropped`
 * says whether the caller left the op out of the journal (the clean settle)
 * or the journal still holds it (a partial rollback keeps its full segment).
 */
export function warnDeletedOutsideCdkd(
  deps: RollbackDeps,
  gone: readonly FailedOperation[],
  recordDropped: boolean
): void {
  for (const op of gone) {
    deps.logger.warn(
      safeMsg`${op.logicalId} (${op.resourceType}): AWS reports this resource no longer exists ` +
        `(deleted outside cdkd), so its failed update has nothing to revert` +
        (recordDropped
          ? ` and no rollback record is kept for it.`
          : `: 'cdkd rollback --revert-failed' cannot revert it.`) +
        ` ${DELETED_RESOURCE_REMEDY}`
    );
  }
}
