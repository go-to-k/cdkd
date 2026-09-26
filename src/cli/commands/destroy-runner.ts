import * as readline from 'node:readline/promises';
import {
  pasteableCommand,
  plainOrDescribed,
  withheldTargetClause,
} from '../../utils/pasteable-command.js';
import { describeAwsFailure, safeStringify } from '../../utils/aws-failure-text.js';
import { displaySafe, displayStackName } from '../../utils/display-safe.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { getLogger } from '../../utils/logger.js';
import { bold, green, red, yellow } from '../../utils/colors.js';
import { formatResourceLine } from '../../utils/resource-line.js';
import {
  deleteIndeterminateGuards,
  deleteSkipReason,
  UNSPECIFIED_SKIP_REASON,
} from '../../deployment/delete-outcome.js';
import { getLiveRenderer } from '../../utils/live-renderer.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import {
  ATOMIC_FINAL_SNAPSHOT_TYPES,
  PRE_DELETE_SNAPSHOT_TYPES,
  buildFinalSnapshotIdentifier,
  ccRoutedFinalSnapshotError,
  createPreDeleteFinalSnapshot,
  isFinalSnapshotError,
  unsupportedFinalSnapshotError,
} from '../../provisioning/final-snapshot.js';
import type { S3StateBackend } from '../../state/s3-state-backend.js';
import type { LockManager } from '../../state/lock-manager.js';
import {
  buildLockContentionMessage,
  forceQuitRecoveryClause,
} from '../../state/lock-contention-message.js';
import { DagBuilder } from '../../analyzer/dag-builder.js';
import {
  IMPLICIT_DELETE_DEPENDENCIES,
  computeImplicitDeleteEdges,
} from '../../analyzer/implicit-delete-deps.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { extractLocalDeletionProtection } from '../../provisioning/providers/dynamodb-globaltable-provider.js';
import { isTruthyCfnBoolean } from '../../provisioning/data-delete-intent.js';
import { slowCcOperationTimeoutMs } from '../../provisioning/slow-cc-operation-timeouts.js';
import { shouldRetainResource, type ResourceState, type StackState } from '../../types/state.js';
import {
  refuseDivergentRecordRegionForDestroy,
  refuseMalformedOutputsForDestroy,
  refuseMalformedOrphanRecordsForDestroy,
  refuseMalformedOrphansForDestroy,
  refuseMalformedResourceEntriesForDestroy,
  refuseMalformedResourcesForDestroy,
} from '../../state/malformed-resources-bag.js';
import type { ResourceDeleteResult } from '../../types/resource.js';
import {
  extractDeploymentEventError,
  type DeploymentEventRecorder,
} from '../../types/deployment-events.js';
import { withResourceDeadline } from '../../deployment/resource-deadline.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
  retryClassificationText,
} from '../../deployment/retryable-errors.js';
import {
  DEFAULT_RESOURCE_WARN_AFTER_MS,
  DEFAULT_RESOURCE_TIMEOUT_MS,
} from '../../deployment/deploy-engine.js';
import {
  CdkdError,
  ProvisioningError,
  ResourceTimeoutError,
  StackHasActiveImportsError,
  type ActiveImportConsumer,
} from '../../utils/error-handler.js';
import type { ExportIndexStore } from '../../state/export-index-store.js';
import { isInterruptedWaitError } from '../../provisioning/interrupt-watch.js';
import { isWaitAbandonedError } from '../../provisioning/wait-abandoned.js';

/**
 * Execution context passed by the caller (`cdkd destroy` or
 * `cdkd state destroy`) to the shared per-stack destroy runner.
 *
 * The state backend, lock manager, and "base" AWS clients are owned by the
 * caller — the runner only borrows them. The runner is responsible for
 * spinning up a region-scoped `AwsClients` / `ProviderRegistry` if a stack's
 * state pinpoints a different region from the caller's, and for tearing
 * those down on its way out.
 */
export interface DestroyRunnerContext {
  stateBackend: S3StateBackend;
  lockManager: LockManager;

  /**
   * Caller's existing provider registry (already wired up against `baseAwsClients`).
   * Reused when the stack's state has no region or matches `baseRegion`.
   */
  providerRegistry: ProviderRegistry;

  /** Caller's existing AWS clients. */
  baseAwsClients: AwsClients;

  /**
   * The region the caller is operating in. When the loaded `StackState.region`
   * differs, the runner switches to a region-scoped `AwsClients` for the
   * destroy and restores `baseAwsClients` afterwards.
   */
  baseRegion: string;

  /**
   * `S3StateBackend.getState`'s divergence report for the record being
   * destroyed: the `region` its BODY carried when that was not the region of
   * the key it was read from, and `undefined` otherwise — which is every
   * record cdkd has ever written (issue
   * [#3328](https://github.com/go-to-k/cdkd/issues/3328)).
   *
   * Threaded rather than re-derived because it CANNOT be re-derived here: by
   * the time the record reaches this function its `region` is already the
   * key's, so the two halves agree and the divergence is invisible. The runner
   * refuses on it when the record still lists resources —
   * `refuseDivergentRecordRegionForDestroy` carries why.
   *
   * A caller that did not load the record through `getState` leaves it unset,
   * which is the pre-#3328 behaviour: no refusal.
   */
  divergentBodyRegion?: unknown;

  /** Caller's --profile, if any. */
  profile?: string;

  /**
   * Caller's `--state-prefix`. Threaded for the recovery hints alone (issue
   * #2170): `cdkd force-unlock` re-resolves the prefix from its own default,
   * so a destroy run under `--state-prefix team-a` was suggesting a command
   * that would force-delete a DIFFERENT team's lock in a shared bucket -- the
   * very failure #2170 exists to close, on the command that most needs it.
   */
  statePrefix?: string;

  /** State bucket — needed for custom-resource ResponseURL pre-signing. */
  stateBucket: string;

  /**
   * Skip the interactive confirmation prompt. Both `cdkd destroy --yes / --force`
   * and `cdkd state destroy --yes` map to true.
   */
  skipConfirmation: boolean;

  /**
   * If true, providers MUST flip per-resource deletion protection off
   * in-place before delete. Mirrors `--remove-protection` on
   * `cdkd destroy` / `cdkd state destroy`. Threaded into each
   * `provider.delete` call via `DeleteContext.removeProtection`.
   * Resource types without a protection field treat this as a no-op.
   */
  removeProtection?: boolean;

  /**
   * `--skip-final-snapshot` (issues #1352 / #1353) — delete
   * `DeletionPolicy: Snapshot` resources WITHOUT the final snapshot the
   * policy promises (data loss, explicit opt-in). Default: honor the policy
   * — atomic final-snapshot delete parameters, or a pre-delete snapshot+wait
   * for the CC-routed types (EC2 Volume / Redshift Cluster / ElastiCache
   * ReplicationGroup) — and refuse (`FINAL_SNAPSHOT_UNSUPPORTED`) when cdkd
   * cannot honor it. Mirrors `DeployEngineOptions.skipFinalSnapshot`.
   */
  skipFinalSnapshot?: boolean;

  /**
   * Per-resource warn threshold (ms). Mirrors `DeployEngineOptions` so
   * `cdkd destroy` exposes the same `--resource-warn-after` UX as
   * `cdkd deploy`. Defaults to {@link DEFAULT_RESOURCE_WARN_AFTER_MS}.
   */
  resourceWarnAfterMs?: number;

  /**
   * Per-resource hard timeout (ms). Mirrors `DeployEngineOptions` so
   * `cdkd destroy` exposes the same `--resource-timeout` UX as
   * `cdkd deploy`. Defaults to {@link DEFAULT_RESOURCE_TIMEOUT_MS}.
   */
  resourceTimeoutMs?: number;

  /**
   * Per-resource-type warn-after override map. Same semantics as
   * `DeployEngineOptions.resourceWarnAfterByType` — the value for the
   * resource's `resourceType` (if present) supersedes
   * `resourceWarnAfterMs` at the per-resource delete site.
   */
  resourceWarnAfterByType?: Record<string, number>;

  /**
   * Per-resource-type hard-timeout override map. Same semantics as
   * `DeployEngineOptions.resourceTimeoutByType` — the value for the
   * resource's `resourceType` (if present) supersedes
   * `resourceTimeoutMs` at the per-resource delete site.
   */
  resourceTimeoutByType?: Record<string, number>;

  /**
   * Persistent exports index. When supplied, the runner removes this
   * stack's entries from the index after a successful destroy so
   * subsequent `Fn::ImportValue` lookups for those exports correctly
   * return "not found" (rather than serving stale values from the
   * derived-view index until the next rebuild). Strong-reference
   * checks ignore this field and always scan state.json directly.
   */
  exportIndexStore?: ExportIndexStore;

  /**
   * Escape-hatch resource types (from `--allow-unsupported-types`). Applied to
   * both the caller's registry and any region-scoped registry the runner spins
   * up, so a stack deployed with the flag can also be destroyed.
   */
  allowUnsupportedTypes?: string[];

  /**
   * Issue [#808] — best-effort structured deployment-event recorder.
   * When supplied, the runner emits one RESOURCE_STARTED /
   * RESOURCE_SUCCEEDED / RESOURCE_FAILED / RESOURCE_RETAINED /
   * RESOURCE_SKIPPED event per
   * resource it deletes (operation always DELETE), plus zero or more
   * RESOURCE_GUARD_INDETERMINATE events ALONGSIDE that outcome (issue
   * [#2301](https://github.com/go-to-k/cdkd/issues/2301)). `record()` is
   * synchronous and never throws. The CALLER (`cdkd destroy`) owns the
   * RUN_STARTED / RUN_FINISHED events and `finalize()`s the recorder. When
   * `undefined` the runner behaves exactly as before #808 (events are a
   * no-op) — which is what `cdkd state destroy` gets today, since it passes
   * no recorder at all. Error + metadata only — never resource properties.
   */
  eventRecorder?: DeploymentEventRecorder;
}

/**
 * Outcome of destroying a single stack.
 */
export interface DestroyRunnerResult {
  /** Stack name we operated on. */
  stackName: string;
  /** True if the user declined the confirmation prompt — caller may skip cleanup. */
  cancelled: boolean;
  /** True if the stack already had no resources and we just dropped the state file. */
  skippedEmpty: boolean;
  /** Number of resources successfully deleted (idempotent "already gone" counts). */
  deletedCount: number;
  /**
   * Number of resources skipped because they carry `DeletionPolicy: Retain`
   * (or `RetainExceptOnCreate`) in cdkd state. The AWS resource is kept;
   * only the cdkd state record for it is dropped (state.json is removed
   * wholesale at the end of a clean destroy). v5+ records the attribute
   * on every successful create/update via `state.deletionPolicy`; pre-v5
   * state has `deletionPolicy: undefined` here, so this branch is a no-op
   * for legacy state — preserves the pre-PR "delete every resource in
   * state" behavior until the resource is re-deployed under v5.
   * `runDestroyForStack` is template-less by design (both `cdkd destroy`
   * and `cdkd state destroy` route through it after synth/state load), so
   * the template's `DeletionPolicy` is NOT consulted here — only state
   * is. The synth-driven `cdkd deploy` DELETE path inside DeployEngine
   * does consult the template (state preferred, template fallback) for
   * pre-v5-state mid-flight back-compat.
   * Counted separately from `deletedCount` so the summary line
   * distinguishes the user-intent "do not delete" from the AWS-side
   * "delete succeeded".
   */
  retainedCount: number;
  /**
   * Number of resources whose provider reported `{ outcome: 'skipped' }` —
   * cdkd could NOT address the resource, so it may still be ALIVE (issue
   * [#1752](https://github.com/go-to-k/cdkd/issues/1752)). The producers are
   * enumerated on `ResourceDeleteResult` in `src/types/resource.ts`, which is
   * the single source of truth — deliberately NOT restated here (issue
   * [#1803](https://github.com/go-to-k/cdkd/issues/1803): this copy said "two
   * producers today" and went stale three times, once per lane that added
   * one). What matters at THIS layer is that it counts ROWS NOT DESTROYED,
   * and a row can be a whole nested stack — see the note on the CLI's
   * aggregate message.
   *
   * Distinct from every neighbouring counter:
   * - `deletedCount` — cdkd addressed it (a delete was issued, or the
   *   resource was already gone). Before #1752 a skip landed here, which is
   *   the bug: the summary reported success over a resource nothing touched.
   * - `retainedCount` — user INTENT (`DeletionPolicy: Retain`). Keeping the
   *   AWS resource is the requested outcome, and the state record is dropped.
   * - `errorCount` — a delete was attempted and FAILED. A skip never reached
   *   AWS, so labelling it an error would misdescribe it (and would make the
   *   summary print it as a failure).
   *
   * The state record is DELIBERATELY KEPT for a skipped resource (it stays in
   * `remainingResources`, so the preserve-write below carries it), because
   * dropping it is the second half of the data loss: the user would end up
   * with neither the AWS resource deleted nor a cdkd record pointing at it.
   * `> 0` therefore also forces state preservation and a non-zero exit, the
   * same contract `errorCount > 0` / `interrupted` already carry.
   */
  skippedCount: number;
  /**
   * Number of PRE-FLIGHT SAFETY GUARDS that ran during this destroy, could
   * NOT reach a verdict, and were therefore not enforced — cdkd proceeded
   * anyway (issue [#2301](https://github.com/go-to-k/cdkd/issues/2301)).
   * Counted per GUARD, not per resource: one resource can in principle trip
   * more than one, and the number a reader wants is how many checks were
   * suppressed.
   *
   * Orthogonal to every counter above, and to the run's outcome. A guard that
   * could not answer says nothing about whether the resource was deleted, so
   * this NEVER moves `deletedCount` / `skippedCount` / `errorCount`, never
   * forces state preservation, and never changes the exit code. It exists
   * because the ephemeral `logger.warn` a provider emits is not evidence
   * after the run: the attack these guards exist to catch works by DENYING
   * the probe (an `s3:GetBucketLocation` `Deny` in a bucket policy), so a
   * destroy that proceeded WITHOUT confirming its target must not be
   * indistinguishable, afterwards, from one that confirmed it. The durable
   * half is the `RESOURCE_GUARD_INDETERMINATE` events; this counter is the
   * summary half.
   *
   * STATED LIMITS, measured rather than assumed. Three, and the first two are
   * about this counter never being reached at all:
   *
   * A guard is reported by RETURNING it, so a delete that THROWS after an
   * unanswerable probe emits no row and increments nothing — the loop that
   * reads it sits inside the `try`. Unreachable through
   * `CloudControlProvider` today (its `NotFound` arm returns rather than
   * throwing, and every other throw is a genuine failure), but it is why the
   * event is documented as accompanying a SUCCEEDED or SKIPPED row and not a
   * `RESOURCE_FAILED` one.
   *
   * `cdkd deploy` drops it entirely: the deploy engine's `provider.delete`
   * sites consume `deleteSkipReason` and never read `indeterminateGuards`, so
   * the same guard suppressed on a template-DELETE / replacement / recreate
   * branch leaves no durable trace. Filed as go-to-k/cdkd#2422.
   *
   * And a guard suppressed inside a NESTED-STACK CHILD is invisible here. `NestedStackProvider.delete` drives
   * `runDestroyForStack` for the child with a context carrying no
   * `eventRecorder` (see its argument list), so the child records no events at
   * all, and it reports only counts upward — this counter has no channel to
   * roll up through. That is the same pre-existing shape `RESOURCE_SKIPPED`
   * has on that path, not a regression introduced here; closing it is
   * go-to-k/cdkd#2422's class of work.
   */
  guardIndeterminateCount: number;
  /** Number of resources that failed to delete. State is preserved on >0 errors. */
  errorCount: number;
  /**
   * True when a graceful SIGINT (issue #816) stopped the destroy early. The
   * in-flight deletes finished, the (trimmed) state was preserved, and the
   * lock was released — but resources may remain, so the caller surfaces a
   * non-zero exit. Distinct from `errorCount > 0` (a resource actually failed
   * to delete): an interrupt is a user-requested stop, not a failure.
   */
  interrupted: boolean;
}

/**
 * Resource-type → state-property name pairs that gate AWS deletion
 * protection. Used by the `--remove-protection` confirmation prompt to
 * report a best-effort count of resources that will have protection
 * cleared. The actual flip-off is unconditional inside each provider's
 * `delete()` (idempotent — safe when AWS already has protection off),
 * so the count is informational only.
 *
 * Most types use a boolean flag — the value `true` is what we count.
 * Two types use a string-valued enum (Cognito UserPool's
 * `DeletionProtection` is `'ACTIVE' | 'INACTIVE'`, AutoScalingGroup's
 * `DeletionProtection` is `'none' | 'prevent-force-deletion' |
 * 'prevent-all-deletion'`). For those, the helper checks against a
 * per-type set of "active" values via `PROTECTION_ACTIVE_VALUES_BY_TYPE`.
 *
 * Exported for unit-test coverage of `countProtectedResources`.
 */
/**
 * The nested-stack resource type. A skipped row of this type means the CHILD
 * stack was not destroyed, and the record a user must repair lives in the
 * child's own state file (`<parent>~<logicalId>`) — see `skippedStateTargets`.
 */
const NESTED_STACK_TYPE = 'AWS::CloudFormation::Stack';

/**
 * Where a type's protection flag lives in a resource's property bag: a
 * top-level key, a PATH of keys for a flag nested in a container, or a reader
 * for a flag that is not at a fixed path (go-to-k/cdkd#3676). A reader gets the
 * bag and the record's region.
 */
export type ProtectionLocator =
  | string
  | readonly string[]
  | ((bag: Record<string, unknown>, region: string | undefined) => unknown);

/**
 * The protection flag per type. `countProtectedResources` reads it the same
 * way in `properties` and then `observedProperties`.
 */
export const PROTECTION_PROPERTY_BY_TYPE: Record<string, ProtectionLocator> = {
  'AWS::Logs::LogGroup': 'DeletionProtectionEnabled',
  'AWS::RDS::DBInstance': 'DeletionProtection',
  'AWS::RDS::DBCluster': 'DeletionProtection',
  // DocDB: cluster-level only. The DocDB DBInstance shape does NOT
  // expose a DeletionProtection field (verified against the
  // @aws-sdk/client-docdb CreateDBInstanceMessage type — the field is
  // absent), so there is nothing to flip on destroy of an instance.
  'AWS::DocDB::DBCluster': 'DeletionProtection',
  // Neptune: both cluster and instance expose DeletionProtection.
  'AWS::Neptune::DBCluster': 'DeletionProtection',
  'AWS::Neptune::DBInstance': 'DeletionProtection',
  'AWS::DynamoDB::Table': 'DeletionProtectionEnabled',
  // CFn and CDK put the flag on the local replica
  // (`Replicas[?Region==<region>].DeletionProtectionEnabled`); the provider's
  // `readCurrentState` writes it top-level. `extractLocalDeletionProtection`
  // reads the replica first and the top-level key second, as `create()` does.
  'AWS::DynamoDB::GlobalTable': (bag, region) => extractLocalDeletionProtection(bag, region ?? ''),
  'AWS::EC2::Instance': 'DisableApiTermination',
  'AWS::Cognito::UserPool': 'DeletionProtection',
  'AWS::AutoScaling::AutoScalingGroup': 'DeletionProtection',
  // The flag is one entry of the `LoadBalancerAttributes` key/value list, its
  // value the string `'true'` / `'false'`.
  'AWS::ElasticLoadBalancingV2::LoadBalancer': (bag) => {
    const attrs = bag['LoadBalancerAttributes'];
    if (!Array.isArray(attrs)) return undefined;
    const entry: unknown = attrs.find(
      (a: unknown) =>
        typeof a === 'object' &&
        a !== null &&
        (a as { Key?: unknown }).Key === 'deletion_protection.enabled'
    );
    return (entry as { Value?: unknown } | undefined)?.Value;
  },
  // EMR's termination protection sits inside the `Instances` block, in the
  // template and in the provider's `readCurrentState` bag alike.
  'AWS::EMR::Cluster': ['Instances', 'TerminationProtected'],
  // CC-routed generic protection flip (issues #1312 / #1314) — see
  // src/provisioning/cc-protection-properties.ts.
  'AWS::DSQL::Cluster': 'DeletionProtectionEnabled',
  'AWS::NeptuneGraph::Graph': 'DeletionProtection',
  'AWS::SMSVOICE::ProtectConfiguration': 'DeletionProtectionEnabled',
  'AWS::VerifiedPermissions::PolicyStore': 'DeletionProtection',
  'AWS::EKS::Cluster': 'DeletionProtection',
  'AWS::RDS::GlobalCluster': 'DeletionProtection',
  'AWS::DocDB::GlobalCluster': 'DeletionProtection',
};

/**
 * For string-valued protection enums, the set of values that count as
 * "currently protected". Types absent from this map use the default
 * (boolean `true`).
 */
export const PROTECTION_ACTIVE_VALUES_BY_TYPE: Record<string, ReadonlySet<unknown>> = {
  'AWS::Cognito::UserPool': new Set(['ACTIVE']),
  'AWS::AutoScaling::AutoScalingGroup': new Set(['prevent-force-deletion', 'prevent-all-deletion']),
};

/**
 * For object-shaped protection properties, a predicate deciding whether the
 * recorded value counts as "currently protected". Checked before the
 * enum-set / boolean defaults. VerifiedPermissions PolicyStore's
 * `DeletionProtection` is `{Mode: 'ENABLED' | 'DISABLED'}` (issue #1314).
 */
export const PROTECTION_ACTIVE_PREDICATE_BY_TYPE: Record<string, (value: unknown) => boolean> = {
  'AWS::VerifiedPermissions::PolicyStore': (value) =>
    typeof value === 'object' && value !== null && (value as { Mode?: unknown }).Mode === 'ENABLED',
};

/**
 * The flag's recorded value in `bag`. A missing or torn container on the way
 * (`null`, a string, a list) yields `undefined`, which leaves the count to the
 * other bag rather than throwing mid-prompt.
 */
function readProtection(
  bag: unknown,
  locator: ProtectionLocator,
  region: string | undefined
): unknown {
  if (typeof locator === 'function') {
    if (typeof bag !== 'object' || bag === null || Array.isArray(bag)) return undefined;
    return locator(bag as Record<string, unknown>, region);
  }
  let value: unknown = bag;
  for (const key of typeof locator === 'string' ? [locator] : locator) {
    if (value === null || value === undefined) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * An OWN entry of one of the per-type maps. A plain-object map answers a
 * `resourceType` of `constructor` or `__proto__` with an inherited value, and a
 * hand-edited record can carry one.
 */
function perType<T>(map: Record<string, T>, resourceType: unknown): T | undefined {
  return typeof resourceType === 'string' && Object.hasOwn(map, resourceType)
    ? map[resourceType]
    : undefined;
}

/**
 * Count how many resources in a stack's recorded state appear to have
 * deletion protection enabled, reading each type's flag through its
 * `PROTECTION_PROPERTY_BY_TYPE` locator in `properties` and in
 * `observedProperties`.
 */
export function countProtectedResources(state: StackState): number {
  let count = 0;
  for (const resource of Object.values(state.resources ?? {})) {
    const locator = perType(PROTECTION_PROPERTY_BY_TYPE, resource.resourceType);
    if (locator) {
      const activePredicate = perType(PROTECTION_ACTIVE_PREDICATE_BY_TYPE, resource.resourceType);
      const activeValues = perType(PROTECTION_ACTIVE_VALUES_BY_TYPE, resource.resourceType);
      const isActive = (recorded: unknown): boolean =>
        activePredicate
          ? activePredicate(recorded)
          : activeValues
            ? activeValues.has(recorded)
            : // `'true'` too: a String parameter or an `Fn::If` resolves a CFn
              // boolean to a string, and the providers flip it all the same.
              isTruthyCfnBoolean(recorded);
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
 * Run the destroy lifecycle for one stack against an already-loaded
 * `StackState`, reusing the caller's state backend / lock manager.
 *
 * Hoisted from `cdkd destroy` so the new `cdkd state destroy` subcommand
 * can call into the exact same per-stack pipeline without depending on
 * synth or the CDK app. The state-source split is the only meaningful
 * difference between the two commands — everything from "prompt the user"
 * onwards is identical.
 *
 * Side effects:
 * - Acquires (and releases) the stack's S3 lock.
 * - Switches `process.env.AWS_REGION` for the duration of the destroy when
 *   the stack's recorded region differs from `baseRegion`. Restored in the
 *   `finally` block.
 * - Persists state incrementally during the delete loop (issue #804):
 *   each successfully deleted resource is removed from the state object
 *   and the trimmed state is written back to S3, mirroring deploy's
 *   `saveStateAfterResource`. An interrupted destroy therefore leaves a
 *   state file listing only resources that still exist, so a re-run does
 *   not replay deletes against already-deleted resources. Persist
 *   failures are logged and never fail the destroy. Every persisted
 *   destroy snapshot CLEARS `outputs` (and drops `imports` / `outputReads`)
 *   so a partial-destroy state never advertises an export / import whose
 *   backing resource is gone — the in-memory `state` the strong-ref check
 *   above reads is untouched.
 * - On full success, deletes the state file. On any failure, the state
 *   file is preserved (trimmed to the remaining resources, outputs/imports
 *   cleared) so the user can retry.
 */
export async function runDestroyForStack(
  stackName: string,
  state: StackState,
  ctx: DestroyRunnerContext
): Promise<DestroyRunnerResult> {
  const logger = getLogger();
  const result: DestroyRunnerResult = {
    stackName,
    cancelled: false,
    skippedEmpty: false,
    deletedCount: 0,
    retainedCount: 0,
    skippedCount: 0,
    guardIndeterminateCount: 0,
    errorCount: 0,
    interrupted: false,
  };
  // Issue #2301: the logical ids whose delete proceeded with a guard that
  // could not answer. Named in the aggregate warning so the operator can go
  // straight to `cdkd events` for the reason rather than scrolling back.
  const guardIndeterminateTargets = new Set<string>();

  // Region is load-bearing on the new state-key layout (PR 1). Fall back to
  // the caller's baseRegion only for legacy `version: 1` records that never
  // recorded one. Resolved HERE, above the two refusals, because both name the
  // record they refuse and neither may be reached with the count already taken.
  const regionForState = state.region ?? ctx.baseRegion;
  // AT THE TOP OF THE DESTROY, and ABOVE THE COUNT BELOW (issue #3161).
  //
  // `parseStateBody` validates the root object and the schema version and
  // nothing inside, so a hand-edited or truncated record reaches this function
  // with `resources` holding a string, a list, a number, a boolean or `null`.
  // `Object.keys` answers three different ways over those, and the middle
  // answer is the damaging one: a `[]`, a `5` or a `true` enumerates NO keys,
  // so `resourceCount` is 0 and — with no orphans — the run takes the
  // empty-stack fast path a few lines down, which deletes `state.json` with no
  // confirmation at all. The destroy reports success having deleted nothing,
  // and every resource the record named is still live in AWS with the only
  // record of what they were now gone. A string enumerates one fabricated
  // logical id per character instead, and a `null` throws a bare `TypeError`.
  //
  // REFUSE rather than repair, and the read-only repair is not the safe half
  // here: reading the bag as EMPTY *is* the fast path, byte-identical to the
  // `[]` case. `malformedDestroyResourcesRefusalMessage` carries that
  // measurement and names `cdkd state orphan` for an operator who does want
  // the record gone.
  //
  // The DISCRIMINATOR is the container's SHAPE, never its size: a legitimately
  // empty `{}` and an unreadable `[]` both count 0, so only `isReadableBag`
  // separates them — which is why this cannot be folded into the
  // `resourceCount === 0` test below.
  refuseMalformedResourcesForDestroy(state, stackName, regionForState);
  // The ROWS of a readable map (go-to-k/cdkd#3202), BELOW the bag guard: an
  // unreadable bag has no rows to name. Every walk below reads
  // `resource.resourceType` per row and validates nothing — the listing above
  // the prompt first — and the delete loop routes on it, so a row that is not a
  // record takes one of three routes (measured, see the refusal's JSDoc): a
  // `null` row is a bare `TypeError` in that listing; a `false` / `0` / `''`
  // row is FALSY at the loop's `if (!resource)` guard, skipped as "not found in
  // state", and the record then removed with its resource live; any other
  // unreadable row — unless its own `deletionPolicy` takes the retention branch
  // first — is a provider call on whatever its type field holds and an
  // unchecked physical id. REFUSE rather than skip, for the reason the bag
  // guard gives: the map IS the list of what to delete, and a skipped row's
  // resource stays live in AWS with the record that named it removed.
  refuseMalformedResourceEntriesForDestroy(state, stackName, regionForState);
  // The `orphans` CONTAINER (go-to-k/cdkd#3379). The orphan warning below reads
  // it on `?? []`, so an unreadable one counts 0 and this run would delete every
  // resource and then the record with its orphan evidence never reported.
  refuseMalformedOrphansForDestroy(state, stackName, regionForState);
  // The ROWS of a readable list (go-to-k/cdkd#3500): the listing below prints
  // each row from fields it validates none of, and filters nothing — so what an
  // unusable row does there depends on which part is torn, which is why this is
  // a refusal rather than a drop.
  refuseMalformedOrphanRecordsForDestroy(state, stackName, regionForState);
  // BELOW the bag guard (which proves the bag can be counted) and ABOVE the
  // delete loop and every `deleteState` (issue #3328, review round 1). NOT
  // "above the fast path" as a discriminating claim — the guard returns early
  // on a zero count, which is that path's own condition, so the two can never
  // disagree; what the placement buys is that no delete is issued and no record
  // removed before the verdict. `getState` adopts the KEY's region, which is right for the lock
  // and the record — but a record whose BODY named a different one is the one
  // shape that gives two answers to "where are the resources", and the delete
  // loop below reads a `*NotFound` as ALREADY DELETED. Without this the wrong
  // answer is a whole stack reported destroyed, its record removed, and every
  // resource still live in the other region. Narrow by construction: divergent
  // AND resource-bearing, so the resource-less recovery destroy this issue's
  // own repro exercises still runs.
  refuseDivergentRecordRegionForDestroy(state, stackName, regionForState, ctx.divergentBodyRegion);
  const resourceCount = Object.keys(state.resources).length;
  // A stack that still has `DeletionPolicy: Retain` resources standing in AWS
  // is NOT empty (issue #2934), even with no rows in `resources`. The record of
  // them is the only thing that lets a later deploy re-adopt them instead of
  // colliding with the deterministic names they hold, and the fast path below
  // deletes state.json with no confirmation at all — in exactly the
  // first-deploy-fails flow that produces this shape.
  const orphanCount = (state.orphans ?? []).length;
  // AT THE TOP OF THE DESTROY, and REFUSE rather than repair (issue #3207).
  //
  // `parseStateBody` validates the root object and the schema version and
  // nothing inside, so a hand-edited or truncated record reaches this function
  // with `outputs` holding a string, a list, a number, a boolean or `null`. The
  // only thing this runner does with the bag is the strong-reference decision
  // below (`Object.keys(state.outputs).length > 0`), and BOTH answers are
  // fabricated on such a record — a string invents six export names, a `null`
  // reads as "exports nothing" and SKIPS the cross-stack scan entirely. Reading
  // the bag as empty, which is the read-only repair, IS that second answer, so
  // there is no repair available here: see
  // `malformedDestroyOutputsRefusalMessage`.
  //
  // Here rather than beside the decision so no later read of `state` in this
  // function can be reached with an unreadable bag — the placement rule
  // `repairMalformedResourcesForReadOnly`'s note records. It dominates all
  // THREE callers (`cdkd destroy`, `cdkd state destroy`, and
  // `NestedStackProvider.delete`'s child destroy), none of which reads the bag
  // before handing the record over.
  //
  // The `resources` bag is a separate container with a separate absence rule,
  // refused separately just above (go-to-k/cdkd#3161) so the message a user
  // sees names the container that is actually broken.
  refuseMalformedOutputsForDestroy(state, stackName, regionForState);
  if (resourceCount === 0 && orphanCount === 0) {
    // Issue #2171: this used to delete the state record with NO lock at all,
    // sitting well above the acquire further down. A record reads as empty for
    // exactly one interval that is not idle — the start of a concurrent
    // `cdkd deploy`, before its first resource lands — so the unlocked delete
    // removed the state file out from under a live deploy holding the lock.
    //
    // Take the lock, then RE-READ: the snapshot this function was handed was
    // taken by the caller before any of this, so emptiness has to be
    // re-established under the lock rather than inherited from it.
    logger.info(`Stack ${stackName} has no resources, cleaning up state...`);
    // Issue #1348's rule applies to THIS acquire too, and the fence in
    // `tests/unit/cli/signal-before-lock-ordering.test.ts` caught the first
    // cut of this fix without one: register the handler BEFORE acquiring, or a
    // Ctrl-C landing between the acquire and the release strands the lock for
    // its full TTL. The window is short but it covers an S3 read and two S3
    // writes. `lockHeld` gates the release exactly as the main path's does, so
    // a signal arriving before the acquire returns cannot delete a lock this
    // process does not own.
    let emptyLockHeld = false;
    let emptyInterrupted = false;
    const emptySigintHandler = (): void => {
      // TWO-SIGNAL contract, matching the main handler below. The first cut of
      // this branch force-quit on the FIRST signal, which is a REGRESSION and
      // not merely impolite: a nested-stack child reaches here through
      // `NestedStackProvider.delete`, listeners fire in registration order, so
      // the PARENT's handler sets its drain flag and returns and then this one
      // would kill the process -- the parent's `finally` never runs and ITS
      // lock is stranded for the full TTL. Recording the signal and letting
      // three S3 round-trips finish is both graceful and correct here.
      if (emptyInterrupted) {
        if (emptyLockHeld) {
          void ctx.lockManager.releaseLock(stackName, regionForState).catch(() => {
            /* best-effort: the recovery line below is the real guarantee */
          });
          process.stderr.write(
            // cdkd-profile-display: the `ctx.profile` below is an ARGUMENT to
            // `forceQuitRecoveryClause`, not a value this line interpolates.
            // What is rendered is that helper's RETURN, and it sanitizes every
            // `LockRecoveryContext` fragment itself -- `displaySafe` plus an
            // EXACTNESS test, suppressing the whole command rather than naming a
            // fragment whose rendering changed (issue go-to-k/cdkd#3377; the
            // behavioural proof is in
            // `tests/unit/state/lock-contention-message.test.ts`). Sanitizing
            // here as well would be wrong, not merely redundant: the helper
            // compares the fragment against the RAW value to decide whether the
            // command can be shown at all, so a pre-sanitized argument would make
            // every altered value compare EXACT and re-open the hole.
            `\nForce-quit: stack lock may not be released.` +
              `${forceQuitRecoveryClause(stackName, regionForState, {
                profile: ctx.profile,
                stateBucket: ctx.stateBucket,
                statePrefix: ctx.statePrefix,
              })}\n`
          );
        }
        process.exit(130);
      }
      emptyInterrupted = true;
      // stderr, NOT `logger.info`, for two reasons the main handler already
      // acts on: `logger.info` reaches stdout and can EPIPE, and a throw inside
      // a SIGINT listener is UNCAUGHT -- the process would die holding the lock
      // with no recovery line; and under `cdkd deploy` (nested-stack removal)
      // the logger writes into the per-stack buffer that is only flushed at
      // stack end, so the first Ctrl-C would produce no feedback at all.
      try {
        process.stderr.write(
          `\nInterrupt received - finishing the state cleanup for ${displayStackName(stackName)} ` +
            `(press Ctrl-C again to force-quit)\n`
        );
      } catch {
        /* the drain itself is what matters; the notice is best-effort */
      }
    };
    process.setMaxListeners(Math.max(process.getMaxListeners(), 100));
    process.on('SIGINT', emptySigintHandler);
    let emptyAcquired: boolean;
    try {
      emptyAcquired = await ctx.lockManager.acquireLock(
        stackName,
        regionForState,
        undefined,
        'destroy'
      );
    } catch (acquireErr) {
      // `acquireLock` THROWS (a LockError) on an S3 failure, as distinct from
      // returning `false` on contention -- and only the boolean path below
      // removed the listener, so a 5xx / AccessDenied leaked a handler that
      // then pre-empts every later drain. Both sibling sites already wrap
      // their acquire for exactly this.
      process.removeListener('SIGINT', emptySigintHandler);
      throw acquireErr;
    }
    if (!emptyAcquired) {
      process.removeListener('SIGINT', emptySigintHandler);
      throw new Error(
        await buildLockContentionMessage({
          lockManager: ctx.lockManager,
          stackName,
          region: regionForState,
          recovery: {
            profile: ctx.profile,
            stateBucket: ctx.stateBucket,
            statePrefix: ctx.statePrefix,
          },
        })
      );
    }
    emptyLockHeld = true;
    try {
      const recheck = await ctx.stateBackend.getState(stackName, regionForState);
      // The SECOND record this function counts, and it needs the same guard as
      // the first (issue #3161). The re-read exists because emptiness has to be
      // established UNDER the lock, so what it returns is a different object
      // from the one the entry guard cleared — a concurrent writer, or a hand
      // edit landing between the two reads, can make it unreadable. The count
      // below would then be 0, `stillEmpty` would be true, and `deleteState`
      // would run on the very line the re-read exists to protect.
      if (recheck) {
        refuseMalformedResourcesForDestroy(recheck.state, stackName, regionForState);
        // The ROWS of the re-read map (go-to-k/cdkd#3202), for the reason the
        // orphan-row guard below is owed here rather than the container's: any
        // row at all makes `recheckResources >= 1`, so this path does not delete
        // either way — what the guard buys is WHICH refusal the operator gets.
        // Without it the run stops at the "not empty" branch, which says the
        // record still holds resources and nothing about the row it could not read.
        refuseMalformedResourceEntriesForDestroy(recheck.state, stackName, regionForState);
        // The re-read is the record `stillEmpty` and `deleteState` act on, so
        // the container guard is owed here as well as at the entry read.
        // `stillEmpty` reads `(recheck.state.orphans ?? []).length`, and the
        // shapes split three ways (measured): `null`, `''` and `{length: 0}`
        // count 0 and REACH the delete; a string or `{length: N}` counts
        // non-zero; a number, an object or a boolean yields `undefined`, which
        // fails the `=== 0` test and stops the run with no cause named
        // (go-to-k/cdkd#3379).
        refuseMalformedOrphansForDestroy(recheck.state, stackName, regionForState);
        // Owed at the re-read, but NOT for the same reason as the container guard
        // above it, and the difference is worth stating (go-to-k/cdkd#3641,
        // maintainer item o4). The container guard is about `deleteState`: an
        // unreadable container counts 0, so the record is removed with its orphan
        // evidence never reported. A ROW cannot reach that outcome — any row at all
        // makes `recheckOrphans >= 1`, so this path does not delete either way.
        // What the row guard buys here is WHICH refusal the operator gets: without
        // it the run stops at the "not empty" branch, which says the record still
        // holds orphans and nothing about the row it could not read.
        refuseMalformedOrphanRecordsForDestroy(recheck.state, stackName, regionForState);
      }
      const recheckResources = recheck ? Object.keys(recheck.state.resources).length : 0;
      const recheckOrphans = recheck ? (recheck.state.orphans ?? []).length : 0;
      // Same widening as the entry check (issue #2934): a record that gained
      // ONLY orphan entries is still not empty, and deleting it would drop the
      // only trace of live, billing AWS resources.
      const stillEmpty = !recheck || (recheckResources === 0 && recheckOrphans === 0);
      if (!stillEmpty) {
        // A concurrent writer populated the record between the caller's read
        // and this lock. Deleting now would drop resources cdkd tracks, so
        // refuse and let the user re-run against the record as it now stands.
        //
        // The message names BOTH counts: a state that gained only orphan
        // records would otherwise read `0 resource(s)`, which contradicts the
        // refusal it is explaining.
        throw new Error(
          `Stack ${displayStackName(stackName)} (${displaySafe(regionForState)}) was empty when this run started but ` +
            `now has ${recheckResources} resource(s) and ${recheckOrphans} rollback-orphaned ` +
            `resource(s) — another cdkd process wrote to it. Re-run the destroy to act on ` +
            `the current state.`
        );
      }
      await ctx.stateBackend.deleteState(stackName, regionForState);
      logger.info(`${green('✓')} State deleted`);
    } finally {
      // Release BEFORE unregistering, matching the strong-ref path below: the
      // reverse order leaves the lock held with no handler, so a Ctrl-C in the
      // release round-trip becomes a 30-minute stranded lock.
      try {
        await ctx.lockManager.releaseLock(stackName, regionForState);
      } catch (releaseErr) {
        logger.warn(
          `Failed to release lock after empty-state cleanup: ${describeAwsFailure(releaseErr).detail}`
        );
      } finally {
        process.removeListener('SIGINT', emptySigintHandler);
      }
    }
    result.skippedEmpty = true;
    // NOTHING is published to `result.interrupted` here, and that absence is
    // the point. This branch has just DELETED the state record, so by the
    // ownership rule the outer `finally` states — `result.interrupted` answers
    // "did THIS stack finish, or is there work left in it?" — the answer is
    // "it finished". There is no preserved state to re-run against and no
    // resource left to delete; the stack's record is gone.
    //
    // A `||= emptyInterrupted` used to sit here, and it reproduced the exact
    // defect the outer re-sync's `&& statePreserved` gate was added to close,
    // ~950 lines above the gate and BEFORE the main `try`/`finally` that
    // carries it. `destroy.ts` then threw `Destroy interrupted by Ctrl-C.
    // State preserved -- re-run 'cdkd destroy' to finish` and exited 2 over a
    // stack whose state file no longer exists, and (since `--purge-events`
    // moved onto this same per-stack flag) additionally skipped the purge for
    // a stack with no state left to post-mortem. Both halves of that sentence
    // false, for the same reason they were false on the main path.
    //
    // Its stated purpose -- "otherwise `destroy --all` walks on to the next
    // stack" -- is served by the command-scoped `watchCommandInterrupt`, which
    // BOTH destroy loops read live via `runInterrupted()` since issue #2117.
    // That is the same argument the outer re-sync's own comment makes for the
    // main path; this branch simply had not been re-read under it.
    //
    // Note the alternative of publishing a `statePreserved`-style flag here is
    // wrong rather than merely unnecessary: on this branch nothing IS
    // preserved, so the gate would be permanently false and the line would be
    // dead code claiming to gate something.
    return result;
  }

  // Strong-reference check (schema v4): refuse to destroy if any other
  // stack's `state.imports[]` still references this stack's outputs via
  // Fn::ImportValue. Matches CloudFormation's behavior of rejecting
  // DeleteStack for an exporter while an importer exists.
  //
  // Scans state.json directly rather than trusting the exports index —
  // a stale index could miss a freshly-recorded consumer and we MUST
  // not let strong-ref bypass on perf-only data. The scan only fires
  // when the stack has at least one output (= might be a producer);
  // export-less stacks short-circuit at the `outputs` length check.
  //
  // This is the PRE-FLIGHT scan — fast-fails before the user is
  // prompted to confirm a destroy that would only be refused after the
  // prompt. A second LOCK-PROTECTED scan runs further down (right after
  // we acquire the producer's lock, see below) to tighten the TOCTOU
  // window against a consumer that started deploying between the
  // pre-flight and the actual delete. Even the lock-protected scan has
  // a small residual race against a brand-new consumer deploy that
  // starts AND saves its imports[] entirely between the lock-protected
  // scan and the producer's per-resource delete loop; per-stack locks
  // can't cover cross-stack reads. This race is documented in
  // docs/cross-stack-references.md and matches the same inherent
  // limitation in CloudFormation's own strong-reference enforcement.
  const needsStrongRefCheck = !!(state.outputs && Object.keys(state.outputs).length > 0);
  if (needsStrongRefCheck) {
    const consumers = await scanActiveConsumers(stackName, regionForState, ctx);
    if (consumers.length > 0) {
      throw new StackHasActiveImportsError(stackName, regionForState, consumers);
    }
  }

  logger.info(`\nResources to be deleted (${resourceCount}):`);
  for (const [logicalId, resource] of Object.entries(state.resources)) {
    // Sanitized for the reason the orphan listing below it is, and this half
    // matters MORE: these resources really are deleted once the operator answers
    // y (go-to-k/cdkd#3641 security review). Both values come from a state
    // record, `ConsoleLogger` sanitizes extra ARGS and never the message, and a
    // `resources` key carrying a newline forges rows and a fake orphan tally into
    // the very banner the y/N answers, while an ESC run in a `resourceType`
    // redraws the lines above it.
    logger.info(`  - ${displaySafe(logicalId)} (${displaySafe(resource.resourceType)})`);
  }

  // When `--remove-protection` is set, surface a count of resources that
  // appear protected per cdkd state so the prompt names the side effect
  // explicitly. This is a best-effort signal — the real authority is
  // AWS's current state, but at confirm time we only have what cdkd
  // recorded. Resources whose state doesn't carry the protection flag
  // (or where the recorded value is `false`) are still flipped via the
  // idempotent flip-off call inside each provider's `delete()`.
  const protectedCount = ctx.removeProtection ? countProtectedResources(state) : 0;

  // Resources an earlier rollback left in AWS (issue #2934). Destroying this
  // stack deletes the state file, and with it the ONLY record that those
  // resources exist and were once cdkd's — after which nothing here can find
  // them again. They are not deleted by the destroy (they are not in
  // `resources`), so this is the last moment a user can be told.
  //
  // Listed BEFORE the prompt, and OUTSIDE the `skipConfirmation` guard, so it
  // is part of what the `y/N` answers AND still reaches a `--yes` / `--force`
  // run and a nested-stack child (which the parent invokes with
  // `skipConfirmation: true`). A flagged run has declined to be ASKED, not to
  // be told that live resources stop being tracked.
  const orphansAtDestroy = state.orphans ?? [];
  if (orphansAtDestroy.length > 0) {
    logger.info(
      `\n${orphansAtDestroy.length} resource(s) are still in AWS from an earlier failed deploy. ` +
        `cdkd left them there because their DeletionPolicy is Retain (CDK's ` +
        `RemovalPolicy.RETAIN), and has been tracking them so a later deploy of this stack ` +
        `could adopt them back instead of colliding with their names.`
    );
    logger.info(
      `Destroying this stack deletes that record. The resources stay in AWS, may continue to ` +
        `incur charges, and cdkd will no longer know about them:`
    );
    for (const entry of orphansAtDestroy) {
      // Every field sanitized (go-to-k/cdkd#3500 security review). The row guard
      // above validates the record's SHAPE, not the CONTENT of the three strings
      // printed here, and all of them come from a state record: measured, a
      // `physicalId` carrying a newline forged an extra row AND a fake
      // "(0 resources left)" tally into the banner the operator's y/N answers,
      // and a `resourceType` carrying an ESC run redrew the lines above it.
      //
      // `displaySafe`, deliberately NOT `displayIdent`, and the difference is
      // LOSSINESS rather than strictness. This listing is the operator's only
      // notice of which resources stop being tracked, and the record is deleted
      // once they answer y — so a rendering that drops part of an identifier
      // leaves them unable to find in AWS what cdkd just forgot. `displayIdent`
      // drops two legitimate classes here: a physical id is provider-defined and
      // NOT ASCII-bounded (a Custom Resource may return `customer-<non-ASCII>`,
      // which renders as `"customer-"`), and it is not length-bounded either —
      // `SnsTopicPolicyProvider` stores a COMMA-JOINED topic ARN list, which
      // passes 2048 at ~50 topics, so no cap is the right cap. What the operator
      // needs protection from is the FORGED ROW and the screen redraw, and the
      // denylist closes both: the newline becomes a space and the escape is
      // stripped.
      //
      // Residual, stated rather than implied away: `displaySafe` TRIMS, so a
      // provider-defined id with LEADING or TRAILING whitespace renders without
      // it — ` customer-x ` and `customer-x` are one line here (measured). That
      // is information loss in the same notice, accepted rather than fixed,
      // because closing it needs a lossless escaping renderer this module should
      // not invent: the quoting helper that exists (`displayIdent`) answers it by
      // dropping MORE. What IS preserved is every printable interior character,
      // which is what makes the id findable in AWS — an interior control
      // character becomes a space, by the same rule that defuses the forged row.
      logger.info(
        `  - ${displaySafe(entry.logicalId)} (${displaySafe(entry.state.resourceType)})  ` +
          `${displaySafe(entry.state.physicalId)}`
      );
    }
  }

  if (!ctx.skipConfirmation) {
    // Issue #2259: refuse a NON-INTERACTIVE run before the interface exists.
    //
    // `rl.question` never settles when stdin is already at EOF, and EOF
    // delivers no signal, so nothing wakes it. Measured on Node 24.15.0, the version `.node-version` pins (and 24.19 before it) against
    // real `node:readline/promises`: `echo y |` resolves `"y"`, while both
    // `printf 'y' |` (a real answer with no trailing newline) and
    // `< /dev/null` stay pending indefinitely. Without this guard
    // `cdkd destroy <stack>`, `cdkd destroy --all` and
    // `cdkd state destroy <stack>` without `--yes` / `--force` parked forever
    // in CI on nothing more than an absent stdin -- a hang, not a failure, so
    // the job burned its whole timeout budget before reporting anything.
    //
    // REFUSE rather than auto-confirm. `deploy.ts` takes the other branch
    // (`!process.stdin.isTTY` -> proceed), but a deploy that assumes "yes" is
    // recoverable and a destroy is not: silently answering "yes" on behalf of
    // an absent operator would delete every resource in the stack. Four
    // prompts already refuse -- `gc.ts`, `bootstrap-destroy.ts`,
    // `recreate-confirm-prompt.ts` and `prefix-migration-check.ts` all test
    // `isTTY` before creating the interface -- and issue #2247 chose the same
    // refusal for `state destroy --all`'s BATCH
    // prompt one layer up. This is the per-stack twin of that guard, so the
    // two layers of the same command now agree.
    //
    // Only TWO of those four share the error SHAPE copied here: `gc.ts` and
    // `bootstrap-destroy.ts` throw `CdkdError` with `NON_INTERACTIVE_CONFIRM`.
    // The other two throw a bare `Error` (`recreate-confirm-prompt.ts`,
    // `prefix-migration-check.ts`). Matching the two that carry the code is
    // deliberate: a destroy refusal is something CI should be able to branch
    // on. (An earlier comment in this repo claimed they all carried the code;
    // that was measured false -- do not restore it.) There were FIVE until
    // `cdkd migrate` was removed (issue #2572); its prompt threw a
    // `LocalMigrateError`.
    //
    // Position is load-bearing: this sits AFTER the `--yes` / `--force`
    // short-circuit, so a non-interactive run that already passed a flag never
    // consults stdin at all, and after the resource banner, so the refusal
    // still names what would have been destroyed. Nested-stack children reach
    // this function with `skipConfirmation: true` (the parent already
    // confirmed the cascade), so a cascading destroy is unaffected.
    if (process.stdin.isTTY !== true) {
      throw new CdkdError(
        `The destroy confirmation prompt for stack ${displayStackName(stackName)} cannot run in a ` +
          'non-interactive environment. Pass --yes / -y to confirm the destroy ' +
          '(cdkd destroy also accepts -f / --force), or run the command from a real ' +
          'terminal.',
        'NON_INTERACTIVE_CONFIRM'
      );
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const prompt = ctx.removeProtection
      ? `\nAbout to destroy ${resourceCount} resources from stack ${displayStackName(stackName)}, ` +
        `REMOVING DELETION PROTECTION on ${protectedCount} of them. Continue? (y/N): `
      : `\nAre you sure you want to destroy stack ${displayStackName(stackName)} and delete all ${resourceCount} resources? (Y/n): `;
    const answer = await rl.question(prompt);
    rl.close();
    const trimmed = answer.trim().toLowerCase();
    // `--remove-protection` flips the default to "no" because the side
    // effect is destructive beyond the basic destroy — require explicit
    // 'y' / 'yes'. The bare-destroy prompt keeps its existing default-yes
    // semantics for back-compat.
    if (ctx.removeProtection) {
      if (trimmed !== 'y' && trimmed !== 'yes') {
        logger.info('Destroy cancelled');
        result.cancelled = true;
        return result;
      }
    } else if (trimmed === 'n' || trimmed === 'no') {
      logger.info('Destroy cancelled');
      result.cancelled = true;
      return result;
    }
  }

  // Switch region if stack was deployed to a different one.
  const stackRegion = state.region;
  let destroyProviderRegistry = ctx.providerRegistry;
  let destroyAwsClients: AwsClients | undefined;
  // Set the moment `AWS_REGION` is switched, so the restore below runs even
  // when the switch is only PARTIAL — a throw while building the region-scoped
  // clients / provider registry leaves the env vars switched but
  // `destroyAwsClients` unbuilt (issue #2161).
  let regionSwitched = false;
  // Restore the process-global region + AWS clients this function switched
  // (below) for a cross-region stack. Called from the main `finally` AND from
  // every exit BEFORE that `finally`'s `try` is entered — the cross-region
  // setup below, the lock-acquisition failure, and the strong-ref refusal
  // (issue #2161) — without it, ordinary lock contention (or any pre-lock
  // failure) on a cross-region destroy would leave `AWS_REGION` / the global
  // client pointed at the target stack for the rest of a `--all` run.
  // Idempotent: `regionSwitched` is claimed (cleared) FIRST, so a repeated
  // call — the success path reaches it from the main `finally` after an exit
  // path may already have run it — is a clean no-op and cannot double-destroy
  // the client. The global region / clients are restored BEFORE `destroy()`, so
  // a throwing `destroy()` cannot skip the restoration that actually matters.
  const restoreBaseRegionAndClients = (): void => {
    if (!regionSwitched) return;
    regionSwitched = false;
    const switchedClients = destroyAwsClients;
    destroyAwsClients = undefined;
    process.env['AWS_REGION'] = ctx.baseRegion;
    process.env['AWS_DEFAULT_REGION'] = ctx.baseRegion;
    setAwsClients(ctx.baseAwsClients);
    // Swallow a teardown failure: this runs from exit paths (before the SIGINT
    // listener is removed) and from the success `finally` (where a `releaseLock`
    // rejection is propagating), so a throwing `destroy()` must not skip the
    // listener removal NOR mask the error that actually matters (issue #2161).
    try {
      switchedClients?.destroy();
    } catch (destroyError) {
      logger.debug(
        `Failed to destroy region-scoped AWS clients: ${describeAwsFailure(destroyError).detail}`
      );
    }
  };
  if (stackRegion && stackRegion !== ctx.baseRegion) {
    logger.info(`Stack region: ${stackRegion}`);
    process.env['AWS_REGION'] = stackRegion;
    process.env['AWS_DEFAULT_REGION'] = stackRegion;
    regionSwitched = true;

    try {
      destroyAwsClients = new AwsClients({
        region: stackRegion,
        ...(ctx.profile && { profile: ctx.profile }),
      });
      setAwsClients(destroyAwsClients);

      destroyProviderRegistry = new ProviderRegistry();
      registerAllProviders(destroyProviderRegistry);
      destroyProviderRegistry.setCustomResourceResponseBucket(ctx.stateBucket);
      if (ctx.allowUnsupportedTypes?.length) {
        destroyProviderRegistry.allowUnsupportedTypes(ctx.allowUnsupportedTypes);
      }
    } catch (setupError) {
      // A failure here is before the main try/finally too, so restore the
      // (possibly partial) region/client switch rather than leaking it.
      restoreBaseRegionAndClients();
      throw setupError;
    }
  }

  // Live progress renderer (multi-line in-flight display at bottom of TTY).
  // Self-disables on non-TTY and when CDKD_NO_LIVE=1 is set. Created (not
  // started) BEFORE the lock acquisition below because the SIGINT handler
  // routes its notice through it; `printAbove` falls through to a direct
  // write while the renderer is not yet started.
  const renderer = getLiveRenderer();

  // Graceful SIGINT handling (issue #816, Terraform parity). The first
  // Ctrl-C flips `draining` true: the reverse-DAG delete loop below stops
  // SCHEDULING new deletes (it checks the flag before each level and before
  // dispatching each resource), but the already-dispatched in-flight
  // `provider.delete` calls in the current level are awaited to completion.
  // Control then falls through to the `finally` block, which flushes the
  // incremental save-chain (issue #804) — leaving a clean, minimal preserved
  // state — and releases the stack lock. Without this the process would die
  // mid-destroy, skip the `finally`, and strand the lock for its 30m TTL.
  //
  // A SECOND Ctrl-C bypasses graceful shutdown entirely (`process.exit(130)`)
  // — the user has decided not to wait for the in-flight call.
  //
  // Registered BEFORE `acquireLock` (issue #1348): the acquire itself plus
  // the under-lock strong-reference scan below take an S3 round-trip each,
  // and a signal landing in that window used to hit the unhandled default
  // (or the #1342 forwarder's exit-143 fallback) and strand the just-written
  // lock for its full TTL. With the handler armed first, an interrupt during
  // acquisition simply flips `draining` — the delete loop then starts no
  // work and the `finally` releases the lock. `lockHeld` gates the
  // force-quit path's best-effort release: before our acquire succeeds the
  // lock key may belong to ANOTHER process (that is what a conflicting
  // acquire is waiting on), and `releaseLock` deletes unconditionally.
  //
  // The handler reads/writes ONLY this call's closure state, and is removed in
  // the `finally` below, so no listener leaks across stacks. Nested-stack
  // destroys recurse into `runDestroyForStack`, registering one handler per
  // level — Node delivers SIGINT to every listener, so the first Ctrl-C drains
  // the parent AND every in-flight child, which is the intended behavior.
  let draining = false;
  let lockHeld = false;
  // "Did this stack finish, or is there work left in it?" — the ONE per-stack
  // answer, and the gate on the outer `finally`'s interrupt re-sync below.
  //
  // Set from `preserveState` at the moment that decision is taken (below), i.e.
  // BEFORE `deleteState` runs. `preserveState === false` means the state file
  // was removed, which is only ever done for a stack with zero errors, zero
  // skips and no interrupt — nothing to re-run. A signal arriving after that
  // point must therefore NOT be able to report this stack as interrupted; see
  // the re-sync's own comment for the window that made it possible.
  let statePreserved = false;
  const sigintHandler = (): void => {
    if (draining) {
      // Second Ctrl-C: force-quit without waiting for the in-flight delete.
      // The synchronous `process.exit(130)` bypasses the `finally` below,
      // so the stack lock is NOT released through the normal path (issue
      // #816). Fire a best-effort, un-awaited release first — it MAY land
      // before the process dies on a fast network — but always print the
      // exact recovery command so the user can recover deterministically if
      // it does not (a force-quit leaving a stranded lock would otherwise
      // re-introduce the 30m-TTL wait this issue fixes, just on this path).
      // Skipped entirely while the lock is not ours yet (issue #1348).
      if (lockHeld) {
        void ctx.lockManager.releaseLock(stackName, regionForState).catch(() => {
          /* best-effort: the recovery line below is the real guarantee */
        });
        process.stderr.write(
          // cdkd-profile-display: the `ctx.profile` below is an ARGUMENT to
          // `forceQuitRecoveryClause`, not a value this line interpolates.
          // What is rendered is that helper's RETURN, and it sanitizes every
          // `LockRecoveryContext` fragment itself -- `displaySafe` plus an
          // EXACTNESS test, suppressing the whole command rather than naming a
          // fragment whose rendering changed (issue go-to-k/cdkd#3377; the
          // behavioural proof is in
          // `tests/unit/state/lock-contention-message.test.ts`). Sanitizing
          // here as well would be wrong, not merely redundant: the helper
          // compares the fragment against the RAW value to decide whether the
          // command can be shown at all, so a pre-sanitized argument would make
          // every altered value compare EXACT and re-open the hole.
          `\nForce-quit: stack lock may not be released.` +
            // Region-qualified for the same reason the contention messages are
            // (issue #2170), and it matters MORE here: by this point
            // `deleteState` may already have removed the record `force-unlock`
            // would otherwise infer the region from. Through the shared clause
            // so a suppressed command cannot leave the banner ending in `run: `.
            `${forceQuitRecoveryClause(stackName, regionForState, {
              profile: ctx.profile,
              stateBucket: ctx.stateBucket,
              statePrefix: ctx.statePrefix,
            })}\n`
        );
      }
      process.exit(130);
    }
    draining = true;
    // Route the notice through the live renderer so it doesn't collide with
    // the in-flight task display.
    renderer.printAbove(() => {
      process.stderr.write(
        '\nInterrupted — finishing in-flight deletes, then flushing state and releasing the lock ' +
          '(press Ctrl-C again to force-quit)...\n'
      );
    });
  };
  // Each nested-stack level recurses into `runDestroyForStack` and registers
  // its own SIGINT listener, and each in-flight provider that installs its own
  // SIGINT handler adds one more. That set is closed and regenerated by
  // `grep -rn "process.on('SIGINT'" src/provisioning/providers/` — today
  // `custom-resource-provider.ts`, `cloudfront-distribution-provider.ts` and
  // `acm-certificate-provider.ts`, NOT Route53, whose provider registers none.
  // Deep nesting + high `--concurrency` can legitimately exceed Node's default
  // 10-listener cap and emit a scary MaxListenersExceededWarning that is NOT a
  // leak (every listener is removed in its own `finally`). Raise the ceiling
  // with generous headroom for real fan-out while still leaving the warning
  // active above it so an ACTUAL listener leak is not masked. `Math.max` keeps
  // this safe under recursion (never lowers an already-raised limit).
  process.setMaxListeners(Math.max(process.getMaxListeners(), 100));
  process.on('SIGINT', sigintHandler);

  try {
    // Inside the `try` (not before it): `logger.info` reaches
    // `process.stdout.write`, which can EPIPE (`cdkd destroy | head`) — and this
    // sits after `regionSwitched = true` and the SIGINT registration, so a throw
    // outside the `try` would leak the listener and the cross-region globals,
    // the same two leaks this fix closes everywhere else (same reasoning as
    // `renderer.start()` below).
    logger.info(`\nAcquiring lock for stack ${displayStackName(stackName)}...`);
    // Check the boolean return (issue #2161): `acquireLock` returns `false`
    // WITHOUT throwing when a live foreign lock is held, and the discarding
    // call this replaced treated that as success — so `destroy` ran against a
    // stack another process (e.g. an in-flight `cdkd deploy`) held the lock on
    // and released that process's lock on the way out. Throwing on `!acquired`
    // aborts before `lockHeld = true`, so the release path never runs and the
    // foreign lock is untouched. Mirrors the fail-fast pattern `cdkd export`
    // already uses.
    const acquired = await ctx.lockManager.acquireLock(
      stackName,
      regionForState,
      undefined,
      'destroy'
    );
    if (!acquired) {
      // Plain `Error`, matching the sibling sites (import / orphan / state /
      // drift / export), so identical contention surfaces the same way across
      // every command (issue #2161). The text — including the holder's
      // identity and the fully-qualified recovery command — is built in one
      // place so the nine sites cannot drift apart again (issue #2170).
      throw new Error(
        await buildLockContentionMessage({
          lockManager: ctx.lockManager,
          stackName,
          region: regionForState,
          recovery: {
            profile: ctx.profile,
            stateBucket: ctx.stateBucket,
            statePrefix: ctx.statePrefix,
          },
        })
      );
    }
  } catch (error) {
    // The main try/finally (which owns the listener removal + region restore)
    // starts further below — clean up here so an acquire failure does not leak
    // the SIGINT handler NOR the process-global region / AWS clients this
    // function switched for a cross-region stack (issue #2161).
    restoreBaseRegionAndClients();
    process.removeListener('SIGINT', sigintHandler);
    throw error;
  }
  lockHeld = true;

  // Second strong-reference scan, now under the producer's lock. The
  // pre-flight scan above is a UX optimization (fast-fail before the
  // prompt); this second scan is the safety boundary. A consumer that
  // started deploying after the pre-flight may have written its
  // imports[] in the meantime — refuse before any provider.delete
  // fires so we don't leave a half-deleted producer + a confused
  // consumer. There is still a small residual TOCTOU window between
  // this re-scan and the resource-level deletes below — a brand-new
  // consumer deploy that runs ENTIRELY between this scan and the
  // delete-loop start is invisible. Per-stack locks can't cover
  // cross-stack reads; this matches CloudFormation's own inherent
  // limitation. Documented in docs/cross-stack-references.md.
  if (needsStrongRefCheck) {
    // Any exit out of this block happens BEFORE the main try/finally that
    // owns the lock release + listener removal, so both are done manually
    // here — for the refusal throw AND for an unexpected scan failure
    // (`listStacks` is not caught inside `scanActiveConsumers`). Release
    // FIRST, remove the listener LAST: while the release round-trip is in
    // flight the handler stays armed, so a SIGTERM landing there is still
    // forwarded gracefully instead of hitting the exit-143 fallback with
    // the lock held.
    const releaseThenUnregister = async (): Promise<void> => {
      try {
        await ctx.lockManager.releaseLock(stackName, regionForState);
      } catch (releaseErr) {
        logger.warn(
          `Failed to release lock after strong-ref refusal/failure: ${describeAwsFailure(releaseErr).detail}`
        );
      }
      // This exit also happens BEFORE the main try/finally that restores the
      // process-global region / clients, so a cross-region destroy refused (or
      // failed) at the strong-ref scan would otherwise leak them for the rest
      // of a `--all` run — the same class as the acquire-failure path above
      // (issue #2161).
      restoreBaseRegionAndClients();
      process.removeListener('SIGINT', sigintHandler);
    };
    let consumers: Awaited<ReturnType<typeof scanActiveConsumers>>;
    try {
      consumers = await scanActiveConsumers(stackName, regionForState, ctx);
    } catch (error) {
      await releaseThenUnregister();
      throw error;
    }
    if (consumers.length > 0) {
      await releaseThenUnregister();
      throw new StackHasActiveImportsError(stackName, regionForState, consumers);
    }
  }

  // Incremental state persistence (issue #804) — the destroy-side mirror of
  // deploy's `saveStateAfterResource`. Successfully deleted resources are
  // removed from this working copy as they complete, and the trimmed state
  // is persisted to S3 after each removal (writes are serialized through
  // `saveChain` and happen under the stack lock we already hold). An
  // interrupted or partially-failed destroy then leaves a state file that
  // only lists resources that still exist, so a re-run never replays a
  // delete against an already-deleted resource — the Custom Resource case
  // stalled 10 minutes per CR on replay before this. Retained resources
  // (`DeletionPolicy: Retain`) are intentionally NOT removed here: their
  // record is only dropped by the wholesale state-file delete at the end of
  // a clean destroy, matching the pre-#804 partial-failure behavior.
  // Persist failures are non-fatal (warn-and-continue) — the final write
  // below (deleteState on success / preserve-write on failure) remains
  // authoritative, and any stale snapshot is a superset of what still
  // exists, which a re-run resolves via the idempotent "not found" path.
  const remainingResources: Record<string, ResourceState> = { ...state.resources };

  // Issue #1752 (G): the state file a user must repair is NOT always this
  // stack's. A skipped nested-stack row's malformed record lives in the CHILD's
  // state file (`<parent>~<childLogicalId>`), so a remedy naming
  // `cdkd state show <parent>` sends the user to a file that does not contain
  // the bad id. Collected during the loop so the summary can name the real
  // target(s).
  const stateTargetFor = (logicalId: string, resourceType: string): string =>
    resourceType === NESTED_STACK_TYPE ? `${stackName}~${logicalId}` : stackName;
  const skippedStateTargets = new Set<string>();
  // Issue #1777: the same is true of a FAILED row, and reaching it is new —
  // `NestedStackProvider.delete` only started throwing (rather than reporting
  // the child deleted) in that issue, so a nested-stack row can now land in the
  // error arm. Its failing resource lives in the CHILD's state file, so the
  // error arm's `cdkd state orphan <parent>` last-resort hint would drop the
  // parent's `Child` row — the exact pointer the throw exists to preserve.
  const failedStateTargets = new Set<string>();
  /**
   * One labelled line per target — the hint both summary arms print.
   *
   * The PROSE quotes are gone, every target goes through the shared gate, and
   * each command gets its OWN line (go-to-k/cdkd#3436). The old
   * `'${command} ${t}'` wrapper is the shape whose paste ran an interpolated
   * value, and this builder was the issue's example of a command the repo-wide
   * grep cannot see, since neither `'cdkd ` nor the value is on the same line
   * as the other. The ` / ` join that first replaced it was its own defect:
   * pasted, it handed the second command to the first as arguments.
   */
  // The ONE builder both `hintFor` and `hintHolesClause` read, so the sentence
  // explaining a hole comes from the gate's own verdict rather than a second
  // predicate that can disagree with it (go-to-k/cdkd#3759).
  const hintCommand = (command: string, t: string) =>
    pasteableCommand(command, [
      { value: t, hole: 'stack', opts: { plainIdent: true } },
      { flag: '--stack-region', value: regionForState, hole: 'region', opts: { plainIdent: true } },
    ]);
  const hintFor = (command: string, targets: string[], label: string): string =>
    // DEDUPED on the produced line, not on the target: one resource failing
    // while another is skipped puts the same state target in both sets, and a
    // name that fails the gate collapses EVERY target to the identical
    // `'<stack>'` line — N copies with nothing to tell them apart (m6 of the
    // go-to-k/cdkd#3499 review).
    [
      ...new Set(
        targets.map(
          (t) =>
            // `--stack-region` is not optional here: without it `state orphan`
            // drops the record for this NAME IN EVERY REGION, so an operator
            // repairing one region would orphan another region's resources with
            // no record of their ids (M2 of the go-to-k/cdkd#3499 review). The
            // `state show` hint carries it for the same reason — a readback of
            // the wrong region's record is the same mistake, one step earlier.
            // `plainIdent` on both values: a target beside a labelled line is
            // named only when it cannot spell one (go-to-k/cdkd#3759).
            `\n${label}: ${hintCommand(command, t).command}`
        )
      ),
    ].join('');

  /**
   * The ONE sentence explaining `hintFor`'s holes, for the prose BEFORE its
   * lines (go-to-k/cdkd#3759). `hintFor` prints one command per target, so a
   * per-hole `withheldTargetClause` would repeat once per line; this states the
   * rule once, and only when the gate actually withheld a value on some line.
   */
  const hintHolesClause = (targets: readonly string[]): string =>
    targets.every((t) => hintCommand('cdkd state show', t).withheld.length === 0)
      ? ''
      : ` A target that is not a plain identifier is printed as a quoted '<stack>' or ` +
        `'<region>' placeholder; list the records as stored with 'cdkd state list --long'.`;

  // Build the partial-destroy snapshot persisted by both the incremental
  // writes and the final preserve-write (issue #804). `outputs` / `imports`
  // / `outputReads` are CLEARED in every persisted destroy snapshot, NOT
  // carried over from the loaded `state`:
  //
  //   - `outputs` is keyed by output NAME, not logical id, so it cannot be
  //     pruned precisely as the backing resources are deleted. A partially
  //     (or fully) destroyed stack has no meaningful outputs, so a preserved
  //     snapshot that still advertised them would name exports whose backing
  //     resources are gone — a phantom export the exports index / a
  //     cross-stack consumer scan could pick up.
  //   - `imports` (this stack's `Fn::ImportValue` consumer records) and
  //     `outputReads` (its `Fn::GetStackOutput` records) are likewise
  //     meaningless once the stack is being torn down; clearing them keeps
  //     another producer's `scanActiveConsumers` from treating a
  //     mid-teardown stack as a live importer.
  //
  // This does NOT disturb the destroy's OWN strong-reference check: that
  // reads the in-memory `state.outputs` (lines ~323 / ~412) BEFORE this
  // loop, and the in-memory `state` object is never mutated here (each
  // snapshot is a fresh spread). The export index for this stack is removed
  // on a clean destroy via `exportIndexStore.removeStack`; on a partial
  // destroy the index may still list stale entries (a perf-only DERIVED
  // view that self-heals on the next deploy / fallback scan — see
  // export-index-store.ts), but the canonical state.json no longer carries
  // the phantom outputs.
  const buildDestroySnapshot = (): StackState => {
    // Strip `imports` / `outputReads` entirely (rather than writing `[]`) to
    // keep the persisted shape identical to a freshly-deployed stack that
    // has none — the deploy engine omits both keys when empty.
    const { imports: _imports, outputReads: _outputReads, ...rest } = state;
    return {
      ...rest,
      resources: { ...remainingResources },
      outputs: {},
      // The bag is REWRITTEN (empty), so its export set is known — and empty
      // (issue #2193). Carrying the record's previous set through `...rest`
      // would pair a known set with a bag that no longer holds those keys.
      exportNames: [],
      lastModified: Date.now(),
    };
  };

  let saveChain: Promise<void> = Promise.resolve();
  const persistStateAfterDelete = (logicalId: string): void => {
    saveChain = saveChain.then(async () => {
      try {
        await ctx.stateBackend.saveState(stackName, regionForState, buildDestroySnapshot());
        logger.debug(`State persisted after deleting ${logicalId}`);
      } catch (error) {
        logger.warn(
          `Failed to persist state after deleting ${logicalId} (continuing): ${describeAwsFailure(error).detail}`
        );
      }
    });
  };

  try {
    // Start the live area only now — the earlier phases (lock, strong-ref
    // scan) log plain lines; the renderer itself was created before the lock
    // acquisition above so the SIGINT handler could reference it. Started
    // INSIDE this `try` (issue #2161): `start()` writes to stdout and can throw
    // (EPIPE on `cdkd destroy | head`), and this is the first statement after
    // `lockHeld = true`, so a throw outside the `try` would strand the lock and
    // leak the cross-region region/clients — the main `finally` below releases
    // and restores both.
    renderer.start();

    logger.info('Building dependency graph...');

    const template = {
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: {} as Record<
        string,
        { Type: string; Properties: Record<string, unknown>; DependsOn?: string[] }
      >,
    };

    for (const [logicalId, resource] of Object.entries(state.resources)) {
      template.Resources[logicalId] = {
        Type: resource.resourceType,
        Properties: resource.properties || {},
        ...(resource.dependencies &&
          resource.dependencies.length > 0 && {
            DependsOn: resource.dependencies,
          }),
      };
    }

    // Type-based implicit deletion ordering (shared with deploy DELETE phase).
    const typeToLogicalIds = new Map<string, string[]>();
    for (const [logicalId, resource] of Object.entries(state.resources)) {
      const ids = typeToLogicalIds.get(resource.resourceType) ?? [];
      ids.push(logicalId);
      typeToLogicalIds.set(resource.resourceType, ids);
    }

    for (const [logicalId, resource] of Object.entries(state.resources)) {
      const mustDeleteAfter = IMPLICIT_DELETE_DEPENDENCIES[resource.resourceType];
      if (!mustDeleteAfter) continue;

      for (const depType of mustDeleteAfter) {
        const depIds = typeToLogicalIds.get(depType);
        if (!depIds) continue;
        for (const depId of depIds) {
          const existing = template.Resources[depId]?.DependsOn ?? [];
          const depsArray = Array.isArray(existing) ? existing : [existing];
          if (!depsArray.includes(logicalId)) {
            template.Resources[depId] = {
              ...template.Resources[depId]!,
              DependsOn: [...depsArray, logicalId],
            };
            logger.debug(
              `Implicit delete dependency: ${depId} (${depType}) must be deleted before ${logicalId} (${resource.resourceType})`
            );
          }
        }
      }
    }

    // Per-resource implicit delete edges that cannot be inferred from a
    // type-pair rule (e.g. CompositeAlarm -> the metric alarms its AlarmRule
    // references by name, which carry no Ref / Fn::GetAtt edge). `before` must
    // be deleted before `after`, so `before` DependsOn `after` (creation order
    // is reversed for deletion, so `before` is torn down first).
    for (const { before, after } of computeImplicitDeleteEdges(state.resources)) {
      const existing = template.Resources[before]?.DependsOn ?? [];
      const depsArray = Array.isArray(existing) ? existing : [existing];
      if (!depsArray.includes(after)) {
        template.Resources[before] = {
          ...template.Resources[before]!,
          DependsOn: [...depsArray, after],
        };
        logger.debug(
          `Implicit delete dependency: ${before} (${state.resources[before]?.resourceType}) must be deleted before ${after} (${state.resources[after]?.resourceType})`
        );
      }
    }

    const dagBuilder = new DagBuilder();
    const graph = dagBuilder.buildGraph(template);
    const executionLevels = dagBuilder.getExecutionLevels(graph);

    logger.debug(`Dependency graph: ${executionLevels.length} level(s)`);

    // Process levels in reverse order for deletion.
    for (let levelIndex = executionLevels.length - 1; levelIndex >= 0; levelIndex--) {
      // Graceful SIGINT (issue #816): once draining, do not start a new
      // deletion level. Any level already in flight finished via its own
      // `Promise.all` below; remaining levels are left untouched and their
      // resources stay in the preserved state for a clean re-run.
      if (draining) {
        logger.debug('Interrupted (draining) — not scheduling further deletion levels');
        break;
      }

      const level = executionLevels[levelIndex];
      if (!level) continue;

      logger.debug(
        `Deletion level ${executionLevels.length - levelIndex}/${executionLevels.length} (${level.length} resources)`
      );

      const stackRegion = state.region ?? ctx.baseRegion;

      const deletePromises = level.map(async (logicalId) => {
        // Graceful SIGINT (issue #816): if the interrupt landed after this
        // level's promises were created but before this resource's delete was
        // dispatched, skip it. It stays in the preserved state for re-run.
        // (Deletes already in flight when the interrupt arrives are NOT
        // cancelled — they run to completion; only not-yet-dispatched ones
        // bail here.)
        if (draining) return;

        const resource = state.resources[logicalId];
        if (!resource) {
          logger.warn(`Resource ${logicalId} not found in state, skipping`);
          return;
        }

        // Schema v5+: honor `state.deletionPolicy: Retain` / `RetainExceptOnCreate`.
        // The AWS resource is kept; only the cdkd state record is dropped
        // (state.json is removed wholesale at the end of a clean destroy).
        // Pre-v5 state has `deletionPolicy: undefined` here, so this branch
        // is a no-op on legacy state — preserves the pre-PR "delete every
        // resource in state" behavior for users who haven't redeployed yet.
        if (shouldRetainResource(resource.deletionPolicy)) {
          logger.info(
            `  ⊘ ${displaySafe(logicalId)} (${displaySafe(resource.resourceType)}) retained — DeletionPolicy: ${displaySafe(resource.deletionPolicy)}`
          );
          result.retainedCount++;
          ctx.eventRecorder?.record({
            eventType: 'RESOURCE_RETAINED',
            stackName,
            operation: 'DELETE',
            logicalId,
            resourceType: resource.resourceType,
            ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
          });
          return;
        }

        const baseLabel = `Deleting ${logicalId} (${resource.resourceType})`;
        renderer.addTask(logicalId, baseLabel);
        const resourceStartedAt = Date.now();
        ctx.eventRecorder?.record({
          eventType: 'RESOURCE_STARTED',
          stackName,
          operation: 'DELETE',
          logicalId,
          resourceType: resource.resourceType,
          ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
        });
        try {
          // Honor `DeletionPolicy: Snapshot` (issues #1352 / #1353) — the
          // template-less twin of the deploy engine's DELETE-branch gating:
          // atomic final-snapshot delete param for the SDK-routed Tier-A
          // types, pre-delete snapshot+wait for the CC-routed
          // `PRE_DELETE_SNAPSHOT_TYPES`, refusal otherwise (opt out with
          // `--skip-final-snapshot`). Pre-v5 state has no recorded
          // `deletionPolicy`, so legacy state keeps the plain-delete behavior
          // until a redeploy records the attribute.
          let finalSnapshotIdentifier: string | undefined;
          if (resource.deletionPolicy === 'Snapshot' && ctx.skipFinalSnapshot !== true) {
            if (
              ATOMIC_FINAL_SNAPSHOT_TYPES.has(resource.resourceType) &&
              resource.provisionedBy !== 'cc-api'
            ) {
              finalSnapshotIdentifier = buildFinalSnapshotIdentifier(
                resource.physicalId,
                resource.resourceType
              );
            } else if (ATOMIC_FINAL_SNAPSHOT_TYPES.has(resource.resourceType)) {
              // cc-api-routed atomic type: Cloud Control DeleteResource has
              // no final-snapshot parameter — refuse instead of silently
              // dropping the promised snapshot.
              throw ccRoutedFinalSnapshotError(
                logicalId,
                resource.resourceType,
                '--skip-final-snapshot'
              );
            } else if (PRE_DELETE_SNAPSHOT_TYPES.has(resource.resourceType)) {
              // destroyAwsClients is the region-scoped set when the stack
              // lives in a different region than the caller's base clients.
              await createPreDeleteFinalSnapshot(
                resource.resourceType,
                resource.physicalId,
                logicalId,
                destroyAwsClients ?? ctx.baseAwsClients,
                logger
              );
            } else {
              throw unsupportedFinalSnapshotError(
                logicalId,
                resource.resourceType,
                '--skip-final-snapshot'
              );
            }
          }

          // Schema v7+ (#614): route DELETE via state-recorded
          // `provisionedBy` so a CC-managed resource is deleted via Cloud
          // Control even if the SDK provider has since gained coverage.
          // Pre-v7 state has `provisionedBy: undefined` which the registry
          // treats as legacy `'sdk'` semantics (matches behavior before
          // this PR shipped).
          const provider = destroyProviderRegistry.getProviderFor({
            resourceType: resource.resourceType,
            provisionedBy: resource.provisionedBy,
          }).provider;

          // Per-resource-type overrides (v2) win over the global default.
          // Resolution order:
          //   1. per-type CLI override (`--resource-timeout TYPE=DURATION`).
          //   2. provider self-report raised against the global default
          //      (`max(getMinResourceTimeoutMs(), globalCli)`).
          //   3. CLI global default (`--resource-timeout 30m`).
          //   4. compile-time default (DEFAULT_RESOURCE_*_MS).
          const providerMinTimeoutMs = provider.getMinResourceTimeoutMs?.() ?? 0;
          const warnAfterMs =
            ctx.resourceWarnAfterByType?.[resource.resourceType] ??
            ctx.resourceWarnAfterMs ??
            DEFAULT_RESOURCE_WARN_AFTER_MS;
          const globalTimeoutMs = ctx.resourceTimeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS;
          // Known-slow types (OpenSearch domains, RDS / Redshift / ElastiCache
          // clusters) lift the outer deadline to match the CC inner poll cap so
          // a slow DELETE is not aborted by the 30-min default. A per-type CLI
          // override still wins (explicit escape hatch).
          const slowTypeMinTimeoutMs = slowCcOperationTimeoutMs(resource.resourceType, 'DELETE');
          const timeoutMs =
            ctx.resourceTimeoutByType?.[resource.resourceType] ??
            Math.max(providerMinTimeoutMs, slowTypeMinTimeoutMs, globalTimeoutMs);

          // Issue #1752: what the provider actually DID. `undefined` (the
          // back-compat `void` return) means "deleted"; a `'skipped'` outcome
          // means no AWS call was issued and the resource may still be alive.
          let deleteResult: ResourceDeleteResult | undefined;

          // Wrap the entire retry loop in the per-resource deadline so a
          // genuinely-stuck delete (e.g. a hung Custom Resource handler or
          // a Cloud-Control polling loop that never terminates) aborts
          // instead of holding the destroy forever.
          await withResourceDeadline(
            async () => {
              // Retry DELETE for transient errors (throttle, dependency race).
              // Providers that opt out of outer retry (e.g. Custom Resources,
              // whose delete generates a fresh pre-signed S3 URL each call)
              // run exactly once.
              const maxAttempts = provider.disableOuterRetry ? 0 : 3;
              let lastDeleteError: unknown;
              for (let attempt = 0; attempt <= maxAttempts; attempt++) {
                try {
                  const outcome = await provider.delete(
                    logicalId,
                    resource.physicalId,
                    resource.resourceType,
                    resource.properties,
                    {
                      ...(state.region !== undefined && { expectedRegion: state.region }),
                      ...(ctx.removeProtection === true && { removeProtection: true }),
                      ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
                    }
                  );
                  // Assign INSIDE the loop, not after it: the loop can
                  // reach this line on a LATER attempt after an earlier one
                  // threw, and the outcome must be that attempt's. (It can
                  // never overwrite a previous non-throwing attempt — the
                  // `break` below ends the loop on the first one.)
                  deleteResult = outcome ?? undefined;
                  lastDeleteError = null;
                  break;
                } catch (retryError) {
                  lastDeleteError = retryError;
                  // Delegate transient-error classification to the shared
                  // classifier so this destroy path (`cdkd destroy` /
                  // `cdkd state destroy`) honors the same retryable patterns
                  // as the deploy-engine delete loop — including the Lambda
                  // EventSourceMapping "because it is in use" teardown lock
                  // surfaced by the multi-resource real-AWS sweep (2026-06-02),
                  // which the prior inline 4-pattern list silently failed
                  // fast on. `'Too Many Requests'` (throttle) stays matched
                  // explicitly: the wrapped ProvisioningError message carries
                  // the phrasing even when the original 429 `$metadata` is
                  // lost across the wrap.
                  // Issue #1778: the `Too Many Requests` arm is load-bearing
                  // (see above) but it is a raw message test, so it bypassed
                  // the non-retryable marker the shared classifier honors —
                  // the same hole `retry.ts` had for custom classifiers. The
                  // marker gates BOTH arms rather than replacing either: a
                  // deliberate cdkd refusal is terminal even if its message
                  // happens to carry a throttle phrase, and a genuine throttle
                  // (never marked) still retries exactly as before.
                  // Issue #2302: BOTH arms classify on the chain text, not on
                  // `msg`. This loop calls `provider.delete` directly rather
                  // than through `withRetry`, so it is a SECOND message
                  // classifier and `retry.ts`'s fix does not reach it. A
                  // provider that redacts its thrown message (the S3 bucket
                  // wraps do) empties exactly what both arms match on:
                  // measured, `conflicting conditional operation` -- S3's
                  // `OperationAborted`, HTTP 409 with a non-throttle name, so
                  // neither `isThrottlingError` nor `isTransientServerError`
                  // sees it and the substring was the ONLY arm -- went from
                  // retryable to terminal. The `Too Many Requests` arm is worse
                  // still: it exists (see above) precisely for the case where
                  // the original 429 `$metadata` is LOST across the wrap, so
                  // the message is the only carrier it has.
                  //
                  // This string is the union of what the redaction withholds
                  // and must never be printed. Nothing here logs it: the
                  // per-attempt line names only the resource and the backoff,
                  // and the error itself is rethrown for the caller to report --
                  // which is why the `msg` binding this replaced is GONE rather
                  // than kept, unlike `retry.ts`'s, whose `message` still feeds
                  // a `warn` and a `debug`.
                  const classify = retryClassificationText(retryError);
                  const isRetryable =
                    !isMarkedNonRetryable(retryError) &&
                    (isRetryableTransientError(retryError, classify) ||
                      classify.includes('Too Many Requests'));
                  if (!isRetryable || attempt >= maxAttempts) break;
                  const delay = 5000 * Math.pow(2, attempt);
                  logger.debug(
                    `  ⏳ Retrying delete ${logicalId} in ${delay / 1000}s (attempt ${attempt + 1}/${maxAttempts})`
                  );
                  await new Promise((resolve) => setTimeout(resolve, delay));
                }
              }
              if (lastDeleteError) throw lastDeleteError;
            },
            {
              warnAfterMs,
              timeoutMs,
              onWarn: (elapsedMs) => {
                const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
                renderer.updateTaskLabel(
                  logicalId,
                  `${baseLabel} [taking longer than expected, ${minutes}m+]`
                );
                renderer.printAbove(() => {
                  logger.warn(
                    `${displaySafe(logicalId)} (${displaySafe(resource.resourceType)}) has been deleting for ${minutes}m — still waiting`
                  );
                });
              },
              onTimeout: (elapsedMs) =>
                new ResourceTimeoutError(
                  logicalId,
                  resource.resourceType,
                  stackRegion,
                  elapsedMs,
                  'DELETE',
                  timeoutMs
                ),
            }
          );

          renderer.removeTask(logicalId);

          // Issue #2301 item 3: a PRE-FLIGHT SAFETY GUARD that ran and could
          // not reach a verdict. Recorded BEFORE the outcome branch below, so
          // it applies to every outcome the branch can take — the guard runs
          // ahead of the delete and its verdict does not depend on how the
          // delete ended.
          //
          // ADDITIONAL to the resource's own RESOURCE_SUCCEEDED /
          // RESOURCE_SKIPPED row, never a replacement for it, which is the
          // shape issue #1819's partial-UPDATE skip already established. The
          // alternative (emit this INSTEAD of RESOURCE_SUCCEEDED) was rejected
          // on two grounds: it would delete the only per-resource success
          // signal existing consumers read, leaving a RESOURCE_STARTED with no
          // terminal row for that logical id; and `counts.deleted` on
          // RUN_FINISHED is driven by `deletedCount`, which this deliberately
          // does not touch, so the run summary would then name a deleted
          // resource whose event stream never says it was deleted.
          for (const guard of deleteIndeterminateGuards(deleteResult)) {
            result.guardIndeterminateCount++;
            guardIndeterminateTargets.add(logicalId);
            ctx.eventRecorder?.record({
              eventType: 'RESOURCE_GUARD_INDETERMINATE',
              stackName,
              operation: 'DELETE',
              logicalId,
              resourceType: resource.resourceType,
              ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
              ...(resource.physicalId && { physicalId: resource.physicalId }),
              guard: guard.guard,
              reason: guard.reason,
              // No `durationMs`, unlike the sibling rows: the guard ran BEFORE
              // the delete, so `Date.now() - resourceStartedAt` here would be
              // the DELETE's elapsed time wearing the guard's label. `timestamp`
              // already orders the row, and a field whose value means something
              // other than what its name says is worse than an absent one.
            });
          }

          // Issue #1752: a provider that could not ADDRESS the resource issued
          // no AWS call, so the resource may still be alive. Print a distinct
          // line, count it separately, and — critically — do NOT drop the
          // state record: without it the user has neither the AWS resource
          // deleted nor a cdkd record pointing at it, and no way to retry.
          if (deleteResult?.outcome === 'skipped') {
            // `reason` is REQUIRED by the discriminated union, so the line
            // always names a cause — a bare `skipped` would be barely more
            // useful than the `deleted` it replaced. Read through the shared
            // `deleteSkipReason` (issue #1762) rather than off the field, so
            // an untyped producer that omits it renders the same
            // `UNSPECIFIED_SKIP_REASON` here as on the deploy side instead of
            // printing `skipped (undefined)` and storing `reason: undefined`
            // in the durable event.
            const skipReason = deleteSkipReason(deleteResult) ?? UNSPECIFIED_SKIP_REASON;
            logger.info(
              `  ${formatResourceLine(
                'skipped',
                logicalId,
                resource.resourceType,
                `skipped (${skipReason})`
              )}`
            );
            result.skippedCount++;
            skippedStateTargets.add(stateTargetFor(logicalId, resource.resourceType));
            ctx.eventRecorder?.record({
              eventType: 'RESOURCE_SKIPPED',
              stackName,
              operation: 'DELETE',
              logicalId,
              resourceType: resource.resourceType,
              ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
              ...(resource.physicalId && { physicalId: resource.physicalId }),
              // The events store is the DURABLE post-mortem, and a bare
              // `RESOURCE_SKIPPED` there cannot tell the user why cdkd could
              // not address the resource. `reason` is required on the
              // `'skipped'` arm, and the shared reader defaults it when a
              // producer omits it anyway, so this is always populated.
              reason: skipReason,
              durationMs: Date.now() - resourceStartedAt,
            });
            // Deliberately NO `delete remainingResources[logicalId]` and no
            // persist call — the record must survive into the preserve-write
            // at the end of the run.
            return;
          }

          logger.info(`  ${formatResourceLine('deleted', logicalId, resource.resourceType)}`);
          result.deletedCount++;
          ctx.eventRecorder?.record({
            eventType: 'RESOURCE_SUCCEEDED',
            stackName,
            operation: 'DELETE',
            logicalId,
            resourceType: resource.resourceType,
            ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
            ...(resource.physicalId && { physicalId: resource.physicalId }),
            durationMs: Date.now() - resourceStartedAt,
          });
          delete remainingResources[logicalId];
          persistStateAfterDelete(logicalId);
        } catch (error) {
          renderer.removeTask(logicalId);
          const msg = describeAwsFailure(error).detail;
          // Treat "not found" as already deleted — but NEVER for a typed
          // final-snapshot failure (issue #1352): the snapshot step runs
          // BEFORE the delete, so its error means the resource is still
          // live; reading a snapshot-poll NotFound as "already deleted"
          // would drop a live, un-snapshotted volume from state.
          //
          // ...and never for a USER ABORT either (issues #2053 / #1952), for the
          // same reason and by the same shape. This match is on the MESSAGE, and
          // an interrupt's message embeds a name the user chose — `DynamoDB
          // auto-scaling for ${tableName}`, `Custom resource ${logicalId}` — so
          // a logical id like `HandleNotFoundException` made an interrupted
          // delete read as "already deleted" and DROPPED a live resource's state
          // row while reporting success. The typed check has to come first
          // because the substring match cannot be made safe: any needle can
          // appear in a user-chosen name.
          //
          // ...and never for a DELIBERATE cdkd REFUSAL either (issue #2301) —
          // the third member of the same family, and the one this PR would
          // otherwise have introduced. `CloudControlProvider`'s pre-flight
          // region check refuses with a message that interpolates the LOGICAL
          // ID, so a construct id containing `NotFoundException` (or a CFn
          // logical id carried in by `--migrate-from-cloudformation`) would
          // make the refusal read as "already deleted": `deletedCount++`, the
          // state row dropped, success reported over a LIVE resource in
          // another region — the exact orphan class that guard exists to
          // prevent, arriving through its own throw. `isMarkedNonRetryable`
          // is the right predicate rather than a new error type: cdkd marks a
          // refusal non-retryable precisely because it is a deterministic
          // verdict rather than an AWS condition, and nothing AWS returns
          // carries the marker.
          // `isWaitAbandonedError` (issue go-to-k/cdkd#3236) is the fourth
          // member of this family and needs its own predicate rather than
          // riding `isMarkedNonRetryable`: a DELETE abandonment is
          // deliberately left RETRYABLE — the point is that this loop can
          // re-issue an idempotent delete — so it carries no non-retryable
          // marker and would fall straight through to the substring match.
          // Reading it as "already deleted" is the same orphan class the note
          // above describes, arriving from cdkd having stopped WATCHING a
          // delete rather than from a refusal.
          if (
            !isInterruptedWaitError(error) &&
            !isFinalSnapshotError(error) &&
            !isMarkedNonRetryable(error) &&
            !isWaitAbandonedError(error) &&
            (msg.includes('does not exist') ||
              msg.includes('not found') ||
              msg.includes('No policy found') ||
              msg.includes('NoSuchEntity') ||
              msg.includes('NotFoundException'))
          ) {
            logger.debug(`  ${logicalId} already deleted, removing from state`);
            result.deletedCount++;
            ctx.eventRecorder?.record({
              eventType: 'RESOURCE_SUCCEEDED',
              stackName,
              operation: 'DELETE',
              logicalId,
              resourceType: resource.resourceType,
              ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
              ...(resource.physicalId && { physicalId: resource.physicalId }),
              durationMs: Date.now() - resourceStartedAt,
            });
            delete remainingResources[logicalId];
            persistStateAfterDelete(logicalId);
          } else if (error instanceof ResourceTimeoutError) {
            // Surface the actionable timeout message wrapped as a
            // ProvisioningError (parity with deploy's failure path) and
            // count it as an error so the state file is preserved.
            const wrapped = new ProvisioningError(
              error.message,
              resource.resourceType,
              logicalId,
              resource.physicalId,
              error
            );
            logger.error(`  ✗ Failed to delete ${logicalId}:`, wrapped.message);
            result.errorCount++;
            failedStateTargets.add(stateTargetFor(logicalId, resource.resourceType));
            ctx.eventRecorder?.record({
              eventType: 'RESOURCE_FAILED',
              stackName,
              operation: 'DELETE',
              logicalId,
              resourceType: resource.resourceType,
              ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
              durationMs: Date.now() - resourceStartedAt,
              error: extractDeploymentEventError(wrapped),
            });
          } else {
            logger.error(`  ✗ Failed to delete ${logicalId}:`, safeStringify(error));
            result.errorCount++;
            failedStateTargets.add(stateTargetFor(logicalId, resource.resourceType));
            ctx.eventRecorder?.record({
              eventType: 'RESOURCE_FAILED',
              stackName,
              operation: 'DELETE',
              logicalId,
              resourceType: resource.resourceType,
              ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
              durationMs: Date.now() - resourceStartedAt,
              error: extractDeploymentEventError(error),
            });
          }
        } finally {
          renderer.removeTask(logicalId);
        }
      });

      await Promise.all(deletePromises);
    }

    // Carry the graceful-interrupt outcome (issue #816) into the result so the
    // CLI surfaces a non-zero exit. Read AFTER the level loop so a SIGINT that
    // arrived while the final level was draining is still observed.
    result.interrupted = draining;

    // Flush pending incremental persists BEFORE the final state decision so
    // a chained write can never land after deleteState and re-create the
    // state file. The chain never rejects (each link catches internally).
    await saveChain;

    // Preserve state (rather than delete it) when there were delete errors OR
    // the destroy was gracefully interrupted (issue #816) OR a resource was
    // SKIPPED (issue #1752). An interrupt leaves not-yet-deleted resources, so
    // deleting the state file would orphan them; a skip leaves a resource cdkd
    // could not even address, so dropping its record orphans it permanently
    // and with no id to go on.
    const preserveState = result.errorCount > 0 || result.interrupted || result.skippedCount > 0;
    // Publish the per-stack "is there work left in this stack" answer to the
    // outer `finally` BEFORE the branch below acts on it, so the re-sync there
    // can never contradict a `deleteState` that has already happened.
    statePreserved = preserveState;
    if (!preserveState) {
      await ctx.stateBackend.deleteState(stackName, regionForState);
      logger.debug('State deleted');
      // Drop this stack's entries from the exports index so the next
      // resolver lookup doesn't return stale values. Best-effort —
      // failures don't fail the destroy (state.json is the canonical
      // record, and the index self-heals on next deploy / fallback).
      if (ctx.exportIndexStore) {
        await ctx.exportIndexStore.removeStack(stackName, regionForState);
      }
    } else {
      // Final authoritative write of the remaining state (not-yet-deleted +
      // failed + retained resources). The incremental persists above are
      // best-effort, so re-write once here to cover the case where some of
      // them failed. Failure here is also non-fatal: the state file in S3
      // is then at worst a superset of what still exists, which a re-run
      // resolves via the idempotent "not found" path.
      try {
        await ctx.stateBackend.saveState(stackName, regionForState, buildDestroySnapshot());
      } catch (error) {
        logger.warn(
          `Failed to persist remaining state after partial destroy: ${describeAwsFailure(error).detail}. ` +
            `The state file may still list already-deleted resources; a re-run resolves them idempotently.`
        );
      }
      if (result.interrupted) {
        logger.warn(
          `Destroy interrupted — ${Object.keys(remainingResources).length} resource(s) not deleted. State preserved.`
        );
      } else if (result.errorCount > 0) {
        logger.warn(`${result.errorCount} resource(s) failed to delete. State preserved.`);
      } else {
        logger.warn(
          `${result.skippedCount} resource(s) skipped — cdkd could not address them, so no ` +
            `delete was issued and they may still exist in AWS. State preserved (the records ` +
            `are kept so the resources stay traceable).`
        );
      }
    }

    // Summary glyph distinguishes clean destroy (✓) from partial failure /
    // interrupt (⚠). The CLI's exit code reflects the same split (0 vs 2) —
    // see PartialFailureError in src/utils/error-handler.ts. Without the
    // visual marker, a partial failure scrolls past in the same shape
    // as a successful destroy and gets missed in CI / bench output.
    const retainedSuffix = result.retainedCount > 0 ? `, ${result.retainedCount} retained` : '';
    // Issue #1752: `skipped` is only rendered when non-zero, so every existing
    // summary line (and the scripts / tests that grep it) is byte-identical on
    // a run with no skips.
    const skippedSuffix = result.skippedCount > 0 ? `, ${yellow(result.skippedCount)} skipped` : '';
    // Issue #2301: rendered on EVERY arm below, the clean-destroy one included
    // — which is the arm that matters most here. A suppressed guard does not
    // preserve state and does not fail the run, so a destroy that proceeded
    // without confirming its target reaches the `✓ Stack X destroyed` line;
    // that line is the summary an operator actually reads, and before this it
    // was byte-identical to a fully-confirmed destroy. Only rendered when
    // non-zero, so every existing summary line (and every script grepping one)
    // is unchanged on a run with no suppressed guard.
    const guardSuffix =
      result.guardIndeterminateCount > 0
        ? `, ${yellow(result.guardIndeterminateCount)} unverified`
        : '';
    if (result.guardIndeterminateCount > 0) {
      // The counter alone does not say what "unverified" means, and the
      // per-resource warns that said it have already scrolled past on any
      // stack of size. Names the resources and points at the durable record,
      // which is the whole point of issue #2301: the events OUTLIVE the run.
      // The pointer at `cdkd events` is GATED on a recorder existing, because
      // `cdkd state destroy` threads none (`state.ts`, the `runDestroyForStack`
      // call) and so writes no `deployments/` object at all. Telling that
      // caller to go read entries nothing wrote sends them to an empty command
      // and reads as cdkd having lost the record -- worse than saying less.
      //
      // The absent-recorder text is CALLER-AGNOSTIC, and that is the correction
      // rather than the wording: TWO callers thread no recorder, not one.
      // `cdkd state destroy` is the obvious one (go-to-k/cdkd#2423), but
      // `NestedStackProvider.delete` also drives this runner for a child stack
      // with no recorder in its context -- under ANY verb, `cdkd destroy`
      // included. Naming `state destroy` here would tell someone already
      // running `cdkd destroy` to re-run it, which changes nothing for them.
      // The runner cannot tell the two apart from `ctx` today, so it states the
      // FACT it can observe (this run recorded none) and cites both causes.
      const eventsCommand = pasteableCommand('cdkd events', [
        { value: stackName, hole: 'stack', opts: { plainIdent: true } },
      ]);
      const durablePointer =
        ctx.eventRecorder === undefined
          ? `This summary is the only record: this run wrote no deployment events, either ` +
            `because it is a 'cdkd state destroy' (go-to-k/cdkd#2423) or because it is a ` +
            `nested-stack child, neither of which threads an event recorder.`
          : `The RESOURCE_GUARD_INDETERMINATE entries name the check and the reason ` +
            `and survive the run.` +
            withheldTargetClause(eventsCommand, 'stack', 'cdkd events', "This stack's name") +
            `\nRead them with: ${eventsCommand.command}`;
      logger.warn(
        `\n${yellow('⚠')} ${result.guardIndeterminateCount} pre-flight safety check(s) could NOT ` +
          `be completed during this destroy and cdkd proceeded anyway: ` +
          `${[...guardIndeterminateTargets].map((t) => plainOrDescribed(t, 'logical id')).join(', ')}. ` +
          `A check can be suppressed by DENYING the permission it needs, so treat this as ` +
          `unconfirmed rather than benign. ${durablePointer}`
      );
    }
    if (!preserveState) {
      logger.info(
        `\n${green('✓')} ${bold(`Stack ${plainOrDescribed(stackName, 'stack name')} destroyed`)} (${green(result.deletedCount)} deleted${retainedSuffix}${guardSuffix}, ${result.errorCount} errors)`
      );
    } else if (result.interrupted && result.errorCount === 0) {
      logger.warn(
        `\n${yellow('⚠')} ${bold(`Stack ${plainOrDescribed(stackName, 'stack name')} destroy interrupted`)} (${green(result.deletedCount)} deleted${retainedSuffix}${skippedSuffix}${guardSuffix}, ${result.errorCount} errors). ` +
          `State preserved — re-run 'cdkd destroy' / 'cdkd state destroy' to finish.`
      );
    } else if (result.errorCount === 0) {
      // Skips only. Nothing FAILED, so "partially destroyed" with an error
      // count would misdescribe the run — and the remedy is different too:
      // there is nothing to retry until the state record is repaired.
      const targets = [...skippedStateTargets];
      const showHint = hintFor('cdkd state show', targets, 'Inspect it with');
      const orphanHint = hintFor('cdkd state orphan', targets, 'Drop the record with');
      logger.warn(
        `\n${yellow('⚠')} ${bold(`Stack ${plainOrDescribed(stackName, 'stack name')} partially destroyed`)} (${green(result.deletedCount)} deleted${retainedSuffix}${skippedSuffix}${guardSuffix}, ${result.errorCount} errors). ` +
          `cdkd could not address the skipped resource(s), so they may still exist in AWS. ` +
          `Fix the physicalId in state.json and re-run, or delete them by hand and drop ` +
          `the records.` +
          hintHolesClause(targets) +
          // Labelled lines, one command each, with NO trailing punctuation: a
          // command inside a sentence is copied WITH the period after it, and
          // `cdkd state orphan TestStack.` addresses a different record
          // (go-to-k/cdkd#3436). `hintFor` opens each line itself, so adding a
          // `\n` here too would print a blank one.
          showHint +
          orphanHint
      );
    } else {
      // Issue #1777: the failing row can be a nested stack, and then the
      // resource that actually failed lives in the CHILD's state file. Naming
      // the parent here would tell the user to `cdkd state orphan <parent>`,
      // which drops the parent's `Child` row — the very pointer the throw was
      // added to preserve, and the user would be left with the child's state
      // file live but unreachable. Same targets-set treatment #1752 gave the
      // skip arm. The `stackName` fallback keeps the hint non-empty if a future
      // path ever increments `errorCount` without recording a target.
      const failedTargets = failedStateTargets.size > 0 ? [...failedStateTargets] : [stackName];
      const orphanHint = hintFor('cdkd state orphan', failedTargets, 'Drop the record with');
      // Issue #1777: a run can carry BOTH kinds at once, and this arm owns that
      // case (the skip-only arm above is unreachable once errorCount > 0). The
      // counters already print `, N skipped`, so saying nothing about them here
      // would name a remedy for the failures and silently drop #1752's guidance
      // for the skips — whose remedy is DIFFERENT in kind: a skip is not
      // retryable, it needs the state record repaired first.
      const skippedTargets = [...skippedStateTargets];
      const skippedClause =
        skippedTargets.length > 0
          ? ` Separately, ${result.skippedCount} resource(s) were SKIPPED — cdkd could not address them, so no delete was issued and they may still exist in AWS. ` +
            `Fix the physicalId in state.json and re-run, or delete them by hand and drop ` +
            `their records.`
          : '';
      // Every command AFTER all the prose, one per line (go-to-k/cdkd#3436):
      // mid-sentence, a copy through the line end takes the words around it.
      // No length guard: `hintFor` maps over the targets, so an empty set
      // yields an empty string without reaching the builder. A conditional here
      // is a branch whose two sides produce identical output.
      const skippedCommands =
        hintFor('cdkd state show', skippedTargets, 'Inspect it with') +
        hintFor('cdkd state orphan', skippedTargets, 'Drop the record with');
      // ACROSS the two calls as well as within each: a stack with one FAILED
      // and one SKIPPED resource puts the same state target in both sets, and
      // `hintFor` cannot see the other call's output (m6 of the
      // go-to-k/cdkd#3499 review).
      const dedupedCommands = (lines: string): string =>
        [...new Set(lines.split('\n').filter((l) => l !== ''))].map((l) => `\n${l}`).join('');
      logger.warn(
        `\n${yellow('⚠')} ${bold(`Stack ${plainOrDescribed(stackName, 'stack name')} partially destroyed`)} (${green(result.deletedCount)} deleted${retainedSuffix}${skippedSuffix}${guardSuffix}, ${red(result.errorCount)} errors). ` +
          `State preserved — re-run 'cdkd destroy' / 'cdkd state destroy' to clean up. ` +
          `If the same resource keeps failing, dropping the state record is the last resort: ` +
          `it removes the record without deleting AWS resources.` +
          skippedClause +
          hintHolesClause([...failedTargets, ...skippedTargets]) +
          dedupedCommands(orphanHint + skippedCommands)
      );
    }
  } finally {
    // RELEASE FIRST, REMOVE THE LISTENER LAST — the same ordering the
    // strong-ref refusal path above states and for a stronger reason than it
    // had. This block used to unregister first, which left a window from the
    // removal until the release resolved where THIS command had no SIGINT
    // handler at all while the lock was still held: `destroy.ts` / `state.ts`
    // register none of their own, so a Ctrl-C there was answered by the
    // provider-side interrupt watch's last-listener force-quit
    // (`src/provisioning/interrupt-watch.ts`), the process exited 130, and the
    // release below never ran — stranding the lock for its full 30-minute TTL.
    // On a `--all` run the watch is armed by the first stack that waits, so
    // every later stack inherited the exposure. That is the issue #1348 class
    // this file already claims to have closed.
    //
    // Keeping the handler armed across the release is also what the graceful
    // path wants: a SIGTERM landing mid-release is still forwarded through it
    // rather than hitting the exit-143 fallback with the lock held.
    //
    // The removal sits in its own `finally` so a throwing STEP cannot leak the
    // listener — one leaked per stack would additionally keep the shared watch
    // from ever being alone, silently disabling the force-quit.
    //
    // The `try` opens at `renderer.stop()` rather than at the release, because
    // `stop()` writes to stdout and CAN throw (EPIPE on a closed pipe). Covering
    // only the release left the exact double-badness this comment argues
    // against: measured `threw=EPIPE releaseLock=0 leakedListeners=1` — the lock
    // stranded AND the handler leaked.
    try {
      // Stop live renderer before releasing the lock so any pending in-flight
      // task lines are cleared cleanly.
      //
      // CAUGHT rather than allowed to propagate, which the `try` above alone
      // does not achieve: `stop()` writes to stdout, so an EPIPE on a closed
      // pipe (`cdkd destroy | head`) would skip the release below entirely and
      // strand the lock. The enclosing `finally` protects the LISTENER from
      // that; only this catch protects the LOCK. A teardown write failing is
      // also the single most swallowable error on this path — the terminal is
      // already gone — so nothing is being hidden that anyone could act on.
      try {
        renderer.stop();
      } catch (rendererError) {
        logger.debug(
          `Live renderer teardown failed (continuing to release the lock): ` +
            `${describeAwsFailure(rendererError).detail}`
        );
      }

      // Drain any still-pending incremental persists before releasing the
      // lock — on the happy path this resolved already (awaited above), but a
      // throw between scheduling and the flush must not let a state write
      // land after the lock is gone. Never rejects (links catch internally).
      await saveChain;

      logger.debug('Releasing lock...');
      // A failed release must never become the error this command reports.
      // Since issue #2168 `releaseLock` raises rather than silently dropping
      // its ownership condition, so a 409 / 503 / throttle here would
      // otherwise REPLACE a real destroy failure -- and, on a successful
      // destroy, abort a `--all` run at the first stack over a lock that
      // lapses on its own. Matches the four sibling sites and
      // `deploy-engine.ts`.
      try {
        await ctx.lockManager.releaseLock(stackName, regionForState);
      } catch (releaseErr) {
        logger.warn(
          `Failed to release lock for stack '${stackName}': ${describeAwsFailure(releaseErr).detail}`
        );
      }
    } finally {
      // Each call registers and removes its own function reference — important
      // for nested-stack recursion, where one handler exists per level.
      //
      // DO NOT introduce an `await` between this line and the function's
      // return. `watchCommandInterrupt` (issue #2117) takes over the moment
      // this handler is gone, and its force-quit can no longer print the
      // region-qualified recovery command — only the hedged
      // `cdkd force-unlock <stack-name>` placeholder, because it has no
      // per-stack context. Nothing suspends here, so a second Ctrl-C cannot
      // land in the gap after a `releaseLock` that FAILED (caught and warned
      // above, not thrown); one added `await` makes it reachable, and the user
      // would then get the vague line on the one path where the lock really is
      // stranded and the exact one would have mattered most.
      process.removeListener('SIGINT', sigintHandler);
      // Restore the cross-region switch HERE, in the guaranteed `finally`, so a
      // throwing `releaseLock` above cannot skip it and leak the target region
      // / global clients into the rest of a `--all` run (issue #2161). The
      // helper is idempotent, so any earlier exit-path call is a no-op.
      restoreBaseRegionAndClients();
    }

    // RE-SYNC the interrupt outcome, because the reordering above MOVED the
    // window it is read in. `result.interrupted` is assigned once, inside the
    // `try`, after the level loop — and everything in this `finally` now runs
    // with `sigintHandler` still armed, so a FIRST Ctrl-C landing in the
    // renderer teardown, the state flush or the lock release sets `draining`
    // AFTER that read. It then stayed false, and `destroy --all` deleted the
    // NEXT STACK after the user asked to stop.
    //
    // That trade is worse than the bug the reordering fixed: before it, the same
    // signal hit the interrupt watch's force-quit and exited 130 — stranding the
    // lock, but never destroying stack B. `||=` rather than `=` because the
    // in-`try` read is the authoritative one for every signal that arrived
    // earlier; this only ever turns false into true. The `return` sits after
    // this `finally`, so the caller sees the corrected value.
    //
    // Kept, and no longer the only thing standing between a Ctrl-C and the next
    // stack. This line was TACTICAL by design: `result.interrupted` being the
    // ONLY channel from here to the `--all` loop was the actual defect, because
    // `destroy.ts` registered no SIGINT handler of its own where `deploy.ts`
    // did. https://github.com/go-to-k/cdkd/issues/2117 closed that — both
    // destroy commands now hold a command-scoped handler
    // (`watchCommandInterrupt`) for their whole run, and their loops read it
    // live, so a signal landing after this `finally` (or after the
    // `removeListener` above, which this line cannot see either) still stops
    // the run.
    //
    // `&& statePreserved` is what makes this line mean what its readers need.
    // OWNERSHIP: `result.interrupted` is the ONE per-stack answer to "did THIS
    // stack finish, or is there work left in it?", and FOUR consumers read it —
    // this stack's state preservation, its summary line, (since this fix)
    // `destroy.ts`'s `--purge-events` skip, and `NestedStackProvider.delete`,
    // which reads a CHILD's result to decide the child row's
    // `{ outcome: 'skipped' }` and its `markNonRetryable` classification. That
    // fourth one was missing from this list for two review rounds; see
    // `interrupt-signals.ts`'s module doc for why the gate's effect on it is
    // the correct reading rather than a regression. The COMMAND-level "has
    // the user asked to stop" is a different question with a different owner:
    // `watchCommandInterrupt`, which the loops read live.
    //
    // Ungated, this line answered the command-level question in the per-stack
    // channel, and got the per-stack one WRONG. `preserveState` is decided
    // inside the `try` from the in-`try` read; a signal landing after it — in
    // `renderer.stop()`, the `saveChain` flush, the real `deleteState` S3
    // round-trip, or `releaseLock` — flipped `draining` with the state file
    // ALREADY DELETED, and the caller then reported "State preserved — re-run
    // 'cdkd destroy' to finish" and exited 2 over a stack that had fully
    // completed. Both halves of that sentence false. The invariant this gate
    // fences: a stack whose state was deleted never reports `interrupted`.
    //
    // Note the correction is still needed for the OTHER half — a stack that
    // preserved state (errors / skips / an earlier interrupt) and then takes a
    // tail signal genuinely does have work left, and `||=` rather than `=`
    // keeps the in-`try` read authoritative for every signal that arrived
    // earlier. `statePreserved` starts false, so a `try` that threw before the
    // preserve decision cannot flip anything — and on that path `result` is
    // never returned anyway.
    result.interrupted ||= draining && statePreserved;
    // (The cross-region region/client restore now runs in the inner `finally`
    // above, so it happens even if `releaseLock` rejected — issue #2161.)
  }

  return result;
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
