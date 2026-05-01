import { getLogger } from '../utils/logger.js';
import { getLiveRenderer } from '../utils/live-renderer.js';
import { ProvisioningError } from '../utils/error-handler.js';
import { withStackName, applyDefaultNameForFallback } from '../provisioning/resource-name.js';
import { IntrinsicFunctionResolver } from './intrinsic-function-resolver.js';
import { DagExecutor } from './dag-executor.js';
import type { CloudFormationTemplate, ResourceProvider } from '../types/resource.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  type StackState,
  type ResourceState,
  type ResourceChange,
} from '../types/state.js';
import type { S3StateBackend } from '../state/s3-state-backend.js';
import type { LockManager } from '../state/lock-manager.js';
import type { DagBuilder } from '../analyzer/dag-builder.js';
import type { DiffCalculator } from '../analyzer/diff-calculator.js';
import { ProviderRegistry } from '../provisioning/provider-registry.js';
import { CloudControlProvider } from '../provisioning/cloud-control-provider.js';
import { TemplateParser } from '../analyzer/template-parser.js';
import { IMPLICIT_DELETE_DEPENDENCIES } from '../analyzer/implicit-delete-deps.js';
import { withRetry } from './retry.js';

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
  /** Previous resource state (for UPDATE rollback) */
  previousState?: ResourceState | undefined;
  /** Physical ID of newly created resource (for CREATE rollback) */
  physicalId?: string | undefined;
  /** Properties used for creation (for CREATE rollback / delete) */
  properties?: Record<string, unknown> | undefined;
}

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
 * Error thrown when deployment is interrupted by SIGINT
 */
class InterruptedError extends Error {
  constructor() {
    super('Deployment interrupted by user (Ctrl+C)');
    this.name = 'InterruptedError';
  }
}

export class DeployEngine {
  private logger = getLogger().child('DeployEngine');
  private resolver: IntrinsicFunctionResolver;
  private interrupted = false;

  /**
   * Target region for this stack. Required — load-bearing for the
   * region-prefixed S3 state key and recorded in state.json for
   * cross-region destroy.
   */
  private stackRegion: string;

  constructor(
    private stateBackend: S3StateBackend,
    private lockManager: LockManager,
    private dagBuilder: DagBuilder,
    private diffCalculator: DiffCalculator,
    private providerRegistry: ProviderRegistry,
    private options: DeployEngineOptions = {},
    stackRegion: string
  ) {
    this.stackRegion = stackRegion;
    this.resolver = new IntrinsicFunctionResolver(stackRegion);
    this.options.concurrency = options.concurrency ?? 10;
    this.options.dryRun = options.dryRun ?? false;
    this.options.lockTimeout = options.lockTimeout ?? 5 * 60 * 1000; // 5 minutes
    this.options.noRollback = options.noRollback ?? false;
  }

  /**
   * Deploy a CloudFormation template
   */
  async deploy(stackName: string, template: CloudFormationTemplate): Promise<DeployResult> {
    // Scope `stackName` to this deploy's async chain so concurrent
    // deploys (--stack-concurrency > 1) don't see each other's value.
    // See `src/provisioning/resource-name.ts` for the AsyncLocalStorage
    // background.
    return withStackName(stackName, () => this.doDeploy(stackName, template));
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
    const sigintHandler = () => {
      // Route the interrupt notice through the live renderer so it does not
      // collide with the in-flight task display.
      renderer.printAbove(() => {
        process.stderr.write(
          '\nInterrupted — saving partial state after current operations complete...\n'
        );
      });
      this.interrupted = true;
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
      const context = {
        template,
        resources: currentState.resources,
        ...(Object.keys(parameterValues).length > 0 && { parameters: parameterValues }),
        stateBackend: this.stateBackend,
        stackName,
      };
      const conditions = await this.resolver.evaluateConditions(context);
      this.logger.debug(
        `Evaluated ${Object.keys(conditions).length} conditions: ${Object.keys(conditions).join(', ')}`
      );

      // 3. Validate resource types (before deployment starts)
      // Skip metadata resources as they don't actually deploy
      const resourceTypes = new Set(
        Object.values(template.Resources || {})
          .map((r) => r.Type)
          .filter((type) => type !== 'AWS::CDK::Metadata')
      );
      this.providerRegistry.validateResourceTypes(resourceTypes);
      this.logger.debug(`All resource types validated`);

      // 4. Build dependency graph
      const dag = this.dagBuilder.buildGraph(template);
      const executionLevels = this.dagBuilder.getExecutionLevels(dag);
      this.logger.debug(`Dependency graph: ${executionLevels.length} execution levels`);

      // 5. Calculate diff
      // Pass a best-effort resolver so that changes hidden inside intrinsics (e.g.
      // `Fn::Join` literal args like "-value" -> "-value2") are detected against
      // the already-resolved values stored in state.
      const diffResolverContext = {
        template,
        resources: currentState.resources,
        ...(Object.keys(parameterValues).length > 0 && { parameters: parameterValues }),
        ...(Object.keys(conditions).length > 0 && { conditions }),
        stateBackend: this.stateBackend,
        stackName,
      };
      const diffResolveFn = (value: unknown) => this.resolver.resolve(value, diffResolverContext);
      const changes = await this.diffCalculator.calculateDiff(
        currentState,
        template,
        diffResolveFn
      );
      const hasChanges = this.diffCalculator.hasChanges(changes);

      if (!hasChanges) {
        this.logger.info('No changes detected. Stack is up to date.');
        return {
          stackName,
          created: 0,
          updated: 0,
          deleted: 0,
          unchanged: Object.keys(currentState.resources).length,
          durationMs: Date.now() - startTime,
        };
      }

      // Log changes summary
      const createChanges = this.diffCalculator.filterByType(changes, 'CREATE');
      const updateChanges = this.diffCalculator.filterByType(changes, 'UPDATE');
      const deleteChanges = this.diffCalculator.filterByType(changes, 'DELETE');

      this.logger.info(
        `Changes: ${createChanges.length} to create, ${updateChanges.length} to update, ${deleteChanges.length} to delete`
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
        template,
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

      // 7. Save final state (ETag may have been updated by partial saves).
      // The legacy migration delete (when migrationPending) was already done by
      // the first per-resource save inside executeDeployment, so this final
      // save is unconditionally region-scoped.
      const newEtag = await this.stateBackend.saveState(stackName, this.stackRegion, newState);
      this.logger.debug(`State saved (ETag: ${newEtag})`);

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
      };
    } finally {
      // Stop live renderer (clears any remaining in-flight task display)
      renderer.stop();

      // Remove SIGINT handler
      process.removeListener('SIGINT', sigintHandler);

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
            lastModified: Date.now(),
          };
          // Migration is a one-shot tail on the first save; subsequent saves
          // overwrite the new key in-place under optimistic locking.
          const migrate = pendingMigration;
          const expectedEtag = migrate ? undefined : currentEtag;
          currentEtag = await this.stateBackend.saveState(
            stackName,
            this.stackRegion,
            partialState,
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
          `Deploying ${createUpdateIds.length} resource(s) (DAG: ${executionLevels.length} levels, max parallel: ${concurrency})`
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
                throw provisionError;
              }

              completedOperations.push({
                logicalId,
                changeType: change.changeType as 'CREATE' | 'UPDATE',
                resourceType: change.resourceType,
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
          throw new InterruptedError();
        }
      }

      // Step 2: Process DELETE operations in reverse dependency order.
      if (deleteChanges.size > 0) {
        this.logger.info(`Deleting ${deleteChanges.size} resource(s)`);

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
                throw provisionError;
              }

              completedOperations.push({
                logicalId,
                changeType: 'DELETE',
                resourceType: change.resourceType,
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
          throw new InterruptedError();
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
          lastModified: Date.now(),
        };
        const migrate = pendingMigration;
        const expectedEtag = migrate ? undefined : currentEtag;
        currentEtag = await this.stateBackend.saveState(
          stackName,
          this.stackRegion,
          preRollbackState,
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
          lastModified: Date.now(),
        };
        await this.stateBackend.saveState(stackName, this.stackRegion, postRollbackState, {
          ...(currentEtag !== undefined && { expectedEtag: currentEtag }),
        });
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
            lastModified: Date.now(),
          };
          await this.stateBackend.saveState(stackName, this.stackRegion, postRollbackState, {
            ...(freshEtag !== undefined && { expectedEtag: freshEtag }),
          });
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
    _stackName: string
  ): Promise<void> {
    if (completedOperations.length === 0) {
      this.logger.info('No completed operations to roll back.');
      return;
    }

    this.logger.info(`Rolling back ${completedOperations.length} completed operation(s)...`);

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
      await this.performSingleRollback(op, stateResources);
    }

    // Step 2: Process CREATE rollbacks (deletions) in dependency-aware order
    // (reverse dependency: dependents are deleted before their dependencies)
    if (createOps.length > 0) {
      const sortedCreateOps = this.sortRollbackCreates(createOps, stateResources);
      for (const op of sortedCreateOps) {
        await this.performSingleRollback(op, stateResources);
      }
    }

    this.logger.info('Rollback completed. Some resources may remain if deletion failed.');
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
    stateResources: Record<string, ResourceState>
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
          const provider = this.providerRegistry.getProvider(op.resourceType);
          await provider.delete(op.logicalId, op.physicalId, op.resourceType, op.properties, {
            expectedRegion: this.stackRegion,
          });

          // Remove from state
          delete stateResources[op.logicalId];
          this.logger.info(`  Rollback: ${op.logicalId} deleted successfully`);
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
          const provider = this.providerRegistry.getProvider(op.resourceType);
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
    const provider = this.providerRegistry.getProvider(resourceType);

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
    renderer.addTask(logicalId, `${verb} ${logicalId} (${resourceType})`);

    try {
      switch (change.changeType) {
        case 'CREATE': {
          const desiredProps = change.desiredProperties || {};

          // Resolve intrinsic functions in properties
          const context = {
            template: template!,
            resources: stateResources,
            ...(parameterValues &&
              Object.keys(parameterValues).length > 0 && { parameters: parameterValues }),
            ...(conditions && Object.keys(conditions).length > 0 && { conditions }),
            stateBackend: this.stateBackend,
            stackName,
          };

          const resolvedProps = (await this.resolver.resolve(desiredProps, context)) as Record<
            string,
            unknown
          >;

          // Safety net: if SDK provider doesn't handle all template properties,
          // fall back to CC API for create to ensure no properties are silently dropped
          const { provider: createProvider, properties: createProps } =
            this.selectProviderWithSafetyNet(provider, resourceType, resolvedProps, logicalId);

          const result = await this.withRetry(
            () => createProvider.create(logicalId, resourceType, createProps),
            logicalId
          );

          // Extract ALL dependencies from template (Ref, Fn::GetAtt, DependsOn)
          // so that deletion order is correct even without implicit type-based deps
          const dependencies = this.extractAllDependencies(template, logicalId);

          stateResources[logicalId] = {
            physicalId: result.physicalId,
            resourceType,
            properties: resolvedProps,
            ...(result.attributes && { attributes: result.attributes }),
            ...(dependencies && dependencies.length > 0 && { dependencies }),
          };

          if (counts) counts.created++;
          if (progress) progress.current++;
          const createPrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
          renderer.removeTask(logicalId);
          this.logger.info(`${createPrefix}✅ ${logicalId} (${resourceType}) created`);
          break;
        }

        case 'UPDATE': {
          const currentResource = stateResources[logicalId];
          if (!currentResource) {
            throw new Error(`Cannot update ${logicalId}: resource not found in state`);
          }

          const desiredProps = change.desiredProperties || {};
          const currentProps = change.currentProperties || {};

          // Resolve intrinsic functions in properties
          const context = {
            template: template!,
            resources: stateResources,
            ...(parameterValues &&
              Object.keys(parameterValues).length > 0 && { parameters: parameterValues }),
            ...(conditions && Object.keys(conditions).length > 0 && { conditions }),
            stateBackend: this.stateBackend,
            stackName,
          };

          const resolvedProps = (await this.resolver.resolve(desiredProps, context)) as Record<
            string,
            unknown
          >;

          // Re-check diff after resolving intrinsic functions
          // DiffCalculator compares unresolved template vs resolved state, which may produce false positives
          if (JSON.stringify(resolvedProps) === JSON.stringify(currentProps)) {
            this.logger.debug(
              `Skipping ${logicalId}: no actual changes after intrinsic function resolution`
            );
            if (counts) counts.skipped++;
            break;
          }

          // Check if this update requires resource replacement (immutable property changed)
          const needsReplacement = change.propertyChanges?.some((pc) => pc.requiresReplacement);

          // Extract ALL dependencies from template (Ref, Fn::GetAtt, DependsOn)
          const dependencies = this.extractAllDependencies(template, logicalId);

          if (needsReplacement) {
            // Resource replacement: DELETE old → CREATE new
            const replacedProps = change.propertyChanges
              ?.filter((pc) => pc.requiresReplacement)
              .map((pc) => pc.path)
              .join(', ');
            this.logger.info(
              `Replacing ${logicalId} (${resourceType}) - immutable properties changed: ${replacedProps}`
            );

            // 1. Create new resource first (CFn order: safe - old resource survives if CREATE fails)
            this.logger.info(`  Creating new ${logicalId}...`);
            const { provider: replaceProvider, properties: replaceProps } =
              this.selectProviderWithSafetyNet(provider, resourceType, resolvedProps, logicalId);
            const createResult = await this.withRetry(
              () => replaceProvider.create(logicalId, resourceType, replaceProps),
              logicalId
            );

            // 2. Delete old resource (after successful CREATE)
            const updateReplacePolicy = template?.Resources?.[logicalId]?.UpdateReplacePolicy;

            if (updateReplacePolicy === 'Retain') {
              this.logger.info(
                `  Retaining old ${logicalId} (${currentResource.physicalId}) - UpdateReplacePolicy: Retain`
              );
            } else {
              this.logger.info(`  Deleting old ${logicalId} (${currentResource.physicalId})...`);
              try {
                await provider.delete(
                  logicalId,
                  currentResource.physicalId,
                  resourceType,
                  currentResource.properties,
                  { expectedRegion: this.stackRegion }
                );
                this.logger.info(`  ✓ Old resource deleted`);
              } catch (deleteError) {
                this.logger.warn(
                  `  ⚠ Failed to delete old resource ${logicalId} (${currentResource.physicalId}): ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`
                );
              }
            }

            stateResources[logicalId] = {
              physicalId: createResult.physicalId,
              resourceType,
              properties: resolvedProps,
              ...(createResult.attributes && { attributes: createResult.attributes }),
              ...(dependencies && dependencies.length > 0 && { dependencies }),
            };

            if (counts) counts.updated++;
            if (progress) progress.current++;
            const replacePrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
            renderer.removeTask(logicalId);
            this.logger.info(`${replacePrefix}✅ ${logicalId} (${resourceType}) replaced`);
          } else {
            // Normal update (in-place)
            this.logger.debug(`Updating ${logicalId} (${resourceType})`);

            // Safety net: fall back to CC API if SDK provider doesn't handle all properties
            const { provider: updateProvider, properties: updateProps } =
              this.selectProviderWithSafetyNet(provider, resourceType, resolvedProps, logicalId);

            let result;
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
                logicalId
              );
            } catch (updateError) {
              // If UPDATE is not supported (e.g., CC API UnsupportedActionException),
              // fall back to DELETE → CREATE (replacement)
              const msg = updateError instanceof Error ? updateError.message : String(updateError);
              if (
                msg.includes('UnsupportedActionException') ||
                msg.includes('does not support UPDATE')
              ) {
                this.logger.info(
                  `UPDATE not supported for ${logicalId} (${resourceType}), replacing (DELETE → CREATE)`
                );
                try {
                  await provider.delete(
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
                const { provider: replProvider, properties: replProps } =
                  this.selectProviderWithSafetyNet(
                    provider,
                    resourceType,
                    resolvedProps,
                    logicalId
                  );
                const createResult = await this.withRetry(
                  () => replProvider.create(logicalId, resourceType, replProps),
                  logicalId
                );
                result = {
                  physicalId: createResult.physicalId,
                  attributes: createResult.attributes,
                  wasReplaced: true,
                };
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
            };

            if (counts) counts.updated++;
            if (progress) progress.current++;
            const updatePrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
            renderer.removeTask(logicalId);
            this.logger.info(`${updatePrefix}✅ ${logicalId} (${resourceType}) updated`);
          }
          break;
        }

        case 'DELETE': {
          const currentResource = stateResources[logicalId];
          if (!currentResource) {
            throw new Error(`Cannot delete ${logicalId}: resource not found in state`);
          }

          // Check DeletionPolicy from template
          const deletionPolicy = template?.Resources?.[logicalId]?.DeletionPolicy;
          if (deletionPolicy === 'Retain') {
            this.logger.info(`Retaining ${logicalId} (${resourceType}) - DeletionPolicy: Retain`);
            delete stateResources[logicalId];
            break;
          }

          this.logger.debug(`Deleting ${logicalId} (${resourceType})`);
          try {
            await this.withRetry(
              () =>
                provider.delete(
                  logicalId,
                  currentResource.physicalId,
                  resourceType,
                  currentResource.properties,
                  { expectedRegion: this.stackRegion }
                ),
              logicalId,
              3, // fewer retries for DELETE
              5_000
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
          this.logger.info(`${deletePrefix}✅ ${logicalId} (${resourceType}) deleted`);
          break;
        }
      }
    } catch (error) {
      renderer.removeTask(logicalId);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to ${change.changeType.toLowerCase()} ${logicalId}: ${message}`);

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
  }

  /**
   * Select the appropriate provider for create/update, falling back to CC API
   * if the SDK provider doesn't handle all template properties.
   *
   * This safety net prevents properties from being silently dropped when an SDK
   * provider only maps a subset of CloudFormation properties.
   *
   * DELETE always uses the SDK provider (force-delete, cleanup, etc.).
   */
  private selectProviderWithSafetyNet(
    sdkProvider: ResourceProvider,
    resourceType: string,
    resolvedProps: Record<string, unknown>,
    logicalId: string
  ): { provider: ResourceProvider; properties: Record<string, unknown> } {
    const handledSet = sdkProvider.handledProperties?.get(resourceType);
    if (!handledSet) {
      // Provider doesn't declare handledProperties for this type — assume full coverage
      return { provider: sdkProvider, properties: resolvedProps };
    }

    const templateProps = Object.keys(resolvedProps);
    const unhandledProps = templateProps.filter((p) => !handledSet.has(p));

    if (unhandledProps.length === 0) {
      // All properties are handled by the SDK provider
      return { provider: sdkProvider, properties: resolvedProps };
    }

    // There are unhandled properties — try to fall back to CC API
    if (
      CloudControlProvider.isSupportedResourceType(resourceType) &&
      !sdkProvider.disableCcApiFallback
    ) {
      this.logger.info(
        `${logicalId}: SDK provider does not handle [${unhandledProps.join(', ')}] — falling back to CC API for create/update`
      );

      // Apply default name generation so CC API uses the same names SDK provider would have.
      // If the provider has custom pre-processing, use that instead.
      const fallbackProps = sdkProvider.preparePropertiesForFallback
        ? sdkProvider.preparePropertiesForFallback(logicalId, resourceType, resolvedProps)
        : applyDefaultNameForFallback(logicalId, resourceType, resolvedProps);

      return {
        provider: this.providerRegistry.getCloudControlProvider(),
        properties: fallbackProps,
      };
    }

    // CC API fallback not available — fail to prevent silent property loss
    const reason = sdkProvider.disableCcApiFallback
      ? 'CC API fallback is disabled for this provider (known CC API issues)'
      : `CC API does not support ${resourceType}`;
    throw new ProvisioningError(
      `SDK provider for ${resourceType} does not handle properties [${unhandledProps.join(', ')}] ` +
        `and ${reason}. ` +
        `These properties would be silently dropped. ` +
        `Please update the SDK provider to handle all required properties.`,
      resourceType,
      logicalId,
      ''
    );
  }

  /**
   * Execute an operation with retry for transient IAM propagation errors.
   *
   * Thin wrapper over `withRetry` from ./retry.js that injects this engine's
   * SIGINT-aware interrupt check and logger. The actual backoff schedule
   * lives there.
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    logicalId: string,
    maxRetries?: number,
    initialDelayMs?: number
  ): Promise<T> {
    return withRetry(operation, logicalId, {
      ...(maxRetries !== undefined && { maxRetries }),
      ...(initialDelayMs !== undefined && { initialDelayMs }),
      logger: this.logger,
      isInterrupted: () => this.interrupted,
      onInterrupted: () => new InterruptedError(),
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
    const context = {
      template: template,
      resources: resources,
      ...(parameterValues &&
        Object.keys(parameterValues).length > 0 && { parameters: parameterValues }),
      ...(conditions && Object.keys(conditions).length > 0 && { conditions }),
      stateBackend: this.stateBackend,
      stackName,
    };

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
}
