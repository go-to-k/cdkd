import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  stateOptions,
  stackOptions,
  destroyOptions,
  contextOptions,
  parseContextOptions,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer } from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { DagBuilder } from '../../analyzer/dag-builder.js';
import { IMPLICIT_DELETE_DEPENDENCIES } from '../../analyzer/implicit-delete-deps.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import * as readline from 'node:readline/promises';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';
import { matchStacks, describeStack, type StackLike } from '../stack-matcher.js';

/**
 * Destroy command implementation
 */
async function destroyCommand(
  stackArgs: string[],
  options: {
    app?: string;
    output?: string;
    stateBucket?: string;
    statePrefix: string;
    stack?: string;
    all?: boolean;
    region?: string;
    profile?: string;
    yes: boolean;
    force: boolean;
    verbose: boolean;
    context?: string[];
  }
): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  // Resolve --state-bucket from CLI, env, cdk.json, or default
  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  logger.info('Starting stack destruction...');
  logger.debug('Options:', options);

  // Initialize AWS clients with region/profile
  // Also set AWS_REGION env for providers using local SDK clients
  if (options.region) {
    process.env['AWS_REGION'] = options.region;
    process.env['AWS_DEFAULT_REGION'] = options.region;
  }
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    // 1. Initialize components
    const stateConfig = {
      bucket: stateBucket,
      prefix: options.statePrefix,
    };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig);
    // Fail fast if the state bucket is missing, before synth or any destructive work.
    await stateBackend.verifyBucketExists();
    const lockManager = new LockManager(awsClients.s3, stateConfig);
    const dagBuilder = new DagBuilder();
    const providerRegistry = new ProviderRegistry();

    // Register all SDK providers
    registerAllProviders(providerRegistry);

    // Configure custom resource response handling via S3
    providerRegistry.setCustomResourceResponseBucket(stateBucket);

    // 2. Resolve stacks to destroy (CDK CLI compatible behavior)
    // Always synth to determine which stacks belong to this CDK app.
    const appCmd = options.app || resolveApp();
    let appStacks: StackLike[] = [];

    if (appCmd) {
      try {
        const synthesizer = new Synthesizer();
        const context = parseContextOptions(options.context);
        const result = await synthesizer.synthesize({
          app: appCmd,
          output: options.output || 'cdk.out',
          ...(Object.keys(context).length > 0 && { context }),
        });
        appStacks = result.stacks.map((s) => ({
          stackName: s.stackName,
          displayName: s.displayName,
        }));
      } catch {
        logger.debug('Could not synthesize app, falling back to state-based stack list');
      }
    }

    // Determine candidate stacks. State only carries physical names, so when synth
    // is unavailable we fall back to a stackName-only candidate list (display-path
    // patterns like "MyStage/MyStack" simply will not match anything in that mode).
    const allStateStacks = await stateBackend.listStacks();
    let candidateStacks: StackLike[];
    if (appStacks.length > 0) {
      // App synth succeeded: only consider stacks from this app
      const stateSet = new Set(allStateStacks);
      candidateStacks = appStacks.filter((s) => stateSet.has(s.stackName));
    } else if (stackArgs.length > 0 || options.stack || options.all) {
      // No synth but explicit stack names or --all given: use state stacks
      candidateStacks = allStateStacks.map((name) => ({ stackName: name }));
    } else {
      // No synth and no explicit stacks: refuse to guess
      throw new Error(
        'Could not determine which stacks belong to this app. ' +
          'Specify stack names explicitly, use --all, or ensure --app / cdk.json is configured.'
      );
    }

    const stackPatterns = stackArgs.length > 0 ? stackArgs : options.stack ? [options.stack] : [];

    let stackNames: string[];
    if (options.all) {
      // --all: destroy all stacks in the current app
      stackNames = candidateStacks.map((s) => s.stackName);
    } else if (stackPatterns.length > 0) {
      // Explicit stack names or wildcards
      stackNames = matchStacks(candidateStacks, stackPatterns).map((s) => s.stackName);
    } else if (candidateStacks.length === 1) {
      // Single stack: auto-select (CDK CLI compatible)
      stackNames = candidateStacks.map((s) => s.stackName);
    } else if (candidateStacks.length === 0) {
      logger.info('No stacks found in state');
      return;
    } else {
      throw new Error(
        `Multiple stacks found: ${candidateStacks.map(describeStack).join(', ')}. ` +
          `Specify stack name(s) or use --all`
      );
    }

    if (stackNames.length === 0) {
      logger.info('No matching stacks found in state');
      return;
    }

    logger.info(`Found ${stackNames.length} stack(s) to destroy: ${stackNames.join(', ')}`);

    // 3. Process each stack
    for (const stackName of stackNames) {
      logger.info(`\nPreparing to destroy stack: ${stackName}`);

      // Load current state
      const stateResult = await stateBackend.getState(stackName);
      if (!stateResult) {
        logger.warn(`No state found for stack ${stackName}, skipping`);
        continue;
      }
      const currentState = stateResult.state;

      const resourceCount = Object.keys(currentState.resources).length;
      if (resourceCount === 0) {
        logger.info(`Stack ${stackName} has no resources, cleaning up state...`);
        await stateBackend.deleteState(stackName);
        logger.info('✓ State deleted');
        continue;
      }

      // Show resources to be deleted
      logger.info(`\nResources to be deleted (${resourceCount}):`);
      for (const [logicalId, resource] of Object.entries(currentState.resources)) {
        logger.info(`  - ${logicalId} (${resource.resourceType})`);
      }

      // 4. Confirm (unless -y/--yes or --force)
      if (!options.yes && !options.force) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await rl.question(
          `\nAre you sure you want to destroy stack "${stackName}" and delete all ${resourceCount} resources? (Y/n): `
        );
        rl.close();

        const trimmed = answer.trim().toLowerCase();
        if (trimmed === 'n' || trimmed === 'no') {
          logger.info('Destroy cancelled');
          continue;
        }
      }

      // 5. Switch region if stack was deployed to a different region
      const stackRegion = currentState.region;
      let destroyProviderRegistry = providerRegistry;
      let destroyAwsClients: AwsClients | undefined;

      if (stackRegion && stackRegion !== region) {
        logger.info(`Stack region: ${stackRegion}`);
        process.env['AWS_REGION'] = stackRegion;
        process.env['AWS_DEFAULT_REGION'] = stackRegion;

        destroyAwsClients = new AwsClients({
          region: stackRegion,
          ...(options.profile && { profile: options.profile }),
        });
        setAwsClients(destroyAwsClients);

        destroyProviderRegistry = new ProviderRegistry();
        registerAllProviders(destroyProviderRegistry);
        destroyProviderRegistry.setCustomResourceResponseBucket(stateBucket);
      }

      // Acquire lock (always uses base region for state bucket)
      logger.info(`\nAcquiring lock for stack ${stackName}...`);
      await lockManager.acquireLock(stackName, 'destroy');

      try {
        // 6. Build dependency graph from current state
        logger.info('Building dependency graph...');

        // Create a minimal template from current state for DAG building
        const template = {
          AWSTemplateFormatVersion: '2010-09-09',
          Resources: {} as Record<
            string,
            { Type: string; Properties: Record<string, unknown>; DependsOn?: string[] }
          >,
        };

        for (const [logicalId, resource] of Object.entries(currentState.resources)) {
          template.Resources[logicalId] = {
            Type: resource.resourceType,
            Properties: resource.properties || {},
            ...(resource.dependencies &&
              resource.dependencies.length > 0 && {
                DependsOn: resource.dependencies,
              }),
          };
        }

        // Type-based implicit deletion ordering rules are shared with the
        // deploy DELETE phase (src/analyzer/implicit-delete-deps.ts).

        // Build type → logicalId index
        const typeToLogicalIds = new Map<string, string[]>();
        for (const [logicalId, resource] of Object.entries(currentState.resources)) {
          const ids = typeToLogicalIds.get(resource.resourceType) ?? [];
          ids.push(logicalId);
          typeToLogicalIds.set(resource.resourceType, ids);
        }

        for (const [logicalId, resource] of Object.entries(currentState.resources)) {
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

        const graph = dagBuilder.buildGraph(template);
        const executionLevels = dagBuilder.getExecutionLevels(graph);

        logger.debug(`Dependency graph: ${executionLevels.length} level(s)`);

        let deletedCount = 0;
        let errorCount = 0;

        // Process levels in reverse order for deletion
        for (let levelIndex = executionLevels.length - 1; levelIndex >= 0; levelIndex--) {
          const level = executionLevels[levelIndex];
          if (!level) {
            continue;
          }

          logger.debug(
            `Deletion level ${executionLevels.length - levelIndex}/${executionLevels.length} (${level.length} resources)`
          );

          // Delete resources in parallel within each level
          const deletePromises = level.map(async (logicalId) => {
            const resource = currentState.resources[logicalId];
            if (!resource) {
              logger.warn(`Resource ${logicalId} not found in state, skipping`);
              return;
            }

            try {
              const provider = destroyProviderRegistry.getProvider(resource.resourceType);
              // Retry DELETE for transient errors (throttle, dependency race)
              let lastDeleteError: unknown;
              for (let attempt = 0; attempt <= 3; attempt++) {
                try {
                  await provider.delete(
                    logicalId,
                    resource.physicalId,
                    resource.resourceType,
                    resource.properties
                  );
                  lastDeleteError = null;
                  break;
                } catch (retryError) {
                  lastDeleteError = retryError;
                  const msg = retryError instanceof Error ? retryError.message : String(retryError);
                  const isRetryable =
                    msg.includes('Too Many Requests') ||
                    msg.includes('has dependencies') ||
                    msg.includes("can't be deleted since") ||
                    msg.includes('DependencyViolation');
                  if (!isRetryable || attempt >= 3) break;
                  const delay = 5000 * Math.pow(2, attempt);
                  logger.debug(
                    `  ⏳ Retrying delete ${logicalId} in ${delay / 1000}s (attempt ${attempt + 1}/3)`
                  );
                  await new Promise((resolve) => setTimeout(resolve, delay));
                }
              }
              if (lastDeleteError) throw lastDeleteError;

              logger.info(`  ✅ ${logicalId} (${resource.resourceType}) deleted`);
              deletedCount++;
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              // Treat "not found" as already deleted
              if (
                msg.includes('does not exist') ||
                msg.includes('not found') ||
                msg.includes('No policy found') ||
                msg.includes('NoSuchEntity') ||
                msg.includes('NotFoundException')
              ) {
                logger.debug(`  ${logicalId} already deleted, removing from state`);
                deletedCount++;
              } else {
                logger.error(`  ✗ Failed to delete ${logicalId}:`, String(error));
                errorCount++;
              }
            }
          });

          await Promise.all(deletePromises);
        }

        // 8. Delete state
        if (errorCount === 0) {
          await stateBackend.deleteState(stackName);
          logger.debug('State deleted');
        } else {
          logger.warn(`${errorCount} resource(s) failed to delete. State preserved.`);
        }

        logger.info(
          `\n✓ Stack ${stackName} destroyed (${deletedCount} deleted, ${errorCount} errors)`
        );
      } finally {
        // 9. Release lock
        logger.debug('Releasing lock...');
        await lockManager.releaseLock(stackName);

        // Restore region if changed
        if (destroyAwsClients) {
          destroyAwsClients.destroy();
          process.env['AWS_REGION'] = region;
          process.env['AWS_DEFAULT_REGION'] = region;
          setAwsClients(awsClients);
        }
      }
    }
  } finally {
    // Cleanup AWS clients
    awsClients.destroy();
  }
}

/**
 * Create destroy command
 */
export function createDestroyCommand(): Command {
  const cmd = new Command('destroy')
    .description('Destroy all resources in the stack')
    .argument(
      '[stacks...]',
      "Stack name(s) to destroy. Accepts physical CloudFormation names (e.g. 'MyStage-Api') or CDK display paths (e.g. 'MyStage/Api'). Supports wildcards (e.g. 'MyStage/*')."
    )
    .option('--all', 'Destroy all stacks', false)
    .action(withErrorHandling(destroyCommand));

  // Add options (appOptions accepted for CDK CLI compatibility, but not used)
  [
    ...commonOptions,
    ...appOptions,
    ...stateOptions,
    ...stackOptions,
    ...destroyOptions,
    ...contextOptions,
  ].forEach((opt) => cmd.addOption(opt));

  return cmd;
}
