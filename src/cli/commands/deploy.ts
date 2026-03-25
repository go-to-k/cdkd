import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  stateOptions,
  stackOptions,
  deployOptions,
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
import { IAMRoleProvider } from '../../provisioning/providers/iam-role-provider.js';
import { DeployEngine } from '../../deployment/deploy-engine.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';

/**
 * Deploy command implementation
 */
async function deployCommand(options: {
  app: string;
  output: string;
  stateBucket: string;
  statePrefix: string;
  stack?: string;
  region?: string;
  profile?: string;
  concurrency: number;
  dryRun: boolean;
  skipAssets: boolean;
  verbose: boolean;
}): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  logger.info('Starting deployment...');
  logger.debug('Options:', options);

  // Initialize AWS clients with region/profile
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    // 1. Synthesize CDK app
    logger.info('Synthesizing CDK app...');
    const synthesizer = new Synthesizer();
    const assembly = await synthesizer.synthesize({
      app: options.app,
      output: options.output,
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
    });

    // 2. Load CloudAssembly and get stacks
    const assemblyLoader = new AssemblyLoader();
    const stacks = assemblyLoader.getAllStacks(assembly);
    logger.info(`Found ${stacks.length} stack(s) in assembly`);

    // Filter stack if specified
    const targetStacks = options.stack
      ? stacks.filter((s) => s.stackName === options.stack)
      : stacks;

    if (targetStacks.length === 0) {
      throw new Error(
        options.stack
          ? `Stack ${options.stack} not found in assembly`
          : 'No stacks found in assembly'
      );
    }

    // 3. Publish assets (unless --skip-assets)
    if (!options.skipAssets) {
      logger.info('Publishing assets...');
      const assetPublisher = new AssetPublisher();
      const manifestPath = `${assembly.directory}/assets.json`;

      try {
        await assetPublisher.publishFromManifest(manifestPath, {
          ...(options.region && { region: options.region }),
          ...(options.profile && { profile: options.profile }),
        });
        logger.info('✓ Assets published successfully');
      } catch (error) {
        // TODO: Improve error handling - distinguish between "file not found" and actual failures
        // Currently we continue deployment even if asset publishing fails, which can cause
        // resource creation failures later (e.g., Lambda function with missing code).
        // Should:
        // 1. Check if assets.json exists first
        // 2. Only ignore ENOENT errors
        // 3. Fail deployment if assets are required but publishing fails
        logger.warn('Asset publishing failed (assets.json may not exist):', String(error));
        logger.info('Continuing with deployment...');
      }
    } else {
      logger.info('Skipping asset publishing (--skip-assets)');
    }

    // 4. Initialize deployment components
    const stateConfig = {
      bucket: options.stateBucket,
      prefix: options.statePrefix,
    };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig);
    const lockManager = new LockManager(awsClients.s3, stateConfig);
    const dagBuilder = new DagBuilder();
    const diffCalculator = new DiffCalculator();
    const providerRegistry = new ProviderRegistry();

    // Register SDK providers for unsupported resource types
    providerRegistry.register('AWS::IAM::Role', new IAMRoleProvider());

    const deployEngine = new DeployEngine(
      stateBackend,
      lockManager,
      dagBuilder,
      diffCalculator,
      providerRegistry,
      {
        concurrency: options.concurrency,
        dryRun: options.dryRun,
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
    // Cleanup AWS clients
    awsClients.destroy();
  }
}

/**
 * Create deploy command
 */
export function createDeployCommand(): Command {
  const cmd = new Command('deploy')
    .description('Deploy CDK app using SDK/Cloud Control API')
    .action(withErrorHandling(deployCommand));

  // Add options
  [...commonOptions, ...appOptions, ...stateOptions, ...stackOptions, ...deployOptions].forEach(
    (opt) => cmd.addOption(opt)
  );

  return cmd;
}
