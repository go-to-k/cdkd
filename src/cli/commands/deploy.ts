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
import { AssemblyLoader } from '../../synthesis/assembly-loader.js';
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
    dryRun: boolean;
    skipAssets: boolean;
    noRollback: boolean;
    verbose: boolean;
    context?: string[];
  }
): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
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
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  let disposeAssembly: (() => Promise<void>) | undefined;
  try {
    // 1. Synthesize CDK app
    logger.info('Synthesizing CDK app...');
    const synthesizer = new Synthesizer();
    const context = parseContextOptions(options.context);
    const { cloudAssembly: assembly, dispose } = await synthesizer.synthesize({
      app: options.app,
      output: options.output,
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
      ...(Object.keys(context).length > 0 && { context }),
    });
    disposeAssembly = dispose;

    // 2. Load CloudAssembly and get stacks
    const assemblyLoader = new AssemblyLoader();
    const allStacks = assemblyLoader.getAllStacks(assembly);
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

    // 3. Publish assets (unless --skip-assets)
    if (!options.skipAssets) {
      const assetPublisher = new AssetPublisher();

      // Try to find asset manifests for each stack
      let assetsPublished = false;
      for (const stack of allStacks) {
        const manifestPath = `${assembly.directory}/${stack.stackName}.assets.json`;

        try {
          await assetPublisher.publishFromManifest(manifestPath, {
            ...(options.region && { region: options.region }),
            ...(options.profile && { profile: options.profile }),
          });
          assetsPublished = true;
        } catch (error) {
          // Check if this is a "file not found" error (assets.json doesn't exist)
          // This is expected when the CDK app has no assets (e.g., infrastructure-only stacks)
          const err = error as { code?: string; message?: string };
          if (err.code === 'ENOENT' || err.message?.includes('ENOENT')) {
            logger.debug(`No assets manifest found for stack ${stack.stackName} - skipping`);
          } else {
            // For all other errors, fail the deployment
            // Asset publishing failures can cause resource creation failures later
            // (e.g., Lambda function with missing code, Docker images, etc.)
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
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig);
    const lockManager = new LockManager(awsClients.s3, stateConfig);
    const dagBuilder = new DagBuilder();
    const diffCalculator = new DiffCalculator();
    const providerRegistry = new ProviderRegistry();

    // Register all SDK providers
    registerAllProviders(providerRegistry);

    // Configure custom resource response handling via S3 (for cfn-response based handlers)
    providerRegistry.setCustomResourceResponseBucket(stateBucket);

    const deployEngine = new DeployEngine(
      stateBackend,
      lockManager,
      dagBuilder,
      diffCalculator,
      providerRegistry,
      {
        concurrency: options.concurrency,
        dryRun: options.dryRun,
        noRollback: options.noRollback,
      }
    );

    // 5. Deploy each stack
    for (const stackInfo of targetStacks) {
      logger.info(`\nDeploying stack: ${stackInfo.stackName}`);

      const template = assemblyLoader.getTemplate(assembly, stackInfo.stackName);

      const result = await deployEngine.deploy(stackInfo.stackName, template);

      logger.info('\nDeployment Summary:');
      logger.info(`  Stack: ${result.stackName}`);
      logger.info(`  Created: ${result.created}`);
      logger.info(`  Updated: ${result.updated}`);
      logger.info(`  Deleted: ${result.deleted}`);
      logger.info(`  Unchanged: ${result.unchanged}`);
      logger.info(`  Duration: ${(result.durationMs / 1000).toFixed(2)}s`);

      if (options.dryRun) {
        logger.info('\n✓ Dry run completed - no actual changes made');
      } else {
        logger.info('\n✓ Deployment completed successfully');
      }
    }
  } finally {
    // Dispose cloud assembly to release cdk.out lock
    if (disposeAssembly) {
      await disposeAssembly();
    }
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
