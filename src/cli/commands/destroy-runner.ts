import * as readline from 'node:readline/promises';
import { getLogger } from '../../utils/logger.js';
import { bold, green, red, yellow } from '../../utils/colors.js';
import { formatResourceLine } from '../../utils/resource-line.js';
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
import { DagBuilder } from '../../analyzer/dag-builder.js';
import {
  IMPLICIT_DELETE_DEPENDENCIES,
  computeImplicitDeleteEdges,
} from '../../analyzer/implicit-delete-deps.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { slowCcOperationTimeoutMs } from '../../provisioning/slow-cc-operation-timeouts.js';
import { shouldRetainResource, type ResourceState, type StackState } from '../../types/state.js';
import type { ResourceDeleteResult } from '../../types/resource.js';
import {
  extractDeploymentEventError,
  type DeploymentEventRecorder,
} from '../../types/deployment-events.js';
import { withResourceDeadline } from '../../deployment/resource-deadline.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../deployment/retryable-errors.js';
import {
  DEFAULT_RESOURCE_WARN_AFTER_MS,
  DEFAULT_RESOURCE_TIMEOUT_MS,
} from '../../deployment/deploy-engine.js';
import {
  ProvisioningError,
  ResourceTimeoutError,
  StackHasActiveImportsError,
  type ActiveImportConsumer,
} from '../../utils/error-handler.js';
import type { ExportIndexStore } from '../../state/export-index-store.js';

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

  /** Caller's --profile, if any. */
  profile?: string;

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
   * resource it deletes (operation always DELETE). `record()` is
   * synchronous and never throws. The CALLER (`cdkd destroy` /
   * `cdkd state destroy`) owns the RUN_STARTED / RUN_FINISHED events and
   * `finalize()`s the recorder. When `undefined` the runner behaves
   * exactly as before #808 (events are a no-op). Error + metadata only —
   * never resource properties.
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
   * [#1752](https://github.com/go-to-k/cdkd/issues/1752)). Two producers
   * today: the malformed-composite-physicalId delete arms (which issue no AWS
   * call at all), and `NestedStackProvider.delete` when the child stack's own
   * destroy skipped or was interrupted (which may have deleted the child's
   * other resources first). So this counts ROWS NOT DESTROYED, and a row can
   * be a whole nested stack — see the note on the CLI's aggregate message.
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

export const PROTECTION_PROPERTY_BY_TYPE: Record<string, string> = {
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
  'AWS::DynamoDB::GlobalTable': 'DeletionProtectionEnabled',
  'AWS::EC2::Instance': 'DisableApiTermination',
  'AWS::Cognito::UserPool': 'DeletionProtection',
  'AWS::AutoScaling::AutoScalingGroup': 'DeletionProtection',
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
 * Count how many resources in a stack's recorded state appear to have
 * deletion protection enabled. Walks `properties` and `observedProperties`
 * for the property name registered against each resource type in
 * `PROTECTION_PROPERTY_BY_TYPE`. ELBv2 LoadBalancer protection lives in
 * `LoadBalancerAttributes` (a CFn `Array<{Key, Value}>`), so it's
 * handled separately via the `deletion_protection.enabled` key.
 */
export function countProtectedResources(state: StackState): number {
  let count = 0;
  for (const resource of Object.values(state.resources ?? {})) {
    const propName = PROTECTION_PROPERTY_BY_TYPE[resource.resourceType];
    if (propName) {
      const recorded = resource.properties?.[propName] ?? resource.observedProperties?.[propName];
      const activePredicate = PROTECTION_ACTIVE_PREDICATE_BY_TYPE[resource.resourceType];
      const activeValues = PROTECTION_ACTIVE_VALUES_BY_TYPE[resource.resourceType];
      if (activePredicate) {
        if (activePredicate(recorded)) count++;
      } else if (activeValues) {
        if (activeValues.has(recorded)) count++;
      } else if (recorded === true) {
        count++;
      }
      continue;
    }
    if (resource.resourceType === 'AWS::ElasticLoadBalancingV2::LoadBalancer') {
      const attrs =
        (resource.properties?.['LoadBalancerAttributes'] as
          | Array<{ Key?: string; Value?: string }>
          | undefined) ??
        (resource.observedProperties?.['LoadBalancerAttributes'] as
          | Array<{ Key?: string; Value?: string }>
          | undefined);
      const enabled = attrs?.find((a) => a?.Key === 'deletion_protection.enabled');
      if (enabled?.Value === 'true') count++;
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
    errorCount: 0,
    interrupted: false,
  };

  const resourceCount = Object.keys(state.resources).length;
  // Region is load-bearing on the new state-key layout (PR 1). Fall back to
  // the caller's baseRegion only for legacy `version: 1` records that never
  // recorded one.
  const regionForState = state.region ?? ctx.baseRegion;
  if (resourceCount === 0) {
    logger.info(`Stack ${stackName} has no resources, cleaning up state...`);
    await ctx.stateBackend.deleteState(stackName, regionForState);
    logger.info(`${green('✓')} State deleted`);
    result.skippedEmpty = true;
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
    logger.info(`  - ${logicalId} (${resource.resourceType})`);
  }

  // When `--remove-protection` is set, surface a count of resources that
  // appear protected per cdkd state so the prompt names the side effect
  // explicitly. This is a best-effort signal — the real authority is
  // AWS's current state, but at confirm time we only have what cdkd
  // recorded. Resources whose state doesn't carry the protection flag
  // (or where the recorded value is `false`) are still flipped via the
  // idempotent flip-off call inside each provider's `delete()`.
  const protectedCount = ctx.removeProtection ? countProtectedResources(state) : 0;

  if (!ctx.skipConfirmation) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const prompt = ctx.removeProtection
      ? `\nAbout to destroy ${resourceCount} resources from stack "${stackName}", ` +
        `REMOVING DELETION PROTECTION on ${protectedCount} of them. Continue? (y/N): `
      : `\nAre you sure you want to destroy stack "${stackName}" and delete all ${resourceCount} resources? (Y/n): `;
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
  if (stackRegion && stackRegion !== ctx.baseRegion) {
    logger.info(`Stack region: ${stackRegion}`);
    process.env['AWS_REGION'] = stackRegion;
    process.env['AWS_DEFAULT_REGION'] = stackRegion;

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
          `\nForce-quit: stack lock may not be released. If the next run reports a lock, run: ` +
            `cdkd force-unlock ${stackName}\n`
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
  // SIGINT handler (CustomResource / CloudFront / ACM / Route53) adds one more.
  // Deep nesting + high `--concurrency` can legitimately exceed Node's default
  // 10-listener cap and emit a scary MaxListenersExceededWarning that is NOT a
  // leak (every listener is removed in its own `finally`). Raise the ceiling
  // with generous headroom for real fan-out while still leaving the warning
  // active above it so an ACTUAL listener leak is not masked. `Math.max` keeps
  // this safe under recursion (never lowers an already-raised limit).
  process.setMaxListeners(Math.max(process.getMaxListeners(), 100));
  process.on('SIGINT', sigintHandler);

  logger.info(`\nAcquiring lock for stack ${stackName}...`);
  try {
    await ctx.lockManager.acquireLock(stackName, regionForState, undefined, 'destroy');
  } catch (error) {
    // The main try/finally (which owns the listener removal) starts further
    // below — clean up here so an acquire failure does not leak the handler.
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
          `Failed to release lock after strong-ref refusal/failure: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`
        );
      }
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
  /** `'cmd A' / 'cmd B'` — the quoted, slash-joined hint both summary arms print. */
  const hintFor = (command: string, targets: string[]): string =>
    targets.map((t) => `'${command} ${t}'`).join(' / ');

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
          `Failed to persist state after deleting ${logicalId} (continuing): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  };

  // Start the live area only now — the earlier phases (lock, strong-ref
  // scan) log plain lines; the renderer itself was created before the lock
  // acquisition above so the SIGINT handler could reference it.
  renderer.start();

  try {
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
            `  ⊘ ${logicalId} (${resource.resourceType}) retained — DeletionPolicy: ${resource.deletionPolicy}`
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
                  const msg = retryError instanceof Error ? retryError.message : String(retryError);
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
                  const isRetryable =
                    !isMarkedNonRetryable(retryError) &&
                    (isRetryableTransientError(retryError, msg) ||
                      msg.includes('Too Many Requests'));
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
                    `${logicalId} (${resource.resourceType}) has been deleting for ${minutes}m — still waiting`
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

          // Issue #1752: a provider that could not ADDRESS the resource issued
          // no AWS call, so the resource may still be alive. Print a distinct
          // line, count it separately, and — critically — do NOT drop the
          // state record: without it the user has neither the AWS resource
          // deleted nor a cdkd record pointing at it, and no way to retry.
          if (deleteResult?.outcome === 'skipped') {
            // `reason` is REQUIRED by the discriminated union, so the line
            // always names a cause — a bare `skipped` would be barely more
            // useful than the `deleted` it replaced.
            logger.info(
              `  ${formatResourceLine(
                'skipped',
                logicalId,
                resource.resourceType,
                `skipped (${deleteResult.reason})`
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
              // `'skipped'` arm, so this is always populated.
              reason: deleteResult.reason,
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
          const msg = error instanceof Error ? error.message : String(error);
          // Treat "not found" as already deleted — but NEVER for a typed
          // final-snapshot failure (issue #1352): the snapshot step runs
          // BEFORE the delete, so its error means the resource is still
          // live; reading a snapshot-poll NotFound as "already deleted"
          // would drop a live, un-snapshotted volume from state.
          if (
            !isFinalSnapshotError(error) &&
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
            logger.error(`  ✗ Failed to delete ${logicalId}:`, String(error));
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
          `Failed to persist remaining state after partial destroy: ${error instanceof Error ? error.message : String(error)}. ` +
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
    if (!preserveState) {
      logger.info(
        `\n${green('✓')} ${bold(`Stack ${stackName} destroyed`)} (${green(result.deletedCount)} deleted${retainedSuffix}, ${result.errorCount} errors)`
      );
    } else if (result.interrupted && result.errorCount === 0) {
      logger.warn(
        `\n${yellow('⚠')} ${bold(`Stack ${stackName} destroy interrupted`)} (${green(result.deletedCount)} deleted${retainedSuffix}${skippedSuffix}, ${result.errorCount} errors). ` +
          `State preserved — re-run 'cdkd destroy' / 'cdkd state destroy' to finish.`
      );
    } else if (result.errorCount === 0) {
      // Skips only. Nothing FAILED, so "partially destroyed" with an error
      // count would misdescribe the run — and the remedy is different too:
      // there is nothing to retry until the state record is repaired.
      const targets = [...skippedStateTargets];
      const showHint = hintFor('cdkd state show', targets);
      const orphanHint = hintFor('cdkd state orphan', targets);
      logger.warn(
        `\n${yellow('⚠')} ${bold(`Stack ${stackName} partially destroyed`)} (${green(result.deletedCount)} deleted${retainedSuffix}${skippedSuffix}, ${result.errorCount} errors). ` +
          `cdkd could not address the skipped resource(s), so they may still exist in AWS. ` +
          `Fix the physicalId in state.json (${showHint}) and ` +
          `re-run, or delete them by hand and drop the records with ${orphanHint}.`
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
      const orphanHint = hintFor('cdkd state orphan', failedTargets);
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
            `Fix the physicalId in state.json (${hintFor('cdkd state show', skippedTargets)}) and re-run, ` +
            `or delete them by hand and drop the records with ${hintFor('cdkd state orphan', skippedTargets)}.`
          : '';
      logger.warn(
        `\n${yellow('⚠')} ${bold(`Stack ${stackName} partially destroyed`)} (${green(result.deletedCount)} deleted${retainedSuffix}${skippedSuffix}, ${red(result.errorCount)} errors). ` +
          `State preserved — re-run 'cdkd destroy' / 'cdkd state destroy' to clean up. ` +
          `If the same resource keeps failing, ${orphanHint} is the last resort: it removes the state record without deleting AWS resources.` +
          skippedClause
      );
    }
  } finally {
    // Remove our SIGINT listener so it never leaks past this call (each
    // call registers and removes its own function reference — important for
    // nested-stack recursion, where one handler is registered per level).
    process.removeListener('SIGINT', sigintHandler);

    // Stop live renderer before releasing the lock so any pending in-flight
    // task lines are cleared cleanly.
    renderer.stop();

    // Drain any still-pending incremental persists before releasing the
    // lock — on the happy path this resolved already (awaited above), but a
    // throw between scheduling and the flush must not let a state write
    // land after the lock is gone. Never rejects (links catch internally).
    await saveChain;

    logger.debug('Releasing lock...');
    await ctx.lockManager.releaseLock(stackName, regionForState);

    // Restore base region/clients if we switched.
    if (destroyAwsClients) {
      destroyAwsClients.destroy();
      process.env['AWS_REGION'] = ctx.baseRegion;
      process.env['AWS_DEFAULT_REGION'] = ctx.baseRegion;
      setAwsClients(ctx.baseAwsClients);
    }
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
        const matches = imports.filter(
          (entry) => entry.sourceStack === producerStack && entry.sourceRegion === producerRegion
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
