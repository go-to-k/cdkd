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
 * Detail row for a single resource emitted by `state resources`.
 *
 * Mirrors the public-facing fields of `ResourceState` minus `properties` —
 * properties are reserved for the planned `state show` subcommand because
 * they can be very large and noisy for an inventory-style listing.
 */
interface ResourceDetail {
  logicalId: string;
  resourceType: string;
  physicalId: string;
  dependencies: string[];
  attributes: Record<string, unknown>;
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
 * `cdkd state resources <stack>` command implementation
 *
 * Lists the resources recorded in a single stack's state file.
 *
 * - Default: aligned three-column output (LogicalID, Type, PhysicalID)
 *   sorted alphabetically by logical id.
 * - `--long`/`-l`: per-resource block including dependencies and attributes.
 * - `--json`: emit a JSON array of full resource detail objects.
 *
 * Properties are intentionally omitted from all output modes — they belong
 * to the planned `state show` subcommand.
 */
async function stateResourcesCommand(
  stackName: string,
  options: {
    long: boolean;
    json: boolean;
    stateBucket?: string;
    statePrefix: string;
    region?: string;
    profile?: string;
    verbose: boolean;
  }
): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

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

    const stateResult = await stateBackend.getState(stackName);
    if (!stateResult) {
      throw new Error(
        `No state found for stack '${stackName}' in s3://${stateBucket}/${options.statePrefix}/. ` +
          `Run 'cdkd state list' to see available stacks.`
      );
    }

    const resources = stateResult.state.resources ?? {};
    const details: ResourceDetail[] = Object.entries(resources)
      .map(([logicalId, resource]) => ({
        logicalId,
        resourceType: resource.resourceType,
        physicalId: resource.physicalId,
        dependencies: resource.dependencies ?? [],
        attributes: resource.attributes ?? {},
      }))
      .sort((a, b) => a.logicalId.localeCompare(b.logicalId));

    if (options.json) {
      process.stdout.write(`${JSON.stringify(details, null, 2)}\n`);
      return;
    }

    if (details.length === 0) {
      // Nothing to print; leaving output empty matches `state list` semantics
      // for an empty bucket.
      return;
    }

    if (options.long) {
      const lines: string[] = [];
      for (const detail of details) {
        lines.push(detail.logicalId);
        lines.push(`  Type: ${detail.resourceType}`);
        lines.push(`  PhysicalID: ${detail.physicalId}`);
        lines.push(
          `  Dependencies: ${detail.dependencies.length > 0 ? detail.dependencies.join(', ') : '(none)'}`
        );
        const attrEntries = Object.entries(detail.attributes);
        if (attrEntries.length === 0) {
          lines.push('  Attributes: (none)');
        } else {
          lines.push('  Attributes:');
          for (const [k, v] of attrEntries) {
            lines.push(`    ${k}: ${formatAttributeValue(v)}`);
          }
        }
        lines.push('');
      }
      // Drop trailing blank line for tidy output.
      if (lines[lines.length - 1] === '') {
        lines.pop();
      }
      process.stdout.write(`${lines.join('\n')}\n`);
      return;
    }

    // Default: aligned three-column output.
    const idWidth = Math.max(...details.map((d) => d.logicalId.length));
    const typeWidth = Math.max(...details.map((d) => d.resourceType.length));
    for (const detail of details) {
      process.stdout.write(
        `${detail.logicalId.padEnd(idWidth)}  ${detail.resourceType.padEnd(typeWidth)}  ${detail.physicalId}\n`
      );
    }
  } finally {
    awsClients.destroy();
  }
}

/**
 * Render a single attribute value for the `--long` human-readable form.
 *
 * Scalar values render as-is; objects/arrays are JSON-encoded inline so a
 * resource block stays compact even when an attribute is structured.
 */
function formatAttributeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Create the `state resources` subcommand.
 */
function createStateResourcesCommand(): Command {
  const cmd = new Command('resources')
    .description("List resources recorded in a stack's state")
    .argument('<stack>', 'Stack name (physical CloudFormation name)')
    .option('-l, --long', 'Include dependencies and attributes per resource', false)
    .option('--json', 'Output as JSON', false)
    .action(withErrorHandling(stateResourcesCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  return cmd;
}

/**
 * Create the `state` parent command.
 *
 * Today `list` (alias `ls`) and `resources` are implemented. Future siblings
 * such as `state show` and `state rm` are planned and will be attached here.
 */
export function createStateCommand(): Command {
  const cmd = new Command('state').description('Manage cdkd state stored in S3');
  cmd.addCommand(createStateListCommand());
  cmd.addCommand(createStateResourcesCommand());
  return cmd;
}
