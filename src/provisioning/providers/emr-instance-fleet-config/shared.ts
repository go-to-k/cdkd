import type { InstanceFleetState } from '@aws-sdk/client-emr';
import { safeMsg } from '../../../utils/display-safe.js';
import { AmbiguousCreateLatch, RecentIdSet } from '../ambiguous-create.js';

/**
 * Default polling budget for an instance fleet reaching RUNNING. Adding a
 * fleet to an already-WAITING cluster provisions + bootstraps its EC2
 * instances (typically 2-6 minutes); a resize settles faster. Reuse the
 * EMR Cluster provider's 1-hour ceiling so the slowest realistic add still
 * fits inside the per-resource deadline.
 */
export const DEFAULT_MAX_WAIT_MS = 60 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** Instance-fleet state that means "the fleet is up and idle/serving". */
export const READY_STATES: ReadonlySet<InstanceFleetState> = new Set<InstanceFleetState>([
  'RUNNING',
]);

/**
 * Instance-fleet states that mean "the fleet will never reach the requested
 * capacity" — a hard error during a create/resize wait.
 *
 * `TERMINATED` means the fleet is gone. `SUSPENDED` means a resize could not
 * complete: the existing instances keep running but AWS can no longer add or
 * remove any, so the wait would poll to the full `maxWaitMs` timeout instead of
 * failing fast with the service's own state-change reason (issue #1092 item 2).
 *
 * This is the fleet-state ANALOGUE of the instance-group provider's failed set,
 * not a copy of it: the two enums differ. `ARRESTED` and `ENDED` are
 * `InstanceGroupState` members that do not exist for fleets, so `TERMINATED` is
 * the only state the two sets share.
 */
export const FAILED_STATES: ReadonlySet<InstanceFleetState> = new Set<InstanceFleetState>([
  'SUSPENDED',
  'TERMINATED',
]);

export const toNumber = (v: unknown): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
};

export const jsonEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Mutable properties whose REMOVAL from the template cdkd leaves in place
 * (issue #1160). `ModifyInstanceFleet` keeps a field it is not sent, and
 * cdkd sends no reset, because CloudFormation keeps both too (CFn A/B
 * us-east-1 2026-10-20 on a running TASK fleet: `ResizeSpecifications`
 * removed alone and beside an `InstanceTypeConfigs` change, and
 * `InstanceTypeConfigs` removed alone, each left the live value in place, and
 * no update failed). Neither has a constant reset anyway: a fleet provisions
 * nothing without instance types, and the resize specification's defaults
 * are per-strategy AWS choices. `update()` names the removal in its own
 * warning rather than the shared caller's, whose line claims a CloudFormation
 * reset.
 */
export const LEFT_IN_PLACE_ON_REMOVAL = ['ResizeSpecifications', 'InstanceTypeConfigs'] as const;

/**
 * The ONE warning line for {@link LEFT_IN_PLACE_ON_REMOVAL} removals. Names
 * are template-borne, so they go through `safeMsg`. The deploy line says
 * CloudFormation keeps the value too (the CFn A/B above). A rollback revert
 * restores an earlier state record, so there the property is one the failed
 * deploy ADDED, and the line says that instead.
 */
export const leftInPlaceWarning = (
  logicalId: string,
  names: readonly string[],
  caller: 'deploy' | 'rollback'
): string => {
  const one = names.length === 1;
  const subject = one ? 'property' : 'properties';
  const verb = one ? 'is' : 'are';
  return caller === 'rollback'
    ? safeMsg`${logicalId} (AWS::EMR::InstanceFleetConfig): ${subject} ${names.join(', ')} ${verb} absent from the state being restored; ModifyInstanceFleet keeps a setting it is not sent, so the rollback leaves the value the failed deploy applied in place.`
    : safeMsg`${logicalId} (AWS::EMR::InstanceFleetConfig): ${subject} ${names.join(', ')} ${one ? 'was' : 'were'} removed from the template and ${one ? 'keeps its' : 'keep their'} current AWS value, as CloudFormation leaves ${one ? 'it' : 'them'}; ModifyInstanceFleet keeps a setting it is not sent. Declare the intended value explicitly to change it.`;
};

/**
 * Retry-safety state for `AddInstanceFleet`, which mints the instance fleet id and
 * carries no idempotency token (issue
 * [#2080](https://github.com/go-to-k/cdkd/issues/2080)); see
 * `orphan-report.ts`. Module-scoped: a provider instance is per
 * registry, and one process can build several.
 */
export const addInstanceFleetLatch = new AmbiguousCreateLatch('emr:AddInstanceFleet');
/** Instance fleets this process created and recorded, never reported as orphan candidates. */
export const fleetsCreatedByThisProcess = new RecentIdSet();
