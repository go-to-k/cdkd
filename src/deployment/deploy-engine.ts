import pLimit from 'p-limit';
import { getLogger } from '../utils/logger.js';
import { ProvisioningError } from '../utils/error-handler.js';
import { IntrinsicFunctionResolver } from './intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { StackState, ResourceState, ResourceChange } from '../types/state.js';
import type { S3StateBackend } from '../state/s3-state-backend.js';
import type { LockManager } from '../state/lock-manager.js';
import type { DagBuilder } from '../analyzer/dag-builder.js';
import type { DiffCalculator } from '../analyzer/diff-calculator.js';
import type { ProviderRegistry } from '../provisioning/provider-registry.js';
import { TemplateParser } from '../analyzer/template-parser.js';

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
export class DeployEngine {
  private logger = getLogger().child('DeployEngine');
  private resolver = new IntrinsicFunctionResolver();

  constructor(
    private stateBackend: S3StateBackend,
    private lockManager: LockManager,
    private dagBuilder: DagBuilder,
    private diffCalculator: DiffCalculator,
    private providerRegistry: ProviderRegistry,
    private options: DeployEngineOptions = {}
  ) {
    this.options.concurrency = options.concurrency ?? 10;
    this.options.dryRun = options.dryRun ?? false;
    this.options.lockTimeout = options.lockTimeout ?? 5 * 60 * 1000; // 5 minutes
    this.options.noRollback = options.noRollback ?? false;
  }

  /**
   * Deploy a CloudFormation template
   */
  async deploy(stackName: string, template: CloudFormationTemplate): Promise<DeployResult> {
    const startTime = Date.now();
    this.logger.debug(`Starting deployment for stack: ${stackName}`);

    // TODO: Use acquireLockWithRetry for better resilience
    // Currently fails immediately if lock is held. Should retry with exponential backoff
    // to handle transient lock conflicts gracefully.

    // Acquire lock
    const lockAcquired = await this.lockManager.acquireLock(stackName, undefined, 'deploy');
    if (!lockAcquired) {
      throw new Error(
        `Failed to acquire lock for stack ${stackName}. Stack may be locked by another process.`
      );
    }

    try {
      // 1. Load current state
      const currentStateData = await this.stateBackend.getState(stackName);
      const currentState: StackState = currentStateData?.state ?? {
        version: 1,
        stackName,
        resources: {},
        outputs: {},
        lastModified: Date.now(),
      };
      const currentEtag = currentStateData?.etag;

      this.logger.debug(
        `Loaded current state: ${Object.keys(currentState.resources).length} resources`
      );

      // 2. Parse template (note: we use the original template directly for now)
      // TODO: Implement full template parsing/validation if needed
      this.logger.debug(`Template has ${Object.keys(template.Resources || {}).length} resources`);

      // 2.5. Resolve parameters from template and user input
      const parameterValues = this.resolver.resolveParameters(template, this.options.parameters);
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
      const changes = this.diffCalculator.calculateDiff(currentState, template);
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

      // 6. Execute deployment (with partial state saves after each level)
      const { state: newState, actualCounts } = await this.executeDeployment(
        template,
        currentState,
        changes,
        executionLevels,
        stackName,
        parameterValues,
        conditions,
        currentEtag,
        progress
      );

      // 7. Save final state (ETag may have been updated by partial saves)
      const newEtag = await this.stateBackend.saveState(stackName, newState);
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
      // Always release lock
      await this.lockManager.releaseLock(stackName);
      this.logger.debug('Lock released');
    }
  }

  /**
   * Execute deployment by processing resources in DAG order
   *
   * Important: DELETE operations are executed in reverse dependency order,
   * while CREATE/UPDATE follow normal dependency order.
   */
  private async executeDeployment(
    template: CloudFormationTemplate,
    currentState: StackState,
    changes: Map<string, ResourceChange>,
    executionLevels: string[][],
    stackName: string,
    parameterValues?: Record<string, unknown>,
    conditions?: Record<string, boolean>,
    currentEtag?: string,
    progress?: { current: number; total: number }
  ): Promise<{
    state: StackState;
    actualCounts: { created: number; updated: number; deleted: number; skipped: number };
  }> {
    const limit = pLimit(this.options.concurrency!);
    const newResources: Record<string, ResourceState> = { ...currentState.resources };
    const actualCounts = { created: 0, updated: 0, deleted: 0, skipped: 0 };
    const completedOperations: CompletedOperation[] = [];

    // Separate DELETE operations from CREATE/UPDATE
    const deleteChanges = new Set(
      Array.from(changes.entries())
        .filter(([_, change]) => change.changeType === 'DELETE')
        .map(([logicalId]) => logicalId)
    );

    try {
      // Step 1: Process CREATE/UPDATE in normal DAG order
      for (let levelIndex = 0; levelIndex < executionLevels.length; levelIndex++) {
        const levelNodes = executionLevels[levelIndex];
        if (!levelNodes) continue;
        const level = levelNodes.filter((id) => !deleteChanges.has(id));

        if (level.length === 0) continue;

        this.logger.info(
          `Level ${levelIndex + 1}/${executionLevels.length} (${level.length} resources)`
        );

        await Promise.all(
          level.map((logicalId) =>
            limit(async () => {
              const change = changes.get(logicalId);
              if (!change || change.changeType === 'NO_CHANGE') {
                this.logger.debug(`Skipping ${logicalId} (no change)`);
                return;
              }

              // Capture previous state before provisioning (for rollback)
              const previousState = currentState.resources[logicalId]
                ? { ...currentState.resources[logicalId] }
                : undefined;

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

              // Track completed operation for potential rollback
              completedOperations.push({
                logicalId,
                changeType: change.changeType as 'CREATE' | 'UPDATE',
                resourceType: change.resourceType,
                previousState,
                physicalId: newResources[logicalId]?.physicalId,
                properties: newResources[logicalId]?.properties,
              });
            })
          )
        );

        // Save partial state after each level to prevent orphaned resources on failure
        if (currentEtag !== undefined) {
          try {
            const partialState: StackState = {
              version: 1,
              stackName: currentState.stackName,
              resources: newResources,
              outputs: currentState.outputs,
              lastModified: Date.now(),
            };
            currentEtag = await this.stateBackend.saveState(stackName, partialState, currentEtag);
            this.logger.debug(`Partial state saved after level ${levelIndex + 1}`);
          } catch (error) {
            this.logger.warn(
              `Failed to save partial state after level ${levelIndex + 1}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }

      // Step 2: Process DELETE operations in reverse dependency order
      if (deleteChanges.size > 0) {
        this.logger.info(`Deleting ${deleteChanges.size} resource(s)`);

        // Build deletion levels from state dependencies (reverse topological order)
        const deletionLevels = this.buildDeletionLevels(deleteChanges, currentState);

        for (let levelIndex = 0; levelIndex < deletionLevels.length; levelIndex++) {
          const level = deletionLevels[levelIndex]!;
          if (level.length === 0) continue;

          await Promise.all(
            level.map((logicalId) =>
              limit(async () => {
                const change = changes.get(logicalId)!;

                const previousState = currentState.resources[logicalId]
                  ? { ...currentState.resources[logicalId] }
                  : undefined;

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

                completedOperations.push({
                  logicalId,
                  changeType: 'DELETE',
                  resourceType: change.resourceType,
                  previousState,
                });
              })
            )
          );
        }

        // Save partial state after DELETE operations
        if (currentEtag !== undefined) {
          try {
            const partialState: StackState = {
              version: 1,
              stackName: currentState.stackName,
              resources: newResources,
              outputs: currentState.outputs,
              lastModified: Date.now(),
            };
            currentEtag = await this.stateBackend.saveState(stackName, partialState, currentEtag);
            this.logger.debug('Partial state saved after DELETE operations');
          } catch (error) {
            this.logger.warn(
              `Failed to save partial state: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }
    } catch (error) {
      // Deployment failed — attempt rollback unless --no-rollback is set
      if (this.options.noRollback) {
        this.logger.warn('Deployment failed. --no-rollback is set, skipping rollback.');
        this.logger.warn('Partial state has been saved. Manual cleanup may be required.');
      } else {
        await this.performRollback(completedOperations, newResources, stackName);
      }

      // Save state after rollback (or partial state if no-rollback)
      try {
        const failureState: StackState = {
          version: 1,
          stackName: currentState.stackName,
          resources: newResources,
          outputs: currentState.outputs,
          lastModified: Date.now(),
        };
        await this.stateBackend.saveState(stackName, failureState, currentEtag);
        this.logger.debug('State saved after deployment failure');
      } catch (saveError) {
        this.logger.warn(
          `Failed to save state after deployment failure: ${saveError instanceof Error ? saveError.message : String(saveError)}`
        );
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
        version: 1,
        stackName: currentState.stackName,
        resources: newResources,
        outputs,
        lastModified: Date.now(),
      },
      actualCounts,
    };
  }

  /**
   * Perform best-effort rollback of completed operations in reverse order
   *
   * - CREATE → delete the newly created resource
   * - UPDATE → update back to previous properties
   * - DELETE → cannot rollback (resource already deleted), log warning
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

    this.logger.info(
      `Rolling back ${completedOperations.length} completed operation(s) in reverse order...`
    );

    // Process in reverse order
    for (let i = completedOperations.length - 1; i >= 0; i--) {
      const op = completedOperations[i]!;
      try {
        switch (op.changeType) {
          case 'CREATE': {
            // Rollback CREATE by deleting the newly created resource
            if (!op.physicalId) {
              this.logger.warn(
                `  Rollback: Cannot delete ${op.logicalId} — no physical ID recorded`
              );
              break;
            }

            this.logger.info(
              `  Rollback: Deleting created resource ${op.logicalId} (${op.resourceType})`
            );
            const provider = this.providerRegistry.getProvider(op.resourceType);
            await provider.delete(op.logicalId, op.physicalId, op.resourceType, op.properties);

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

    this.logger.info('Rollback completed (best-effort).');
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

          const result = await this.withRetry(
            () => provider.create(logicalId, resourceType, resolvedProps),
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
            const createResult = await this.withRetry(
              () => provider.create(logicalId, resourceType, resolvedProps),
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
                  currentResource.properties
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
            this.logger.info(`${replacePrefix}✅ ${logicalId} (${resourceType}) replaced`);
          } else {
            // Normal update (in-place)
            this.logger.debug(`Updating ${logicalId} (${resourceType})`);

            const result = await this.withRetry(
              () =>
                provider.update(
                  logicalId,
                  currentResource.physicalId,
                  resourceType,
                  resolvedProps,
                  currentProps
                ),
              logicalId
            );

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
                  currentResource.properties
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
          this.logger.info(`${deletePrefix}✅ ${logicalId} (${resourceType}) deleted`);
          break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to ${change.changeType.toLowerCase()} ${logicalId}: ${message}`);

      throw new ProvisioningError(
        `Failed to ${change.changeType.toLowerCase()} resource ${logicalId}`,
        resourceType,
        logicalId,
        stateResources[logicalId]?.physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Create a resource with retry for transient errors
   *
   * Some resources fail immediately after their dependencies are created due to
   * AWS eventual consistency (e.g., Lambda fails if IAM Role hasn't propagated yet).
   * CloudFormation handles this internally; cdkq retries with exponential backoff.
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
   * Implicit dependency map for correct deletion order.
   *
   * Key = resource type that must be deleted AFTER all value types are deleted.
   * Value = resource types that must be deleted BEFORE the key type.
   *
   * Example: InternetGateway depends on VPCGatewayAttachment being deleted first,
   * because AWS won't let you delete an IGW while it's still attached to a VPC.
   */
  private static readonly IMPLICIT_DELETE_DEPENDENCIES: Record<string, string[]> = {
    // IGW must be deleted AFTER VPCGatewayAttachment
    'AWS::EC2::InternetGateway': ['AWS::EC2::VPCGatewayAttachment'],
    // EventBus must be deleted AFTER Rules on that bus
    'AWS::Events::EventBus': ['AWS::Events::Rule'],
    // VPC must be deleted AFTER all VPC-dependent resources
    'AWS::EC2::VPC': [
      'AWS::EC2::Subnet',
      'AWS::EC2::SecurityGroup',
      'AWS::EC2::InternetGateway',
      'AWS::EC2::VPCGatewayAttachment',
      'AWS::EC2::RouteTable',
    ],
    // Subnet must be deleted AFTER RouteTableAssociation
    'AWS::EC2::Subnet': ['AWS::EC2::SubnetRouteTableAssociation'],
    // RouteTable must be deleted AFTER Route and Association
    'AWS::EC2::RouteTable': ['AWS::EC2::Route', 'AWS::EC2::SubnetRouteTableAssociation'],
    // SecurityGroup must be deleted AFTER resources that reference it
    'AWS::EC2::SecurityGroup': ['AWS::EC2::SecurityGroupIngress', 'AWS::EC2::SecurityGroupEgress'],
  };

  /**
   * Build deletion levels from state dependencies (reverse topological order).
   * Resources that are depended upon by others are deleted LAST.
   */
  private buildDeletionLevels(deleteIds: Set<string>, state: StackState): string[][] {
    // Build reverse dependency map: resource → resources that depend on it
    const dependedBy = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();

    for (const id of deleteIds) {
      if (!dependedBy.has(id)) dependedBy.set(id, new Set());
      if (!inDegree.has(id)) inDegree.set(id, 0);
    }

    for (const id of deleteIds) {
      const resource = state.resources[id];
      if (!resource?.dependencies) continue;
      for (const dep of resource.dependencies) {
        if (!deleteIds.has(dep)) continue;
        // id depends on dep → dep must be deleted AFTER id
        if (!dependedBy.has(dep)) dependedBy.set(dep, new Set());
        dependedBy.get(dep)!.add(id);
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      }
    }

    // Add implicit dependencies based on resource types.
    // For each resource being deleted, if its type has implicit dependencies,
    // find other resources being deleted that match those dependency types
    // and add edges so those dependents are deleted first.
    this.addImplicitDeleteDependencies(deleteIds, state, dependedBy);

    // Topological sort (Kahn's algorithm) — produces levels for parallel delete
    const levels: string[][] = [];
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
        // Circular dependency fallback: delete all remaining
        this.logger.warn(
          `Circular dependency detected in delete order, deleting remaining ${remaining.size} resources`
        );
        levels.push([...remaining]);
        break;
      }

      levels.push(level);
      remaining = new Set([...remaining].filter((id) => !level.includes(id)));
    }

    this.logger.debug(
      `Delete order: ${levels.length} levels - ${levels.map((l, i) => `L${i + 1}(${l.length})`).join(', ')}`
    );
    return levels;
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

      const mustDeleteAfter = DeployEngine.IMPLICIT_DELETE_DEPENDENCIES[resource.resourceType];
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
   * Execute an operation with retry for transient IAM propagation errors
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    logicalId: string,
    maxRetries: number = 5,
    initialDelayMs: number = 10_000
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);

        const isRetryable = this.isRetryableError(error, message);

        if (!isRetryable || attempt >= maxRetries) {
          throw error;
        }

        const delay = initialDelayMs * Math.pow(2, attempt);
        this.logger.info(
          `  ⏳ Retrying ${logicalId} in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries}) - ${message}`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Determine if an error is retryable (transient).
   * Checks HTTP status codes (429 throttle, 503 unavailable)
   * and IAM propagation delay message patterns.
   */
  private isRetryableError(error: unknown, message: string): boolean {
    // Check HTTP status code from AWS SDK errors
    const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
    const statusCode = metadata?.httpStatusCode;
    if (statusCode === 429 || statusCode === 503) return true;

    // Check cause chain for wrapped errors
    const cause = (error as { cause?: { $metadata?: { httpStatusCode?: number } } }).cause;
    const causeStatus = cause?.$metadata?.httpStatusCode;
    if (causeStatus === 429 || causeStatus === 503) return true;

    // IAM propagation delay patterns
    const retryablePatterns = [
      'cannot be assumed',
      'role defined for the function',
      'not authorized to perform',
      'execution role',
      'trust policy',
      'Role validation failed',
      'does not have required permissions',
      // DELETE dependency ordering (parallel deletion race conditions)
      'has dependencies and cannot be deleted',
      "can't be deleted since it has",
      'DependencyViolation',
    ];
    return retryablePatterns.some((p) => message.includes(p));
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
      } catch (error) {
        this.logger.warn(`Failed to resolve output ${outputKey}: ${String(error)}`);
        outputs[outputKey] = undefined;
      }
    }

    return outputs;
  }
}
