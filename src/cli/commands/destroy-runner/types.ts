/**
 * The shared per-stack destroy runner's context and result types (split out
 * of `../destroy-runner.ts`, go-to-k/cdkd#5835).
 */
import { getLogger } from '../../../utils/logger.js';
import type { TemplateNoEchoReresolver } from '../../../deployment/noecho-delete-reresolution.js';
import { AwsClients } from '../../../utils/aws-clients.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import type { LockManager } from '../../../state/lock-manager.js';
import type { CrossPrefixSource } from '../cross-prefix-gate.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import type { DeploymentEventRecorder } from '../../../types/deployment-events.js';
import type { ExportIndexStore } from '../../../state/export-index-store.js';
import type { StackLockOptions } from '../stack-lock-guard.js';

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
/**
 * How long `cdkd destroy` waits for the stack's `NoEcho` values before it
 * judges the printing bags from the records alone (go-to-k/cdkd#3869).
 */
export const NOECHO_PRINTING_BIND_CAP_MS = 10_000;

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
   * The command this destroy runs for, when it is `cdkd state destroy`
   * (go-to-k/cdkd#5238): names its remedy in the under-lock termination-
   * protection refusal.
   */
  stateDestroy?: boolean;

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
   * `cdkd destroy` / `cdkd state destroy` (and a cascading nested destroy)
   * only; never set by a deploy's nested-stack removal (go-to-k/cdkd#4150,
   * `DeleteContext.resolveSecretDerivedPrincipals`). A nested child carries
   * the parent's producer regions, which its own state does not record, and
   * `producerRegionsIncomplete` when its parent's own evidence was (a parent
   * destroyed on its own, go-to-k/cdkd#4887).
   */
  resolveSecretDerivedPrincipals?: {
    inheritedProducerRegions?: readonly string[];
    producerRegionsIncomplete?: boolean;
  };

  /**
   * go-to-k/cdkd#4705: refuse when the bucket also records this stack and
   * region under ANOTHER state prefix. Set by `cdkd destroy` and
   * `cdkd state destroy` for a top-level stack; never for a nested child,
   * whose parent was checked (`src/state/cross-prefix-stack-scan.ts`). The
   * `cache` is the command run's: its caller pre-starts every target stack's
   * scan before the sequential loop (one listing, one run-wide probe cap), and
   * this awaits the stack's own memoized result.
   */
  crossPrefixCheck?: { cache: CrossPrefixSource };

  /**
   * go-to-k/cdkd#4705: when set (`destroy --all`), the writes that follow a
   * stack's record delete -- its kept list or tombstone, then its registry
   * marker's release -- are handed here instead of awaited, with that stack's
   * lock held until they settle, so they overlap the next stack's destroy and
   * nothing costs a round trip per stack. The caller MUST await every promise
   * it collects before the command ends.
   */
  deferRegistryTail?: (released: Promise<void>) => void;

  /**
   * A whole-stack teardown: set by `cdkd destroy` / `cdkd state destroy`, and
   * forwarded to a nested child only from its delete's own context, so a
   * deploy's nested-stack removal never carries it (go-to-k/cdkd#2115). Passed
   * through as `DeleteContext.stackDestroy`.
   */
  stackDestroy?: boolean;

  /**
   * go-to-k/cdkd#2346: when the record is deleted, also purge its earlier
   * `state.json` versions (`S3StateBackend.purgeDeletedStateHistory`, after
   * the kept-resource record is written). Set by `cdkd state destroy` only, and
   * forwarded to its cascading nested children through
   * `destroyOptions.purgeStateHistory`; `cdkd destroy` keeps the history.
   */
  purgeStateHistory?: boolean;

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
   * synchronous and never throws. The CALLER (`cdkd destroy` /
   * `cdkd state destroy`) owns the RUN_STARTED / RUN_FINISHED events and
   * `finalize()`s the recorder. When `undefined` the runner behaves exactly as
   * before #808 (events are a no-op) — which is what a nested-stack child's
   * destroy gets, since `NestedStackProvider.delete` passes no recorder.
   * Error + metadata only — never resource properties.
   */
  eventRecorder?: DeploymentEventRecorder;

  /**
   * The stack's synthesized template source (go-to-k/cdkd#4682): set by
   * `cdkd destroy` when the app synthesized it, and by a nested-stack row for
   * its child. Each delete whose record holds a NoEcho mask gets today's
   * values at those coordinates (`DeleteContext.noEchoDeleteValues`), so a
   * custom resource's handler receives them instead of being skipped.
   * `cdkd state destroy` holds no template and leaves it unset.
   */
  noEchoReresolver?: TemplateNoEchoReresolver;
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
   * STATED LIMITS, measured rather than assumed. Two, both about this
   * counter never being reached at all (`cdkd deploy` and a rollback record
   * the same event since go-to-k/cdkd#2422, with no counter):
   *
   * A guard is reported by RETURNING it, so a delete that THROWS after an
   * unanswerable probe emits no row and increments nothing — the loop that
   * reads it sits inside the `try`. Unreachable through
   * `CloudControlProvider` today (its `NotFound` arm returns rather than
   * throwing, and every other throw is a genuine failure), but it is why the
   * event is documented, on destroy, as accompanying a SUCCEEDED or SKIPPED
   * row and not a `RESOURCE_FAILED` one.
   *
   * And a guard suppressed inside a NESTED-STACK CHILD is invisible here. `NestedStackProvider.delete` drives
   * `runDestroyForStack` for the child with a context carrying no
   * `eventRecorder` (see its argument list), so the child records no events at
   * all, and it reports only counts upward — this counter has no channel to
   * roll up through. That is the same pre-existing shape `RESOURCE_SKIPPED`
   * has on that path, not a regression introduced here. go-to-k/cdkd#2422
   * wired the deploy engine and the rollback executor, not this path.
   */
  guardIndeterminateCount: number;
  /**
   * The share of `skippedCount` that keeps no state record
   * (go-to-k/cdkd#4658, #4738): a resource a failed deploy created that the
   * destroy left in AWS with a warning, recorded only in the rollback journal,
   * whose entry is settled. Includes those a nested child left: that child
   * deleted its own state, so its row counts as deleted and its orphans here.
   * And a superseded resource the provider would not address, whose entry is
   * dropped (go-to-k/cdkd#5111). Such a skip still exits 2, but never keeps
   * the state.
   */
  journaledOrphanSkips: number;
  /**
   * True once this run deleted the stack's `state.json` (go-to-k/cdkd#4738).
   * `NestedStackProvider.delete` reads it, rather than re-deriving the
   * preserve decision from the counters, before it reports a child with
   * skips as deleted: a parent must never drop its row while the child's
   * state survives.
   */
  stateDeleted: boolean;
  /**
   * Number of resources this run did NOT try to delete because the delete of
   * a resource that depends on them failed (go-to-k/cdkd#5670). CloudFormation's
   * DELETE_FAILED keeps a failed resource's dependencies the same way:
   * deleting them (an ECS gateway's infrastructure role, a VPC gateway
   * attachment's internet gateway) strands the failed resource, which then
   * cannot be deleted on a re-run either. Their records stay in state, so a
   * re-run deletes them once the blocking resource is gone. Never counted in
   * `skippedCount` (the provider was never asked) or `errorCount` (nothing
   * failed); the failed row already makes the run exit non-zero.
   */
  blockedCount: number;
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

/** The stack-region clients and registry a cross-region destroy runs under. */
export interface StackRegionScope {
  clients: AwsClients;
  registry: ProviderRegistry;
}

/** The logger every destroy-runner step writes through. */
export type DestroyLogger = ReturnType<typeof getLogger>;

/** The lock options BOTH of the runner's lock sites share (`stackLockBase`). */
export type StackLockBase = Omit<
  StackLockOptions,
  'onFirstSignal' | 'beforeAcquire' | 'onAcquireFailure'
>;
