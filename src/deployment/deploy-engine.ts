import { getLogger } from '../utils/logger.js';
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
import { withStackName, applyDefaultNameForFallback } from '../provisioning/resource-name.js';
import { IntrinsicFunctionResolver } from './intrinsic-function-resolver.js';
import { DagExecutor } from './dag-executor.js';
import type { CloudFormationTemplate, ResourceProvider } from '../types/resource.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  shouldRetainResource,
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
import { TemplateParser } from '../analyzer/template-parser.js';
import {
  IMPLICIT_DELETE_DEPENDENCIES,
  computeImplicitDeleteEdges,
} from '../analyzer/implicit-delete-deps.js';
import { withRetry } from './retry.js';
import { withResourceDeadline } from './resource-deadline.js';
import { findUnrewrittenAssetReferences, type AssetRedirectMap } from '../assets/asset-redirect.js';

/**
 * Completed operation record for rollback tracking
 */
interface CompletedOperation {
  /** Logical ID of the resource */
  logicalId: string;
  /** Type of change that was applied */
  changeType: 'CREATE' | 'UPDATE' | 'DELETE';
  /** Resource type (e.g., "AWS::S3::Bucket") */
  resourceType: string;
  /**
   * Provisioning layer the resource ran on. Load-bearing for rollback
   * dispatch — a CC-routed CREATE must roll back via the CC provider's
   * delete, NOT the SDK provider's (#614). Populated from the routing
   * decision (CREATE) or from the previous state (UPDATE / DELETE).
   * `undefined` falls back to legacy SDK semantics for legacy state.
   */
  provisionedBy?: 'sdk' | 'cc-api' | undefined;
  /** Previous resource state (for UPDATE rollback) */
  previousState?: ResourceState | undefined;
  /** Physical ID of newly created resource (for CREATE rollback) */
  physicalId?: string | undefined;
  /** Properties used for creation (for CREATE rollback / delete) */
  properties?: Record<string, unknown> | undefined;
}

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
   * stateful resource. Required alongside {@link replace} (and the existing
   * `--recreate-via-*` flags) whenever the replacement target is a stateful
   * type. Without it, the engine refuses the replacement and surfaces a clear
   * error naming the resource + the data-loss reason.
   */
  forceStatefulRecreation?: boolean;
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
    this.resolver = new IntrinsicFunctionResolver(stackRegion);
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
    };
  }

  /**
   * Stamp `parentStack` / `parentLogicalId` / `parentRegion` (schema v6+)
   * onto a state object that's about to be saved, when this engine was
   * constructed with `options.parentStackInfo` (= it's deploying a
   * nested-stack child). Returns the state unchanged for top-level
   * deploys so the three v6 fields stay absent from non-child state files.
   */
  private withParentInfo(state: StackState): StackState {
    if (!this.options.parentStackInfo) return state;
    const { parentStack, parentLogicalId, parentRegion } = this.options.parentStackInfo;
    return {
      ...state,
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

    // Acquire lock with retry (retries up to 3 times with 2s delay for transient lock conflicts)
    await this.lockManager.acquireLockWithRetry(stackName, this.stackRegion, undefined, 'deploy');

    // Live progress renderer: shows in-flight resources as a multi-line area
    // at the bottom of the terminal. Self-disables on non-TTY and when
    // `CDKD_NO_LIVE=1` is set (the CLI sets this in verbose mode so debug
    // logs do not interleave with the live area).
    const renderer = getLiveRenderer();
    renderer.start();

    // Register SIGINT handler to save partial state on Ctrl+C
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

    try {
      // 1. Load current state
      const currentStateData = await this.stateBackend.getState(stackName, this.stackRegion);
      const currentState: StackState = currentStateData?.state ?? {
        version: STATE_SCHEMA_VERSION_CURRENT,
        region: this.stackRegion,
        stackName,
        resources: {},
        outputs: {},
        lastModified: Date.now(),
      };
      const currentEtag = currentStateData?.etag;
      // Set when we loaded a `version: 1` legacy record. The next save
      // migrates it to the new key.
      const migrationPending = currentStateData?.migrationPending ?? false;

      this.logger.debug(
        `Loaded current state: ${Object.keys(currentState.resources).length} resources`
      );

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
      const parameterValues = await this.resolver.resolveParameters(
        template,
        this.options.parameters
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
          parameters: parameterValues,
          conditions,
        },
        stackName
      );
      const diffResolveFn = (value: unknown) => this.resolver.resolve(value, diffResolverContext);
      const changes = await this.diffCalculator.calculateDiff(
        currentState,
        effectiveTemplate,
        diffResolveFn
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
          const resolvedOutputs = await this.resolveOutputs(
            effectiveTemplate,
            currentState.resources,
            stackName,
            parameterValues,
            conditions
          );
          // resolveOutputs stores `undefined` for any output it could not
          // resolve (logged as a warn there). In the no-change path every
          // resource is already in state so resolution should succeed; if it
          // doesn't, keep the existing good outputs rather than overwrite them
          // with a partial map.
          const resolutionFailed = Object.values(resolvedOutputs).some((v) => v === undefined);
          const outputsChanged =
            !resolutionFailed && !outputMapsEqual(persistedOutputs, resolvedOutputs);

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

          if (observedRefresh || outputsChanged) {
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
                // Preserve existing imports[] (no-change path: nothing
                // re-resolved). Otherwise the refresh would silently
                // strip the strong-reference record on every diff-clean
                // deploy. Same logic applies to outputReads[] (v8+).
                ...(currentState.imports &&
                  currentState.imports.length > 0 && {
                    imports: currentState.imports,
                  }),
                ...(currentState.outputReads &&
                  currentState.outputReads.length > 0 && {
                    outputReads: currentState.outputReads,
                  }),
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
              if (outputsChanged) {
                persistedOutputs = resolvedOutputs;
                this.logger.info('Persisted Outputs-only change (no resource diff).');
                // Update the persistent exports index so the newly-added export
                // resolves O(1) for consumers. Inside the try so a failed state
                // save doesn't publish an export that wasn't persisted;
                // updateForStack is itself best-effort (swallows + warns).
                if (this.exportIndexStore) {
                  await this.exportIndexStore.updateForStack(
                    stackName,
                    this.stackRegion,
                    persistedOutputs
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

        return {
          stackName,
          created: 0,
          updated: 0,
          deleted: 0,
          unchanged: Object.keys(currentState.resources).length,
          durationMs: Date.now() - startTime,
          outputs: this.buildDisplayOutputs(template, persistedOutputs),
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
          unchanged: this.diffCalculator.filterByType(changes, 'NO_CHANGE').length,
          durationMs: Date.now() - startTime,
        };
      }

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

      // 7c. Update the persistent exports index with this stack's
      // outputs so subsequent `Fn::ImportValue` resolves hit O(1).
      // Best-effort: failures are swallowed inside updateForStack and
      // surfaced as warnings (state.json is canonical; a stale index
      // self-heals on the next deploy/resolve fallback).
      if (this.exportIndexStore) {
        await this.exportIndexStore.updateForStack(
          stackName,
          this.stackRegion,
          (newState.outputs as Record<string, unknown>) ?? {}
        );
      }

      const durationMs = Date.now() - startTime;
      const unchangedCount =
        this.diffCalculator.filterByType(changes, 'NO_CHANGE').length + actualCounts.skipped;

      return {
        stackName,
        created: actualCounts.created,
        updated: actualCounts.updated,
        deleted: actualCounts.deleted,
        unchanged: unchangedCount,
        durationMs,
        outputs: this.buildDisplayOutputs(template, newState.outputs ?? {}),
      };
    } finally {
      // Stop live renderer (clears any remaining in-flight task display)
      renderer.stop();

      // Remove SIGINT handler
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
    actualCounts: { created: number; updated: number; deleted: number; skipped: number };
  }> {
    const concurrency = this.options.concurrency!;
    const newResources: Record<string, ResourceState> = { ...currentState.resources };
    const actualCounts = { created: 0, updated: 0, deleted: 0, skipped: 0 };
    const completedOperations: CompletedOperation[] = [];
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
            // Per-resource partial save: imports[] / outputReads[]
            // revert to the pre-deploy snapshot. recordedImports +
            // recordedOutputReads from this session are persisted
            // only on the final success path.
            ...(currentState.imports &&
              currentState.imports.length > 0 && {
                imports: currentState.imports,
              }),
            ...(currentState.outputReads &&
              currentState.outputReads.length > 0 && {
                outputReads: currentState.outputReads,
              }),
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
                this.interrupted = true;
                this.interruptCause ??= 'sibling-failure';
                throw provisionError;
              }

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
          ...(currentState.imports &&
            currentState.imports.length > 0 && {
              imports: currentState.imports,
            }),
          ...(currentState.outputReads &&
            currentState.outputReads.length > 0 && {
              outputReads: currentState.outputReads,
            }),
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

      // On SIGINT, skip rollback — just save partial state and let the caller exit
      if (error instanceof InterruptedError) {
        this.logger.info(
          `Partial state saved (${Object.keys(newResources).length} resources). ` +
            'Run deploy again to resume, or destroy to clean up.'
        );
        throw error;
      }

      // Deployment failed — attempt rollback unless --no-rollback is set
      if (this.options.noRollback) {
        this.logger.warn('Deployment failed. --no-rollback is set, skipping rollback.');
        this.logger.warn('Partial state has been saved. Manual cleanup may be required.');
      } else {
        await this.performRollback(completedOperations, newResources, stackName);
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
          ...(currentState.imports &&
            currentState.imports.length > 0 && {
              imports: currentState.imports,
            }),
          ...(currentState.outputReads &&
            currentState.outputReads.length > 0 && {
              outputReads: currentState.outputReads,
            }),
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
            ...(currentState.imports &&
              currentState.imports.length > 0 && {
                imports: currentState.imports,
              }),
            ...(currentState.outputReads &&
              currentState.outputReads.length > 0 && {
                outputReads: currentState.outputReads,
              }),
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
        } catch (retryError) {
          this.logger.warn(
            `Failed to save state after rollback: ${retryError instanceof Error ? retryError.message : String(retryError)}`
          );
        }
      }

      throw error;
    }

    // Resolve outputs
    const outputs = await this.resolveOutputs(
      template,
      newResources,
      stackName,
      parameterValues,
      conditions
    );

    return {
      state: {
        version: STATE_SCHEMA_VERSION_CURRENT,
        region: this.stackRegion,
        stackName: currentState.stackName,
        resources: newResources,
        outputs,
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
   * Perform best-effort rollback of completed operations respecting dependencies
   *
   * - CREATE → delete the newly created resource (in reverse dependency order)
   * - UPDATE → update back to previous properties
   * - DELETE → cannot rollback (resource already deleted), log warning
   *
   * Resources completed concurrently in the dispatcher may have dependencies
   * between them (e.g., IAM Policy depends on IAM Role). When rolling back
   * CREATEs (deleting), dependent resources must be deleted before their
   * dependencies. This method sorts CREATE rollback operations using dependency
   * information from state, then processes UPDATE/DELETE rollbacks, and finally
   * processes sorted CREATE rollback deletions.
   */
  private async performRollback(
    completedOperations: CompletedOperation[],
    stateResources: Record<string, ResourceState>,
    stackName: string
  ): Promise<void> {
    if (completedOperations.length === 0) {
      this.logger.info('No completed operations to roll back.');
      return;
    }

    this.logger.info(`Rolling back ${completedOperations.length} completed operation(s)...`);
    this.recordEvent({ eventType: 'ROLLBACK_STARTED', stackName });

    // Separate CREATE operations (which need dependency-aware ordering) from others
    const createOps: CompletedOperation[] = [];
    const otherOps: CompletedOperation[] = [];

    for (const op of completedOperations) {
      if (op.changeType === 'CREATE') {
        createOps.push(op);
      } else {
        otherOps.push(op);
      }
    }

    // Step 1: Process UPDATE/DELETE rollbacks in reverse order (simple reversal is fine)
    for (let i = otherOps.length - 1; i >= 0; i--) {
      const op = otherOps[i]!;
      await this.performSingleRollback(op, stateResources, stackName);
    }

    // Step 2: Process CREATE rollbacks (deletions) in dependency-aware order
    // (reverse dependency: dependents are deleted before their dependencies)
    if (createOps.length > 0) {
      const sortedCreateOps = this.sortRollbackCreates(createOps, stateResources);
      for (const op of sortedCreateOps) {
        await this.performSingleRollback(op, stateResources, stackName);
      }
    }

    this.logger.info('Rollback completed. Some resources may remain if deletion failed.');
    this.recordEvent({ eventType: 'ROLLBACK_FINISHED', stackName });
  }

  /**
   * Sort CREATE rollback operations so that resources depending on others
   * are deleted first (reverse dependency order).
   *
   * Uses state dependencies to determine reverse-dependency order, similar to buildDeletionDependencies.
   */
  private sortRollbackCreates(
    createOps: CompletedOperation[],
    stateResources: Record<string, ResourceState>
  ): CompletedOperation[] {
    const opMap = new Map<string, CompletedOperation>();
    const deleteIds = new Set<string>();
    for (const op of createOps) {
      opMap.set(op.logicalId, op);
      deleteIds.add(op.logicalId);
    }

    // Build reverse dependency map: resource → resources that depend on it
    const dependedBy = new Map<string, Set<string>>();
    for (const id of deleteIds) {
      if (!dependedBy.has(id)) dependedBy.set(id, new Set());
    }

    for (const id of deleteIds) {
      const resource = stateResources[id];
      if (!resource?.dependencies) continue;
      for (const dep of resource.dependencies) {
        if (!deleteIds.has(dep)) continue;
        // id depends on dep → dep must be deleted AFTER id
        if (!dependedBy.has(dep)) dependedBy.set(dep, new Set());
        dependedBy.get(dep)!.add(id);
      }
    }

    // Topological sort (Kahn's algorithm) — produces levels for parallel delete
    const sorted: CompletedOperation[] = [];
    let remaining = new Set(deleteIds);

    while (remaining.size > 0) {
      // Find resources with no remaining dependents (safe to delete now)
      const level: string[] = [];
      for (const id of remaining) {
        const dependents = dependedBy.get(id);
        const hasPendingDependents = dependents
          ? [...dependents].some((d) => remaining.has(d))
          : false;
        if (!hasPendingDependents) {
          level.push(id);
        }
      }

      if (level.length === 0) {
        // Circular dependency fallback: add all remaining
        this.logger.warn(
          `Circular dependency detected in rollback order, processing remaining ${remaining.size} resources`
        );
        for (const id of remaining) {
          const op = opMap.get(id);
          if (op) sorted.push(op);
        }
        break;
      }

      for (const id of level) {
        const op = opMap.get(id);
        if (op) sorted.push(op);
      }
      remaining = new Set([...remaining].filter((id) => !level.includes(id)));
    }

    this.logger.debug(
      `Rollback CREATE deletion order: ${sorted.map((op) => op.logicalId).join(' → ')}`
    );
    return sorted;
  }

  /**
   * Perform a single rollback operation (extracted for reuse)
   */
  private async performSingleRollback(
    op: CompletedOperation,
    stateResources: Record<string, ResourceState>,
    stackName: string
  ): Promise<void> {
    try {
      switch (op.changeType) {
        case 'CREATE': {
          // Rollback CREATE by deleting the newly created resource
          if (!op.physicalId) {
            this.logger.warn(`  Rollback: Cannot delete ${op.logicalId} — no physical ID recorded`);
            break;
          }

          this.logger.info(
            `  Rollback: Deleting created resource ${op.logicalId} (${op.resourceType})`
          );
          // Route via the SAME provider the CREATE landed on (#614). Without
          // threading `provisionedBy`, a CC-routed CREATE would roll back
          // via the SDK provider — wrong API, wrong identifier semantics.
          const { provider } = this.providerRegistry.getProviderFor({
            resourceType: op.resourceType,
            provisionedBy: op.provisionedBy,
          });
          await provider.delete(op.logicalId, op.physicalId, op.resourceType, op.properties, {
            expectedRegion: this.stackRegion,
          });

          // Remove from state
          delete stateResources[op.logicalId];
          this.logger.info(`  Rollback: ${op.logicalId} deleted successfully`);
          this.recordEvent({
            eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
            stackName,
            operation: 'CREATE',
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
          });
          break;
        }

        case 'UPDATE': {
          // Rollback UPDATE by restoring previous properties
          if (!op.previousState) {
            this.logger.warn(
              `  Rollback: Cannot restore ${op.logicalId} — no previous state available`
            );
            break;
          }

          this.logger.info(
            `  Rollback: Restoring ${op.logicalId} (${op.resourceType}) to previous state`
          );
          // Route via the provider that owns the resource right now per
          // state (#614). For a CC-managed resource being rolled back, the
          // SDK provider would have the wrong patch semantics.
          const { provider } = this.providerRegistry.getProviderFor({
            resourceType: op.resourceType,
            provisionedBy: op.provisionedBy,
          });
          const currentResource = stateResources[op.logicalId];

          if (!currentResource) {
            this.logger.warn(
              `  Rollback: Cannot restore ${op.logicalId} — resource not found in current state`
            );
            break;
          }

          await provider.update(
            op.logicalId,
            currentResource.physicalId,
            op.resourceType,
            op.previousState.properties,
            currentResource.properties
          );

          // Restore previous state
          stateResources[op.logicalId] = op.previousState;
          this.logger.info(`  Rollback: ${op.logicalId} restored successfully`);
          this.recordEvent({
            eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
            stackName,
            operation: 'UPDATE',
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
          });
          break;
        }

        case 'DELETE': {
          // Cannot rollback DELETE — resource is already deleted
          this.logger.warn(
            `  Rollback: Cannot restore deleted resource ${op.logicalId} (${op.resourceType}) — resource has already been deleted`
          );
          break;
        }
      }
    } catch (rollbackError) {
      // Best-effort: log warning and continue with remaining rollbacks
      this.logger.warn(
        `  Rollback failed for ${op.logicalId} (${op.changeType}): ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      );
      this.logger.warn('  Continuing with remaining rollback operations...');
      this.recordEvent({
        eventType: 'ROLLBACK_RESOURCE_FAILED',
        stackName,
        operation: op.changeType,
        logicalId: op.logicalId,
        resourceType: op.resourceType,
        ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
        error: extractDeploymentEventError(rollbackError),
      });
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
    counts?: { created: number; updated: number; deleted: number; skipped: number },
    progress?: { current: number; total: number }
  ): Promise<void> {
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
    const timeoutMs =
      this.options.resourceTimeoutByType?.[resourceType] ??
      Math.max(providerMinTimeoutMs, globalTimeoutMs);

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

    try {
      await withResourceDeadline(
        async () => {
          await this.provisionResourceBody(
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
      this.logger.error(`Failed to ${change.changeType.toLowerCase()} ${logicalId}: ${message}`);

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

      throw new ProvisioningError(
        `Failed to ${change.changeType.toLowerCase()} resource ${logicalId}`,
        resourceType,
        logicalId,
        stateResources[logicalId]?.physicalId,
        error instanceof Error ? error : undefined
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
      this.options.eventRecorder.record(event);
    } catch {
      // best-effort: never let event recording surface into the deploy path
    }
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
    counts?: { created: number; updated: number; deleted: number; skipped: number },
    progress?: { current: number; total: number }
  ): Promise<void> {
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

        const resolvedProps = (await this.resolver.resolve(desiredProps, context)) as Record<
          string,
          unknown
        >;

        this.auditResolvedAssetReferences(logicalId, resourceType, resolvedProps);

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
          () => createProvider.create(logicalId, resourceType, createProps),
          logicalId,
          undefined,
          undefined,
          createProvider
        );

        // Extract ALL dependencies from template (Ref, Fn::GetAtt, DependsOn)
        // so that deletion order is correct even without implicit type-based deps
        const dependencies = this.extractAllDependencies(template, logicalId);
        const templateAttrs = this.extractTemplateAttributes(template, logicalId);

        stateResources[logicalId] = {
          physicalId: result.physicalId,
          resourceType,
          properties: resolvedProps,
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

        const resolvedProps = (await this.resolver.resolve(desiredProps, context)) as Record<
          string,
          unknown
        >;

        this.auditResolvedAssetReferences(logicalId, resourceType, resolvedProps);

        // Re-check diff after resolving intrinsic functions
        // DiffCalculator compares unresolved template vs resolved state, which may produce false positives
        if (JSON.stringify(resolvedProps) === JSON.stringify(currentProps)) {
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
          // object-count probe.
          if (propertyDrivenReplacement && !recreateFlagged) {
            const statefulReason = isStatefulRecreateTargetForReplace(resourceType, currentProps);
            if (statefulReason && this.options.forceStatefulRecreation !== true) {
              const immutableProps = change.propertyChanges
                ?.filter((pc) => pc.requiresReplacement)
                .map((pc) => pc.path)
                .join(', ');
              throw new CdkdError(
                `${logicalId} (${resourceType}) requires replacement (immutable property changed: ` +
                  `${immutableProps}) but it is a stateful resource — ` +
                  `${renderStatefulReason(statefulReason)}. Re-run with ` +
                  `--force-stateful-recreation to confirm the data loss, or change the resource ` +
                  `definition to avoid the immutable-property change.`,
                'STATEFUL_REPLACE_BLOCKED'
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
          // i.e. destroy-then-create.
          const updateReplacePolicy = template?.Resources?.[logicalId]?.UpdateReplacePolicy;
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
              try {
                await oldDeleteProvider.delete(
                  logicalId,
                  currentResource.physicalId,
                  resourceType,
                  currentResource.properties,
                  { expectedRegion: this.stackRegion }
                );
                this.logger.info(`  ${green('✓')} Old resource deleted`);
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
            }

            this.logger.info(`  Creating new ${logicalId}...`);
            createResult = await this.withRetry(
              () => replaceProvider.create(logicalId, resourceType, replaceProps),
              logicalId,
              undefined,
              undefined,
              replaceProvider
            );
          } else {
            // Property-driven replacement: create-then-destroy (CFn
            // safe-replacement order — keeps the old alive if CREATE
            // fails so the deploy can roll back to it cleanly).
            this.logger.info(`  Creating new ${logicalId}...`);
            let deletedOldFirst = false;
            try {
              createResult = await this.withRetry(
                () => replaceProvider.create(logicalId, resourceType, replaceProps),
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
              const nameCollision =
                /already exists/i.test(createMsg) || createMsg.includes('AlreadyExists');
              if (!nameCollision) throw createError;
              // Retain pins the old resource (and its name) in place, so a
              // same-name replacement can never proceed under any flag.
              // (Snapshot is NOT special-cased — matching the pre-existing
              // create-then-destroy path, which also plain-deletes under
              // Snapshot.)
              if (updateReplacePolicy === 'Retain') {
                throw new CdkdError(
                  `${logicalId} (${resourceType}) requires replacement, but its user-supplied ` +
                    `physical name is still held by the existing resource AND ` +
                    `UpdateReplacePolicy: Retain pins that resource in place. Rename the ` +
                    `resource in your CDK code — with Retain, the old resource keeps the ` +
                    `name, so a same-name replacement can never proceed.`,
                  'NAMED_REPLACEMENT_COLLISION'
                );
              }
              if (this.options.replace !== true) {
                throw new CdkdError(
                  `${logicalId} (${resourceType}) requires replacement, but the create-first ` +
                    `attempt collided with the existing resource: ${createMsg}. The resource ` +
                    `has a user-supplied physical name, so the CloudFormation-style safe ` +
                    `replacement order (create the new resource before deleting the old) ` +
                    `cannot reuse the occupied name — CloudFormation refuses this shape with ` +
                    `"cannot update a stack when a custom-named resource requires replacing". ` +
                    `Either rename the resource in your CDK code (a fresh name lets the safe ` +
                    `create-first order proceed), or re-run with \`cdkd deploy --replace\` to ` +
                    `delete the old resource FIRST and recreate it under the same name (the ` +
                    `resource is briefly unavailable while it is recreated).`,
                  'NAMED_REPLACEMENT_COLLISION'
                );
              }
              // --replace opt-in: the user accepts delete-first semantics
              // (the stateful guard for this property-driven replacement
              // already ran above). Delete the old holder, then re-create.
              this.logger.info(
                `  Create-first collided with the custom-named resource and --replace is set — ` +
                  `deleting old ${logicalId} (${currentResource.physicalId}) first...`
              );
              try {
                await oldDeleteProvider.delete(
                  logicalId,
                  currentResource.physicalId,
                  resourceType,
                  currentResource.properties,
                  { expectedRegion: this.stackRegion }
                );
              } catch (deleteError) {
                // Mirror the recreate-flagged path's wrapping: the delete is
                // load-bearing here (without it the re-create collides again).
                throw new Error(
                  `Failed to delete old resource ${logicalId} (${currentResource.physicalId}) ` +
                    `during the --replace delete-first fallback: ` +
                    `${deleteError instanceof Error ? deleteError.message : String(deleteError)}`
                );
              }
              this.logger.info(`  ${green('✓')} Old resource deleted`);
              deletedOldFirst = true;
              this.logger.info(`  Re-creating ${logicalId}...`);
              try {
                // Some providers return from delete() before the name is
                // actually released (async deletes: Step Functions, Kinesis,
                // Pipes DELETING state). "already exists" is deliberately
                // NOT in the transient-retry patterns, so give the re-create
                // its own bounded collision retry instead of failing fast
                // with the old resource already gone.
                createResult = await withRetry(
                  () =>
                    this.withRetry(
                      () => replaceProvider.create(logicalId, resourceType, replaceProps),
                      logicalId,
                      undefined,
                      undefined,
                      replaceProvider
                    ),
                  logicalId,
                  {
                    maxRetries: 5,
                    initialDelayMs: 2_000,
                    maxDelayMs: 10_000,
                    logger: this.logger,
                    isInterrupted: () => this.interrupted,
                    onInterrupted: () => new InterruptedError(this.interruptCause ?? 'user'),
                    isRetryable: (message: string) =>
                      /already exists/i.test(message) || message.includes('AlreadyExists'),
                  }
                );
              } catch (recreateError) {
                // The old resource is ALREADY deleted at this point — say so,
                // because state still records it and the next deploy's UPDATE
                // would otherwise chase a resource that no longer exists.
                throw new Error(
                  `Failed to re-create ${logicalId} after the --replace delete-first fallback ` +
                    `already deleted the old resource (${currentResource.physicalId}): ` +
                    `${recreateError instanceof Error ? recreateError.message : String(recreateError)}. ` +
                    `Re-run the deploy to create it fresh.`
                );
              }
            }

            if (deletedOldFirst) {
              // Old resource is already gone (delete-first fallback above).
            } else if (updateReplacePolicy === 'Retain') {
              this.logger.info(
                `  Retaining old ${logicalId} (${currentResource.physicalId}) - UpdateReplacePolicy: Retain`
              );
            } else {
              this.logger.info(`  Deleting old ${logicalId} (${currentResource.physicalId})...`);
              try {
                await oldDeleteProvider.delete(
                  logicalId,
                  currentResource.physicalId,
                  resourceType,
                  currentResource.properties,
                  { expectedRegion: this.stackRegion }
                );
                this.logger.info(`  ${green('✓')} Old resource deleted`);
              } catch (deleteError) {
                this.logger.warn(
                  `  ⚠ Failed to delete old resource ${logicalId} (${currentResource.physicalId}): ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`
                );
              }
            }
          }

          stateResources[logicalId] = {
            physicalId: createResult.physicalId,
            resourceType,
            properties: resolvedProps,
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
                updateProvider.update(
                  logicalId,
                  currentResource.physicalId,
                  resourceType,
                  updateProps,
                  currentProps
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
            //      UPDATE" — auto-fallback, UNCONDITIONAL (pre-existing).
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
              // Stateful guard for the `--replace` opt-in path only (the CC
              // auto-fallback keeps its long-standing unconditional behavior).
              // A stateful type (RDS / DynamoDB / EFS / etc.) must not be
              // silently DELETE+CREATEd — require --force-stateful-recreation.
              if (replaceOptIn) {
                // Conservative variant: --replace fires mid-deploy with no
                // chance to run the async S3 object-count probe, so a deferred
                // S3 bucket is treated as stateful (block unless forced).
                const statefulReason = isStatefulRecreateTargetForReplace(
                  resourceType,
                  currentProps
                );
                if (statefulReason && this.options.forceStatefulRecreation !== true) {
                  throw new CdkdError(
                    `--replace would DELETE + CREATE the stateful resource ${logicalId} ` +
                      `(${resourceType}) — ${renderStatefulReason(statefulReason)}. Re-run with ` +
                      `--force-stateful-recreation to confirm the data loss, or change the ` +
                      `resource definition to avoid the immutable-property change.`,
                    'STATEFUL_REPLACE_BLOCKED'
                  );
                }
              }
              this.logger.info(
                `UPDATE not supported for ${logicalId} (${resourceType}), replacing (DELETE → CREATE)`
              );
              try {
                await updateProvider.delete(
                  logicalId,
                  currentResource.physicalId,
                  resourceType,
                  currentProps,
                  { expectedRegion: this.stackRegion }
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
                () => replProvider.create(logicalId, resourceType, replProps),
                logicalId,
                undefined,
                undefined,
                replProvider
              );
              result = {
                physicalId: createResult.physicalId,
                attributes: createResult.attributes,
                wasReplaced: true,
              };
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

          stateResources[logicalId] = {
            physicalId: result.physicalId,
            resourceType,
            properties: resolvedProps,
            ...(result.attributes && { attributes: result.attributes }),
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

          if (counts) counts.updated++;
          if (progress) progress.current++;
          const updatePrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
          renderer.removeTask(logicalId);
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

        // Schema v7+: route DELETE through the layer recorded on state
        // (`provisionedBy: 'cc-api'` → Cloud Control; absent / `'sdk'`
        // → SDK provider — legacy default).
        const deleteProvider = this.providerRegistry.getProviderFor({
          resourceType,
          provisionedBy: currentResource.provisionedBy,
        }).provider;

        this.logger.debug(`Deleting ${logicalId} (${resourceType})`);
        try {
          await this.withRetry(
            () =>
              deleteProvider.delete(
                logicalId,
                currentResource.physicalId,
                resourceType,
                currentResource.properties,
                { expectedRegion: this.stackRegion }
              ),
            logicalId,
            3, // fewer retries for DELETE
            5_000,
            deleteProvider
          );
        } catch (deleteError) {
          const msg = deleteError instanceof Error ? deleteError.message : String(deleteError);
          // Treat "not found" errors as success (resource already deleted)
          if (
            msg.includes('does not exist') ||
            msg.includes('was not found') ||
            msg.includes('not found') ||
            msg.includes('No policy found') ||
            msg.includes('NoSuchEntity') ||
            msg.includes('NotFoundException') ||
            msg.includes('ResourceNotFoundException')
          ) {
            this.logger.debug(
              `Resource ${logicalId} already deleted (${msg}), removing from state`
            );
          } else {
            throw deleteError;
          }
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
   */
  private extractAllDependencies(
    template: CloudFormationTemplate | undefined,
    logicalId: string
  ): string[] | undefined {
    const resource = template?.Resources?.[logicalId];
    if (!resource) return undefined;
    const parser = new TemplateParser();
    const deps = parser.extractDependencies(resource);
    return deps.size > 0 ? [...deps] : undefined;
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
      logger: this.logger,
      isInterrupted: () => this.interrupted,
      onInterrupted: () => new InterruptedError(this.interruptCause ?? 'user'),
    });
  }

  /**
   * Resolve stack outputs from template and resource attributes
   *
   * Uses IntrinsicFunctionResolver for full CloudFormation intrinsic function support.
   */
  private async resolveOutputs(
    template: CloudFormationTemplate,
    resources: Record<string, ResourceState>,
    stackName: string,
    parameterValues?: Record<string, unknown>,
    conditions?: Record<string, boolean>
  ): Promise<Record<string, unknown>> {
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

    for (const [outputKey, output] of Object.entries(template.Outputs)) {
      try {
        const value = await this.resolver.resolve(output.Value, context);
        outputs[outputKey] = value;

        // If the output has an Export.Name, also store under that key
        // so Fn::ImportValue can find it by export name
        if (output.Export?.Name) {
          const exportName =
            typeof output.Export.Name === 'string'
              ? output.Export.Name
              : await this.resolver.resolve(output.Export.Name, context);
          if (typeof exportName === 'string') {
            outputs[exportName] = value;
          }
        }
      } catch (error) {
        this.logger.warn(`Failed to resolve output ${outputKey}: ${String(error)}`);
        outputs[outputKey] = undefined;
      }
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
