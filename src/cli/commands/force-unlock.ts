import { Command } from 'commander';
import { commonOptions, stateOptions, stackOptions } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { LockManager } from '../../state/lock-manager.js';
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
    throw new Error('Stack name is required. Usage: cdkq force-unlock <stack-name>');
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

    for (const stackName of stackPatterns) {
      logger.info(`Force-unlocking stack: ${stackName}`);

      try {
        await lockManager.forceReleaseLock(stackName);
        logger.info(`✓ Lock released for stack: ${stackName}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('No lock found') || message.includes('NoSuchKey')) {
          logger.info(`No lock found for stack: ${stackName}`);
        } else {
          logger.error(`Failed to unlock stack ${stackName}: ${message}`);
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
    .action(withErrorHandling(forceUnlockCommand));

  [...commonOptions, ...stateOptions, ...stackOptions].forEach((opt) => cmd.addOption(opt));

  return cmd;
}
