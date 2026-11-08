/**
 * The destroy runner's module-level helpers (split out of
 * `../destroy-runner.ts`, go-to-k/cdkd#5835).
 */
import { isDeepStrictEqual } from 'node:util';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { displaySafe, displayStackName, safeMsg } from '../../../utils/display-safe.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import {
  PROTECTION_PROPERTY_BY_TYPE,
  isProtectionValueActive,
  perType,
  readProtection,
} from '../../../provisioning/protection-flags.js';
import type { StackState } from '../../../types/state.js';
import type { DeploymentEventRecorder } from '../../../types/deployment-events.js';
import type { ActiveImportConsumer } from '../../../utils/error-handler.js';
import type { JournaledOrphans } from '../../../deployment/rollback-executor/journaled-orphans.js';
import { orphanNeedsIdentity } from '../../../deployment/rollback-executor/orphan-identity.js';
import { maskEventTextWithBoundBags } from '../../../deployment/secret-name-needles.js';
import { supersededResourcesOf } from '../../../deployment/superseded-resources.js';
import type { DestroyRunnerContext } from './types.js';

/**
 * go-to-k/cdkd#2346: purge the deleted record's earlier `state.json` versions
 * when the caller opted in ({@link DestroyRunnerContext.purgeStateHistory}).
 * Both of the runner's record deletes call it AFTER the kept-resource record
 * is written and before the lock is released. Never throws.
 */
export async function purgeStateHistoryIfOptedIn(
  ctx: DestroyRunnerContext,
  stackName: string,
  region: string
): Promise<void> {
  if (ctx.purgeStateHistory === true) {
    await ctx.stateBackend.purgeDeletedStateHistory(stackName, region);
  }
}

/**
 * The nested-stack resource type. A skipped row of this type means the CHILD
 * stack was not destroyed, and the record a user must repair lives in the
 * child's own state file (`<parent>~<logicalId>`) — see `skippedStateTargets`.
 */
export const NESTED_STACK_TYPE = 'AWS::CloudFormation::Stack';

/**
 * The pre-delete final snapshot's logger, with every line routed through the
 * delete's masker (go-to-k/cdkd#2319): its debug line quotes a withheld AWS
 * failure's text. The `rollback-executor/names.ts` shape.
 */
export function maskedSnapshotLogger(
  logger: { info(message: string): void; debug(message: string): void },
  mask: (text: string) => string
): { info(message: string): void; debug(message: string): void } {
  return {
    info: (message) => logger.info(mask(message)),
    debug: (message) => logger.debug(mask(message)),
  };
}

/**
 * Record one destroy event with its human-authored text masked by the
 * printing bags bound where it is recorded (go-to-k/cdkd#3869,
 * {@link maskEventTextWithBoundBags}): a delete's own bag, or a
 * journaled-orphan batch's.
 */
export function recordDestroyEvent(
  recorder: DeploymentEventRecorder | undefined,
  event: Parameters<DeploymentEventRecorder['record']>[0]
): void {
  recorder?.record(maskEventTextWithBoundBags(event));
}

/**
 * The remedy both skip arms of the per-stack summary name (go-to-k/cdkd#2122).
 *
 * A skip has two kinds of producer, and they need different remedies: one that
 * could not ADDRESS the resource from its state record (issue #1752), where
 * repairing the record and re-running is the fix, and a custom-resource Delete
 * handler that RAN and refused (issue #2054) or whose invoke did not complete,
 * where the record is fine and editing it changes nothing. Even a record-shaped
 * cause is not always repairable (a masked or referenced ServiceToken whose
 * handler this destroy deletes, a secret-derived principal list), so the
 * summary defers to the per-resource warning, which says which applies.
 * Worded for both callers: this runner serves `cdkd destroy` AND
 * `cdkd state destroy`, so it says "re-run" without naming either.
 */
export const SKIPPED_REMEDY =
  `Each 'skipped (...)' line above names its cause, and its warning says whether ` +
  `repairing the record in state.json helps. Where it does, repair it and re-run. ` +
  `Otherwise (for example a custom-resource Delete handler that reported FAILED), ` +
  `delete the resources by hand, then drop the records.`;

/**
 * Count how many resources in a stack's recorded state appear to have
 * deletion protection enabled, reading each type's flag through its
 * `PROTECTION_PROPERTY_BY_TYPE` locator in `properties` and in
 * `observedProperties`.
 */
export function countProtectedResources(state: StackState): number {
  let count = 0;
  // go-to-k/cdkd#5111: the superseded copies too, whose delete gets the flag.
  const records = [
    ...Object.values(state.resources ?? {}),
    ...supersededResourcesOf(state).map((entry) => entry.state),
  ];
  for (const resource of records) {
    const locator = perType(PROTECTION_PROPERTY_BY_TYPE, resource.resourceType);
    if (locator) {
      const isActive = (recorded: unknown): boolean =>
        isProtectionValueActive(resource.resourceType, recorded);
      // EITHER bag, not the first one that holds a value. The template can
      // say off while the observed baseline says on (protection enabled out
      // of band): the delete flips what AWS has, so the prompt must count it.
      // Over-counting is the safe direction for a warning.
      if (
        isActive(readProtection(resource.properties, locator, state.region)) ||
        isActive(readProtection(resource.observedProperties, locator, state.region))
      ) {
        count++;
      }
      continue;
    }
  }
  return count;
}

/**
 * The journaled failed-CREATE orphans whose ATTEMPTED properties turn deletion
 * protection on: `--remove-protection` strips theirs too (go-to-k/cdkd#4678),
 * so the prompt counts them beside {@link countProtectedResources}. Not one
 * the sweep leaves alone (demoted, `Retain`), nor a name-keyed one with no
 * journaled identity, whose protection the delete never strips; one whose
 * identity a live read may yet disprove is counted (over-counting is the safe
 * direction for a warning).
 */
export function countProtectedJournaledOrphans(
  orphans: Pick<JournaledOrphans, 'segments'>,
  region: string | undefined
): number {
  let count = 0;
  for (const { ops } of orphans.segments) {
    for (const op of ops) {
      if (op.physicalIdRecoveredFromError !== true || op.deletionPolicy === 'Retain') continue;
      if (orphanNeedsIdentity(op) && !op.createdResourceIdentity) continue;
      const locator = perType(PROTECTION_PROPERTY_BY_TYPE, op.resourceType);
      if (
        locator &&
        isProtectionValueActive(
          op.resourceType,
          readProtection(op.attemptedProperties, locator, region)
        )
      ) {
        count++;
      }
    }
  }
  return count;
}

/**
 * go-to-k/cdkd#4705: once a top-level stack's record is gone (deleted FIRST, so
 * the registry never names a prefix for a stack it no longer records), delete
 * its registry marker when it names this prefix. Only for `cdkd destroy` /
 * `cdkd state destroy` of a top-level stack (`crossPrefixCheck` is set exactly
 * then). Best-effort: a marker left behind names a prefix with no record, which
 * another prefix's next check treats as stale and re-claims.
 */
export async function releaseRegistryMarkerAfterDestroy(
  ctx: Pick<DestroyRunnerContext, 'crossPrefixCheck' | 'stateBackend'>,
  stackName: string,
  region: string,
  logger: { warn(message: string): void; debug(message: string): void }
): Promise<void> {
  if (ctx.crossPrefixCheck === undefined) return;
  try {
    const known = await ctx.crossPrefixCheck.cache.knownMarker?.(stackName, region);
    const released = await ctx.stateBackend.releaseRegistryMarker(stackName, region, known);
    logger.debug(safeMsg`Stack registry marker: ${released}`);
  } catch (error) {
    logger.warn(
      safeMsg`Could not delete the stack registry marker of ${displayStackName(stackName)} ` +
        safeMsg`(${describeAwsFailure(error).summary}). It names this state prefix, which no longer ` +
        `records the stack, so a deploy under another prefix treats it as stale.`
    );
  }
}

/**
 * Whether `current` still holds exactly the resources `snapshot` holds
 * (go-to-k/cdkd#5220): the same `resources` rows, field for field, and the
 * same `supersededResources`. The delete loop acts on the snapshot's rows --
 * their physical ids, deletion policies and properties -- and the end of a
 * clean run deletes the whole record, so any difference is unsafe: a row gone
 * or re-pointed deletes a resource the record no longer owns, a row changed in
 * place deletes under a stale deletion policy, and a row added since would be
 * dropped with the record while its resource stays live. Exported for its
 * unit tests.
 */
export function holdsSameResourcesAs(snapshot: StackState, current: StackState): boolean {
  return (
    isDeepStrictEqual(snapshot.resources, current.resources) &&
    isDeepStrictEqual(snapshot.supersededResources, current.supersededResources)
  );
}

/**
 * Strong-reference scan: read every other stack's state.json from the
 * state bucket and check whether any of its `imports[]` entries names
 * `producerStack`. Returns the list of offending consumers (possibly
 * empty).
 *
 * NEVER trusts the persistent exports index — a stale index could miss
 * a freshly-recorded consumer and let a destructive destroy through.
 * The cost is one `listStacks` + N parallel GETs at destroy time only
 * (not the deploy hot path), which the user-facing UX rationalizes as
 * the "destroy is slow OK" trade-off (Issue #343).
 */
export async function scanActiveConsumers(
  producerStack: string,
  producerRegion: string,
  ctx: Pick<DestroyRunnerContext, 'stateBackend' | 'baseRegion'>
): Promise<ActiveImportConsumer[]> {
  const refs = await ctx.stateBackend.listStacks();
  const results = await Promise.all(
    refs.map(async (ref) => {
      // Region missing on legacy v1 records — fall back to caller's
      // baseRegion to match the deploy-side resolver's behavior.
      const region = ref.region ?? ctx.baseRegion;
      // Skip self (a stack importing its own export is invalid in CFn).
      // Match on BOTH name AND region — the v2 layout supports the
      // same stackName deployed to multiple regions, and an unrelated
      // same-name stack in a different region is NOT self.
      if (ref.stackName === producerStack && region === producerRegion) return null;
      try {
        const got = await ctx.stateBackend.getState(ref.stackName, region);
        const imports = got?.state.imports;
        if (!imports || imports.length === 0) return null;
        // The region is compared CANONICALIZED (go-to-k/cdkd#3746), the rule
        // the deploy side keys and dedups these entries by: an entry stored
        // in another case was kept there as the same reference, and a strict
        // `===` here let a destroy through over it.
        const matches = imports.filter(
          (entry) =>
            entry.sourceStack === producerStack &&
            canonicalizeRegion(entry.sourceRegion) === canonicalizeRegion(producerRegion)
        );
        if (matches.length === 0) return null;
        return matches.map<ActiveImportConsumer>((entry) => ({
          consumerStack: ref.stackName,
          consumerRegion: region,
          exportName: entry.exportName,
        }));
      } catch {
        // A single unreadable state shouldn't tank the safety scan —
        // skip and log nothing here; the destroy is going to refuse
        // or proceed based on what we CAN read. The caller will see
        // any persistent listStacks-level issue separately.
        return null;
      }
    })
  );
  return results.filter((r) => r !== null).flat();
}

/**
 * go-to-k/cdkd#3252: a re-read under the destroy's lock that finds an
 * unsettled abandoned Cloud Control CREATE refuses. The settle at the top of
 * the run left none, so a deploy failing since journaled it, and this destroy
 * would sweep the journal holding its only record.
 */
export function refuseNewPendingRequests(
  read: { pendingRequests?: number },
  stackName: string,
  region: string
): void {
  if ((read.pendingRequests ?? 0) === 0) return;
  throw new Error(
    `The rollback journal of stack ${displayStackName(stackName)} (${displaySafe(region, { asciiOnly: true })}) ` +
      `now records a Cloud Control CREATE a failed deploy stopped waiting for — another cdkd process ` +
      `wrote to it. Nothing was deleted; re-run the destroy, which checks how that CREATE ended first.`
  );
}
