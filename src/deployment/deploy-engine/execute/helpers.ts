import { type DeployEngine } from '../../deploy-engine.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import { type ResourceState } from '../../../types/state.js';
import { extractTemplateAttributes } from '../record-shape.js';
import { dropFailedUpdateMacs } from '../noecho-macs.js';
import type { FailedOperation } from '../../rollback-executor.js';
import { CreatedResourceSink } from '../../../provisioning/created-resource-sink.js';
import { ResourceTimeoutError } from '../../../utils/error-handler.js';
import {
  orphanNeedsIdentity,
  readResourceIdentity,
} from '../../rollback-executor/orphan-identity.js';
import {
  unsettledItemsTopKey,
  withUnsettledItems,
  withUnsettledProperties,
} from '../../../state/unsettled-properties.js';

/**
 * The `DeletionPolicy` a proven failed-CREATE orphan is journaled with
 * (go-to-k/cdkd#1710). A value outside CloudFormation's four is journaled as
 * `Retain`: the policy picks whether `--revert-failed` deletes a resource only
 * this entry records, so an unreadable one keeps the resource rather than
 * falling through to a plain delete (and the journal parser refuses it).
 */
export function journaledOrphanPolicy(
  policy: unknown
): 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined {
  if (policy === undefined) return undefined;
  return policy === 'Delete' ||
    policy === 'Retain' ||
    policy === 'Snapshot' ||
    policy === 'RetainExceptOnCreate'
    ? policy
    : 'Retain';
}

/**
 * Record what a failed in-place update left unsettled (go-to-k/cdkd#5380) on
 * the record the failure save writes: the marks its provider made through
 * `UpdateContext.markUnsettled`, unioned with the record's own. `only` limits
 * it to one logical id (the failed row, before its siblings' saves); without
 * it every pending mark is recorded, which catches one a provider made after
 * the engine had already given up on its call. A successful update and the
 * replacement fallback delete their entry first, so an entry here is a failed
 * update's.
 */
export function recordUnsettledMarks(
  engine: DeployEngine,
  newResources: Record<string, ResourceState>,
  only?: string
): void {
  // go-to-k/cdkd#6146: an unfinished update's handed keys lose their MACs.
  dropFailedUpdateMacs(engine, newResources, only);
  for (const [logicalId, marks] of engine.unsettledMarks) {
    if (only !== undefined && logicalId !== only) continue;
    if (marks.size === 0 || !Object.hasOwn(newResources, logicalId)) continue;
    newResources[logicalId] = withUnsettledProperties(newResources[logicalId]!, marks);
    // go-to-k/cdkd#5498: the items its accepted calls added, under those keys only.
    const items = engine.unsettledItemMarks.get(logicalId);
    if (items !== undefined && items.size > 0) {
      newResources[logicalId] = withUnsettledItems(newResources[logicalId]!, items);
    }
  }
}

/**
 * go-to-k/cdkd#5505: drop `names` (and the attempted items under them) from
 * the engine's pending marks for `logicalId`, once a revert proved them.
 */
export function dropUnsettledMarks(
  engine: DeployEngine,
  logicalId: string,
  names: ReadonlySet<string>
): void {
  const marks = engine.unsettledMarks.get(logicalId);
  if (marks !== undefined) for (const name of names) marks.delete(name);
  const items = engine.unsettledItemMarks.get(logicalId);
  if (items !== undefined) {
    for (const path of [...items.keys()]) {
      if (names.has(unsettledItemsTopKey(path))) items.delete(path);
    }
  }
}

/**
 * go-to-k/cdkd#5511: whether `error` is (or wraps) the `ResourceTimeoutError`
 * this logical id's own deadline raised: `provisionResource` wraps it as the
 * `cause` of its `ProvisioningError`. Bounded; never throws.
 */
export function deadlineFiredFor(error: unknown, logicalId: string): boolean {
  try {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
      if (current instanceof ResourceTimeoutError) return current.logicalId === logicalId;
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // Unreadable chain: not a deadline.
  }
  return false;
}

/** go-to-k/cdkd#5511: a failed operation whose sink is read at the save. */
export interface ReportedCreateToSettle {
  readonly sink: CreatedResourceSink;
  /** The op already journaled for the failure (the CREATE, or the UPDATE). */
  readonly failedOp: FailedOperation;
  /** On a replacement, the record being replaced. */
  readonly replaced?: ResourceState;
  readonly refused: boolean;
}

/**
 * go-to-k/cdkd#5511: complete each deadline-failed operation from what its
 * provider reported, as its mark would have: the failed CREATE then names the
 * resource, and a replacement journals the new one as its orphan (#4604). A
 * sink the engine cleared (the resource reached state) or the provider
 * retracted from (its cleanup deleted it) adds nothing.
 */
export async function settleReportedCreates(
  engine: DeployEngine,
  template: CloudFormationTemplate,
  failedOperations: FailedOperation[],
  pending: readonly ReportedCreateToSettle[]
): Promise<void> {
  for (const { sink, failedOp, replaced, refused } of pending) {
    const report = sink.report;
    if (report === undefined) continue;
    let orphanOp: FailedOperation;
    if (replaced === undefined) {
      failedOp.provisionedBy = 'sdk';
      failedOp.physicalId = report.physicalId;
      failedOp.physicalIdRecoveredFromError = true;
      failedOp.deletionPolicy = journaledOrphanPolicy(
        extractTemplateAttributes(template, failedOp.logicalId).deletionPolicy
      );
      orphanOp = failedOp;
    } else {
      if (report.physicalId === replaced.physicalId) continue;
      failedOp.replacementOrphaned = engine.replacementRun.oldDeletedBeforeCreate.has(
        failedOp.logicalId
      )
        ? 'delete-first'
        : 'create-first';
      orphanOp = replacementOrphanOpFor(
        engine,
        template,
        failedOp.logicalId,
        failedOp.resourceType,
        replaced,
        report.physicalId,
        refused
      );
      failedOperations.push(orphanOp);
    }
    await journalOrphanIdentity(engine, orphanOp, report.createdResourceIdentity);
  }
}

/**
 * go-to-k/cdkd#4604: the proven orphan a failed replacement's create made,
 * journaled beside the UPDATE naming `record`, the resource being replaced.
 */
export function replacementOrphanOpFor(
  engine: DeployEngine,
  template: CloudFormationTemplate,
  logicalId: string,
  resourceType: string,
  record: ResourceState,
  createdId: string,
  refused: boolean
): FailedOperation {
  return {
    logicalId,
    changeType: 'CREATE',
    resourceType,
    provisionedBy: 'sdk',
    physicalId: createdId,
    physicalIdRecoveredFromError: true,
    deletionPolicy: journaledOrphanPolicy(
      extractTemplateAttributes(template, logicalId).deletionPolicy
    ),
    replacedPhysicalId: record.physicalId,
    replacedResourceType: record.resourceType,
    // The replacement deleted the old resource before its create:
    // the record names a resource that is gone.
    ...(engine.replacementRun.oldDeletedBeforeCreate.has(logicalId) && {
      replacedResourceDeleted: true,
    }),
    ...(!refused && {
      attemptedProperties: engine.attemptedResolvedProps.get(logicalId),
    }),
  };
}

/**
 * go-to-k/cdkd#4655: the token naming the resource just made, so a later
 * settle can tell it from one that reused its name. Read once, best-effort,
 * after the entry is pushed: a failed read only leaves the token out, never
 * the entry. The read delays the failure's journal write, so it is bounded
 * (`readResourceIdentity`'s timeout), skipped once the user has interrupted
 * the deploy, and skipped for an orphan no settle reads a token for (an exempt
 * type, or `Retain`, which deletes nothing). A provider that took the token
 * from its create call's response carried it (`carried`, on the mark or the
 * report): that is journaled with no read, since the failure being journaled
 * (a describe that cannot run) often fails the read too.
 */
export async function journalOrphanIdentity(
  engine: DeployEngine,
  orphanOp: FailedOperation,
  carried: string | undefined
): Promise<void> {
  if (
    orphanOp.physicalId === undefined ||
    orphanOp.deletionPolicy === 'Retain' ||
    !orphanNeedsIdentity(orphanOp)
  ) {
    return;
  }
  if (carried !== undefined) {
    orphanOp.createdResourceIdentity = carried;
  } else if (engine.interruptCause !== 'user') {
    const identity = await readResourceIdentity(
      engine.providerRegistry,
      {
        resourceType: orphanOp.resourceType,
        physicalId: orphanOp.physicalId,
        provisionedBy: orphanOp.provisionedBy,
      },
      engine.stackRegion
    );
    if (typeof identity === 'string') orphanOp.createdResourceIdentity = identity;
  }
}
