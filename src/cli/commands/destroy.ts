import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  deprecatedRegionOption,
  stateOptions,
  stackOptions,
  destroyOptions,
  resourceTimeoutOptions,
  contextOptions,
  parseContextOptions,
  warnIfDeprecatedRegion,
  validateResourceTimeouts,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer } from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';
import { matchStacks, describeStack, type StackLike } from '../stack-matcher.js';
import { runDestroyForStack } from './destroy-runner.js';

/**
 * Destroy command implementation
 */
async function destroyCommand(
  stackArgs: string[],
  options: {
    app?: string;
    output?: string;
    stateBucket?: string;
    statePrefix: string;
    stack?: string;
    all?: boolean;
    region?: string;
    profile?: string;
    yes: boolean;
    force: boolean;
    verbose: boolean;
    context?: string[];
    resourceWarnAfter: number;
    resourceTimeout: number;
  }
): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
    // Disable the live progress renderer in verbose mode — debug logs would
    // interleave too aggressively with the live area's in-flight task lines.
    process.env['CDKD_NO_LIVE'] = '1';
  }

  // PR 5: --region is deprecated on non-bootstrap commands. Warn but keep
  // the rest of the pipeline working as before.
  warnIfDeprecatedRegion(options);

  // Reject mis-ordered --resource-warn-after / --resource-timeout pairs
  // up front so the user sees the error before synth runs.
  validateResourceTimeouts({
    resourceWarnAfter: options.resourceWarnAfter,
    resourceTimeout: options.resourceTimeout,
  });

  // Resolve --state-bucket from CLI, env, cdk.json, or default
  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  logger.info('Starting stack destruction...');
  logger.debug('Options:', options);

  // Initialize AWS clients with region/profile
  // Also set AWS_REGION env for providers using local SDK clients
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
    // 1. Initialize components
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
    // Fail fast if the state bucket is missing, before synth or any destructive work.
    await stateBackend.verifyBucketExists();
    const lockManager = new LockManager(awsClients.s3, stateConfig);
    const providerRegistry = new ProviderRegistry();

    // Register all SDK providers
    registerAllProviders(providerRegistry);

    // Configure custom resource response handling via S3
    providerRegistry.setCustomResourceResponseBucket(stateBucket);

    // 2. Resolve stacks to destroy (CDK CLI compatible behavior)
    // Always synth to determine which stacks belong to this CDK app.
    const appCmd = options.app || resolveApp();
    // Local extension of `StackLike` that also carries the synth-derived
    // region. Stack-matcher only reads stackName/displayName, so this is
    // backwards-compatible everywhere matchStacks is used.
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

    // Determine candidate stacks. State only carries physical names + regions
    // (no display path), so when synth is unavailable we fall back to a
    // stackName-only candidate list (display-path patterns like
    // "MyStage/MyStack" simply will not match anything in that mode).
    const allStateRefs = await stateBackend.listStacks();
    // Map stackName -> first region (collision warning emitted later if a
    // stack has multiple region keys). Synth-driven destroy is single-region:
    // if synth.region matches one of the records we use it; otherwise we
    // surface a clear error.
    let candidateStacks: StackLike[];
    if (appStacks.length > 0) {
      // App synth succeeded: only consider stacks from this app
      const stateNames = new Set(allStateRefs.map((r) => r.stackName));
      candidateStacks = appStacks.filter((s) => stateNames.has(s.stackName));
    } else if (stackArgs.length > 0 || options.stack || options.all) {
      // No synth but explicit stack names or --all given: use state stacks
      // (deduplicate by name so a stack with two region records appears once
      // — the per-stack loop handles the multi-region case explicitly)
      const seen = new Set<string>();
      candidateStacks = [];
      for (const ref of allStateRefs) {
        if (seen.has(ref.stackName)) continue;
        seen.add(ref.stackName);
        candidateStacks.push({ stackName: ref.stackName });
      }
    } else {
      // No synth and no explicit stacks: refuse to guess
      throw new Error(
        'Could not determine which stacks belong to this app. ' +
          'Specify stack names explicitly, use --all, or ensure --app / cdk.json is configured.'
      );
    }

    const stackPatterns = stackArgs.length > 0 ? stackArgs : options.stack ? [options.stack] : [];

    let stackNames: string[];
    if (options.all) {
      // --all: destroy all stacks in the current app
      stackNames = candidateStacks.map((s) => s.stackName);
    } else if (stackPatterns.length > 0) {
      // Explicit stack names or wildcards
      stackNames = matchStacks(candidateStacks, stackPatterns).map((s) => s.stackName);
    } else if (candidateStacks.length === 1) {
      // Single stack: auto-select (CDK CLI compatible)
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

    logger.info(`Found ${stackNames.length} stack(s) to destroy: ${stackNames.join(', ')}`);

    // Index state refs by stack name so we can resolve which region(s) each
    // stack has. Built once so the per-stack loop is cheap.
    const stateRefsByName = new Map<string, typeof allStateRefs>();
    for (const ref of allStateRefs) {
      const arr = stateRefsByName.get(ref.stackName) ?? [];
      arr.push(ref);
      stateRefsByName.set(ref.stackName, arr);
    }

    // 3. Process each stack via the shared destroy runner.
    for (const stackName of stackNames) {
      logger.info(`\nPreparing to destroy stack: ${stackName}`);

      // Pick the region for this stack. If synth ran, prefer the synth region
      // (so a user changing env.region targets only that region). Otherwise,
      // use the unique state region; refuse with a helpful error when the
      // stack has multiple regions and the user did not pin one.
      const refs = stateRefsByName.get(stackName) ?? [];
      const synthStack = appStacks.find((s) => s.stackName === stackName);
      const synthRegion = synthStack?.region;
      let stackTargetRegion: string;
      if (refs.length === 0) {
        logger.warn(`No state found for stack ${stackName}, skipping`);
        continue;
      } else if (refs.length === 1) {
        const onlyRegion = refs[0]?.region;
        if (!onlyRegion) {
          // Legacy state with no recorded region: fall back to the CLI region.
          stackTargetRegion = region;
        } else {
          stackTargetRegion = onlyRegion;
        }
      } else if (synthRegion && refs.some((r) => r.region === synthRegion)) {
        stackTargetRegion = synthRegion;
      } else {
        const regions = refs.map((r) => r.region ?? '(legacy)').join(', ');
        throw new Error(
          `Stack '${stackName}' has state in multiple regions: ${regions}. ` +
            `Use 'cdkd state orphan ${stackName} --stack-region <region>' to remove cdkd's record for one ` +
            `region, or run destroy from a CDK app whose env.region matches one of them.`
        );
      }

      // Load current state for the chosen region
      const stateResult = await stateBackend.getState(stackName, stackTargetRegion);
      if (!stateResult) {
        logger.warn(`No state found for stack ${stackName}, skipping`);
        continue;
      }

      await runDestroyForStack(stackName, stateResult.state, {
        stateBackend,
        lockManager,
        providerRegistry,
        baseAwsClients: awsClients,
        baseRegion: region,
        ...(options.profile && { profile: options.profile }),
        stateBucket,
        skipConfirmation: options.yes || options.force,
        resourceWarnAfterMs: options.resourceWarnAfter,
        resourceTimeoutMs: options.resourceTimeout,
      });
    }
  } finally {
    // Cleanup AWS clients
    awsClients.destroy();
  }
}

/**
 * Create destroy command
 */
export function createDestroyCommand(): Command {
  const cmd = new Command('destroy')
    .description('Destroy all resources in the stack')
    .argument(
      '[stacks...]',
      "Stack name(s) to destroy. Accepts physical CloudFormation names (e.g. 'MyStage-Api') or CDK display paths (e.g. 'MyStage/Api'). Supports wildcards (e.g. 'MyStage/*')."
    )
    .option('--all', 'Destroy all stacks', false)
    .action(withErrorHandling(destroyCommand));

  // Add options (appOptions accepted for CDK CLI compatibility, but not used)
  [
    ...commonOptions,
    ...appOptions,
    ...stateOptions,
    ...stackOptions,
    ...destroyOptions,
    ...resourceTimeoutOptions,
    ...contextOptions,
  ].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated for destroy (PR 5). Accepted for backward
  // compatibility; warning emitted at runtime via warnIfDeprecatedRegion.
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
