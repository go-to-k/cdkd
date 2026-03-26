import { Command } from 'commander';
import { appOptions, commonOptions, stateOptions, stackOptions } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer } from '../../synthesis/synthesizer.js';
import { AssemblyLoader } from '../../synthesis/assembly-loader.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { DiffCalculator } from '../../analyzer/diff-calculator.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';

/**
 * Check if a value contains CloudFormation intrinsic functions.
 * Used to detect false-positive diffs where state has resolved values
 * but template has unresolved intrinsics (Ref, Fn::Sub, Fn::GetAtt, etc.)
 */
function containsIntrinsicFunction(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsIntrinsicFunction);
  const obj = value as Record<string, unknown>;
  const intrinsicKeys = [
    'Ref',
    'Fn::Sub',
    'Fn::GetAtt',
    'Fn::Join',
    'Fn::Select',
    'Fn::Split',
    'Fn::If',
    'Fn::ImportValue',
    'Fn::FindInMap',
    'Fn::Base64',
    'Fn::GetAZs',
    'Fn::Equals',
    'Fn::And',
    'Fn::Or',
    'Fn::Not',
  ];
  for (const key of intrinsicKeys) {
    if (key in obj) return true;
  }
  // Check nested values
  return Object.values(obj).some(containsIntrinsicFunction);
}

/**
 * Diff command implementation
 */
async function diffCommand(
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
    verbose: boolean;
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

  // Resolve --state-bucket from CLI, env, cdk.json, or default
  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  logger.info('Calculating diff...');
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
    const { cloudAssembly: assembly, dispose } = await synthesizer.synthesize({
      app: options.app,
      output: options.output,
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
    });
    disposeAssembly = dispose;

    // 2. Load CloudAssembly and get stacks
    const assemblyLoader = new AssemblyLoader();
    const allStacks = assemblyLoader.getAllStacks(assembly);
    logger.info(`Found ${allStacks.length} stack(s) in assembly`);

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
          ? `No stacks matching ${stackPatterns.join(', ')} found in assembly`
          : 'No stacks found in assembly'
      );
    }

    // 3. Initialize components
    const stateConfig = {
      bucket: stateBucket,
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

      logger.info(`\nStack ${stackInfo.stackName}:`);

      let createCount = 0;
      let updateCount = 0;
      let deleteCount = 0;

      for (const [logicalId, change] of changes.entries()) {
        switch (change.changeType) {
          case 'CREATE':
            createCount++;
            logger.info(`  [+] ${logicalId} (${change.resourceType})`);
            break;
          case 'UPDATE': {
            // Filter out false-positive property changes (resolved vs unresolved intrinsic)
            const realChanges = (change.propertyChanges ?? []).filter(
              (pc) => !containsIntrinsicFunction(pc.newValue)
            );
            if (realChanges.length === 0 && (change.propertyChanges ?? []).length > 0) {
              // All changes were false positives, skip this resource
              break;
            }
            updateCount++;
            logger.info(`  [~] ${logicalId} (${change.resourceType})`);
            if (change.propertyChanges && change.propertyChanges.length > 0) {
              for (const propChange of change.propertyChanges) {
                // Skip false-positive diffs caused by intrinsic functions
                // State stores resolved values, template has unresolved intrinsics
                if (containsIntrinsicFunction(propChange.newValue)) {
                  continue;
                }
                const requiresReplace = propChange.requiresReplacement
                  ? ' [requires replacement]'
                  : '';
                const oldStr = JSON.stringify(propChange.oldValue, null, 2);
                const newStr = JSON.stringify(propChange.newValue, null, 2);
                logger.info(`      - ${propChange.path}:${requiresReplace}`);
                logger.info(`          old: ${oldStr}`);
                logger.info(`          new: ${newStr}`);
              }
            }
            break;
          }
          case 'DELETE':
            deleteCount++;
            logger.info(`  [-] ${logicalId} (${change.resourceType})`);
            break;
        }
      }

      logger.info(`\n${createCount} to create, ${updateCount} to update, ${deleteCount} to delete`);
    }
  } finally {
    if (disposeAssembly) {
      await disposeAssembly();
    }
    awsClients.destroy();
  }
}

/**
 * Create diff command
 */
export function createDiffCommand(): Command {
  const cmd = new Command('diff')
    .description('Show difference between current state and desired state')
    .argument('[stacks...]', 'Stack name(s) to diff (supports wildcards)')
    .option('--all', 'Diff all stacks', false)
    .action(withErrorHandling(diffCommand));

  // Add options
  [...commonOptions, ...appOptions, ...stateOptions, ...stackOptions].forEach((opt) =>
    cmd.addOption(opt)
  );

  return cmd;
}
