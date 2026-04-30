import { Command, Option } from 'commander';
import { commonOptions, stateOptions, stackOptions } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { LockManager } from '../../state/lock-manager.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveStateBucketWithDefault } from '../config-loader.js';

/**
 * Force-unlock command implementation
 *
 * Removes a stale lock from a stack. Use when a previous deploy was
 * interrupted and left a lock behind.
 */
async function forceUnlockCommand(
  stackArgs: string[],
  options: {
    stateBucket?: string;
    statePrefix: string;
    stack?: string;
    stackRegion?: string;
    region?: string;
    profile?: string;
    verbose: boolean;
  }
): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  // Resolve stack name
  const stackPatterns = stackArgs.length > 0 ? stackArgs : options.stack ? [options.stack] : [];
  if (stackPatterns.length === 0) {
    throw new Error('Stack name is required. Usage: cdkd force-unlock <stack-name>');
  }

  // Initialize AWS clients
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  try {
    const stateConfig = {
      bucket: stateBucket,
      prefix: options.statePrefix,
    };
    const lockManager = new LockManager(awsClients.s3, stateConfig);
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig);

    for (const stackName of stackPatterns) {
      // Determine which region(s) to release. Order:
      //   1. Explicit `--stack-region` flag.
      //   2. Region(s) discovered in S3 state for this stack name (new
      //      region-prefixed key + legacy key).
      //   3. Fallback to the CLI region when no state record exists yet.
      let regionsToTry: (string | undefined)[];
      if (options.stackRegion) {
        regionsToTry = [options.stackRegion];
      } else {
        const refs = await stateBackend.listStacks();
        const matched = refs.filter((r) => r.stackName === stackName);
        if (matched.length === 0) {
          regionsToTry = [region];
        } else {
          regionsToTry = matched.map((r) => r.region);
        }
      }

      for (const r of regionsToTry) {
        const where = r ? `${stackName} (${r})` : `${stackName} (legacy lock key)`;
        logger.info(`Force-unlocking stack: ${where}`);
        try {
          await lockManager.forceReleaseLock(stackName, r);
          logger.info(`✓ Lock released for stack: ${where}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('No lock found') || message.includes('NoSuchKey')) {
            logger.info(`No lock found for stack: ${where}`);
          } else {
            logger.error(`Failed to unlock stack ${where}: ${message}`);
          }
        }
      }
    }
  } finally {
    awsClients.destroy();
  }
}

/**
 * Create force-unlock command
 */
export function createForceUnlockCommand(): Command {
  const cmd = new Command('force-unlock')
    .description('Force-release a stale lock on a stack')
    .argument('[stacks...]', 'Stack name(s) to unlock')
    .addOption(
      new Option(
        '--stack-region <region>',
        'Stack region whose lock to release (use when the same stack name has locks in multiple regions). ' +
          'Defaults to all regions where the stack has state.'
      )
    )
    .action(withErrorHandling(forceUnlockCommand));

  [...commonOptions, ...stateOptions, ...stackOptions].forEach((opt) => cmd.addOption(opt));

  return cmd;
}
