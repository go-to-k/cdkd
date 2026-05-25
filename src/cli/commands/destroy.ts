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
  type ResourceTimeoutOption,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import {
  NestedStackChildDirectDestroyError,
  PartialFailureError,
  StackTerminationProtectionError,
  withErrorHandling,
} from '../../utils/error-handler.js';
import { Synthesizer } from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { ExportIndexStore } from '../../state/export-index-store.js';
import { LockManager } from '../../state/lock-manager.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { withNestedStackContext } from '../../provisioning/nested-stack-context.js';
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
    roleArn?: string;
    yes: boolean;
    force: boolean;
    removeProtection?: boolean;
    verbose: boolean;
    context?: string[];
    allowUnsupportedTypes?: string[];
    resourceWarnAfter?: ResourceTimeoutOption;
    resourceTimeout?: ResourceTimeoutOption;
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
  // up front so the user sees the error before synth runs. Mutates
  // `options.resourceWarnAfter` in place when auto-lowering the inherited
  // warn against a shortened --resource-timeout (so the destroy-runner
  // call site below reads the lowered value).
  validateResourceTimeouts(options);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

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
    // Exports index store for post-destroy invalidation of this stack's
    // entries. Strong-reference safety checks scan state.json directly
    // (NOT the index), so the index is purely a perf hint for the
    // resolver on subsequent deploys.
    const exportIndexStore = new ExportIndexStore(
      awsClients.s3,
      stateBucket,
      options.statePrefix,
      region,
      stateBackend
    );
    const providerRegistry = new ProviderRegistry();

    // Register all SDK providers
    registerAllProviders(providerRegistry);

    // Configure custom resource response handling via S3
    providerRegistry.setCustomResourceResponseBucket(stateBucket);

    // Escape hatch: types deployed with --allow-unsupported-types must also be
    // destroyable, so route them through Cloud Control here too.
    if (options.allowUnsupportedTypes?.length) {
      providerRegistry.allowUnsupportedTypes(options.allowUnsupportedTypes);
    }

    // 2. Resolve stacks to destroy (CDK CLI compatible behavior)
    // Always synth to determine which stacks belong to this CDK app.
    const appCmd = options.app || resolveApp();
    // Local extension of `StackLike` that also carries the synth-derived
    // region and the manifest's `terminationProtection` flag. Stack-matcher
    // only reads stackName/displayName, so this is backwards-compatible
    // everywhere matchStacks is used. `terminationProtection` is consulted
    // in the per-stack loop below to refuse destroying protected stacks
    // before any lock or per-resource delete fires.
    type AppStack = StackLike & { region?: string; terminationProtection?: boolean };
    let appStacks: AppStack[] = [];

    if (appCmd) {
      try {
        const synthesizer = new Synthesizer();
        const context = parseContextOptions(options.context);
        const result = await synthesizer.synthesize({
          app: appCmd,
          output: options.output || 'cdk.out',
          ...(Object.keys(context).length > 0 && { context }),
          // Threaded so the macro-expander has a real state bucket for
          // the > 51,200-byte template upload path (Issue #463).
          stateBucket,
          ...(options.profile && { macroExpandS3ClientOpts: { profile: options.profile } }),
        });
        appStacks = result.stacks.map((s) => ({
          stackName: s.stackName,
          displayName: s.displayName,
          ...(s.region && { region: s.region }),
          ...(s.terminationProtection !== undefined && {
            terminationProtection: s.terminationProtection,
          }),
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

    // Aggregate error counts across stacks so a single partial failure
    // anywhere in the run propagates to a non-zero exit (PartialFailureError
    // → exit code 2). Mirrors `cdkd state destroy`'s totalErrors handling.
    // Hoisted out of the per-stack loop so the upfront nested-child-by-name
    // refusal (after the empty-match gate below) can use the same accumulator.
    let totalErrors = 0;

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
      // Special-case: when a user explicitly names a stack that doesn't appear
      // in candidateStacks but DOES exist in state with `parentStack` set, we
      // hit "No matching stacks found" — misleading, since the state file
      // exists but the synth-success filter excludes nested children (they
      // aren't CDK top-level stacks). Detect that case and surface the
      // dedicated A2 refusal so the user gets a clear "destroy the parent
      // instead" message instead of the generic miss. Only fires for
      // explicit, non-wildcard names — wildcards still get the generic miss
      // (they aren't a clear "destroy this specific child" intent).
      if (stackPatterns.length > 0) {
        const allStateNamesSet = new Set(allStateRefs.map((r) => r.stackName));
        for (const pattern of stackPatterns) {
          if (pattern.includes('*') || pattern.includes('?') || pattern.includes('/')) continue;
          if (!allStateNamesSet.has(pattern)) continue;
          // Single-region MVP per design §3 (`parentRegion === region` until
          // cross-region nested stacks ship). For v6 state — which is the
          // only state that has `parentStack` set, and therefore the only
          // state the refusal below acts on — `region` is always populated,
          // so the `?? region` tail is defensive against a hand-edited
          // legacy state file rather than a code path v6 writers reach.
          // A future cross-region extension should mirror the multi-region
          // disambiguation logic in the per-stack loop below.
          const refRegion = allStateRefs.find((r) => r.stackName === pattern)?.region ?? region;
          const stateOnlyResult = await stateBackend.getState(pattern, refRegion);
          if (stateOnlyResult?.state.parentStack) {
            const err = new NestedStackChildDirectDestroyError(
              pattern,
              stateOnlyResult.state.parentStack,
              stateOnlyResult.state.parentLogicalId
            );
            logger.error(`  ✗ ${err.message}`);
            totalErrors++;
          }
        }
        if (totalErrors > 0) {
          throw new PartialFailureError(
            `Destroy completed with ${totalErrors} resource error(s). State preserved — ` +
              `inspect 'cdkd state show <stack>' and re-run 'cdkd destroy' to retry.`
          );
        }
      }
      logger.info('No matching stacks found in state');
      return;
    }

    logger.info(`Found ${stackNames.length} stack(s) to destroy: ${stackNames.join(', ')}`);

    // accountId is only used to synthesize the parent's fake `Ref` ARN inside
    // `NestedStackProvider.create` — the destroy path never re-synthesizes
    // that ARN (each child's physicalId already lives in state and is
    // passed straight to `provider.delete`). Using the same `'unknown'`
    // placeholder as `cdkd state destroy` avoids an STS call that would
    // fail when no AWS credentials are configured (= the CI test env), and
    // matches the same pattern used by `state.ts` for the destroy path.
    const accountId = 'unknown';

    // Index state refs by stack name so we can resolve which region(s) each
    // stack has. Built once so the per-stack loop is cheap.
    const stateRefsByName = new Map<string, typeof allStateRefs>();
    for (const ref of allStateRefs) {
      const arr = stateRefsByName.get(ref.stackName) ?? [];
      arr.push(ref);
      stateRefsByName.set(ref.stackName, arr);
    }

    // 3. Process each stack via the shared destroy runner. The cross-stack
    // `totalErrors` accumulator is declared above (before the empty-match
    // gate) so the upfront nested-child-by-name refusal can also contribute.
    for (const stackName of stackNames) {
      logger.info(`\nPreparing to destroy stack: ${stackName}`);

      // Pick the region for this stack. If synth ran, prefer the synth region
      // (so a user changing env.region targets only that region). Otherwise,
      // use the unique state region; refuse with a helpful error when the
      // stack has multiple regions and the user did not pin one.
      const refs = stateRefsByName.get(stackName) ?? [];
      const synthStack = appStacks.find((s) => s.stackName === stackName);
      const synthRegion = synthStack?.region;

      // Stack-level terminationProtection guard. Refuse to destroy BEFORE any
      // lock acquisition or per-resource delete. In multi-stack runs (--all
      // or wildcard), a protected stack counts as a per-stack failure and
      // does NOT abort the rest — sibling unprotected stacks still get
      // destroyed, and the aggregated count surfaces as PartialFailureError
      // (exit 2) below. Mirrors CDK CLI's `cdk destroy` refusal but framed
      // through cdkd's partial-failure pipeline. `--remove-protection` is
      // the explicit opt-in bypass: log at WARN so the bypass is visible
      // in CI logs, then proceed with the destroy.
      if (synthStack?.terminationProtection === true) {
        if (options.removeProtection) {
          logger.warn(
            `Stack ${stackName} has terminationProtection: true — bypassing because --remove-protection set`
          );
        } else {
          const err = new StackTerminationProtectionError(stackName);
          logger.error(`  ✗ ${err.message}`);
          totalErrors++;
          continue;
        }
      }
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

      // Nested-stack child-only destroy refusal (#555 A2 / design §7). A
      // state record with `parentStack` set was written by
      // `NestedStackProvider.create` (or recursive `cdkd import
      // --migrate-from-cloudformation`) as a child of another stack;
      // directly destroying it without going through the parent would
      // leave the parent's `AWS::CloudFormation::Stack` record pointing
      // at gone-from-AWS resources, and the parent's next deploy would
      // silently try to re-create them. Mirrors CFn's own "can't
      // directly destroy a nested stack" semantic. `cdkd state destroy`
      // intentionally bypasses this guard — that's the documented
      // state-only escape hatch for users who accept the dangling
      // parent reference. Multi-stack runs (--all) count this as a
      // per-stack failure so siblings continue and the aggregated count
      // surfaces as PartialFailureError (exit 2).
      if (stateResult.state.parentStack) {
        const err = new NestedStackChildDirectDestroyError(
          stackName,
          stateResult.state.parentStack,
          stateResult.state.parentLogicalId
        );
        logger.error(`  ✗ ${err.message}`);
        totalErrors++;
        continue;
      }

      // Set the NestedStackProvider context for this destroy. The provider
      // is registered globally (it's state-less) and only fires when the
      // state file actually carries an AWS::CloudFormation::Stack record;
      // for stacks without nested children this is a cheap no-op.
      const result = await withNestedStackContext(
        {
          stateBackend,
          lockManager,
          providerRegistry,
          parentStackName: stackName,
          parentRegion: stackTargetRegion,
          accountId,
          awsClients,
          stateBucket,
          exportIndexStore,
          destroyOptions: {
            ...(options.profile && { profile: options.profile }),
            ...(options.removeProtection === true && { removeProtection: true }),
            ...(options.resourceWarnAfter?.globalMs !== undefined && {
              resourceWarnAfterMs: options.resourceWarnAfter.globalMs,
            }),
            ...(options.resourceTimeout?.globalMs !== undefined && {
              resourceTimeoutMs: options.resourceTimeout.globalMs,
            }),
            ...(options.resourceWarnAfter?.perTypeMs && {
              resourceWarnAfterByType: options.resourceWarnAfter.perTypeMs,
            }),
            ...(options.resourceTimeout?.perTypeMs && {
              resourceTimeoutByType: options.resourceTimeout.perTypeMs,
            }),
          },
        },
        () =>
          runDestroyForStack(stackName, stateResult.state, {
            stateBackend,
            lockManager,
            providerRegistry,
            baseAwsClients: awsClients,
            baseRegion: region,
            ...(options.profile && { profile: options.profile }),
            stateBucket,
            skipConfirmation: options.yes || options.force,
            removeProtection: options.removeProtection === true,
            exportIndexStore,
            ...(options.allowUnsupportedTypes?.length && {
              allowUnsupportedTypes: options.allowUnsupportedTypes,
            }),
            ...(options.resourceWarnAfter?.globalMs !== undefined && {
              resourceWarnAfterMs: options.resourceWarnAfter.globalMs,
            }),
            ...(options.resourceTimeout?.globalMs !== undefined && {
              resourceTimeoutMs: options.resourceTimeout.globalMs,
            }),
            ...(options.resourceWarnAfter?.perTypeMs && {
              resourceWarnAfterByType: options.resourceWarnAfter.perTypeMs,
            }),
            ...(options.resourceTimeout?.perTypeMs && {
              resourceTimeoutByType: options.resourceTimeout.perTypeMs,
            }),
          })
      );
      totalErrors += result.errorCount;
    }

    if (totalErrors > 0) {
      // Partial failure: per-stack runner already wrote the warning
      // banner and preserved state.json. Surface this distinctly from
      // "command crashed" so CI / bench scripts can detect the case
      // via exit code (PartialFailureError → exit 2, vs general
      // failures → exit 1).
      throw new PartialFailureError(
        `Destroy completed with ${totalErrors} resource error(s). State preserved — ` +
          `inspect 'cdkd state show <stack>' and re-run 'cdkd destroy' to retry.`
      );
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
