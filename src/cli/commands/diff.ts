import { Command } from 'commander';
import { appOptions, commonOptions, stateOptions, stackOptions } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer } from '../../synthesis/synthesizer.js';
import { AssemblyLoader } from '../../synthesis/assembly-loader.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { DiffCalculator } from '../../analyzer/diff-calculator.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveApp, resolveStateBucket } from '../config-loader.js';

/**
 * Diff command implementation
 */
async function diffCommand(options: {
  app?: string;
  output: string;
  stateBucket?: string;
  statePrefix: string;
  stack?: string;
  region?: string;
  profile?: string;
  verbose: boolean;
}): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  // Resolve --app from CLI, env, or cdk.json
  const app = resolveApp(options.app);
  if (!app) {
    throw new Error(
      'No app command specified. Use --app, set CDKQ_APP env var, or add "app" to cdk.json'
    );
  }
  options.app = app;

  // Resolve --state-bucket from CLI, env, or cdk.json
  const stateBucket = resolveStateBucket(options.stateBucket);
  if (!stateBucket) {
    throw new Error(
      'No state bucket specified. Use --state-bucket, set CDKQ_STATE_BUCKET env var, or add context.cdkq.stateBucket to cdk.json'
    );
  }
  options.stateBucket = stateBucket;

  logger.info('Calculating diff...');
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

    // 3. Initialize components
    const stateConfig = {
      bucket: options.stateBucket,
      prefix: options.statePrefix,
    };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig);
    const diffCalculator = new DiffCalculator();

    // 4. Calculate and display diff for each stack
    for (const stackInfo of targetStacks) {
      logger.info(`\nCalculating diff for stack: ${stackInfo.stackName}`);

      const template = assemblyLoader.getTemplate(assembly, stackInfo.stackName);

      // Load current state
      let currentState;
      const stateResult = await stateBackend.getState(stackInfo.stackName);
      if (stateResult) {
        currentState = stateResult.state;
      } else {
        logger.debug(`No existing state for ${stackInfo.stackName}`);
        currentState = {
          stackName: stackInfo.stackName,
          resources: {},
          outputs: {},
          version: 1,
          lastModified: Date.now(),
        };
      }

      // Calculate diff
      const changes = diffCalculator.calculateDiff(currentState, template);

      // Display changes
      if (changes.size === 0) {
        logger.info('\n✓ No changes detected');
        continue;
      }

      logger.info(`\nChanges for stack ${stackInfo.stackName}:`);
      logger.info(`Total changes: ${changes.size}`);

      let createCount = 0;
      let updateCount = 0;
      let deleteCount = 0;

      for (const [logicalId, change] of changes.entries()) {
        switch (change.changeType) {
          case 'CREATE':
            createCount++;
            logger.info(`  [+] ${logicalId} (${change.resourceType})`);
            break;
          case 'UPDATE':
            updateCount++;
            logger.info(`  [~] ${logicalId} (${change.resourceType})`);
            if (change.propertyChanges && change.propertyChanges.length > 0) {
              for (const propChange of change.propertyChanges) {
                const requiresReplace = propChange.requiresReplacement
                  ? ' [requires replacement]'
                  : '';
                logger.info(
                  `      - ${propChange.path}: ${JSON.stringify(propChange.oldValue)} → ${JSON.stringify(propChange.newValue)}${requiresReplace}`
                );
              }
            }
            break;
          case 'DELETE':
            deleteCount++;
            logger.info(`  [-] ${logicalId} (${change.resourceType})`);
            break;
        }
      }

      logger.info(`\nSummary:`);
      logger.info(`  Created: ${createCount}`);
      logger.info(`  Updated: ${updateCount}`);
      logger.info(`  Deleted: ${deleteCount}`);
    }
  } finally {
    // Cleanup AWS clients
    awsClients.destroy();
  }
}

/**
 * Create diff command
 */
export function createDiffCommand(): Command {
  const cmd = new Command('diff')
    .description('Show difference between current state and desired state')
    .action(withErrorHandling(diffCommand));

  // Add options
  [...commonOptions, ...appOptions, ...stateOptions, ...stackOptions].forEach((opt) =>
    cmd.addOption(opt)
  );

  return cmd;
}
