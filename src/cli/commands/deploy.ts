import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  stateOptions,
  stackOptions,
  deployOptions,
  contextOptions,
  parseContextOptions,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer } from '../../synthesis/synthesizer.js';
import { AssetPublisher } from '../../assets/asset-publisher.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { DagBuilder } from '../../analyzer/dag-builder.js';
import { DiffCalculator } from '../../analyzer/diff-calculator.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { DeployEngine } from '../../deployment/deploy-engine.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';

/**
 * Deploy command implementation
 */
async function deployCommand(
  stacks: string[],
  options: {
    app?: string;
    output: string;
    stateBucket?: string;
    statePrefix: string;
    stack?: string;
    all?: boolean;
    region?: string;
    profile?: string;
    concurrency: number;
    stackConcurrency: number;
    dryRun: boolean;
    skipAssets: boolean;
    rollback: boolean;
    wait: boolean;
    exclusively: boolean;
    verbose: boolean;
    context?: string[];
  }
): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  // Skip waiting for async resources (CloudFront, RDS, ElastiCache, etc.)
  if (!options.wait) {
    process.env['CDKD_NO_WAIT'] = 'true';
  }

  // Resolve --app from CLI, env, or cdk.json
  const app = resolveApp(options.app);
  if (!app) {
    throw new Error(
      'No app command specified. Use --app, set CDKD_APP env var, or add "app" to cdk.json'
    );
  }
  options.app = app;

  // Resolve --state-bucket from CLI, env, cdk.json, or default (cdkd-state-{accountId}-{region})
  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  logger.debug('Starting deployment...');
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

  let deployInterrupted = false;
  const topLevelSigintHandler = () => {
    if (deployInterrupted) {
      process.stderr.write('\nForce exit\n');
      process.exit(130);
    }
    process.stderr.write('\nInterrupted — waiting for in-progress operations to complete...\n');
    deployInterrupted = true;
  };
  process.on('SIGINT', topLevelSigintHandler);

  try {
    // 1. Synthesize CDK app
    logger.info('Synthesizing CDK app...');
    const synthesizer = new Synthesizer();
    const context = parseContextOptions(options.context);
    const result = await synthesizer.synthesize({
      app: options.app,
      output: options.output,
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
      ...(Object.keys(context).length > 0 && { context }),
    });

    const { stacks: allStacks } = result;

    logger.debug(`Found ${allStacks.length} stack(s) in assembly`);

    // Determine target stacks: positional args > --stack > --all > auto (single stack)
    const stackPatterns = stacks.length > 0 ? stacks : options.stack ? [options.stack] : [];
    let targetStacks;

    if (options.all) {
      targetStacks = allStacks;
    } else if (stackPatterns.length > 0) {
      targetStacks = allStacks.filter((s) =>
        stackPatterns.some((pattern) =>
          pattern.includes('*')
            ? new RegExp('^' + pattern.replace(/\*/g, '.*') + '$').test(s.stackName)
            : s.stackName === pattern
        )
      );
    } else if (allStacks.length === 1) {
      // Single stack: auto-select
      targetStacks = allStacks;
    } else {
      throw new Error(
        `Multiple stacks found: ${allStacks.map((s) => s.stackName).join(', ')}. ` +
          `Specify stack name(s) or use --all`
      );
    }

    if (targetStacks.length === 0) {
      throw new Error(
        stackPatterns.length > 0
          ? `No stacks matching ${stackPatterns.join(', ')} found in assembly. Available: ${allStacks.map((s) => s.stackName).join(', ')}`
          : 'No stacks found in assembly'
      );
    }

    // Auto-include dependency stacks (CDK CLI compatible behavior)
    // When deploying StackA that depends on StackB, also deploy StackB first.
    // Use -e / --exclusively to skip this and deploy only the requested stacks.
    if (!options.exclusively) {
      const targetNames = new Set(targetStacks.map((s) => s.stackName));
      const allStackMap = new Map(allStacks.map((s) => [s.stackName, s]));

      const addDependencies = (stackName: string): void => {
        const stack = allStackMap.get(stackName);
        if (!stack) return;
        for (const depName of stack.dependencyNames) {
          if (!targetNames.has(depName)) {
            const depStack = allStackMap.get(depName);
            if (depStack) {
              targetNames.add(depName);
              targetStacks.push(depStack);
              logger.debug(
                `Auto-including dependency stack: ${depName} (required by ${stackName})`
              );
              addDependencies(depName); // Recursive
            }
          }
        }
      };

      for (const stack of [...targetStacks]) {
        addDependencies(stack.stackName);
      }
    }

    // 3. Publish assets (unless --skip-assets)
    if (!options.skipAssets) {
      const assetPublisher = new AssetPublisher();

      // Try to find asset manifests for each stack
      let assetsPublished = false;
      for (const stack of allStacks) {
        if (!stack.assetManifestPath) {
          logger.debug(`No assets manifest found for stack ${stack.stackName} - skipping`);
          continue;
        }

        try {
          // Use stack's target region for asset publishing (falls back to CLI --region or default)
          const assetRegion =
            stack.region || options.region || process.env['AWS_REGION'] || 'us-east-1';
          await assetPublisher.publishFromManifest(stack.assetManifestPath, {
            region: assetRegion,
            ...(options.profile && { profile: options.profile }),
          });
          assetsPublished = true;
        } catch (error) {
          const err = error as { code?: string; message?: string };
          if (err.code === 'ENOENT' || err.message?.includes('ENOENT')) {
            logger.debug(`No assets manifest found for stack ${stack.stackName} - skipping`);
          } else {
            logger.error(
              `Asset publishing failed for stack ${stack.stackName}:`,
              err.message || String(error)
            );
            throw error;
          }
        }
      }

      if (assetsPublished) {
        logger.info('✓ Assets published');
      }
    }

    // 4. Initialize deployment components
    const stateConfig = {
      bucket: stateBucket,
      prefix: options.statePrefix,
    };
    const dagBuilder = new DagBuilder();
    const diffCalculator = new DiffCalculator();

    // 5. Deploy stacks (parallel within same region, cross-region handled via env vars)
    const baseRegion = options.region || process.env['AWS_REGION'] || 'us-east-1';

    const switchRegion = (region: string): void => {
      process.env['AWS_REGION'] = region;
      process.env['AWS_DEFAULT_REGION'] = region;
    };

    const deployStack = async (stackInfo: (typeof targetStacks)[0]) => {
      const stackRegion = stackInfo.region || baseRegion;
      logger.info(
        `\nDeploying stack: ${stackInfo.stackName}${stackRegion !== baseRegion ? ` (region: ${stackRegion})` : ''}`
      );

      // Switch region for this stack (providers create local clients that pick up env)
      switchRegion(stackRegion);

      // Create stack-specific AWS clients for resource provisioning (stack's region)
      const stackAwsClients = new AwsClients({
        region: stackRegion,
        ...(options.profile && { profile: options.profile }),
      });
      setAwsClients(stackAwsClients);

      // State backend and lock manager use base region (state bucket region),
      // NOT the stack's region. The state bucket is always in the base region.
      const stateS3Client = new AwsClients({
        region: baseRegion,
        ...(options.profile && { profile: options.profile }),
      });
      const stackStateBackend = new S3StateBackend(stateS3Client.s3, stateConfig);
      const stackLockManager = new LockManager(stateS3Client.s3, stateConfig);
      const stackProviderRegistry = new ProviderRegistry();
      registerAllProviders(stackProviderRegistry);
      stackProviderRegistry.setCustomResourceResponseBucket(stateBucket, baseRegion);

      const stackDeployEngine = new DeployEngine(
        stackStateBackend,
        stackLockManager,
        dagBuilder,
        diffCalculator,
        stackProviderRegistry,
        {
          concurrency: options.concurrency,
          dryRun: options.dryRun,
          noRollback: !options.rollback,
        },
        stackRegion
      );

      try {
        const template = stackInfo.template;
        const deployResult = await stackDeployEngine.deploy(stackInfo.stackName, template);

        logger.info('\nDeployment Summary:');
        logger.info(`  Stack: ${deployResult.stackName}`);
        logger.info(`  Created: ${deployResult.created}`);
        logger.info(`  Updated: ${deployResult.updated}`);
        logger.info(`  Deleted: ${deployResult.deleted}`);
        logger.info(`  Unchanged: ${deployResult.unchanged}`);
        logger.info(`  Duration: ${(deployResult.durationMs / 1000).toFixed(2)}s`);

        if (options.dryRun) {
          logger.info('\n✓ Dry run completed - no actual changes made');
        } else {
          logger.info('\n✓ Deployment completed successfully');
        }
      } finally {
        stackAwsClients.destroy();
        stateS3Client.destroy();
        // Restore base region
        switchRegion(baseRegion);
        setAwsClients(awsClients);
      }
    };

    if (targetStacks.length === 1) {
      // Single stack: deploy directly
      await deployStack(targetStacks[0]!);
    } else {
      // Multiple stacks: deploy in dependency order, parallelizing independent stacks.
      const deployed = new Set<string>();
      const failed = new Set<string>();
      const skipped = new Set<string>();
      const deploying = new Map<string, Promise<void>>();
      const remaining = new Set(targetStacks.map((s) => s.stackName));
      const stackMap = new Map(targetStacks.map((s) => [s.stackName, s]));
      const errors: Array<{ stackName: string; error: unknown }> = [];

      const hasFailedDependency = (stackName: string): boolean => {
        const stack = stackMap.get(stackName);
        if (!stack) return false;
        return stack.dependencyNames.some((dep) => failed.has(dep) || skipped.has(dep));
      };

      while (remaining.size > 0) {
        if (deployInterrupted) {
          logger.info('Deployment interrupted. Waiting for in-progress stacks to finish...');
          if (deploying.size > 0) {
            await Promise.allSettled(deploying.values());
          }
          break;
        }

        const ready: string[] = [];
        const toSkip: string[] = [];

        for (const name of remaining) {
          if (deploying.has(name)) continue;

          if (hasFailedDependency(name)) {
            toSkip.push(name);
            continue;
          }

          const stack = stackMap.get(name)!;
          const depsReady = stack.dependencyNames.every(
            (dep) => deployed.has(dep) || !remaining.has(dep)
          );
          if (depsReady) {
            ready.push(name);
          }
        }

        // Limit to stack concurrency
        const slotsAvailable = options.stackConcurrency - deploying.size;
        if (slotsAvailable < ready.length) {
          ready.splice(slotsAvailable);
        }

        for (const name of toSkip) {
          logger.warn(`Skipping stack ${name}: dependency failed`);
          skipped.add(name);
          remaining.delete(name);
        }

        if (ready.length === 0 && deploying.size === 0) {
          if (remaining.size > 0) {
            for (const name of remaining) {
              skipped.add(name);
            }
            remaining.clear();
          }
          break;
        }

        for (const name of ready) {
          const stack = stackMap.get(name)!;
          const promise = deployStack(stack)
            .then(() => {
              deployed.add(name);
            })
            .catch((error) => {
              const msg = error instanceof Error ? error.message : String(error);
              if (msg.includes('interrupted') || msg.includes('Interrupted')) {
                logger.info(`Stack ${name} interrupted by user`);
              } else {
                logger.error(`Stack ${name} failed: ${msg}`);
                failed.add(name);
                errors.push({ stackName: name, error });
              }
            })
            .finally(() => {
              remaining.delete(name);
              deploying.delete(name);
            });
          deploying.set(name, promise);
        }

        if (deploying.size > 0) {
          await Promise.race(deploying.values());
        }
      }

      if (deploying.size > 0) {
        await Promise.allSettled(deploying.values());
      }

      if (failed.size > 0 || skipped.size > 0) {
        if (skipped.size > 0) {
          logger.warn(`\nSkipped stacks (dependency failed): ${[...skipped].join(', ')}`);
        }
        throw new Error(
          `${failed.size} stack(s) failed: ${errors.map((e) => e.stackName).join(', ')}`
        );
      }
    }
  } finally {
    process.removeListener('SIGINT', topLevelSigintHandler);
    awsClients.destroy();
  }
}

/**
 * Create deploy command
 */
export function createDeployCommand(): Command {
  const cmd = new Command('deploy')
    .description('Deploy CDK app using SDK/Cloud Control API')
    .argument('[stacks...]', 'Stack name(s) to deploy (supports wildcards)')
    .option('--all', 'Deploy all stacks', false)
    .action(withErrorHandling(deployCommand));

  // Add options
  [
    ...commonOptions,
    ...appOptions,
    ...stateOptions,
    ...stackOptions,
    ...deployOptions,
    ...contextOptions,
  ].forEach((opt) => cmd.addOption(opt));

  return cmd;
}
