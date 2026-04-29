import * as readline from 'node:readline/promises';
import { Command } from 'commander';
import { commonOptions, stateOptions } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveStateBucketWithDefault } from '../config-loader.js';
import type { LockInfo } from '../../types/state.js';

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
 * properties are reserved for `state show`, which does include them.
 */
interface ResourceDetail {
  logicalId: string;
  resourceType: string;
  physicalId: string;
  dependencies: string[];
  attributes: Record<string, unknown>;
}

/**
 * Shared bootstrap for every `state` subcommand: build the AWS clients,
 * resolve the bucket name, verify the bucket exists, and hand back the
 * S3 state backend / lock manager.
 *
 * `verifyBucketExists` runs early so users without a bootstrapped bucket
 * get a helpful "run cdkd bootstrap" message instead of a generic
 * NoSuchBucket from a downstream list/get call.
 *
 * The returned `dispose` function MUST be called in a `finally` block.
 */
async function setupStateBackend(options: {
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
}): Promise<{
  stateBackend: S3StateBackend;
  lockManager: LockManager;
  bucket: string;
  prefix: string;
  dispose: () => void;
}> {
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const bucket = await resolveStateBucketWithDefault(options.stateBucket, region);
  const prefix = options.statePrefix;
  const stateConfig = { bucket, prefix };
  const stateBackend = new S3StateBackend(awsClients.s3, stateConfig);
  const lockManager = new LockManager(awsClients.s3, stateConfig);

  await stateBackend.verifyBucketExists();

  return {
    stateBackend,
    lockManager,
    bucket,
    prefix,
    dispose: () => awsClients.destroy(),
  };
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
  if (options.verbose) logger.setLevel('debug');

  const setup = await setupStateBackend(options);
  try {
    const stackNames = (await setup.stateBackend.listStacks()).slice().sort();

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
          setup.stateBackend.getState(stackName),
          setup.lockManager.isLocked(stackName),
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
    setup.dispose();
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
 * Properties are intentionally omitted from all output modes — `state show`
 * is the right command when properties are needed.
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
  if (options.verbose) logger.setLevel('debug');

  const setup = await setupStateBackend(options);
  try {
    const stateResult = await setup.stateBackend.getState(stackName);
    if (!stateResult) {
      throw new Error(
        `No state found for stack '${stackName}' in s3://${setup.bucket}/${setup.prefix}/. ` +
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
    setup.dispose();
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
 * Render a duration in milliseconds as `1m23s` / `45s`.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds}s`;
}

/**
 * Render lock metadata for the `state show` block.
 */
function formatLockSummary(lockInfo: LockInfo | null): string {
  if (!lockInfo) return 'unlocked';
  const opStr = lockInfo.operation ? ` (operation: ${lockInfo.operation})` : '';
  const expiresInMs = lockInfo.expiresAt - Date.now();
  const expiresStr =
    expiresInMs > 0
      ? `expires in ${formatDuration(expiresInMs)}`
      : `expired ${formatDuration(-expiresInMs)} ago`;
  return `locked by ${lockInfo.owner}${opStr}, ${expiresStr}`;
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
 * `cdkd state show <stack>` command implementation
 *
 * Renders the full state record for one stack: stack-level metadata, lock
 * status, outputs, and every resource (including properties). The deepest /
 * most verbose `state` subcommand — use `state list` / `state resources` for
 * lighter inspection.
 *
 * - Default: human-readable multi-line format.
 * - `--json`: a `{state, lock}` object containing the raw `StackState` plus
 *   the lock record (or null).
 */
async function stateShowCommand(
  stackName: string,
  options: {
    json: boolean;
    stateBucket?: string;
    statePrefix: string;
    region?: string;
    profile?: string;
    verbose: boolean;
  }
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  const setup = await setupStateBackend(options);
  try {
    const [stateResult, lockInfo] = await Promise.all([
      setup.stateBackend.getState(stackName),
      setup.lockManager.getLockInfo(stackName),
    ]);

    if (!stateResult) {
      throw new Error(
        `No state found for stack '${stackName}' in s3://${setup.bucket}/${setup.prefix}/. ` +
          `Run 'cdkd state list' to see available stacks.`
      );
    }

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ state: stateResult.state, lock: lockInfo }, null, 2)}\n`
      );
      return;
    }

    const state = stateResult.state;
    const lines: string[] = [];

    lines.push(`Stack: ${state.stackName}`);
    if (state.region) lines.push(`  Region: ${state.region}`);
    lines.push(`  Version: ${state.version}`);
    lines.push(`  Last Modified: ${new Date(state.lastModified).toISOString()}`);
    lines.push(`  Lock: ${formatLockSummary(lockInfo)}`);

    const outputEntries = Object.entries(state.outputs ?? {});
    if (outputEntries.length > 0) {
      lines.push('');
      lines.push('Outputs:');
      for (const [k, v] of outputEntries) {
        lines.push(`  ${k}: ${formatAttributeValue(v)}`);
      }
    }

    const resourceEntries = Object.entries(state.resources ?? {}).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    lines.push('');
    lines.push(`Resources (${resourceEntries.length}):`);
    for (const [logicalId, resource] of resourceEntries) {
      lines.push('');
      lines.push(logicalId);
      lines.push(`  Type: ${resource.resourceType}`);
      lines.push(`  PhysicalID: ${resource.physicalId}`);
      const deps = resource.dependencies ?? [];
      lines.push(`  Dependencies: ${deps.length > 0 ? deps.join(', ') : '(none)'}`);

      const attrEntries = Object.entries(resource.attributes ?? {});
      if (attrEntries.length === 0) {
        lines.push('  Attributes: (none)');
      } else {
        lines.push('  Attributes:');
        for (const [k, v] of attrEntries) {
          lines.push(`    ${k}: ${formatAttributeValue(v)}`);
        }
      }

      const propEntries = Object.entries(resource.properties ?? {});
      if (propEntries.length === 0) {
        lines.push('  Properties: (none)');
      } else {
        lines.push('  Properties:');
        for (const [k, v] of propEntries) {
          lines.push(`    ${k}: ${formatAttributeValue(v)}`);
        }
      }
    }

    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    setup.dispose();
  }
}

/**
 * Create the `state show` subcommand.
 */
function createStateShowCommand(): Command {
  const cmd = new Command('show')
    .description('Show the full cdkd state record for a stack (metadata, outputs, resources)')
    .argument('<stack>', 'Stack name (physical CloudFormation name)')
    .option('--json', 'Output the raw state and lock as JSON', false)
    .action(withErrorHandling(stateShowCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  return cmd;
}

/**
 * `cdkd state rm <stacks...>` command implementation
 *
 * Removes the cdkd state record (state.json + any lingering lock.json) for
 * one or more stacks. **Does not** touch the underlying AWS resources —
 * `cdkd destroy` is the command that deletes those.
 *
 * Behavior:
 * - Refuses to remove a locked stack unless `--force` is set, since tearing
 *   the lock out from under an in-flight deploy can corrupt state.
 * - Confirmation prompt defaults to `(y/N)`, requiring an explicit `y` —
 *   this is more cautious than `cdkd destroy` because the operation orphans
 *   AWS resources from cdkd's view rather than reconciling them.
 * - `--yes` / `--force` skip the prompt.
 * - Skips cleanly when a stack has no state (idempotent).
 */
async function stateRmCommand(
  stackArgs: string[],
  options: {
    force: boolean;
    yes: boolean;
    stateBucket?: string;
    statePrefix: string;
    region?: string;
    profile?: string;
    verbose: boolean;
  }
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  if (stackArgs.length === 0) {
    throw new Error('Stack name is required. Usage: cdkd state rm <stack> [<stack>...]');
  }

  const setup = await setupStateBackend(options);
  try {
    for (const stackName of stackArgs) {
      const exists = await setup.stateBackend.stateExists(stackName);
      if (!exists) {
        logger.info(`No state found for stack: ${stackName}, skipping`);
        continue;
      }

      // Refuse to remove a locked stack unless --force is set: an active
      // deploy could be racing with us and ripping the lock out from under it
      // would produce arbitrary mid-deploy corruption.
      if (!options.force) {
        const locked = await setup.lockManager.isLocked(stackName);
        if (locked) {
          throw new Error(
            `Stack '${stackName}' is locked. Run 'cdkd force-unlock ${stackName}' first, ` +
              `or pass --force to remove anyway.`
          );
        }
      }

      // Confirmation prompt unless --yes / --force.
      if (!options.yes && !options.force) {
        process.stdout.write(
          `\nWARNING: This removes cdkd's state record for '${stackName}' only. ` +
            `AWS resources will NOT be deleted.\n` +
            `Use 'cdkd destroy ${stackName}' if you want to delete the actual resources.\n\n`
        );
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await rl.question(
          `Remove state for stack '${stackName}' from s3://${setup.bucket}/${setup.prefix}/? (y/N): `
        );
        rl.close();
        const trimmed = answer.trim().toLowerCase();
        if (trimmed !== 'y' && trimmed !== 'yes') {
          logger.info(`Cancelled removal of state for stack: ${stackName}`);
          continue;
        }
      }

      // Remove state.json AND any lingering lock.json. forceReleaseLock is
      // idempotent (no-op when no lock present).
      await setup.stateBackend.deleteState(stackName);
      await setup.lockManager.forceReleaseLock(stackName);
      logger.info(`✓ Removed state for stack: ${stackName}`);
    }
  } finally {
    setup.dispose();
  }
}

/**
 * Create the `state rm` subcommand.
 */
function createStateRmCommand(): Command {
  const cmd = new Command('rm')
    .description('Remove cdkd state for one or more stacks (does NOT delete AWS resources)')
    .argument('<stacks...>', 'Stack name(s) to remove from state')
    .option('-f, --force', 'Skip confirmation and remove even if the stack is locked', false)
    .action(withErrorHandling(stateRmCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  return cmd;
}

/**
 * Create the `state` parent command.
 *
 * Subcommands:
 * - `state list` (alias `ls`) — list stacks in the state bucket
 * - `state resources <stack>` — list resources of one stack
 * - `state show <stack>` — full state record (metadata, outputs, resources)
 * - `state rm <stack>...` — remove cdkd's state record (NOT AWS resources)
 */
export function createStateCommand(): Command {
  const cmd = new Command('state').description('Manage cdkd state stored in S3');
  cmd.addCommand(createStateListCommand());
  cmd.addCommand(createStateResourcesCommand());
  cmd.addCommand(createStateShowCommand());
  cmd.addCommand(createStateRmCommand());
  return cmd;
}
