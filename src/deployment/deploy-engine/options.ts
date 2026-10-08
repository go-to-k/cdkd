import type { AssetRedirectMap } from '../../assets/asset-redirect.js';
import type { PreDeleteSnapshotClients } from '../../provisioning/final-snapshot.js';
import type { DeploymentEventRecorder } from '../../types/deployment-events.js';
import type { StackState } from '../../types/state.js';
import type { DestructiveChange } from '../../analyzer/destructive-changes.js';
import type { ForeignHolding } from '../rollback-executor/journaled-orphans.js';
import type { RecordedSecretValues } from '../secret-redaction.js';
import type { ProducerRegionEvidence } from '../producer-regions-scope.js';
import type { LockRecoveryContext } from '../../state/lock-contention-message.js';

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
   * The run's `--profile`, resolved state bucket and `--state-prefix`, which
   * the malformed-record refusals at the state load (and the unaddressable
   * UPDATE refusal) print on their `cdkd state show` / `cdkd state list`
   * pointers, so a pasted command reads the bucket this deploy read
   * (go-to-k/cdkd#4159). Account values, not stack identifiers, so a nested
   * child engine inheriting it through the option spread is correct.
   */
  refusalRecovery?: LockRecoveryContext;
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
   * How the parent classified each value it passes this child, for the
   * child's masked-property input fingerprints (go-to-k/cdkd#4543): `clean`
   * when the parent's expression for it reads only known non-secret inputs,
   * `unknown` when it could not be read (nothing reading it is compared).
   * A parameter missing here, or an absent map, is treated as possibly
   * secret-derived. Set by `NestedStackProvider` from the parent's bag.
   */
  passedParameterClasses?: ReadonlyMap<string, 'clean' | 'secret' | 'unknown'>;

  /**
   * The child parameters the parent's row fills from a `NoEcho` source
   * (go-to-k/cdkd#4043, review round 9/10): positioned as `NoEcho` parameters
   * in this child. Set by `NestedStackProvider` from the parent's bag whatever
   * else that bag holds (a value under the needle floor leaves it otherwise
   * empty); always overwritten there, so a grandchild never inherits it.
   */
  passedNoEchoParameters?: ReadonlySet<string> | undefined;

  /**
   * The PARENT engine's producer-region evidence, set by `NestedStackProvider`
   * on the child engine it builds (go-to-k/cdkd#4174). A child receives a
   * parent's cross-region value only as a Parameter and records the parent's
   * region-less `{{resolve:...}}` spelling, which its own reads do not
   * explain; this child's in-process rollback unions these regions with its
   * own. Read only when {@link parentStackInfo} is set, where absent (or
   * incomplete) evidence makes that rollback refuse every region-less secret
   * reference.
   */
  inheritedProducerRegions?: (() => ProducerRegionEvidence) | undefined;

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
   * Issues [#615] / [#651] — user-named resources to destroy + recreate this
   * deploy, plumbed through `--recreate-via-cc-api <LogicalId>` /
   * `--recreate-via-sdk-provider <LogicalId>` (both repeatable), TOGETHER WITH
   * the stack name the pre-flight validated them against.
   *
   * Behavior at each provisionResource site:
   *   - CREATE → the flag is not read at all. The pre-flight refuses an id
   *     absent from cdkd state (`missingFromState`), so a CREATE here means a
   *     state race between the pre-lock probe and the post-lock read; recreate
   *     is N/A for a resource that does not yet exist, and the CREATE proceeds
   *     normally. (An earlier revision of this comment promised a warning on
   *     that path. There has never been one.)
   *   - UPDATE → force the replacement code path, route the new resource via
   *     the named direction's layer (`viaCcApi`: Cloud Control regardless of
   *     whether the template has a silent-drop property, stamping
   *     `provisionedBy: 'cc-api'`; `viaSdkProvider`: cdkd's SDK provider,
   *     stamping `provisionedBy: 'sdk'`, used to migrate a CC-sticky resource
   *     back after a #609 backfill release adds coverage). The OLD resource's
   *     destroy uses its state-recorded `provisionedBy` so the destroy hits
   *     the right provider. Destroy-then-create ordering in both directions —
   *     the old physical id usually reuses its user-supplied name, so a
   *     create-first would collide.
   *   - DELETE → ignore the flag (the resource is being destroyed
   *     anyway).
   *
   * `stackName` is NOT decoration and NOT redundant with the engine's own
   * stack (issue [#2567]). The ids are validated ONCE, in `deploy.ts`, against
   * the TOP-LEVEL stack's template + state + live emptiness probes — and this
   * whole option object is then spread into every NESTED child engine by
   * `NestedStackProvider.runChildDeploy`. A bare id set therefore matched the
   * CHILD's logical ids too, and since `recreateFlagged` is exactly what SKIPS
   * the mid-deploy stateful guard below, a child resource that merely SHARED a
   * logical id with a validated parent one (same construct id, or an
   * `overrideLogicalId`) could be DELETE + CREATEd with neither the pre-flight
   * nor the guard having looked at it. Carrying the validated stack name
   * beside the ids — and matching only there — is what confines the flag to
   * the stack the user actually named. Same shape as the prefix-migration
   * gate's `gateStackName !== opts.stackName` guard, and for the same reason.
   *
   * The two sets are mutually exclusive (the pre-flight validator rejects any
   * logical id named in both), and the engine trusts that every id in them is
   * present in the named stack's cdkd state on entry. When `undefined`, the
   * engine behaves exactly as before #615 / #651.
   */
  /**
   * `--pin-cc-api` targets (issue #2719): logical ids that decline the
   * automatic return to their SDK provider and stay on the Cloud Control
   * route for this deploy.
   *
   * Logical ids live HERE rather than on the registry because the registry is
   * type-scoped and knows nothing about logical ids; the engine resolves
   * membership and passes the answer down as a boolean.
   *
   * SELF-SCOPED by `stackName`, exactly like `recreateTargets` and for the
   * same reason: this object is spread into every nested child engine, and a
   * logical id is unique only WITHIN one template. Without the scope, pinning
   * `Topic` in the parent would also pin a `Topic` in any nested child that
   * happens to use the id -- silently, since a pin produces no output. Caught
   * by `tests/unit/provisioning/nested-stack-option-boundary-audit.test.ts`,
   * which is why the shape is a record rather than a bare Set.
   */
  pinCcApi?: {
    /** The stack these ids were validated against — the ONLY stack they apply to. */
    stackName: string;
    logicalIds: ReadonlySet<string>;
  };
  recreateTargets?: {
    /** The stack the ids below were validated against — the ONLY stack they apply to. */
    stackName: string;
    /** `--recreate-via-cc-api` targets (SDK → Cloud Control). */
    viaCcApi: ReadonlySet<string>;
    /** `--recreate-via-sdk-provider` targets (Cloud Control → SDK). */
    viaSdkProvider: ReadonlySet<string>;
  };

  /**
   * Issue [#808] — best-effort structured deployment-event recorder. When
   * supplied, the engine emits one event per per-resource operation
   * (RESOURCE_STARTED / RESOURCE_SUCCEEDED / RESOURCE_FAILED) and per
   * rollback step (ROLLBACK_STARTED / ROLLBACK_RESOURCE_SUCCEEDED /
   * ROLLBACK_RESOURCE_FAILED / ROLLBACK_RESOURCE_SKIPPED / ROLLBACK_FINISHED). The run-level
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

  /**
   * `--require-approval` (AWS CDK CLI parity, aws/aws-cdk-cli#2021): which
   * changes need {@link approveDeployment} to say yes before anything is
   * provisioned. `any-change` asks whenever the stack has a resource change,
   * `destructive` only when one replaces, deletes or orphans a resource.
   * Absent or `never`: no approval. Asked after the diff and the `--dry-run`
   * return, so a dry run never asks. A nested child engine inherits both
   * members through the options spread and asks for its own changes when the
   * parent reaches its row; declining fails that row like any other failure.
   */
  requireApproval?: RequireApprovalLevel;

  /**
   * Asks the operator whether to deploy. Resolves `false` to abort the stack's
   * deploy before any provider call. Owned by the CLI, which renders the
   * request, serializes prompts across concurrent stacks and handles `--yes`
   * and a non-interactive stdin.
   */
  approveDeployment?: (request: DeploymentApprovalRequest) => Promise<boolean>;

  /**
   * go-to-k/cdkd#4705: called after the diff and the `--dry-run` return, BEFORE
   * the approval prompt and any provider call, only when the plan may destroy
   * (`WILL_DESTROY` / `WILL_REPLACE` / `MAY_REPLACE`) or adds or updates a
   * nested-stack row (`checkDestructivePlan`). Throwing
   * aborts the stack before anything changes. Called again with `stage`
   * `'late'` for a replacement the deploy decides only on reading a resource
   * back (`approveLateReplacement`, #4656): there a throw keeps that resource
   * and the deploy goes on. NOT inherited by nested children: the spread site
   * sets it to `undefined`.
   */
  onDestructivePlan?:
    | ((
        stackName: string,
        destructive: readonly DestructiveChange[],
        stage?: 'late'
      ) => Promise<void>)
    | undefined;

  /**
   * go-to-k/cdkd#4705: asked, after the same-prefix foreign-holder scan finds
   * nothing, before a SUCCESSFUL deploy's settle deletes a proven journaled
   * orphan of `stackName` (`settleJournalAfterSuccess`): whether the bucket
   * records that stack under ANOTHER state prefix, whose record may hold the
   * resource. A holding keeps the orphan, with the settle's existing warning.
   * Also asked, alone, by a failed deploy's AUTOMATIC rollback before it
   * deletes a resource the deploy created (`performRollback`). Absent: no
   * cross-prefix check. A nested child inherits it and asks by its own stack
   * name (`Parent~Child`); only the root engine settles.
   */
  crossPrefixHolder?: ((stackName: string) => Promise<ForeignHolding>) | undefined;
}

/** The `--require-approval` levels cdkd implements (CDK's `broadening` needs a security diff cdkd has none of). */
export type RequireApprovalLevel = 'never' | 'any-change' | 'destructive';

/** What {@link DeployEngineOptions.approveDeployment} is asked to approve. */
export interface DeploymentApprovalRequest {
  stackName: string;
  level: Exclude<RequireApprovalLevel, 'never'>;
  counts: { create: number; update: number; delete: number };
  /** The changes that replace, delete or orphan a resource; non-empty under `destructive`. */
  destructiveChanges: DestructiveChange[];
  /** The stack's Outputs (or its export set) change with no resource change. */
  outputsOnly?: true;
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
   *
   * Includes every nested-stack descendant's own count (issue
   * [#1989](https://github.com/go-to-k/cdkd/issues/1989)): a child engine's
   * `DeployResult` is added to its `AWS::CloudFormation::Stack` row's engine,
   * so a skip inside a child or grandchild reaches the top-level summary and
   * exit code. `created` / `updated` / `deleted` stay this stack's own rows.
   */
  deleteSkipped: number;
  /**
   * Resources whose UPDATE reported `{ outcome: 'partial' }` (issue #1819):
   * updated, but something the update owned survives untracked. Separate from
   * `updated` so a clean run and a run that orphaned a resource do not print
   * the same summary, and separate from `deleteSkipped` because the surviving
   * resource is not the row's own. Includes nested-stack descendants' counts,
   * as `deleteSkipped` does (issue #1989), so the exit code sees them;
   * `nestedUpdatePartial` says how many of them are a descendant's.
   */
  updatePartial: number;
  /**
   * The part of `updatePartial` reported by nested-stack descendants (issue
   * #1989) — a subset of it, never added to it. `deploy.ts` subtracts it from
   * the `Updated:` total, which counts this stack's own rows, and prints it on
   * its own row. Absent on results that never provisioned (the dry-run and
   * no-change returns) and in older test doubles: read as 0.
   */
  nestedUpdatePartial?: number;
  /**
   * go-to-k/cdkd#4705: late replacements the cross-prefix check refused, each
   * keeping its old resource (`ProvisionCounts.crossPrefixKept`). Unaddressed:
   * `deploy.ts` adds it to the exit-2 total. Only a top-level engine runs that
   * check. Absent means 0.
   */
  crossPrefixKept?: number;
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
