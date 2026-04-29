import { Command } from 'commander';
import { commonOptions, stateOptions } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveStateBucketWithDefault } from '../config-loader.js';

/**
 * Detail row for a single stack when --long is requested.
 */
interface StackDetail {
  stackName: string;
  resourceCount: number;
  lastModified: string | null;
  locked: boolean;
}

/**
 * `cdkd state list` command implementation
 *
 * Lists stacks registered in the configured S3 state bucket.
 *
 * - Default: stack names, one per line, sorted alphabetically.
 * - `--long`/`-l`: include resource count, last-modified time, and lock status.
 * - `--json`: emit a JSON array (alongside or instead of the long form).
 */
async function stateListCommand(options: {
  long: boolean;
  json: boolean;
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
  verbose: boolean;
}): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
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
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig);
    const lockManager = new LockManager(awsClients.s3, stateConfig);

    const stackNames = (await stateBackend.listStacks()).slice().sort();

    // Default mode: just print sorted stack names, one per line.
    if (!options.long && !options.json) {
      for (const name of stackNames) {
        process.stdout.write(`${name}\n`);
      }
      return;
    }

    // --json without --long: array of names.
    if (options.json && !options.long) {
      process.stdout.write(`${JSON.stringify(stackNames, null, 2)}\n`);
      return;
    }

    // --long (with or without --json): fetch detail per stack in parallel.
    const details: StackDetail[] = await Promise.all(
      stackNames.map(async (stackName): Promise<StackDetail> => {
        const [stateResult, locked] = await Promise.all([
          stateBackend.getState(stackName),
          lockManager.isLocked(stackName),
        ]);
        const state = stateResult?.state;
        return {
          stackName,
          resourceCount: state ? Object.keys(state.resources).length : 0,
          lastModified:
            state && typeof state.lastModified === 'number'
              ? new Date(state.lastModified).toISOString()
              : null,
          locked,
        };
      })
    );

    if (options.json) {
      process.stdout.write(`${JSON.stringify(details, null, 2)}\n`);
      return;
    }

    // Long human-readable format.
    const lines: string[] = [];
    for (const detail of details) {
      lines.push(detail.stackName);
      lines.push(`  Resources: ${detail.resourceCount}`);
      lines.push(`  Last Modified: ${detail.lastModified ?? 'unknown'}`);
      lines.push(`  Lock: ${detail.locked ? 'locked' : 'unlocked'}`);
      lines.push('');
    }
    if (lines.length > 0) {
      // Drop trailing blank line for tidy output.
      if (lines[lines.length - 1] === '') {
        lines.pop();
      }
      process.stdout.write(`${lines.join('\n')}\n`);
    }
  } finally {
    awsClients.destroy();
  }
}

/**
 * Create the `state list` subcommand.
 */
function createStateListCommand(): Command {
  const cmd = new Command('list')
    .alias('ls')
    .description('List stacks registered in the cdkd state bucket')
    .option('-l, --long', 'Show resource count, last-modified time, and lock status', false)
    .option('--json', 'Output as JSON', false)
    .action(withErrorHandling(stateListCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  return cmd;
}

/**
 * Create the `state` parent command.
 *
 * Today only `list` (alias `ls`) is implemented. Future siblings such as
 * `state show` and `state rm` are planned and will be attached here.
 */
export function createStateCommand(): Command {
  const cmd = new Command('state').description('Manage cdkd state stored in S3');
  cmd.addCommand(createStateListCommand());
  return cmd;
}
