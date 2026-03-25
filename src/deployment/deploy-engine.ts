import pLimit from 'p-limit';
import { getLogger } from '../utils/logger.js';
import { ProvisioningError } from '../utils/error-handler.js';
import { IntrinsicFunctionResolver } from './intrinsic-function-resolver.js';
import type {
  CloudFormationTemplate,
  ResourceProvider,
  ResourceCreateResult,
} from '../types/resource.js';
import type { StackState, ResourceState, ResourceChange } from '../types/state.js';
import type { S3StateBackend } from '../state/s3-state-backend.js';
import type { LockManager } from '../state/lock-manager.js';
import type { DagBuilder } from '../analyzer/dag-builder.js';
import type { DiffCalculator } from '../analyzer/diff-calculator.js';
import type { ProviderRegistry } from '../provisioning/provider-registry.js';

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
 * TODO: Implement rollback mechanism
 * - Track all changes in a transaction log
 * - On failure, rollback in reverse order
 * - Support --no-rollback flag for debugging
 * - Similar to Terraform's behavior (no automatic rollback, manual state recovery)
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
  }

  /**
   * Deploy a CloudFormation template
   */
  async deploy(stackName: string, template: CloudFormationTemplate): Promise<DeployResult> {
    const startTime = Date.now();
    this.logger.info(`Starting deployment for stack: ${stackName}`);

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
      this.logger.info(`✓ All resource types are supported`);

      // 4. Build dependency graph
      const dag = this.dagBuilder.buildGraph(template);
      const executionLevels = this.dagBuilder.getExecutionLevels(dag);
      this.logger.info(`Dependency graph: ${executionLevels.length} execution levels`);

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
        `Changes: +${createChanges.length} ~${updateChanges.length} -${deleteChanges.length}`
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

      // 6. Execute deployment (with partial state saves after each level)
      const newState = await this.executeDeployment(
        template,
        currentState,
        changes,
        executionLevels,
        stackName,
        parameterValues,
        conditions,
        currentEtag
      );

      // 7. Save final state (ETag may have been updated by partial saves)
      const newEtag = await this.stateBackend.saveState(stackName, newState);
      this.logger.debug(`State saved (ETag: ${newEtag})`);

      const durationMs = Date.now() - startTime;

      return {
        stackName,
        created: createChanges.length,
        updated: updateChanges.length,
        deleted: deleteChanges.length,
        unchanged: this.diffCalculator.filterByType(changes, 'NO_CHANGE').length,
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
    currentEtag?: string
  ): Promise<StackState> {
    const limit = pLimit(this.options.concurrency!);
    const newResources: Record<string, ResourceState> = { ...currentState.resources };

    // Separate DELETE operations from CREATE/UPDATE
    const deleteChanges = new Set(
      Array.from(changes.entries())
        .filter(([_, change]) => change.changeType === 'DELETE')
        .map(([logicalId]) => logicalId)
    );

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

            await this.provisionResource(
              logicalId,
              change,
              newResources,
              stackName,
              template,
              parameterValues,
              conditions
            );
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

    // Step 2: Process DELETE in reverse DAG order
    if (deleteChanges.size > 0) {
      this.logger.info(`Processing ${deleteChanges.size} DELETE operations in reverse order`);

      for (let levelIndex = executionLevels.length - 1; levelIndex >= 0; levelIndex--) {
        const levelNodes = executionLevels[levelIndex];
        if (!levelNodes) continue;
        const level = levelNodes.filter((id) => deleteChanges.has(id));

        if (level.length === 0) continue;

        this.logger.info(
          `Executing reverse level ${executionLevels.length - levelIndex}/${executionLevels.length}: ${level.length} resources (DELETE)`
        );

        await Promise.all(
          level.map((logicalId) =>
            limit(async () => {
              const change = changes.get(logicalId)!;
              await this.provisionResource(
                logicalId,
                change,
                newResources,
                stackName,
                template,
                parameterValues,
                conditions
              );
            })
          )
        );

        // Save partial state after DELETE level
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
            this.logger.debug(
              `Partial state saved after reverse level ${executionLevels.length - levelIndex}`
            );
          } catch (error) {
            this.logger.warn(
              `Failed to save partial state: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }
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
      version: 1,
      stackName: currentState.stackName,
      resources: newResources,
      outputs,
      lastModified: Date.now(),
    };
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
    conditions?: Record<string, boolean>
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

          const result = await this.createWithRetry(
            provider,
            logicalId,
            resourceType,
            resolvedProps
          );

          // Extract dependencies from template
          const dependencies = template?.Resources?.[logicalId]?.DependsOn
            ? Array.isArray(template.Resources[logicalId].DependsOn)
              ? (template.Resources[logicalId].DependsOn as string[])
              : [template.Resources[logicalId].DependsOn as string]
            : undefined;

          stateResources[logicalId] = {
            physicalId: result.physicalId,
            resourceType,
            properties: resolvedProps,
            ...(result.attributes && { attributes: result.attributes }),
            ...(dependencies && { dependencies }),
          };

          this.logger.info(`  ✅ ${logicalId} (${resourceType})`);
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

          // Check if this update requires resource replacement (immutable property changed)
          const needsReplacement = change.propertyChanges?.some((pc) => pc.requiresReplacement);

          // Extract dependencies from template
          const dependencies = template?.Resources?.[logicalId]?.DependsOn
            ? Array.isArray(template.Resources[logicalId].DependsOn)
              ? (template.Resources[logicalId].DependsOn as string[])
              : [template.Resources[logicalId].DependsOn as string]
            : undefined;

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
            const createResult = await provider.create(logicalId, resourceType, resolvedProps);

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
              ...(dependencies && { dependencies }),
            };

            this.logger.info(
              `✓ Replaced ${logicalId}: ${currentResource.physicalId} → ${createResult.physicalId}`
            );
          } else {
            // Normal update (in-place)
            this.logger.debug(`Updating ${logicalId} (${resourceType})`);

            const result = await provider.update(
              logicalId,
              currentResource.physicalId,
              resourceType,
              resolvedProps,
              currentProps
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
              ...(dependencies && { dependencies }),
            };

            this.logger.info(`  ✅ ${logicalId} (${resourceType})`);
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
          await provider.delete(
            logicalId,
            currentResource.physicalId,
            resourceType,
            currentResource.properties
          );

          delete stateResources[logicalId];
          this.logger.info(`  ✅ ${logicalId} (${resourceType}) deleted`);
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
  private async createWithRetry(
    provider: ResourceProvider,
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    maxRetries: number = 3,
    initialDelayMs: number = 5_000
  ): Promise<ResourceCreateResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await provider.create(logicalId, resourceType, properties);
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);

        // Retry on transient IAM propagation errors
        const isRetryable =
          message.includes('cannot be assumed by Lambda') ||
          message.includes('role defined for the function') ||
          message.includes('not authorized to perform') ||
          message.includes('The provided execution role');

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
