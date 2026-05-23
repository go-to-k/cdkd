import { AsyncLocalStorage } from 'node:async_hooks';
import type { S3StateBackend } from '../state/s3-state-backend.js';
import type { LockManager } from '../state/lock-manager.js';
import type { ExportIndexStore } from '../state/export-index-store.js';
import type { DagBuilder } from '../analyzer/dag-builder.js';
import type { DiffCalculator } from '../analyzer/diff-calculator.js';
import type { ProviderRegistry } from './provider-registry.js';
import type { DeployEngineOptions } from '../deployment/deploy-engine.js';
import type { AwsClients } from '../utils/aws-clients.js';

/**
 * Execution context carried by `NestedStackProvider` across a parent stack's
 * deploy / destroy. Propagated through the call chain via
 * {@link AsyncLocalStorage} so the provider registry can stay state-less
 * (one instance per process) while each `create / update / delete` invocation
 * still sees the parent-specific parent stack name, region, asset paths, and
 * shared infra handles.
 *
 * The context is mutated only via `withNestedStackContext` — `getCurrentNestedStackContext`
 * returns whatever the outermost (or innermost) `withNestedStackContext` set,
 * with inner scopes shadowing the outer. The recursive nested-stack case
 * (parent -> child -> grandchild) re-runs `withNestedStackContext` inside the
 * provider's `create` so the grandchild's parent is the child, not the
 * top-level stack.
 */
export interface NestedStackProviderContext {
  /** Shared state backend — child state keys derive as `<parentStackName>~<NestedStackLogicalId>`. */
  stateBackend: S3StateBackend;

  /** Shared lock manager — child locks are acquired against the derived stack name. */
  lockManager: LockManager;

  /**
   * Shared provider registry. Used by the child `DeployEngine` (during create / update)
   * AND by `runDestroyForStack` (during delete) so children re-use the parent's full
   * SDK + Cloud-Control provider set, including `NestedStackProvider` itself for
   * grand-nested cases.
   */
  providerRegistry: ProviderRegistry;

  /** Physical name of the parent stack — embedded in the child's derived state key. */
  parentStackName: string;

  /** Region of the parent stack — children inherit (AWS forbids cross-region nested stacks). */
  parentRegion: string;

  /** Caller AWS account id — used to synthesize the child's fake `Ref` ARN. */
  accountId: string;

  /** Caller AWS clients — borrowed by the child `DeployEngine` for AWS calls. */
  awsClients: AwsClients;

  /** State bucket name — needed when the child resolves Custom-Resource ResponseURLs. */
  stateBucket: string;

  /** Persistent exports index — children share with the parent. */
  exportIndexStore?: ExportIndexStore;

  /**
   * Deploy-only: per-logical-id absolute file paths of nested templates one
   * level below the current parent. Populated by `AssemblyReader` when synth
   * runs. `NestedStackProvider.create / update` reads the matching path and
   * the child template — itself sourced from `cdk.out/<file>.nested.template.json`.
   * Undefined on the destroy path where synth has not run.
   *
   * `| undefined` is explicit (vs bare `?:`) so the recursive nested call
   * site can spread `{ ...ctx, nestedTemplates: undefined }` to drop the
   * field under `exactOptionalPropertyTypes: true`.
   */
  nestedTemplates?: Record<string, string> | undefined;

  /** Deploy-only: shared dependency-graph builder (re-used for the child DAG). */
  dagBuilder?: DagBuilder;

  /** Deploy-only: shared diff calculator (re-used for the child diff). */
  diffCalculator?: DiffCalculator;

  /**
   * Deploy-only: caller's `DeployEngineOptions`. Forwarded to the child
   * `DeployEngine` so flags like `--concurrency`, `--dry-run`,
   * `--resource-timeout` propagate into the recursive deploy. The child engine
   * overlays `parameters` (from `Properties.Parameters`) and `parentStackInfo`
   * on top of these on its own.
   */
  options?: DeployEngineOptions;

  /**
   * Destroy-only: caller's `--resource-warn-after` / `--resource-timeout`
   * mirrored from `DestroyRunnerContext` so the child's recursive
   * `runDestroyForStack` sees the same per-resource deadlines.
   */
  destroyOptions?: {
    resourceWarnAfterMs?: number;
    resourceTimeoutMs?: number;
    resourceWarnAfterByType?: Record<string, number>;
    resourceTimeoutByType?: Record<string, number>;
    removeProtection?: boolean;
    profile?: string;
  };
}

const storage = new AsyncLocalStorage<NestedStackProviderContext>();

/**
 * Run `fn` inside a NestedStackProvider context scope. Calls to
 * `getCurrentNestedStackContext()` from inside `fn` (and any awaited callees)
 * return `ctx`. Nested scopes shadow outer ones — the recursive provider
 * uses this to switch the "current parent" to the child before kicking off
 * the child's deploy / destroy, so grand-nested handling resolves against
 * the right parent.
 */
export function withNestedStackContext<T>(ctx: NestedStackProviderContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Returns the current `NestedStackProviderContext`, or `undefined` when called
 * outside any `withNestedStackContext` scope (= cdkd is operating on a
 * top-level stack with no nested-stack work in flight).
 *
 * `NestedStackProvider.create / update / delete` MUST find a context here —
 * absence means a caller forgot to wrap the deploy / destroy entry point.
 */
export function getCurrentNestedStackContext(): NestedStackProviderContext | undefined {
  return storage.getStore();
}
