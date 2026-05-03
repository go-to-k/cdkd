import * as readline from 'node:readline/promises';
import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  destroyOptions,
  parseContextOptions,
  stateOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer } from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cdk-path.js';
import {
  rewriteResourceReferences,
  type OrphanRewrite,
  type UnresolvableReference,
} from '../../analyzer/orphan-rewriter.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';

interface OrphanOptions {
  app?: string;
  output?: string;
  stateBucket?: string;
  statePrefix: string;
  stackRegion?: string;
  region?: string;
  profile?: string;
  yes: boolean;
  force: boolean;
  dryRun: boolean;
  verbose: boolean;
  context?: string[];
}

/**
 * `cdkd orphan <constructPath>...` — per-resource orphan, mirrors upstream
 * `cdk orphan --unstable=orphan`.
 *
 * Removes one or more *resources* from cdkd's state for a single stack,
 * rewriting every sibling resource that referenced an orphan so the next
 * deploy doesn't try to re-create the orphan or fail to resolve a stale
 * Ref/GetAtt. **Does not** delete the underlying AWS resources — they
 * remain in AWS, just no longer tracked by cdkd.
 *
 * Migration note (PR #92): the previous "orphan a whole stack's state
 * record" behavior moved to `cdkd state orphan <stack>`; this command is
 * now per-resource and takes construct paths (`MyStack/MyTable`).
 *
 * Algorithm (mirrors upstream's 3-step CFn deploy via SDK calls):
 *
 *   1. Synth, load state, acquire lock.
 *   2. For each non-orphan resource, find every reference to an orphan
 *      in `properties` / `attributes` / `dependencies`:
 *      - `{Ref: O}` → orphan.physicalId
 *      - `{Fn::GetAtt: [O, attr]}` (and `"O.attr"` form) → live
 *        `provider.getAttribute(...)` value (cached per `(O, attr)`).
 *      - `Fn::Sub` template strings — `${O}` / `${O.attr}` placeholders
 *        substituted in place; unrelated placeholders preserved.
 *      - dependency-array entries equal to `O` removed.
 *   3. Apply rewrites + remove orphans from `state.resources` +
 *      `saveState` (If-Match) + release lock.
 *
 * Failure modes (hard-fail with `--force` escape hatch):
 *
 *   - Path doesn't match any resource — error listing available paths.
 *   - Multiple paths reference different stacks — error.
 *   - Reference can't be resolved (provider doesn't implement that attr,
 *     OR the API call fails) — error listing every unresolvable site at
 *     once. With `--force`: fall back to `state.attributes` cache; if
 *     the cache also lacks the attr, leave the original intrinsic
 *     untouched.
 */
async function orphanCommand(pathArgs: string[], options: OrphanOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  warnIfDeprecatedRegion(options);

  if (pathArgs.length === 0) {
    throw new Error(
      "'cdkd orphan' requires at least one construct path, e.g. 'cdkd orphan MyStack/MyTable'.\n" +
        "       To remove a stack's state record (the previous behavior), use:\n" +
        '         cdkd state orphan MyStack'
    );
  }

  // Detect the pre-PR "stack name only" syntax and redirect with an
  // explicit error rather than silently routing — the new behavior is a
  // breaking change and we want users to make a conscious choice between
  // per-resource orphan and the state-orphan route.
  for (const p of pathArgs) {
    if (!p.includes('/')) {
      throw new Error(
        `'cdkd orphan' now expects a construct path like 'MyStack/MyTable'.\n` +
          `       Got: '${p}'\n` +
          `       To remove a stack's state record (the previous behavior), use:\n` +
          `         cdkd state orphan ${p}`
      );
    }
  }

  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

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
    const stateConfig = { bucket: stateBucket, prefix: options.statePrefix };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
    });
    await stateBackend.verifyBucketExists();
    const lockManager = new LockManager(awsClients.s3, stateConfig);

    // Synth — required for orphan: we need the template to resolve construct
    // paths back to logical IDs.
    const appCmd = options.app || resolveApp();
    if (!appCmd) {
      throw new Error(
        "'cdkd orphan' requires a CDK app: pass --app or set it in cdk.json. " +
          'The template is read to resolve construct paths to logical IDs.'
      );
    }

    logger.info('Synthesizing CDK app to read template...');
    const synthesizer = new Synthesizer();
    const context = parseContextOptions(options.context);
    const result = await synthesizer.synthesize({
      app: appCmd,
      output: options.output || 'cdk.out',
      ...(Object.keys(context).length > 0 && { context }),
    });

    // Resolve each path to (stack, logicalId). Every path must reference the
    // same stack — orphan operates on one state file at a time.
    const resolved = resolveConstructPaths(pathArgs, result.stacks);
    const stackInfo = resolved.stack;
    const orphanLogicalIds = resolved.logicalIds;

    const targetRegion = await pickStackRegion(
      stateBackend,
      stackInfo.stackName,
      stackInfo.region,
      options.stackRegion
    );

    logger.info(
      `Target: ${stackInfo.stackName} (${targetRegion}); orphaning ${orphanLogicalIds.length} resource(s): ${orphanLogicalIds.join(', ')}`
    );

    // Acquire lock so a concurrent deploy can't observe the half-rewritten
    // state. Skip in --dry-run to keep dry-run a pure read.
    const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
    if (!options.dryRun) {
      await lockManager.acquireLock(stackInfo.stackName, targetRegion, owner, 'orphan');
    }

    try {
      const stateData = await stateBackend.getState(stackInfo.stackName, targetRegion);
      if (!stateData) {
        throw new Error(
          `No state found for stack '${stackInfo.stackName}' (${targetRegion}). ` +
            `Nothing to orphan. (Did the stack get deployed?)`
        );
      }
      const { state, etag, migrationPending } = stateData;

      // Validate that every requested orphan exists in state — otherwise we
      // would silently no-op while the user expected a removal.
      const missing = orphanLogicalIds.filter((id) => !(id in state.resources));
      if (missing.length > 0) {
        const have = Object.keys(state.resources).join(', ');
        throw new Error(
          `Resource(s) not in state for stack '${stackInfo.stackName}' (${targetRegion}): ` +
            `${missing.join(', ')}.\n` +
            `Available logical IDs: ${have}`
        );
      }

      const providerRegistry = new ProviderRegistry();
      registerAllProviders(providerRegistry);

      const rewriteResult = await rewriteResourceReferences(
        state,
        orphanLogicalIds,
        providerRegistry,
        { force: options.force }
      );

      printRewriteSummary(rewriteResult.rewrites, orphanLogicalIds);

      if (rewriteResult.unresolvable.length > 0 && !options.force) {
        printUnresolvable(rewriteResult.unresolvable);
        throw new Error(
          `Orphan aborted: ${rewriteResult.unresolvable.length} reference(s) could not be resolved.\n` +
            `Re-run with --force to fall back to cached attribute values from state, ` +
            `or fix the underlying provider/AWS issue and retry.`
        );
      }
      if (rewriteResult.unresolvable.length > 0) {
        // --force path: print but don't abort.
        printUnresolvable(rewriteResult.unresolvable);
        logger.warn(
          `--force: continuing despite ${rewriteResult.unresolvable.length} unresolved reference(s); ` +
            `the original intrinsic was left in place where the cache also lacked the value.`
        );
      }

      if (options.dryRun) {
        logger.info('--dry-run: state will NOT be written. Re-run without --dry-run to apply.');
        return;
      }

      if (!options.yes && !options.force) {
        const ok = await confirmPrompt(
          `Orphan ${orphanLogicalIds.length} resource(s) from cdkd state for ` +
            `${stackInfo.stackName} (${targetRegion})? AWS resources will NOT be deleted.`
        );
        if (!ok) {
          logger.info('Orphan cancelled.');
          return;
        }
      }

      await stateBackend.saveState(stackInfo.stackName, targetRegion, rewriteResult.state, {
        expectedEtag: etag,
        ...(migrationPending && { migrateLegacy: true }),
      });

      logger.info(
        `Orphaned ${orphanLogicalIds.length} resource(s) from state: ${stackInfo.stackName} (${targetRegion}). ` +
          `AWS resources are still in AWS; cdkd will no longer manage them.`
      );
    } finally {
      if (!options.dryRun) {
        await lockManager.releaseLock(stackInfo.stackName, targetRegion).catch((err) => {
          logger.warn(
            `Failed to release lock: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      }
    }
  } finally {
    awsClients.destroy();
  }
}

/**
 * Resolve every user-supplied construct path to a `(stack, logicalId)`
 * pair, enforcing that all paths reference the same stack.
 *
 * The first segment of each path must be a synthesized stack's
 * `displayName` (or `stackName`); the remainder is the path that CDK
 * encodes into the `aws:cdk:path` Metadata tag (e.g.
 * `MyStack/MyTable/Resource`). We index the template by that tag and
 * look the rest up there.
 */
function resolveConstructPaths(
  paths: string[],
  stacks: StackInfo[]
): { stack: StackInfo; logicalIds: string[] } {
  const byStackName = new Map<string, StackInfo>();
  const byDisplayName = new Map<string, StackInfo>();
  for (const s of stacks) {
    byStackName.set(s.stackName, s);
    byDisplayName.set(s.displayName, s);
  }

  let stack: StackInfo | undefined;
  const logicalIds: string[] = [];

  for (const p of paths) {
    const slash = p.indexOf('/');
    if (slash <= 0 || slash === p.length - 1) {
      throw new Error(`Invalid construct path '${p}'. Expected '<StackName>/<Path/To/Resource>'.`);
    }
    const head = p.slice(0, slash);
    const candidate = byDisplayName.get(head) ?? byStackName.get(head);
    if (!candidate) {
      const available = stacks.map((s) => s.displayName ?? s.stackName).join(', ');
      throw new Error(
        `Construct path '${p}': stack '${head}' not found in synthesized app. ` +
          `Available: ${available}`
      );
    }
    if (stack === undefined) {
      stack = candidate;
    } else if (stack.stackName !== candidate.stackName) {
      throw new Error(
        `All construct paths must reference the same stack. ` +
          `Got '${stack.stackName}' and '${candidate.stackName}'. ` +
          `Run 'cdkd orphan' once per stack.`
      );
    }

    // Match the input as an L2 path (orphan everything under it) OR an
    // exact L1 path. Mirrors upstream `cdk orphan --unstable=orphan`'s
    // prefix-match strategy so users can pass `MyStack/MyConstruct/Bucket`
    // instead of the synthesized `MyStack/MyConstruct/Bucket/Resource`.
    const index = buildCdkPathIndex(candidate.template);
    const matches = resolveCdkPathToLogicalIds(p, index);
    if (matches.length === 0) {
      const available = [...index.keys()].sort().join('\n  ');
      throw new Error(
        `Construct path '${p}' not found in template for stack '${candidate.stackName}'.\n` +
          `Available paths:\n  ${available}`
      );
    }
    for (const { logicalId } of matches) {
      if (!logicalIds.includes(logicalId)) {
        logicalIds.push(logicalId);
      }
    }
  }

  if (!stack) {
    throw new Error('No construct paths supplied.');
  }
  return { stack, logicalIds };
}

/**
 * Decide which region's state to operate on. Mirrors the disambiguation
 * logic shared with `state resources` / `state show`: prefer the
 * synthesized stack's region, then `--stack-region`, then the single
 * region in state. Errors out with a clear list when ambiguous.
 */
async function pickStackRegion(
  stateBackend: S3StateBackend,
  stackName: string,
  synthRegion: string | undefined,
  flag: string | undefined
): Promise<string> {
  const refs = (await stateBackend.listStacks()).filter((r) => r.stackName === stackName);
  if (refs.length === 0) {
    if (flag) return flag;
    if (synthRegion) return synthRegion;
    throw new Error(
      `No state found for stack '${stackName}'. Run 'cdkd state list' to see available stacks.`
    );
  }
  if (flag) {
    const found = refs.find((r) => r.region === flag);
    if (!found) {
      const seen = refs.map((r) => r.region ?? '(legacy)').join(', ');
      throw new Error(
        `No state found for stack '${stackName}' in region '${flag}'. ` +
          `Available regions: ${seen}.`
      );
    }
    return flag;
  }
  if (synthRegion) {
    const found = refs.find((r) => r.region === synthRegion);
    if (found) return synthRegion;
  }
  if (refs.length === 1) {
    return refs[0]!.region ?? synthRegion ?? '';
  }
  const regions = refs.map((r) => r.region ?? '(legacy)').join(', ');
  throw new Error(
    `Stack '${stackName}' has state in multiple regions: ${regions}. ` +
      `Re-run with --stack-region <region> to disambiguate.`
  );
}

function printRewriteSummary(rewrites: OrphanRewrite[], orphanLogicalIds: string[]): void {
  const logger = getLogger();
  logger.info('');
  logger.info(`Orphaning ${orphanLogicalIds.length} resource(s): ${orphanLogicalIds.join(', ')}`);
  if (rewrites.length === 0) {
    logger.info('  No sibling references — every reference was already to a non-orphan resource.');
    return;
  }
  logger.info(`Applied ${rewrites.length} rewrite(s):`);
  for (const r of rewrites) {
    const before = stringifyForAudit(r.before);
    const after = r.kind === 'dependency' ? '(dropped)' : stringifyForAudit(r.after);
    logger.info(`  [${r.kind}] ${r.logicalId}.${r.path}: ${before} → ${after}`);
  }
}

function printUnresolvable(unresolvable: UnresolvableReference[]): void {
  const logger = getLogger();
  logger.error(`${unresolvable.length} reference(s) could not be resolved:`);
  for (const u of unresolvable) {
    logger.error(`  ${u.logicalId}.${u.path}: ${u.orphanLogicalId}.${u.attribute} — ${u.reason}`);
  }
}

function stringifyForAudit(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value);
}

async function confirmPrompt(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`${prompt} [y/N] `);
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

/**
 * Create the top-level `cdkd orphan` command.
 */
export function createOrphanCommand(): Command {
  const cmd = new Command('orphan')
    .description(
      'Remove one or more resources from cdkd state by construct path (does NOT delete AWS ' +
        "resources). Mirrors aws-cdk-cli's 'cdk orphan --unstable=orphan'. Synth-driven; for " +
        "the previous whole-stack-orphan behavior, use 'cdkd state orphan <stack>'."
    )
    .argument(
      '<paths...>',
      "Construct paths to orphan, e.g. 'MyStack/MyTable'. Multiple paths must reference the same stack."
    )
    .option(
      '--stack-region <region>',
      'Region of the stack record to operate on. Required when the same stack name has state in multiple regions.'
    )
    .option(
      '--dry-run',
      'Compute and print the rewrite audit table without acquiring a lock or saving state.',
      false
    )
    .action(withErrorHandling(orphanCommand));

  [
    ...commonOptions,
    ...appOptions,
    ...stateOptions,
    ...destroyOptions, // adds -f / --force (escape hatch for unresolvable references + skip confirm)
    ...contextOptions,
  ].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated outside of bootstrap (PR 5).
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
