import * as readline from 'node:readline/promises';
import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  deprecatedRegionOption,
  stateOptions,
  stackOptions,
  destroyOptions,
  contextOptions,
  parseContextOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer } from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';
import { matchStacks, describeStack, type StackLike } from '../stack-matcher.js';

/**
 * `cdkd orphan <stack>...` command implementation
 *
 * Synth-driven counterpart to `cdkd state orphan`. Mirrors the new
 * `cdk orphan` command in aws-cdk-cli: removes the cdkd state record for
 * each matched stack while leaving the underlying AWS resources alone.
 *
 * Naming distinction (CDK CLI parity):
 * - `cdkd destroy`         — synth-driven, deletes resources + state.
 * - `cdkd state destroy`   — state-driven (no CDK app), deletes resources + state.
 * - `cdkd orphan`          — synth-driven, deletes ONLY the state record.
 * - `cdkd state orphan`    — state-driven (no CDK app), deletes ONLY the state record.
 *
 * The synth-driven variant is convenient when you have the CDK source: it
 * reuses the same stack-selection / pattern-matching pipeline as `deploy`
 * and `destroy` (display-path patterns like `MyStage/*` work, single-stack
 * auto-detection works, etc.) and only operates on stacks that belong to
 * the current CDK app.
 */
async function orphanCommand(
  stackArgs: string[],
  options: {
    app?: string;
    output?: string;
    stateBucket?: string;
    statePrefix: string;
    stack?: string;
    all?: boolean;
    stackRegion?: string;
    region?: string;
    profile?: string;
    yes: boolean;
    force: boolean;
    verbose: boolean;
    context?: string[];
  }
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  // --region is deprecated everywhere except bootstrap; warn and ignore.
  warnIfDeprecatedRegion(options);

  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  logger.info('Starting stack orphan...');
  logger.debug('Options:', options);

  if (options.region) {
    process.env['AWS_REGION'] = options.region;
    process.env['AWS_DEFAULT_REGION'] = options.region;
  }
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    const stateConfig = {
      bucket: stateBucket,
      prefix: options.statePrefix,
    };
    // Pass region/profile so the backend can rebuild its S3 client if the
    // bucket lives in a region different from the CLI's profile region.
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
    });
    await stateBackend.verifyBucketExists();
    const lockManager = new LockManager(awsClients.s3, stateConfig);

    // Resolve target stacks via synth (CDK CLI parity with destroy.ts).
    const appCmd = options.app || resolveApp();
    type AppStack = StackLike & { region?: string };
    let appStacks: AppStack[] = [];

    if (appCmd) {
      try {
        const synthesizer = new Synthesizer();
        const context = parseContextOptions(options.context);
        const result = await synthesizer.synthesize({
          app: appCmd,
          output: options.output || 'cdk.out',
          ...(Object.keys(context).length > 0 && { context }),
        });
        appStacks = result.stacks.map((s) => ({
          stackName: s.stackName,
          displayName: s.displayName,
          ...(s.region && { region: s.region }),
        }));
      } catch {
        logger.debug('Could not synthesize app, falling back to state-based stack list');
      }
    }

    const allStateRefs = await stateBackend.listStacks();

    // Build candidate list. Mirrors destroy.ts so display-path patterns and
    // auto-detection behave identically.
    let candidateStacks: StackLike[];
    if (appStacks.length > 0) {
      const stateNames = new Set(allStateRefs.map((r) => r.stackName));
      candidateStacks = appStacks.filter((s) => stateNames.has(s.stackName));
    } else if (stackArgs.length > 0 || options.stack || options.all) {
      const seen = new Set<string>();
      candidateStacks = [];
      for (const ref of allStateRefs) {
        if (seen.has(ref.stackName)) continue;
        seen.add(ref.stackName);
        candidateStacks.push({ stackName: ref.stackName });
      }
    } else {
      throw new Error(
        'Could not determine which stacks belong to this app. ' +
          'Specify stack names explicitly, use --all, or ensure --app / cdk.json is configured.'
      );
    }

    const stackPatterns = stackArgs.length > 0 ? stackArgs : options.stack ? [options.stack] : [];

    let stackNames: string[];
    if (options.all) {
      stackNames = candidateStacks.map((s) => s.stackName);
    } else if (stackPatterns.length > 0) {
      stackNames = matchStacks(candidateStacks, stackPatterns).map((s) => s.stackName);
    } else if (candidateStacks.length === 1) {
      stackNames = candidateStacks.map((s) => s.stackName);
    } else if (candidateStacks.length === 0) {
      logger.info('No stacks found in state');
      return;
    } else {
      throw new Error(
        `Multiple stacks found: ${candidateStacks.map(describeStack).join(', ')}. ` +
          `Specify stack name(s) or use --all`
      );
    }

    if (stackNames.length === 0) {
      logger.info('No matching stacks found in state');
      return;
    }

    logger.info(`Found ${stackNames.length} stack(s) to orphan: ${stackNames.join(', ')}`);

    // Index state refs by stack name for the per-stack loop.
    const stateRefsByName = new Map<string, typeof allStateRefs>();
    for (const ref of allStateRefs) {
      const arr = stateRefsByName.get(ref.stackName) ?? [];
      arr.push(ref);
      stateRefsByName.set(ref.stackName, arr);
    }

    const skipConfirmation = options.yes || options.force;

    for (const stackName of stackNames) {
      const refs = stateRefsByName.get(stackName) ?? [];
      if (refs.length === 0) {
        logger.info(`No state found for stack: ${stackName}, skipping`);
        continue;
      }

      // Pick which region(s) to orphan. With --stack-region, restrict to one.
      const targets = options.stackRegion
        ? refs.filter((r) => r.region === options.stackRegion)
        : refs;

      if (targets.length === 0) {
        const seen = refs.map((r) => r.region ?? '(legacy)').join(', ');
        throw new Error(
          `No state found for stack '${stackName}' in region '${options.stackRegion}'. ` +
            `Available regions: ${seen}.`
        );
      }

      // Lock check applies per region; --force bypasses it. Same behavior as
      // `cdkd state orphan` so users get a consistent guard-rail.
      if (!options.force) {
        for (const target of targets) {
          const locked = await lockManager.isLocked(stackName, target.region);
          if (locked) {
            const where = target.region ?? '(legacy)';
            throw new Error(
              `Stack '${stackName}' (${where}) is locked. ` +
                `Run 'cdkd force-unlock ${stackName}${target.region ? ` --stack-region ${target.region}` : ''}' first, ` +
                `or pass --force to orphan anyway.`
            );
          }
        }
      }

      // Single confirmation listing all regions being affected.
      if (!skipConfirmation) {
        const targetList = targets
          .map((t) => (t.region ? `${stackName} (${t.region})` : stackName))
          .join(', ');
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
          `Orphan state for ${targetList} from s3://${stateBucket}/${options.statePrefix}/? (y/N): `
        );
        rl.close();
        const trimmed = answer.trim().toLowerCase();
        if (trimmed !== 'y' && trimmed !== 'yes') {
          logger.info(`Cancelled orphan of stack: ${stackName}`);
          continue;
        }
      }

      for (const target of targets) {
        if (target.region) {
          await stateBackend.deleteState(stackName, target.region);
          await lockManager.forceReleaseLock(stackName, target.region);
        } else {
          // Pure legacy record without a region body field: just sweep the
          // legacy lock key; deleteState requires a region.
          await lockManager.forceReleaseLock(stackName, undefined);
        }
        const label = target.region ? `${stackName} (${target.region})` : stackName;
        logger.info(`✓ Orphaned state for stack: ${label}`);
      }
    }
  } finally {
    awsClients.destroy();
  }
}

/**
 * Create the top-level `cdkd orphan` command.
 */
export function createOrphanCommand(): Command {
  const cmd = new Command('orphan')
    .description(
      "Remove cdkd's state record for one or more stacks (does NOT delete AWS resources). " +
        "Synth-driven; for the CDK-app-free version use 'cdkd state orphan'."
    )
    .argument(
      '[stacks...]',
      "Stack name(s) to orphan. Accepts physical CloudFormation names (e.g. 'MyStage-Api') or CDK display paths (e.g. 'MyStage/Api'). Supports wildcards (e.g. 'MyStage/*')."
    )
    .option('--all', 'Orphan all stacks in the current app', false)
    .option(
      '--stack-region <region>',
      'Region of the stack record to operate on. Required when the same stack name has state in multiple regions.'
    )
    .action(withErrorHandling(orphanCommand));

  [
    ...commonOptions,
    ...appOptions,
    ...stateOptions,
    ...stackOptions,
    ...destroyOptions,
    ...contextOptions,
  ].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated outside of bootstrap (PR 5).
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
