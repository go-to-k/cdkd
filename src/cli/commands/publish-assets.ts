import { Option, Command } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  parseContextOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { PartialFailureError, withErrorHandling } from '../../utils/error-handler.js';
import { AssetPublisher } from '../../assets/asset-publisher.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import { WorkGraph } from '../../deployment/work-graph.js';
import { resolveApp } from '../config-loader.js';
import { matchStacks, describeStack } from '../stack-matcher.js';

interface PublishAssetsOptions {
  app?: string;
  output: string;
  stack?: string;
  all?: boolean;
  context?: string[];
  verbose: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  assetPublishConcurrency: number;
  imageBuildConcurrency: number;
}

/**
 * `cdkd publish-assets [stacks...]` — synthesize the CDK app, select target
 * stacks, build and publish every asset they reference. Mirrors the asset
 * half of `cdkd deploy` — uses `AssetPublisher.addAssetsToGraph(...)` plus a
 * `WorkGraph` with `stack: 0` concurrency so only `asset-build` /
 * `asset-publish` nodes run. No state writes, no provisioning.
 *
 * `--app` accepts either a shell command (`"npx ts-node app.ts"`) or a path
 * to an already-synthesized cloud assembly directory (`cdk.out`). When a
 * directory is given, `Synthesizer.synthesize` skips the subprocess and
 * reads the manifest directly — same dual semantics as `cdkd deploy`. So a
 * pre-synthesized assembly can be re-used by pointing `-a` at the dir;
 * `cdkd publish-assets` does not need its own `--path <manifest>` flag.
 *
 * Stack selection: positional > --stack > --all > auto (single stack).
 * Match patterns route by `/`-presence to display path / physical name in
 * the same way deploy / diff / destroy do (via shared `matchStacks`).
 *
 * Exit code policy mirrors `cdkd destroy`: 0 on success, 2 (via
 * `PartialFailureError`) when any stack's asset publish fails. The
 * surface-level summary lists per-stack results so a failed stack does
 * not silently disappear into a single aggregate error.
 */
async function publishAssetsCommand(
  stacks: string[],
  options: PublishAssetsOptions
): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  // PR 5: --region is deprecated on non-bootstrap commands. Warn but keep
  // the rest of the pipeline working as before.
  warnIfDeprecatedRegion(options);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  // Resolve --app from CLI, env, or cdk.json (mirrors deploy.ts).
  const app = resolveApp(options.app);
  if (!app) {
    throw new Error(
      'No app command specified. Use --app, set CDKD_APP env var, or add "app" to cdk.json'
    );
  }

  // 1. Synthesize CDK app (or read pre-synthesized assembly when --app is a dir).
  logger.info('Synthesizing CDK app...');
  const synthesizer = new Synthesizer();
  const context = parseContextOptions(options.context);
  const synthOptions: SynthesisOptions = {
    app,
    output: options.output,
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
    ...(Object.keys(context).length > 0 && { context }),
  };
  const result = await synthesizer.synthesize(synthOptions);
  const { stacks: allStacks } = result;
  logger.debug(`Found ${allStacks.length} stack(s) in assembly`);

  // 2. Determine target stacks: positional > --stack > --all > auto (single stack).
  const stackPatterns = stacks.length > 0 ? stacks : options.stack ? [options.stack] : [];
  let targetStacks: StackInfo[];

  if (options.all) {
    targetStacks = allStacks;
  } else if (stackPatterns.length > 0) {
    targetStacks = matchStacks(allStacks, stackPatterns);
  } else if (allStacks.length === 1) {
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
        ? `No stacks matching ${stackPatterns.join(', ')} found in assembly. Available: ${allStacks
            .map(describeStack)
            .join(', ')}`
        : 'No stacks found in assembly'
    );
  }

  // 3. Resolve account id once (asset-publish nodes need it for ECR / S3 paths).
  const baseRegion = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const stsClient = new STSClient({ region: baseRegion });
  const callerIdentity = await stsClient.send(new GetCallerIdentityCommand({}));
  const accountId = callerIdentity.Account!;
  stsClient.destroy();

  // 4. Per-stack: build a WorkGraph populated with asset nodes only and run it.
  // Running per stack (rather than one shared graph) keeps the per-stack
  // success/failure accounting clean and mirrors the CI expectation that
  // "publish stack A, even if stack B's assets fail." A merged graph would
  // short-circuit at the first failure due to WorkGraph's reject behavior.
  const assetPublisher = new AssetPublisher();

  interface StackResult {
    stackName: string;
    displayName: string;
    assetCount: number;
    durationMs: number;
    error?: Error;
  }
  const results: StackResult[] = [];

  for (const stack of targetStacks) {
    const startedAt = Date.now();
    let assetCount = 0;
    let error: Error | undefined;

    try {
      if (!stack.assetManifestPath) {
        logger.debug(`Stack ${stack.stackName} has no asset manifest; nothing to publish`);
        results.push({
          stackName: stack.stackName,
          displayName: stack.displayName,
          assetCount: 0,
          durationMs: Date.now() - startedAt,
        });
        continue;
      }

      logger.info(`\nPublishing assets for stack: ${describeStack(stack)}`);

      const workGraph = new WorkGraph();
      let nodeIds: string[] = [];
      try {
        nodeIds = assetPublisher.addAssetsToGraph(workGraph, stack.assetManifestPath, {
          accountId,
          region: stack.region || baseRegion,
          ...(options.profile && { profile: options.profile }),
          nodePrefix: `${stack.stackName}:`,
        });
      } catch (err) {
        const e = err as { code?: string };
        if (e.code === 'ENOENT') {
          // Manifest path was set but the file doesn't exist on disk — match
          // deploy.ts's behavior, which silently skips this case.
          logger.debug(
            `Asset manifest not found for ${stack.stackName} (${stack.assetManifestPath}); skipping`
          );
          results.push({
            stackName: stack.stackName,
            displayName: stack.displayName,
            assetCount: 0,
            durationMs: Date.now() - startedAt,
          });
          continue;
        }
        throw err;
      }

      assetCount = nodeIds.filter((id) => id.startsWith('asset-publish:')).length;

      if (assetCount === 0) {
        logger.info('  (no assets to publish)');
        results.push({
          stackName: stack.stackName,
          displayName: stack.displayName,
          assetCount: 0,
          durationMs: Date.now() - startedAt,
        });
        continue;
      }

      // Stack-deploy nodes are intentionally NOT added — `stack: 0` concurrency
      // is a belt-and-suspenders guard so even an accidental stack node would
      // never run.
      await workGraph.execute(
        {
          'asset-build': options.imageBuildConcurrency,
          'asset-publish': options.assetPublishConcurrency,
          stack: 0,
        },
        (node) => assetPublisher.executeNode(node)
      );

      logger.info(
        `  ✓ Published ${assetCount} asset(s) in ${((Date.now() - startedAt) / 1000).toFixed(2)}s`
      );
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      logger.error(`  ✗ ${stack.stackName}: ${error.message}`);
    }

    results.push({
      stackName: stack.stackName,
      displayName: stack.displayName,
      assetCount,
      durationMs: Date.now() - startedAt,
      ...(error && { error }),
    });
  }

  // 5. Summary + exit code policy.
  const failed = results.filter((r) => r.error);
  const totalAssets = results.reduce((sum, r) => sum + r.assetCount, 0);

  logger.info('\nPublish Summary:');
  for (const r of results) {
    const tag = r.error ? '✗' : '✓';
    const id = r.displayName === r.stackName ? r.stackName : `${r.displayName} (${r.stackName})`;
    const detail = r.error
      ? `failed: ${r.error.message}`
      : `${r.assetCount} asset(s), ${(r.durationMs / 1000).toFixed(2)}s`;
    logger.info(`  ${tag} ${id} — ${detail}`);
  }

  if (failed.length > 0) {
    throw new PartialFailureError(
      `Asset publishing completed with ${failed.length} stack failure(s) ` +
        `(${totalAssets} asset(s) published successfully across the rest).`
    );
  }

  logger.info(`\n✅ Asset publishing complete (${totalAssets} asset(s))`);
}

/**
 * Create publish-assets command.
 *
 * Synthesizes the CDK app (or reads a pre-synthesized cloud assembly when
 * `-a/--app` points at a directory) and publishes asset bundles for every
 * selected stack. No state writes, no provisioning — the inverse of
 * `cdkd deploy --no-asset-publish` (which doesn't exist).
 */
export function createPublishAssetsCommand(): Command {
  const cmd = new Command('publish-assets')
    .description(
      'Synthesize the CDK app and publish assets to S3/ECR for the selected stack(s) without deploying'
    )
    .argument(
      '[stacks...]',
      "Stack name(s) to publish assets for. Accepts physical CloudFormation names (e.g. 'MyStage-Api') or CDK display paths (e.g. 'MyStage/Api'). Supports wildcards."
    )
    .option('--all', 'Publish assets for all stacks', false)
    .addOption(
      new Option(
        '--asset-publish-concurrency <number>',
        'Maximum concurrent asset publish operations'
      )
        .default(8)
        .argParser((value) => parseInt(value, 10))
    )
    .addOption(
      new Option('--image-build-concurrency <number>', 'Maximum concurrent Docker image builds')
        .default(4)
        .argParser((value) => parseInt(value, 10))
    )
    .action(withErrorHandling(publishAssetsCommand));

  // App-mode options: --app, --output, --context, common.
  // Note: --state-bucket is intentionally NOT added — publish-assets never
  // touches state, so advertising it would be misleading.
  [...commonOptions, ...appOptions, ...contextOptions].forEach((opt) => cmd.addOption(opt));

  // --stack <name> kept for parity with deploy/destroy CLIs, even though the
  // recommended form is positional.
  cmd.addOption(new Option('--stack <name>', 'Stack name to publish (alternative to positional)'));

  // --region is deprecated for publish-assets (PR 5). Accepted for backward
  // compatibility; warning emitted at runtime via warnIfDeprecatedRegion.
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
