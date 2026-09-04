import { getLogger } from '../utils/logger.js';
import { withCurrentResourceSecrets } from './resource-secrets-scope.js';
import {
  collectPublishedOutputNames,
  exportAliasCollisionWarning,
  exportNameSecretExposure,
  isExportAliasCollision,
  isOutputSuppressedByCondition,
  secretBearingExportNameWarning,
} from './outputs-export-alias.js';
import { bold, cyan, gray, green, red, yellow } from '../utils/colors.js';
import { formatResourceLine } from '../utils/resource-line.js';
import { getLiveRenderer } from '../utils/live-renderer.js';
import {
  ProvisioningError,
  ResourceTimeoutError,
  ResourceUpdateNotSupportedError,
  CdkdError,
} from '../utils/error-handler.js';
import {
  isStatefulRecreateTargetForReplace,
  renderStatefulReason,
} from '../provisioning/stateful-types.js';
import {
  withStackName,
  applyDefaultNameForFallback,
  getCurrentStackName,
  looksLikeCdkdGeneratedName,
} from '../provisioning/resource-name.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import { IntrinsicFunctionResolver } from './intrinsic-function-resolver.js';
import {
  redactSecretsForState,
  mergeResolvedPairs,
  scrubResourceRecord,
  maskSecretsInText,
  maskSecretsInError,
  createSecretMasker,
  recordNestedStackParameterExpressions,
  inheritNestedStackParameterAssociations,
  inheritedParameterExpression,
  carriesSecretMask,
  recordMaskOnlyValuesIn,
  recordRecoverableMaskedOutput,
  wholeStringLeavesOf,
  TEMPLATE_SOURCED_RULES,
  type RecordedSecretValues,
} from './secret-redaction.js';
import { DagExecutor } from './dag-executor.js';
import type {
  CloudFormationTemplate,
  CreateContext,
  EffectivePropertiesResult,
  ResourceDeleteResult,
  ResourceProvider,
  ResourceUpdateResult,
} from '../types/resource.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  shouldRetainResource,
  exportNamesCarriedFrom,
  importableOutputKeys,
  importableOutputs,
  type StackState,
  type StateImportEntry,
  type StateOutputReadEntry,
  type ResourceState,
  type ResourceChange,
} from '../types/state.js';
import type { S3StateBackend } from '../state/s3-state-backend.js';
import {
  extractDeploymentEventError,
  type DeploymentEventRecorder,
  type DeploymentResourceOperation,
} from '../types/deployment-events.js';
import type { LockManager } from '../state/lock-manager.js';
import type { ExportIndexStore } from '../state/export-index-store.js';
import type { DagBuilder } from '../analyzer/dag-builder.js';
import type { DiffCalculator } from '../analyzer/diff-calculator.js';
import { ProviderRegistry } from '../provisioning/provider-registry.js';
import { slowCcOperationTimeoutMs } from '../provisioning/slow-cc-operation-timeouts.js';
import { makeCanonicalizePropertiesFn } from '../provisioning/canonicalize-properties.js';
import {
  ATOMIC_FINAL_SNAPSHOT_TYPES,
  PRE_DELETE_SNAPSHOT_TYPES,
  buildFinalSnapshotIdentifier,
  ccRoutedFinalSnapshotError,
  createPreDeleteFinalSnapshot,
  unsupportedFinalSnapshotError,
  type PreDeleteSnapshotClients,
} from '../provisioning/final-snapshot.js';
import { getAwsClients } from '../utils/aws-clients.js';
import { getCreateOnlyPropertyPaths } from '../provisioning/create-only-properties.js';
import { hasNoRegistrySchema } from '../provisioning/describe-type.js';
import { TemplateParser } from '../analyzer/template-parser.js';
import {
  IMPLICIT_DELETE_DEPENDENCIES,
  computeImplicitDeleteEdges,
} from '../analyzer/implicit-delete-deps.js';
import { withRetry, type RetryLogger } from './retry.js';
import { maskingRetryLogger } from './masking-retry-logger.js';
import {
  isMarkedNonRetryable,
  isNameCollisionError,
  isRecreateRetryableError,
  markNonRetryable,
} from './retryable-errors.js';
import { withResourceDeadline } from './resource-deadline.js';
import { deleteSkipReason, deleteSkippedMessage } from './delete-outcome.js';
import { updatePartialMessage, updatePartialReason } from './update-outcome.js';
import { findUnrewrittenAssetReferences, type AssetRedirectMap } from '../assets/asset-redirect.js';
import {
  replayRollback,
  producerRegionsFromState,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from './rollback-executor.js';
import { getCdkdVersion } from '../state/deployment-events-store.js';
import type { RollbackJournalSegment } from '../types/rollback-journal.js';
import { isInterruptedWaitError } from '../provisioning/interrupt-watch.js';

/**
 * The bag a resource with no recorded secret masks against (issue #2038).
 * Shared so the "no entry" path allocates nothing and — more usefully — so
 * every masking site takes the SAME branch: `maskSecretsInText` /
 * `maskSecretsInError` both return their input unchanged for an empty bag, so
 * an absent entry and an empty one cannot behave differently. Never written to.
 */
const EMPTY_SECRETS: RecordedSecretValues = new Map();

/**
 * Default per-resource warn threshold: warn the user when a single
 * resource has been in flight for 5 minutes. Most CC API resources
 * complete in under a minute; 5m is the agreed elbow.
 */
export const DEFAULT_RESOURCE_WARN_AFTER_MS = 5 * 60 * 1000;

/**
 * Default per-resource hard timeout: abort after 30 minutes. Matches the
 * design doc — Custom-Resource-heavy stacks should pass `--resource-timeout 1h`
 * explicitly because the Custom Resource provider's polling cap is 1h.
 */
export const DEFAULT_RESOURCE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Deploy engine options
 */
export interface DeployEngineOptions {
  /** Maximum concurrent resource operations */
  concurrency?: number;
  /** Dry run mode (plan only, no actual changes) */
  dryRun?: boolean;
  /** Lock timeout in milliseconds */
  lockTimeout?: number;
  /** User-provided parameter values */
  parameters?: Record<string, string>;
  /** Skip rollback on failure (save partial state and fail) */
  noRollback?: boolean;
  /**
   * The `--role-arn` the deploy is running with, if any. Informational only
   * — recorded into the rollback-journal segment (issue #1183) so `cdkd
   * rollback` can note that the deploy used a role when it is about to run
   * with ambient credentials.
   */
  roleArn?: string;
  /**
   * Per-resource warn threshold (ms). When a single CREATE / UPDATE /
   * DELETE has been running this long, the live renderer's task label
   * gets a "[taking longer than expected, Nm+]" suffix and a
   * `logger.warn` line is emitted. Defaults to
   * {@link DEFAULT_RESOURCE_WARN_AFTER_MS}.
   *
   * Per-type override via {@link resourceWarnAfterByType} wins for
   * matching resource types.
   */
  resourceWarnAfterMs?: number;
  /**
   * Per-resource hard timeout (ms). When a single resource exceeds this,
   * `ResourceTimeoutError` is thrown and the existing rollback path
   * runs. Defaults to {@link DEFAULT_RESOURCE_TIMEOUT_MS}.
   *
   * Per-type override via {@link resourceTimeoutByType} wins for
   * matching resource types.
   */
  resourceTimeoutMs?: number;
  /**
   * Per-resource-type warn-after override map. Keys are
   * `AWS::Service::Resource` strings; values are milliseconds. When the
   * resource being provisioned matches a key here, that value supersedes
   * `resourceWarnAfterMs` at the call site.
   */
  resourceWarnAfterByType?: Record<string, number>;
  /**
   * Per-resource-type hard-timeout override map. Same shape as
   * {@link resourceWarnAfterByType}; supersedes `resourceTimeoutMs` at
   * the call site for matching types.
   */
  resourceTimeoutByType?: Record<string, number>;
  /**
   * When true, kick off `provider.readCurrentState` immediately after
   * each successful create / update so its result lands in
   * `ResourceState.observedProperties` for the drift comparator. Calls
   * are fire-and-forget — the deploy critical path does NOT block on
   * them — and a final `Promise.all` drains the in-flight set right
   * before the success state save.
   *
   * Defaults to `true`. Pass `--no-capture-observed-state` (or set
   * `cdk.json context.cdkd.captureObservedState: false`) to disable
   * when deploy speed is more important than rich drift detection.
   */
  captureObservedState?: boolean;

  /**
   * Issue #1002 PR 2 — §6 asset-location mapping table, present when the
   * deploy region is in cdkd-assets mode and the stack has redirected
   * assets. The engine uses it for the §7 step 3 post-resolution audit:
   * after the intrinsic resolver produces final literal properties, any
   * value still naming a mapped SOURCE (CDK bootstrap) bucket / repo fails
   * the resource loudly — a template shape the rewrite missed must never
   * deploy as a split-brain reference. Forwarded to nested-child engines
   * via `NestedStackProvider`'s options spread. `undefined` in legacy mode
   * (no audit — byte-identical behavior).
   */
  assetRedirect?: AssetRedirectMap;

  /**
   * When set, every state save during this deploy stamps the supplied
   * parent-stack identity onto `StackState.parentStack` /
   * `parentLogicalId` / `parentRegion` (schema v6+). The
   * `NestedStackProvider` populates this when it builds a child
   * `DeployEngine`, so the child's state file records that it is a
   * nested-stack child of `<parentStack>` under template logical id
   * `<parentLogicalId>`. Top-level deploys leave this `undefined` and
   * the three fields stay unset (top-level state file shape).
   *
   * See issue [#459](https://github.com/go-to-k/cdkd/issues/459) /
   * [docs/design/459-nested-stacks.md](../../docs/design/459-nested-stacks.md)
   * §3 for the full state-key + identity layout.
   */
  parentStackInfo?: {
    parentStack: string;
    parentLogicalId: string;
    parentRegion: string;
  };

  /**
   * Secrets the PARENT already resolved on this child's behalf (issue
   * [#1903](https://github.com/go-to-k/cdkd/issues/1903)) — the seed map
   * `NestedStackProvider` hands the child {@link DeployEngine} it builds.
   *
   * WHY A CHILD ENGINE NEEDS ONE AT ALL. cdkd's secret redaction rests on the
   * resolver recording `plaintext -> {{resolve:...}} expression` into
   * `recordedSecretValues`, which this engine reads at its state-save choke
   * point. A nested stack breaks that chain: the parent resolves the child's
   * `Parameters` block, so the value reaching the child is already PLAINTEXT
   * and the child's template carries `{Ref: <ParamName>}` — an intrinsic
   * OBJECT, not an expression string. Nothing in the child's own resolution
   * ever sees a `{{resolve:`, so its `perResourceSecrets` came out EMPTY and
   * the child's `state.json` persisted the decrypted secret with no expression
   * to redact back to.
   *
   * The PATH-based redaction that closed #1904 / #1900 structurally cannot
   * help, and that is why this is a seed rather than a second source bag: that
   * pass copies a source leaf that IS a `{{resolve:...}}` string, and the
   * child's corresponding leaf is `{Ref: ...}`. There is no leaf to copy.
   *
   * WHAT IT IS USED FOR, both halves being needed or the fix trades one bug for
   * another:
   *
   * 1. {@link buildResolverContext} puts it on the resolver context as
   *    `ResolverContext.inheritedSecrets`, and the resolver copies a pair into
   *    the context's own `recordedSecretValues` at the moment a `{Ref: Param}`
   *    resolves to a value carrying that plaintext
   *    (`recordInheritedParameterSecrets`). The ordinary VALUE-based redaction
   *    then finds the plaintext wherever the parameter landed in that resource
   *    — including inside an `Fn::Join` / `Fn::Sub` that merely EMBEDS it.
   *
   *    RECORDED AT RESOLUTION TIME, NOT PRE-SEEDED (issue
   *    [#2087](https://github.com/go-to-k/cdkd/issues/2087)). The first cut
   *    pre-loaded every child resource's map with this bag, which redacted the
   *    genuine consumers but also spliced the expression into an UNRELATED
   *    resource's literal that merely contained the plaintext as a substring
   *    (`my-production-bucket` against a secret `production`) — a change the
   *    desired side never mirrors, so the child acquired a perpetual UPDATE, or
   *    a perpetual REPLACEMENT on a create-only property. Recording at
   *    resolution time reproduces the parent's own scoping, where
   *    `perResourceSecrets` is keyed by logical id.
   * 2. The DIFF resolver context binds the child's `parameters` to the
   *    REDACTED form (see `redactParametersForDiff`), so the comparison stays
   *    expression-vs-expression. Without it the child's desired side resolves
   *    `{Ref: Param}` to plaintext while its state now holds the expression,
   *    and every deploy reports a spurious UPDATE — the #1901 perpetual-change
   *    class, arriving through the parameter boundary.
   *
   * The redaction of (2) is deliberately NOT applied to the
   * CONDITION-evaluation context: an `Fn::Equals` over a parameter must compare
   * the value the stack actually deployed with, and substituting the expression
   * there would flip a condition. (1) is harmless there and on the diff context
   * alike, because it only RECORDS — it never changes a resolved value.
   *
   * The map is READ-ONLY: the resolver copies matching entries out of it into a
   * fresh per-resource map, so passing the parent's own bag by reference cannot
   * let a child's resolution write back into it.
   *
   * Nesting composes without extra plumbing, and now scopes on the way down
   * too: a grandchild's `AWS::CloudFormation::Stack` row resolves its own
   * `Parameters` block through a context carrying this option, so the pairs its
   * values actually reference are recorded into THAT row's bag — which is
   * exactly the bag `withCurrentResourceSecrets` binds around the provider call
   * that builds the grandchild engine.
   */
  inheritedSecrets?: RecordedSecretValues;

  /**
   * Pre-provisioning gate invoked with the stack's CURRENT state, exactly
   * once per `deploy()`, immediately after the post-lock state read and
   * BEFORE anything else touches the template or a provider. `state` is
   * `undefined` when the stack has no state at all (first deploy).
   *
   * Exists so a CLI pre-flight that needs to inspect existing state can
   * reuse the state read the engine already performs, instead of issuing
   * its own S3 GET before the lock and then having the engine read the
   * same object again. The deploy CLI's `--prefix-user-supplied-names`
   * migration check is the caller; reading POST-lock is also strictly more
   * authoritative than the pre-lock read it replaces, since no concurrent
   * deploy can mutate the state between the check and the diff.
   *
   * Throwing aborts the deploy. `DeployCancelledError` is the "user
   * declined a confirmation prompt" signal the CLI unwinds quietly; any
   * other error surfaces as a normal deploy failure. The engine does not
   * catch either — the `finally` still releases the lock and stops the
   * live renderer.
   *
   * `stackName` is passed so an implementation shared across a run can
   * scope itself; the engine forwards its own option object to
   * nested-stack children, which invoke the hook with the CHILD's name and
   * state.
   */
  onCurrentStateLoaded?: (stackName: string, state: StackState | undefined) => Promise<void>;

  /**
   * Issue [#615] — user-named resources to destroy + recreate via Cloud
   * Control API this deploy. Plumbed through `--recreate-via-cc-api
   * <LogicalId>` (repeatable). Validated upstream in `deploy.ts` (typo /
   * missing-state / ambiguous-intent / stateful guard); the engine
   * trusts that every id in this set is present in cdkd state on entry.
   *
   * Behavior at each provisionResource site:
   *   - CREATE → log a warning + treat as normal CREATE (recreate is
   *     N/A for resources that don't yet exist).
   *   - UPDATE → force the replacement code path, route the new
   *     resource via CC API (regardless of whether the template has a
   *     silent-drop property), stamp `provisionedBy: 'cc-api'` on the
   *     new state record. The OLD resource's destroy uses its
   *     state-recorded `provisionedBy` so the destroy hits the right
   *     provider.
   *   - DELETE → ignore the flag (the resource is being destroyed
   *     anyway).
   *
   * When `undefined` or empty, the engine behaves exactly as before #615.
   */
  recreateViaCcApiTargets?: ReadonlySet<string>;

  /**
   * #651 — set of resource logical ids the user named with
   * `--recreate-via-sdk-provider`. Reverse direction of {@link recreateViaCcApiTargets}:
   * for each id, the engine destroys + recreates the resource via cdkd's
   * SDK Provider, stamping `provisionedBy: 'sdk'` on the new state
   * record. Used to migrate CC-sticky resources back to SDK after a
   * #609 backfill release adds SDK coverage for a previously-silent-drop
   * property.
   *
   * Same destroy-then-create ordering as `recreateViaCcApiTargets` —
   * the old physical id usually reuses its user-supplied name so a
   * create-first would collide.
   *
   * The two sets are mutually exclusive (the pre-flight validator
   * rejects any logical id named in both). When `undefined` or empty,
   * the engine behaves exactly as before #651.
   */
  recreateViaSdkProviderTargets?: ReadonlySet<string>;

  /**
   * Issue [#808] — best-effort structured deployment-event recorder. When
   * supplied, the engine emits one event per per-resource operation
   * (RESOURCE_STARTED / RESOURCE_SUCCEEDED / RESOURCE_FAILED) and per
   * rollback step (ROLLBACK_STARTED / ROLLBACK_RESOURCE_SUCCEEDED /
   * ROLLBACK_RESOURCE_FAILED / ROLLBACK_FINISHED). The run-level
   * RUN_STARTED / RUN_FINISHED events are emitted by the OWNER (the
   * deploy CLI) which knows the command / cdkd version / terminal result
   * and `finalize()`s the recorder after the run reaches a terminal
   * state. `record()` is synchronous and never throws — the recorder
   * buffers in memory and flushes to S3 asynchronously, so event
   * recording can NEVER fail or block the deploy. When `undefined` the
   * engine behaves exactly as before #808 (events are a no-op).
   *
   * NOTE: events carry error + metadata ONLY — never resource
   * properties (which may contain secrets and already live in state.json).
   */
  eventRecorder?: DeploymentEventRecorder;

  /**
   * `--replace` — opt into replacing (DELETE + CREATE) a resource whose
   * in-place `provider.update()` hard-rejects with a typed
   * `ResourceUpdateNotSupportedError`. This happens when a user changes an
   * immutable property (same logical id) of a type cdkd has no replacement
   * rule for — AWS exposes no in-place update API, so CloudFormation would
   * replace the resource, but cdkd otherwise fails the deploy. With this
   * flag set, the engine catches the typed error and falls back to the same
   * destroy-then-create path the CC-API `UnsupportedActionException` fallback
   * already uses. When `undefined`/`false`, the engine rethrows the error
   * (the pre-flag behavior — the deploy fails with the provider's message).
   *
   * Stateful types (RDS / DynamoDB / EFS / S3-with-data / Logs-with-retention
   * / etc.) require {@link forceStatefulRecreation} to be ALSO set, since the
   * replacement is a data-losing DELETE + CREATE.
   */
  replace?: boolean;

  /**
   * `--force-stateful-recreation` — confirm a data-losing replacement of a
   * stateful resource. It is NOT merely a companion to {@link replace} / the
   * `--recreate-via-*` flags: the guard also runs on replacement paths a plain
   * `cdkd deploy` reaches with no flag at all — a property-driven replacement
   * (an immutable / createOnly property changed in the template), and the
   * update-failure fallback's Cloud Control trigger (issue [#2514]) — so a
   * plain deploy can demand this flag on its own.
   *
   * It is NOT required on every replacement of a stateful type, and this
   * comment must not be read as saying so. The property-driven site exempts a
   * target whose template declares `UpdateReplacePolicy: Retain` (the old
   * resource and its data survive, orphaned rather than deleted) and a
   * `--recreate-via-*` target, which the pre-flight probe already validated.
   * The update-failure fallback exempts neither, because it deletes the old
   * resource before creating the new one. The exemptions are enumerated under
   * "Three exemptions apply to this trigger specifically" in
   * `docs/cli-deploy-safety.md`, whose per-path table separately enumerates
   * the paths; prose here names examples and must not read as exhaustive.
   *
   * Without it, the engine refuses the replacement and surfaces a clear error
   * naming the resource + the data-loss reason.
   */
  forceStatefulRecreation?: boolean;

  /**
   * `--strict-getatt` (issue #1111) — promote every unknown-attribute
   * `Fn::GetAtt` physicalId fallback (any suffix, not just the always-fatal
   * `*Arn` / `*Url` shape mismatches) to a hard error, and fail the deploy
   * when a stack Output cannot be resolved (default: warn and store no
   * value). Threaded into the engine's `IntrinsicFunctionResolver` at
   * construction and consulted by `resolveOutputs`. Nested-stack child
   * engines inherit it via the options spread in `NestedStackProvider`.
   */
  strictGetAtt?: boolean;

  /**
   * `--no-cfn-fallback` (issue #1697) — when false, disables the
   * CloudFormation fallback for cross-stack references
   * (`Fn::ImportValue` -> `ListExports`, `Fn::GetStackOutput` ->
   * `DescribeStacks` outputs) that otherwise fires after a cdkd-state
   * miss. Default true. Threaded into the engine's
   * `IntrinsicFunctionResolver` at construction; nested-stack child
   * engines inherit it via the options spread in `NestedStackProvider`.
   */
  cfnFallback?: boolean;

  /**
   * `--skip-final-snapshot` (issues #1352 / #1354) — delete
   * `DeletionPolicy: Snapshot` resources (and, on the replacement paths,
   * `UpdateReplacePolicy: Snapshot` old resources) WITHOUT the final snapshot
   * the policy promises (data loss, explicit opt-in). Default
   * (`undefined`/`false`): the delete sites honor the policy — atomic
   * final-snapshot delete parameters for the `ATOMIC_FINAL_SNAPSHOT_TYPES`,
   * a pre-delete snapshot+wait for the `PRE_DELETE_SNAPSHOT_TYPES` (EC2
   * Volume, Redshift Cluster, ElastiCache ReplicationGroup — issue #1353),
   * and a refusal (`FINAL_SNAPSHOT_UNSUPPORTED`) otherwise.
   */
  skipFinalSnapshot?: boolean;

  /**
   * Region-pinned clients for the pre-delete final snapshots (issues #1352 /
   * #1353). The process-global `getAwsClients()` singleton is repointed
   * per-stack under `--stack-concurrency > 1`, so a concurrent multi-region
   * deploy could hand a delete site a wrong-region client — whose snapshot
   * call 404s as a NotFound and silently skips the snapshot. `deploy.ts`
   * threads the stack-scoped `AwsClients` instance here (structurally a
   * `PreDeleteSnapshotClients`); absent (tests / legacy callers), the global
   * is used.
   */
  finalSnapshotClients?: PreDeleteSnapshotClients;
}

/**
 * Reported up from a template-DELETE whose provider returned
 * `{ outcome: 'skipped' }` (issue #1762).
 *
 * It travels as a RETURN VALUE rather than a thrown error because the deploy
 * deliberately continues: the state record is kept, so the next run re-attempts
 * the delete. The two callers that must know are the event emitter (a skip is
 * not `RESOURCE_SUCCEEDED`) and the DELETE executor, whose rollback journal
 * must NOT record a delete that never happened.
 */
interface DeleteSkipSignal {
  /** The provider's `ResourceDeleteResult.reason` — always present on a skip. */
  deleteSkipped: string;
}

/**
 * The UPDATE-side twin of {@link DeleteSkipSignal} (issue #1819): the provider
 * updated the resource but did NOT retire something the update owned.
 *
 * Carried separately from `deleteSkipped` for the same reason those two counters
 * are separate: the row's own resource WAS updated here, so the wrapper still
 * emits `RESOURCE_SUCCEEDED` for it and adds a `RESOURCE_SKIPPED` naming the
 * survivor. Collapsing them would make the events store claim the updated
 * resource was skipped.
 */
interface UpdatePartialSignal {
  /** The provider's `ResourceUpdateResult.reason` — required on `'partial'`. */
  updatePartial: string;
}

/** What `provisionResourceBody` can report upward about a non-clean outcome. */
type ResourceOutcomeSignal = Partial<DeleteSkipSignal> & Partial<UpdatePartialSignal>;

/**
 * Per-resource operation tallies threaded through `provisionResource`.
 *
 * `skipped` and `deleteSkipped` are NOT the same thing and must never be
 * merged: `skipped` counts resources whose UPDATE resolved to no actual
 * change (it feeds `DeployResult.unchanged`), while `deleteSkipped` counts
 * DELETEs a provider refused to issue (issue #1762) — a resource that is
 * still alive and still in state.
 */
interface ProvisionCounts {
  created: number;
  updated: number;
  deleted: number;
  /** UPDATE resolved to no actual change — folded into `unchanged`. */
  skipped: number;
  /** Provider reported `{ outcome: 'skipped' }` for a template DELETE. */
  deleteSkipped: number;
  /**
   * Provider reported `{ outcome: 'partial' }` for an UPDATE (issue #1819) —
   * the resource WAS updated, but something the update owned survives and is
   * no longer in state. Counted apart from `updated` because the row is not a
   * clean success, and apart from `deleteSkipped` because the row's own
   * resource is not the thing that survived.
   */
  updatePartial: number;
}

/**
 * Deploy result
 */
export interface DeployResult {
  /** Stack name */
  stackName: string;
  /** Number of resources created */
  created: number;
  /** Number of resources updated */
  updated: number;
  /** Number of resources deleted */
  deleted: number;
  /**
   * Number of template-DELETE resources whose provider reported
   * `{ outcome: 'skipped' }` — cdkd could not address the resource, so it was
   * NOT deleted and may still be ALIVE (issue
   * [#1762](https://github.com/go-to-k/cdkd/issues/1762), the deploy-side twin
   * of `DestroyRunnerResult.skippedCount`).
   *
   * Counted separately from `deleted` for the same reason it is on destroy: a
   * skip never reached AWS, so counting it as deleted reports success over a
   * resource nothing touched. Distinct from `unchanged` too — that counts
   * resources cdkd deliberately left alone, whereas this one counts resources
   * cdkd MEANT to delete and could not.
   *
   * The state record is deliberately KEPT for these, so the next deploy still
   * sees the resource as a pending DELETE and re-attempts it. That
   * self-healing is why a skip here is a warning rather than a failed
   * RESOURCE -- but it is NOT why the RUN succeeds, and since issue
   * [#1960](https://github.com/go-to-k/cdkd/issues/1960) it no longer does:
   * the deploy exits 2, as `cdkd destroy` has for the identical outcome since
   * #1752. Self-healing means the next run can fix it; it does not mean this
   * run applied the template it was given. (`--allow-unaddressed` opts back
   * out of the exit code, not out of the warning.)
   */
  deleteSkipped: number;
  /**
   * Resources whose UPDATE reported `{ outcome: 'partial' }` (issue #1819):
   * updated, but something the update owned survives untracked. Separate from
   * `updated` so a clean run and a run that orphaned a resource do not print
   * the same summary, and separate from `deleteSkipped` because the surviving
   * resource is not the row's own.
   */
  updatePartial: number;
  /** Number of resources unchanged */
  unchanged: number;
  /** Total deployment time in milliseconds */
  durationMs: number;
  /**
   * Resolved stack outputs keyed by the template-declared Output name
   * (Export.Name duplicates are filtered out). Populated on a real
   * deploy and on the no-change path; undefined under --dry-run.
   */
  outputs?: Record<string, unknown>;
  /**
   * Number of `Fn::GetAtt` resolutions that fell back to the physical ID
   * (the resolver's warn path) during this deploy run (issue #1111 item 3).
   * The deploy CLI prints a one-line summary when > 0 so the per-resolution
   * warns don't scroll away on green deploys. Each distinct fallback site
   * counts once per run (on the change path the counter is reset after the
   * diff phase so a site is not counted at diff time AND provisioning
   * time); see `IntrinsicFunctionResolver.getPhysicalIdFallbackCount` for
   * the full per-path semantics. Scoped to THIS engine's resolver: a
   * nested-stack CHILD engine's fallbacks appear in the child's own count
   * and are NOT aggregated into the parent stack's summary. Always 0 under
   * `--strict-getatt` (every fallback is a hard error there).
   */
  attributeFallbackCount: number;
}

/**
 * Deploy engine orchestrates the entire deployment process
 *
 * Responsibilities:
 * 1. Acquire stack lock
 * 2. Load current state
 * 3. Calculate diff
 * 4. Validate resource types
 * 5. Execute deployment in DAG order
 * 6. Save new state
 * 7. Release lock
 *
 * Rollback mechanism:
 * - Tracks completed operations during deployment
 * - On failure, rolls back in reverse order (best-effort)
 * - Supports --no-rollback flag to skip rollback (saves partial state and fails)
 * - CREATE → delete the newly created resource
 * - UPDATE → restore previous properties
 * - DELETE → cannot rollback (log warning)
 */
/**
 * Error thrown when the deployment is aborted mid-flight — by a user SIGINT
 * (Ctrl+C) or because another resource's failure cancelled the remaining
 * work. The two causes share one class (the engine's catch path treats them
 * identically) but carry cause-accurate messages: pending siblings cancelled
 * by a failure used to report "interrupted by user (Ctrl+C)" even though
 * nobody pressed anything.
 */
type InterruptCause = 'user' | 'sibling-failure';

class InterruptedError extends Error {
  constructor(reason: InterruptCause = 'user') {
    super(
      reason === 'user'
        ? 'Deployment interrupted by user (Ctrl+C)'
        : 'Deployment aborted after another resource failed'
    );
    this.name = 'InterruptedError';
  }
}

/**
 * Best-effort routing inference for the live-progress task label
 * (#614 §9). Mirrors the routing decision tree but is purely cosmetic:
 * errors here never surface — when the inference fails we return
 * `undefined` and the label gets no `[CC API]` tag. The real
 * `getProviderFor` call inside the deploy/destroy critical path is the
 * load-bearing dispatch.
 *
 * Inputs:
 * - CREATE / UPDATE → template-side `desiredProperties` (top-level CFn
 *   property names; intrinsic resolution does not change those, so we
 *   can route ahead of the resolver run).
 * - DELETE → sticky `provisionedBy` from the existing-state record.
 *
 * Exported so {@link DeployEngine.peekRoutingForLabel} stays a 1-line
 * delegate and the routing-inference logic is directly unit-testable
 * without standing up a full DeployEngine harness.
 */
export function deriveLabelRouting(
  change: ResourceChange,
  existingState: ResourceState | undefined,
  registry: Pick<ProviderRegistry, 'getProviderFor'>
): 'sdk' | 'cc-api' | undefined {
  try {
    if (change.changeType === 'DELETE') {
      return existingState?.provisionedBy;
    }
    const decision = registry.getProviderFor({
      resourceType: change.resourceType,
      properties: change.desiredProperties,
      provisionedBy: existingState?.provisionedBy,
    });
    return decision.provisionedBy;
  } catch {
    return undefined;
  }
}

/**
 * Structural equality for resolved Outputs maps (issue #875).
 *
 * Output values are intrinsic-resolved primitives or nested objects/arrays
 * and key order is irrelevant. Used by the no-change deploy path to decide
 * whether an Outputs-only change (a new Export added because a downstream
 * stack now references this one, with no resource diff) must be persisted.
 */
function outputMapsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return deepEqualValue(a, b);
}

function deepEqualValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqualValue(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqualValue(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * The `imports` / `outputReads` records to persist on a save that is NOT the
 * final success save — the UNION of the pre-deploy snapshot and what THIS
 * session resolved (issue
 * [#2057](https://github.com/go-to-k/cdkd/issues/2057) review).
 *
 * Every non-success save used to write `currentState.imports` /
 * `currentState.outputReads` verbatim, i.e. the PRE-DEPLOY snapshot, while
 * writing the POST-deploy `newResources` beside it. So a deploy that
 * introduced a cross-stack read and then failed persisted resources built FROM
 * that read next to a record that does not mention it. Two consequences, and
 * only the first is about #2057:
 *
 *  1. A rollback journal exists only after a FAILED deploy, so
 *     {@link producerRegionsFromState} saw an empty list on exactly the deploy
 *     that introduces a cross-region secret read — and
 *     `classifyReplaySecretRegion` answered `local`, resolving the producer's
 *     region-less expression in the consumer's region. The refusal was inert
 *     where it mattered most.
 *  2. INDEPENDENT PRE-EXISTING BUG. `state.imports[]` is what
 *     `findActiveImportConsumers` (`src/cli/commands/destroy-runner.ts`) scans
 *     to refuse destroying a producer while a consumer still imports from it,
 *     and `state.outputReads[]` is what `findDownstreamConsumers`
 *     (`src/cli/commands/recreate-downstream-consumers.ts`) enumerates. A
 *     failed deploy therefore silently DOWNGRADED a fresh strong reference to
 *     no reference: the consumer's resource is live and recorded, its import is
 *     not, and `cdkd destroy` on the producer sails through the strong-ref
 *     pre-flight. This exists on main today, with or without #2057.
 *
 * DIRECTION OF THE RESIDUAL, stated rather than left to be discovered: a union
 * never drops a record, so a stack that STOPS reading across a region keeps the
 * stale entry until its next SUCCESSFUL deploy, whose save replaces the list
 * wholesale (`imports: [...this.recordedImports]`). Until then a purely-local
 * rollback can be refused on the strength of a read the template no longer has.
 * That is the fail-closed side — a clear error naming the region to reconcile,
 * versus a silent wrong-secret write — and the same asymmetry already justifies
 * preserving the snapshot at all (dropping it would strip a live strong-ref
 * record on every diff-clean deploy).
 *
 * THE RULE IS "EVERY SAVE EXCEPT THE TERMINAL SUCCESS ONE", and it is stated
 * that way rather than as "every non-success save" because the latter is loose
 * in both directions: the diff-clean no-change save in `doDeploy` is a SUCCESS
 * outcome and unions anyway (nothing was re-resolved, so the union is an
 * identity there and one rule beats an exception), while
 * `persistStateAfterOutputFailure` looks like a success save — provisioning
 * was clean — and is not one.
 *
 * THE ENUMERATION IS NOT KEPT HERE, DELIBERATELY. Two prose counts in this
 * lane were measured wrong (an "ALL FIVE" that missed
 * `persistStateAfterOutputFailure`, and a "three post-rollback saves" that is
 * two), and each wrong count is worse than none: it is the sentence a reader
 * uses to conclude the rule is already applied everywhere.
 * `tests/unit/deployment/deploy-engine-cross-stack-read-writers.test.ts`
 * derives the set instead — it SCANS this file for every `imports:` /
 * `outputReads:` object key that writes a VALUE and fails on any that is not
 * the one allow-listed success-path write, with a positive control proving the
 * scan can see a violation. A save site added here fails that test rather than
 * escaping silently, so the authority on "where is this applied" is a grep the
 * test performs, not a number anybody has to maintain.
 */
function crossStackReadsForPartialSave(
  previous: StackState,
  recordedImports: readonly StateImportEntry[],
  recordedOutputReads: readonly StateOutputReadEntry[]
): Pick<StackState, 'imports' | 'outputReads'> {
  const imports = unionCrossStackReads(
    previous.imports,
    recordedImports,
    (e) => `${e.sourceStack}\u0000${canonicalizeRegion(e.sourceRegion)}\u0000${e.exportName}`
  );
  const outputReads = unionCrossStackReads(
    previous.outputReads,
    recordedOutputReads,
    (e) => `${e.sourceStack}\u0000${canonicalizeRegion(e.sourceRegion)}\u0000${e.outputName}`
  );
  return {
    // Omitted rather than written empty, matching what every one of these save
    // sites did before: an absent field and an empty array are different
    // records to a reader that predates the field.
    ...(imports.length > 0 && { imports }),
    ...(outputReads.length > 0 && { outputReads }),
  };
}

/**
 * Concatenate two cross-stack-read lists, dropping a later duplicate of an
 * identity an earlier entry already carries. First-seen wins, so the PRE-DEPLOY
 * spelling of a region survives — entries are COMPARED on a canonicalized
 * region but STORED verbatim, mirroring `producerRegionsFromState`.
 */
function unionCrossStackReads<T>(
  previous: readonly T[] | undefined,
  recorded: readonly T[],
  identity: (entry: T) => string
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of [...(previous ?? []), ...recorded]) {
    // `previous` comes from persisted JSON, and `parseState` only CASTS — it
    // does not validate the element shape. A `null` / non-object element in a
    // hand-edited `state.imports` would make `identity` throw where the old
    // code copied the array verbatim. Every call site sits inside a try/catch
    // whose catch only warns, so the blast radius was a skipped save rather
    // than a crash, but a save skipped for this reason is a strong-reference
    // record silently not written.
    if (entry === null || typeof entry !== 'object') continue;
    const key = identity(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export class DeployEngine {
  private logger = getLogger().child('DeployEngine');
  private resolver: IntrinsicFunctionResolver;
  private interrupted = false;
  /**
   * Why `interrupted` was set — first cause wins. `'user'` = SIGINT;
   * `'sibling-failure'` = a resource failed and the remaining work is being
   * cancelled. Drives the {@link InterruptedError} message so cancelled
   * siblings don't misreport a Ctrl+C nobody pressed.
   */
  private interruptCause: InterruptCause | null = null;

  /**
   * In-flight `provider.readCurrentState` promises kicked off after a
   * successful CREATE / UPDATE. The deploy critical path does NOT
   * `await` these; instead they're drained at the end of `doDeploy`
   * (success path only) and the resolved values are merged into
   * `ResourceState.observedProperties` before the final state save.
   *
   * Each Promise resolves to the AWS-current snapshot, or `undefined`
   * if the provider does not implement `readCurrentState` or the call
   * threw — never rejects, so an unhandled-rejection cannot escape.
   */
  private observedCaptureTasks: Map<string, Promise<Record<string, unknown> | undefined>> =
    new Map();
  private stateBackend: S3StateBackend;
  private lockManager: LockManager;
  private dagBuilder: DagBuilder;
  private diffCalculator: DiffCalculator;
  private templateParser = new TemplateParser();
  private providerRegistry: ProviderRegistry;
  private options: DeployEngineOptions;
  /**
   * Optional persistent exports index store. When supplied, all
   * `Fn::ImportValue` resolutions in this deploy session prefer the
   * O(1) index lookup over the per-stack state.json scan, and the
   * consumer's `state.imports` field is populated for destroy-time
   * strong-reference checks. Shared across DeployEngine instances in
   * a single `cdkd deploy --all` invocation so the in-memory cache
   * survives across stacks.
   */
  private exportIndexStore: ExportIndexStore | undefined;
  /**
   * Per-deploy-session bag the resolver pushes resolved
   * `Fn::ImportValue` entries into. Reset at the start of each
   * `deploy()` call and persisted to `newState.imports` at the end.
   */
  private recordedImports: StateImportEntry[] = [];
  /**
   * Per-deploy-session bag the resolver pushes resolved
   * `Fn::GetStackOutput` entries into (schema v8+, issue #668).
   * Reset at the start of each `deploy()` call and persisted to
   * `newState.outputReads` at the end. Sibling of `recordedImports`
   * for the weak-reference `Fn::GetStackOutput` intrinsic.
   */
  private recordedOutputReads: StateOutputReadEntry[] = [];
  /**
   * PER-RESOURCE map of resolved SECRET dynamic-reference values
   * (plaintext -> `{{resolve:...}}` expression) the resolver records for each
   * resource's own resolution (GHSA fix). Keyed by logicalId. Per-resource, NOT
   * session-wide, because a session-wide map cross-contaminates: if resource A
   * resolves a `{{resolve:...:SecretString}}` whole-secret reference to value V,
   * and resource B (e.g. the `AWS::SecretsManager::Secret` that OWNS the secret)
   * carries V as its own LITERAL property, a session-wide value scan would
   * wrongly rewrite B's literal to A's expression — a false positive that shows
   * up as a permanent spurious diff. Redacting each resource only with the
   * secrets substituted during ITS OWN resolution scopes the value match
   * correctly. Kept on the engine (not just the resolver context) so the async
   * observed-property capture — which drains after the context is gone — can
   * still redact an AWS-readback secret (Cognito `client_secret`). Reset per
   * `deploy()`. See `secret-redaction.ts`.
   */
  private perResourceSecrets = new Map<string, RecordedSecretValues>();
  /**
   * Logical ids whose provider declared THIS RUN's `attributes` sensitive
   * (`ResourceCreateResult.noEchoAttributes` — issue
   * [#2274](https://github.com/go-to-k/cdkd/issues/2274)). One producer today:
   * `CustomResourceProvider`, relaying the handler's `NoEcho: true`.
   *
   * IN-RUN ONLY, and that is the whole shape of the feature rather than a
   * shortcut. `NoEcho` arrives on a RESPONSE, so cdkd knows it exactly when the
   * handler answered — this deploy — and `ResourceState` carries no durable
   * per-attribute flag to remember it by (a v9 -> v10 schema bump, issue
   * [#2449](https://github.com/go-to-k/cdkd/issues/2449)). Within the run that
   * is enough: the DAG provisions the custom resource before anything that
   * depends on it, so every dependent's resolution sees the entry. Across runs
   * the persisted `***` is the signal instead — see
   * `ResolverContext.redactedAttributeReads`.
   *
   * Reset per `deploy()`, like `perResourceSecrets`.
   *
   * `true` means the WHOLE attributes bag is sensitive (a custom resource's
   * `NoEcho` response); a SET names the sensitive members only (a nested
   * stack's `Outputs.<Key>` entries — see `NoEchoAttributesResult`).
   */
  private noEchoAttributeResources = new Map<string, true | ReadonlySet<string>>();
  /**
   * PER-RESOURCE unresolved TEMPLATE properties, keyed by logicalId (issues
   * #1904 / #1900). The redaction choke point uses this as the POSITION source:
   * wherever the template leaf is a `{{resolve:...}}` string, state persists
   * that string verbatim instead of asking the value-keyed map which expression
   * a plaintext came from — a question that map cannot answer when two
   * expressions resolve to the same value. Captured at the same two sites that
   * populate `perResourceSecrets`, where the unresolved bag is already in hand.
   * Reset per `deploy()`.
   */
  private perResourceTemplateProps = new Map<string, Record<string, unknown>>();
  /**
   * Resolved secrets recorded while resolving the stack OUTPUTS (a `CfnOutput`
   * whose Value resolves a `{{resolve:...}}` reference). Separate from the
   * per-resource maps for the same anti-cross-contamination reason. Reset per
   * `deploy()`.
   */
  private outputSecrets: RecordedSecretValues = new Map();
  /**
   * UNRESOLVED template `Outputs` values, keyed by output name (issue #1910) —
   * the outputs' POSITION source, the sibling of `perResourceTemplateProps` for
   * the bag `resolveOutputs` produces. Without it two outputs resolving one
   * secret collapse onto whichever expression was recorded last, exactly as two
   * resource properties did before #1904. Captured in `resolveOutputs` at the
   * same point `outputSecrets` is accumulated. Reset per `deploy()`.
   */
  private outputsTemplateSource: Record<string, unknown> = {};
  /**
   * The export aliases the last `resolveOutputs` pass WROTE into its bag
   * (issue #2193) — exactly the keys `outputs[exportName] = value` landed on,
   * so an alias the pass refused (secret-bearing name, collision with a
   * published output name) or skipped (unresolved value, condition-suppressed
   * output) is not in it. Persisted as `StackState.exportNames` by the saves
   * that persist that bag, and the set the exports index is fed from. Reset
   * at the top of every `resolveOutputs`, so it is only meaningful right
   * after that call returns — read it there, not later.
   */
  private resolvedExportNames: string[] = [];
  /**
   * Whether {@link outputsTemplateSource} may be used to POSITION the outputs
   * redaction. False once an outputs pass threw partway: the post-loop
   * name pass never ran, so the bag holds only the alias keys written before
   * the throw — a partial source built from THIS template, while the bag the
   * failure path then redacts is the PREVIOUS deploy's. Reset per `deploy()`.
   */
  private outputsSourceUsable = true;

  /**
   * Per-logical-id snapshot of the intrinsic-RESOLVED desired properties
   * each CREATE / UPDATE attempted (issue #1198). Written just before the
   * provider call; read only when the op FAILS, to journal the failed op's
   * `attemptedProperties` so `cdkd rollback --revert-failed` can generate a
   * patch that undoes a half-applied update.
   */
  private attemptedResolvedProps = new Map<string, Record<string, unknown>>();

  /**
   * Target region for this stack. Required — load-bearing for the
   * region-prefixed S3 state key and recorded in state.json for
   * cross-region destroy.
   */
  private stackRegion: string;

  constructor(
    stateBackend: S3StateBackend,
    lockManager: LockManager,
    dagBuilder: DagBuilder,
    diffCalculator: DiffCalculator,
    providerRegistry: ProviderRegistry,
    options: DeployEngineOptions = {},
    stackRegion: string,
    exportIndexStore?: ExportIndexStore
  ) {
    this.stateBackend = stateBackend;
    this.lockManager = lockManager;
    this.dagBuilder = dagBuilder;
    this.diffCalculator = diffCalculator;
    this.providerRegistry = providerRegistry;
    this.options = options;
    this.stackRegion = stackRegion;
    this.exportIndexStore = exportIndexStore;
    this.resolver = new IntrinsicFunctionResolver(stackRegion, {
      strictGetAtt: options.strictGetAtt ?? false,
      cfnFallback: options.cfnFallback ?? true,
    });
    this.options.concurrency = options.concurrency ?? 10;
    this.options.dryRun = options.dryRun ?? false;
    this.options.lockTimeout = options.lockTimeout ?? 5 * 60 * 1000; // 5 minutes
    this.options.noRollback = options.noRollback ?? false;
    this.options.resourceWarnAfterMs =
      options.resourceWarnAfterMs ?? DEFAULT_RESOURCE_WARN_AFTER_MS;
    this.options.resourceTimeoutMs = options.resourceTimeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS;
    // Default ON: drift detection without observedProperties is the
    // pre-PR behavior and we want the upgrade to be a strict superset.
    // The opt-out exists for users who care more about deploy speed
    // than the +0-10% drift-baseline overhead.
    this.options.captureObservedState = options.captureObservedState ?? true;
  }

  /**
   * Deploy a CloudFormation template
   */
  async deploy(stackName: string, template: CloudFormationTemplate): Promise<DeployResult> {
    // Reset per-session state. `recordedImports` is the bag the
    // resolver pushes Fn::ImportValue resolutions into; it lands in
    // `state.imports` at deploy save time. `recordedOutputReads`
    // is the v8 sibling for Fn::GetStackOutput, landing in
    // `state.outputReads`.
    this.recordedImports = [];
    this.recordedOutputReads = [];
    this.perResourceSecrets = new Map();
    this.noEchoAttributeResources = new Map();
    this.perResourceTemplateProps = new Map();
    this.outputSecrets = new Map();
    this.outputsTemplateSource = {};
    this.outputsSourceUsable = true;
    // Per-deploy-run counter: the resolver instance is engine-scoped and an
    // engine can be reused across deploys, so reset here (not in the
    // resolver constructor) to keep the deploy-summary count per run.
    this.resolver.resetPhysicalIdFallbackCount();
    // Scope `stackName` to this deploy's async chain so concurrent
    // deploys (--stack-concurrency > 1) don't see each other's value.
    // See `src/provisioning/resource-name.ts` for the AsyncLocalStorage
    // background.
    return withStackName(stackName, () => this.doDeploy(stackName, template));
  }

  /**
   * Resolver context with the imports-recording and exports-index
   * fields wired in. Keeps the four+ inline context construction
   * sites consistent — pass through callable as
   * `this.buildResolverContext({...}, stackName)`.
   */
  private buildResolverContext(
    base: {
      template: CloudFormationTemplate;
      resources: Record<string, ResourceState>;
      parameters?: Record<string, unknown>;
      conditions?: Record<string, boolean>;
    },
    stackName: string
  ): import('./intrinsic-function-resolver.js').ResolverContext {
    // FRESH per-context map — see the field note at the bottom of the returned
    // object. Named here rather than inlined so the nested-stack parameter
    // associations can be copied onto it (issue #2291).
    const recordedSecretValues = new Map<string, string>();
    // Issue #2291: the parent recorded, per child PARAMETER NAME, which
    // `{{resolve:...}}` expression that parameter was resolved from. Copy those
    // onto this resource's bag as `{Ref: <ParamName>}` position associations,
    // so a child leaf spelling the parameter persists ITS OWN expression rather
    // than whichever one the plaintext-keyed inherited map kept.
    //
    // NOT the issue #2087 pre-seed this file's note below warns about, and the
    // difference is which store decides SCOPE. That defect pre-loaded the
    // PLAINTEXT map, which is what `redactSecretsForState` substring-matches
    // with — so every resource's literals became rewritable. These associations
    // can only change an answer for a leaf whose value is already a plaintext in
    // THIS bag, i.e. only for a resource whose own resolution consumed the
    // parameter. They decide WHICH expression such a leaf takes, never WHETHER
    // a leaf is rewritten.
    if (this.options.inheritedSecrets && this.options.inheritedSecrets.size > 0) {
      inheritNestedStackParameterAssociations(recordedSecretValues, this.options.inheritedSecrets);
    }
    return {
      template: base.template,
      resources: base.resources,
      ...(base.parameters &&
        Object.keys(base.parameters).length > 0 && { parameters: base.parameters }),
      ...(base.conditions &&
        Object.keys(base.conditions).length > 0 && { conditions: base.conditions }),
      stateBackend: this.stateBackend,
      stackName,
      ...(this.exportIndexStore && { exportIndex: this.exportIndexStore }),
      recordedImports: this.recordedImports,
      recordedOutputReads: this.recordedOutputReads,
      // The pairs the PARENT resolved for this stack, on a nested-stack child
      // engine only (issue #1903). NOT pre-loaded into the map below: the
      // resolver copies a pair across at the moment a resource's `{Ref: Param}`
      // actually resolves to a value carrying that plaintext
      // (`recordInheritedParameterSecrets`), so the pair lands in the bag of
      // the resource that consumed the parameter and nowhere else.
      //
      // The first cut DID pre-load every context's map, and that was issue
      // #2087: `redactSecretsForState` substring-matches at or above
      // `MIN_NEEDLE_LENGTH`, so a child resource that never referenced the
      // parameter but spells `my-production-bucket` while the secret is
      // `production` had `my-{{resolve:...}}-bucket` persisted. The desired
      // side does NOT mirror that — `redactParametersForDiff` rewrites only the
      // PARAMETERS — so the stack acquired a perpetual UPDATE, or a perpetual
      // REPLACEMENT on a create-only property. The rationale that shipped with
      // it ("the same over-approximation the parent already accepts") was
      // simply wrong: the parent scopes its bag to the ONE resource whose
      // resolution produced the secret, because `perResourceSecrets` is keyed
      // by logical id. Recording at resolution time gives the child the SAME
      // scoping rule.
      //
      // PARITY, not perfection, and the residual is worth naming rather than
      // leaving to be rediscovered: within a resource that genuinely DOES
      // consume the parameter, `redactSecretsForState` still substring-matches
      // every leaf, so an UNRELATED literal in that same resource carrying the
      // plaintext verbatim is rewritten too. The parent has exactly that
      // residual for a resource that resolves a `{{resolve:...}}`, so this is
      // the child reaching parity with it — not a claim that no
      // over-approximation remains.
      ...(this.options.inheritedSecrets &&
        this.options.inheritedSecrets.size > 0 && {
          inheritedSecrets: this.options.inheritedSecrets,
        }),
      // FRESH per-context map: the resolver records each resolved secret
      // (plaintext -> `{{resolve:...}}` expression) here (GHSA fix). The caller
      // captures it and stores it per-logicalId in `perResourceSecrets` (or in
      // `outputSecrets` for the outputs pass) so each bag is redacted only with
      // the secrets substituted during ITS OWN resolution — see the
      // `perResourceSecrets` field doc for why per-resource, not session-wide.
      recordedSecretValues,
      // Issue #2274, and BOTH fields go on EVERY context this method builds —
      // the diff / no-op one included — rather than only on the provisioning
      // ones. The first can only ADD mask-only needles to a bag, which is right
      // wherever that bag ends up redacting something and inert wherever it
      // does not. The second is a RECORD the resolver writes and only the two
      // provisioning sites read: putting the bag on the diff context too costs
      // an array nobody consults, while omitting it would make a future third
      // provisioning site silently unguarded — the failure direction that
      // matters here is the one that ships a `***` to AWS.
      noEchoAttributeResources: this.noEchoAttributeResources,
      redactedAttributeReads: [],
    };
  }

  /**
   * The parameter bag the DIFF resolver context binds, with any inherited
   * secret plaintext rewritten back to its `{{resolve:...}}` expression (issue
   * #1903).
   *
   * The provisioning pass must keep the REAL values — that is what actually
   * reaches AWS — but the child's persisted state holds the expression, so the
   * comparison side has to hold it too or every deploy of a secret-bearing
   * nested stack reports a spurious UPDATE and re-issues an AWS call that
   * changes nothing. This is the child-stack twin of the
   * `skipDynamicReferences` flag the parent's own diff sets: same goal
   * (expression-vs-expression), reached differently because the child's
   * template carries `{Ref: Param}` rather than a `{{resolve:` string, so
   * there is no reference for that flag to decline to resolve.
   *
   * `redactSecretsForState` rather than a `Map.get` lookup so an EMBEDDED
   * secret — a parameter whose value is `postgres://u:<secret>@host` because
   * the parent built it with `Fn::Sub` — is rewritten the same way the
   * state-save choke point rewrites it, keeping the two sides byte-identical.
   * Identity-returns when nothing was inherited.
   */
  private redactParametersForDiff(
    parameterValues: Record<string, unknown>
  ): Record<string, unknown> {
    const inherited = this.options.inheritedSecrets;
    if (!inherited || inherited.size === 0) return parameterValues;
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(parameterValues)) {
      // Issue #2291: the PER-PARAMETER answer first, because `inherited` is
      // keyed by PLAINTEXT and two parameters resolving to one value have
      // already collapsed there. The persist side positions each child leaf
      // onto its OWN expression; without the same answer here the losing
      // parameter's desired side would carry the SURVIVOR's expression forever
      // and its resource would report a spurious UPDATE on every deploy.
      // `undefined` whenever the parent could not certify one, which falls back
      // to the value scan below — the pre-#2291 behaviour, expression-collapsed
      // but consistent with what a pre-#2291 persist side wrote.
      out[name] =
        inheritedParameterExpression(inherited, name, value) ??
        redactSecretsForState(value, inherited);
    }
    return out;
  }

  /**
   * Redact resolved secret plaintext out of a bag about to be PERSISTED to
   * state, replacing each secret value with the unresolved `{{resolve:...}}`
   * expression it came from (GHSA fix; see `secret-redaction.ts`). No-op when
   * the deploy recorded no secrets. The bag sent to the AWS API is the
   * un-redacted resolved bag; only the persisted copy is rewritten.
   */
  /**
   * Redact the resolved stack OUTPUTS bag, positioned by the unresolved
   * template `Outputs` values (issue #1910).
   *
   * A single entry point because THREE call sites redact this same bag — the
   * state-persist choke point, the no-change re-check, and the post-deploy
   * publish that feeds the exports index / deploy summary — and before this
   * they each spelled the value-only redaction separately. Two outputs
   * resolving one secret collapsed onto whichever expression was recorded last
   * at all three.
   */
  /**
   * Record the plaintext behind every output {@link redactOutputs} just masked,
   * for the duration of THIS PROCESS (issue #2274).
   *
   * Per KEY, comparing the two bags rather than re-deriving from the secrets
   * map: what matters is whether the persisted value at this key IS a mask that
   * the resolved value was not, which is exactly "this key's plaintext is about
   * to become unreadable". A key already carrying `***` before redaction — a
   * value read back out of a previous run's state — is skipped, because there
   * is no plaintext behind it to remember.
   *
   * Called only from the REAL-DEPLOY outputs pass. The other two `redactOutputs`
   * callers hand it a bag from a previous generation, where a mask is already
   * unrecoverable and pretending otherwise would serve a stale value.
   */
  private rememberRecoverableMaskedOutputs(
    stackName: string,
    resolved: Record<string, unknown>,
    redacted: Record<string, unknown>
  ): void {
    if (resolved === redacted) return;
    for (const [key, redactedValue] of Object.entries(redacted)) {
      if (!carriesSecretMask(redactedValue)) continue;
      const plaintext = resolved[key];
      if (plaintext === undefined || carriesSecretMask(plaintext)) continue;
      recordRecoverableMaskedOutput(stackName, this.stackRegion, key, plaintext);
    }
  }

  private redactOutputs(outputs: Record<string, unknown>): Record<string, unknown> {
    if (this.outputSecrets.size === 0) return outputs;
    // TEMPLATE_SOURCED and not the DEFAULT template-DERIVED rules (issue
    // [#1943](https://github.com/go-to-k/cdkd/issues/1943)). `descendArrays` is
    // the only flag the two differ on, and it claims "this bag was PRODUCED by
    // resolving this source" — which two of this method's three callers cannot
    // say. `redactStateForPersist` walks whatever `state.outputs` holds, and on
    // the no-change path that is `persistedOutputs`, the PREVIOUS deploy's bag,
    // while `outputsTemplateSource` is TODAY's template. Positional descent
    // there does not merely mis-redact: `redactByPath` returns a known-secret
    // SOURCE leaf verbatim, so a previous generation's ordinary literal at
    // index `i` is rewritten to today's expression at index `i` — a value the
    // stack never held, persisted into `state.outputs`, which the exports index
    // re-applies to consumer stacks.
    //
    // Reachable rather than theoretical, though narrowly: `TemplateOutput.Value`
    // is `unknown` and cdkd does not enforce CloudFormation's "Value must be a
    // String", so a list-valued output (an escape hatch, an imported template)
    // gives the array arm an array on BOTH sides and `state.outputs` is
    // explicitly not string-coerced. Every CDK-synthesized template lands on a
    // string or an intrinsic OBJECT, so for those the swap is inert.
    //
    // `sourceIsSameGeneration` is already false in both constants, so the
    // token-shaped-leaf hazard (issue #1917) was never the gap here. The
    // sibling `cdkd scrub` outputs call still passes the default and records
    // the inertness measurement for its own bag; converging the two is issue
    // [#2099](https://github.com/go-to-k/cdkd/issues/2099).
    return redactSecretsForState(
      outputs,
      this.outputSecrets,
      this.outputsSourceUsable ? this.outputsTemplateSource : undefined,
      TEMPLATE_SOURCED_RULES
    );
  }

  /**
   * Redact resolved secret plaintext out of rollback-journal operations (GHSA
   * fix). Each op may carry resolved `properties` / `attemptedProperties` and a
   * `previousState` snapshot (whose `properties` / `attributes` /
   * `observedProperties` also hold resolved values). Each op is redacted with
   * the secrets recorded for ITS OWN resource (`perResourceSecrets`), so a
   * whole-secret value from one resource cannot rewrite another's literal.
   * Preserves ops that carry none of those fields, or whose resource recorded
   * no secret.
   *
   * The POSITION source matters MORE here than anywhere else (issue #1910).
   * This journal is not just persisted, it is REPLAYED to AWS by the rollback
   * executor's `resolveReplayProps`, so a leaf redacted onto a SIBLING's
   * expression — which is what the value-keyed map does when two expressions
   * resolve to one value — re-resolves at replay time to the wrong reference.
   * For two `:AWSCURRENT` / `:AWSPREVIOUS` stages of one secret that is the
   * wrong VERSION shipped to the live resource the moment the two diverge.
   *
   * The two SIDES take different sources, and conflating them would be a fresh
   * defect rather than a simplification: `properties` / `attemptedProperties`
   * are this deploy's DESIRED bags, produced by resolving the CURRENT template,
   * so the template bag positions them. `previousState` is a record read back
   * from STATE, whose leaves already hold expressions from whenever it was
   * written — the current template is not its source and may not even have the
   * same shape — so it is redacted against ITSELF via `scrubResourceRecord`,
   * the same #1900 fallback an UNCHANGED resource takes.
   */
  /**
   * Take a provider's `noEchoAttributes` declaration and turn it into REDACTION
   * (issue [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
   *
   * TWO registrations, and both are needed because `perResourceSecrets` is
   * keyed by LOGICAL ID:
   *
   * - the values go into the PRODUCER's own bag, which is what
   *   `scrubResourceRecord` redacts this record's `attributes` with;
   * - the logical id goes into {@link noEchoAttributeResources}, which every
   *   later resolution consults, so a DEPENDENT that resolves an `Fn::GetAtt`
   *   here records the same plaintext into ITS bag and its resolved
   *   `properties` are masked too. Without the second half the custom resource's
   *   record would be clean while the SSM parameter that consumed it still held
   *   the plaintext — a line that cannot be explained to someone who set
   *   `NoEcho` expecting "not in state".
   *
   * Called AFTER the provider returns and BEFORE the state record is built, so
   * the needles exist by the time anything is persisted. Nothing is masked in
   * memory: `stateResources[logicalId].attributes` keeps the REAL value, which
   * is what the resolver serves to dependents in this same run.
   *
   * `ownProperties` is the resource's OWN resolved template bag, and passing it
   * is what stops a handler from masking cdkd's inputs back at it (issue #2274
   * review). Its whole string leaves are EXCLUDED from the needles: a handler
   * echoing `event.ResourceProperties` into its `Data` — the shape the CDK
   * `Provider` samples encourage — makes `Data.X` equal the resource's own
   * `ServiceToken`, and registering that rewrites `properties.ServiceToken` to
   * `***` in the record `CustomResourceProvider.delete` reads it back from,
   * where the mask is a truthy string that passes both of that method's guards.
   * A value already present in the template is not handler-GENERATED, so
   * excluding it gives up no secrecy — and where the template value IS a
   * resolved secret it already carries a real EXPRESSION needle, which
   * `recordMaskOnlyValue` would refuse to demote anyway.
   */
  private registerNoEchoAttributes(
    logicalId: string,
    result: {
      attributes?: Record<string, unknown>;
      noEchoAttributes?: boolean;
      noEchoAttributeNames?: readonly string[];
    },
    secrets: RecordedSecretValues,
    ownProperties?: Record<string, unknown>
  ): void {
    const attributes = result.attributes;
    if (attributes === undefined) return;
    const excluded = ownProperties === undefined ? undefined : wholeStringLeavesOf(ownProperties);
    if (result.noEchoAttributes === true) {
      this.noEchoAttributeResources.set(logicalId, true);
      recordMaskOnlyValuesIn(attributes, secrets, excluded);
      return;
    }
    // The PER-ATTRIBUTE arm. Filtered against the bag actually returned, so a
    // name the provider declared but did not deliver registers nothing — the
    // declaration is evidence about a VALUE, and with no value there is no
    // needle to record.
    const names = (result.noEchoAttributeNames ?? []).filter((name) => name in attributes);
    if (names.length === 0) return;
    this.noEchoAttributeResources.set(logicalId, new Set(names));
    for (const name of names) recordMaskOnlyValuesIn(attributes[name], secrets, excluded);
  }

  /**
   * Refuse to provision a resource whose resolution served a REDACTED attribute
   * out of a previous deploy's state (issue #2274).
   *
   * The unavoidable cost of masking a `NoEcho` custom resource's `Data`: state
   * then holds `***`, and cdkd cannot get the value back without re-invoking
   * the handler, which is a SIDE-EFFECTING operation it must not perform just
   * to fill in a property. Since `ResourceState` carries no durable `NoEcho`
   * flag (issue #2449), there is not even a way to tell the user which
   * attribute it was without this record.
   *
   * REFUSING IS THE SAFE DIRECTION and the alternative is not "it works": the
   * literal `***` would be written to the live resource by any provider that
   * sends its desired bag wholesale (`PutParameter` and every
   * `Put*Configuration`), which is the issue #1498 / #1501 data-corruption
   * class. A loud failure naming the remedy is strictly better than a silent
   * wrong write.
   *
   * NARROW BY CONSTRUCTION. The bag is only non-empty when a `Fn::GetAtt`
   * actually served a masked attribute during THIS resource's resolution, so a
   * resource whose properties merely happen to contain the string `***` is
   * untouched — which is why the check is not "does `resolvedProps` hold the
   * mask". And the diff pass does not consult the bag at all, so an untouched
   * stack still reports NO_CHANGE and deploys.
   */
  private refuseRedactedAttributeReads(
    logicalId: string,
    resourceType: string,
    context: import('./intrinsic-function-resolver.js').ResolverContext
  ): void {
    const reads = context.redactedAttributeReads;
    if (reads === undefined || reads.length === 0) return;
    throw new ProvisioningError(
      `Cannot resolve ${reads.join(', ')} for ${logicalId}: cdkd's recorded state holds only the ` +
        `redaction mask there, and the value is not recoverable from state. That happens when a ` +
        `custom resource handler declared its response NoEcho: true — the value is generated by ` +
        `the handler, so cdkd has nothing to re-derive it from and must not write the literal ` +
        `mask to AWS. Two remedies: force that custom resource to update (change one of its ` +
        `properties, e.g. a nonce / version property) so its handler runs again and supplies the ` +
        `value in this same run; or stop setting NoEcho on that response. If the value comes ` +
        `from ANOTHER stack, the producer and this stack must deploy in ONE run (cdkd deploy ` +
        `--all) with the producer's custom resource actually running — re-deploying the producer ` +
        `by itself does not help, because it re-masks the value on the way into its own state. ` +
        `See https://github.com/go-to-k/cdkd/issues/2449.`,
      resourceType,
      logicalId
    );
  }

  private redactOperationsForJournal<T extends CompletedOperation | FailedOperation>(
    operations: T[]
  ): T[] {
    return operations.map((op) => {
      const secrets = this.perResourceSecrets.get(op.logicalId);
      const templateProps = this.perResourceTemplateProps.get(op.logicalId);
      // `previousState` is redactable with NO secrets map at all (#1900), so the
      // early return has to let that case through or the whole state-sourced
      // half is dead code.
      if ((!secrets || secrets.size === 0) && !op.previousState) return op;
      const ownSecrets = secrets ?? new Map<string, string>();
      const next = { ...op } as CompletedOperation & FailedOperation;
      if (next.properties) {
        next.properties = redactSecretsForState(next.properties, ownSecrets, templateProps);
      }
      if (next.attemptedProperties) {
        next.attemptedProperties = redactSecretsForState(
          next.attemptedProperties,
          ownSecrets,
          templateProps
        );
      }
      if (next.previousState) {
        // No `sourceProperties`: the previous record positions itself.
        next.previousState = scrubResourceRecord(next.previousState, ownSecrets);
      }
      return next as unknown as T;
    });
  }

  private redactStateForPersist(state: StackState): StackState {
    const resources: Record<string, ResourceState> = {};
    for (const [logicalId, record] of Object.entries(state.resources)) {
      // Redact each record ONLY with the secrets substituted during that
      // resource's own resolution — see the `perResourceSecrets` field doc.
      const secrets = this.perResourceSecrets.get(logicalId);
      // The template bag is the POSITION source (#1904); when this resource was
      // not resolved this deploy there is none, and `scrubResourceRecord` falls
      // back to the record's own `properties` for the observed bag (#1900).
      const templateProps = this.perResourceTemplateProps.get(logicalId);
      resources[logicalId] = scrubResourceRecord(
        record,
        secrets ?? new Map<string, string>(),
        // No template bag means this resource was not resolved this deploy (an
        // UNCHANGED one). `scrubResourceRecord` then falls back to the record's
        // own already-redacted properties as the observed bag's source, which is
        // the #1900 path — so do NOT "simplify" this to `templateProps!`.
        templateProps
      );
    }
    // `outputs` is also secret-bearing: a `CfnOutput` whose Value resolves a
    // SECRET dynamic reference (`{{resolve:secretsmanager:...}}`, or a
    // `{{resolve:ssm:...}}` pointing at a `SecureString` parameter — issue
    // #1901 — including an Fn::Sub/Join embedding one) stores the resolved
    // plaintext, which would otherwise reach
    // state.json / the exports index / the deploy summary. Redact it with the
    // OUTPUTS' own secrets map (a literal output equal to a secret is not
    // recorded there, so it is not touched).
    return {
      ...state,
      resources,
      outputs: this.redactOutputs(state.outputs),
    };
  }

  /**
   * Stamp `parentStack` / `parentLogicalId` / `parentRegion` (schema v6+)
   * onto a state object that's about to be saved, when this engine was
   * constructed with `options.parentStackInfo` (= it's deploying a
   * nested-stack child). Returns the state unchanged for top-level
   * deploys so the three v6 fields stay absent from non-child state files.
   *
   * ALSO the single choke point where resolved SECRET plaintext is redacted out
   * of the persisted state (GHSA fix): every `stateBackend.saveState` call in
   * this engine wraps its state through here, so redacting `resources` once here
   * covers `properties` / `attributes` / `observedProperties` across every
   * create / update / replacement / rollback / observed-capture path uniformly —
   * including the async observed-capture drain that runs after the resolver
   * context is gone (which is why the secret map is session-wide).
   */
  private withParentInfo(state: StackState): StackState {
    const redacted = this.redactStateForPersist(state);
    if (!this.options.parentStackInfo) return redacted;
    const { parentStack, parentLogicalId, parentRegion } = this.options.parentStackInfo;
    return {
      ...redacted,
      parentStack,
      parentLogicalId,
      parentRegion,
    };
  }

  /**
   * Kick off `provider.readCurrentState` for a freshly-created/updated
   * resource without blocking the deploy critical path. The promise
   * lands in `observedCaptureTasks` keyed by `logicalId`; the deploy's
   * success-path drain (`drainObservedCaptures`) awaits the full set
   * and merges the resolved values into `ResourceState.observedProperties`
   * before the final state save.
   *
   * Errors are swallowed at the Promise level — readCurrentState
   * failing must not fail the deploy. The map entry resolves to
   * `undefined` for failures and for providers without
   * `readCurrentState`; both translate to "no observedProperties" at
   * the merge step, which is fine: drift falls back to comparing
   * against `properties`.
   */
  private kickOffObservedCapture(
    provider: ResourceProvider,
    logicalId: string,
    physicalId: string,
    resourceType: string,
    resolvedProps: Record<string, unknown>,
    context?: import('../types/resource.js').ReadCurrentStateContext
  ): void {
    if (this.options.captureObservedState !== true) return;
    if (!provider.readCurrentState) return;

    const promise = provider
      .readCurrentState(physicalId, logicalId, resourceType, resolvedProps, context)
      .catch((err: unknown) => {
        this.logger.debug(
          `observedProperties capture for ${logicalId} (${resourceType}) failed: ${err instanceof Error ? err.message : String(err)} — drift will fall back to template properties for this resource until the next successful deploy.`
        );
        return undefined;
      });
    this.observedCaptureTasks.set(logicalId, promise);
  }

  /**
   * Wait for every in-flight `readCurrentState` promise from the
   * deploy's success path, then merge each resolved snapshot into the
   * matching `ResourceState.observedProperties`. After this runs the
   * map is drained so a subsequent deploy starts fresh.
   *
   * Called from `doDeploy` immediately before the final `saveState`.
   * The rollback / failure paths intentionally do NOT call this — a
   * failed deploy's partial state is already inconsistent, and waiting
   * on potentially many in-flight reads would slow down the rollback
   * itself.
   */
  private async drainObservedCaptures(
    stateResources: Record<string, ResourceState>
  ): Promise<void> {
    if (this.observedCaptureTasks.size === 0) return;
    const entries = Array.from(this.observedCaptureTasks.entries());
    this.observedCaptureTasks.clear();
    const resolved = await Promise.all(entries.map(([, p]) => p));
    for (let i = 0; i < entries.length; i++) {
      const logicalId = entries[i]![0];
      const observed = resolved[i];
      const target = stateResources[logicalId];
      if (target && observed !== undefined) {
        target.observedProperties = observed;
      }
    }
  }

  /**
   * Build a sibling context for the deploy-time `observedProperties`
   * capture of an IAM principal (`AWS::IAM::Role` / `::User` / `::Group`)
   * so that inline policies managed by a SEPARATE `AWS::IAM::Policy`
   * resource are filtered OUT of the captured `Policies` baseline —
   * exactly as the `cdkd drift` read path already does via
   * `buildReadCurrentStateContext`.
   *
   * Without this, the post-CREATE / post-UPDATE capture passes no
   * context, so `collectInlinePolicyNamesManagedBySiblings` no-ops. The
   * capture's `ListRolePolicies` then RACES the sibling
   * `AWS::IAM::Policy`'s `PutRolePolicy`: when the read lands after the
   * write, the sibling-managed `DefaultPolicy*` leaks into
   * `observedProperties.Policies`. A later `cdkd drift` (whose AWS-current
   * side filters it correctly) then reports phantom drift
   * `- Policies:[DefaultPolicy] / + Policies:[]` — a systemic false
   * positive that fires for essentially every Lambda / L2 construct whose
   * grant emits a `Default Policy`.
   *
   * The sibling relationship is fully determined by the TEMPLATE (which
   * `AWS::IAM::Policy` lists this principal in its `Roles`/`Users`/
   * `Groups`), so this is built from the template — deploy-order-
   * independent, immune to the race. Each matched sibling is synthesized
   * into the resolved-property shape
   * `collectInlinePolicyNamesManagedBySiblings` expects
   * (`{ [attachmentField]: [thisPrincipalPhysicalId], PolicyName }`).
   *
   * Returns `undefined` (no context) for non-IAM-principal types and when
   * no sibling policy attaches to the captured principal — both leave the
   * capture behaving exactly as before.
   */
  private async buildObservedCaptureSiblings(
    resourceType: string,
    capturedLogicalId: string,
    capturedPhysicalId: string,
    template: CloudFormationTemplate | undefined,
    stateResources: Record<string, ResourceState>,
    stackName: string,
    parameterValues?: Record<string, unknown>,
    conditions?: Record<string, boolean>
  ): Promise<import('../types/resource.js').ReadCurrentStateContext | undefined> {
    // Capture disabled (kickOffObservedCapture would ignore the context) —
    // skip the template walk / resolver work entirely.
    if (this.options.captureObservedState !== true) return undefined;
    const attachmentField =
      resourceType === 'AWS::IAM::Role'
        ? 'Roles'
        : resourceType === 'AWS::IAM::User'
          ? 'Users'
          : resourceType === 'AWS::IAM::Group'
            ? 'Groups'
            : undefined;
    if (!attachmentField) return undefined;
    const resources = template?.Resources;
    if (!resources) return undefined;

    // Built lazily — only a non-literal `PolicyName` (rare; e.g. an
    // Fn::Sub) needs the resolver, and the overwhelmingly common case
    // (a literal Default-Policy name) never touches it.
    let resolverContext: import('./intrinsic-function-resolver.js').ResolverContext | undefined;

    const isRefTo = (value: unknown, logicalId: string): boolean =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>)['Ref'] === logicalId;

    const siblings: NonNullable<
      import('../types/resource.js').ReadCurrentStateContext['siblings']
    > = {};
    for (const [lid, res] of Object.entries(resources)) {
      if (lid === capturedLogicalId) continue;
      if (res.Type !== 'AWS::IAM::Policy') continue;
      const props = (res.Properties ?? {}) as Record<string, unknown>;
      const attachments = props[attachmentField];
      if (!Array.isArray(attachments)) continue;
      // CDK emits `Roles: [{Ref: <principalLogicalId>}]`; hand-written
      // templates may use the literal physical name. Match either.
      const attachesToCaptured = attachments.some(
        (a) => isRefTo(a, capturedLogicalId) || a === capturedPhysicalId
      );
      if (!attachesToCaptured) continue;
      // PolicyName is almost always a literal string; resolve only when
      // it carries an intrinsic (e.g. Fn::Sub with a pseudo-parameter).
      // Best-effort: an unresolvable name just won't be added to the
      // exclude set (no worse than the pre-fix behavior).
      let policyName: unknown = props['PolicyName'];
      if (policyName !== undefined && typeof policyName !== 'string') {
        resolverContext ??= this.buildResolverContext(
          {
            template: template!,
            resources: stateResources,
            ...(parameterValues && { parameters: parameterValues }),
            ...(conditions && { conditions }),
          },
          stackName
        );
        try {
          policyName = await this.resolver.resolve(policyName, resolverContext);
        } catch {
          continue;
        }
      }
      if (typeof policyName !== 'string') continue;
      siblings[lid] = {
        resourceType: 'AWS::IAM::Policy',
        properties: { [attachmentField]: [capturedPhysicalId], PolicyName: policyName },
      };
    }
    return Object.keys(siblings).length > 0 ? { siblings } : undefined;
  }

  /**
   * Kick off `provider.readCurrentState` for every resource in the
   * loaded state that lacks `observedProperties` (e.g. state written
   * by a pre-v3 binary, or a v3 record where a NO_CHANGE-skipped
   * resource's baseline never landed). Calls go through
   * `kickOffObservedCapture`, so they share the same fire-and-forget
   * pipeline, error swallowing, and final-drain wiring that the
   * post-CREATE / post-UPDATE captures use.
   *
   * The deploy critical path does NOT wait on these; the cost is
   * bounded by `max(per-resource readCurrentState latency)` (typically
   * ~200-300ms in practice) once at the end-of-deploy drain. Any
   * resource that subsequently goes through CREATE / UPDATE in the
   * same deploy will overwrite this entry via the `Map.set` keyed by
   * `logicalId` (latest-wins) — so there's no double-write to state,
   * just a wasted SDK call for the (rare) UPDATE / DELETE intersection.
   *
   * Resources whose provider lookup throws (e.g. unsupported type) or
   * lacks `readCurrentState` are silently skipped — same policy as the
   * manual `cdkd state refresh-observed` command.
   */
  private kickOffAutoRefreshObservedProperties(
    stateResources: Record<string, ResourceState>
  ): void {
    if (this.options.captureObservedState !== true) return;
    // Dry run must not fire real SDK reads (matches the dry-run
    // guarantee that no AWS side-effect runs).
    if (this.options.dryRun === true) return;
    let toRefresh = 0;
    const candidates: Array<{
      logicalId: string;
      resource: ResourceState;
    }> = [];
    for (const [logicalId, resource] of Object.entries(stateResources)) {
      if (resource.observedProperties !== undefined) continue;
      candidates.push({ logicalId, resource });
    }
    if (candidates.length === 0) return;

    // Issue #323: at the v2→v3 schema-upgrade refresh path, state is
    // fully loaded from the previous deploy — sibling AWS::IAM::Policy
    // resources are all present. Pass a cross-resource context so IAM
    // providers can filter inline policies managed via sibling
    // resources, otherwise observed.Policies would record the
    // sibling-managed entries and the next `cdkd drift` would fire
    // false drift (filtered AWS-current = []) until `cdkd drift
    // --accept` runs. Build the siblings map once and clone-minus-self
    // per resource to avoid an O(N²) walk.
    const allSiblings: Record<
      string,
      { resourceType: string; properties: Record<string, unknown> }
    > = {};
    for (const [lid, res] of Object.entries(stateResources)) {
      allSiblings[lid] = {
        resourceType: res.resourceType,
        properties: res.properties ?? {},
      };
    }

    for (const { logicalId, resource } of candidates) {
      // Skip-list / unsupported types: getProvider throws — silently skip
      // (mirrors `cdkd state refresh-observed`'s policy: best-effort,
      // no failure on a state record we cannot resolve).
      let provider: ResourceProvider;
      try {
        provider = this.providerRegistry.getProvider(resource.resourceType);
      } catch {
        continue;
      }
      if (!provider.readCurrentState) continue;
      const siblings = { ...allSiblings };
      delete siblings[logicalId];
      this.kickOffObservedCapture(
        provider,
        logicalId,
        resource.physicalId,
        resource.resourceType,
        resource.properties ?? {},
        { siblings }
      );
      toRefresh++;
    }

    if (toRefresh > 0) {
      this.logger.warn(
        `cdkd state schema upgrade detected — refreshing observed-properties baseline for ${toRefresh} resource(s) (one-time, runs in parallel with deploy)`
      );
    }
  }

  private async doDeploy(
    stackName: string,
    template: CloudFormationTemplate
  ): Promise<DeployResult> {
    const startTime = Date.now();
    this.logger.debug(`Starting deployment for stack: ${stackName}`);

    // Warm the create-only DescribeType cache in parallel with the lock + state
    // read below. calculateDiff (further down) resolves each UPDATE resource's
    // create-only property paths via cloudformation:DescribeType (~0.8s cold per
    // type, cached per-type for the deploy lifetime). Kicking those lookups off
    // here for the template's distinct resource types — fire-and-forget — lets
    // the diff's awaits hit a warm cache instead of paying the round-trip inline
    // on the critical path. getCreateOnlyPropertyPaths is idempotent (per-type
    // module cache) and never throws (it swallows DescribeType errors), so this
    // is pure latency-hiding with no correctness impact. Custom types short-
    // circuit without an API call; on a pure-CREATE (first) deploy the diff makes
    // no create-only lookups at all, so the prefetched entries simply go unused
    // that run — bounded, deduped, non-blocking waste, never a correctness issue.
    // Part of #1180.
    //
    // Schema-less types are filtered out: `AWS::CDK::Metadata` (the CDK
    // construct-tree sentinel every synthesized template carries) and custom
    // resources have no CloudFormation registry entry, so DescribeType can
    // only fail for them. Before the filter, every single deploy burned one
    // guaranteed-to-fail API call on the metadata sentinel AND printed a
    // "Grant cloudformation:DescribeType ..." warning naming a pseudo-resource
    // the user cannot act on. The diff / type-validation / property-validation
    // passes below already exclude `AWS::CDK::Metadata`; this makes the
    // prefetch consistent with them. `hasNoRegistrySchema` short-circuits
    // inside the resolver too, so this filter is the cheap outer guard.
    for (const type of new Set(
      Object.values(template.Resources)
        .map((r) => r.Type)
        .filter((type) => !hasNoRegistrySchema(type))
    )) {
      // getCreateOnlyPropertyPaths already swallows DescribeType errors, but a
      // .catch here defends against any unexpected rejection so a fire-and-forget
      // prefetch never surfaces as an unhandled promise rejection.
      void getCreateOnlyPropertyPaths(type).catch(() => {});
    }

    // Live progress renderer: shows in-flight resources as a multi-line area
    // at the bottom of the terminal. Self-disables on non-TTY and when
    // `CDKD_NO_LIVE=1` is set (the CLI sets this in verbose mode so debug
    // logs do not interleave with the live area). Created (not started)
    // before the lock acquisition below because the SIGINT handler routes
    // its notice through it; `printAbove` falls through to a direct write
    // while the renderer is not yet started.
    const renderer = getLiveRenderer();

    // Register SIGINT handler to save partial state on Ctrl+C. Registered
    // BEFORE `acquireLockWithRetry` (issue #1348) so a signal landing during
    // the acquisition's S3 round-trip flips the interrupt flag instead of
    // hitting the unhandled default (or the #1342 forwarder's exit-143
    // fallback) and stranding the just-written lock: with the flag set, the
    // DAG executor dispatches no work and the `finally` below releases the
    // lock through the normal path.
    this.interrupted = false;
    this.interruptCause = null;
    const sigintHandler = () => {
      // Route the interrupt notice through the live renderer so it does not
      // collide with the in-flight task display.
      renderer.printAbove(() => {
        process.stderr.write(
          '\nInterrupted — saving partial state after current operations complete...\n'
        );
      });
      this.interrupted = true;
      this.interruptCause ??= 'user';
    };
    process.on('SIGINT', sigintHandler);

    // Acquire lock with retry (retries up to 3 times with 2s delay for transient lock conflicts)
    try {
      await this.lockManager.acquireLockWithRetry(stackName, this.stackRegion, undefined, 'deploy');
    } catch (error) {
      // The try/finally that owns the listener removal starts below — clean
      // up here so an acquire failure does not leak the handler.
      process.removeListener('SIGINT', sigintHandler);
      throw error;
    }

    try {
      // Started INSIDE this `try` (issue #2171): `start()` writes to stdout and
      // can throw (EPIPE on `cdkd deploy | head`), and it sits AFTER the lock
      // acquisition, so a throw outside would strand the lock for its full TTL.
      // This is the same move issue #2161 made in `destroy-runner.ts`; the two
      // commands had the identical shape and only one of them was fixed.
      renderer.start();

      // 1. Load current state
      const currentStateData = await this.stateBackend.getState(stackName, this.stackRegion);
      const currentState: StackState = currentStateData?.state ?? {
        version: STATE_SCHEMA_VERSION_CURRENT,
        region: this.stackRegion,
        stackName,
        resources: {},
        outputs: {},
        // A record that does not exist yet exports nothing, and that is KNOWN
        // (issue #2193): a first deploy that fails before its outputs resolve
        // carries this bag forward, and must not persist it as "not known".
        exportNames: [],
        lastModified: Date.now(),
      };
      const currentEtag = currentStateData?.etag;
      // Set when we loaded a `version: 1` legacy record. The next save
      // migrates it to the new key.
      const migrationPending = currentStateData?.migrationPending ?? false;

      this.logger.debug(
        `Loaded current state: ${Object.keys(currentState.resources).length} resources`
      );

      // 1a-pre. Pre-provisioning gate. Runs before the journal note, the
      // observed-properties refresh, parsing, the diff and every provider
      // call — so a caller that declines here has changed nothing. Reuses
      // the state read just performed instead of making the CLI issue its
      // own pre-lock GET of the same object.
      if (this.options.onCurrentStateLoaded) {
        await this.options.onCurrentStateLoaded(stackName, currentStateData?.state);
      }

      // 1b. If a rollback journal exists, a previous deploy failed / was
      // interrupted and has not yet been reverted (issue #1183). Note that
      // `cdkd rollback` can revert it; the deploy proceeds (fix-forward is
      // still supported). Best-effort — a journal read failure must not
      // block the deploy.
      try {
        const journal = await this.stateBackend.loadRollbackJournal(stackName, this.stackRegion);
        if (journal && journal.segments.length > 0) {
          // A journal whose every segment carries no completed ops is the
          // failed-only shape kept after a CLEAN automatic rollback (issue
          // #1208) — the stack is already back at its pre-deploy baseline,
          // so the generic "run cdkd rollback to revert" advice would be
          // misleading (a plain rollback is a no-op replay there). Detected
          // structurally, not by reason, so mixed journals keep the generic
          // note.
          const failedOnly =
            journal.segments.every((s) => s.operations.length === 0) &&
            journal.segments.some((s) => (s.failedOperations?.length ?? 0) > 0);
          this.logger.info(
            failedOnly
              ? `A previous deploy of '${stackName}' failed and was automatically rolled back. ` +
                  `The failed resource may be partially applied — run ` +
                  `'cdkd rollback ${stackName} --revert-failed' to revert it, or continue ` +
                  `deploying to fix forward (a successful deploy clears this note).`
              : `A previous deploy of '${stackName}' failed or was interrupted. ` +
                  `Run 'cdkd rollback ${stackName}' to revert it, or continue deploying to fix forward.`
          );
        }
      } catch {
        // ignore — journal is advisory here
      }

      // 1a. Auto-refresh observedProperties for any state entry that lacks it
      // (state written by an older binary / direct edit). Fires
      // `provider.readCurrentState` fire-and-forget through the same
      // `kickOffObservedCapture` pipeline that successful CREATE / UPDATE
      // uses, so the in-flight set is drained right before the final
      // `saveState`. Latest-wins semantics (Map.set keyed by logicalId)
      // means a CREATE / UPDATE later in the same deploy overwrites
      // the auto-refresh entry — no double-write to state. CREATEs for
      // brand-new resources skip this loop because they're not yet in
      // `currentState.resources`. Closes the upgrade UX gap left by
      // v3 schema: the manual `cdkd state refresh-observed` command
      // remains for non-deploy refresh.
      this.kickOffAutoRefreshObservedProperties(currentState.resources);

      // 2. Template parsing is handled by DagBuilder (dependency analysis) and
      // IntrinsicResolver (intrinsic function resolution) in later steps
      this.logger.debug(`Template has ${Object.keys(template.Resources || {}).length} resources`);

      // 2.5. Resolve parameters from template and user input
      // The inherited bag travels into `resolveParameters` as well as into the
      // per-resource contexts below (issue #1903 review round 2). This is the
      // seam where the PARENT's already-decrypted values first enter the child
      // engine, so it is where both the `--verbose` parameter lines are masked
      // and where a declared `Type` that would coerce the value out of cdkd's
      // string-keyed redaction model is refused.
      const parameterValues = await this.resolver.resolveParameters(
        template,
        this.options.parameters,
        {
          ...(this.options.inheritedSecrets &&
            this.options.inheritedSecrets.size > 0 && {
              inheritedSecrets: this.options.inheritedSecrets,
            }),
        }
      );
      this.logger.debug(
        `Resolved ${Object.keys(parameterValues).length} parameters: ${Object.keys(parameterValues).join(', ')}`
      );

      // 2.6. Evaluate conditions from template
      const context = this.buildResolverContext(
        {
          template,
          resources: currentState.resources,
          parameters: parameterValues,
        },
        stackName
      );
      const conditions = await this.resolver.evaluateConditions(context);
      this.logger.debug(
        `Evaluated ${Object.keys(conditions).length} conditions: ${Object.keys(conditions).join(', ')}`
      );

      // 2.7. Prune resources whose `Condition:` key evaluated false (issue
      // #840). CFn does not strip condition-gated resources at synth time —
      // they sit in `Resources` with a `Condition:` key regardless of value,
      // and the deploy engine excludes them when the condition is false. From
      // here on the whole pipeline (type/property validation, DAG, diff,
      // provisioning) operates on this CFn-effective resource set, so a
      // condition-false resource that exists in prior state but is now absent
      // from the effective template flows through the diff's existing
      // "in state but not in desired -> DELETE" path (CFn removes it the same
      // way), and a condition-false resource is never created in the first
      // place.
      const effectiveTemplate = this.templateParser.filterResourcesByCondition(
        template,
        conditions
      );

      // 3. Validate resource types (before deployment starts)
      // Skip metadata resources as they don't actually deploy
      const resourceTypes = new Set(
        Object.values(effectiveTemplate.Resources || {})
          .map((r) => r.Type)
          .filter((type) => type !== 'AWS::CDK::Metadata')
      );
      this.providerRegistry.validateResourceTypes(resourceTypes);
      this.logger.debug(`All resource types validated`);

      // 3.5. Report top-level resource property routing decisions
      // (#614). For each resource using a silent-drop top-level property,
      // info-log that cdkd is auto-routing it via Cloud Control (which
      // forwards the full property map). For each resource explicitly
      // opted out via `--allow-unsupported-properties Type:Prop`, warn
      // that the silent drop has been accepted. No throw — the legacy
      // PR #608 fail-fast was reversed by #614 to a default-on
      // auto-route. Skips AWS::CDK::Metadata (filtered by the same
      // predicate as the type set).
      const resourcesForPropertyCheck = Object.entries(effectiveTemplate.Resources || {})
        .filter(([, r]) => r.Type !== 'AWS::CDK::Metadata')
        .map(([logicalId, r]) => ({
          logicalId,
          resourceType: r.Type,
          properties: r.Properties,
          // Thread the state-recorded routing layer so already-sticky CC
          // resources demote the info-log to debug (avoids "routing via
          // Cloud Control API" repeated on every redeploy).
          provisionedBy: currentState.resources[logicalId]?.provisionedBy,
        }));
      this.providerRegistry.validateResourceProperties(resourcesForPropertyCheck);
      this.logger.debug(`All resource properties validated`);

      // 4. Build dependency graph
      const dag = this.dagBuilder.buildGraph(effectiveTemplate);
      const executionLevels = this.dagBuilder.getExecutionLevels(dag);
      this.logger.debug(`Dependency graph: ${executionLevels.length} execution levels`);

      // 5. Calculate diff
      // Pass a best-effort resolver so that changes hidden inside intrinsics (e.g.
      // `Fn::Join` literal args like "-value" -> "-value2") are detected against
      // the already-resolved values stored in state.
      const diffResolverContext = this.buildResolverContext(
        {
          template: effectiveTemplate,
          resources: currentState.resources,
          // The DIFF side binds the REDACTED parameter bag on a nested-stack
          // child (issue #1903). The provisioning contexts below deliberately
          // keep `parameterValues` — the real values are what reach AWS — and
          // so does the condition evaluation above, where substituting an
          // expression would flip an `Fn::Equals` over a parameter. See
          // `redactParametersForDiff`.
          parameters: this.redactParametersForDiff(parameterValues),
          conditions,
        },
        stackName
      );
      // The diff-phase resolution is best-effort (the calculator catches
      // failures and keeps the raw intrinsic): a Ref to a resource this
      // same deploy will CREATE is the expected case, so the resolver logs
      // it at debug, not warn (issue #1017). The provisioning-phase
      // resolver contexts do NOT set this — there, an unresolvable Ref is
      // a genuine error signal.
      diffResolverContext.bestEffort = true;
      // Leave SECRET `{{resolve:...}}` dynamic references UNRESOLVED for the
      // diff (GHSA fix): state now stores the unresolved expression, so
      // comparing the desired side as its expression too avoids a spurious
      // perpetual UPDATE on every deploy of a secret-bearing resource, and
      // fetches no secret value at plan time. `cdkd diff --recursive` sets the
      // same flag when it resolves a nested child's input `Parameters`
      // (`resolveChildStackParameters`) — as of issue #1903, together with the
      // child-state half that makes the comparison self-consistent; setting it
      // there alone would have compared an expression against a child state
      // still holding plaintext. A changed expression still diffs.
      // An `ssm` reference is classified by the parameter's TYPE rather than by
      // its spelling (issue #1901), so unlike the secretsmanager case the diff
      // DOES issue one `GetParameter` per not-yet-classified reference — with
      // `WithDecryption: false`, so a `SecureString` never yields plaintext
      // here, while a `String` / `StringList` keeps resolving as the public
      // config state stores resolved.
      diffResolverContext.skipDynamicReferences = true;
      const diffResolveFn = (value: unknown) => this.resolver.resolve(value, diffResolverContext);
      const changes = await this.diffCalculator.calculateDiff(
        currentState,
        effectiveTemplate,
        diffResolveFn,
        // Shared with `cdkd diff` (issue #1591): a preview that narrows
        // differently from the apply forecasts a change the deploy will never
        // make, which is this issue's own bug class moved one command over.
        makeCanonicalizePropertiesFn(this.providerRegistry)
      );
      const hasChanges = this.diffCalculator.hasChanges(changes);

      if (!hasChanges) {
        this.logger.info('No changes detected. Stack is up to date.');

        // The diff only inspects Resources, so an Outputs-only change (a new
        // Export added because a downstream stack now references this one — its
        // Resources stay identical) lands here with hasChanges=false. If we
        // early-returned without persisting, the new export would never be
        // written to state / the exports index and the consumer's subsequent
        // Fn::ImportValue would fail (issue #875). So in the no-change path we
        // also resolve the template outputs against current state and persist
        // them when they differ — alongside the existing observed-properties
        // refresh (e.g. a v2 → v3 schema upgrade on a stack with nothing to
        // deploy). Both are skipped in dry-run.
        let persistedOutputs: Record<string, unknown> = currentState.outputs ?? {};
        if (!this.options.dryRun) {
          // Resolve against `effectiveTemplate` (condition-pruned) — the same
          // map the executeDeployment path resolves. Outputs reference
          // resources, which come from `currentState.resources` (the arg), and
          // condition pruning only touches `Resources`, so resolving against
          // `effectiveTemplate` vs the raw `template` is equivalent here.
          const resolvedOutputs = this.redactOutputs(
            await this.resolveOutputs(
              effectiveTemplate,
              currentState.resources,
              stackName,
              parameterValues,
              conditions
            )
          );
          // resolveOutputs stores `undefined` for any output it could not
          // resolve (logged as a warn there). In the no-change path every
          // resource is already in state so resolution should succeed; if it
          // doesn't, keep the existing good outputs rather than overwrite them
          // with a partial map.
          const resolutionFailed = Object.values(resolvedOutputs).some((v) => v === undefined);
          const outputsChanged =
            !resolutionFailed && !outputMapsEqual(persistedOutputs, resolvedOutputs);
          // Issue #2193: the EFFECTIVE export set can change without the outputs
          // VALUES changing, and the no-change path is the only place that would
          // persist it. Two shapes reach here with `outputsChanged` false:
          //   - a pre-v9 record (`exportNames` undefined) still feeding the index
          //     every plain Output name — the legacy every-key set differs from
          //     the resolved exports whenever there is a plain name to suppress;
          //   - a SELF-NAMED export toggled on a v9 record: adding
          //     `Export: { Name: <same-as-output-key> }` (or removing it) rewrites
          //     the same key with the same value, so the bag is byte-equal, but
          //     `exportNames` flips between `[]` and `[<key>]`. Without this the
          //     added export never lands in state/index (consumer's Fn::ImportValue
          //     hard-fails), and the removed one is a phantom export served forever.
          // Detect it by comparing the CURRENTLY-effective set against this pass's
          // resolved set. Subsumes the old pre-v9 backfill and catches both
          // self-named directions. Kept OUT of `outputsChanged` deliberately: this
          // is not an outputs-VALUE change, so it must not flip the "Outputs-only
          // change" log or the `resolvedOutputs`-vs-`persistedOutputs` bag choice.
          const currentEffectiveExports = new Set(importableOutputKeys(currentState));
          const resolvedExportSet = new Set(this.resolvedExportNames);
          const exportSetChanged =
            !resolutionFailed &&
            (currentEffectiveExports.size !== resolvedExportSet.size ||
              [...resolvedExportSet].some((k) => !currentEffectiveExports.has(k)));

          // Surface the rare case where outputs DID change but a resolution
          // failure suppressed the persist. resolveOutputs already warns
          // per-output, but a call-site summary makes the "deploy reports
          // no-change yet a new export silently failed to land" path explicit
          // (a downstream Fn::ImportValue would otherwise break later with no
          // obvious link back to this deploy).
          if (resolutionFailed && !outputMapsEqual(persistedOutputs, resolvedOutputs)) {
            this.logger.warn(
              'Outputs changed but one or more could not be resolved; keeping the previously ' +
                'persisted outputs. A downstream Fn::ImportValue may fail until the next deploy.'
            );
          }

          // Drain any auto-refresh readCurrentState calls (drainObservedCaptures
          // short-circuits on an empty map) so the refreshed observed-properties
          // baseline lands in the same save.
          const observedRefresh = this.observedCaptureTasks.size > 0;
          if (observedRefresh) {
            await this.drainObservedCaptures(currentState.resources);
          }

          if (observedRefresh || outputsChanged || exportSetChanged) {
            try {
              const refreshedState: StackState = {
                version: STATE_SCHEMA_VERSION_CURRENT,
                region: this.stackRegion,
                stackName: currentState.stackName,
                resources: currentState.resources,
                outputs: (outputsChanged ? resolvedOutputs : persistedOutputs) as Record<
                  string,
                  string
                >,
                // The set belongs to the bag written above: this pass's when
                // the bag resolved clean (changed, or equal — either way the
                // resolved set describes it), the previous record's when the
                // persisted bag was kept because resolution failed.
                ...(resolutionFailed
                  ? exportNamesCarriedFrom(currentState)
                  : { exportNames: [...this.resolvedExportNames] }),
                // Preserve existing imports[] / outputReads[] (v8+) — otherwise
                // the refresh would silently strip the strong-reference record
                // on every diff-clean deploy. Unioned with this session's
                // records rather than taking the snapshot alone (issue #2057):
                // the no-change path resolves nothing new in the common case,
                // so the union is usually an identity, and applying one rule at
                // every non-success save leaves no exception to remember. See
                // `crossStackReadsForPartialSave`.
                ...crossStackReadsForPartialSave(
                  currentState,
                  this.recordedImports,
                  this.recordedOutputReads
                ),
                lastModified: Date.now(),
              };
              const saveOptions: { expectedEtag?: string; migrateLegacy?: boolean } = {};
              if (currentEtag !== undefined) saveOptions.expectedEtag = currentEtag;
              if (migrationPending) saveOptions.migrateLegacy = true;
              await this.stateBackend.saveState(
                stackName,
                this.stackRegion,
                this.withParentInfo(refreshedState),
                saveOptions
              );
              if (outputsChanged || exportSetChanged) {
                persistedOutputs = refreshedState.outputs;
                if (outputsChanged) {
                  this.logger.info('Persisted Outputs-only change (no resource diff).');
                } else {
                  this.logger.debug(
                    'Persisted export-set change (no outputs-value diff, no-change path, #2193)'
                  );
                }
                // Update the persistent exports index so the newly-added export
                // resolves O(1) for consumers — with the EXPORTS only (#2193),
                // which on the backfill arm is what evicts the plain-name
                // entries a pre-v9 deploy published. Inside the try so a failed
                // state save doesn't publish an export that wasn't persisted;
                // updateForStack is itself best-effort (swallows + warns).
                if (this.exportIndexStore) {
                  await this.exportIndexStore.updateForStack(
                    stackName,
                    this.stackRegion,
                    importableOutputs(refreshedState)
                  );
                }
              } else {
                this.logger.debug('Persisted refreshed observedProperties (no-change path)');
              }
            } catch (saveError) {
              this.logger.warn(
                `Failed to persist no-change state update: ${saveError instanceof Error ? saveError.message : String(saveError)} — drift baseline / outputs will be re-resolved on next deploy.`
              );
            }
          }
        }

        // A clean no-change deploy is still a SUCCESSFUL deploy — drop any
        // lingering rollback journal, matching the documented "deleted on
        // the next successful deploy" contract (the changes path does this
        // at its end too). This matters for the failed-only segment a clean
        // auto-rollback retains (issue #1208): the typical fix-forward is
        // REMOVING the failed resource from the template, which lands here
        // with hasChanges=false — without this delete the journal (and its
        // "previous deploy failed" note) would linger indefinitely.
        if (!this.options.dryRun) {
          await this.deleteRollbackJournalBestEffort(stackName);
        }

        return {
          stackName,
          created: 0,
          updated: 0,
          deleted: 0,
          deleteSkipped: 0,
          updatePartial: 0,
          unchanged: Object.keys(currentState.resources).length,
          durationMs: Date.now() - startTime,
          outputs: this.buildDisplayOutputs(template, persistedOutputs),
          attributeFallbackCount: this.resolver.getPhysicalIdFallbackCount(),
        };
      }

      // Log changes summary
      const createChanges = this.diffCalculator.filterByType(changes, 'CREATE');
      const updateChanges = this.diffCalculator.filterByType(changes, 'UPDATE');
      const deleteChanges = this.diffCalculator.filterByType(changes, 'DELETE');

      this.logger.info(
        `Changes: ${green(createChanges.length)} to create, ${yellow(updateChanges.length)} to update, ${red(deleteChanges.length)} to delete`
      );

      if (this.options.dryRun) {
        this.logger.info('Dry run mode - skipping actual deployment');
        return {
          stackName,
          created: createChanges.length,
          updated: updateChanges.length,
          deleted: deleteChanges.length,
          // A dry run issues no provider call, so nothing can be skipped.
          deleteSkipped: 0,
          updatePartial: 0,
          unchanged: this.diffCalculator.filterByType(changes, 'NO_CHANGE').length,
          durationMs: Date.now() - startTime,
          attributeFallbackCount: this.resolver.getPhysicalIdFallbackCount(),
        };
      }

      // Issue #1111 item 3 (review fix): the diff phase above resolves
      // intrinsics through the SAME counted resolver, so a warn-path
      // fallback on a to-be-updated resource would otherwise count once
      // during diff and AGAIN during provisioning (~2x distinct sites in
      // the summary). Reset here so the change-path summary counts each
      // fallback site once (provisioning + final output resolution). The
      // no-change / dry-run early returns above keep the deploy()-start
      // reset: their only resolutions ARE the diff phase (+ the no-change
      // path's output resolution), so nothing double-counts there. Full
      // semantics in the counter's JSDoc
      // ({@link IntrinsicFunctionResolver.getPhysicalIdFallbackCount}).
      this.resolver.resetPhysicalIdFallbackCount();

      // Progress counter for tracking overall deployment progress
      const totalOperations = createChanges.length + updateChanges.length + deleteChanges.length;
      const progress = { current: 0, total: totalOperations };

      // 6. Execute deployment (event-driven DAG dispatch with partial state saves)
      const { state: newState, actualCounts } = await this.executeDeployment(
        effectiveTemplate,
        currentState,
        changes,
        dag,
        executionLevels,
        stackName,
        parameterValues,
        conditions,
        currentEtag,
        progress,
        migrationPending
      );

      // 7a. Drain in-flight readCurrentState promises so each resource's
      // observedProperties lands in newState before we persist it. By
      // this point the deploy critical path is over, so awaiting the
      // remaining captures only adds the longest still-pending read
      // (typically <300ms in practice for medium stacks; see PR notes).
      await this.drainObservedCaptures(newState.resources);

      // 7b. Save final state (ETag may have been updated by partial saves).
      // The legacy migration delete (when migrationPending) was already done by
      // the first per-resource save inside executeDeployment, so this final
      // save is unconditionally region-scoped.
      const newEtag = await this.stateBackend.saveState(
        stackName,
        this.stackRegion,
        this.withParentInfo(newState)
      );
      this.logger.debug(`State saved (ETag: ${newEtag})`);

      // 7c. Two independent post-save S3 writes, run CONCURRENTLY:
      //
      //   1. Delete the rollback journal. Deploy succeeded, so the stable
      //      baseline has moved and a journal from a prior failed attempt
      //      (fix-forward that now succeeded) must NOT be replayable past
      //      this point (issue #1183). Best-effort.
      //   2. Update the persistent exports index with this stack's outputs
      //      so subsequent `Fn::ImportValue` resolves hit O(1). Best-effort:
      //      failures are swallowed inside updateForStack and surfaced as
      //      warnings (state.json is canonical; a stale index self-heals on
      //      the next deploy/resolve fallback).
      //
      // They target DISJOINT S3 objects — `{prefix}/{stack}/{region}/
      // rollback-journal.json` vs the bucket-level exports index — and
      // neither reads what the other writes: `updateForStack` only ever
      // touches the exports index (plus, on a first-ever call, a rebuild
      // scan of `state.json` files, which the journal delete does not
      // affect), and the journal delete reads nothing at all. So the
      // previous sequential ordering carried no dependency; it was costing
      // a full extra S3 round trip on every successful deploy (measured
      // ~0.5s of the ~1.0s "State saved" -> "Lock released" window).
      //
      // BOTH stay strictly AFTER the state save above and strictly BEFORE
      // the lock release in the `finally` below, which is load-bearing:
      // deleting the journal before the new baseline is durable would lose
      // the ability to revert, and releasing the lock before these settle
      // would let a concurrent deploy of the same stack observe a journal
      // we are about to delete (spurious "a previous deploy failed" note)
      // or race the exports-index read-modify-write.
      await Promise.all([
        this.deleteRollbackJournalBestEffort(stackName),
        this.exportIndexStore
          ? this.exportIndexStore.updateForStack(
              stackName,
              this.stackRegion,
              // The EXPORTS only (issue #2193): the bag also holds every plain
              // Output name, and an index fed the whole bag served those to
              // `Fn::ImportValue` — a same-named plain Output in an unrelated
              // stack could shadow a real export.
              importableOutputs(newState)
            )
          : Promise.resolve(),
      ]);

      const durationMs = Date.now() - startTime;
      const unchangedCount =
        this.diffCalculator.filterByType(changes, 'NO_CHANGE').length + actualCounts.skipped;

      return {
        stackName,
        created: actualCounts.created,
        updated: actualCounts.updated,
        deleted: actualCounts.deleted,
        deleteSkipped: actualCounts.deleteSkipped,
        updatePartial: actualCounts.updatePartial,
        unchanged: unchangedCount,
        durationMs,
        outputs: this.buildDisplayOutputs(template, newState.outputs ?? {}),
        attributeFallbackCount: this.resolver.getPhysicalIdFallbackCount(),
      };
    } finally {
      // Stop live renderer (clears any remaining in-flight task display).
      //
      // Guarded for the same reason `start()` moved inside the `try` above
      // (issue #2171): `stop()` writes to stdout, and it is the FIRST statement
      // of the `finally` that releases the lock — a throw here would abort the
      // teardown before `releaseLock` and re-open the strand one line later.
      try {
        renderer.stop();
      } catch {
        // Deliberately silent: the whole point is that the stdout channel is
        // failing, so logging the failure through it is another throw on the
        // same pre-`releaseLock` path.
      }

      // Remove SIGINT handler.
      //
      // This unregisters BEFORE the lock release further down, which is the
      // ordering `destroy-runner.ts` (issues #2053 / #1952) and `rollback.ts`
      // (issue #2118) were both corrected AWAY from — so the last remaining
      // instance owes an explanation. It is safe HERE for a reason neither of those had:
      // `deploy.ts` registers its own top-level SIGINT handler that outlives
      // this whole method, so the process is never left with zero listeners
      // while the lock is held. `destroy.ts` / `state.ts` register none, which
      // is exactly why the same shape was a stranded lock there.
      //
      // If that top-level handler is ever removed or made conditional, this
      // block has to be reordered to release first.
      process.removeListener('SIGINT', sigintHandler);

      // On a rollback / SIGINT exit we may leave in-flight readCurrentState
      // promises in the map (the success path drains them above). Clear the
      // map so a re-used engine instance does not accumulate stale entries
      // across deploys. The underlying promises already have a `.catch` so
      // dropping the references will not produce an unhandled rejection.
      this.observedCaptureTasks.clear();

      // Always release lock
      try {
        await this.lockManager.releaseLock(stackName, this.stackRegion);
        this.logger.debug('Lock released');
      } catch (lockError) {
        this.logger.warn(
          `Failed to release lock: ${lockError instanceof Error ? lockError.message : String(lockError)}`
        );
      }
    }
  }

  /**
   * Execute deployment by processing resources via event-driven DAG dispatch.
   *
   * - CREATE/UPDATE follow forward dependency order (a node starts as soon as
   *   ALL of its dependencies are completed — does not wait for unrelated
   *   siblings in the same "level")
   * - DELETE follows reverse dependency order (a node starts as soon as all
   *   resources that depend ON it have finished deleting)
   */
  private async executeDeployment(
    template: CloudFormationTemplate,
    currentState: StackState,
    changes: Map<string, ResourceChange>,
    dag: ReturnType<DagBuilder['buildGraph']>,
    executionLevels: string[][],
    stackName: string,
    parameterValues?: Record<string, unknown>,
    conditions?: Record<string, boolean>,
    currentEtag?: string,
    progress?: { current: number; total: number },
    migrationPending = false
  ): Promise<{
    state: StackState;
    actualCounts: ProvisionCounts;
  }> {
    const concurrency = this.options.concurrency!;
    const newResources: Record<string, ResourceState> = { ...currentState.resources };
    const actualCounts: ProvisionCounts = {
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      deleteSkipped: 0,
      updatePartial: 0,
    };
    const completedOperations: CompletedOperation[] = [];
    // #1198: the op(s) that FAILED mid-deploy (usually one; concurrent
    // siblings can add more). Journaled alongside completedOperations so
    // `cdkd rollback --revert-failed` can optionally revert them.
    const failedOperations: FailedOperation[] = [];
    // Tracked here so the FIRST per-resource save sweeps the legacy key; we
    // don't want to delete it on every save.
    let pendingMigration = migrationPending;

    // Serialize per-resource state saves to avoid ETag conflicts from concurrent writes
    let saveChain: Promise<void> = Promise.resolve();
    const saveStateAfterResource = (logicalId: string): void => {
      if (currentEtag === undefined) return;
      saveChain = saveChain.then(async () => {
        try {
          const partialState: StackState = {
            version: STATE_SCHEMA_VERSION_CURRENT,
            region: this.stackRegion,
            stackName: currentState.stackName,
            resources: newResources,
            outputs: currentState.outputs,
            ...exportNamesCarriedFrom(currentState),
            // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
            // session resolved. See `crossStackReadsForPartialSave` — writing the
            // snapshot alone left a failed deploy's persisted record denying a
            // cross-stack read its own resources were built from.
            ...crossStackReadsForPartialSave(
              currentState,
              this.recordedImports,
              this.recordedOutputReads
            ),
            lastModified: Date.now(),
          };
          // Migration is a one-shot tail on the first save; subsequent saves
          // overwrite the new key in-place under optimistic locking.
          const migrate = pendingMigration;
          const expectedEtag = migrate ? undefined : currentEtag;
          currentEtag = await this.stateBackend.saveState(
            stackName,
            this.stackRegion,
            this.withParentInfo(partialState),
            { ...(expectedEtag !== undefined && { expectedEtag }), migrateLegacy: migrate }
          );
          if (migrate) pendingMigration = false;
          this.logger.debug(`State saved after ${logicalId}`);
        } catch (error) {
          this.logger.warn(
            `Failed to save state after ${logicalId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      });
    };

    // Separate DELETE operations from CREATE/UPDATE
    const deleteChanges = new Set(
      Array.from(changes.entries())
        .filter(([_, change]) => change.changeType === 'DELETE')
        .map(([logicalId]) => logicalId)
    );

    try {
      // Step 1: Process CREATE/UPDATE via event-driven DAG dispatch.
      // A node starts as soon as ALL of its dependencies are completed, rather
      // than waiting for an entire "level" of unrelated siblings to finish.
      const createUpdateIds: string[] = [];
      for (const [id, change] of changes.entries()) {
        if (deleteChanges.has(id)) continue;
        if (change.changeType === 'NO_CHANGE') continue;
        createUpdateIds.push(id);
      }

      if (createUpdateIds.length > 0) {
        this.logger.info(
          `${cyan('Deploying')} ${cyan(createUpdateIds.length)} resource(s) (DAG: ${executionLevels.length} levels, max parallel: ${concurrency})`
        );

        const createUpdateExecutor = new DagExecutor<ResourceChange>();
        const provisionable = new Set(createUpdateIds);
        for (const id of createUpdateIds) {
          const allDeps = this.dagBuilder.getDirectDependencies(dag, id);
          // Only carry deps that are themselves being provisioned in this phase;
          // NO_CHANGE / DELETE / non-DAG deps are already satisfied.
          const deps = new Set(allDeps.filter((d) => provisionable.has(d)));
          createUpdateExecutor.add({
            id,
            dependencies: deps,
            state: 'pending',
            data: changes.get(id)!,
          });
        }

        try {
          await createUpdateExecutor.execute(
            concurrency,
            async (node) => {
              const logicalId = node.id;
              const change = node.data;

              const previousState = currentState.resources[logicalId]
                ? { ...currentState.resources[logicalId] }
                : undefined;

              try {
                await this.provisionResource(
                  logicalId,
                  change,
                  newResources,
                  stackName,
                  template,
                  parameterValues,
                  conditions,
                  actualCounts,
                  progress
                );
              } catch (provisionError) {
                // Signal interruption so that long-running operations (e.g., CloudFront
                // waitForDeployed) in sibling tasks abort promptly instead of blocking
                // until their own polling timeouts fire.
                this.interrupted = true;
                this.interruptCause ??= 'sibling-failure';
                // #1198: journal the failed op's pre-op state + attempted
                // properties so `cdkd rollback --revert-failed` can act on it.
                failedOperations.push({
                  logicalId,
                  changeType: change.changeType as 'CREATE' | 'UPDATE',
                  resourceType: change.resourceType,
                  provisionedBy:
                    newResources[logicalId]?.provisionedBy ?? previousState?.provisionedBy,
                  ...(previousState && { previousState }),
                  physicalId: newResources[logicalId]?.physicalId ?? previousState?.physicalId,
                  attemptedProperties: this.attemptedResolvedProps.get(logicalId),
                });
                throw provisionError;
              }

              completedOperations.push({
                logicalId,
                changeType: change.changeType as 'CREATE' | 'UPDATE',
                resourceType: change.resourceType,
                // Snapshot the routing layer just landed on the resource
                // (CREATE = the auto-route decision; UPDATE = the state's
                // sticky / re-evaluated layer). Threads into rollback so a
                // CC-routed CREATE rolls back via the CC delete path —
                // closing the silent-data-corruption hazard the v7 schema
                // bump was designed to prevent.
                provisionedBy:
                  newResources[logicalId]?.provisionedBy ?? previousState?.provisionedBy,
                previousState,
                physicalId: newResources[logicalId]?.physicalId,
                properties: newResources[logicalId]?.properties,
              });

              saveStateAfterResource(logicalId);
            },
            () => this.interrupted
          );
        } finally {
          // Wait for any pending per-resource state saves before the next phase or
          // before propagating an error — prevents partial-save races.
          await saveChain;
        }

        // If SIGINT fired AND there is still un-provisioned work (some nodes
        // remained pending because dispatch was cancelled), surface it as an
        // explicit interruption so the catch path saves partial state.
        // If every node already completed before SIGINT landed, treat the deploy
        // as fully successful — matches the prior level-loop's "loop exits, no
        // check" behaviour at the very end of execution.
        if (this.interrupted && this.hasPending(createUpdateExecutor)) {
          throw new InterruptedError(this.interruptCause ?? 'user');
        }
      }

      // Step 2: Process DELETE operations in reverse dependency order.
      if (deleteChanges.size > 0) {
        this.logger.info(`${red('Deleting')} ${red(deleteChanges.size)} resource(s)`);

        const deleteDeps = this.buildDeletionDependencies(deleteChanges, currentState);
        const deleteExecutor = new DagExecutor<ResourceChange>();
        for (const id of deleteChanges) {
          deleteExecutor.add({
            id,
            dependencies: deleteDeps.get(id) ?? new Set(),
            state: 'pending',
            data: changes.get(id)!,
          });
        }

        try {
          await deleteExecutor.execute(
            concurrency,
            async (node) => {
              const logicalId = node.id;
              const change = node.data;

              const previousState = currentState.resources[logicalId]
                ? { ...currentState.resources[logicalId] }
                : undefined;

              let deleteOutcome: ResourceOutcomeSignal | void;
              try {
                deleteOutcome = await this.provisionResource(
                  logicalId,
                  change,
                  newResources,
                  stackName,
                  template,
                  parameterValues,
                  conditions,
                  actualCounts,
                  progress
                );
              } catch (provisionError) {
                this.interrupted = true;
                this.interruptCause ??= 'sibling-failure';
                // #1198: a failed DELETE leaves the resource in place — the
                // record documents it in the journal (no revert needed).
                failedOperations.push({
                  logicalId,
                  changeType: 'DELETE',
                  resourceType: change.resourceType,
                  provisionedBy: previousState?.provisionedBy,
                  ...(previousState && { previousState }),
                  physicalId: previousState?.physicalId,
                });
                throw provisionError;
              }

              // Issue #1762: a skipped DELETE is NOT a completed operation.
              // Journaling it would make `cdkd rollback` re-CREATE a resource
              // that was never deleted — colliding on its name at best, and
              // producing a second live copy at worst. The state record was
              // kept, so there is nothing to revert and nothing to persist
              // beyond what is already there.
              if (deleteOutcome) return;

              completedOperations.push({
                logicalId,
                changeType: 'DELETE',
                resourceType: change.resourceType,
                provisionedBy: previousState?.provisionedBy,
                previousState,
              });

              saveStateAfterResource(logicalId);
            },
            () => this.interrupted
          );
        } finally {
          await saveChain;
        }

        if (this.interrupted && this.hasPending(deleteExecutor)) {
          throw new InterruptedError(this.interruptCause ?? 'user');
        }
      }
    } catch (error) {
      // `initialDeploy` (issue #1183): the failed deploy was the FIRST deploy
      // (no prior state loaded). Captured BEFORE the partial-state save below,
      // which reassigns `currentEtag`. Recorded on the journal segment so
      // `cdkd rollback` deletes state.json entirely once everything is unwound.
      const initialDeploy = currentEtag === undefined;

      // Save partial state BEFORE rollback to track all successfully provisioned
      // resources (including those that completed concurrently with the one that
      // failed). This prevents orphaned resources — resources that exist in AWS
      // but not in the state file.
      try {
        const preRollbackState: StackState = {
          version: STATE_SCHEMA_VERSION_CURRENT,
          region: this.stackRegion,
          stackName: currentState.stackName,
          resources: newResources,
          outputs: currentState.outputs,
          ...exportNamesCarriedFrom(currentState),
          // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
          // session resolved. See `crossStackReadsForPartialSave` — writing the
          // snapshot alone left a failed deploy's persisted record denying a
          // cross-stack read its own resources were built from.
          ...crossStackReadsForPartialSave(
            currentState,
            this.recordedImports,
            this.recordedOutputReads
          ),
          lastModified: Date.now(),
        };
        const migrate = pendingMigration;
        const expectedEtag = migrate ? undefined : currentEtag;
        currentEtag = await this.stateBackend.saveState(
          stackName,
          this.stackRegion,
          this.withParentInfo(preRollbackState),
          { ...(expectedEtag !== undefined && { expectedEtag }), migrateLegacy: migrate }
        );
        if (migrate) pendingMigration = false;
        this.logger.debug('Partial state saved before rollback (orphaned resource tracking)');
      } catch (saveError) {
        this.logger.warn(
          `Failed to save partial state before rollback: ${saveError instanceof Error ? saveError.message : String(saveError)}`
        );
      }

      // Set true when an automatic rollback replayed with zero per-op
      // failures — gates the post-save journal deletion below.
      let autoRollbackClean = false;

      // On SIGINT, skip rollback — just save partial state, record a rollback
      // journal segment so the interrupted deploy is REVERTIBLE (not just
      // resumable), and let the caller exit.
      //
      // `InterruptedError` is this module's own and is NOT exported, so it can
      // only ever be raised HERE — by the engine's own interrupt poll between
      // operations. An interrupt raised inside a provider's wait (issues #2053
      // / #1952 thread one into every `withRetry` under
      // `src/provisioning/**`) arrives as an `InterruptedWaitError`, and by the
      // time it reaches this catch it is WRAPPED: every provider catch
      // re-throws AWS failures as a `ProvisioningError` threading the original
      // as `cause` (issue #2040). Matching only the private class meant a
      // Ctrl-C during a provider backoff read as a genuine resource failure and
      // rolled the whole stack back automatically — strictly worse than the
      // unresponsiveness the threading removes. `isInterruptedWaitError` walks
      // the cause chain to a bounded depth for exactly that reason.
      if (error instanceof InterruptedError || isInterruptedWaitError(error)) {
        await this.writeRollbackJournalSegment(
          stackName,
          completedOperations,
          failedOperations,
          'interrupted',
          initialDeploy
        );
        this.logger.info(
          `Partial state saved (${Object.keys(newResources).length} resources). ` +
            "Run deploy again to resume, 'cdkd rollback' to revert, or destroy to clean up."
        );
        throw error;
      }

      // Deployment failed — attempt rollback unless --no-rollback is set
      if (this.options.noRollback) {
        // Record a journal segment so `cdkd rollback` can revert the failed
        // deploy later instead of only fixing forward / destroying.
        await this.writeRollbackJournalSegment(
          stackName,
          completedOperations,
          failedOperations,
          'no-rollback-failure',
          initialDeploy
        );
        this.logger.warn('Deployment failed. --no-rollback is set, skipping rollback.');
        this.logger.warn(
          "Partial state has been saved. Run 'cdkd deploy' to resume, 'cdkd rollback' to revert, " +
            'or destroy to clean up.'
        );
      } else {
        // Automatic in-process rollback. Write a journal segment FIRST so a
        // rollback that dies partway (crash / network / per-op failure)
        // leaves the segment behind and becomes resumable via `cdkd
        // rollback`; the segment is deleted after a clean replay + save.
        await this.writeRollbackJournalSegment(
          stackName,
          completedOperations,
          failedOperations,
          'auto-rollback-started',
          initialDeploy
        );
        const rollbackResult = await this.performRollback(
          completedOperations,
          newResources,
          stackName,
          currentState
        );
        autoRollbackClean = rollbackResult.failures === 0;
      }

      // Save state after rollback (reflects rolled-back resource state).
      // This is critical: if rollback deleted resources, the state must reflect
      // that. Otherwise, next deploy will think deleted resources still exist.
      try {
        const postRollbackState: StackState = {
          version: STATE_SCHEMA_VERSION_CURRENT,
          region: this.stackRegion,
          stackName: currentState.stackName,
          resources: newResources,
          outputs: currentState.outputs,
          ...exportNamesCarriedFrom(currentState),
          // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
          // session resolved. See `crossStackReadsForPartialSave` — writing the
          // snapshot alone left a failed deploy's persisted record denying a
          // cross-stack read its own resources were built from.
          ...crossStackReadsForPartialSave(
            currentState,
            this.recordedImports,
            this.recordedOutputReads
          ),
          lastModified: Date.now(),
        };
        await this.stateBackend.saveState(
          stackName,
          this.stackRegion,
          this.withParentInfo(postRollbackState),
          {
            ...(currentEtag !== undefined && { expectedEtag: currentEtag }),
          }
        );
        this.logger.debug('State saved after deployment failure');
        // Auto-rollback replayed cleanly AND the post-rollback state save
        // succeeded — the pre-deploy baseline is restored, so settle the
        // journal (issue #1183): drop it entirely, or — when the segment
        // carries failed in-flight op(s) — keep a failed-only segment so
        // `cdkd rollback --revert-failed` still works (issue #1208). A
        // partial / failed rollback keeps the full segment so `cdkd
        // rollback` can resume.
        if (autoRollbackClean) {
          await this.settleJournalAfterCleanRollback(stackName, failedOperations, initialDeploy);
        }
      } catch (saveError) {
        // ETag mismatch from per-resource saves — force overwrite with fresh ETag
        this.logger.debug(
          `Retrying state save after rollback (ETag mismatch): ${saveError instanceof Error ? saveError.message : String(saveError)}`
        );
        try {
          const freshState = await this.stateBackend.getState(stackName, this.stackRegion);
          const freshEtag = freshState?.etag;
          const postRollbackState: StackState = {
            version: STATE_SCHEMA_VERSION_CURRENT,
            region: this.stackRegion,
            stackName: currentState.stackName,
            resources: newResources,
            outputs: currentState.outputs,
            ...exportNamesCarriedFrom(currentState),
            // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
            // session resolved. See `crossStackReadsForPartialSave` — writing the
            // snapshot alone left a failed deploy's persisted record denying a
            // cross-stack read its own resources were built from.
            ...crossStackReadsForPartialSave(
              currentState,
              this.recordedImports,
              this.recordedOutputReads
            ),
            lastModified: Date.now(),
          };
          await this.stateBackend.saveState(
            stackName,
            this.stackRegion,
            this.withParentInfo(postRollbackState),
            {
              ...(freshEtag !== undefined && { expectedEtag: freshEtag }),
            }
          );
          this.logger.debug('State saved after deployment failure (retry succeeded)');
          if (autoRollbackClean) {
            await this.settleJournalAfterCleanRollback(stackName, failedOperations, initialDeploy);
          }
        } catch (retryError) {
          this.logger.warn(
            `Failed to save state after rollback: ${retryError instanceof Error ? retryError.message : String(retryError)}`
          );
        }
      }

      throw error;
    }

    // Resolve outputs. Under --strict-getatt an unresolvable Output makes
    // resolveOutputs THROW (instead of warn-and-skip). By this point EVERY
    // resource operation already succeeded in AWS, and the throw would
    // propagate through doDeploy's catch-less try — skipping the final
    // saveState. On a FIRST deploy `currentEtag` is undefined so the
    // incremental per-resource saves were no-ops too: rethrowing without a
    // save would leave every created resource invisible to cdkd (no state,
    // no rollback; a re-run collides with "already exists"). Persist the
    // provisioning result FIRST, then rethrow so the deploy still fails
    // (review blocker on issue #1111 item 2).
    let outputs: Record<string, unknown>;
    try {
      outputs = await this.resolveOutputs(
        template,
        newResources,
        stackName,
        parameterValues,
        conditions
      );
      // Redact resolved secrets out of outputs before they flow to the exports
      // index / deploy summary / state (GHSA fix). The state save also redacts
      // via `withParentInfo`, but the exports-index `updateForStack` and
      // `buildDisplayOutputs` read this bag directly. `resolveOutputs` populated
      // `this.outputSecrets` with the outputs' own substituted references, and
      // `this.outputsTemplateSource` with the unresolved values that position
      // them (#1910).
      const resolvedOutputsBeforeRedaction = outputs;
      outputs = this.redactOutputs(outputs);
      // Issue #2274: remember, FOR THIS PROCESS ONLY, the plaintext behind any
      // output the redaction just replaced with the mask. Every cross-stack
      // route — a nested stack's `Outputs.<Key>`, `Fn::ImportValue`,
      // `Fn::GetStackOutput` — reads the producer's PERSISTED outputs, so
      // without this the first deploy of a consumer whose producer exports a
      // `NoEcho` custom-resource value would land on `***` and be refused: a
      // template that deployed before this feature. See
      // `recoverableMaskedOutputs` for why the key is a COORDINATE and not a
      // bare plaintext.
      this.rememberRecoverableMaskedOutputs(stackName, resolvedOutputsBeforeRedaction, outputs);
    } catch (outputError) {
      await this.persistStateAfterOutputFailure(
        stackName,
        currentState,
        newResources,
        currentEtag,
        pendingMigration
      );
      // Every resource op succeeded here — provisioning was clean, only
      // output resolution failed — so rolling back is a legitimate use case
      // (issue #1183). Record a journal segment so `cdkd rollback` can revert.
      await this.writeRollbackJournalSegment(
        stackName,
        completedOperations,
        failedOperations,
        'no-rollback-failure',
        currentEtag === undefined
      );
      throw outputError;
    }

    return {
      state: {
        version: STATE_SCHEMA_VERSION_CURRENT,
        region: this.stackRegion,
        stackName: currentState.stackName,
        resources: newResources,
        outputs,
        // Always written, `[]` included: on this path the bag was re-resolved,
        // so the set is KNOWN (issue #2193). Absent would read as "not known".
        exportNames: [...this.resolvedExportNames],
        ...(this.recordedImports.length > 0 && { imports: [...this.recordedImports] }),
        ...(this.recordedOutputReads.length > 0 && {
          outputReads: [...this.recordedOutputReads],
        }),
        lastModified: Date.now(),
      },
      actualCounts,
    };
  }

  /**
   * Persist state after provisioning fully succeeded but output resolution
   * threw (only reachable under `--strict-getatt`, whose promotion fires
   * AFTER the rollback catch block). The persisted shape mirrors the
   * success-path state EXCEPT for outputs:
   *
   * - `resources`: this run's provisioning result (`newResources`) — every
   *   create/update/delete landed in AWS, so state must record it.
   * - `imports` / `outputReads`: this run's `recordedImports` /
   *   `recordedOutputReads` (the provisioning that produced them succeeded;
   *   dropping them would desync the strong-reference records from AWS —
   *   matters on the update-deploy path where the pre-deploy snapshot may
   *   be stale).
   * - `outputs`: the PREVIOUSLY persisted map — resolveOutputs threw before
   *   producing a new one, mirroring what a resource-failure persist keeps.
   *   The exports index is deliberately NOT updated (it stays consistent
   *   with the old outputs that remain in state).
   *
   * ETag handling mirrors the post-rollback save: expected-ETag first (or
   * unconditional when `pendingMigration` — same as the per-resource save),
   * then a fresh-ETag retry, then warn. Best-effort: the deploy error being
   * rethrown is the primary signal; a failed save only warns.
   */
  private async persistStateAfterOutputFailure(
    stackName: string,
    currentState: StackState,
    newResources: Record<string, ResourceState>,
    currentEtag: string | undefined,
    pendingMigration: boolean
  ): Promise<void> {
    const buildState = (): StackState => ({
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: this.stackRegion,
      stackName: currentState.stackName,
      resources: newResources,
      outputs: currentState.outputs,
      ...exportNamesCarriedFrom(currentState),
      // Issue #2057: the UNION, like every other non-success save. This one
      // used to write `[...this.recordedImports]` WHOLESALE, copying the
      // SUCCESS path's shape onto a path that is not one — provisioning
      // succeeded, but output resolution threw, and the caller writes a
      // rollback journal segment and rethrows, so `cdkd rollback` reads
      // exactly this record. A deploy that no longer re-resolves a
      // cross-stack read (the reference moved, or the resource holding it had
      // no diff this run) therefore came through here with an EMPTY
      // `recordedOutputReads`, the field was omitted, and the producer region
      // the previous record carried was erased from under a
      // `properties.Value` that still holds the producer's region-less
      // spelling. `producerRegionsFromState` then returned `[]` and the replay
      // resolved it locally.
      ...crossStackReadsForPartialSave(
        currentState,
        this.recordedImports,
        this.recordedOutputReads
      ),
      lastModified: Date.now(),
    });
    try {
      const expectedEtag = pendingMigration ? undefined : currentEtag;
      await this.stateBackend.saveState(
        stackName,
        this.stackRegion,
        this.withParentInfo(buildState()),
        {
          ...(expectedEtag !== undefined && { expectedEtag }),
          migrateLegacy: pendingMigration,
        }
      );
      this.logger.debug('State saved after output resolution failure');
    } catch (saveError) {
      this.logger.debug(
        `Retrying state save after output resolution failure (ETag mismatch): ${saveError instanceof Error ? saveError.message : String(saveError)}`
      );
      try {
        const freshState = await this.stateBackend.getState(stackName, this.stackRegion);
        const freshEtag = freshState?.etag;
        await this.stateBackend.saveState(
          stackName,
          this.stackRegion,
          this.withParentInfo(buildState()),
          {
            ...(freshEtag !== undefined && { expectedEtag: freshEtag }),
          }
        );
        this.logger.debug('State saved after output resolution failure (retry succeeded)');
      } catch (retryError) {
        this.logger.warn(
          `Failed to save state after output resolution failure: ${retryError instanceof Error ? retryError.message : String(retryError)} — resources were provisioned but not recorded; run deploy again to reconcile.`
        );
      }
    }
  }

  /**
   * Perform best-effort rollback of completed operations (issue #1183:
   * extracted into `rollback-executor.ts` so the standalone `cdkd rollback`
   * command drives identical semantics). Thin wrapper that builds the
   * executor context from the engine's collaborators and delegates.
   */
  private async performRollback(
    completedOperations: CompletedOperation[],
    stateResources: Record<string, ResourceState>,
    stackName: string,
    /**
     * The PRE-deploy state record, threaded in for issue #2057's
     * `importedProducerRegions`. Taken as a parameter rather than read off a
     * field because `currentState` is a local of `executeDeployment`, whose
     * automatic-rollback arm is this method's only caller.
     */
    previousState: StackState
  ): Promise<{ failures: number; warnings: number }> {
    const result = await replayRollback(
      completedOperations,
      stateResources,
      stackName,
      this.rollbackExecutorContext(previousState)
    );
    return { failures: result.failures, warnings: result.warnings };
  }

  /**
   * Best-effort rollback-journal deletion (issue #1183) used on the deploy
   * success path and after a clean automatic rollback. Never throws — a
   * failed delete only warns (the journal is advisory; the worst case is a
   * spurious "previous deploy failed" note on the next deploy).
   */
  private async deleteRollbackJournalBestEffort(stackName: string): Promise<void> {
    try {
      await this.stateBackend.deleteRollbackJournal(stackName, this.stackRegion);
    } catch (err) {
      this.logger.debug(
        `Failed to delete rollback journal for ${stackName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Settle the rollback journal after a CLEAN automatic rollback (issue
   * #1208). The completed ops are reverted, but the op that FAILED mid-deploy
   * may have left its resource half-applied — and its journaled record is the
   * ONLY input `cdkd rollback --revert-failed` has. So instead of deleting the
   * journal outright (which made --revert-failed unusable in the DEFAULT
   * deploy flow), pop this attempt's segment and re-record a failed-only one
   * (`operations: []` + the failed ops). Older segments from prior
   * un-reverted attempts are preserved by the pop. The next successful deploy
   * still deletes the whole journal, bounding the lingering window. With no
   * failed ops there is nothing left to revert from THIS attempt — but only
   * this attempt's segment is popped, NOT the whole journal (issue #1215):
   * the clean rollback reverted only this attempt's ops, so older segments'
   * completed ops are still live in AWS/state and must keep their revert
   * records; pop deletes the object itself when the last segment goes, so
   * the common single-segment case still ends with no journal.
   *
   * Best-effort like every journal write: a pop failure warns and leaves the
   * full segment in place (the pre-#1208 partial-rollback shape — replay is
   * idempotent, so a later `cdkd rollback` is still safe).
   */
  private async settleJournalAfterCleanRollback(
    stackName: string,
    failedOperations: FailedOperation[],
    initialDeploy: boolean
  ): Promise<void> {
    if (failedOperations.length === 0) {
      try {
        await this.stateBackend.popRollbackJournalSegment(stackName, this.stackRegion);
      } catch (err) {
        this.logger.debug(
          `Failed to pop the rollback journal segment after the clean rollback: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return;
    }
    try {
      await this.stateBackend.popRollbackJournalSegment(stackName, this.stackRegion);
    } catch (err) {
      this.logger.warn(
        `Failed to settle the rollback journal after the clean rollback: ${err instanceof Error ? err.message : String(err)}. ` +
          `The journal keeps the full segment; a later 'cdkd rollback' replay is idempotent.`
      );
      return;
    }
    await this.writeRollbackJournalSegment(
      stackName,
      [],
      failedOperations,
      'auto-rollback-clean',
      initialDeploy
    );
    this.logger.info(
      `The automatic rollback restored the pre-deploy state. The failed resource's pre-failure ` +
        `record was kept — if it was left partially applied, run ` +
        `'cdkd rollback ${stackName} --revert-failed' to revert it.`
    );
  }

  /** Build the {@link RollbackExecutorContext} from the engine's fields. */
  private rollbackExecutorContext(previousState: StackState): RollbackExecutorContext {
    return {
      providerRegistry: this.providerRegistry,
      region: this.stackRegion,
      logger: this.logger,
      recordEvent: (event) => this.recordEvent(event),
      // `DeletionPolicy: Snapshot` on a rolled-back CREATE (issue #1358) —
      // the executor needs the same region-pinned clients + data-loss
      // opt-out the engine's own delete sites use.
      finalSnapshotClients: this.options.finalSnapshotClients,
      skipFinalSnapshot: this.options.skipFinalSnapshot,
      // Issue #2057: the producer regions this stack reads across, so the
      // replay refuses a region-LESS `{{resolve:...}}` expression rather than
      // re-resolving it here and writing a same-named foreign secret to a live
      // resource. The UNION is what makes this reachable at all — a rollback
      // runs only after a FAILED deploy, and the read this deploy INTRODUCED is
      // in `recordedImports` / `recordedOutputReads`, never yet in the
      // persisted snapshot. Strictly more evidence than `cdkd rollback` can
      // derive on its own, which sees only what a save persisted.
      importedProducerRegions: producerRegionsFromState(
        crossStackReadsForPartialSave(previousState, this.recordedImports, this.recordedOutputReads)
      ),
    };
  }

  /**
   * Record one rollback-journal segment (issue #1183) so the failed /
   * interrupted / about-to-auto-rollback deploy can be reverted later by
   * `cdkd rollback`. Best-effort like the partial-state save, but warns
   * LOUDLY on failure — the user just lost the ability to `cdkd rollback`.
   */
  private async writeRollbackJournalSegment(
    stackName: string,
    completedOperations: CompletedOperation[],
    failedOperations: FailedOperation[],
    reason: RollbackJournalSegment['reason'],
    initialDeploy: boolean
  ): Promise<void> {
    // A segment with no operations carries nothing to revert — skip it so a
    // failure before any resource completed does not create an empty journal.
    // A failed op alone (#1198) IS worth journaling: `cdkd rollback
    // --revert-failed` can act on it even with zero completed ops.
    if (completedOperations.length === 0 && failedOperations.length === 0) return;
    // Redact resolved secret plaintext out of the journal (GHSA fix): the ops
    // carry resolved / attempted properties and previous-state snapshots read
    // from the in-memory working map, which is NOT run through the state save
    // choke point, so plaintext would otherwise land in rollback-journal.json.
    const redactedCompleted = this.redactOperationsForJournal(completedOperations);
    const redactedFailed = this.redactOperationsForJournal(failedOperations);
    try {
      const segment: RollbackJournalSegment = {
        ...(this.options.eventRecorder?.runId !== undefined && {
          runId: this.options.eventRecorder.runId,
        }),
        timestamp: Date.now(),
        reason,
        initialDeploy,
        ...(this.options.roleArn && { roleArn: this.options.roleArn }),
        cdkdVersion: getCdkdVersion(),
        operations: redactedCompleted,
        ...(redactedFailed.length > 0 && { failedOperations: redactedFailed }),
      };
      await this.stateBackend.appendRollbackJournalSegment(stackName, this.stackRegion, segment);
      this.logger.debug(`Rollback journal segment written (${reason})`);
    } catch (journalError) {
      this.logger.warn(
        `Failed to write rollback journal: ${journalError instanceof Error ? journalError.message : String(journalError)}. ` +
          `'cdkd rollback' will NOT be able to revert this deploy — use 'cdkd deploy' to resume or 'cdkd destroy' to clean up.`
      );
    }
  }

  /**
   * Provision a single resource (CREATE/UPDATE/DELETE)
   */
  private async provisionResource(
    logicalId: string,
    change: ResourceChange,
    stateResources: Record<string, ResourceState>,
    stackName: string,
    template?: CloudFormationTemplate,
    parameterValues?: Record<string, unknown>,
    conditions?: Record<string, boolean>,
    counts?: ProvisionCounts,
    progress?: { current: number; total: number }
  ): Promise<ResourceOutcomeSignal | void> {
    const resourceType = change.resourceType;

    const renderer = getLiveRenderer();
    const needsReplacement =
      change.changeType === 'UPDATE' &&
      (change.propertyChanges?.some((pc) => pc.requiresReplacement) ?? false);
    const verb =
      change.changeType === 'CREATE'
        ? 'Creating'
        : change.changeType === 'DELETE'
          ? 'Deleting'
          : needsReplacement
            ? 'Replacing'
            : 'Updating';
    // #614 §9 live-progress annotation: distinguish CC-routed work from
    // SDK-routed work so the user sees WHY a particular resource is taking
    // longer than its sibling (CC API is async-polling). CREATE / UPDATE
    // consult `getProviderFor` with the template-side properties +
    // recorded `provisionedBy` (the latter so sticky-CC resources keep
    // the tag even when the update payload has no silent-drop property
    // of its own — design §8). DELETE short-circuits on recorded
    // `provisionedBy` since delete routing is fully driven by state, not
    // by the template. Routing is based on top-level property NAMES
    // which intrinsic resolution does not change, so the pre-routing
    // here matches the real decision in `provisionResourceBody`. Errors
    // here never surface — if routing inference fails, we drop the tag
    // and the real `getProviderFor` call later will re-evaluate.
    const labelRouting = this.peekRoutingForLabel(change, stateResources[logicalId]);
    const routingTag = labelRouting === 'cc-api' ? ' [CC API]' : '';
    const baseLabel = `${verb} ${logicalId} (${resourceType})${routingTag}`;
    renderer.addTask(logicalId, baseLabel);

    // Operation classification for the timeout error message. UPDATE and
    // its replacement-replacement form are both surfaced as 'UPDATE' since
    // the user-facing distinction (which immutable property triggered it)
    // is already in the renderer label.
    const operationKind: 'CREATE' | 'UPDATE' | 'DELETE' =
      change.changeType === 'CREATE'
        ? 'CREATE'
        : change.changeType === 'DELETE'
          ? 'DELETE'
          : 'UPDATE';

    // Per-resource-type overrides (v2) win over the global default.
    // Resolution order at the call site:
    //   1. per-type CLI override map for this resourceType — explicit
    //      escape hatch, always wins (`--resource-timeout TYPE=DURATION`).
    //   2. provider self-report (`getMinResourceTimeoutMs()`) raised
    //      against the global default — long-running providers
    //      (Custom Resource polls up to 1h) lift the deadline for their
    //      resources without forcing every user to remember
    //      `--resource-timeout 1h`.
    //   3. CLI global default (`--resource-timeout 30m`).
    //   4. compile-time default (DEFAULT_RESOURCE_*_MS).
    //
    // `getProvider` here only consults the resource type (no template
    // properties / no state-recorded layer) — it's used solely to read
    // `getMinResourceTimeoutMs`. The real routing decision (which can
    // promote a Tier 1 resource to Cloud Control under #614) happens
    // inside `provisionResourceBody` via `getProviderFor`.
    const provider = this.providerRegistry.getProvider(resourceType);
    const providerMinTimeoutMs = provider.getMinResourceTimeoutMs?.() ?? 0;
    const warnAfterMs =
      this.options.resourceWarnAfterByType?.[resourceType] ??
      this.options.resourceWarnAfterMs ??
      DEFAULT_RESOURCE_WARN_AFTER_MS;
    const globalTimeoutMs = this.options.resourceTimeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS;
    // Known-slow types (OpenSearch domains, RDS / Redshift / ElastiCache
    // clusters) lift the outer deadline to match the CC inner poll cap so a
    // slow CREATE / UPDATE is not aborted by the 30-min default. A per-type CLI
    // override still wins (explicit escape hatch).
    const slowTypeMinTimeoutMs = slowCcOperationTimeoutMs(resourceType, operationKind);
    const timeoutMs =
      this.options.resourceTimeoutByType?.[resourceType] ??
      Math.max(providerMinTimeoutMs, slowTypeMinTimeoutMs, globalTimeoutMs);

    // #808 best-effort event: per-resource op started. `provisionedBy`
    // is the routing inference used for the live label (same decision the
    // real provider call makes); good enough for the event metadata.
    const eventOp: DeploymentResourceOperation = operationKind;
    const resourceStartedAt = Date.now();
    this.recordEvent({
      eventType: 'RESOURCE_STARTED',
      stackName,
      operation: eventOp,
      logicalId,
      resourceType,
      ...(labelRouting && { provisionedBy: labelRouting }),
    });

    // Issue #1762: set when the body's DELETE branch consumed a
    // `{ outcome: 'skipped' }` from the provider. Assigned inside the
    // deadline callback (same shape destroy-runner.ts uses for its own
    // `deleteResult`) because the body's return value is otherwise swallowed
    // by `withResourceDeadline`.
    let deleteSkipped: string | undefined;
    // Issue #1819: an UPDATE that left a resource behind. Unlike
    // `deleteSkipped` this does NOT suppress `RESOURCE_SUCCEEDED` — the row's
    // resource really was updated — it adds a second event naming the survivor.
    let updatePartial: string | undefined;
    // Snapshot BEFORE the body runs: a replacement re-points the state record
    // to the NEW physical id, so by the time the event is built the survivor's
    // id is gone from state and only the free-text reason would still carry it.
    const physicalIdBeforeUpdate = stateResources[logicalId]?.physicalId;
    const provisionedByBeforeUpdate = stateResources[logicalId]?.provisionedBy;
    try {
      await withResourceDeadline(
        async () => {
          const bodyResult = await this.provisionResourceBody(
            logicalId,
            change,
            stateResources,
            stackName,
            template,
            parameterValues,
            conditions,
            counts,
            progress
          );
          deleteSkipped = bodyResult?.deleteSkipped;
          updatePartial = bodyResult?.updatePartial;
        },
        {
          warnAfterMs,
          timeoutMs,
          onWarn: (elapsedMs) => {
            const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
            const warnSuffix = ` [taking longer than expected, ${minutes}m+]`;
            // Mutate the live renderer's task label in place (TTY mode)
            // and emit a warn line above the live area (non-TTY / verbose).
            renderer.updateTaskLabel(logicalId, `${baseLabel}${warnSuffix}`);
            renderer.printAbove(() => {
              this.logger.warn(
                `${logicalId} (${resourceType}) has been ${operationKind === 'CREATE' ? 'creating' : operationKind === 'DELETE' ? 'deleting' : 'updating'} for ${minutes}m — still waiting`
              );
            });
          },
          onTimeout: (elapsedMs) =>
            new ResourceTimeoutError(
              logicalId,
              resourceType,
              this.stackRegion,
              elapsedMs,
              operationKind,
              timeoutMs
            ),
        }
      );
      // Issue #1762: a DELETE the provider refused to issue is NOT a
      // success — the events store is the durable post-mortem, and
      // `RESOURCE_SUCCEEDED` there would claim cdkd deleted a resource that
      // is still alive. Mirrors destroy-runner.ts's RESOURCE_SKIPPED emit,
      // `reason` included: a bare event cannot tell the user why.
      if (deleteSkipped !== undefined) {
        this.recordEvent({
          eventType: 'RESOURCE_SKIPPED',
          stackName,
          operation: eventOp,
          logicalId,
          resourceType,
          ...(stateResources[logicalId]?.provisionedBy
            ? { provisionedBy: stateResources[logicalId]?.provisionedBy }
            : labelRouting && { provisionedBy: labelRouting }),
          ...(stateResources[logicalId]?.physicalId && {
            physicalId: stateResources[logicalId]?.physicalId,
          }),
          reason: deleteSkipped,
          durationMs: Date.now() - resourceStartedAt,
        });
        return { deleteSkipped };
      }
      // Issue #1819 / #1922: the row's resource WAS updated, so it still gets
      // `RESOURCE_SUCCEEDED` below. What did NOT happen is the retirement of
      // the resource the update owned, so that gets its own `RESOURCE_SKIPPED`
      // — whose documented invariant ("the resource this row names was not
      // destroyed") is exactly true of the survivor, and false of the updated
      // row. Emitting only the skip, as the issue first proposed, would have
      // put the events store at odds with its own contract.
      if (updatePartial !== undefined) {
        this.recordEvent({
          eventType: 'RESOURCE_SKIPPED',
          stackName,
          operation: eventOp,
          logicalId,
          resourceType,
          // The SURVIVOR's routing layer, snapshotted with its id below: the
          // post-update record describes the NEW resource, so a replacement
          // that re-routed would label the survivor with the wrong layer.
          ...(provisionedByBeforeUpdate
            ? { provisionedBy: provisionedByBeforeUpdate }
            : labelRouting && { provisionedBy: labelRouting }),
          // The SURVIVOR's id as a FIELD, not only inside `reason`: a `--json`
          // consumer should not have to parse prose, and this is the one datum
          // a cleanup pass actually needs.
          ...(physicalIdBeforeUpdate && { physicalId: physicalIdBeforeUpdate }),
          reason: updatePartial,
          durationMs: Date.now() - resourceStartedAt,
        });
      }
      // #808 best-effort event: per-resource op succeeded. Read the
      // freshly-stamped routing layer + physical id off the state record
      // the body just wrote (falls back to the label inference / undefined).
      this.recordEvent({
        eventType: 'RESOURCE_SUCCEEDED',
        stackName,
        operation: eventOp,
        logicalId,
        resourceType,
        ...(stateResources[logicalId]?.provisionedBy
          ? { provisionedBy: stateResources[logicalId]?.provisionedBy }
          : labelRouting && { provisionedBy: labelRouting }),
        ...(stateResources[logicalId]?.physicalId && {
          physicalId: stateResources[logicalId]?.physicalId,
        }),
        durationMs: Date.now() - resourceStartedAt,
      });
    } catch (error) {
      renderer.removeTask(logicalId);
      const message = error instanceof Error ? error.message : String(error);
      // Issue #2038: MASKED, and at a strictly higher log level than the retry
      // give-up summary one statement below it. `perResourceSecrets` is
      // populated right after `resolver.resolve` and BEFORE the provider call
      // on both the CREATE and the UPDATE path, so whenever this resource
      // resolved a `{{resolve:...}}` reference the bag handed to the provider
      // was PLAINTEXT — and an AWS validation error routinely quotes the
      // offending value back (`Value '<secret>' at 'clientSecret' failed to
      // satisfy constraint ...`). The `recordEvent` below already masked (via
      // `maskSecretsInEvent`); this `error` line did not, so the durable sink
      // was clean while the terminal printed the secret at DEFAULT verbosity.
      // Masks the CONCATENATED line, matching `maskingRetryLogger`; forwards
      // verbatim for a resource with no recorded secret.
      this.logger.error(
        this.maskForResource(
          logicalId,
          `Failed to ${change.changeType.toLowerCase()} ${logicalId}: ${message}`
        )
      );

      // #808 best-effort event: per-resource op failed. Error metadata
      // only — no resource properties.
      this.recordEvent({
        eventType: 'RESOURCE_FAILED',
        stackName,
        operation: eventOp,
        logicalId,
        resourceType,
        ...(stateResources[logicalId]?.provisionedBy
          ? { provisionedBy: stateResources[logicalId]?.provisionedBy }
          : labelRouting && { provisionedBy: labelRouting }),
        durationMs: Date.now() - resourceStartedAt,
        error: extractDeploymentEventError(error),
      });

      // Issue #2038 review: the CAUSE is masked too, and that is a THIRD sink
      // rather than a belt-and-braces repeat of the two above. `formatError`
      // renders a `CdkdError`'s cause as `Caused by: <cause.message>` and
      // `handleError` logs it at `error` level, so a deploy that fails on a
      // secret-bearing resource printed the plaintext at the CLI boundary even
      // with both log sites masked — the sink reads the error OBJECT, not the
      // text this method formatted. `maskSecretsInError` clones with every own
      // property descriptor (symbols included), so `markNonRetryable`'s marker,
      // `$metadata` and any nested `cause` survive for the classifiers, and it
      // returns the original by identity when nothing matched. Deliberately
      // AFTER `extractDeploymentEventError` above, which masks separately via
      // `recordEvent` and would otherwise mask twice for no benefit.
      throw new ProvisioningError(
        `Failed to ${change.changeType.toLowerCase()} resource ${logicalId}`,
        resourceType,
        logicalId,
        stateResources[logicalId]?.physicalId,
        error instanceof Error
          ? maskSecretsInError(error, this.perResourceSecrets.get(logicalId) ?? EMPTY_SECRETS)
          : undefined
      );
    } finally {
      // Safety net for early-break paths (UPDATE skip, DeletionPolicy: Retain).
      // removeTask is idempotent, so calling it again after the explicit calls
      // above is a no-op.
      renderer.removeTask(logicalId);
    }
  }

  private peekRoutingForLabel(
    change: ResourceChange,
    existingState: ResourceState | undefined
  ): 'sdk' | 'cc-api' | undefined {
    return deriveLabelRouting(change, existingState, this.providerRegistry);
  }

  /**
   * #808 — forward one structured deployment event to the optional
   * recorder. No-op when no recorder was supplied. `record()` is
   * contractually synchronous and never-throwing, but we still guard
   * with a try/catch so an event emission can NEVER abort a deploy.
   */
  private recordEvent(
    event: Omit<import('../types/deployment-events.js').DeploymentEvent, 'timestamp'>
  ): void {
    if (!this.options.eventRecorder) return;
    try {
      this.options.eventRecorder.record(this.maskSecretsInEvent(event));
    } catch {
      // best-effort: never let event recording surface into the deploy path
    }
  }

  /**
   * Mask any resolved secret value out of an event's human-authored text before
   * it is persisted to `deployments/*.jsonl` (which outlives `cdkd destroy`)
   * — GHSA fix. An AWS validation error can quote the offending property value
   * (`Value '<secret>' at 'X' failed to satisfy ...`), and a provider `reason`
   * is provider-authored prose; both reach the event store as `error.message` /
   * `reason`. No-op when the deploy recorded no secrets.
   */
  private maskSecretsInEvent<
    T extends { logicalId?: string; error?: { message?: string }; reason?: string },
  >(event: T): T {
    // Mask with the event's own resource secrets; a resource-less (run-level)
    // event carries no properties-derived text.
    const secrets = event.logicalId ? this.perResourceSecrets.get(event.logicalId) : undefined;
    if (!secrets || secrets.size === 0) return event;
    const next: T = { ...event };
    if (next.error?.message) {
      next.error = { ...next.error, message: maskSecretsInText(next.error.message, secrets) };
    }
    if (next.reason) next.reason = maskSecretsInText(next.reason, secrets);
    return next;
  }

  /**
   * Issue #1002 PR 2 — §7 step 3 post-resolution audit (defense in depth).
   * No-op in legacy mode (`options.assetRedirect` unset). In cdkd-assets
   * mode, a resolved property still naming a mapped SOURCE (CDK bootstrap)
   * bucket / repo means a template shape the §7 rewrite missed — fail the
   * resource loudly BEFORE provisioning instead of deploying a split-brain
   * reference (assets live in cdkd storage, the property points at the CDK
   * bootstrap bucket that `cdk gc` may have emptied).
   */
  private auditResolvedAssetReferences(
    logicalId: string,
    resourceType: string,
    resolvedProps: Record<string, unknown>
  ): void {
    const redirect = this.options.assetRedirect;
    if (!redirect) return;
    const findings = findUnrewrittenAssetReferences(resolvedProps, redirect);
    if (findings.length === 0) return;
    const detail = findings.map((f) => `  - ${f.path}: still references '${f.source}'`).join('\n');
    throw new ProvisioningError(
      `Unrewritten asset reference on '${logicalId}' (${resourceType}): this region uses ` +
        `cdkd-owned asset storage, but the following resolved properties still point at the ` +
        `CDK bootstrap storage that 'cdk gc' may garbage-collect:\n${detail}\n` +
        `This is a template shape cdkd's asset-reference rewrite did not cover — deploying it ` +
        `would split-brain the stack (assets in cdkd storage, properties reading the CDK ` +
        `bucket). Please report this at https://github.com/go-to-k/cdkd/issues with the ` +
        `property shape. Workaround: deploy with --use-cdk-bootstrap-assets to pin the ` +
        `legacy destinations for this app.`,
      resourceType,
      logicalId
    );
  }

  /**
   * The `Snapshot`-policy gate every engine delete site runs BEFORE its
   * delete (issues #1352 / #1353 / #1354). Given the resource's effective
   * policy for THIS delete (`DeletionPolicy` on the destroy / removal paths,
   * `UpdateReplacePolicy` on the replacement paths):
   *
   *   - not `Snapshot` (or `--skip-final-snapshot`) → no-op.
   *   - atomic type, SDK-routed → returns the generated identifier for the
   *     provider's atomic final-snapshot delete parameter.
   *   - atomic type, cc-api-routed → refuses (Cloud Control has no
   *     final-snapshot parameter; `CloudControlProvider.delete` also
   *     fail-closes on the context field as defense-in-depth).
   *   - `PRE_DELETE_SNAPSHOT_TYPES` (EC2 Volume / Redshift Cluster /
   *     ElastiCache ReplicationGroup) → creates the snapshot and waits for
   *     it here, then returns undefined (the subsequent delete is plain).
   *   - anything else Snapshot-tagged → refuses.
   */
  private async prepareFinalSnapshotForDelete(
    logicalId: string,
    resourceType: string,
    currentResource: { physicalId: string; provisionedBy?: 'sdk' | 'cc-api' | undefined },
    policy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined
  ): Promise<string | undefined> {
    if (policy !== 'Snapshot' || this.options.skipFinalSnapshot === true) return undefined;
    if (
      ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType) &&
      currentResource.provisionedBy !== 'cc-api'
    ) {
      return buildFinalSnapshotIdentifier(currentResource.physicalId, resourceType);
    }
    if (ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType)) {
      throw ccRoutedFinalSnapshotError(logicalId, resourceType, '--skip-final-snapshot');
    }
    if (PRE_DELETE_SNAPSHOT_TYPES.has(resourceType)) {
      // Region-pinned clients: `getAwsClients()` is a process-global that a
      // concurrent stack's deploy can repoint at ANOTHER region
      // (`--stack-concurrency > 1` + multi-region apps); a wrong-region
      // snapshot call 404s as a NotFound, which would be read as "source
      // gone" and skip the snapshot. Prefer the engine-scoped clients
      // threaded via options.
      await createPreDeleteFinalSnapshot(
        resourceType,
        currentResource.physicalId,
        logicalId,
        this.options.finalSnapshotClients ?? getAwsClients(),
        this.logger
      );
      return undefined;
    }
    throw unsupportedFinalSnapshotError(logicalId, resourceType, '--skip-final-snapshot');
  }

  /**
   * `--replace` delete-first fallback for a property-driven replacement of a
   * custom-named resource: delete the old name holder, then re-create it
   * under the same name. Shared by the create-first collision catch (issue
   * #960 follow-up) and the name-idempotent same-id guard (issue #1238) so
   * the two --replace escape hatches cannot drift apart.
   */
  private async replaceDeleteFirstAndRecreate(
    logicalId: string,
    resourceType: string,
    currentResource: ResourceState,
    oldDeleteProvider: ResourceProvider,
    replaceProvider: ResourceProvider,
    replaceProps: Record<string, unknown>,
    // Issue #1932 item 3. A PARAMETER rather than a field read inside the
    // method: this helper is shared by both --replace escape hatches, and both
    // call it from the UPDATE case where the resolution pass's own bag is in
    // scope. Reading `perResourceSecrets` here instead would work today but
    // would bind the masker to a map looked up by logical id rather than to
    // the bag the caller actually resolved with, which is a different (and
    // silently wrong under concurrency) thing.
    //
    // Issue #2038 review: it is the BAG, not the finished `CreateContext`, for
    // exactly that reason. The retry logger and the two wrap messages below
    // need the same bag the masker is built from, and re-deriving it from
    // `perResourceSecrets` inside this method would have made the file state
    // the rule above and then break it three lines on. The `CreateContext` is
    // built here from this argument, so the provider call is unchanged.
    secrets: RecordedSecretValues,
    updateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate'
  ): Promise<Awaited<ReturnType<ResourceProvider['create']>>> {
    const createContext: CreateContext = { maskSecrets: createSecretMasker(secrets) };
    // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the OLD
    // resource before the replacement delete, exactly like the destroy
    // paths honor `DeletionPolicy: Snapshot`. Deliberately OUTSIDE the
    // delete's try: a snapshot failure/refusal here must surface with its
    // own typed FINAL_SNAPSHOT_* error, not be rewrapped as "Failed to
    // delete old resource ..." for a delete that was never attempted.
    const finalSnapshotIdentifier = await this.prepareFinalSnapshotForDelete(
      logicalId,
      resourceType,
      currentResource,
      updateReplacePolicy
    );
    let deleteResult: void | ResourceDeleteResult;
    try {
      deleteResult = await oldDeleteProvider.delete(
        logicalId,
        currentResource.physicalId,
        resourceType,
        currentResource.properties,
        {
          expectedRegion: this.stackRegion,
          // Replacement delete: `--force-stateful-recreation` is the user's
          // explicit data-loss consent, so thread it to the provider's data
          // guard (issue #1340).
          forceDataDelete: this.options.forceStatefulRecreation === true,
          ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
        }
      );
    } catch (deleteError) {
      // Mirror the recreate-flagged path's wrapping: the delete is
      // load-bearing here (without it the re-create collides again).
      //
      // Issue #2038: masked at CONSTRUCTION, not only where it is logged. This
      // message lands in `provisionResource`'s `error` line, in the durable
      // `RESOURCE_FAILED` event, and in the `ProvisioningError` cause — all
      // three of which mask it again, so double-masking is a no-op. Masking
      // here means the plaintext never exists inside a thrown `Error` at all,
      // so a future reader of the `cause` chain cannot re-open the hole. The
      // delete's own payload is the STATE record, which is redacted; the wrap
      // is masked because a provider re-creating from `replaceProps` can echo
      // the resolved value back through this catch.
      //
      // MEASURED UNFENCEABLE, deliberately kept: removing this mask (and the
      // twin on the re-create wrap below) leaves the whole unit suite green,
      // because every reader downstream masks independently. It is
      // defense-in-depth against a future change to one of those readers, not
      // a fence — do not record it in a PR body as a tested behavior.
      throw new Error(
        maskSecretsInText(
          `Failed to delete old resource ${logicalId} (${currentResource.physicalId}) ` +
            `during the --replace delete-first fallback: ` +
            `${deleteError instanceof Error ? deleteError.message : String(deleteError)}`,
          secrets
        )
      );
    }
    // Issue #1762: a skip here FAILS the resource, unlike the template-DELETE
    // branch. The old resource is still alive and the whole point of this
    // path is that the re-create needs its name released — proceeding would
    // either collide or, for a type with no name conflict, leave two live
    // resources with state describing one. Checked outside the catch above so
    // the wrapping never sees it (a return value, not a throw).
    const replaceSkipReason = deleteSkipReason(deleteResult);
    if (replaceSkipReason !== undefined) {
      throw new Error(
        deleteSkippedMessage(
          logicalId,
          currentResource.physicalId,
          replaceSkipReason,
          'during the --replace delete-first fallback'
        )
      );
    }
    this.logger.info(`  ${green('✓')} Old resource deleted`);
    this.logger.info(`  Re-creating ${logicalId}...`);
    try {
      // Some providers return from delete() before the name is
      // actually released (async deletes: Step Functions, Kinesis,
      // Pipes DELETING state). "already exists" is deliberately
      // NOT in the transient-retry patterns, so give the re-create
      // its own bounded collision retry instead of failing fast
      // with the old resource already gone. SQS additionally
      // enforces a ~60s same-name re-creation cooldown after the
      // delete (QueueDeletedRecently, issue #1206) — the schedule
      // (2s/4s/8s then capped at 10s over 8 retries ≈ 64s total
      // sleep) covers the full cooldown window even when the inner
      // generic retry's budget is exhausted first.
      return await withRetry(
        () =>
          this.withRetry(
            // Issue #1903, same scope as the ordinary CREATE path: bind the
            // resolved-secrets bag around every provider create, so no
            // replacement route can silently skip the nested-stack seed.
            () =>
              withCurrentResourceSecrets(secrets, () =>
                replaceProvider.create(logicalId, resourceType, replaceProps, createContext)
              ),
            logicalId,
            undefined,
            undefined,
            replaceProvider
          ),
        logicalId,
        {
          maxRetries: 8,
          initialDelayMs: 2_000,
          maxDelayMs: 10_000,
          // Issue #2038: `replaceProps` is RESOLVED, so mask the AWS message
          // this retry echoes. Bound to the CALLER's bag (the `secrets`
          // parameter above), not looked up by logical id -- see
          // {@link maskingRetryLoggerFor}.
          logger: this.maskingRetryLoggerFor(secrets),
          isInterrupted: () => this.interrupted,
          onInterrupted: () => new InterruptedError(this.interruptCause ?? 'user'),
          isRetryable: isRecreateRetryableError,
        }
      );
    } catch (recreateError) {
      // The old resource is ALREADY deleted at this point — say so,
      // because state still records it and the next deploy's UPDATE
      // would otherwise chase a resource that no longer exists.
      //
      // Issue #2038: masked at construction, same reason as the delete wrap
      // above — and more acutely, since THIS one wraps a create that was
      // handed the RESOLVED `replaceProps`.
      throw new Error(
        maskSecretsInText(
          `Failed to re-create ${logicalId} after the --replace delete-first fallback ` +
            `already deleted the old resource (${currentResource.physicalId}): ` +
            `${recreateError instanceof Error ? recreateError.message : String(recreateError)}. ` +
            `Re-run the deploy to create it fresh.`,
          secrets
        )
      );
    }
  }

  /**
   * Inner body of provisionResource, extracted so the outer wrapper can
   * apply the per-resource deadline (`withResourceDeadline`) without
   * having the timeout / warn timer code dwarf the real provisioning
   * logic. Behaviour is unchanged from the pre-deadline implementation.
   */
  private async provisionResourceBody(
    logicalId: string,
    change: ResourceChange,
    stateResources: Record<string, ResourceState>,
    stackName: string,
    template?: CloudFormationTemplate,
    parameterValues?: Record<string, unknown>,
    conditions?: Record<string, boolean>,
    counts?: ProvisionCounts,
    progress?: { current: number; total: number }
  ): Promise<ResourceOutcomeSignal | void> {
    const resourceType = change.resourceType;
    // Existing state record (UPDATE / DELETE) — load-bearing for the
    // sticky `provisionedBy` routing introduced in #614: a resource
    // first created via Cloud Control (because its template had
    // silent-drop properties at the time) stays on Cloud Control for
    // every subsequent update / delete, even if the SDK provider has
    // since gained property coverage.
    const existingState = stateResources[logicalId];
    const renderer = getLiveRenderer();

    switch (change.changeType) {
      case 'CREATE': {
        const desiredProps = change.desiredProperties || {};

        // Resolve intrinsic functions in properties
        const context = this.buildResolverContext(
          {
            template: template!,
            resources: stateResources,
            ...(parameterValues && { parameters: parameterValues }),
            ...(conditions && { conditions }),
          },
          stackName
        );

        // Store the secrets substituted during THIS resource's resolution so the
        // save choke point (and the async observed-capture drain) redact this
        // record only with its own secrets (GHSA fix — see perResourceSecrets).
        //
        // Issue #2038 review: registered BEFORE `resolve`, not after. The
        // resolver MUTATES `context.recordedSecretValues` in place, so the map
        // this line publishes is the very one the resolution fills — but a
        // throw from INSIDE `resolve()`, after a secret was already
        // substituted, used to reach the catch in this method with NO entry for
        // this resource, so the error line, the durable event and the
        // `ProvisioningError` cause all masked against an EMPTY bag. No
        // resolver throw is known to inline a resolved value, so this closes a
        // WINDOW rather than a demonstrated leak. The hoist cannot expose a
        // STALE bag: the map is keyed by logical id, `deploy()` resets it per
        // run, and each logical id is provisioned once — so this key has no
        // prior entry and the only thing another reader can observe earlier is
        // this resource's own map, empty, which every masking site treats
        // identically to an absent entry.
        if (context.recordedSecretValues) {
          this.perResourceSecrets.set(logicalId, context.recordedSecretValues);
        }
        const resolvedProps = (await this.resolver.resolve(desiredProps, context)) as Record<
          string,
          unknown
        >;
        // Issue #2274: before ANY of the resolved bag reaches a provider, refuse
        // if the resolution had to serve an attribute a previous deploy
        // redacted. See the helper — the value would be the literal `***`.
        this.refuseRedactedAttributeReads(logicalId, resourceType, context);
        // Capture the UNRESOLVED bag as the redaction position source (#1904).
        this.perResourceTemplateProps.set(logicalId, desiredProps);
        // Named so the provider call below can bind the SAME bag into its
        // masker (issue #1932 item 3), mirroring `updateSecrets` on the UPDATE
        // path. `?? new Map()` rather than a conditional: `buildResolverContext`
        // always sets the field, so the fallback is unreachable in practice,
        // but a masker bound to a real map is what keeps the provider call
        // shape identical on both paths.
        const createSecrets = context.recordedSecretValues ?? new Map<string, string>();
        // Issue #2291: for an `AWS::CloudFormation::Stack` row, remember which
        // `{{resolve:...}}` expression each `Parameters` entry was resolved
        // FROM, keyed by the child's parameter NAME. The bag above is keyed by
        // PLAINTEXT, so two parameters resolving to one value have already
        // collapsed there — the parent's own template is the only uncollapsed
        // source left, and this is the last point at which both it and the
        // resolved values are in hand. `withCurrentResourceSecrets` binds THIS
        // bag around the provider call below, so the child engine reads the
        // associations off the same object. No-op for every other type.
        recordNestedStackParameterExpressions(
          createSecrets,
          resourceType,
          resolvedProps,
          desiredProps
        );

        this.auditResolvedAssetReferences(logicalId, resourceType, resolvedProps);

        // #1198: snapshot the attempted (resolved) properties so a failed
        // CREATE can be journaled with what it tried to apply.
        this.attemptedResolvedProps.set(logicalId, resolvedProps);

        // #614 routing: consult the registry with the resolved properties.
        // If the SDK provider would silent-drop a top-level key (and the
        // user has not overridden it via `--allow-unsupported-properties`),
        // we auto-route via Cloud Control API. The chosen `provisionedBy`
        // is persisted on state so the next update / delete uses the
        // same layer.
        const createDecision = this.providerRegistry.getProviderFor({
          resourceType,
          properties: resolvedProps,
        });
        const createProvider = createDecision.provider;
        const createProps =
          createDecision.provisionedBy === 'cc-api'
            ? this.preparePropertiesForCcApi(resourceType, resolvedProps, logicalId)
            : resolvedProps;

        const result = await this.withRetry(
          () =>
            // Issue #1903: the SAME bag, bound to this call's async chain so
            // `NestedStackProvider` can seed it into the child engine it
            // builds. Inside the retry arrow, so every attempt is scoped.
            withCurrentResourceSecrets(createSecrets, () =>
              createProvider.create(logicalId, resourceType, createProps, {
                // Issue #1932 item 3. The bag handed to the provider is RESOLVED,
                // so a `{{resolve:secretsmanager:...}}` property is plaintext by
                // now; a provider that echoes one into its own warn is outside
                // both existing masking boundaries (this engine's error/reason
                // text and the resolver's debug line). Give it the capability
                // rather than the bag — see `SecretMaskingContext`.
                maskSecrets: createSecretMasker(createSecrets),
              })
            ),
          logicalId,
          undefined,
          undefined,
          createProvider
        );

        // Issue #2274: BEFORE the record is built, so the needles exist by the
        // time anything is persisted, and before any dependent resolves against
        // this resource's fresh attributes.
        this.registerNoEchoAttributes(logicalId, result, createSecrets, resolvedProps);

        // Extract ALL dependencies from template (Ref, Fn::GetAtt, DependsOn)
        // so that deletion order is correct even without implicit type-based deps
        const dependencies = this.extractAllDependencies(template, logicalId);
        const templateAttrs = this.extractTemplateAttributes(template, logicalId);

        stateResources[logicalId] = {
          physicalId: result.physicalId,
          resourceType,
          properties: this.propertiesToRecord(resolvedProps, result),
          // The REAL attribute values, deliberately: this in-memory record is
          // what `Fn::GetAtt` serves to dependents in this same run, and
          // CloudFormation delivers a `NoEcho` custom resource's `Data` to a
          // dependent in the clear (issue #2274, measured). Masking happens at
          // the PERSIST choke point, from the needles registered above.
          ...(result.attributes && { attributes: result.attributes }),
          ...(dependencies && dependencies.length > 0 && { dependencies }),
          ...templateAttrs,
          provisionedBy: createDecision.provisionedBy,
        };

        const createCaptureSiblings = await this.buildObservedCaptureSiblings(
          resourceType,
          logicalId,
          result.physicalId,
          template,
          stateResources,
          stackName,
          parameterValues,
          conditions
        );
        this.kickOffObservedCapture(
          createProvider,
          logicalId,
          result.physicalId,
          resourceType,
          resolvedProps,
          createCaptureSiblings
        );

        if (counts) counts.created++;
        if (progress) progress.current++;
        const createPrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
        renderer.removeTask(logicalId);
        this.logger.info(
          `${createPrefix}${formatResourceLine('created', logicalId, resourceType)}`
        );
        break;
      }

      case 'UPDATE': {
        const currentResource = existingState;
        if (!currentResource) {
          throw new Error(`Cannot update ${logicalId}: resource not found in state`);
        }

        const desiredProps = change.desiredProperties || {};
        const currentProps = change.currentProperties || {};

        // Resolve intrinsic functions in properties
        const context = this.buildResolverContext(
          {
            template: template!,
            resources: stateResources,
            ...(parameterValues && { parameters: parameterValues }),
            ...(conditions && { conditions }),
          },
          stackName
        );

        // Issue #2038 review: registered BEFORE `resolve`, same reason as the
        // CREATE path above — the resolver fills this map in place, and a throw
        // from inside `resolve()` after a substitution otherwise reaches the
        // shared catch with an empty bag.
        const updateSecrets = context.recordedSecretValues ?? new Map<string, string>();
        this.perResourceSecrets.set(logicalId, updateSecrets);
        const resolvedProps = (await this.resolver.resolve(desiredProps, context)) as Record<
          string,
          unknown
        >;
        // Issue #2274: the UPDATE twin of the CREATE arm's refusal — same
        // reason, and needed on BOTH because an existing dependent whose OTHER
        // properties changed is the commonest way to reach a redacted read.
        this.refuseRedactedAttributeReads(logicalId, resourceType, context);
        // Same position source on the UPDATE path (#1904).
        this.perResourceTemplateProps.set(logicalId, desiredProps);
        // Issue #2291: for an `AWS::CloudFormation::Stack` row, remember which
        // `{{resolve:...}}` expression each `Parameters` entry was resolved
        // FROM, keyed by the child's parameter NAME. The bag above is keyed by
        // PLAINTEXT, so two parameters resolving to one value have already
        // collapsed there — the parent's own template is the only uncollapsed
        // source left, and this is the last point at which both it and the
        // resolved values are in hand. `withCurrentResourceSecrets` binds THIS
        // bag around the provider call below, so the child engine reads the
        // associations off the same object. No-op for every other type.
        recordNestedStackParameterExpressions(
          updateSecrets,
          resourceType,
          resolvedProps,
          desiredProps
        );

        this.auditResolvedAssetReferences(logicalId, resourceType, resolvedProps);

        // #1198: snapshot the attempted (resolved) properties so a failed
        // UPDATE can be journaled with what it tried to apply (load-bearing
        // for the --revert-failed patch generation).
        this.attemptedResolvedProps.set(logicalId, resolvedProps);

        // Re-check diff after resolving intrinsic functions
        // DiffCalculator compares unresolved template vs resolved state, which may produce false positives.
        // Compare the REDACTED resolved bag (secret plaintext -> `{{resolve:...}}`
        // expression) against the stored side, which also holds the expression
        // (GHSA fix): a rotated secret behind an unchanged reference is a no-op,
        // matching CloudFormation, rather than a spurious UPDATE every deploy.
        // POSITIONED by the same template bag the persist path uses (#1910):
        // `currentProps` comes from state, which since #1904 holds each leaf's
        // OWN expression, so a value-only redaction here collapses a coinciding
        // pair onto the survivor and the comparison can never match — a
        // redundant UPDATE on every deploy of such a resource.
        if (
          JSON.stringify(redactSecretsForState(resolvedProps, updateSecrets, desiredProps)) ===
          JSON.stringify(currentProps)
        ) {
          // Attribute-only change (schema v5+): `DeletionPolicy` /
          // `UpdateReplacePolicy` may have flipped without any AWS-side
          // property change. There is no per-resource AWS API for those —
          // refresh cdkd state alone and skip the provider call.
          if (change.attributeChanges && change.attributeChanges.length > 0) {
            const attrSummary = change.attributeChanges
              .map((a) => `${a.attribute}: ${a.oldValue ?? '(unset)'} → ${a.newValue ?? '(unset)'}`)
              .join(', ');
            this.logger.info(`  ↻ ${logicalId} (${resourceType}) attribute update: ${attrSummary}`);
            stateResources[logicalId] = {
              ...currentResource,
              ...this.extractTemplateAttributes(template, logicalId),
            };
            if (counts) counts.updated++;
            if (progress) progress.current++;
            const attrPrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
            renderer.removeTask(logicalId);
            this.logger.info(
              `${attrPrefix}${formatResourceLine('updated', logicalId, resourceType, 'updated (metadata)')}`
            );
            break;
          }
          this.logger.debug(
            `Skipping ${logicalId}: no actual changes after intrinsic function resolution`
          );
          if (counts) counts.skipped++;
          break;
        }

        // Check if this update requires resource replacement (immutable property changed)
        const propertyDrivenReplacement = change.propertyChanges?.some(
          (pc) => pc.requiresReplacement
        );
        // Issue [#615] — the user explicitly named this resource via
        // `--recreate-via-cc-api <LogicalId>` so this deploy MUST destroy
        // + recreate it through Cloud Control regardless of whether the
        // template's diff would otherwise drive a replacement.
        const recreateViaCcApi = this.options.recreateViaCcApiTargets?.has(logicalId) ?? false;
        // #651 reverse direction. Mutually exclusive with `recreateViaCcApi`
        // — the pre-flight validator rejects any logical id named in both
        // lists, so at most one of these two booleans is true at a time.
        const recreateViaSdkProvider =
          this.options.recreateViaSdkProviderTargets?.has(logicalId) ?? false;
        const recreateFlagged = recreateViaCcApi || recreateViaSdkProvider;
        const needsReplacement = propertyDrivenReplacement || recreateFlagged;

        // Extract ALL dependencies from template (Ref, Fn::GetAtt, DependsOn)
        const dependencies = this.extractAllDependencies(template, logicalId);

        // `UpdateReplacePolicy: Retain` orphans the OLD physical resource on a
        // replacement (the create-first path below leaves it in place — see the
        // "Retaining old" branch), so a property-driven replacement of a
        // Retain-policy resource loses NO data. Read it here so the stateful
        // guard can honor it, and reused by every later site that asks what
        // policy the user is applying NOW: the replace/delete sites below and
        // the update-failure fallback's `Retain` note. The ONE read that does
        // not use it is the fallback's SNAPSHOT read, which falls back to
        // `currentResource.updateReplacePolicy`; the reason is stated at that
        // call site.
        const updateReplacePolicy = template?.Resources?.[logicalId]?.UpdateReplacePolicy;

        if (needsReplacement) {
          // Stateful guard for PROPERTY-DRIVEN replacement (an immutable /
          // createOnly property changed in the template). DELETE+CREATEing a
          // stateful type (RDS / EFS / Secret / SSM Parameter / Kinesis / etc.)
          // loses all of its data, so — mirroring the `--replace` and
          // `--recreate-via-*` paths — require `--force-stateful-recreation` to
          // confirm the data loss. Only the property-driven case is gated here:
          // the `--recreate-via-*` flags run their own pre-flight stateful probe
          // (`probeStatefulRecreateTargetsAsync`) before the deploy, so a
          // recreate-flagged target has already been validated. Uses the
          // conservative mid-deploy variant (treats a non-probed S3 bucket as
          // stateful) since the diff loop has no chance to run the async
          // object-count probe. A `Retain` UpdateReplacePolicy is exempt: the
          // old resource + its data survive the replacement (orphaned, not
          // deleted), so there is no data loss to confirm. `Snapshot` is NOT
          // exempt: cdkd DOES take a final snapshot on the replacement delete
          // (issue #1354), but a snapshot is a point-in-time copy, not a
          // surviving resource — the live resource is still destroyed and
          // recreated, so the consent flag is still the right gate.
          if (propertyDrivenReplacement && !recreateFlagged && updateReplacePolicy !== 'Retain') {
            const statefulReason = isStatefulRecreateTargetForReplace(resourceType, currentProps);
            if (statefulReason && this.options.forceStatefulRecreation !== true) {
              const immutableProps = change.propertyChanges
                ?.filter((pc) => pc.requiresReplacement)
                .map((pc) => pc.path)
                .join(', ');
              // `markNonRetryable`: the verdict is computed from a CLI flag and
              // a state-recorded property bag, neither of which a retry can
              // change — and the message interpolates a template-controlled
              // logical id into text the SUBSTRING-matching retry classifiers
              // read. The twin marker sits on the update-failure fallback's
              // guard below; both are declarations, not fixes for an observed
              // retry (the throws are outside `withRetry` today, but a nested
              // stack's child engine re-throws into the parent's).
              throw markNonRetryable(
                new CdkdError(
                  `${logicalId} (${resourceType}) requires replacement (immutable property changed: ` +
                    `${immutableProps}) but it is a stateful resource — ` +
                    `${renderStatefulReason(statefulReason)}. Re-run with ` +
                    `--force-stateful-recreation to confirm the data loss, or change the resource ` +
                    `definition to avoid the immutable-property change.`,
                  'STATEFUL_REPLACE_BLOCKED'
                )
              );
            }
          }

          // Resource replacement: DELETE old → CREATE new
          let replacementReason: string;
          if (recreateViaCcApi) {
            replacementReason = '--recreate-via-cc-api flag (mid-life SDK→CC migration)';
          } else if (recreateViaSdkProvider) {
            // #651 reverse direction.
            replacementReason = '--recreate-via-sdk-provider flag (mid-life CC→SDK migration)';
          } else {
            replacementReason = `immutable properties changed: ${change.propertyChanges
              ?.filter((pc) => pc.requiresReplacement)
              .map((pc) => pc.path)
              .join(', ')}`;
          }
          this.logger.info(`Replacing ${logicalId} (${resourceType}) - ${replacementReason}`);

          // The new (replacement) resource gets a fresh routing decision —
          // a property the SDK provider used to silent-drop may now be
          // wired, or vice versa. The OLD resource's delete uses the
          // state-recorded layer (sticky) so a CC-managed legacy is
          // deleted via CC even if the template now would land on SDK.
          //
          // When the recreate is driven by `--recreate-via-cc-api`, pass
          // an explicit `provisionedBy: 'cc-api'` hint so the routing
          // decision tree's rule 2 ("sticky CC") returns CC even when
          // the template itself has no silent-drop property. The new
          // physical id then stamps `provisionedBy: 'cc-api'` on state
          // and all subsequent ops stick to CC.
          //
          // #651: `--recreate-via-sdk-provider` is the reverse — force
          // `provisionedBy: 'sdk'` so the routing decision returns the
          // SDK provider even though the current state record sticks at
          // 'cc-api'. The new physical id stamps `provisionedBy: 'sdk'`.
          const recreateDirectionHint: 'sdk' | 'cc-api' | undefined = recreateViaCcApi
            ? 'cc-api'
            : recreateViaSdkProvider
              ? 'sdk'
              : undefined;
          const replaceDecision = this.providerRegistry.getProviderFor({
            resourceType,
            properties: resolvedProps,
            ...(recreateDirectionHint && { provisionedBy: recreateDirectionHint }),
          });
          const replaceProvider = replaceDecision.provider;
          const replaceProps =
            replaceDecision.provisionedBy === 'cc-api'
              ? this.preparePropertiesForCcApi(resourceType, resolvedProps, logicalId)
              : resolvedProps;

          // Order: property-driven replacement (immutable prop changed)
          // creates the NEW resource first so the old survives a CREATE
          // failure — matches CFn's safe-replacement order. The
          // `--recreate-via-cc-api` flag (#615) instead destroys the OLD
          // resource first: the user-named recreate target almost always
          // has a user-supplied physical name (e.g. `functionName: 'foo'`),
          // and a create-first attempt with the same name collides with
          // the existing resource. Brief deletion-window downtime is the
          // explicit cost of opting into recreate; the design doc § 2
          // calls this out as "Old physical resource: destroyed via SDK
          // Provider ... New physical resource: created via CC API",
          // i.e. destroy-then-create. (`updateReplacePolicy` is read once
          // above, before the stateful guard, and reused here.)
          const oldDeleteProvider = this.providerRegistry.getProviderFor({
            resourceType,
            provisionedBy: currentResource.provisionedBy,
          }).provider;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape varies by ResourceProvider impl
          let createResult: any;
          if (recreateFlagged) {
            // Destroy-then-create path. Same `UpdateReplacePolicy:
            // Retain` semantics — retained old resources leak (named the
            // same as the new); document via warning. CFn would refuse a
            // Retain + replace combo at template-author time; cdkd warns
            // and proceeds since the user explicitly opted in.
            const recreateFlagName = recreateViaCcApi
              ? '--recreate-via-cc-api'
              : '--recreate-via-sdk-provider';
            if (updateReplacePolicy === 'Retain') {
              this.logger.warn(
                `  ⚠ ${logicalId} has UpdateReplacePolicy: Retain — ${recreateFlagName} will ` +
                  `leak the old physical resource (${currentResource.physicalId}). The new ` +
                  `resource shares the same name where applicable; if the type ` +
                  `has user-supplied names (e.g. functionName, bucketName), the create will ` +
                  `deterministically collide with the retained orphan.`
              );
            } else {
              this.logger.info(
                `  Destroying old ${logicalId} (${currentResource.physicalId}) before recreate...`
              );
              // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the
              // old resource before the recreate's delete. OUTSIDE the try
              // so a snapshot failure/refusal keeps its typed
              // FINAL_SNAPSHOT_* error instead of being rewrapped as a
              // delete failure that never happened.
              const recreateFinalSnapshotId = await this.prepareFinalSnapshotForDelete(
                logicalId,
                resourceType,
                currentResource,
                updateReplacePolicy
              );
              let recreateDeleteResult: void | ResourceDeleteResult;
              try {
                recreateDeleteResult = await oldDeleteProvider.delete(
                  logicalId,
                  currentResource.physicalId,
                  resourceType,
                  currentResource.properties,
                  {
                    expectedRegion: this.stackRegion,
                    forceDataDelete: this.options.forceStatefulRecreation === true,
                    ...(recreateFinalSnapshotId !== undefined && {
                      finalSnapshotIdentifier: recreateFinalSnapshotId,
                    }),
                  }
                );
              } catch (deleteError) {
                // Re-throw so the deploy engine's existing rollback path
                // sees the failure — recreate's destroy is load-bearing
                // (without it the subsequent create collides with the
                // pre-existing resource), so a swallowed failure would
                // produce a confusing AlreadyExists later.
                throw new Error(
                  `Failed to destroy old resource ${logicalId} (${currentResource.physicalId}) ` +
                    `during ${recreateFlagName}: ` +
                    `${deleteError instanceof Error ? deleteError.message : String(deleteError)}`
                );
              }
              // Issue #1762: same reasoning as the delete-first fallback —
              // this destroy is load-bearing, so a skip has to fail the
              // resource rather than let the create run beside a live old one.
              const recreateSkipReason = deleteSkipReason(recreateDeleteResult);
              if (recreateSkipReason !== undefined) {
                throw new Error(
                  deleteSkippedMessage(
                    logicalId,
                    currentResource.physicalId,
                    recreateSkipReason,
                    `during ${recreateFlagName}`
                  )
                );
              }
              this.logger.info(`  ${green('✓')} Old resource deleted`);
            }

            this.logger.info(`  Creating new ${logicalId}...`);
            // Delete-then-create just released the old resource's name, so
            // the re-create can hit a late name release ("already exists"
            // from an async delete) or the SQS 60s same-name cooldown
            // (QueueDeletedRecently, issue #1214). The inner retry matches
            // the cooldown — and since issue #2116 it rides the name-cooldown
            // grid (2s/4s/8s then 10s, ≈64s), not the generic ~47s one it used
            // to inherit, so the inner loop alone now covers the 60s window
            // rather than typically ending inside it.
            //
            // This outer loop is kept anyway, and the reason has MOVED rather
            // than disappeared: it is no longer "the inner budget is too
            // short" but that the outer filter is `isRecreateRetryableError`,
            // which also covers the late name RELEASE ("already exists" from
            // an async delete) that the inner default classifier deliberately
            // rejects. Note the two now COMPOUND — the outer loop re-enters an
            // inner loop that is itself 64s — measured at 640s total sleep on
            // a cooldown, inside the 30-minute per-resource deadline. See
            // `NAME_COOLDOWN_INITIAL_DELAY_MS` in retry.ts.
            createResult = await withRetry(
              () =>
                this.withRetry(
                  () =>
                    withCurrentResourceSecrets(updateSecrets, () =>
                      replaceProvider.create(logicalId, resourceType, replaceProps, {
                        maskSecrets: createSecretMasker(updateSecrets),
                      })
                    ),
                  logicalId,
                  undefined,
                  undefined,
                  replaceProvider
                ),
              logicalId,
              {
                maxRetries: 8,
                initialDelayMs: 2_000,
                maxDelayMs: 10_000,
                // Issue #2038, same reason as the --replace fallback above --
                // and bound to `updateSecrets`, the bag this UPDATE resolved
                // with and the very one the `createSecretMasker` one statement
                // up is built from, rather than looked up by logical id.
                logger: this.maskingRetryLoggerFor(updateSecrets),
                isInterrupted: () => this.interrupted,
                onInterrupted: () => new InterruptedError(this.interruptCause ?? 'user'),
                isRetryable: isRecreateRetryableError,
              }
            );

            // Issue #1238: under `UpdateReplacePolicy: Retain` the old
            // resource was NOT destroyed above, so a name-idempotent Create
            // API (e.g. SQS CreateQueue with an unchanged QueueName) can
            // silently return the EXISTING resource instead of colliding.
            // Recording that id as the "new" resource would re-adopt the
            // resource the Retain policy just orphaned — without the new
            // properties ever being applied. Fail before the state
            // bookkeeping runs; the old resource and its state record stay
            // intact.
            if (
              updateReplacePolicy === 'Retain' &&
              createResult.physicalId === currentResource.physicalId
            ) {
              throw new CdkdError(
                `${logicalId} (${resourceType}) recreate returned the existing resource ` +
                  `(${currentResource.physicalId}) instead of creating a new one — its Create ` +
                  `API is name-idempotent — and UpdateReplacePolicy: Retain means the old ` +
                  `resource was never destroyed, so the new properties were not applied. ` +
                  `Rename the resource in your CDK code (or remove the explicit physical ` +
                  `name) so the recreate can produce a genuinely new resource.`,
                'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
              );
            }
          } else {
            // Property-driven replacement: create-then-destroy (CFn
            // safe-replacement order — keeps the old alive if CREATE
            // fails so the deploy can roll back to it cleanly).
            this.logger.info(`  Creating new ${logicalId}...`);
            let deletedOldFirst = false;
            try {
              createResult = await this.withRetry(
                () =>
                  withCurrentResourceSecrets(updateSecrets, () =>
                    replaceProvider.create(logicalId, resourceType, replaceProps, {
                      maskSecrets: createSecretMasker(updateSecrets),
                    })
                  ),
                logicalId,
                undefined,
                undefined,
                replaceProvider
              );
            } catch (createError) {
              const createMsg =
                createError instanceof Error ? createError.message : String(createError);
              // A custom-named resource cannot be safely replaced: the
              // create-first attempt collides with the old resource still
              // holding the name. CloudFormation refuses this same shape
              // ("cannot update a stack when a custom-named resource
              // requires replacing"); surface an equally clear error —
              // with a working one-command escape hatch CFn lacks —
              // instead of the raw AlreadyExists (issue #960 follow-up).
              //
              // NOTE: the detection is a message HEURISTIC — an "already
              // exists" raised by something other than the replaced
              // resource's own name (e.g. an externally-owned sibling)
              // also matches. The blast radius is bounded: delete-first
              // only fires under the explicit --replace opt-in, targets
              // only the state-recorded old physicalId, and the stateful
              // guard has already run.
              const nameCollision = isNameCollisionError(createMsg);
              if (!nameCollision) throw createError;
              // Retain pins the old resource (and its name) in place, so a
              // same-name replacement can never proceed under any flag.
              // (Snapshot is not special-cased HERE — the old resource is
              // still deleted so the name frees up; the delete-first helper
              // takes its final snapshot first, issue #1354.)
              const nameOrigin = this.replacementNameOrigin(logicalId, currentResource.physicalId);
              if (updateReplacePolicy === 'Retain') {
                throw new CdkdError(
                  `${logicalId} (${resourceType}) requires replacement, but its physical name ` +
                    `is still held by the existing resource AND UpdateReplacePolicy: Retain ` +
                    `pins that resource in place. ${nameOrigin.descriptor}. ` +
                    `${nameOrigin.remedy} — with Retain, the old resource keeps the name, so a ` +
                    `same-name replacement can never proceed.`,
                  'NAMED_REPLACEMENT_COLLISION'
                );
              }
              if (this.options.replace !== true) {
                throw new CdkdError(
                  `${logicalId} (${resourceType}) requires replacement, but the create-first ` +
                    `attempt collided with the existing resource: ${createMsg}. ` +
                    `${nameOrigin.descriptor}, so the CloudFormation-style safe replacement ` +
                    `order (create the new resource before deleting the old) cannot reuse the ` +
                    `occupied name — CloudFormation refuses this shape with "cannot update a ` +
                    `stack when a custom-named resource requires replacing". ` +
                    `${nameOrigin.remedy}, or re-run with \`cdkd deploy --replace\` to delete ` +
                    `the old resource FIRST and recreate it under the same name (the resource ` +
                    `is briefly unavailable while it is recreated).`,
                  'NAMED_REPLACEMENT_COLLISION'
                );
              }
              // --replace opt-in: the user accepts delete-first semantics
              // (the stateful guard for this property-driven replacement
              // already ran above). Delete the old holder, then re-create.
              // "named" not "custom-named": the name may be cdkd's own
              // derivation, and this line PRINTS the physical id, so a user
              // reading it against a template that declares no such name was
              // being told it was theirs (issue #1636).
              this.logger.info(
                `  Create-first collided with the existing resource's name and --replace is ` +
                  `set — deleting old ${logicalId} (${currentResource.physicalId}) first...`
              );
              deletedOldFirst = true;
              createResult = await this.replaceDeleteFirstAndRecreate(
                logicalId,
                resourceType,
                currentResource,
                oldDeleteProvider,
                replaceProvider,
                replaceProps,
                updateSecrets,
                updateReplacePolicy
              );
            }

            // Issue #1238: a name-idempotent Create API (e.g. SQS
            // CreateQueue with an unchanged QueueName) does NOT collide
            // when the template carries an explicit physical name — it
            // silently returns the OLD resource's physicalId as the "new"
            // one. The "new" resource IS the old one, so the delete-old
            // step below would destroy the very resource the deploy just
            // reported as created, and state would keep pointing at a
            // deleted resource (observed live with a FIFO queue). Mirror
            // the create-first collision handling above: hard-fail under
            // Retain, fail with the rename / --replace remediation without
            // the opt-in, and fall back to delete-first + re-create under
            // --replace. Skipped when the old resource was already deleted
            // (delete-first fallback) — there, re-acquiring the same
            // physical id under the same name is the expected outcome.
            if (!deletedOldFirst && createResult.physicalId === currentResource.physicalId) {
              const idempotentNameOrigin = this.replacementNameOrigin(
                logicalId,
                currentResource.physicalId
              );
              if (updateReplacePolicy === 'Retain') {
                throw new CdkdError(
                  `${logicalId} (${resourceType}) requires replacement, but its Create API is ` +
                    `name-idempotent: the create-first attempt returned the existing resource ` +
                    `(${currentResource.physicalId}) instead of creating a new one, and ` +
                    `UpdateReplacePolicy: Retain pins that resource in place. ` +
                    `${idempotentNameOrigin.descriptor}. ${idempotentNameOrigin.remedy} — with ` +
                    `Retain, the old resource keeps the name, so a same-name replacement can ` +
                    `never proceed.`,
                  'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
                );
              }
              if (this.options.replace !== true) {
                throw new CdkdError(
                  `${logicalId} (${resourceType}) requires replacement, but its Create API is ` +
                    `name-idempotent: the create-first attempt returned the EXISTING resource ` +
                    `(${currentResource.physicalId}) instead of creating a new one, so deleting ` +
                    `the "old" resource would silently destroy the resource the deploy just ` +
                    `reported as created. ${idempotentNameOrigin.descriptor}; ` +
                    `${idempotentNameOrigin.remedy}, or re-run with ` +
                    `\`cdkd deploy --replace\` to delete the old resource FIRST and recreate ` +
                    `it under the same name (the resource is briefly unavailable while it is ` +
                    `recreated). Note: this branch is also reached when the old resource was ` +
                    `deleted out-of-band and the physical id is name-derived — there the ` +
                    `create was a genuine fresh create; \`--replace\` converges that case too.`,
                  'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
                );
              }
              // --replace opt-in: same delete-first fallback as the
              // collision path — the "created" resource is the old one, so
              // deleting the old physical id releases the name, and the
              // re-create applies the new properties for real.
              this.logger.info(
                `  Create-first returned the existing resource (name-idempotent Create API) ` +
                  `and --replace is set — deleting old ${logicalId} ` +
                  `(${currentResource.physicalId}) first...`
              );
              deletedOldFirst = true;
              createResult = await this.replaceDeleteFirstAndRecreate(
                logicalId,
                resourceType,
                currentResource,
                oldDeleteProvider,
                replaceProvider,
                replaceProps,
                updateSecrets,
                updateReplacePolicy
              );
            }

            if (deletedOldFirst) {
              // Old resource is already gone (delete-first fallback above).
            } else if (updateReplacePolicy === 'Retain') {
              this.logger.info(
                `  Retaining old ${logicalId} (${currentResource.physicalId}) - UpdateReplacePolicy: Retain`
              );
            } else {
              this.logger.info(`  Deleting old ${logicalId} (${currentResource.physicalId})...`);
              // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the
              // old resource before the post-replacement cleanup delete.
              // Two failure classes, deliberately handled differently:
              //   - a REFUSAL (`FINAL_SNAPSHOT_UNSUPPORTED` — cc-api routing
              //     or a type cdkd cannot snapshot) is a CONFIGURATION error
              //     the user must resolve, so it propagates and fails the
              //     resource, matching CloudFormation failing the update.
              //   - a transient snapshot failure / timeout degrades to this
              //     site's existing warn-and-continue policy, but SKIPS the
              //     delete: the old resource stays alive (leaked, warned)
              //     rather than being deleted without its promised snapshot.
              let cleanupFinalSnapshotId: string | undefined;
              let snapshotBlockedDelete = false;
              try {
                cleanupFinalSnapshotId = await this.prepareFinalSnapshotForDelete(
                  logicalId,
                  resourceType,
                  currentResource,
                  updateReplacePolicy
                );
              } catch (snapshotError) {
                if (
                  snapshotError instanceof CdkdError &&
                  snapshotError.code === 'FINAL_SNAPSHOT_UNSUPPORTED'
                ) {
                  throw snapshotError;
                }
                snapshotBlockedDelete = true;
                this.logger.warn(
                  `  ⚠ Final snapshot for old ${logicalId} (${currentResource.physicalId}) ` +
                    `failed: ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}. ` +
                    `The old resource was NOT deleted (UpdateReplacePolicy: Snapshot) — delete it ` +
                    `manually once you have a snapshot; it is no longer tracked in state.`
                );
              }
              if (!snapshotBlockedDelete) {
                // Initialized because the catch below can leave it unassigned.
                let cleanupDeleteResult: void | ResourceDeleteResult = undefined;
                let cleanupDeleteFailed = false;
                try {
                  cleanupDeleteResult = await oldDeleteProvider.delete(
                    logicalId,
                    currentResource.physicalId,
                    resourceType,
                    currentResource.properties,
                    {
                      expectedRegion: this.stackRegion,
                      forceDataDelete: this.options.forceStatefulRecreation === true,
                      ...(cleanupFinalSnapshotId !== undefined && {
                        finalSnapshotIdentifier: cleanupFinalSnapshotId,
                      }),
                    }
                  );
                } catch (deleteError) {
                  this.logger.warn(
                    `  ⚠ Failed to delete old resource ${logicalId} (${currentResource.physicalId}): ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`
                  );
                  cleanupDeleteFailed = true;
                }
                // Issue #1762: this is the ONE replacement site where a skip
                // is a warning rather than a failure, and it takes that from
                // the site's existing policy for a delete FAILURE right above:
                // the new resource is already created and recorded, so the old
                // one is untracked either way — failing the resource here
                // would roll back a replacement that actually succeeded.
                const cleanupSkipReason = deleteSkipReason(cleanupDeleteResult);
                if (cleanupSkipReason !== undefined) {
                  this.logger.warn(
                    `  ⚠ ${deleteSkippedMessage(
                      logicalId,
                      currentResource.physicalId,
                      cleanupSkipReason,
                      'while cleaning up the replaced resource'
                    )}. Delete it manually — it is no longer tracked in state.`
                  );
                } else if (!cleanupDeleteFailed) {
                  this.logger.info(`  ${green('✓')} Old resource deleted`);
                }
              }
            }
          }

          // Issue #2274: the replacement path re-CREATES, so the fresh create
          // result carries its own `NoEcho` declaration and must register it —
          // the create arm's registration is in a different `case` and does not
          // run here.
          this.registerNoEchoAttributes(logicalId, createResult, updateSecrets, resolvedProps);

          stateResources[logicalId] = {
            physicalId: createResult.physicalId,
            resourceType,
            properties: this.propertiesToRecord(resolvedProps, createResult),
            ...(createResult.attributes && { attributes: createResult.attributes }),
            ...(dependencies && dependencies.length > 0 && { dependencies }),
            ...this.extractTemplateAttributes(template, logicalId),
            provisionedBy: replaceDecision.provisionedBy,
          };

          this.kickOffObservedCapture(
            replaceProvider,
            logicalId,
            createResult.physicalId,
            resourceType,
            resolvedProps
          );

          if (counts) counts.updated++;
          if (progress) progress.current++;
          const replacePrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
          renderer.removeTask(logicalId);
          this.logger.info(
            `${replacePrefix}${yellow('↻')} ${bold(logicalId)} ${gray(`(${resourceType})`)} ${yellow('replaced')}`
          );
        } else {
          // Normal update (in-place).
          //
          // For an existing resource, the layer is sticky: if it was first
          // created via Cloud Control (because of silent-drop properties at
          // CREATE time), the update stays on Cloud Control. If it was
          // SDK-managed and the user has since added a silent-drop property,
          // we re-evaluate via `getProviderFor` — which will auto-route
          // through Cloud Control as long as the user hasn't overridden
          // via `--allow-unsupported-properties`. Once a resource flips
          // to CC mid-life, it stays there (the state record's
          // `provisionedBy: 'cc-api'` written below sticks).
          this.logger.debug(`Updating ${logicalId} (${resourceType})`);
          const updateDecision = this.providerRegistry.getProviderFor({
            resourceType,
            properties: resolvedProps,
            provisionedBy: currentResource.provisionedBy,
          });
          const updateProvider = updateDecision.provider;
          const updateProps =
            updateDecision.provisionedBy === 'cc-api'
              ? this.preparePropertiesForCcApi(resourceType, resolvedProps, logicalId)
              : resolvedProps;

          let result;
          let resultProvisionedBy = updateDecision.provisionedBy;
          try {
            result = await this.withRetry(
              () =>
                // The UPDATE twin of the CREATE call's async-local scope (issue
                // #1903). Both paths bind it or a nested stack that already
                // exists silently keeps persisting the parent's plaintext.
                withCurrentResourceSecrets(updateSecrets, () =>
                  updateProvider.update(
                    logicalId,
                    currentResource.physicalId,
                    resourceType,
                    updateProps,
                    currentProps,
                    // The UPDATE twin of the CREATE call's masker (issue #1932
                    // item 3): same resolved bag, same exposure, so the contract
                    // is applied on both or it has a hole in the shape of
                    // whichever path a given deploy takes.
                    //
                    // `expectedRegion` (issue #2301 item 1) is the same value
                    // this file already hands every `DeleteContext` it builds:
                    // the region this stack's state was read under and is
                    // written back to. The update is addressed BY
                    // `currentResource.physicalId`, a state-recorded id, so it
                    // carries the same wrong-region hazard the delete sites do
                    // -- misapplied configuration rather than destruction, but
                    // on a resource cdkd does not manage. Typed `string`, so a
                    // caller with no region hands over `''`; the guard treats
                    // that as absent and proceeds.
                    {
                      maskSecrets: createSecretMasker(updateSecrets),
                      expectedRegion: this.stackRegion,
                    }
                  )
                ),
              logicalId,
              undefined,
              undefined,
              updateProvider
            );
          } catch (updateError) {
            // If UPDATE is not supported, fall back to DELETE → CREATE
            // (replacement). Two triggers:
            //   1. CC API `UnsupportedActionException` / "does not support
            //      UPDATE" — auto-fallback, needs no flag to REACH the
            //      replacement (issue #2514 left that half unchanged; only the
            //      stateful guard below became common to both triggers).
            //   2. An SDK provider throwing a typed
            //      `ResourceUpdateNotSupportedError` (an immutable property
            //      changed on a type with no replacement rule) — gated on the
            //      user opting in via `--replace`, because for some of these
            //      types the replacement is a data-losing DELETE + CREATE.
            const msg = updateError instanceof Error ? updateError.message : String(updateError);
            const ccUnsupported =
              msg.includes('UnsupportedActionException') || msg.includes('does not support UPDATE');
            const typedUnsupported = updateError instanceof ResourceUpdateNotSupportedError;
            const replaceOptIn = typedUnsupported && this.options.replace === true;
            if (ccUnsupported || replaceOptIn) {
              // Stateful guard for BOTH triggers (issue #2514). A stateful
              // type (RDS / DynamoDB / EFS / etc.) must not be silently
              // DELETE+CREATEd — require --force-stateful-recreation.
              //
              // It used to sit inside `if (replaceOptIn)`, so the CC
              // auto-fallback recreated a stateful resource on a plain
              // `cdkd deploy` with neither `--replace` nor
              // `--force-stateful-recreation`, while the SAME type behind an
              // SDK provider was refused twice over. The discriminator was
              // neither the resource nor the user's intent but which
              // provisioning layer the type happened to route through — and
              // routing is re-decided every deploy (`provisionedBy` is
              // recorded, not pinned), so the guard's presence was not
              // something a user could reason about. The delete below is
              // identical on both triggers, so the data-loss consent belongs
              // to the REPLACEMENT, not to the trigger.
              //
              // Conservative variant: this fires mid-deploy with no chance to
              // run the async S3 object-count probe, so a deferred S3 bucket
              // is treated as stateful (block unless forced).
              //
              // `UpdateReplacePolicy: Retain` is deliberately NOT an exemption
              // here, unlike the property-driven replacement guard above: that
              // path creates the replacement FIRST and leaves the old resource
              // in place under `Retain` (nothing is lost), while this fallback
              // deletes the old resource unconditionally a few lines down —
              // whatever the policy says.
              const statefulReason = isStatefulRecreateTargetForReplace(resourceType, currentProps);
              if (statefulReason && this.options.forceStatefulRecreation !== true) {
                // Both arms name the `Retain` trap: this path deletes the old
                // resource unconditionally, so a user who reads the remedy and
                // re-runs with the consent flag loses the data even though the
                // template said `UpdateReplacePolicy: Retain`. The property-
                // driven guard above needs no such clause — Retain exempts it
                // outright there. (The divergence itself is issue #2518.)
                // TEMPLATE ONLY — deliberately no `?? currentResource
                // .updateReplacePolicy` fallback, which is where the snapshot
                // attribute a few lines below DOES fall back to state. The two
                // decisions are not the same shape: omitting a promised
                // snapshot is destructive, so that read is conservative, while
                // this note only describes the attribute the user is applying
                // NOW. Falling back to state would tell someone whose template
                // just dropped `Retain` that a policy they no longer declare
                // fails to protect them.
                //
                // Hence the shared `updateReplacePolicy` binding, read once
                // in this UPDATE branch's own scope: it IS the template-only read,
                // so the property-driven guard's EXEMPTION and this note ask
                // the same question ("what is the user applying now?") of the
                // same value, and a future change to one cannot leave the
                // other on an older spelling. The snapshot read below is the
                // deliberate exception and stays spelled out with its state
                // fallback.
                // Only `'Retain'` is called out: `RetainExceptOnCreate` is a
                // `DeletionPolicy` value CloudFormation rejects for
                // `UpdateReplacePolicy`, so it cannot reach this note.
                const retainNote =
                  updateReplacePolicy === 'Retain'
                    ? ` Note: UpdateReplacePolicy: Retain does NOT protect this path — the ` +
                      `replacement deletes the old resource regardless.`
                    : '';
                // `markNonRetryable` for the same reason as the property-driven
                // guard's twin above: a flag plus a state-recorded bag decide
                // it, and the message carries a template-controlled logical id
                // into substring-matching classifiers.
                throw markNonRetryable(
                  new CdkdError(
                    (replaceOptIn
                      ? `--replace would DELETE + CREATE the stateful resource ${logicalId} ` +
                        `(${resourceType}) — ${renderStatefulReason(statefulReason)}. Re-run with ` +
                        `--force-stateful-recreation to confirm the data loss, or change the ` +
                        `resource definition to avoid the immutable-property change.`
                      : `${logicalId} (${resourceType}) cannot be updated in place by the ` +
                        `provisioning layer it routes through, so applying this change would ` +
                        `DELETE + CREATE it — but it is a stateful resource: ` +
                        `${renderStatefulReason(statefulReason)}. Re-run with ` +
                        `--force-stateful-recreation to confirm the data loss, or change the ` +
                        `resource definition to avoid the update.`) + retainNote,
                    'STATEFUL_REPLACE_BLOCKED',
                    // Chain the rejection that routed us here: the message
                    // above names no layer and no AWS text, so this is the
                    // only place that rejection is retained.
                    //
                    // Where it actually SURFACES is narrower than the terminal
                    // output: `formatError` (`src/utils/error-handler.ts`)
                    // renders exactly ONE `Caused by:` level, and the error the
                    // CLI prints is the `ProvisioningError` this method's catch
                    // wraps the refusal in — so that one level is the refusal's
                    // own message and the raw Cloud Control text stays a hop
                    // below it, unprinted. It DOES reach the persisted
                    // `RESOURCE_FAILED` event: `extractDeploymentEventError`
                    // walks the whole chain for `awsErrorCode` / `requestId`,
                    // so `cdkd events` can name the AWS rejection behind the
                    // refusal (pinned in `tests/unit/types/deployment-events.test.ts`).
                    //
                    // Safe to chain now that the refusal is marked:
                    // `isMarkedNonRetryable` is consulted before any chain-text
                    // classification, and `ccUnsupported` reads only a
                    // top-level message.
                    updateError instanceof Error ? updateError : undefined
                  )
                );
              }
              this.logger.info(
                `UPDATE not supported for ${logicalId} (${resourceType}), replacing (DELETE → CREATE)`
              );
              // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the
              // old resource before the fallback replacement's delete. The
              // TEMPLATE is authoritative here — unlike a destroy, an update
              // necessarily has the resource in the template, and the
              // attribute being applied is the desired one (state records
              // only what the LAST deploy used, so a template that just
              // gained `Snapshot` must not be overridden by a stale
              // `Delete`). State is the fallback for a template that omits
              // the attribute, and this is the ONLY snapshot read on the
              // replacement paths that has one: every other site above passes
              // the shared `updateReplacePolicy` binding, which is template-only.
              // The divergence is deliberate — omitting a promised snapshot is
              // destructive, so this read is conservative, while a `Retain`
              // NOTE only describes what the user is applying now.
              const fallbackFinalSnapshotId = await this.prepareFinalSnapshotForDelete(
                logicalId,
                resourceType,
                currentResource,
                template?.Resources?.[logicalId]?.UpdateReplacePolicy ??
                  currentResource.updateReplacePolicy
              );
              // Initialized because the catch below can leave it unassigned.
              let fallbackDeleteResult: void | ResourceDeleteResult = undefined;
              try {
                fallbackDeleteResult = await updateProvider.delete(
                  logicalId,
                  currentResource.physicalId,
                  resourceType,
                  currentProps,
                  {
                    expectedRegion: this.stackRegion,
                    forceDataDelete: this.options.forceStatefulRecreation === true,
                    ...(fallbackFinalSnapshotId !== undefined && {
                      finalSnapshotIdentifier: fallbackFinalSnapshotId,
                    }),
                  }
                );
              } catch (deleteError) {
                // If old resource doesn't exist (already deleted), proceed with CREATE
                const deleteMsg =
                  deleteError instanceof Error ? deleteError.message : String(deleteError);
                if (
                  deleteMsg.includes('does not exist') ||
                  deleteMsg.includes('not found') ||
                  deleteMsg.includes('NotFound')
                ) {
                  this.logger.debug(
                    `Old resource ${logicalId} already gone, proceeding with CREATE`
                  );
                } else {
                  throw deleteError;
                }
              }
              // Issue #1762: a skip fails the resource here too — the CREATE
              // below re-provisions the resource, so proceeding would leave
              // the old one alive and untracked. Deliberately OUTSIDE the
              // catch: the classifier above reads "already gone" out of an
              // error MESSAGE, and a skip must never be read that way.
              const fallbackSkipReason = deleteSkipReason(fallbackDeleteResult);
              if (fallbackSkipReason !== undefined) {
                throw new Error(
                  deleteSkippedMessage(
                    logicalId,
                    currentResource.physicalId,
                    fallbackSkipReason,
                    'during the UPDATE-not-supported replacement'
                  )
                );
              }
              // The replacement create gets a fresh routing decision.
              const replDecision = this.providerRegistry.getProviderFor({
                resourceType,
                properties: resolvedProps,
              });
              const replProvider = replDecision.provider;
              const replProps =
                replDecision.provisionedBy === 'cc-api'
                  ? this.preparePropertiesForCcApi(resourceType, resolvedProps, logicalId)
                  : resolvedProps;
              const createResult = await this.withRetry(
                () =>
                  withCurrentResourceSecrets(updateSecrets, () =>
                    replProvider.create(logicalId, resourceType, replProps, {
                      maskSecrets: createSecretMasker(updateSecrets),
                    })
                  ),
                logicalId,
                undefined,
                undefined,
                replProvider
              );
              // Annotated rather than inferred: `result` is an evolving `let`,
              // and a conditional spread makes the literal's type a union that
              // TS then checks against the wrong constituent.
              const replacementResult: ResourceUpdateResult = {
                physicalId: createResult.physicalId,
                wasReplaced: true,
                // Spread rather than assigned: under `exactOptionalPropertyTypes`
                // an explicit `undefined` is not assignable to an optional
                // property. Behaviorally identical — the reader below is
                // `result.attributes ?? ...`, which cannot tell absent from
                // undefined.
                ...(createResult.attributes && { attributes: createResult.attributes }),
              };
              // Carried explicitly: this literal REPLACES the update result, so
              // a narrowing the replacement create announced would be dropped
              // on the floor and the desired bag recorded instead — silently
              // re-introducing the phantom drift (#1591).
              if (createResult.effectiveProperties) {
                replacementResult.effectiveProperties = createResult.effectiveProperties;
              }
              result = replacementResult;
              resultProvisionedBy = replDecision.provisionedBy;
            } else {
              throw updateError;
            }
          }

          if (result.wasReplaced) {
            this.logger.info(
              `Resource ${logicalId} was replaced: ${currentResource.physicalId} -> ${result.physicalId}`
            );
          }

          // Attributes: prefer the update result's fresh set; when the
          // provider returned none AND the resource was updated IN PLACE,
          // carry the previously-stored (create-time) attributes forward —
          // an in-place update never invalidates them, and dropping them
          // would degrade every later Fn::GetAtt on this resource to the
          // physical-id fallback (observed live: an FSx update wiped
          // LustreMountName / DNSName and the stack outputs regressed to
          // the file-system id). A REPLACED resource must NOT inherit the
          // old resource's attributes — its create result is authoritative
          // (and absent attributes stay absent).
          const carriedAttributes =
            result.attributes ?? (result.wasReplaced ? undefined : currentResource.attributes);

          // Issue #2274: registered against `carriedAttributes`, not
          // `result.attributes`, because those are the values that land in the
          // record — and the whole point of the needles is to redact what is
          // PERSISTED. The two differ exactly when a provider declared `NoEcho`
          // and returned no fresh attributes, where the carried-forward set is
          // what state keeps.
          this.registerNoEchoAttributes(
            logicalId,
            {
              ...(carriedAttributes && { attributes: carriedAttributes }),
              ...(result.noEchoAttributes === true && { noEchoAttributes: true }),
              ...(result.noEchoAttributeNames && {
                noEchoAttributeNames: result.noEchoAttributeNames,
              }),
            },
            updateSecrets,
            resolvedProps
          );

          stateResources[logicalId] = {
            physicalId: result.physicalId,
            resourceType,
            properties: this.propertiesToRecord(resolvedProps, result),
            ...(carriedAttributes && { attributes: carriedAttributes }),
            ...(dependencies && dependencies.length > 0 && { dependencies }),
            ...this.extractTemplateAttributes(template, logicalId),
            provisionedBy: resultProvisionedBy,
          };

          const updateCaptureSiblings = await this.buildObservedCaptureSiblings(
            resourceType,
            logicalId,
            result.physicalId,
            template,
            stateResources,
            stackName,
            parameterValues,
            conditions
          );
          this.kickOffObservedCapture(
            updateProvider,
            logicalId,
            result.physicalId,
            resourceType,
            resolvedProps,
            updateCaptureSiblings
          );

          // Issue #1819: the provider may have updated the resource and left
          // something behind. The row still counts as an update for ordering
          // and state purposes, but it is not a clean one, so it gets its own
          // counter and its own status line rather than printing `updated`
          // over a survivor the user is never told about.
          const updatePartial = updatePartialReason(result);
          if (counts) {
            if (updatePartial !== undefined) counts.updatePartial++;
            else counts.updated++;
          }
          if (progress) progress.current++;
          const updatePrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
          renderer.removeTask(logicalId);
          if (updatePartial !== undefined) {
            this.logger.warn(
              `${updatePrefix}${formatResourceLine('updated', logicalId, resourceType)} ` +
                updatePartialMessage(updatePartial)
            );
            return { updatePartial };
          }
          this.logger.info(
            `${updatePrefix}${formatResourceLine('updated', logicalId, resourceType)}`
          );
        }
        break;
      }

      case 'DELETE': {
        const currentResource = existingState;
        if (!currentResource) {
          throw new Error(`Cannot delete ${logicalId}: resource not found in state`);
        }

        // Honor `DeletionPolicy: Retain` / `RetainExceptOnCreate`.
        // State is source of truth as of schema v5+ (cdkd records the
        // attribute on every successful create/update). The synth template
        // is consulted as a fallback for pre-v5 state that has no
        // `state.deletionPolicy` recorded yet — once that resource is
        // re-deployed under v5, the state value takes over and stays
        // authoritative even if the user removes the template attribute
        // mid-flight (a destroy mid-PR would otherwise silently downgrade
        // from Retain to Delete on a transient template edit).
        const deletionPolicy =
          currentResource.deletionPolicy ?? template?.Resources?.[logicalId]?.DeletionPolicy;
        if (shouldRetainResource(deletionPolicy)) {
          this.logger.info(
            `Retaining ${logicalId} (${resourceType}) - DeletionPolicy: ${deletionPolicy}`
          );
          delete stateResources[logicalId];
          break;
        }

        // Honor `DeletionPolicy: Snapshot` (issues #1352 / #1353) — see
        // prepareFinalSnapshotForDelete for the mechanism matrix.
        const finalSnapshotIdentifier = await this.prepareFinalSnapshotForDelete(
          logicalId,
          resourceType,
          currentResource,
          deletionPolicy
        );

        // Schema v7+: route DELETE through the layer recorded on state
        // (`provisionedBy: 'cc-api'` → Cloud Control; absent / `'sdk'`
        // → SDK provider — legacy default).
        const deleteProvider = this.providerRegistry.getProviderFor({
          resourceType,
          provisionedBy: currentResource.provisionedBy,
        }).provider;

        this.logger.debug(`Deleting ${logicalId} (${resourceType})`);
        // Issue #1762: what the provider actually DID. `undefined` (the
        // back-compat `void` return) means "deleted"; a `'skipped'` outcome
        // means the resource was NOT deleted and may still be alive.
        let deleteResult: void | ResourceDeleteResult = undefined;
        try {
          deleteResult = await this.withRetry(
            () =>
              deleteProvider.delete(
                logicalId,
                currentResource.physicalId,
                resourceType,
                currentResource.properties,
                {
                  expectedRegion: this.stackRegion,
                  ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
                }
              ),
            logicalId,
            3, // fewer retries for DELETE
            5_000,
            deleteProvider
          );
        } catch (deleteError) {
          const msg = deleteError instanceof Error ? deleteError.message : String(deleteError);
          // Treat "not found" errors as success (resource already deleted) —
          // but never a USER ABORT (issues #2053 / #1952). The match is on the
          // MESSAGE, and an interrupt's message embeds a name the user chose, so
          // a logical id containing `NotFoundException` / `NoSuchEntity` made an
          // interrupted delete read as "already deleted" and dropped a live
          // resource from state. Typed check first: the substring match cannot
          // be made safe, because any needle can appear in a user-chosen name.
          //
          // The same holds for a DELIBERATE cdkd REFUSAL (issue #2301): the
          // Cloud Control pre-flight region check interpolates the LOGICAL ID
          // into its message, so a construct id containing `NotFoundException`
          // would make the refusal read as "already deleted" here and drop a
          // live foreign-region resource from state on the deploy path's
          // template-removal delete. Twin of the guard in
          // `destroy-runner.ts`; see the longer note there for why
          // `isMarkedNonRetryable` is the predicate.
          if (
            !isInterruptedWaitError(deleteError) &&
            !isMarkedNonRetryable(deleteError) &&
            (msg.includes('does not exist') ||
              msg.includes('was not found') ||
              msg.includes('not found') ||
              msg.includes('No policy found') ||
              msg.includes('NoSuchEntity') ||
              msg.includes('NotFoundException') ||
              msg.includes('ResourceNotFoundException'))
          ) {
            this.logger.debug(
              `Resource ${logicalId} already deleted (${msg}), removing from state`
            );
          } else {
            throw deleteError;
          }
        }

        // Issue #1762: handled OUTSIDE the catch above on purpose — a skip is
        // a RETURN VALUE, so it can never be read by that block's
        // already-deleted message classifier, whatever a provider puts in
        // `reason`. Reading a skip as "already deleted" is precisely the
        // mis-accounting this branch used to commit.
        const deleteSkipped = deleteSkipReason(deleteResult);
        if (deleteSkipped !== undefined) {
          if (progress) progress.current++;
          const skipPrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
          renderer.removeTask(logicalId);
          this.logger.info(
            `${skipPrefix}${formatResourceLine(
              'skipped',
              logicalId,
              resourceType,
              `skipped (${deleteSkipped})`
            )}`
          );
          this.logger.warn(
            deleteSkippedMessage(
              logicalId,
              currentResource.physicalId,
              deleteSkipped,
              'while removing it from the template'
            ) +
              `. Its cdkd state record was KEPT, so the next 'cdkd deploy' re-attempts the ` +
              `delete. Repair the record first ('cdkd state show ${stackName}' to inspect; ` +
              `for a nested stack it is the CHILD's own state, whose other resources may ` +
              `already be gone), or delete the resource by hand and drop the record with ` +
              `'cdkd state orphan ${stackName}'.`
          );
          // Deliberately NO `delete stateResources[logicalId]` and NO
          // `counts.deleted++`. Dropping the record is the data-loss half:
          // the user would have neither the AWS resource deleted nor a cdkd
          // record pointing at it. Keeping it also means the resource is
          // still diffed as a DELETE next run, which is why a skip here is a
          // warning rather than a resource failure — unlike `cdkd destroy`,
          // `cdkd deploy` self-heals on the next run.
          if (counts) counts.deleteSkipped++;
          return { deleteSkipped };
        }

        delete stateResources[logicalId];
        if (counts) counts.deleted++;
        if (progress) progress.current++;
        const deletePrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
        renderer.removeTask(logicalId);
        this.logger.info(
          `${deletePrefix}${formatResourceLine('deleted', logicalId, resourceType)}`
        );
        break;
      }
    }
  }

  /**
   * Create a resource with retry for transient errors
   *
   * Some resources fail immediately after their dependencies are created due to
   * AWS eventual consistency (e.g., Lambda fails if IAM Role hasn't propagated yet).
   * CloudFormation handles this internally; cdkd retries with exponential backoff.
   */
  /**
   * Extract ALL dependencies for a resource from the template.
   *
   * Uses TemplateParser.extractDependencies() to capture Ref, Fn::GetAtt,
   * and DependsOn dependencies. This ensures the state contains complete
   * dependency information for correct deletion ordering (not just DependsOn).
   *
   * Template Parameter names are filtered out (issue #1032): a `Ref` to a
   * CFn Parameter is not a provisioning-order edge, and the destroy-side
   * graph build (which reconstructs a pseudo-template from state with no
   * `Parameters` section) would warn `depends on <Param>, but <Param> not
   * found in template` for every parameter-referencing resource.
   */
  private extractAllDependencies(
    template: CloudFormationTemplate | undefined,
    logicalId: string
  ): string[] | undefined {
    const resource = template?.Resources?.[logicalId];
    if (!resource) return undefined;
    const parser = new TemplateParser();
    const parameterNames = new Set(Object.keys(template?.Parameters ?? {}));
    const deps = [...parser.extractDependencies(resource)].filter(
      (dep) => !parameterNames.has(dep)
    );
    return deps.length > 0 ? deps : undefined;
  }

  /**
   * The properties to RECORD in cdkd state for a just-provisioned resource.
   *
   * Normally the DESIRED (resolved) bag: state is the record of what the user
   * asked for, and the #1160 absent-field removal derivation reads it as the
   * previous side on the next deploy, so it must stay template-shaped.
   *
   * A provider may override it by returning `effectiveProperties` when it
   * deliberately NARROWED what it sent (issue #1591). Recording the desired
   * bag there would describe something AWS does not hold, and since
   * `readCurrentState` can only return what AWS does hold, the difference is
   * PERMANENT phantom drift — reported by every `cdkd drift`, and "repaired"
   * by `drift --revert` into another `update()` that narrows and re-reports.
   * The provider is the only layer that knows what it dropped, so it says so
   * and the engine records that instead.
   */
  private propertiesToRecord(
    desiredProperties: Record<string, unknown>,
    result: EffectivePropertiesResult
  ): Record<string, unknown> {
    return result.effectiveProperties ?? desiredProperties;
  }

  /**
   * The name-origin half of the replacement-collision messages (issue #1636).
   *
   * Every one of those refusals used to assert that the colliding resource
   * "has a user-supplied physical name" and prescribe "rename the resource in
   * your CDK code". For a resource the template never named BOTH halves are
   * wrong: `generateResourceName` produces `{stackName}-{logicalId}` with no
   * random component, so the collision is caused by cdkd's OWN naming scheme,
   * and "rename" there means renaming the CONSTRUCT — a materially different
   * and more disruptive action. The false half is the part the user is asked
   * to act on, and a reader who finds no such name in their template cannot
   * connect the message to their code at all.
   *
   * `descriptor` names WHERE the name came from; `remedy` is the accurate
   * first option. Both callers append the shared `--replace` alternative,
   * which is identical in either case.
   *
   * Classification is best-effort by construction (see
   * {@link looksLikeCdkdGeneratedName}) and falls back to the pre-#1636
   * wording, which stays correct for the template-named resource.
   */
  private replacementNameOrigin(
    logicalId: string,
    physicalId: string
  ): { descriptor: string; remedy: string } {
    if (looksLikeCdkdGeneratedName(physicalId, logicalId, getCurrentStackName())) {
      return {
        descriptor:
          `The physical name (${physicalId}) was GENERATED by cdkd from the construct's ` +
          `logical id rather than declared in your template, and that derivation has no ` +
          `random component — so the new resource asks for exactly the name the existing ` +
          `one still holds`,
        remedy:
          `Either give the resource an explicit physical name in your CDK code, or rename ` +
          `the CONSTRUCT (its id feeds the generated name — note that this replaces the ` +
          `resource rather than renaming it in place)`,
      };
    }
    return {
      descriptor: `The resource has a user-supplied physical name (${physicalId})`,
      remedy:
        `Either rename the resource in your CDK code (a fresh name lets the safe ` +
        `create-first order proceed)`,
    };
  }

  /**
   * Read `DeletionPolicy` / `UpdateReplacePolicy` from the synth template
   * so they can be persisted in `ResourceState` (schema v5+). Always returns
   * both keys (`undefined` when the template does not carry the attribute)
   * so that spreading into an existing `ResourceState` reliably overrides a
   * previously-recorded value back to `undefined` — required when the user
   * removes the attribute from their CDK code. `JSON.stringify` then omits
   * the `undefined` keys when state is serialized to S3.
   */
  private extractTemplateAttributes(
    template: CloudFormationTemplate | undefined,
    logicalId: string
  ): {
    deletionPolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
    updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
  } {
    const resource = template?.Resources?.[logicalId];
    return {
      deletionPolicy: resource?.DeletionPolicy,
      updateReplacePolicy: resource?.UpdateReplacePolicy,
    };
  }

  // Type-based implicit deletion ordering rules are defined in
  // src/analyzer/implicit-delete-deps.ts so the deploy DELETE phase and the
  // standalone destroy command apply the same rules.

  /**
   * Build a per-resource map of "must be deleted before me" dependencies for
   * the DELETE phase, derived from state-recorded dependencies plus implicit
   * type-based ordering rules.
   *
   * For a resource X, the returned set contains every resource Y such that Y
   * must finish deleting before X starts — i.e., Y depends on X (or is otherwise
   * required to vanish first per implicit type rules).
   */
  /**
   * Returns true if the executor still has un-started pending nodes —
   * used to distinguish "SIGINT cancelled real work" from "SIGINT landed
   * after all nodes already completed" (the latter should not error).
   */
  private hasPending<T>(executor: DagExecutor<T>): boolean {
    for (const node of executor.values()) {
      if (node.state === 'pending') return true;
    }
    return false;
  }

  private buildDeletionDependencies(
    deleteIds: Set<string>,
    state: StackState
  ): Map<string, Set<string>> {
    const dependedBy = new Map<string, Set<string>>();
    for (const id of deleteIds) {
      dependedBy.set(id, new Set());
    }

    for (const id of deleteIds) {
      const resource = state.resources[id];
      if (!resource?.dependencies) continue;
      for (const dep of resource.dependencies) {
        if (!deleteIds.has(dep)) continue;
        // id depends on dep → dep must be deleted AFTER id (i.e., id is in dep's deletion deps)
        dependedBy.get(dep)!.add(id);
      }
    }

    this.addImplicitDeleteDependencies(deleteIds, state, dependedBy);

    return dependedBy;
  }

  /**
   * Add implicit delete dependency edges based on resource type relationships.
   *
   * Some AWS resources have ordering constraints during deletion that are NOT
   * expressed via Ref/GetAtt in CloudFormation templates. For example, an
   * InternetGateway cannot be deleted until its VPCGatewayAttachment is removed,
   * even though the attachment references the IGW (not the other way around).
   *
   * This method inspects resource types and adds edges so that dependents
   * (e.g., VPCGatewayAttachment) are deleted BEFORE the resources they implicitly
   * depend on (e.g., InternetGateway).
   */
  private addImplicitDeleteDependencies(
    deleteIds: Set<string>,
    state: StackState,
    dependedBy: Map<string, Set<string>>
  ): void {
    // Build a type → logical IDs index for resources being deleted
    const typeToIds = new Map<string, string[]>();
    for (const id of deleteIds) {
      const resource = state.resources[id];
      if (!resource) continue;
      const ids = typeToIds.get(resource.resourceType) ?? [];
      ids.push(id);
      typeToIds.set(resource.resourceType, ids);
    }

    for (const id of deleteIds) {
      const resource = state.resources[id];
      if (!resource) continue;

      const mustDeleteAfter = IMPLICIT_DELETE_DEPENDENCIES[resource.resourceType];
      if (!mustDeleteAfter) continue;

      for (const depType of mustDeleteAfter) {
        const depIds = typeToIds.get(depType);
        if (!depIds) continue;

        for (const depId of depIds) {
          // depId (of depType) must be deleted BEFORE id (of resource.resourceType)
          // In the dependedBy map: id is "depended on" by depId
          // meaning depId will be picked first (deleted first)
          if (!dependedBy.has(id)) dependedBy.set(id, new Set());
          if (!dependedBy.get(id)!.has(depId)) {
            dependedBy.get(id)!.add(depId);
            this.logger.debug(
              `Implicit delete dependency: ${depId} (${depType}) must be deleted before ${id} (${resource.resourceType})`
            );
          }
        }
      }
    }

    // Per-resource implicit delete edges that cannot be inferred from a
    // type-pair rule (e.g. CompositeAlarm -> the metric alarms its AlarmRule
    // references by name, which carry no Ref / Fn::GetAtt edge).
    const scoped: Record<string, ResourceState> = {};
    for (const id of deleteIds) {
      const resource = state.resources[id];
      if (resource) scoped[id] = resource;
    }
    for (const { before, after } of computeImplicitDeleteEdges(scoped)) {
      // `before` must be deleted before `after`, so `before` is in `after`'s
      // deletion deps (picked / deleted first).
      if (!dependedBy.has(after)) dependedBy.set(after, new Set());
      if (!dependedBy.get(after)!.has(before)) {
        dependedBy.get(after)!.add(before);
        this.logger.debug(
          `Implicit delete dependency: ${before} (${scoped[before]?.resourceType}) must be deleted before ${after} (${scoped[after]?.resourceType})`
        );
      }
    }
  }

  /**
   * Prepare a property map for a Cloud Control API call. When a Tier 1
   * resource is routed via Cloud Control (either because the user's
   * template hit silent-drop properties under #614 or because the resource
   * is sticky-routed via `provisionedBy: 'cc-api'`), CC requires the full
   * property map — including identifier-like fields (`BucketName`,
   * `RoleName`, etc.) that the SDK provider would have auto-generated.
   * This helper threads the property prep through the registered SDK
   * provider's `preparePropertiesForFallback` hook when defined, falling
   * back to `applyDefaultNameForFallback` (which mints stack-prefixed
   * names matching what the SDK provider would have done) otherwise.
   *
   * No-ops for types with no registered SDK provider (Tier 2 / CC-native).
   */
  private preparePropertiesForCcApi(
    resourceType: string,
    resolvedProps: Record<string, unknown>,
    logicalId: string
  ): Record<string, unknown> {
    const sdkProvider = this.providerRegistry.getRegisteredTypes().includes(resourceType)
      ? this.providerRegistry.getProvider(resourceType)
      : undefined;
    if (sdkProvider?.preparePropertiesForFallback) {
      return sdkProvider.preparePropertiesForFallback(logicalId, resourceType, resolvedProps);
    }
    return applyDefaultNameForFallback(logicalId, resourceType, resolvedProps);
  }

  /**
   * Execute an operation with retry for transient IAM propagation errors.
   *
   * Thin wrapper over `withRetry` from ./retry.js that injects this engine's
   * SIGINT-aware interrupt check and logger. The actual backoff schedule
   * lives there.
   *
   * When the provider opts out via `disableOuterRetry`, the operation is
   * invoked exactly once and the retry loop is skipped entirely. The
   * Custom Resource provider uses this to avoid re-running its `create()`
   * — each invocation derives a fresh pre-signed S3 URL and RequestId,
   * so an outer retry leaves the previous attempt's Lambda response
   * stranded at an S3 key nobody polls.
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    logicalId: string,
    maxRetries?: number,
    initialDelayMs?: number,
    provider?: ResourceProvider
  ): Promise<T> {
    if (provider?.disableOuterRetry) {
      // Single-shot — provider handles transient errors internally.
      return operation();
    }
    return withRetry(operation, logicalId, {
      ...(maxRetries !== undefined && { maxRetries }),
      ...(initialDelayMs !== undefined && { initialDelayMs }),
      logger: this.maskingRetryLogger(logicalId),
      isInterrupted: () => this.interrupted,
      onInterrupted: () => new InterruptedError(this.interruptCause ?? 'user'),
    });
  }

  /**
   * Mask one line of engine-authored text with a resource's OWN recorded
   * secrets (issue [#2038](https://github.com/go-to-k/cdkd/issues/2038)).
   *
   * Per-resource, never session-wide — see the `perResourceSecrets` field doc
   * for why one resource's secret must not rewrite another's literal. A
   * `logicalId` with no entry (or an empty bag) forwards verbatim, so every
   * non-secret resource is byte-identical to before.
   */
  private maskForResource(logicalId: string, text: string): string {
    return maskSecretsInText(text, this.perResourceSecrets.get(logicalId) ?? EMPTY_SECRETS);
  }

  /**
   * The LAZY `RetryLogger` the engine's generic `withRetry` wrapper threads
   * (issue [#2038](https://github.com/go-to-k/cdkd/issues/2038) acceptance
   * item 1) — the same masking shape `drift.ts` and `rollback-executor.ts`
   * install, bound to the resource's OWN recorded secrets.
   *
   * `retry.ts` interpolates the AWS message verbatim into both the per-attempt
   * `debug` line and the give-up `warn` summary, and the bag this engine hands
   * a provider is RESOLVED — `perResourceSecrets` is populated immediately after
   * `resolver.resolve` and BEFORE the create / update call, so a secret is in
   * scope at every retried provider call. An AWS validation error routinely
   * quotes the offending value back, so the give-up summary could print it at
   * DEFAULT verbosity: the same hole #2038 found on the rollback path, one
   * caller over.
   *
   * The bag is resolved PER LINE rather than captured, because `withRetry`
   * (the private wrapper below) is reached from call sites that hold no bag —
   * DELETE, the observed-capture drain, the Outputs pass — and a
   * `logicalId`-keyed read is the only thing available there. The two
   * `--replace` sites do hold their caller's bag and use
   * {@link maskingRetryLoggerFor} instead; see the note on
   * {@link replaceDeleteFirstAndRecreate}'s `secrets` parameter for why binding
   * the bag beats looking it up whenever the bag is in scope.
   *
   * Do NOT restate that the engine "already masked its own error text" — an
   * earlier revision of this comment did, and it was FALSE: `provisionResource`
   * logged the raw AWS message at `error` level (a HIGHER level than this
   * summary) until #2038's review round. Only the EVENT store was masked.
   */
  private maskingRetryLogger(logicalId: string): RetryLogger {
    return {
      debug: (msg) => this.logger.debug(this.maskForResource(logicalId, msg)),
      warn: (msg) => this.logger.warn(this.maskForResource(logicalId, msg)),
    };
  }

  /**
   * The EAGER `RetryLogger`, bound to the bag the caller actually resolved
   * with (issue [#2038](https://github.com/go-to-k/cdkd/issues/2038)).
   *
   * Preferred over {@link maskingRetryLogger} wherever the resolution pass's
   * own `RecordedSecretValues` is in scope, for the reason
   * {@link replaceDeleteFirstAndRecreate}'s parameter list already states about
   * the masker it threads: a map looked up by logical id is a DIFFERENT thing
   * from the bag this call resolved with, and one file must not argue both
   * sides. It delegates to the shared `masking-retry-logger.ts` so the deploy
   * engine, `rollback-executor.ts` and `drift.ts` cannot drift apart.
   */
  private maskingRetryLoggerFor(secrets: RecordedSecretValues): RetryLogger {
    return maskingRetryLogger(this.logger, secrets);
  }

  /**
   * What a failed Output resolution does, shared by both passes of
   * {@link resolveOutputs} so they cannot drift — the alias pass reports the
   * SAME failure for a name it could not resolve as the value pass does for a
   * value, which is what the single-pass shape did when both lived in one
   * `try`.
   *
   * Issue #1111 item 2: under `--strict-getatt` an unresolvable Output fails
   * the deploy instead of silently publishing nothing (which breaks downstream
   * `Fn::ImportValue` consumers with "export not found" long after this deploy
   * exits 0).
   */
  private handleOutputResolutionFailure(
    error: unknown,
    outputKey: string,
    outputs: Record<string, unknown>
  ): void {
    if (this.options.strictGetAtt) {
      // `cause` is load-bearing, not decoration (issue #1874 review). The
      // non-retryable marker is a NON-ENUMERABLE symbol on the original error,
      // so re-wrapping without a cause DROPS it — while inlining the refusal's
      // full text, which for a resolver refusal includes template-controlled
      // identifiers. A logical id like `MyDependencyViolationHandler` then puts
      // `DependencyViolation` (a whitespace-free entry in the substring
      // table — the only one until issue #2116 added the name-cooldown error
      // codes) into this message, and the classifier reads it as transient.
      // That is reachable: this throw leaves `executeDeployment`, leaves the
      // child `deploy()`, passes through `NestedStackProvider.create`, and
      // lands in the PARENT's `withRetry` — so a nested stack would re-run a
      // whole child deploy plus rollback per retry on a path that can never
      // succeed. `isMarkedNonRetryable` walks the `.cause` chain, so threading
      // the cause preserves the marker.
      throw new Error(
        `Failed to resolve output ${outputKey}: ${error instanceof Error ? error.message : String(error)} ` +
          `(--strict-getatt promotes output resolution failures to deploy errors; ` +
          `drop the flag to warn and skip the output instead)`,
        { cause: error }
      );
    }
    this.logger.warn(`Failed to resolve output ${outputKey}: ${String(error)}`);
    outputs[outputKey] = undefined;
  }

  /**
   * Resolve stack outputs from template and resource attributes.
   *
   * Uses `IntrinsicFunctionResolver` for full CloudFormation intrinsic function
   * support, and runs in TWO passes — every value, then every export alias —
   * so an alias decision sees the complete set of secrets this pass resolved
   * rather than whatever the declaration order happened to have recorded by
   * then (issue #1919).
   */
  private async resolveOutputs(
    template: CloudFormationTemplate,
    resources: Record<string, ResourceState>,
    stackName: string,
    parameterValues?: Record<string, unknown>,
    conditions?: Record<string, boolean>
  ): Promise<Record<string, unknown>> {
    // Reset BEFORE the early return: a template with no Outputs exports
    // nothing, and that is a known `[]`, not a stale set from a prior pass.
    this.resolvedExportNames = [];
    if (!template.Outputs) {
      return {};
    }

    const outputs: Record<string, unknown> = {};
    const context = this.buildResolverContext(
      {
        template,
        resources,
        ...(parameterValues && { parameters: parameterValues }),
        ...(conditions && { conditions }),
      },
      stackName
    );

    // The names this deploy PUBLISHES. Owns keys in both this bag and the
    // position-source bag below, and is the set an export alias must not land
    // on (issue #1919).
    const publishedOutputNames = collectPublishedOutputNames(template.Outputs, conditions);

    let outputsPassCompleted = false;
    try {
      // TWO passes, and the split is the fix for an ORDER dependence rather
      // than tidiness (issue #1919 round-6 review). The alias decision consults
      // the secrets this pass has recorded so far; deciding inside the value
      // loop meant an output declared BEFORE the secret-bearing one was judged
      // against an empty map, so the SAME template published a plaintext state
      // KEY or refused it depending on declaration order — the very
      // order-dependence class this issue's addendum flagged for the original
      // defect. Values first, aliases second: every alias then sees the
      // complete map, and the split costs no extra AWS calls because the loop
      // already resolved every value.

      // PASS 1 — values.
      for (const [outputKey, output] of Object.entries(template.Outputs)) {
        // CFn semantics: an output whose `Condition` evaluates false is simply
        // not created — skip it silently instead of attempting resolution
        // (which would warn on a Ref to a condition-pruned resource and could
        // even publish an output/export CFn would omit). Mirrors the resource
        // side's `filterResourcesByCondition` (issue #1028; unknown condition
        // names are kept, matching that helper's semantics).
        if (isOutputSuppressedByCondition(output, conditions)) {
          this.logger.debug(
            `Skipping output ${outputKey} — condition ${output.Condition} is false`
          );
          continue;
        }
        try {
          outputs[outputKey] = await this.resolver.resolve(output.Value, context);
        } catch (error) {
          this.handleOutputResolutionFailure(error, outputKey, outputs);
        }
      }

      // PASS 2 — export aliases, decided against the COMPLETE secrets map.
      for (const [outputKey, output] of Object.entries(template.Outputs)) {
        if (isOutputSuppressedByCondition(output, conditions)) continue;
        if (!output.Export?.Name) continue;
        const value = outputs[outputKey];
        // An output whose value did not resolve publishes nothing, so it
        // publishes no alias either — matching the single-pass shape, where the
        // failure jumped past the alias block.
        if (value === undefined) continue;

        // Resolved with its OWN `recordedSecretValues` map, not the pass's:
        // `Fn::Sub` / `Fn::Join` substitute dynamic references, so the map
        // tells us EXACTLY whether a secret went into THIS name — no length
        // threshold, and no coincidental match against a sibling's secret.
        //
        // The isolation is for the DECISION only, and the RECORDING side
        // effect is merged back below — do not re-isolate it. Every plaintext
        // this resolution records must stay a needle of the PASS map: for the
        // exposure refusal masked right below, and for every later consumer
        // that never resolves the reference itself (a value re-using the
        // same token records its own entry; one that does not, does not). An
        // earlier version of this comment grounded the merge on the cache-hit
        // arm re-recording "only what it can still prove is secret" for an
        // unpinned `ssm` reference (issue #1901); since issue #1933 the cache
        // carries the verdict beside the value, so a hit re-records a cached
        // secret, and an unclassifiable-`Type` reference is never cached at
        // all (`cacheable = false`) — it re-asks AWS and records again. The
        // merge keeps this resolution's entries either way.
        const nameSecrets: RecordedSecretValues = new Map();
        let exportName: unknown;
        try {
          try {
            exportName =
              typeof output.Export.Name === 'string'
                ? output.Export.Name
                : await this.resolver.resolve(output.Export.Name, {
                    ...context,
                    recordedSecretValues: nameSecrets,
                  });
          } finally {
            // Merge what the name's resolution learned back into the PASS map.
            //
            // `finally`, and that is the load-bearing part rather than a style
            // choice: the resolver records and caches AS IT GOES, so a
            // resolution that records one element and then throws on the next
            // (an `Fn::Join` whose `Promise.all` has a sibling reject) has
            // already put a plaintext in this map that a success-path merge
            // would drop — and that plaintext must be a needle for the
            // failure's own message and for the rest of the pass. (Not, as an
            // earlier version said, because a later cache hit "records
            // nothing": see the note above the map.) Any exit that skips this merge
            // — `throw` here, `continue`, a discarded local — reopens that hole,
            // so the invariant is: this recording survives EVERY exit from this
            // block. Unconditional for the same reason: a name that resolved to
            // a non-string warmed the cache just the same.

            for (const [plaintext, expression] of nameSecrets) {
              context.recordedSecretValues?.set(plaintext, expression);
            }
            // The ENTRIES only — not the resolved pairs beside them (issue
            // #2485). A name never positions a leaf, and a value re-using the
            // same token already recorded its own pair at the seam, so the
            // merge could add nothing; what it COULD do is mark a pair
            // conflicting — an `ssm` reference whose `Type` came back
            // unclassifiable is never cached (the resolver's `cacheable =
            // false`), so a name resolving it re-asks AWS and can see a value
            // that moved since the value pass — and destroy the positioning
            // the value pass had earned. The outputs-bag merge
            // below is the one that carries evidence, because that bag
            // positions.
          }
        } catch (error) {
          this.handleOutputResolutionFailure(error, outputKey, outputs);
          continue;
        }
        if (typeof exportName !== 'string') continue;

        // TWO refusals guard this alias, and both are about the same thing:
        // this bag's KEYS (issue #1919).
        //
        // 1. SECRET-BEARING NAME. `Export.Name` may be an intrinsic, and
        //    `Fn::Sub` / `Fn::Join` substitute dynamic references — so the
        //    resolved name can contain secret PLAINTEXT. It would become a
        //    key in `state.json` and in the exports index, and every
        //    redaction pass walks VALUES only, so nothing downstream would
        //    ever scrub it. Refuse rather than publish. Detected from the
        //    name's OWN resolution map (above), so the answer is exact
        //    rather than a containment guess; the warning masks every
        //    occurrence and omits the name outright if it cannot, since
        //    stderr is a reader too.
        //
        // 2. COLLISION with a published output NAME. Two writers key this
        //    one bag: this alias, and the post-loop pass below that writes
        //    the redaction POSITION source for every published output NAME.
        //    On a collision they disagree — the alias puts THIS output's
        //    resolved value under key `A` while the post-loop pass puts
        //    output `A`'s UNRESOLVED value there — and `redactByPath`'s
        //    expression arm then returns the source leaf verbatim,
        //    persisting A's `{{resolve:...}}` expression as THIS output's
        //    value into state and the exports index. That is the
        //    wrong-reference class issue #1910 exists to remove, one layer
        //    up. It WAS order-dependent — the corruption needed the exporting
        //    output iterated AFTER the colliding-name output, or the latter's
        //    own write reclaimed the key and only the alias was lost — and the
        //    value/alias pass split has made it UNCONDITIONAL: every alias now
        //    runs after every value write, so without this guard the alias
        //    always wins the key while the post-loop pass always writes the
        //    owner's source. The test file still pins both declaration orders,
        //    which now assert the same thing rather than two different ones.
        //
        //    Of the issue's two directions this takes SKIP-AND-WARN rather
        //    than re-keying the source pass by the alias rule. Matching the
        //    source pass to the alias's write order would keep the two bags
        //    consistent, but it would leave `outputs[A]` holding a DIFFERENT
        //    output's value — order-dependently — which is corruption of the
        //    output named `A` even once its expression is right. Skipping
        //    instead partitions the key space by construction: published
        //    output NAMES belong to the post-loop pass, export aliases to
        //    this one, and no key is in both.
        //
        //    This IS a behavior change with a consumer-visible edge, stated
        //    plainly because the warning fires on the PRODUCER's deploy
        //    while the effect lands on the CONSUMER's: where the alias
        //    previously won the key, an `Fn::ImportValue` on that name now
        //    resolves to the colliding output's value instead. CFn would
        //    publish both (its export namespace is separate from its output
        //    names), so this is a deliberate parity divergence — cdkd's
        //    exports index is derived from the outputs bag and cannot hold
        //    two values under one key. Fail-closed and warned beats a
        //    silently wrong reference.
        //
        // The collision set is the PUBLISHED names, not the declared ones.
        // A condition-suppressed output writes neither a value nor a source
        // (see the post-loop pass), so its name is free — reserving it would
        // drop a working export because an unrelated condition went false.
        const exposure = exportNameSecretExposure(
          exportName,
          nameSecrets,
          context.recordedSecretValues
        );
        if (exposure) {
          this.logger.warn(secretBearingExportNameWarning(outputKey, exportName, exposure));
        } else if (isExportAliasCollision(exportName, outputKey, publishedOutputNames)) {
          this.logger.warn(exportAliasCollisionWarning(outputKey, exportName));
        } else {
          outputs[exportName] = value;
          // A SET: two outputs declaring one Export.Name (which CloudFormation
          // rejects) alias the same key twice, and the second write wins the
          // value; the name must not be persisted twice.
          if (!this.resolvedExportNames.includes(exportName)) {
            this.resolvedExportNames.push(exportName);
          }
          // The alias is a SECOND key holding the same value, so it needs the
          // same POSITION source or it falls to the value scan and collapses
          // onto a sibling's expression (issue #1910 review). This bag feeds
          // `updateForStack`, so a collapsed alias hands a downstream
          // `Fn::ImportValue` consumer the WRONG reference.
          this.outputsTemplateSource[exportName] = output.Value;
        }
      }
      outputsPassCompleted = true;
    } finally {
      // Accumulate the secrets resolved while producing outputs so the outputs
      // redaction (GHSA fix) uses only outputs-substituted references — a
      // literal output equal to a secret is not recorded here and is not
      // touched.
      //
      // `finally` for the same reason as the export-name merge above:
      // `--strict-getatt` RETHROWS out of the loop, and everything this pass
      // recorded before that point would otherwise be dropped while the
      // resolver's module-global cache stays warm. Same invariant, other exit.
      //
      // An earlier revision called this DEFENSIVE and unobservable. That was
      // WRONG, and how it was wrong is the point: the throw path DOES reach
      // `redactOutputs`, through `persistStateAfterOutputFailure` ->
      // `withParentInfo` -> `redactStateForPersist`, which redacts
      // `currentState.outputs` — the PREVIOUS deploy's bag. Accumulating here is
      // what lets that bag's plaintext be redacted at all, so the merge is
      // load-bearing on exactly the path it was claimed not to reach.
      if (context.recordedSecretValues) {
        for (const [value, expr] of context.recordedSecretValues) {
          this.outputSecrets.set(value, expr);
        }
        // ...and the uncollapsed evidence beside the entries (issue #2485):
        // without it a literal Output embedding one of two same-plaintext
        // references would lose its span positioning and persist the sibling's
        // expression.
        mergeResolvedPairs(context.recordedSecretValues, this.outputSecrets);
      }
      // ...and the POSITION source must GO, for the same reason it now matters.
      // The post-loop pass below never ran, so this bag holds only the alias
      // keys written before the throw: a PARTIAL source, built from THIS
      // template, about to position the PREVIOUS deploy's bag. That is the
      // bag/source provenance mismatch `secret-redaction` calls unsound —
      // `redactByPath` returns a known-secret source leaf VERBATIM, so a
      // coinciding key persists an expression that need not name the value it
      // replaced. Dropping it degrades those keys to the value scan, which reads
      // what is actually stored. Same call the scrub twin makes through
      // `outputsSourceUntrusted`, for the same reason.
      if (!outputsPassCompleted) this.outputsSourceUsable = false;
    }
    // ...and the UNRESOLVED values beside them, as the POSITION source (#1910).
    // Keyed by output NAME so the walk lines up with the resolved `outputs` bag
    // this method returns.
    //
    // PUBLISHED names only. A condition-suppressed output contributed no value
    // above, so a source under its name can never position anything — it can
    // only CLOBBER an export alias that legitimately took the free name, which
    // is the #1919 corruption arriving from the other side. Restricting the
    // pass is what lets the alias guard key on the published set and keep such
    // an export working.
    //
    // An earlier revision of this comment claimed the writes had to accumulate
    // because `resolveOutputs` runs more than once per deploy. That is wrong,
    // and it was load-bearing for the wrong decision, so it is corrected rather
    // than deleted: there are exactly two call sites (the no-change branch and
    // the post-provisioning one) and they are MUTUALLY EXCLUSIVE — the
    // no-change branch returns before `executeDeployment` — while `deploy()`
    // resets this bag. So at most one call runs per deploy, and skipping a
    // suppressed output here cannot drop a source some other pass wrote.
    // `tests/unit/deployment/deploy-engine-outputs-export-name-collision.test.ts`
    // pins that single-call property, since this decision now rests on it.
    for (const [outputKey, output] of Object.entries(template.Outputs)) {
      if (!publishedOutputNames.has(outputKey)) continue;
      this.outputsTemplateSource[outputKey] = output.Value;
    }

    return outputs;
  }

  private buildDisplayOutputs(
    template: CloudFormationTemplate,
    resolvedOutputs: Record<string, unknown>
  ): Record<string, unknown> {
    const display: Record<string, unknown> = {};
    if (!template.Outputs) return display;
    for (const key of Object.keys(template.Outputs)) {
      const v = resolvedOutputs[key];
      if (v !== undefined) display[key] = v;
    }
    return display;
  }
}
