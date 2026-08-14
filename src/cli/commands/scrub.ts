import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  stateOptions,
  stackOptions,
  contextOptions,
  deprecatedRegionOption,
  parseContextOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling, CdkdError } from '../../utils/error-handler.js';
import {
  Synthesizer,
  synthesisStatusMessage,
  type SynthesisOptions,
} from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';
import { matchStacks, describeStack } from '../stack-matcher.js';
import { IntrinsicFunctionResolver } from '../../deployment/intrinsic-function-resolver.js';
import { scrubResourceRecord } from '../../deployment/secret-redaction.js';
import type { StackState } from '../../types/state.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';

/**
 * Signals `cdkd scrub` found stacks whose state still holds plaintext secrets.
 * Only thrown under `--dry-run --fail`; carries no message (the plan was
 * already printed) and maps to a non-zero exit so CI can gate on it.
 */
class ScrubNeededError extends CdkdError {
  readonly silent: boolean = true;

  constructor() {
    super('scrub needed', 'SCRUB_NEEDED');
    this.name = 'ScrubNeededError';
    Object.setPrototypeOf(this, ScrubNeededError.prototype);
  }
}

interface ScrubOptions {
  app?: string;
  output: string;
  stateBucket?: string;
  statePrefix: string;
  stack?: string;
  all?: boolean;
  dryRun?: boolean;
  fail?: boolean;
  yes?: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  verbose: boolean;
  context?: string[];
}

/**
 * `cdkd scrub` — rewrite persisted state so any resolved secret dynamic
 * reference (`{{resolve:secretsmanager:...}}`) is stored as its UNRESOLVED
 * expression rather than the plaintext value (GHSA fix).
 *
 * A normal `cdkd deploy` already scrubs state as a side effect (the deploy
 * engine redacts every persisted bag), so this command is for cleaning up
 * existing state WITHOUT a redeploy — e.g. after upgrading cdkd on a stack you
 * do not want to re-provision right now.
 *
 * It needs the CDK app (`--app`) because a state file records the RESOLVED
 * plaintext with no marker of which values are secrets: only the template
 * carries the `{{resolve:...}}` expressions. So scrub synthesizes the template,
 * re-resolves each resource's properties to learn the resolved secret VALUES
 * (recorded, never printed or re-persisted), and replaces those values in the
 * state record's `properties` / `attributes` / `observedProperties` with the
 * expression. No AWS resource is created, updated, or deleted; only state.json
 * is rewritten. This is why it is a top-level command and not `cdkd state
 * scrub` — the `cdkd state ...` family operates on the state bucket alone and
 * deliberately needs no CDK code.
 *
 * IMPORTANT: scrubbing does not un-expose an already-leaked secret. A value
 * that was stored in plaintext should be treated as compromised and ROTATED in
 * Secrets Manager; scrub only stops it from being re-read out of state going
 * forward.
 */
async function scrubCommand(stacks: string[], options: ScrubOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');
  warnIfDeprecatedRegion(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  const app = resolveApp(options.app);
  if (!app) {
    throw new Error(
      'CDK app is required (scrub needs the template to identify secret references). ' +
        'Pass --app, set CDKD_APP, or add "app" to cdk.json.'
    );
  }

  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  logger.info(synthesisStatusMessage(app, 'Synthesizing CDK app...'));
  const synthesizer = new Synthesizer();
  const context = parseContextOptions(options.context);
  const synthOptions: SynthesisOptions = {
    app,
    output: options.output,
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
    ...(Object.keys(context).length > 0 && { context }),
    stateBucket,
    deferMacroExpansion: true,
  };
  const result = await synthesizer.synthesize(synthOptions);
  const allStacks = result.stacks;

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
    throw new Error('No stacks matched.');
  }

  await synthesizer.expandMacrosForStacks(targetStacks, synthOptions);

  const stateConfig = { bucket: stateBucket, prefix: options.statePrefix };
  const stateS3 = new AwsClients({
    region,
    ...(options.profile && { profile: options.profile }),
  });
  const stateBackend = new S3StateBackend(stateS3.s3, stateConfig, {
    region,
    ...(options.profile && { profile: options.profile }),
  });
  const lockManager = new LockManager(stateS3.s3, stateConfig);

  let totalStacksScrubbed = 0;
  let totalSecretsFound = 0;

  for (const stack of targetStacks) {
    const stackRegion = stack.region || region;
    const scrubbed = await scrubStack(stack, stackRegion, stateBackend, lockManager, {
      dryRun: options.dryRun ?? false,
      roleArn: options.roleArn,
      logger,
    });
    totalSecretsFound += scrubbed.secretsFound;
    if (scrubbed.recordsChanged > 0) totalStacksScrubbed++;
    if (scrubbed.recordsChanged > 0) {
      logger.info(
        `${options.dryRun ? 'Would scrub' : 'Scrubbed'} ${scrubbed.recordsChanged} resource record(s) ` +
          `in ${stack.stackName} (${scrubbed.secretsFound} secret reference(s))`
      );
    } else {
      logger.info(`No plaintext secrets found in ${stack.stackName}`);
    }
  }

  if (totalSecretsFound === 0) {
    logger.info('\nNo plaintext secrets found in any target stack state. Nothing to scrub.');
    return;
  }

  if (options.dryRun) {
    logger.info(
      `\nPlan: ${totalStacksScrubbed} stack(s) hold plaintext secrets and would be scrubbed ` +
        `(--dry-run, no state written). ROTATE any exposed secret in Secrets Manager.`
    );
    if (options.fail) throw new ScrubNeededError();
    return;
  }

  logger.info(
    `\nDone: scrubbed ${totalStacksScrubbed} stack(s). ` +
      `The plaintext is no longer stored, but a value that was ever persisted should be ` +
      `treated as compromised — ROTATE it in Secrets Manager.`
  );
}

/**
 * Scrub one stack's state. Re-resolves the template's per-resource properties to
 * learn the resolved secret VALUES, then replaces those values in the state
 * record with their `{{resolve:...}}` expressions. Returns counts; performs no
 * AWS mutation. Acquires the stack lock for the read-modify-write unless
 * `dryRun`.
 */
async function scrubStack(
  stack: StackInfo,
  region: string,
  stateBackend: S3StateBackend,
  lockManager: LockManager,
  opts: { dryRun: boolean; roleArn?: string | undefined; logger: ReturnType<typeof getLogger> }
): Promise<{ recordsChanged: number; secretsFound: number }> {
  const { logger } = opts;
  const acquired = !opts.dryRun;
  if (acquired) {
    await lockManager.acquireLockWithRetry(stack.stackName, region, undefined, 'scrub');
  }
  try {
    const loaded = await stateBackend.getState(stack.stackName, region);
    if (!loaded) {
      logger.debug(`No state for ${stack.stackName} (${region}) — skipping`);
      return { recordsChanged: 0, secretsFound: 0 };
    }
    const state = loaded.state;

    // Re-resolve each resource's TEMPLATE properties to collect the resolved
    // secret plaintext -> expression map. The resolved output is discarded; only
    // the recorded secrets matter.
    const recordedSecretValues = new Map<string, string>();
    const resolver = new IntrinsicFunctionResolver(region);
    let parameters: Record<string, unknown> = {};
    let conditions: Record<string, boolean> = {};
    try {
      parameters = await resolver.resolveParameters(stack.template);
    } catch (err) {
      logger.debug(
        `Parameter resolution skipped for ${stack.stackName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    try {
      conditions = await resolver.evaluateConditions({
        template: stack.template,
        resources: state.resources,
        ...(Object.keys(parameters).length > 0 && { parameters }),
        bestEffort: true,
      });
    } catch (err) {
      logger.debug(
        `Condition evaluation skipped for ${stack.stackName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const templateResources = stack.template.Resources ?? {};
    for (const logicalId of Object.keys(state.resources)) {
      const templateResource = templateResources[logicalId];
      if (!templateResource?.Properties) continue;
      try {
        await resolver.resolve(templateResource.Properties, {
          template: stack.template,
          resources: state.resources,
          ...(Object.keys(parameters).length > 0 && { parameters }),
          ...(Object.keys(conditions).length > 0 && { conditions }),
          stackName: stack.stackName,
          recordedSecretValues,
          bestEffort: true,
        });
      } catch (err) {
        // Best-effort: a resource whose intrinsics cannot resolve (a Ref to
        // something not in state) still has its own {{resolve:...}} leaves
        // recorded along the way; leave the rest untouched.
        logger.debug(
          `Resolution of ${logicalId} during scrub was partial: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (recordedSecretValues.size === 0) {
      return { recordsChanged: 0, secretsFound: 0 };
    }

    // Rewrite each record; count how many actually changed.
    let recordsChanged = 0;
    const newResources: StackState['resources'] = {};
    for (const [logicalId, record] of Object.entries(state.resources)) {
      const scrubbed = scrubResourceRecord(record, recordedSecretValues);
      if (JSON.stringify(scrubbed) !== JSON.stringify(record)) recordsChanged++;
      newResources[logicalId] = scrubbed;
    }

    if (recordsChanged > 0 && !opts.dryRun) {
      const nextState: StackState = { ...state, resources: newResources, lastModified: Date.now() };
      await stateBackend.saveState(stack.stackName, region, nextState, {
        expectedEtag: loaded.etag,
      });
    }

    return { recordsChanged, secretsFound: recordedSecretValues.size };
  } finally {
    if (acquired) {
      await lockManager.releaseLock(stack.stackName, region).catch((err) => {
        logger.warn(
          `Failed to release lock for ${stack.stackName}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  }
}

export function createScrubCommand(): Command {
  const cmd = new Command('scrub')
    .description(
      'Rewrite persisted state so resolved secret dynamic references are stored ' +
        'as their {{resolve:...}} expression, not the plaintext value (no deploy).'
    )
    .argument('[stacks...]', 'Stack name(s) to scrub (physical name or display path)')
    .option('--all', 'Scrub every stack in the synthesized app', false)
    .option('--dry-run', 'Report what would be scrubbed without writing state')
    .option('--fail', 'With --dry-run, exit non-zero if any plaintext secret is found (CI gate)');

  [...commonOptions, ...appOptions, ...stateOptions, ...stackOptions, ...contextOptions].forEach(
    (opt) => cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);

  cmd.action(async (stacks: string[], options: ScrubOptions) => {
    await withErrorHandling(() => scrubCommand(stacks, options));
  });
  return cmd;
}
