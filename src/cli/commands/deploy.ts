import { readFileSync } from 'node:fs';
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
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { DagBuilder } from '../../analyzer/dag-builder.js';
import { DiffCalculator } from '../../analyzer/diff-calculator.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { DeployEngine } from '../../deployment/deploy-engine.js';
import { WorkGraph } from '../../deployment/work-graph.js';
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
    assetPublishConcurrency: number;
    imageBuildConcurrency: number;
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

    // 3. Build work graph: asset-publish → stack deploy (DAG)
    // Resolve account ID once for asset publishing
    const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
    const stsClient = new STSClient({
      region: options.region || process.env['AWS_REGION'] || 'us-east-1',
    });
    const callerIdentity = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = callerIdentity.Account!;
    stsClient.destroy();

    const filePublisher = new (
      await import('../../assets/file-asset-publisher.js')
    ).FileAssetPublisher();
    const dockerPublisher = new (
      await import('../../assets/docker-asset-publisher.js')
    ).DockerAssetPublisher();

    const stateConfig = {
      bucket: stateBucket,
      prefix: options.statePrefix,
    };
    const dagBuilder = new DagBuilder();
    const diffCalculator = new DiffCalculator();
    const baseRegion = options.region || process.env['AWS_REGION'] || 'us-east-1';

    const switchRegion = (region: string): void => {
      process.env['AWS_REGION'] = region;
      process.env['AWS_DEFAULT_REGION'] = region;
    };

    // Build work graph
    const workGraph = new WorkGraph();
    const stackMap = new Map(targetStacks.map((s) => [s.stackName, s]));

    for (const stack of targetStacks) {
      const stackNodeId = `stack:${stack.stackName}`;
      const stackDeps = new Set<string>();

      // Add asset-publish nodes for this stack
      if (!options.skipAssets && stack.assetManifestPath) {
        try {
          const content = readFileSync(stack.assetManifestPath, 'utf-8');
          const manifest = JSON.parse(content) as import('../../types/assets.js').AssetManifest;

          // File assets
          const fileAssets = Object.entries(manifest.files || {}).filter(
            ([, asset]) =>
              !asset.source.path.endsWith('.json') && !asset.source.path.endsWith('.template.json')
          );
          for (const [hash, asset] of fileAssets) {
            const nodeId = `asset-publish:${stack.stackName}:file:${hash}`;
            workGraph.addNode({
              id: nodeId,
              type: 'asset-publish',
              dependencies: new Set(),
              state: 'pending',
              data: { kind: 'file', hash, asset, stack },
            });
            stackDeps.add(nodeId);
          }

          // Docker assets
          for (const [hash, asset] of Object.entries(manifest.dockerImages || {})) {
            const nodeId = `asset-publish:${stack.stackName}:docker:${hash}`;
            workGraph.addNode({
              id: nodeId,
              type: 'asset-publish',
              dependencies: new Set(),
              state: 'pending',
              data: { kind: 'docker', hash, asset, stack },
            });
            stackDeps.add(nodeId);
          }
        } catch (error) {
          const err = error as { code?: string };
          if (err.code !== 'ENOENT') throw error;
        }
      }

      // Add inter-stack dependencies: this stack's deploy depends on dependency stacks' deploy
      for (const depName of stack.dependencyNames) {
        if (stackMap.has(depName)) {
          stackDeps.add(`stack:${depName}`);
        }
      }

      // Add stack deploy node
      workGraph.addNode({
        id: stackNodeId,
        type: 'stack',
        dependencies: stackDeps,
        state: 'pending',
        data: { stack },
      });
    }

    const summary = workGraph.summary();
    logger.debug(`Work graph: ${summary['asset-publish']} asset(s), ${summary['stack']} stack(s)`);

    // Execute work graph
    await workGraph.execute(
      {
        'asset-publish': options.assetPublishConcurrency,
        stack: options.stackConcurrency,
      },
      async (node) => {
        if (node.type === 'asset-publish') {
          const { kind, hash, asset, stack } = node.data as {
            kind: 'file' | 'docker';
            hash: string;
            asset: unknown;
            stack: (typeof targetStacks)[0];
          };
          const assetRegion = stack.region || baseRegion;

          const cdkOutputDir = stack.assetManifestPath!.replace(/\/[^/]+$/, '');
          if (kind === 'file') {
            await filePublisher.publish(
              hash,
              asset as import('../../types/assets.js').FileAsset,
              cdkOutputDir,
              accountId,
              assetRegion,
              options.profile
            );
          } else {
            await dockerPublisher.publish(
              hash,
              asset as import('../../types/assets.js').DockerImageAsset,
              cdkOutputDir,
              accountId,
              assetRegion,
              options.profile
            );
          }

          logger.debug(`✅ Published asset: ${node.id}`);
        } else {
          // Stack deploy
          const { stack: stackInfo } = node.data as { stack: (typeof targetStacks)[0] };
          const stackRegion = stackInfo.region || baseRegion;

          logger.info(
            `\nDeploying stack: ${stackInfo.stackName}${stackRegion !== baseRegion ? ` (region: ${stackRegion})` : ''}`
          );

          switchRegion(stackRegion);

          const stackAwsClients = new AwsClients({
            region: stackRegion,
            ...(options.profile && { profile: options.profile }),
          });
          setAwsClients(stackAwsClients);

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
            const deployResult = await stackDeployEngine.deploy(
              stackInfo.stackName,
              stackInfo.template
            );

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
            switchRegion(baseRegion);
            setAwsClients(awsClients);
          }
        }
      }
    );
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
