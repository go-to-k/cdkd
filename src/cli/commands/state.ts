import * as readline from 'node:readline/promises';
import { Command, Option } from 'commander';
import {
  GetBucketLocationCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import {
  commonOptions,
  deprecatedRegionOption,
  stateOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { S3StateBackend, type StackStateRef } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import {
  resolveStateBucketWithDefault,
  resolveStateBucketWithDefaultAndSource,
  type StateBucketSource,
} from '../config-loader.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { runDestroyForStack } from './destroy-runner.js';
import type { LockInfo, StackState } from '../../types/state.js';

/**
 * Detail row for a single stack when --long is requested.
 */
interface StackDetail {
  stackName: string;
  /**
   * Region recorded for this state record. `null` for legacy `version: 1`
   * state where no region was persisted in the state body.
   */
  region: string | null;
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
 * Render `Stack` or `Stack (region)` — used by every state subcommand's
 * default output mode and ambiguity error messages.
 */
function formatStackRef(ref: StackStateRef): string {
  return ref.region ? `${ref.stackName} (${ref.region})` : ref.stackName;
}

/**
 * Resolve a stack name + optional region flag against the `listStacks` index
 * built up front. When a name resolves to multiple regions and the caller
 * didn't pin one, surface a clear error listing the candidates so the user
 * knows exactly which `--region X` to add.
 */
function resolveSingleRegion(
  stackName: string,
  refs: StackStateRef[],
  requestedRegion: string | undefined
): StackStateRef {
  const matches = refs.filter((r) => r.stackName === stackName);
  if (matches.length === 0) {
    throw new Error(
      `No state found for stack '${stackName}'. Run 'cdkd state list' to see available stacks.`
    );
  }
  if (requestedRegion) {
    const ref = matches.find((r) => r.region === requestedRegion);
    if (!ref) {
      const seen = matches.map((r) => r.region ?? '(legacy)').join(', ');
      throw new Error(
        `No state found for stack '${stackName}' in region '${requestedRegion}'. ` +
          `Available regions: ${seen}.`
      );
    }
    return ref;
  }
  if (matches.length === 1) return matches[0]!;
  const regions = matches.map((r) => r.region ?? '(legacy)').join(', ');
  throw new Error(
    `Stack '${stackName}' has state in multiple regions: ${regions}. ` +
      `Re-run with --region <region> to disambiguate.`
  );
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
  awsClients: AwsClients;
  region: string;
  bucket: string;
  prefix: string;
  dispose: () => void;
}> {
  // PR 5: --region is deprecated on every state subcommand. Warn here so
  // the four subcommands inherit the warning via this shared bootstrap.
  warnIfDeprecatedRegion(options);

  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const bucket = await resolveStateBucketWithDefault(options.stateBucket, region);
  const prefix = options.statePrefix;
  const stateConfig = { bucket, prefix };
  // Pass region/profile so the backend can rebuild its S3 client if the
  // bucket lives in a region different from the CLI's profile region.
  const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
    region,
    ...(options.profile && { profile: options.profile }),
  });
  const lockManager = new LockManager(awsClients.s3, stateConfig);

  // verifyBucketExists() triggers ensureClientForBucket() which resolves the
  // bucket region via GetBucketLocation. Every state subcommand that follows
  // sees a fully-ready backend.
  await stateBackend.verifyBucketExists();

  return {
    stateBackend,
    lockManager,
    awsClients,
    region,
    bucket,
    prefix,
    dispose: () => awsClients.destroy(),
  };
}

/**
 * Stable sort for `StackStateRef[]` — alphabetical by stackName (ASCII order,
 * matches the legacy `state list` sort), then by region with `null`/legacy
 * entries last.
 */
function sortRefs(refs: StackStateRef[]): StackStateRef[] {
  return refs.slice().sort((a, b) => {
    if (a.stackName < b.stackName) return -1;
    if (a.stackName > b.stackName) return 1;
    const ar = a.region ?? '￿';
    const br = b.region ?? '￿';
    if (ar < br) return -1;
    if (ar > br) return 1;
    return 0;
  });
}

/**
 * `cdkd state list` command implementation
 *
 * Lists stacks registered in the configured S3 state bucket. Each row is a
 * `(stackName, region)` pair — the same `stackName` deployed to two regions
 * shows up as two rows, which is the whole point of the region-prefixed
 * state key layout introduced in PR 1.
 *
 * - Default: `Stack (region)` per line, sorted alphabetically. Legacy
 *   `version: 1` records (no region) appear as plain `Stack` rows.
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
    const refs = sortRefs(await setup.stateBackend.listStacks());

    // Default mode: `Stack (region)` per line, sorted.
    if (!options.long && !options.json) {
      for (const ref of refs) {
        process.stdout.write(`${formatStackRef(ref)}\n`);
      }
      return;
    }

    // --json without --long: array of `{stackName, region}` records.
    if (options.json && !options.long) {
      const payload = refs.map((r) => ({ stackName: r.stackName, region: r.region ?? null }));
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }

    // --long (with or without --json): fetch detail per stack in parallel.
    const details: StackDetail[] = await Promise.all(
      refs.map(async (ref): Promise<StackDetail> => {
        // For legacy refs (no region), passing the legacy region string would
        // miss the legacy key — instead, lookup with whichever region the ref
        // carries (could be `undefined` for very-legacy records). The state
        // backend's getState uses the region as part of the key; for legacy
        // records the region embedded in the file is the one that matches.
        const lookupRegion = ref.region ?? '';
        const [stateResult, locked] = await Promise.all([
          lookupRegion
            ? setup.stateBackend.getState(ref.stackName, lookupRegion)
            : Promise.resolve(null),
          setup.lockManager.isLocked(ref.stackName, ref.region),
        ]);
        const state = stateResult?.state;
        return {
          stackName: ref.stackName,
          region: ref.region ?? null,
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
      lines.push(
        formatStackRef({
          stackName: detail.stackName,
          ...(detail.region ? { region: detail.region } : {}),
        })
      );
      lines.push(`  Region: ${detail.region ?? '(legacy)'}`);
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

  // --region is deprecated for state subcommands (PR 5). Accepted for
  // backward compatibility; warning emitted at runtime via
  // warnIfDeprecatedRegion (called from setupStateBackend).
  cmd.addOption(deprecatedRegionOption);

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
 * When the same stack name has state in multiple regions, requires
 * `--region <region>` to disambiguate. The error message lists candidate
 * regions so the next attempt is one keystroke away.
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
    stackRegion?: string;
    profile?: string;
    verbose: boolean;
  }
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  const setup = await setupStateBackend(options);
  try {
    const refs = await setup.stateBackend.listStacks();
    const ref = resolveSingleRegion(stackName, refs, options.stackRegion);
    if (!ref.region) {
      throw new Error(
        `Stack '${stackName}' has only a legacy state record without a region. ` +
          `Run 'cdkd deploy ${stackName}' (or any cdkd write) to migrate it to the region-scoped layout, ` +
          `then re-run this command.`
      );
    }
    const stateResult = await setup.stateBackend.getState(stackName, ref.region);
    if (!stateResult) {
      throw new Error(
        `No state found for stack '${stackName}' (${ref.region}) in s3://${setup.bucket}/${setup.prefix}/. ` +
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
    .addOption(stackRegionOption())
    .action(withErrorHandling(stateResourcesCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated for state subcommands (PR 5). Accepted for
  // backward compatibility; warning emitted at runtime via
  // warnIfDeprecatedRegion (called from setupStateBackend).
  cmd.addOption(deprecatedRegionOption);

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
 * When the same stack name has state in multiple regions, requires
 * `--region <region>` to disambiguate.
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
    stackRegion?: string;
    profile?: string;
    verbose: boolean;
  }
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  const setup = await setupStateBackend(options);
  try {
    const refs = await setup.stateBackend.listStacks();
    const ref = resolveSingleRegion(stackName, refs, options.stackRegion);
    if (!ref.region) {
      throw new Error(
        `Stack '${stackName}' has only a legacy state record without a region. ` +
          `Run 'cdkd deploy ${stackName}' (or any cdkd write) to migrate it to the region-scoped layout, ` +
          `then re-run this command.`
      );
    }

    const [stateResult, lockInfo] = await Promise.all([
      setup.stateBackend.getState(stackName, ref.region),
      setup.lockManager.getLockInfo(stackName, ref.region),
    ]);

    if (!stateResult) {
      throw new Error(
        `No state found for stack '${stackName}' (${ref.region}) in s3://${setup.bucket}/${setup.prefix}/. ` +
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
    .addOption(stackRegionOption())
    .action(withErrorHandling(stateShowCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated for state subcommands (PR 5). Accepted for
  // backward compatibility; warning emitted at runtime via
  // warnIfDeprecatedRegion (called from setupStateBackend).
  cmd.addOption(deprecatedRegionOption);

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
 * - Default: removes all region keys recorded for the stack, with a single
 *   confirmation that lists every region being affected. Use
 *   `--region <region>` to scope removal to one region when a stack name has
 *   state in multiple regions.
 * - Refuses to remove a locked region's state unless `--force` is set, since
 *   tearing the lock out from under an in-flight deploy can corrupt state.
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
    stackRegion?: string;
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
    const refs = await setup.stateBackend.listStacks();

    for (const stackName of stackArgs) {
      const stackRefs = refs.filter((r) => r.stackName === stackName);
      if (stackRefs.length === 0) {
        logger.info(`No state found for stack: ${stackName}, skipping`);
        continue;
      }

      // Pick which region(s) to remove. With --region, restrict to one. The
      // legacy entry (region: undefined) is matched only when --region is
      // absent — there's no legacy-only flag because the legacy key is
      // self-identifying via its missing region.
      const targets = options.stackRegion
        ? stackRefs.filter((r) => r.region === options.stackRegion)
        : stackRefs;

      if (targets.length === 0) {
        const seen = stackRefs.map((r) => r.region ?? '(legacy)').join(', ');
        throw new Error(
          `No state found for stack '${stackName}' in region '${options.stackRegion}'. ` +
            `Available regions: ${seen}.`
        );
      }

      // Lock check applies per region; --force bypasses it.
      if (!options.force) {
        for (const target of targets) {
          const locked = await setup.lockManager.isLocked(stackName, target.region);
          if (locked) {
            const where = target.region ?? '(legacy)';
            throw new Error(
              `Stack '${stackName}' (${where}) is locked. ` +
                `Run 'cdkd force-unlock ${stackName}${target.region ? ` --stack-region ${target.region}` : ''}' first, ` +
                `or pass --force to remove anyway.`
            );
          }
        }
      }

      // Single confirmation listing all regions being affected.
      if (!options.yes && !options.force) {
        const targetList = targets.map((t) => formatStackRef(t)).join(', ');
        process.stdout.write(
          `\nWARNING: This removes cdkd's state record for [${targetList}] only. ` +
            `AWS resources will NOT be deleted.\n` +
            `Use 'cdkd destroy ${stackName}' if you want to delete the actual resources.\n\n`
        );
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await rl.question(
          `Remove state for ${targetList} from s3://${setup.bucket}/${setup.prefix}/? (y/N): `
        );
        rl.close();
        const trimmed = answer.trim().toLowerCase();
        if (trimmed !== 'y' && trimmed !== 'yes') {
          logger.info(`Cancelled removal of state for stack: ${stackName}`);
          continue;
        }
      }

      // Iterate over every selected region. forceReleaseLock is idempotent
      // (no-op when no lock present). For legacy-only refs (no region) we
      // pass `undefined` to delete the legacy key; deleteState handles both.
      for (const target of targets) {
        if (target.region) {
          await setup.stateBackend.deleteState(stackName, target.region);
          await setup.lockManager.forceReleaseLock(stackName, target.region);
        } else {
          // Pure legacy record without a region body field: just sweep the
          // legacy key (which is what the no-region forceReleaseLock targets).
          await setup.lockManager.forceReleaseLock(stackName, undefined);
        }
        logger.info(`✓ Removed state for stack: ${formatStackRef(target)}`);
      }
    }
  } finally {
    setup.dispose();
  }
}

/**
 * Reusable `--region <region>` option for state subcommands. Aliased at the
 * commander level via `stackRegion` so it doesn't collide with the global
 * `--region` (AWS profile region) defined in `commonOptions`.
 */
function stackRegionOption(): Option {
  return new Option(
    '--stack-region <region>',
    'Region of the stack record to operate on. Required when the same stack name has state in multiple regions.'
  );
}

/**
 * Create the `state rm` subcommand.
 */
function createStateRmCommand(): Command {
  const cmd = new Command('rm')
    .description('Remove cdkd state for one or more stacks (does NOT delete AWS resources)')
    .argument('<stacks...>', 'Stack name(s) to remove from state')
    .option('-f, --force', 'Skip confirmation and remove even if the stack is locked', false)
    .addOption(stackRegionOption())
    .action(withErrorHandling(stateRmCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated for state subcommands (PR 5). Accepted for
  // backward compatibility; warning emitted at runtime via
  // warnIfDeprecatedRegion (called from setupStateBackend).
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}

/**
 * `cdkd state destroy <stacks...>` command implementation
 *
 * Destroys a stack's AWS resources AND removes its state record, **without**
 * requiring the CDK app (no synth). The intended audience is anyone who
 * needs to clean up a stack from a working directory that doesn't have the
 * CDK source — a teammate on a different machine, a CI cleanup job after the
 * source repo is gone, etc.
 *
 * Naming distinction:
 * - `cdkd destroy` — synth-driven, requires the CDK app, deletes resources +
 *   state.
 * - `cdkd state destroy` — state-driven, no synth needed, deletes resources +
 *   state.
 * - `cdkd state rm` — state-driven, no synth needed, deletes ONLY the state
 *   record. AWS resources are left intact.
 *
 * Region scoping: when a stack name has multiple state records spread across
 * regions (PR 1 territory), `--region` selects one. With the current single-
 * region-per-name layout the flag still works — it sets the AWS clients'
 * region and refuses to proceed if the loaded state.region disagrees.
 */
async function stateDestroyCommand(
  stackArgs: string[],
  options: {
    all?: boolean;
    yes: boolean;
    stateBucket?: string;
    statePrefix: string;
    region?: string;
    stackRegion?: string;
    profile?: string;
    verbose: boolean;
  }
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
    // Disable the live progress renderer in verbose mode — debug logs would
    // interleave too aggressively with the live area's in-flight task lines.
    process.env['CDKD_NO_LIVE'] = '1';
  }

  if (!options.all && stackArgs.length === 0) {
    throw new Error(
      'Stack name is required. Usage: cdkd state destroy <stack> [<stack>...] | --all'
    );
  }

  const setup = await setupStateBackend(options);
  const providerRegistry = new ProviderRegistry();
  registerAllProviders(providerRegistry);
  providerRegistry.setCustomResourceResponseBucket(setup.bucket);

  try {
    // Resolve target stack names from S3 (no synth). After PR 1, listStacks
    // returns one ref per (stackName, region) pair — same stackName across
    // two regions is two entries.
    const stateRefs = await setup.stateBackend.listStacks();
    const knownStackNames = new Set(stateRefs.map((r) => r.stackName));
    let stackNames: string[];
    if (options.all) {
      stackNames = [...knownStackNames].sort();
      if (stackNames.length === 0) {
        logger.info('No stacks found in state');
        return;
      }
    } else {
      // Be strict: every named stack must exist in state. Silently skipping
      // typos here would be more dangerous than helpful for a destroy command.
      const missing = stackArgs.filter((name) => !knownStackNames.has(name));
      if (missing.length > 0) {
        throw new Error(
          `No state found for stack(s): ${missing.join(', ')}. ` +
            `Run 'cdkd state list' to see available stacks.`
        );
      }
      stackNames = stackArgs;
    }

    // --all confirmation prompt (single prompt for the whole batch). The
    // per-stack prompt inside `runDestroyForStack` covers the per-stack case
    // when `--yes` is not given.
    if (options.all && !options.yes) {
      process.stdout.write(
        `\nWARNING: This destroys ${stackNames.length} stack(s) and removes their state records:\n`
      );
      for (const name of stackNames) {
        process.stdout.write(`  - ${name}\n`);
      }
      process.stdout.write('\n');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await rl.question(`Destroy all ${stackNames.length} stack(s)? (y/N): `);
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed !== 'y' && trimmed !== 'yes') {
        logger.info('Destroy cancelled');
        return;
      }
    }

    logger.info(`Found ${stackNames.length} stack(s) to destroy: ${stackNames.join(', ')}`);

    let totalErrors = 0;
    for (const stackName of stackNames) {
      // After PR 1, the same stackName can have state in multiple regions.
      // Pick the right ref(s):
      // - If --stack-region is given, take the matching ref (skip with warning if none).
      // - If only one region exists, take it.
      // - If multiple regions exist and no --stack-region, error out (ambiguous).
      const refs = stateRefs.filter((r) => r.stackName === stackName);
      let targets: typeof refs;
      if (options.stackRegion) {
        targets = refs.filter((r) => r.region === options.stackRegion || !r.region);
        if (targets.length === 0) {
          logger.warn(
            `Skipping ${stackName}: no state record matches --stack-region '${options.stackRegion}'`
          );
          continue;
        }
      } else if (refs.length === 1) {
        targets = refs;
      } else {
        const regions = refs.map((r) => r.region ?? '(legacy)').join(', ');
        throw new Error(
          `Stack '${stackName}' has state in multiple regions: ${regions}. ` +
            `Use --region <region> to pick one.`
        );
      }

      for (const ref of targets) {
        logger.info(
          `\nPreparing to destroy stack: ${stackName}${ref.region ? ` (${ref.region})` : ''}`
        );

        const stateResult = await setup.stateBackend.getState(
          stackName,
          ref.region ?? setup.region
        );
        if (!stateResult) {
          logger.warn(
            `No state found for stack ${stackName}${ref.region ? ` in ${ref.region}` : ''}, skipping`
          );
          continue;
        }

        const result = await runDestroyForStack(stackName, stateResult.state, {
          stateBackend: setup.stateBackend,
          lockManager: setup.lockManager,
          providerRegistry,
          baseAwsClients: setup.awsClients,
          baseRegion: setup.region,
          ...(options.profile && { profile: options.profile }),
          stateBucket: setup.bucket,
          // --yes covers both the --all batch prompt above (already consumed)
          // and the per-stack prompt inside the runner. Per-stack prompts are
          // skipped when `options.yes` is set OR `--all` was set (the user
          // already accepted the batch prompt).
          skipConfirmation: options.yes || options.all === true,
        });
        totalErrors += result.errorCount;
      }
    }

    if (totalErrors > 0) {
      throw new Error(
        `Destroy completed with ${totalErrors} resource error(s). ` +
          `Inspect 'cdkd state show <stack>' and re-run.`
      );
    }
  } finally {
    setup.dispose();
  }
}

/**
 * Create the `state destroy` subcommand.
 */
function createStateDestroyCommand(): Command {
  const cmd = new Command('destroy')
    .description(
      "Destroy a stack's AWS resources and remove its state record without requiring the CDK app. " +
        "For removing only the state record (keeping AWS resources intact), use 'cdkd state rm'."
    )
    .argument('[stacks...]', 'Stack name(s) to destroy (physical CloudFormation names)')
    .option('--all', 'Destroy every stack in the state bucket', false)
    .addOption(stackRegionOption())
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  cdkd state destroy MyStack',
        '  cdkd state destroy MyStack OtherStack',
        '  cdkd state destroy --all -y',
        '  cdkd state destroy MyStack --state-bucket cdkd-state-test',
        '  cdkd state destroy MyStack --stack-region us-west-2',
        '',
        "For removing only the state record (keeping AWS resources intact), use 'cdkd state rm'.",
      ].join('\n')
    )
    .action(withErrorHandling(stateDestroyCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated on every state subcommand (PR 5). Accepted for
  // backward compatibility; warning emitted at runtime.
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}

/**
 * Human-readable label for a {@link StateBucketSource}.
 *
 * Mirrors the `Source` column documented in `docs/plans/07-state-bucket-display.md`.
 */
function formatBucketSource(source: StateBucketSource): string {
  switch (source) {
    case 'cli-flag':
      return '--state-bucket flag';
    case 'env':
      return 'CDKD_STATE_BUCKET env';
    case 'cdk.json':
      return 'cdk.json (context.cdkd.stateBucket)';
    case 'default':
      return 'default (account ID from STS)';
  }
}

/**
 * Detect the bucket's actual region via S3 `GetBucketLocation`.
 *
 * Returns `undefined` when the call fails — the command should still succeed
 * and just report `unknown` rather than crash on a permission issue or a
 * not-yet-bootstrapped bucket. (Bucket existence is verified separately
 * via {@link setupStateBackend}, so getting here implies the bucket is
 * reachable; `GetBucketLocation` failing is most often a permissions gap.)
 */
async function detectBucketRegion(
  awsClients: AwsClients,
  bucket: string
): Promise<string | undefined> {
  try {
    const resp = await awsClients.s3.send(new GetBucketLocationCommand({ Bucket: bucket }));
    // S3 returns `null`/empty for us-east-1 (historical quirk).
    const constraint: string | undefined = resp.LocationConstraint;
    if (!constraint) return 'us-east-1';
    // EU is the legacy alias for eu-west-1.
    if (constraint === 'EU') return 'eu-west-1';
    return constraint;
  } catch {
    return undefined;
  }
}

/**
 * Walk the state-bucket prefix and collect every state.json key, regardless of
 * which layout produced it.
 *
 * Two layouts are supported here so the command keeps working both before and
 * after PR 1 (region segment) lands:
 * - Legacy: `<prefix>/<stackName>/state.json`
 * - New:    `<prefix>/<stackName>/<region>/state.json`
 *
 * Returns the full set of state-file keys; the count is the unique-stacks
 * tally we want for the `Stacks:` line.
 */
async function listStateFileKeys(
  awsClients: AwsClients,
  bucket: string,
  prefix: string
): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  const searchPrefix = `${prefix}/`;
  do {
    const resp = await awsClients.s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: searchPrefix,
        ...(continuationToken && { ContinuationToken: continuationToken }),
      })
    );
    for (const obj of resp.Contents ?? []) {
      const key = obj.Key;
      if (typeof key === 'string' && key.endsWith('/state.json')) {
        keys.push(key);
      }
    }
    continuationToken = resp.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

/**
 * Read one of the discovered state.json keys and pluck its schema version.
 * Returns `'unknown'` when no state files exist or parsing fails — we don't
 * want a cosmetic command to crash on an unexpected payload.
 */
async function readSchemaVersion(
  awsClients: AwsClients,
  bucket: string,
  keys: string[]
): Promise<number | 'unknown'> {
  if (keys.length === 0) return 'unknown';
  try {
    const resp = await awsClients.s3.send(new GetObjectCommand({ Bucket: bucket, Key: keys[0]! }));
    if (!resp.Body) return 'unknown';
    const body = await resp.Body.transformToString();
    const parsed = JSON.parse(body) as Partial<StackState>;
    return typeof parsed.version === 'number' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Shape of `cdkd state info --json` output. Documented as a stable contract
 * in the plan; downstream tooling may parse it.
 */
interface StateInfoJson {
  bucket: string;
  region: string | null;
  regionSource: 'flag' | 'auto-detected' | 'unknown';
  bucketSource: StateBucketSource;
  schemaVersion: number | 'unknown';
  stackCount: number;
}

/**
 * `cdkd state info` command implementation.
 *
 * Prints the state-bucket information that used to appear as a banner on
 * every command. Removed from default output (PR 7) because the bucket name
 * leaks the AWS account id into screenshots and CI logs; surface it
 * explicitly here when the user actually wants to know.
 *
 * Output shows: bucket name, region (auto-detected via `GetBucketLocation`),
 * the source that resolved the bucket (cli flag / env / cdk.json / default),
 * the state schema version (read from the first state file, or `unknown`
 * when the bucket is empty), and the total stack count (counts state files
 * at both `<prefix>/<stackName>/state.json` and
 * `<prefix>/<stackName>/<region>/state.json` so the result is correct
 * before and after PR 1's region-aware layout lands).
 *
 * `--json` emits the {@link StateInfoJson} shape for tooling.
 */
async function stateInfoCommand(options: {
  json: boolean;
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
  verbose: boolean;
}): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
    const resolved = await resolveStateBucketWithDefaultAndSource(options.stateBucket, region);
    const bucket = resolved.bucket;
    const prefix = options.statePrefix;

    const stateBackend = new S3StateBackend(awsClients.s3, { bucket, prefix });
    await stateBackend.verifyBucketExists();

    const detectedRegion = await detectBucketRegion(awsClients, bucket);
    const stateFileKeys = await listStateFileKeys(awsClients, bucket, prefix);
    const schemaVersion = await readSchemaVersion(awsClients, bucket, stateFileKeys);

    if (options.json) {
      const json: StateInfoJson = {
        bucket,
        region: detectedRegion ?? null,
        regionSource: detectedRegion ? 'auto-detected' : 'unknown',
        bucketSource: resolved.source,
        schemaVersion,
        stackCount: stateFileKeys.length,
      };
      process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
      return;
    }

    const lines: string[] = [];
    lines.push(`State bucket:    ${bucket}`);
    if (detectedRegion) {
      lines.push(`Region:          ${detectedRegion} (auto-detected via GetBucketLocation)`);
    } else {
      lines.push('Region:          unknown (GetBucketLocation failed or denied)');
    }
    lines.push(`Source:          ${formatBucketSource(resolved.source)}`);
    lines.push(`Schema version:  ${schemaVersion}`);
    lines.push(`Stacks:          ${stateFileKeys.length}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    awsClients.destroy();
  }
}

/**
 * Create the `state info` subcommand.
 */
function createStateInfoCommand(): Command {
  const cmd = new Command('info')
    .description(
      'Show cdkd state bucket info (bucket name, region, source, schema version, stack count)'
    )
    .option('--json', 'Output as JSON', false)
    .action(withErrorHandling(stateInfoCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  return cmd;
}

/**
 * Create the `state` parent command.
 *
 * Subcommands:
 * - `state info` — show bucket name, region, source, schema version, stack count
 * - `state list` (alias `ls`) — list stacks in the state bucket
 * - `state resources <stack>` — list resources of one stack
 * - `state show <stack>` — full state record (metadata, outputs, resources)
 * - `state rm <stack>...` — remove cdkd's state record (NOT AWS resources)
 * - `state destroy <stack>...` — delete AWS resources AND state record
 *   without requiring the CDK app (CDK-app-free version of `cdkd destroy`)
 */
export function createStateCommand(): Command {
  const cmd = new Command('state').description('Manage cdkd state stored in S3');
  cmd.addCommand(createStateInfoCommand());
  cmd.addCommand(createStateListCommand());
  cmd.addCommand(createStateResourcesCommand());
  cmd.addCommand(createStateShowCommand());
  cmd.addCommand(createStateRmCommand());
  cmd.addCommand(createStateDestroyCommand());
  return cmd;
}
