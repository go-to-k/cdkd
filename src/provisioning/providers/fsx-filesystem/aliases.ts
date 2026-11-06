import type { FSxFileSystemProvider } from '../fsx-filesystem-provider.js';
import {
  DescribeFileSystemsCommand,
  AssociateFileSystemAliasesCommand,
  DisassociateFileSystemAliasesCommand,
  DescribeFileSystemAliasesCommand,
  type Alias,
  TagResourceCommand,
  UntagResourceCommand,
  type Tag,
} from '@aws-sdk/client-fsx';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { planTagDiff, tagPlanWarning } from '../../tag-list.js';
import {
  STALE_FAILED_READS,
  runningAliasBlockingActions,
  isAdministrativeActionInProgress,
  isTransientFsxError,
} from './shared.js';

/**
 * go-to-k/cdkd#5469: apply a Windows `Aliases` change. Disassociate first
 * (it frees room under the 50-alias limit) and wait until the removed names
 * are gone, then associate and wait until the added ones are AVAILABLE —
 * each call starts an async administrative action, so the two are not run
 * concurrently, and the deploy returns only once the aliases read back as
 * the template declares.
 *
 * The delta is reconciled against ONE read of the live aliases first, so a
 * retry after a partial failure converges instead of failing for ever:
 * `DisassociateFileSystemAliases` answers 400 for a name that is not
 * associated, so only a listed name that is not already DELETING is sent;
 * `AssociateFileSystemAliases` is a no-op for a name already there, which
 * would leave a CREATE_FAILED one failed (and a DELETING / DELETE_FAILED
 * one never AVAILABLE), so that one is cleared first — disassociated unless
 * already DELETING, then waited out — and associated afresh; an AVAILABLE /
 * CREATING one is not re-sent.
 *
 * Before any of it, wait until no OTHER administrative action is PENDING /
 * IN_PROGRESS. A storage or IOPS optimization (which can run for hours
 * after a capacity or throughput increase) is not waited for: FSx documents
 * nothing refusing an alias action beside one. If FSx does refuse a call
 * with a BadRequest naming an administrative action in progress, the call
 * is re-sent until `deadline`, the one deadline `update()` gives every
 * wait.
 */
export async function applyAliasDelta(
  this: FSxFileSystemProvider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  delta: { add: string[]; remove: string[] },
  deadline: number
): Promise<void> {
  await this.waitForNoAdministrativeAction(physicalId, logicalId, resourceType, deadline);
  const live = new Map(
    (await this.describeAliases(physicalId)).map((a) => [a.Name?.toLowerCase(), a.Lifecycle])
  );
  // An added name stuck mid-removal (DELETING / DELETE_FAILED, e.g. after an
  // interrupted earlier attempt) or CREATE_FAILED is still associated, so an
  // Associate would be a no-op that never reaches AVAILABLE: clear it first.
  const retryAdd = delta.add.filter((n) => {
    const lifecycle = live.get(n);
    return (
      lifecycle === 'CREATE_FAILED' || lifecycle === 'DELETING' || lifecycle === 'DELETE_FAILED'
    );
  });
  const awaitGone = [...delta.remove, ...retryAdd];
  const sendRemove = awaitGone.filter((n) => live.has(n) && live.get(n) !== 'DELETING');
  const sendAdd = delta.add.filter(
    (n) => live.get(n) !== 'AVAILABLE' && live.get(n) !== 'CREATING'
  );
  if (sendRemove.length > 0) {
    await this.sendAliasCall(
      physicalId,
      logicalId,
      resourceType,
      () =>
        new DisassociateFileSystemAliasesCommand({
          FileSystemId: physicalId,
          Aliases: sendRemove,
        }),
      deadline
    );
  }
  if (awaitGone.length > 0) {
    await this.waitForAliases(physicalId, logicalId, resourceType, awaitGone, 'gone', deadline);
  }
  if (sendAdd.length > 0) {
    await this.sendAliasCall(
      physicalId,
      logicalId,
      resourceType,
      () => new AssociateFileSystemAliasesCommand({ FileSystemId: physicalId, Aliases: sendAdd }),
      deadline
    );
  }
  if (delta.add.length > 0) {
    await this.waitForAliases(
      physicalId,
      logicalId,
      resourceType,
      delta.add,
      'AVAILABLE',
      deadline
    );
  }
}

/** Every alias of the file system, all pages. */
export async function describeAliases(
  this: FSxFileSystemProvider,
  physicalId: string
): Promise<Alias[]> {
  const aliases: Alias[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await this.getClient().send(
      new DescribeFileSystemAliasesCommand({ FileSystemId: physicalId, NextToken: nextToken })
    );
    aliases.push(...(resp.Aliases ?? []));
    nextToken = resp.NextToken;
  } while (nextToken);
  return aliases;
}

/**
 * Wait until no `AdministrativeActions` entry other than a storage / IOPS
 * optimization is PENDING or IN_PROGRESS (go-to-k/cdkd#5469), so an alias
 * action never overlaps another update. An optimization (and the
 * UPDATED_OPTIMIZING status of the update it follows) is not waited for: it
 * can run for hours. Bounded by the caller's `deadline`.
 */
export async function waitForNoAdministrativeAction(
  this: FSxFileSystemProvider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  deadline: number
): Promise<void> {
  const transientState = { count: 0 };
  let running: string[] = [];
  while (Date.now() < deadline) {
    const fs = await this.describeForPoll(physicalId, transientState);
    if (fs) {
      running = runningAliasBlockingActions(fs);
      if (running.length === 0) return;
      this.logger.debug(
        safeMsg`FSx FileSystem ${physicalId}: waiting for ${running.join(', ')} to finish before changing DNS aliases...`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
  }
  throw new ProvisioningError(
    safeMsg`Timed out waiting for FSx FileSystem ${physicalId} administrative actions (${running.join(', ') || 'unknown'}) to finish before changing its DNS aliases (${Math.round(this.maxWaitMs / 60000)} min). Re-deploy once they complete.`,
    resourceType,
    logicalId,
    physicalId
  );
}

/**
 * Send an Associate / Disassociate call, re-sending it while FSx refuses it
 * with a BadRequest naming an administrative action in progress
 * (go-to-k/cdkd#5469), until `deadline`; any other error propagates. On the
 * deadline the error names the actions still running.
 */
export async function sendAliasCall(
  this: FSxFileSystemProvider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  command: () => AssociateFileSystemAliasesCommand | DisassociateFileSystemAliasesCommand,
  deadline: number
): Promise<void> {
  for (;;) {
    try {
      const call = command();
      if (call instanceof AssociateFileSystemAliasesCommand) await this.getClient().send(call);
      else await this.getClient().send(call);
      return;
    } catch (error) {
      if (!isAdministrativeActionInProgress(error)) throw error;
      if (Date.now() >= deadline) {
        let running: string[] = [];
        try {
          const fs = await this.describeForPoll(physicalId, { count: 0 });
          running = (fs?.AdministrativeActions ?? [])
            .filter((a) => a.Status === 'PENDING' || a.Status === 'IN_PROGRESS')
            .map((a) => a.AdministrativeActionType ?? 'unknown');
        } catch {
          // The refusal is the error to report; the names are best-effort.
        }
        throw new ProvisioningError(
          safeMsg`Timed out changing FSx FileSystem ${physicalId} DNS aliases: FSx kept refusing the call while an administrative action (${running.join(', ') || 'unknown'}) is in progress (${Math.round(this.maxWaitMs / 60000)} min). Re-deploy once it completes.`,
          resourceType,
          logicalId,
          physicalId,
          error
        );
      }
      this.logger.debug(
        safeMsg`FSx FileSystem ${physicalId}: DNS alias call refused while an administrative action is in progress, re-sending...`
      );
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }
}

/**
 * Poll `DescribeFileSystemAliases` until each of `names` is AVAILABLE
 * (`target: 'AVAILABLE'`) or absent (`target: 'gone'`), up to `deadline`.
 * A name read as CREATE_FAILED / DELETE_FAILED fails the update, FSx will
 * not get there on its own, but only once that name was read in transition
 * (CREATING / DELETING) during this wait or read failed
 * {@link STALE_FAILED_READS} times in a row: a fresh Disassociate of a
 * DELETE_FAILED name (the retry arm of `applyAliasDelta`) can read the old
 * DELETE_FAILED before FSx flips it to DELETING.
 */
export async function waitForAliases(
  this: FSxFileSystemProvider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  names: string[],
  target: 'AVAILABLE' | 'gone',
  deadline: number
): Promise<void> {
  const failedLifecycle = target === 'AVAILABLE' ? 'CREATE_FAILED' : 'DELETE_FAILED';
  const transitionLifecycle = target === 'AVAILABLE' ? 'CREATING' : 'DELETING';
  const seenTransition = new Set<string>();
  const failedReads = new Map<string, number>();
  let transient = 0;
  while (Date.now() < deadline) {
    let aliases: Alias[];
    try {
      aliases = await this.describeAliases(physicalId);
      transient = 0;
    } catch (error) {
      // Tolerated like the file-system polls' (describeForPoll): one
      // throttle must not fail an update whose alias action already ran.
      if (!isTransientFsxError(error) || transient >= 5) throw error;
      transient += 1;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      continue;
    }
    const byName = new Map(aliases.map((a) => [a.Name?.toLowerCase(), a.Lifecycle]));
    for (const n of names) {
      const lifecycle = byName.get(n);
      if (lifecycle === transitionLifecycle) seenTransition.add(n);
      failedReads.set(n, lifecycle === failedLifecycle ? (failedReads.get(n) ?? 0) + 1 : 0);
    }
    const failed = names.filter(
      (n) =>
        byName.get(n) === failedLifecycle &&
        (seenTransition.has(n) || (failedReads.get(n) ?? 0) >= STALE_FAILED_READS)
    );
    if (failed.length > 0) {
      throw new ProvisioningError(
        safeMsg`FSx FileSystem ${physicalId}: DNS alias ${failed.join(', ')} entered ${failedLifecycle}. Check the alias name and the file system's Active Directory, then re-deploy.`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    const settled = names.every((n) =>
      target === 'AVAILABLE' ? byName.get(n) === 'AVAILABLE' : !byName.has(n)
    );
    if (settled) return;
    this.logger.debug(
      safeMsg`FSx FileSystem ${physicalId}: waiting for DNS aliases ${names.join(', ')} to be ${target}...`
    );
    await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
  }
  throw new ProvisioningError(
    safeMsg`Timed out waiting for FSx FileSystem ${physicalId} DNS aliases ${names.join(', ')} to be ${target} (${Math.round(this.maxWaitMs / 60000)} min)`,
    resourceType,
    logicalId,
    physicalId
  );
}

/**
 * Apply a `Tags` diff via `TagResource` / `UntagResource` (the FSx
 * `UpdateFileSystem` API does not accept tags). Needs the ARN — resolve
 * it from `DescribeFileSystems`. Both sides are read through `planTagDiff`
 * (go-to-k/cdkd#3994): an unreadable record untags nothing.
 */
export async function applyTagDiff(
  this: FSxFileSystemProvider,
  physicalId: string,
  resourceType: string,
  logicalId: string,
  nextTags: unknown,
  prevTags: unknown
): Promise<void> {
  const plan = planTagDiff(prevTags, nextTags);
  const resp = await this.getClient().send(
    new DescribeFileSystemsCommand({ FileSystemIds: [physicalId] })
  );
  const arn = resp.FileSystems?.[0]?.ResourceARN;
  if (!arn) {
    throw new Error(`could not resolve ResourceARN for FSx FileSystem ${physicalId}`);
  }

  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  const toSet: Tag[] = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
  const toRemove = plan.remove;

  if (toSet.length > 0) {
    await this.getClient().send(new TagResourceCommand({ ResourceARN: arn, Tags: toSet }));
  }
  if (toRemove.length > 0) {
    await this.getClient().send(new UntagResourceCommand({ ResourceARN: arn, TagKeys: toRemove }));
  }
}
