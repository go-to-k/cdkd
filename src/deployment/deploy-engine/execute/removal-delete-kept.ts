/**
 * A template-removal DELETE that fails, kept instead of failing the deploy
 * (go-to-k/cdkd#6969).
 *
 * CloudFormation deletes a removed resource in its cleanup phase: a refused
 * delete there is `DELETE_FAILED`, the update stays applied and the stack ends
 * `UPDATE_COMPLETE`. So the deploy keeps the record (the next deploy retries the
 * delete, as it does a skipped one), counts it under `deleteSkipped` (exit 2)
 * and leaves every other change applied. Everything the kept resource depends
 * on is kept with it rather than deleted from under it, as `cdkd destroy` keeps
 * a failed delete's dependencies (go-to-k/cdkd#5670).
 *
 * An interrupt still fails the deploy: the user stopped it, and the rollback or
 * journal is how an interrupted deploy is resumed. So does a fired
 * `--resource-timeout`, whose delete is still running.
 */
import type { DeployEngine, ProvisionCounts } from '../../deploy-engine.js';
import type { ResourceChange, ResourceState } from '../../../types/state.js';
import { isInterruptedWaitError } from '../../../provisioning/interrupt-watch.js';
import { deadlineFiredFor } from './helpers.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { getLiveRenderer } from '../../../utils/live-renderer.js';
import { formatResourceLine } from '../../../utils/resource-line.js';

export class RemovalDeletesKept {
  /** Kept logical id -> the failed delete that keeps it (itself for that one). */
  private readonly keptBy = new Map<string, string>();

  /**
   * @param heldForOldCopies go-to-k/cdkd#7204: each removed resource an old
   *   copy uses that waits for the run's consumers, to that old copy. Its
   *   delete is not sent: AWS would refuse it while the old copy uses it.
   */
  constructor(heldForOldCopies: ReadonlyMap<string, string> = new Map()) {
    this.heldForOldCopies = heldForOldCopies;
  }

  private readonly heldForOldCopies: ReadonlyMap<string, string>;

  /** The held old copy that uses this removed resource, if any. */
  heldOldCopyOf(logicalId: string): string | undefined {
    return this.heldForOldCopies.get(logicalId);
  }

  /**
   * Keep `logicalId`, a removed resource `oldCopy` uses, without sending its
   * delete: the old copy waits for the stacks importing this stack's outputs
   * (go-to-k/cdkd#7204). Counted and warned like a failed delete, so what it
   * uses is kept with it.
   */
  keepHeld(
    engine: DeployEngine,
    logicalId: string,
    change: ResourceChange,
    oldCopy: string,
    record: ResourceState | undefined,
    stackName: string,
    counts: ProvisionCounts,
    progress: { current: number; total: number } | undefined
  ): void {
    this.keptBy.set(logicalId, logicalId);
    if (progress) progress.current++;
    counts.deleteSkipped++;
    const reason = `the old ${oldCopy} still uses it and waits for the stacks importing this stack's outputs`;
    getLiveRenderer().removeTask(logicalId);
    engine.logger.warn(
      safeMsg`${logicalId} (${change.resourceType}) was removed from the template, but ${reason}, so it stays in AWS and its cdkd state record was KEPT: the next 'cdkd deploy' deletes it.`
    );
    engine.recordEvent({
      eventType: 'RESOURCE_SKIPPED',
      stackName,
      operation: 'DELETE',
      logicalId,
      resourceType: change.resourceType,
      ...(record?.provisionedBy && { provisionedBy: record.provisionedBy }),
      ...(record?.physicalId && { physicalId: record.physicalId }),
      reason,
    });
  }

  /**
   * Whether `error`, the failure of `logicalId`'s template-removal delete, is
   * kept. `provisionResource` already printed it and recorded
   * `RESOURCE_FAILED`; this adds the warning and the count. The state record
   * is still in `resources`: the delete threw before it dropped it.
   */
  keepFailure(
    engine: DeployEngine,
    logicalId: string,
    change: ResourceChange,
    error: unknown,
    counts: ProvisionCounts,
    progress: { current: number; total: number } | undefined
  ): boolean {
    // A fired deadline is not kept either: the delete keeps running after it
    // and may still succeed, and the failure path's rollback waits for it.
    if (engine.interrupted || isInterruptedWaitError(error) || deadlineFiredFor(error, logicalId)) {
      return false;
    }
    this.keptBy.set(logicalId, logicalId);
    if (progress) progress.current++;
    counts.deleteSkipped++;
    engine.logger.warn(
      safeMsg`${logicalId} (${change.resourceType}) was removed from the template, but its delete failed, so it stays in AWS and its cdkd state record was KEPT: the next 'cdkd deploy' retries the delete. The deploy's other changes stay applied, as CloudFormation's cleanup phase leaves them.`
    );
    return true;
  }

  /**
   * The failed delete keeping this resource, when one of the resources whose
   * delete had to come first (`dependencies`, its dependents) was kept.
   */
  blockerOf(dependencies: Iterable<string>): string | undefined {
    for (const dependency of dependencies) {
      const blocker = this.keptBy.get(dependency);
      if (blocker !== undefined) return blocker;
    }
    return undefined;
  }

  /** Keep `logicalId` untouched because `blocker`'s delete failed. */
  keepBlocked(
    engine: DeployEngine,
    logicalId: string,
    change: ResourceChange,
    blocker: string,
    record: ResourceState | undefined,
    stackName: string,
    counts: ProvisionCounts,
    progress: { current: number; total: number } | undefined
  ): void {
    this.keptBy.set(logicalId, blocker);
    if (progress) progress.current++;
    counts.deleteSkipped++;
    const reason = `${blocker} depends on it and its delete failed`;
    const prefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
    getLiveRenderer().removeTask(logicalId);
    engine.logger.info(
      safeMsg`${prefix}${formatResourceLine('skipped', logicalId, change.resourceType, `not deleted (${reason})`)}`
    );
    engine.recordEvent({
      eventType: 'RESOURCE_SKIPPED',
      stackName,
      operation: 'DELETE',
      logicalId,
      resourceType: change.resourceType,
      ...(record?.provisionedBy && { provisionedBy: record.provisionedBy }),
      ...(record?.physicalId && { physicalId: record.physicalId }),
      reason,
    });
  }
}
