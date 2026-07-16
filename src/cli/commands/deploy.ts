import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  deprecatedRegionOption,
  stateOptions,
  stackOptions,
  deployOptions,
  contextOptions,
  parseContextOptions,
  warnIfDeprecatedRegion,
  validateResourceTimeouts,
  type ResourceTimeoutOption,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { bold, cyan, gray, green, red, yellow } from '../../utils/colors.js';
import { withErrorHandling, CdkdError } from '../../utils/error-handler.js';
import {
  validateRecreateTargets,
  renderRecreateTargetsErrors,
  probeAndRevalidateStateful,
} from '../../deployment/recreate-targets.js';
import { promptRecreateConfirm } from './recreate-confirm-prompt.js';
import { findDownstreamConsumers } from './recreate-downstream-consumers.js';
import { Synthesizer, synthesisStatusMessage } from '../../synthesis/synthesizer.js';
import { AssetPublisher } from '../../assets/asset-publisher.js';
import { AssetModeResolver } from '../../assets/asset-storage.js';
import {
  buildAssetRedirectMap,
  loadPublishableAssetManifest,
  rewriteTemplateAssetReferences,
  type AssetRedirectMap,
} from '../../assets/asset-redirect.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import type { DeploymentRunResult } from '../../types/deployment-events.js';
import { startRunRecorder, recordRunSucceeded, recordRunFailed } from './deployment-events-run.js';
import { ExportIndexStore } from '../../state/export-index-store.js';
import { LockManager } from '../../state/lock-manager.js';
import { DagBuilder } from '../../analyzer/dag-builder.js';
import { DiffCalculator } from '../../analyzer/diff-calculator.js';
import { inferCrossStackStackDeps } from '../../analyzer/cross-stack-deps.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { withNestedStackContext } from '../../provisioning/nested-stack-context.js';
import { DeployEngine, type DeployEngineOptions } from '../../deployment/deploy-engine.js';
import { WorkGraph } from '../../deployment/work-graph.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { runStackBuffered } from '../../utils/stack-context.js';
import { withSkipPrefix } from '../../provisioning/resource-name.js';
import {
  resolveApp,
  resolveCaptureObservedState,
  resolveAutoAssetStorage,
  resolveSkipPrefix,
  resolveStateBucketWithDefault,
  resolveUseCdkBootstrapAssets,
  warnDeprecatedNoPrefixCliFlag,
} from '../config-loader.js';
import { matchStacks, describeStack } from '../stack-matcher.js';
import { findPendingPrefixRenames, promptMigrationConfirm } from './prefix-migration-check.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../types/state.js';

/**
 * Default-yes confirmation prompt for the issue #1007 asset-storage
 * auto-create (only reached on interactive TTY runs without `--yes`).
 */
async function promptYesNo(prompt: string): Promise<boolean> {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`${prompt} [Y/n] `);
    return /^(y(es)?)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

/**
 * Deploy command implementation
 */
async function deployCommand(
  stacks: string[],
  options: {
    app?: string;
    output: string;
    stateBucket?: string;
    statePrefix: string;
    stack?: string;
    all?: boolean;
    region?: string;
    profile?: string;
    roleArn?: string;
    concurrency: number;
    stackConcurrency: number;
    assetPublishConcurrency: number;
    imageBuildConcurrency: number;
    dryRun: boolean;
    skipAssets: boolean;
    rollback: boolean;
    wait: boolean;
    captureObservedState: boolean;
    prefixUserSuppliedNames: boolean;
    aggressiveVpcParallel: boolean;
    exclusively: boolean;
    yes: boolean;
    verbose: boolean;
    context?: string[];
    allowUnsupportedTypes?: string[];
    allowUnsupportedProperties?: string[];
    recreateViaCcApi?: string[];
    recreateViaSdkProvider?: string[];
    forceStatefulRecreation?: boolean;
    replace?: boolean;
    useCdkBootstrapAssets?: boolean;
    autoAssetStorage?: boolean;
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
  // up front so the user sees the error before synth / docker builds run.
  // Mutates `options.resourceWarnAfter` in place when auto-lowering the
  // inherited warn against a shortened --resource-timeout (so the
  // DeployEngine constructor below reads the lowered value).
  validateResourceTimeouts(options);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call. Writes the
  // assumed-role temp credentials into AWS_* env vars so every later
  // `new AwsClients(...)` picks them up via the SDK default chain.
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  // Skip waiting for async resources (CloudFront, RDS, ElastiCache, etc.)
  if (!options.wait) {
    process.env['CDKD_NO_WAIT'] = 'true';
  }

  // Resolve the prefix-user-supplied-names flag pair once at command
  // start. The resolved boolean is plumbed into a `withSkipPrefix(...)`
  // scope around each stack's deploy so every per-resource
  // `generateResourceName(...)` call inside picks up the flag via
  // AsyncLocalStorage — no need to thread it through the
  // DeployEngine / ProviderRegistry / per-provider call signatures.
  //
  // Since v0.94.0 the default is to SKIP the prefix on user-supplied
  // physical names. Pass `--prefix-user-supplied-names` (or set
  // CDKD_PREFIX_USER_SUPPLIED_NAMES=true / cdk.json
  // context.cdkd.prefixUserSuppliedNames=true) to opt back in to
  // legacy prefixing. The deprecated `--no-prefix-user-supplied-names`
  // flag is still accepted (matches the new default; emits a warning).
  // Detect the literal `--no-prefix-user-supplied-names` flag (Commander
  // collapses it onto `prefixUserSuppliedNames` via auto-negation, so the
  // deprecation warning needs a pre-parse argv walk).
  warnDeprecatedNoPrefixCliFlag();
  const skipPrefix = resolveSkipPrefix({
    prefixUserSuppliedNames: options.prefixUserSuppliedNames,
  });
  if (skipPrefix) {
    logger.debug(
      'Skipping stack-name prefix on user-supplied physical names (default since v0.94.0)'
    );
  } else {
    logger.debug(
      'Keeping legacy stack-name prefix on user-supplied physical names ' +
        '(--prefix-user-supplied-names / CDKD_PREFIX_USER_SUPPLIED_NAMES / ' +
        'cdk.json context.cdkd.prefixUserSuppliedNames)'
    );
  }

  // Resolve --app from CLI, env, or cdk.json
  const app = resolveApp(options.app);
  if (!app) {
    throw new Error(
      'No app command specified. Use --app, set CDKD_APP env var, or add "app" to cdk.json'
    );
  }
  options.app = app;

  // Resolve --state-bucket from CLI, env, cdk.json, or default (cdkd-state-{accountId};
  // legacy cdkd-state-{accountId}-{region} is consulted only as a fallback)
  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  logger.debug('Starting deployment...');
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

  // Fail fast if the state bucket is missing, before running synth / docker builds / asset uploads.
  // Passing region/profile lets the backend rebuild its S3 client when the
  // state bucket lives in a region different from the CLI's profile region.
  const preflightStateBackend = new S3StateBackend(
    awsClients.s3,
    {
      bucket: stateBucket,
      prefix: options.statePrefix,
    },
    {
      region,
      ...(options.profile && { profile: options.profile }),
    }
  );
  await preflightStateBackend.verifyBucketExists();

  // Shared exports index store for this deploy session. Lifecycle: created
  // here once and threaded through every per-stack DeployEngine so its
  // in-memory cache survives across all stacks in a `cdkd deploy --all`
  // run. Lazy-loaded — the first Fn::ImportValue resolution triggers the
  // rebuild from state.json (when index file is absent post-upgrade) or
  // a single GET (when index file already exists).
  const exportIndexStore = new ExportIndexStore(
    awsClients.s3,
    stateBucket,
    options.statePrefix,
    region,
    preflightStateBackend
  );

  let deployInterrupted = false;
  const topLevelSigintHandler = () => {
    if (deployInterrupted) {
      process.stderr.write('\nForce exit\n');
      process.exit(130);
    }
    process.stderr.write('\nInterrupted — waiting for in-progress operations to complete...\n');
    deployInterrupted = true;
  };
  process.on('SIGINT', topLevelSigintHandler);

  try {
    // 1. Synthesize CDK app (or read a pre-synthesized assembly when --app
    // points at an existing directory — synthesis is skipped in that case).
    logger.info(cyan(synthesisStatusMessage(app, 'Synthesizing CDK app...')));
    const synthesizer = new Synthesizer();
    const context = parseContextOptions(options.context);
    const result = await synthesizer.synthesize({
      app: options.app,
      output: options.output,
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
      ...(Object.keys(context).length > 0 && { context }),
      // Threaded so the macro-expander has a real state bucket for
      // the > 51,200-byte template upload path (Issue #463).
      stateBucket,
      ...(options.profile && { macroExpandS3ClientOpts: { profile: options.profile } }),
    });

    const { stacks: allStacks } = result;

    logger.debug(`Found ${allStacks.length} stack(s) in assembly`);

    // Determine target stacks: positional args > --stack > --all > auto (single stack)
    const stackPatterns = stacks.length > 0 ? stacks : options.stack ? [options.stack] : [];
    let targetStacks;

    if (options.all) {
      targetStacks = allStacks;
    } else if (stackPatterns.length > 0) {
      targetStacks = matchStacks(allStacks, stackPatterns);
    } else if (allStacks.length === 1) {
      // Single stack: auto-select
      targetStacks = allStacks;
    } else {
      throw new Error(
        `Multiple stacks found: ${allStacks.map(describeStack).join(', ')}. ` +
          `Specify stack name(s) or use --all`
      );
    }

    if (targetStacks.length === 0) {
      throw new Error(
        stackPatterns.length > 0
          ? `No stacks matching ${stackPatterns.join(', ')} found in assembly. Available: ${allStacks.map(describeStack).join(', ')}`
          : 'No stacks found in assembly'
      );
    }

    // Cross-stack ordering edges that CDK's manifest dependency graph
    // (`stack.dependencyNames`) does NOT capture: a raw
    // `cdk.Fn.importValue('<exportName>')` or `Fn::GetStackOutput` reference
    // without an explicit `addDependency` produces no manifest edge, so cdkd
    // would otherwise deploy the consumer concurrently with (often before)
    // the producer and fail with `export not found` / `stack not found`.
    // Inferred from the synthesized templates (the runtime S3 export index is
    // empty on a fresh multi-stack deploy). Both the auto-include walk below
    // and the inter-stack DAG-edge building further down use the UNION of
    // `dependencyNames` + these inferred producers. Computed over ALL stacks
    // so auto-include can reach a producer not yet in `targetStacks`.
    const inferredCrossStackDeps = inferCrossStackStackDeps(allStacks);
    const effectiveStackDeps = (stackName: string, deps: readonly string[]): Set<string> => {
      const union = new Set<string>(deps);
      for (const producer of inferredCrossStackDeps.get(stackName) ?? []) {
        union.add(producer);
      }
      return union;
    };

    // STRONG-only edges (CDK manifest deps + `Fn::ImportValue`) for the
    // auto-include-dependency walk below. `Fn::GetStackOutput` is a WEAK
    // reference (it reads the producer's output opportunistically from cdkd
    // state) and must NOT pull an unselected producer into the deploy:
    // `cdkd deploy <consumer>` should deploy only the consumer, not silently
    // re-deploy a producer it merely reads from (issue #751 conflated the two,
    // which re-deployed — and so mutated the state of — the producer). The DAG
    // ordering further down still uses the full (strong + weak) set, so when a
    // producer IS in the deploy set it is correctly ordered before its
    // GetStackOutput consumer.
    const inferredStrongCrossStackDeps = inferCrossStackStackDeps(allStacks, {
      kinds: ['ImportValue'],
    });
    const effectiveStrongStackDeps = (stackName: string, deps: readonly string[]): Set<string> => {
      const union = new Set<string>(deps);
      for (const producer of inferredStrongCrossStackDeps.get(stackName) ?? []) {
        union.add(producer);
      }
      return union;
    };

    // Auto-include dependency stacks (CDK CLI compatible behavior)
    // When deploying StackA that depends on StackB, also deploy StackB first.
    // Use -e / --exclusively to skip this and deploy only the requested stacks.
    if (!options.exclusively) {
      const targetNames = new Set(targetStacks.map((s) => s.stackName));
      const allStackMap = new Map(allStacks.map((s) => [s.stackName, s]));

      const addDependencies = (stackName: string): void => {
        const stack = allStackMap.get(stackName);
        if (!stack) return;
        for (const depName of effectiveStrongStackDeps(stackName, stack.dependencyNames)) {
          if (!targetNames.has(depName)) {
            const depStack = allStackMap.get(depName);
            if (depStack) {
              targetNames.add(depName);
              targetStacks.push(depStack);
              logger.debug(
                `Auto-including dependency stack: ${depName} (required by ${stackName})`
              );
              addDependencies(depName); // Recursive
            }
          }
        }
      };

      for (const stack of [...targetStacks]) {
        addDependencies(stack.stackName);
      }
    }

    // 3. Build work graph: asset-publish → stack deploy (DAG)
    const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
    const stsClient = new STSClient({
      region: options.region || process.env['AWS_REGION'] || 'us-east-1',
    });
    const callerIdentity = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = callerIdentity.Account!;
    stsClient.destroy();

    const assetPublisher = new AssetPublisher();
    // Issue #1002 — per-region asset-mode detection (legacy vs cdkd-assets).
    // One marker read per unique region, cached for the invocation. In
    // `cdkd-assets` mode (marker present), PR 2 wires publish redirection +
    // template rewrite through the §6 mapping table built below; legacy
    // deploys stay byte-identical to before (plus one info line about the
    // `cdk gc` hazard). `--use-cdk-bootstrap-assets` (or cdk.json
    // context.cdkd.useCdkBootstrapAssets) pins legacy mode for the app.
    const useCdkBootstrapAssets = resolveUseCdkBootstrapAssets(options.useCdkBootstrapAssets);
    // Issue #1007 — first deploy into a region with no bootstrap marker
    // auto-creates the per-region asset storage (instead of legacy mode), so
    // `cdkd bootstrap` stays a true once-per-account step. Interactive runs
    // are prompted once per region; `--yes` / non-TTY runs create with an
    // info line. Opt out via --no-auto-asset-storage / cdk.json
    // context.cdkd.autoAssetStorage: false. Never under --dry-run (a
    // dry run must not create resources), and moot under the
    // --use-cdk-bootstrap-assets legacy pin (marker is never read).
    const autoAssetStorage = resolveAutoAssetStorage(options.autoAssetStorage);
    const confirmAutoAssetStorage = async (assetRegion: string): Promise<boolean> => {
      if (options.yes || !process.stdin.isTTY) {
        logger.info(
          `Creating cdkd asset storage for region '${assetRegion}' (first deploy into this ` +
            `region; opt out with --no-auto-asset-storage).`
        );
        return true;
      }
      return promptYesNo(
        `Region '${assetRegion}' has no cdkd asset storage yet. Create it now ` +
          `(S3 bucket cdkd-assets-${accountId}-${assetRegion} + container-asset ECR repo, ` +
          `out of 'cdk gc' reach)?`
      );
    };
    const assetModeResolver = new AssetModeResolver(preflightStateBackend, accountId, {
      ...(options.profile && { profile: options.profile }),
      ...(useCdkBootstrapAssets && { useCdkBootstrapAssets: true }),
      ...(autoAssetStorage &&
        !options.dryRun && {
          autoCreate: { confirm: confirmAutoAssetStorage },
        }),
    });
    const stateConfig = {
      bucket: stateBucket,
      prefix: options.statePrefix,
    };
    const dagBuilder = new DagBuilder({
      relaxCdkVpcDefensiveDeps: !!options.aggressiveVpcParallel,
    });
    const diffCalculator = new DiffCalculator();
    const baseRegion = options.region || process.env['AWS_REGION'] || 'us-east-1';

    const switchRegion = (region: string): void => {
      process.env['AWS_REGION'] = region;
      process.env['AWS_DEFAULT_REGION'] = region;
    };

    // Build work graph
    const workGraph = new WorkGraph();
    const stackMap = new Map(targetStacks.map((s) => [s.stackName, s]));
    // Issue #1002 PR 2 — per-stack §6 mapping table for stacks whose region
    // is in cdkd-assets mode. Consumed by the deploy engine's
    // post-resolution audit + the NestedStackProvider context below.
    const stackRedirects = new Map<string, AssetRedirectMap>();

    for (const stack of targetStacks) {
      const stackNodeId = `stack:${stack.stackName}`;
      const stackDeps = new Set<string>();

      // Asset-mode resolution + §6 mapping table + §7 template rewrite +
      // asset-publish nodes. `loadPublishableAssetManifest` returns null on
      // a missing manifest OR one with nothing cdkd would publish, so
      // asset-less deploys stay byte-identical (no marker read, no
      // legacy-mode info line). The mode resolution + rewrite run even
      // under --skip-assets: assets already published (e.g. via
      // `cdkd publish-assets`) live in cdkd storage once the region is
      // opted in, so skipping the rewrite would deploy split-brain
      // references that the audit then rejects.
      if (stack.assetManifestPath) {
        const assetRegion = stack.region || baseRegion;
        const manifest = loadPublishableAssetManifest(stack.assetManifestPath);
        if (manifest) {
          const assetMode = await assetModeResolver.resolve(assetRegion);
          logger.debug(
            `Asset mode for region ${assetRegion}: ${assetMode.mode} (stack ${stack.stackName})`
          );
          let redirect: AssetRedirectMap | undefined;
          if (assetMode.mode === 'cdkd-assets') {
            redirect = buildAssetRedirectMap(manifest, assetMode.marker, accountId, assetRegion);
            if (redirect.entries.length > 0) {
              stackRedirects.set(stack.stackName, redirect);
              const rewritten = rewriteTemplateAssetReferences(stack.template, redirect);
              logger.debug(
                `Rewrote ${rewritten} asset reference(s) to cdkd asset storage ` +
                  `(${assetMode.marker.assetBucket} / ${assetMode.marker.containerRepo}) ` +
                  `in template of stack ${stack.stackName}`
              );
            } else {
              redirect = undefined;
            }
          }
          if (!options.skipAssets) {
            const nodeIds = assetPublisher.addAssetsToGraph(workGraph, stack.assetManifestPath, {
              accountId,
              region: assetRegion,
              ...(options.profile && { profile: options.profile }),
              nodePrefix: `${stack.stackName}:`,
              ...(redirect && { redirect }),
            });
            for (const id of nodeIds) {
              stackDeps.add(id);
            }
          }
        }
      }

      // Add inter-stack dependencies: the UNION of CDK manifest deps
      // (`dependencyNames`) and inferred raw cross-stack references, so a
      // consumer waits for its producer even without an explicit
      // `addDependency`. Both are guarded by `stackMap.has(...)` so only
      // edges between stacks in this deploy set are added.
      for (const depName of effectiveStackDeps(stack.stackName, stack.dependencyNames)) {
        if (stackMap.has(depName)) {
          stackDeps.add(`stack:${depName}`);
        }
      }

      workGraph.addNode({
        id: stackNodeId,
        type: 'stack',
        dependencies: stackDeps,
        state: 'pending',
        data: { stack },
      });
    }

    const summary = workGraph.summary();
    logger.debug(`Work graph: ${summary['asset-publish']} asset(s), ${summary['stack']} stack(s)`);

    // Buffer per-stack log output when more than one stack will deploy
    // concurrently. Without this, two stacks' `logger.info(...)` lines
    // interleave: stack A's "Changes: 4 to create" / "Deploying 4
    // resource(s)" lands between stack B's `[N/N] ✅ ...` rows, and
    // stack B's "Deployment completed" prints after stack A's late
    // progress. The buffer captures everything for the duration of one
    // stack and flushes it as one block — clean per-stack groups.
    const bufferStackOutput = targetStacks.length > 1;

    const runStack = async (stackInfo: (typeof targetStacks)[0]): Promise<void> => {
      // Wrap the entire per-stack deploy body in withSkipPrefix so every
      // `generateResourceName(name, { userSupplied: true })` call inside
      // the provider chain sees the resolved flag via AsyncLocalStorage.
      // The inner `withStackName(...)` lives in DeployEngine.deploy; the
      // two stores are independent so order does not matter, but
      // outer-skipPrefix / inner-stackName keeps the call-site readable.
      return withSkipPrefix(skipPrefix, () => runStackInner(stackInfo));
    };

    const runStackInner = async (stackInfo: (typeof targetStacks)[0]): Promise<void> => {
      const stackRegion = stackInfo.region || baseRegion;

      logger.info(
        `\n${cyan('Deploying stack:')} ${bold(cyan(stackInfo.stackName))}${stackRegion !== baseRegion ? gray(` (region: ${stackRegion})`) : ''}`
      );

      switchRegion(stackRegion);

      const stackAwsClients = new AwsClients({
        region: stackRegion,
        ...(options.profile && { profile: options.profile }),
      });
      setAwsClients(stackAwsClients);

      const stateS3Client = new AwsClients({
        region: baseRegion,
        ...(options.profile && { profile: options.profile }),
      });
      const stackStateBackend = new S3StateBackend(stateS3Client.s3, stateConfig, {
        region: baseRegion,
        ...(options.profile && { profile: options.profile }),
      });
      const stackLockManager = new LockManager(stateS3Client.s3, stateConfig);
      const stackProviderRegistry = new ProviderRegistry();
      registerAllProviders(stackProviderRegistry);
      stackProviderRegistry.setCustomResourceResponseBucket(stateBucket, baseRegion);
      if (options.allowUnsupportedTypes?.length) {
        stackProviderRegistry.allowUnsupportedTypes(options.allowUnsupportedTypes);
      }
      if (options.allowUnsupportedProperties?.length) {
        stackProviderRegistry.allowUnsupportedProperties(options.allowUnsupportedProperties);
      }

      // Issue [#808] — best-effort structured deployment-event recorder.
      // Skipped under --dry-run (no real run to record — startRunRecorder
      // returns undefined). The engine emits per-resource + rollback events
      // through it; this CLI emits the run-level RUN_STARTED (inside
      // startRunRecorder) / RUN_FINISHED and finalize()s in the finally
      // below. Failures are swallowed inside the store and never surface
      // here. Declared OUTSIDE the try so the catch / finally see it.
      const eventRecorder = startRunRecorder({
        backend: stackStateBackend,
        stackName: stackInfo.stackName,
        region: stackRegion,
        command: 'deploy',
        dryRun: options.dryRun,
      });
      // Tracks the terminal result for the recorder's index summary;
      // flipped to FAILED in the catch below.
      let runResult: DeploymentRunResult = 'SUCCEEDED';

      try {
        // Pre-flight migration check for --no-prefix-user-supplied-names.
        // When the flag is on AND the stack has existing state with
        // Pattern B resources whose physical id is still prefixed with
        // the stack name, cdkd's diff path will silently propose
        // REPLACEMENT on each of them. Surface this up front so the
        // user sees the side effect before any provider call runs.
        // Honors --yes / --force (the CLI is single-flagged via
        // `options.yes`). No-op when:
        //   - skipPrefix is false (the flag is not active)
        //   - state is empty (first-time deploy — nothing to migrate)
        //   - no Pattern B resource is still prefixed
        if (skipPrefix) {
          const existing = await stackStateBackend.getState(stackInfo.stackName, stackRegion);
          const pending = findPendingPrefixRenames(stackInfo.stackName, existing?.state);
          if (pending.length > 0) {
            const proceed = await promptMigrationConfirm(pending, { yes: options.yes });
            if (!proceed) {
              // Clean exit — nothing was modified. The outer finally
              // below tears down per-stack AWS clients.
              return;
            }
          }
        }

        // Issue [#615] — validate `--recreate-via-cc-api <LogicalId>` (+
        // companion `--force-stateful-recreation`) against the synth
        // template + existing state. Surfaces every error category in
        // one block (typos / missing-state / ambiguous-intent with
        // --allow-unsupported-properties / stateful guard refusal) so
        // the user fixes them all in one cycle. Skipped when the flag
        // is absent (no list).
        let recreateViaCcApiTargets: ReadonlySet<string> | undefined;
        let recreateViaSdkProviderTargets: ReadonlySet<string> | undefined;
        if (options.recreateViaCcApi?.length || options.recreateViaSdkProvider?.length) {
          const stateForRecreateCheck = await stackStateBackend.getState(
            stackInfo.stackName,
            stackRegion
          );
          const syncValidation = validateRecreateTargets({
            template: stackInfo.template,
            state: stateForRecreateCheck?.state ?? {
              version: STATE_SCHEMA_VERSION_CURRENT,
              stackName: stackInfo.stackName,
              region: stackRegion,
              resources: {},
              outputs: {},
              lastModified: Date.now(),
            },
            recreateViaCcApi: options.recreateViaCcApi ?? [],
            recreateViaSdkProvider: options.recreateViaSdkProvider ?? [],
            allowUnsupportedProperties: new Set(options.allowUnsupportedProperties ?? []),
            forceStatefulRecreation: options.forceStatefulRecreation ?? false,
            // Reviewer caught: `hasProvider(rt)` returns true for ANY
            // routable type (SDK / Cloud Control / Custom Resource / escape-
            // hatch), so a Tier 2 CC-only type would slip past
            // `blockedNoSdkProvider` and the routing decision would silently
            // round-trip back to CC after the recreate. Ask the narrower
            // `getProviderType(rt) === 'sdk'` instead — true ONLY when a
            // dedicated SDK provider is registered for the type.
            hasSdkProvider: (rt) => stackProviderRegistry.getProviderType(rt) === 'sdk',
          });
          // Issue [#648] — promote `AWS::S3::Bucket` targets whose sync
          // reason is `null` to `'has-objects'` when the live bucket
          // has at least one object. Uses the deploy-region S3 client
          // (the user's bucket lives in the stack's deploy region, not
          // the state bucket region). Soft-fails on permission denied
          // / bucket-not-found: leaves the sync reason in place and
          // logs a warn (the user can decide to pass --force-stateful-
          // recreation).
          const validation = await probeAndRevalidateStateful({
            validation: syncValidation,
            s3Client: stackAwsClients.s3,
            forceStatefulRecreation: options.forceStatefulRecreation ?? false,
          });
          const errorBlock = renderRecreateTargetsErrors(validation);
          if (errorBlock) {
            throw new CdkdError(errorBlock, 'RECREATE_TARGETS_INVALID');
          }
          recreateViaCcApiTargets = new Set(
            validation.targets.filter((t) => t.direction === 'to-cc-api').map((t) => t.logicalId)
          );
          recreateViaSdkProviderTargets = new Set(
            validation.targets.filter((t) => t.direction === 'to-sdk').map((t) => t.logicalId)
          );
          if (recreateViaCcApiTargets.size > 0 || recreateViaSdkProviderTargets.size > 0) {
            // Issue [#650] — enumerate downstream `Fn::ImportValue`
            // consumers via the state bucket walk so the warn block
            // names them by stack. Soft-fail (returns []) on read
            // errors — the generic caveat still surfaces below.
            const downstreamConsumers = await findDownstreamConsumers({
              producerStack: stackInfo.stackName,
              producerRegion: stackRegion,
              stateBackend: stackStateBackend,
              baseRegion,
            });

            // Issue [#649] — interactive [y/N] prompt. Mirrors the
            // existing prefix-rename prompt structure: per-stack, with
            // --yes / -y short-circuiting to the warn-log surface that
            // v1 shipped. Stateful targets get a **DATA LOSS** prefix
            // as a third "stop and think" moment beyond the explicit
            // --force-stateful-recreation opt-in.
            const proceed = await promptRecreateConfirm({
              stackName: stackInfo.stackName,
              targets: validation.targets,
              yes: options.yes ?? false,
              downstreamConsumers,
            });
            if (!proceed) {
              return;
            }
          }
        }

        // Issue #1002 PR 2 — thread the stack's §6 mapping table into the
        // engine (post-resolution audit) and the nested-stack context
        // (child-template rewrite). Undefined in legacy mode.
        const assetRedirect = stackRedirects.get(stackInfo.stackName);

        const deployEngineOptions: DeployEngineOptions = {
          concurrency: options.concurrency,
          dryRun: options.dryRun,
          noRollback: !options.rollback,
          ...(assetRedirect && { assetRedirect }),
          ...(eventRecorder && { eventRecorder }),
          ...(recreateViaCcApiTargets &&
            recreateViaCcApiTargets.size > 0 && { recreateViaCcApiTargets }),
          ...(recreateViaSdkProviderTargets &&
            recreateViaSdkProviderTargets.size > 0 && { recreateViaSdkProviderTargets }),
          ...(options.replace && { replace: true }),
          ...(options.forceStatefulRecreation && { forceStatefulRecreation: true }),
          captureObservedState: resolveCaptureObservedState(options.captureObservedState),
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
        };

        const stackDeployEngine = new DeployEngine(
          stackStateBackend,
          stackLockManager,
          dagBuilder,
          diffCalculator,
          stackProviderRegistry,
          deployEngineOptions,
          stackRegion,
          exportIndexStore
        );

        // Set the NestedStackProvider context for this deploy. The provider
        // pulls parentStackName / parentRegion / nestedTemplates / accountId
        // from the surrounding AsyncLocalStorage scope (see
        // src/provisioning/nested-stack-context.ts). When the stack has no
        // AWS::CloudFormation::Stack resources, this is a cheap no-op (the
        // provider is never invoked); when it does, the context lets the
        // provider build a child DeployEngine recursively.
        const deployResult = await withNestedStackContext(
          {
            stateBackend: stackStateBackend,
            lockManager: stackLockManager,
            providerRegistry: stackProviderRegistry,
            parentStackName: stackInfo.stackName,
            parentRegion: stackRegion,
            accountId,
            awsClients: stackAwsClients,
            stateBucket,
            exportIndexStore,
            nestedTemplates: stackInfo.nestedTemplates ?? {},
            dagBuilder,
            diffCalculator,
            options: deployEngineOptions,
            ...(assetRedirect && { assetRedirect }),
          },
          () => stackDeployEngine.deploy(stackInfo.stackName, stackInfo.template)
        );

        logger.info(`\n${bold('Deployment Summary:')}`);
        logger.info(`  Stack: ${bold(cyan(deployResult.stackName))}`);
        logger.info(
          `  Created: ${deployResult.created > 0 ? green(deployResult.created) : gray(deployResult.created)}`
        );
        logger.info(
          `  Updated: ${deployResult.updated > 0 ? yellow(deployResult.updated) : gray(deployResult.updated)}`
        );
        logger.info(
          `  Deleted: ${deployResult.deleted > 0 ? red(deployResult.deleted) : gray(deployResult.deleted)}`
        );
        logger.info(`  Unchanged: ${gray(deployResult.unchanged)}`);
        logger.info(`  Duration: ${cyan((deployResult.durationMs / 1000).toFixed(2) + 's')}`);

        if (deployResult.outputs && Object.keys(deployResult.outputs).length > 0) {
          logger.info('\nOutputs:');
          for (const [key, value] of Object.entries(deployResult.outputs)) {
            logger.info(`  ${deployResult.stackName}.${key} = ${String(value)}`);
          }
        }

        if (options.dryRun) {
          logger.info(`\n${green('✓')} ${bold('Dry run completed')} - no actual changes made`);
        } else {
          logger.info(`\n${green('✓')} ${bold('Deployment completed successfully')}`);
        }

        recordRunSucceeded(
          eventRecorder,
          stackInfo.stackName,
          {
            created: deployResult.created,
            updated: deployResult.updated,
            deleted: deployResult.deleted,
          },
          deployResult.durationMs
        );
      } catch (deployError) {
        // Issue [#808] — record the run-level failure event before
        // re-throwing. Error metadata only (no resource properties).
        runResult = 'FAILED';
        recordRunFailed(eventRecorder, stackInfo.stackName, deployError);
        throw deployError;
      } finally {
        // Best-effort final flush + index update. Never throws.
        if (eventRecorder) {
          await eventRecorder.finalize(runResult);
        }
        stackAwsClients.destroy();
        stateS3Client.destroy();
        switchRegion(baseRegion);
        setAwsClients(awsClients);
      }
    };

    // Execute work graph
    await workGraph.execute(
      {
        'asset-build': options.imageBuildConcurrency,
        'asset-publish': options.assetPublishConcurrency,
        stack: options.stackConcurrency,
      },
      async (node) => {
        if (node.type === 'asset-build' || node.type === 'asset-publish') {
          await assetPublisher.executeNode(node);
        } else {
          const { stack: stackInfo } = node.data as { stack: (typeof targetStacks)[0] };

          if (!bufferStackOutput) {
            await runStack(stackInfo);
            return;
          }

          // Multi-stack run: buffer this stack's log lines and flush
          // them as one atomic block when the deploy finishes.
          const outcome = await runStackBuffered(() => runStack(stackInfo));
          if (outcome.lines.length > 0) {
            process.stdout.write(outcome.lines.join('\n') + '\n');
          }
          if (!outcome.ok) throw outcome.error;
        }
      }
    );
  } finally {
    process.removeListener('SIGINT', topLevelSigintHandler);
    awsClients.destroy();
  }
}

/**
 * Create deploy command
 */
export function createDeployCommand(): Command {
  const cmd = new Command('deploy')
    .description('Deploy CDK app using SDK/Cloud Control API')
    .argument(
      '[stacks...]',
      "Stack name(s) to deploy. Accepts physical CloudFormation names (e.g. 'MyStage-Api') or CDK display paths (e.g. 'MyStage/Api'). Supports wildcards (e.g. 'MyStage/*')."
    )
    .option('--all', 'Deploy all stacks', false)
    .action(withErrorHandling(deployCommand));

  // Add options
  [
    ...commonOptions,
    ...appOptions,
    ...stateOptions,
    ...stackOptions,
    ...deployOptions,
    ...contextOptions,
  ].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated for deploy (PR 5). Accepted for backward
  // compatibility; warning emitted at runtime via warnIfDeprecatedRegion.
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
