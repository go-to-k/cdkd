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
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer } from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../types/state.js';
import { DiffCalculator } from '../../analyzer/diff-calculator.js';
import { IntrinsicFunctionResolver } from '../../deployment/intrinsic-function-resolver.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';
import { matchStacks, describeStack } from '../stack-matcher.js';

const INTRINSIC_KEYS = new Set([
  'Ref',
  'Fn::Sub',
  'Fn::GetAtt',
  'Fn::Join',
  'Fn::Select',
  'Fn::Split',
  'Fn::If',
  'Fn::ImportValue',
  'Fn::FindInMap',
  'Fn::Base64',
  'Fn::GetAZs',
  'Fn::Equals',
  'Fn::And',
  'Fn::Or',
  'Fn::Not',
]);

function isIntrinsic(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 1 && INTRINSIC_KEYS.has(keys[0]!);
}

/**
 * Strip unchanged and intrinsic-only values from a diff value.
 *
 * Recursively compares `value` against `other` and keeps only the keys
 * whose values actually differ (excluding intrinsic vs resolved mismatches).
 * This produces a minimal diff showing only real changes.
 */
function stripUnchangedValues(value: unknown, other: unknown): unknown {
  // Primitives or nulls: return as-is (the caller already determined these differ)
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value;

  // If value itself is an intrinsic, omit it (it's not a real change)
  if (isIntrinsic(value)) return undefined;
  // If the other side is an intrinsic, the resolved value on this side is not a real change
  if (isIntrinsic(other)) return undefined;

  if (other === null || other === undefined || typeof other !== 'object' || Array.isArray(other)) {
    return value;
  }

  const valObj = value as Record<string, unknown>;
  const otherObj = other as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(valObj)) {
    const v = valObj[key];
    const o = otherObj[key];

    // If either side is intrinsic for this key, skip (not a real change)
    if (isIntrinsic(v) || isIntrinsic(o)) continue;

    // If values are deeply equal, skip
    if (JSON.stringify(v) === JSON.stringify(o)) continue;

    // Recurse for nested objects
    if (typeof v === 'object' && v !== null && typeof o === 'object' && o !== null) {
      const filtered = stripUnchangedValues(v, o);
      if (filtered !== undefined && JSON.stringify(filtered) !== '{}') {
        result[key] = filtered;
      }
    } else {
      result[key] = v;
    }
  }

  return Object.keys(result).length > 0 ? result : value;
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
    region?: string;
    profile?: string;
    verbose: boolean;
    context?: string[];
  }
): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  // PR 5: --region is deprecated on non-bootstrap commands. Warn but keep
  // the rest of the pipeline working as before.
  warnIfDeprecatedRegion(options);

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
    logger.info('Synthesizing CDK app...');
    const synthesizer = new Synthesizer();
    const context = parseContextOptions(options.context);
    const result = await synthesizer.synthesize({
      app: options.app,
      output: options.output,
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
      ...(Object.keys(context).length > 0 && { context }),
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
    const intrinsicResolver = new IntrinsicFunctionResolver(region);

    // 4. Calculate and display diff for each stack
    for (const stackInfo of targetStacks) {
      logger.info(`\nCalculating diff for stack: ${stackInfo.stackName}`);

      const template = stackInfo.template;
      // Stack region drives the state key. Falls back to the CLI region only
      // when synth couldn't determine a region (e.g. env-agnostic stacks).
      const stackRegion = stackInfo.region || region;

      // Load current state
      const stateResult = await stateBackend.getState(stackInfo.stackName, stackRegion);
      const currentState = stateResult
        ? stateResult.state
        : {
            stackName: stackInfo.stackName,
            region: stackRegion,
            resources: {},
            outputs: {},
            version: STATE_SCHEMA_VERSION_CURRENT,
            lastModified: Date.now(),
          };
      if (!stateResult) {
        logger.debug(`No existing state for ${stackInfo.stackName} (${stackRegion})`);
      }

      // Calculate diff. A best-effort intrinsic resolver lets us detect changes
      // buried inside intrinsics (e.g. Fn::Join literal args) against resolved
      // values in state. Resolution failures fall back to the unresolved value.
      const diffResolveFn = (value: unknown) =>
        intrinsicResolver.resolve(value, {
          template,
          resources: currentState.resources,
          stateBackend,
          stackName: stackInfo.stackName,
        });
      const changes = await diffCalculator.calculateDiff(currentState, template, diffResolveFn);

      // Display changes
      if (changes.size === 0) {
        logger.info('\n✓ No changes detected');
        continue;
      }

      logger.info(`\nStack ${stackInfo.stackName}:`);

      let createCount = 0;
      let updateCount = 0;
      let deleteCount = 0;

      for (const [logicalId, change] of changes.entries()) {
        switch (change.changeType) {
          case 'CREATE':
            createCount++;
            logger.info(`  [+] ${logicalId} (${change.resourceType})`);
            break;
          case 'UPDATE': {
            updateCount++;
            logger.info(`  [~] ${logicalId} (${change.resourceType})`);
            if (change.propertyChanges && change.propertyChanges.length > 0) {
              for (const propChange of change.propertyChanges) {
                const requiresReplace = propChange.requiresReplacement
                  ? ' [requires replacement]'
                  : '';
                // Strip unchanged and intrinsic values to show only actual changes
                const oldFiltered = stripUnchangedValues(propChange.oldValue, propChange.newValue);
                const newFiltered = stripUnchangedValues(propChange.newValue, propChange.oldValue);
                const indent = '              ';
                const oldStr = (JSON.stringify(oldFiltered, null, 2) ?? 'undefined').replace(
                  /\n/g,
                  `\n${indent}`
                );
                const newStr = (JSON.stringify(newFiltered, null, 2) ?? 'undefined').replace(
                  /\n/g,
                  `\n${indent}`
                );
                logger.info(`      - ${propChange.path}:${requiresReplace}`);
                logger.info(`          old: ${oldStr}`);
                logger.info(`          new: ${newStr}`);
              }
            }
            break;
          }
          case 'DELETE':
            deleteCount++;
            logger.info(`  [-] ${logicalId} (${change.resourceType})`);
            break;
        }
      }

      logger.info(`\n${createCount} to create, ${updateCount} to update, ${deleteCount} to delete`);
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
