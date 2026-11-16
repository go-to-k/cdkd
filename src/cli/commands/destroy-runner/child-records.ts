import { displayStackName, safeMsg } from '../../../utils/display-safe.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { holdsSupersededResources } from '../../../deployment/superseded-resources.js';
import { loadJournaledOrphans } from '../../../deployment/rollback-executor/journaled-orphans.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import type { StackState } from '../../../types/state.js';
import { destroyEmptyStack } from './preflight.js';
import type { DestroyLogger, DestroyRunnerContext, DestroyRunnerResult } from './types.js';

/**
 * Retire the nested-child records a destroyed stack leaves with nothing to
 * address them (go-to-k/cdkd#6396).
 *
 * A nested child writes `cdkd/<Parent>~<ChildLogicalId>/<region>/state.json`
 * (and its rollback journal) while its first deploy runs. When that deploy
 * fails inside the child, the child rolls back to an EMPTY record, but the
 * parent's `AWS::CloudFormation::Stack` row recorded no physical id, so the
 * parent's state holds no row for it. The parent's destroy therefore never
 * reaches `NestedStackProvider.delete` for that child, and the record outlived
 * the destroy: `cdkd state list` kept listing the child as a stack.
 *
 * Called once the parent's own record is deleted, still under the parent's
 * lock (so no deploy of the parent can be writing a child record meanwhile).
 * A record is retired only when it names this parent (`parentStack` /
 * `parentRegion`, matching its own key) and holds nothing: no resource, no
 * rollback orphan, no superseded resource, no journaled orphan. The delete
 * itself is `destroyEmptyStack`, which takes the CHILD's lock and re-checks
 * every one of those guards under it, exactly as a top-level stack's empty
 * record is deleted. A record that still holds anything is kept and named,
 * never destroyed: nothing in the parent's template or state addresses its
 * resources. A child kept that way also keeps every ancestor record below the
 * parent, so the chain stays readable.
 *
 * Best-effort: a listing or read that fails warns and keeps the records; the
 * parent's destroy already succeeded.
 */
export async function retireUnaddressedChildRecords(
  parentStackName: string,
  region: string,
  ctx: DestroyRunnerContext,
  logger: DestroyLogger,
  refusalRecovery: LockRecoveryContext
): Promise<void> {
  const namePrefix = `${parentStackName}~`;
  let names: string[];
  try {
    const refs = await ctx.stateBackend.listStacks(namePrefix);
    names = refs
      .filter((ref) => ref.region === region && ref.stackName.startsWith(namePrefix))
      .map((ref) => ref.stackName);
  } catch (err) {
    logger.warn(
      safeMsg`Could not list the nested-stack records under ${displayStackName(parentStackName)} ` +
        safeMsg`to retire the ones its destroy left unaddressed: ${describeAwsFailure(err).detail}. ` +
        `They are kept; \`cdkd state list\` shows them.`
    );
    return;
  }
  // Deepest first, so a grandchild is settled before the child above it.
  names.sort((a, b) => depthOf(b) - depthOf(a) || a.localeCompare(b));
  const kept: string[] = [];
  for (const childName of names) {
    if (kept.some((k) => k.startsWith(`${childName}~`))) {
      kept.push(childName);
      continue;
    }
    const verdict = await retireOne(childName, region, ctx, logger, refusalRecovery);
    if (verdict === 'kept') kept.push(childName);
  }
}

function depthOf(stackName: string): number {
  return stackName.split('~').length;
}

/** The record holds nothing a destroy could still address. */
function holdsNothing(state: StackState): boolean {
  const resources: unknown = state.resources;
  const orphans: unknown = state.orphans;
  return (
    resources !== null &&
    typeof resources === 'object' &&
    !Array.isArray(resources) &&
    Object.keys(resources).length === 0 &&
    (orphans === undefined || (Array.isArray(orphans) && orphans.length === 0)) &&
    !holdsSupersededResources(state)
  );
}

async function retireOne(
  childName: string,
  region: string,
  ctx: DestroyRunnerContext,
  logger: DestroyLogger,
  refusalRecovery: LockRecoveryContext
): Promise<'retired' | 'kept' | 'not-ours'> {
  const keptNote = (reason: string): 'kept' => {
    logger.warn(
      safeMsg`Kept the nested-stack record ${displayStackName(childName)}: ${reason} ` +
        `\`cdkd state show\` shows it.`
    );
    return 'kept';
  };
  let read: Awaited<ReturnType<DestroyRunnerContext['stateBackend']['getState']>>;
  try {
    read = await ctx.stateBackend.getState(childName, region);
  } catch (err) {
    return keptNote(safeMsg`it could not be read (${describeAwsFailure(err).detail}).`);
  }
  if (!read) return 'not-ours';
  const state = read.state;
  // The key's own parent: `<Parent>~A~B` is a child of `<Parent>~A`. A
  // record whose body names another parent is not this tree's to retire.
  const expectedParent = childName.slice(0, childName.lastIndexOf('~'));
  if (state.parentStack !== expectedParent || state.parentRegion !== region) return 'not-ours';
  if (!holdsNothing(state)) {
    return keptNote(
      'it still records resources, rollback orphans or superseded resources that no ' +
        'row of its parent addresses.'
    );
  }
  const journaledOrphans = await loadJournaledOrphans(
    ctx.stateBackend,
    childName,
    region,
    state.orphans,
    logger
  );
  if (journaledOrphans.count > 0 || journaledOrphans.unreadable === true) {
    return keptNote('its rollback journal records resources a failed deploy created.');
  }
  const result: DestroyRunnerResult = {
    stackName: childName,
    cancelled: false,
    skippedEmpty: false,
    deletedCount: 0,
    retainedCount: 0,
    skippedCount: 0,
    guardIndeterminateCount: 0,
    journaledOrphanSkips: 0,
    stateDeleted: false,
    blockedCount: 0,
    errorCount: 0,
    interrupted: false,
  };
  try {
    await destroyEmptyStack({
      stackName: childName,
      ctx,
      logger,
      stackLockBase: {
        lockManager: ctx.lockManager,
        stackName: childName,
        region,
        operation: 'destroy',
        recovery: refusalRecovery,
      },
      regionForState: region,
      refusalRecovery,
      journaledOrphans,
      result,
    });
  } catch (err) {
    return keptNote(safeMsg`retiring it was refused (${describeAwsFailure(err).detail}).`);
  }
  return result.stateDeleted ? 'retired' : 'kept';
}
