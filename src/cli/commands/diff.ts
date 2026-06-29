import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  deprecatedRegionOption,
  stateOptions,
  stackOptions,
  contextOptions,
  parseContextOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling, CdkdError } from '../../utils/error-handler.js';
import { Synthesizer, synthesisStatusMessage } from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { DiffCalculator } from '../../analyzer/diff-calculator.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';
import { matchStacks, describeStack } from '../stack-matcher.js';
import {
  buildDiffTree,
  diffTreeToJson,
  renderDiffTree,
  treeHasChanges,
  type DiffTreeNode,
} from './diff-recursive.js';

/**
 * Signals that `cdkd diff --fail` detected at least one change. Carries no
 * message — the diff report was already printed before throwing, so the
 * handler only needs the exit code. Mirrors `cdkd drift`'s
 * `DriftDetectedError` (exit 1 = "non-zero outcome", not "command crashed").
 */
class DiffDetectedError extends CdkdError {
  readonly silent: boolean = true;

  constructor() {
    super('diff detected', 'DIFF_DETECTED');
    this.name = 'DiffDetectedError';
    Object.setPrototypeOf(this, DiffDetectedError.prototype);
  }
}

/**
 * Diff command implementation
 */
async function diffCommand(
  stacks: string[],
  options: {
    app?: string;
    output: string;
    stateBucket?: string;
    statePrefix: string;
    stack?: string;
    all?: boolean;
    recursive?: boolean;
    fail?: boolean;
    json?: boolean;
    region?: string;
    profile?: string;
    roleArn?: string;
    verbose: boolean;
    context?: string[];
  }
): Promise<void> {
  const logger = getLogger();

  if (options.json) {
    // Keep stdout clean for machine consumers: suppress info/debug progress
    // chatter so only the JSON payload lands on stdout. Warnings / errors
    // still surface (stderr). --json wins even when --verbose is ALSO set —
    // clean JSON on stdout is the point of --json; if the user wants debug
    // output too, they should drop --json and run twice (or pipe stderr
    // separately). The previous precedence (verbose wins) interleaved debug
    // chatter into stdout via console.info / console.debug and corrupted
    // the JSON payload for any tooling that parsed it.
    logger.setLevel('warn');
  } else if (options.verbose) {
    logger.setLevel('debug');
  }

  // PR 5: --region is deprecated on non-bootstrap commands. Warn but keep
  // the rest of the pipeline working as before.
  warnIfDeprecatedRegion(options);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  // Resolve --app from CLI, env, or cdk.json
  const app = resolveApp(options.app);
  if (!app) {
    throw new Error(
      'No app command specified. Use --app, set CDKD_APP env var, or add "app" to cdk.json'
    );
  }
  options.app = app;

  // Resolve --state-bucket from CLI, env, cdk.json, or default
  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  logger.info('Calculating diff...');
  logger.debug('Options:', options);

  // Initialize AWS clients with region/profile
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    // 1. Synthesize CDK app
    logger.info(synthesisStatusMessage(app, 'Synthesizing CDK app...'));
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
    logger.info(`Found ${allStacks.length} stack(s) in assembly`);

    // Determine target stacks: positional args > --stack > --all > auto (single stack)
    const stackPatterns = stacks.length > 0 ? stacks : options.stack ? [options.stack] : [];
    let targetStacks;

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
          ? `No stacks matching ${stackPatterns.join(', ')} found in assembly. Available: ${allStacks.map(describeStack).join(', ')}`
          : 'No stacks found in assembly'
      );
    }

    // 3. Initialize components
    const stateConfig = {
      bucket: stateBucket,
      prefix: options.statePrefix,
    };
    // Pass region/profile so the backend can rebuild its S3 client if the
    // bucket lives in a region different from the CLI's profile region.
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      region,
      ...(options.profile && { profile: options.profile }),
    });
    const diffCalculator = new DiffCalculator();
    const recursive = options.recursive ?? false;

    // 4. Build a diff tree per target stack (nested children only when --recursive).
    const trees: DiffTreeNode[] = [];
    for (const stackInfo of targetStacks) {
      logger.info(`\nCalculating diff for stack: ${stackInfo.stackName}`);
      // Stack region drives the state key. Falls back to the CLI region only
      // when synth couldn't determine a region (e.g. env-agnostic stacks).
      const stackRegion = stackInfo.region || region;
      trees.push(
        await buildDiffTree({
          stackName: stackInfo.stackName,
          displayName: stackInfo.stackName,
          region: stackRegion,
          template: stackInfo.template,
          nestedTemplates: stackInfo.nestedTemplates ?? {},
          recursive,
          stateBackend,
          diffCalculator,
        })
      );
    }

    // 5. Emit results — JSON payload (nested when --recursive) or human blocks.
    if (options.json) {
      process.stdout.write(`${JSON.stringify(trees.map(diffTreeToJson), null, 2)}\n`);
    } else {
      for (const tree of trees) {
        if (!treeHasChanges(tree)) {
          logger.info(`\n✓ No changes detected for stack ${tree.stackName}`);
          continue;
        }
        renderDiffTree(tree, true, (msg) => logger.info(msg));
      }
    }

    // 6. --fail (CDK parity with `cdk diff --fail`): exit 1 when any change is
    // detected. With --recursive this covers the whole nested-stack tree, so
    // CI can gate on tree-wide drift.
    if (options.fail && trees.some(treeHasChanges)) {
      throw new DiffDetectedError();
    }
  } finally {
    awsClients.destroy();
  }
}

/**
 * Create diff command
 */
export function createDiffCommand(): Command {
  const cmd = new Command('diff')
    .description('Show difference between current state and desired state')
    .argument(
      '[stacks...]',
      "Stack name(s) to diff. Accepts physical CloudFormation names (e.g. 'MyStage-Api') or CDK display paths (e.g. 'MyStage/Api'). Supports wildcards (e.g. 'MyStage/*')."
    )
    .option('--all', 'Diff all stacks', false)
    .option(
      '--recursive',
      'Recurse into each AWS::CloudFormation::Stack row and diff every nested-stack child against its own deployed state (DFS order). Default is non-recursive, matching cdk diff.',
      false
    )
    .option(
      '--fail',
      'Exit with code 1 when any change is detected (matches cdk diff --fail). With --recursive, considers the whole nested-stack tree.',
      false
    )
    .option(
      '--json',
      'Output the diff as JSON (nested tree shape when combined with --recursive)',
      false
    )
    .action(withErrorHandling(diffCommand));

  // Add options
  [...commonOptions, ...appOptions, ...stateOptions, ...stackOptions, ...contextOptions].forEach(
    (opt) => cmd.addOption(opt)
  );

  // --region is deprecated for diff (PR 5). Accepted for backward
  // compatibility; warning emitted at runtime via warnIfDeprecatedRegion.
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
