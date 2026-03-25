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

      // 6. Execute deployment
      const newState = await this.executeDeployment(
        template,
        currentState,
        changes,
        executionLevels
      );

      // 7. Save new state with optimistic locking
      // currentEtag is the old ETag - S3 will only save if the current state matches this ETag
      const newEtag = await this.stateBackend.saveState(stackName, newState, currentEtag);
      this.logger.info(`✓ State saved successfully (new ETag: ${newEtag})`);

      const durationMs = Date.now() - startTime;
      this.logger.info(`Deployment completed in ${(durationMs / 1000).toFixed(2)}s`);

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
    executionLevels: string[][]
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
        `Executing level ${levelIndex + 1}/${executionLevels.length}: ${level.length} resources (CREATE/UPDATE)`
      );

      await Promise.all(
        level.map((logicalId) =>
          limit(async () => {
            const change = changes.get(logicalId);
            if (!change || change.changeType === 'NO_CHANGE') {
              this.logger.debug(`Skipping ${logicalId} (no change)`);
              return;
            }

            await this.provisionResource(logicalId, change, newResources, template);
          })
        )
      );

      this.logger.debug(`Level ${levelIndex + 1} completed`);
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
              await this.provisionResource(logicalId, change, newResources, template);
            })
          )
        );

        this.logger.debug(`Reverse level ${executionLevels.length - levelIndex} completed`);
      }
    }

    // Resolve outputs
    const outputs = this.resolveOutputs(template, newResources);

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
    template?: CloudFormationTemplate
  ): Promise<void> {
    const resourceType = change.resourceType;
    const provider = this.providerRegistry.getProvider(resourceType);

    try {
      switch (change.changeType) {
        case 'CREATE': {
          this.logger.info(`Creating ${logicalId} (${resourceType})`);
          const desiredProps = change.desiredProperties || {};

          // Resolve intrinsic functions in properties
          const context = template?.Parameters
            ? {
                template: template,
                resources: stateResources,
                parameters: template.Parameters,
              }
            : {
                template: template!,
                resources: stateResources,
              };

          const resolvedProps = this.resolver.resolve(desiredProps, context) as Record<
            string,
            unknown
          >;

          const result = await provider.create(logicalId, resourceType, resolvedProps);

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

          this.logger.info(`✓ Created ${logicalId}: ${result.physicalId}`);
          break;
        }

        case 'UPDATE': {
          this.logger.info(`Updating ${logicalId} (${resourceType})`);
          const currentResource = stateResources[logicalId];
          if (!currentResource) {
            throw new Error(`Cannot update ${logicalId}: resource not found in state`);
          }

          const desiredProps = change.desiredProperties || {};
          const currentProps = change.currentProperties || {};

          // Resolve intrinsic functions in properties
          const context = template?.Parameters
            ? {
                template: template,
                resources: stateResources,
                parameters: template.Parameters,
              }
            : {
                template: template!,
                resources: stateResources,
              };

          const resolvedProps = this.resolver.resolve(desiredProps, context) as Record<
            string,
            unknown
          >;

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

          this.logger.info(`✓ Updated ${logicalId}`);
          break;
        }

        case 'DELETE': {
          this.logger.info(`Deleting ${logicalId} (${resourceType})`);
          const currentResource = stateResources[logicalId];
          if (!currentResource) {
            throw new Error(`Cannot delete ${logicalId}: resource not found in state`);
          }

          await provider.delete(logicalId, currentResource.physicalId, resourceType);

          delete stateResources[logicalId];
          this.logger.info(`✓ Deleted ${logicalId}`);
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
   * Resolve stack outputs from template and resource attributes
   *
   * Limitations:
   * - Only supports Ref and Fn::GetAtt intrinsic functions
   * - Does NOT support: Fn::Sub, Fn::Join, Fn::Select, Fn::ImportValue, etc.
   * - Complex outputs with unsupported functions will fail silently and return undefined
   *
   * TODO: Implement full CloudFormation intrinsic function support
   */
  private resolveOutputs(
    template: CloudFormationTemplate,
    resources: Record<string, ResourceState>
  ): Record<string, unknown> {
    if (!template.Outputs) {
      return {};
    }

    const outputs: Record<string, unknown> = {};

    for (const [outputKey, output] of Object.entries(template.Outputs)) {
      try {
        const value = this.resolveValue(output.Value, template, resources);
        outputs[outputKey] = value;
      } catch (error) {
        this.logger.warn(`Failed to resolve output ${outputKey}: ${String(error)}`);
        outputs[outputKey] = undefined;
      }
    }

    return outputs;
  }

  /**
   * Resolve a template value (Ref, Fn::GetAtt, etc.)
   *
   * TODO: Support Ref for Parameters
   * Currently, Ref only resolves to resource physical IDs.
   * Need to also check template.Parameters and resolve parameter values.
   */
  private resolveValue(
    value: unknown,
    template: CloudFormationTemplate,
    resources: Record<string, ResourceState>
  ): unknown {
    if (typeof value !== 'object' || value === null) {
      return value;
    }

    const obj = value as Record<string, unknown>;

    // Ref
    if ('Ref' in obj) {
      const logicalId = obj['Ref'] as string;

      // Check if it's a resource
      const resource = resources[logicalId];
      if (resource) {
        return resource.physicalId;
      }

      // TODO: Check if it's a parameter
      // if (template.Parameters?.[logicalId]) {
      //   return resolvedParameterValue;
      // }

      throw new Error(`Resource or parameter ${logicalId} not found`);
    }

    // Fn::GetAtt
    if ('Fn::GetAtt' in obj) {
      const getAtt = obj['Fn::GetAtt'] as [string, string];
      const [logicalId, attributeName] = getAtt;
      const resource = resources[logicalId];
      if (!resource) {
        throw new Error(`Resource ${logicalId} not found`);
      }
      return resource.attributes?.[attributeName] ?? resource.physicalId;
    }

    // Recursively resolve nested objects/arrays
    if (Array.isArray(value)) {
      return value.map((v) => this.resolveValue(v, template, resources));
    }

    const resolved: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      resolved[key] = this.resolveValue(val, template, resources);
    }
    return resolved;
  }
}
