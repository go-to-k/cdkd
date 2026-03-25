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
import { IAMPolicyProvider } from '../../provisioning/providers/iam-policy-provider.js';
import { S3BucketPolicyProvider } from '../../provisioning/providers/s3-bucket-policy-provider.js';
import { SQSQueuePolicyProvider } from '../../provisioning/providers/sqs-queue-policy-provider.js';
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

      // Try to find asset manifests for each stack
      let assetsPublished = false;
      for (const stack of stacks) {
        const manifestPath = `${assembly.directory}/${stack.stackName}.assets.json`;

        try {
          await assetPublisher.publishFromManifest(manifestPath, {
            ...(options.region && { region: options.region }),
            ...(options.profile && { profile: options.profile }),
          });
          logger.info(`✓ Assets published for stack ${stack.stackName}`);
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
        logger.info('✓ All assets published successfully');
      } else {
        logger.info('No assets to publish');
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
    providerRegistry.register('AWS::IAM::Policy', new IAMPolicyProvider());
    providerRegistry.register('AWS::S3::BucketPolicy', new S3BucketPolicyProvider());
    providerRegistry.register('AWS::SQS::QueuePolicy', new SQSQueuePolicyProvider());

    // Custom resources (Custom::*) are automatically handled by CustomResourceProvider

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
