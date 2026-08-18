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
import {
  scrubResourceRecord,
  redactSecretsForState,
  TEMPLATE_SOURCED_RULES,
  STATE_SOURCED_CROSS_GENERATION_RULES,
} from '../../deployment/secret-redaction.js';
import type { StackState } from '../../types/state.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import {
  collectDeclaredOutputNames,
  exportAliasCollisionScrubWarning,
  isExportAliasCollision,
} from '../../deployment/outputs-export-alias.js';

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
 * reference is stored as its UNRESOLVED expression rather than the plaintext
 * value (GHSA fix). "Secret" here is whatever the RESOLVER classifies as one,
 * which is the single source of truth this command shares with the deploy
 * path: every `{{resolve:secretsmanager:...}}`, plus a `{{resolve:ssm:...}}`
 * naming a `SecureString` parameter (issue #1901). scrub therefore gains a new
 * secret class automatically, with no second list to keep in sync.
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
 * that was stored in plaintext should be treated as compromised and ROTATED at
 * its source — in Secrets Manager, or by re-putting the `SecureString` SSM
 * parameter; scrub only stops it from being re-read out of state going
 * forward.
 *
 * ORDERING: scrub matches the CURRENT resolved secret value against what state
 * holds, so run it BEFORE rotating. Once the secret is rotated, the value in
 * state no longer matches the current one and scrub cannot find it (it reports
 * "nothing to scrub"). A rotated-away stale value in state is invalidated by
 * the rotation, but to remove it, redeploy the stack (which rewrites the record
 * with the expression).
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

  for (const stack of targetStacks) {
    const stackRegion = stack.region || region;
    const scrubbed = await scrubStack(stack, stackRegion, stateBackend, lockManager, {
      dryRun: options.dryRun ?? false,
      roleArn: options.roleArn,
      logger,
    });
    // The verdict keys on records-that-CHANGED (state actually held plaintext),
    // NOT on secrets-found: a resource whose reference is already stored as its
    // `{{resolve:...}}` expression resolves the same secret again but needs no
    // rewrite. Only a state record still holding the plaintext counts.
    if (scrubbed.recordsChanged > 0) {
      totalStacksScrubbed++;
      logger.info(
        `${options.dryRun ? 'Would scrub' : 'Scrubbed'} ${scrubbed.recordsChanged} resource record(s) ` +
          `in ${stack.stackName}`
      );
    } else {
      logger.info(`No plaintext secrets found in ${stack.stackName}`);
    }
  }

  if (totalStacksScrubbed === 0) {
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
      `treated as compromised — ROTATE it in Secrets Manager (scrub matches the current ` +
      `value, so scrub BEFORE rotating).`
  );
}

/**
 * Scrub one stack's state. Re-resolves the template's per-resource properties to
 * learn the resolved secret VALUES, then replaces those values in the state
 * record with their `{{resolve:...}}` expressions. Returns counts; performs no
 * AWS mutation. Acquires the stack lock for the read-modify-write unless
 * `dryRun`.
 */
export async function scrubStack(
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
    // PER-RESOURCE secrets (keyed by logicalId) + a separate outputs map, so a
    // whole-secret value from one resource cannot rewrite another's literal —
    // the cross-resource collision the deploy engine's `perResourceSecrets` doc
    // describes.
    const perResourceSecrets = new Map<string, Map<string, string>>();
    const perResourceTemplateProps = new Map<string, Record<string, unknown>>();
    const outputSecrets = new Map<string, string>();
    const outputsTemplateSource: Record<string, unknown> = {};
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
      const recordedSecretValues = new Map<string, string>();
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
      if (recordedSecretValues.size > 0) perResourceSecrets.set(logicalId, recordedSecretValues);
      // The unresolved template bag is this record's POSITION source (#1910).
      // Captured for EVERY templated resource, not only the secret-bearing ones,
      // because `scrubResourceRecord` uses it for the `observedProperties` walk
      // too — and unlike the deploy engine, `cdkd scrub` re-resolves the whole
      // template every run, so a resource with no recorded secret still has a
      // usable source in hand.
      perResourceTemplateProps.set(logicalId, templateResource.Properties);
    }

    // Outputs are secret-bearing too (a CfnOutput resolving a secret reference),
    // so re-resolve the template Outputs to record any secret they carry.
    const templateOutputs = stack.template.Outputs ?? {};
    // The SAME key-space rules the deploy engine applies when it builds this bag
    // (issue #1919) — shared rather than re-spelled, because this bag only works
    // if it reproduces the deploy engine's key ownership. Without a guard here
    // `cdkd scrub` was the WORSE half of that defect: its bag is legacy state
    // holding plaintext, and the alias write below runs AFTER the owning
    // output's write in this single loop (the opposite winner from the deploy
    // engine, where the post-loop pass wins), so a colliding export name
    // positioned a CORRECT public output by the exporting output's secret
    // expression and rewrote it into a reference naming a DIFFERENT output's
    // secret — in the command that exists to remediate the advisory, and
    // republished from there into the exports index.
    //
    // Two rules differ from the engine's on purpose, and both follow from what
    // scrub can KNOW about state some earlier binary wrote:
    //
    // 1. A colliding key gets NO source at all, rather than the owning output's.
    //    The engine just resolved that key's value and knows whose it is; scrub
    //    does not, and in the corrupted-legacy case — the case it exists for —
    //    the alias may well have WON the key. So the key falls to the VALUE
    //    scan, which reads the plaintext actually stored and maps it back to
    //    the expression that produced it. That is the pre-#1910 behavior, which
    //    for this key is what the issue calls "weaker but not wrong: it
    //    returned an expression that at least resolved to the value it
    //    replaced". The residual it accepts is the #1910 collapse (two
    //    expressions sharing one resolved value) for that single key; neither
    //    rule dominates there, and the test file pins both sides of the trade.
    //
    // 2. Collisions are tested against every DECLARED output name, conditions
    //    ignored, and an INTRINSIC `Export.Name` is best-effort resolved for
    //    that test alone — see `collectDeclaredOutputNames` for why scrub must
    //    over-approximate here, and note the legacy population is exactly the
    //    binaries that DID resolve intrinsic export names into state keys, so a
    //    literal-only test leaves the original corruption reachable. The
    //    resolved name is never written as a source key: it is only compared.
    const declaredOutputNames = collectDeclaredOutputNames(templateOutputs);
    const ambiguousKeys = new Set<string>();
    for (const [name, output] of Object.entries(templateOutputs)) {
      // The declared type says `string`, but templates carry intrinsics here and
      // the pre-fix binary resolved them into state keys.
      const declaredExportName = (output as { Export?: { Name?: unknown } }).Export?.Name;
      let exportName: unknown = declaredExportName;
      if (declaredExportName !== undefined && typeof declaredExportName !== 'string') {
        try {
          exportName = await resolver.resolve(declaredExportName, {
            template: stack.template,
            resources: state.resources,
            ...(Object.keys(parameters).length > 0 && { parameters }),
            ...(Object.keys(conditions).length > 0 && { conditions }),
            stackName: stack.stackName,
            bestEffort: true,
          });
        } catch (err) {
          logger.debug(
            `Export.Name of output ${name} could not be resolved during scrub: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      if (
        typeof exportName === 'string' &&
        isExportAliasCollision(exportName, name, declaredOutputNames)
      ) {
        ambiguousKeys.add(exportName);
        logger.warn(exportAliasCollisionScrubWarning(name, exportName));
      }
    }
    for (const [name, output] of Object.entries(templateOutputs)) {
      const value = output.Value;
      if (value === undefined) continue;
      // The unresolved output value is its POSITION source (#1910).
      if (!ambiguousKeys.has(name)) outputsTemplateSource[name] = value;
      // `state.outputs` ALSO carries an export-name ALIAS for the same value
      // (the deploy engine writes one so `Fn::ImportValue` can find it), and
      // that second key needs the same source or it falls to the value scan and
      // collapses onto a sibling's expression. Only a LITERAL export name gets a
      // source: the resolved form of an intrinsic one is trusted for the
      // collision TEST above but not as a key to write under, since a
      // best-effort resolution with template-default parameters can differ from
      // what the deploy resolved. (Nor can scrub meet the secret-bearing-name
      // case the deploy engine refuses: it never writes a resolved name.)
      const exportName = (output as { Export?: { Name?: unknown } }).Export?.Name;
      if (typeof exportName === 'string' && !ambiguousKeys.has(exportName)) {
        outputsTemplateSource[exportName] = value;
      }
      // NOT gated on the suppression rules the deploy engine applies, and this
      // is load-bearing rather than an omission: skipping the iteration would
      // skip the resolve below, so a secret this output carries would never be
      // RECORDED, and a stack whose only secret sits in a
      // (possibly-spuriously) suppressed output would be reported CLEAN by the
      // command whose job is to find it. The write above is the only thing a
      // suppressed output could get wrong, and the ambiguity set already covers
      // that.
      try {
        await resolver.resolve(value, {
          template: stack.template,
          resources: state.resources,
          ...(Object.keys(parameters).length > 0 && { parameters }),
          ...(Object.keys(conditions).length > 0 && { conditions }),
          stackName: stack.stackName,
          recordedSecretValues: outputSecrets,
          bestEffort: true,
        });
      } catch (err) {
        logger.debug(
          `Resolution of output ${name} during scrub was partial: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const totalSecrets =
      outputSecrets.size + [...perResourceSecrets.values()].reduce((n, m) => n + m.size, 0);
    if (totalSecrets === 0) {
      return { recordsChanged: 0, secretsFound: 0 };
    }

    // Rewrite each record with ITS OWN secrets, POSITIONED by its own unresolved
    // template bag (#1910), + the outputs; count changes.
    let recordsChanged = 0;
    const newResources: StackState['resources'] = {};
    for (const [logicalId, record] of Object.entries(state.resources)) {
      const secrets = perResourceSecrets.get(logicalId);
      const templateProps = perResourceTemplateProps.get(logicalId);
      // A record with NO recorded secret is still worth scrubbing once a source
      // is in hand: that is the #1900 shape (an `observedProperties` readback
      // echoing a secret whose leaf the template positions), and it is exactly
      // what an older binary left behind — which is the state `cdkd scrub`
      // exists to clean.
      // Position `properties` HERE rather than handing `templateProps` to
      // `scrubResourceRecord` (issue #1910 review). That parameter also
      // re-points the `observedProperties` walk at the template, which for
      // scrub is the wrong source: an observed leaf whose expression is in
      // STATE but no longer in the template would lose the #1900
      // trust-any-expression relaxation and fall back to the value scan —
      // exactly the legacy state this command exists to clean.
      //
      // TEMPLATE_SOURCED rules, NOT template-derived: this bag is persisted
      // state, so it was NOT produced by resolving today's template. Their
      // shapes can diverge, which makes positional array descent unsound; the
      // template carries public ssm expressions that must not be persisted; and
      // it is a different GENERATION, so a state leaf that ALREADY holds a
      // `{{resolve:...}}` token is not overwritten from it (issue #1917) — an
      // edited-but-undeployed template would otherwise rewrite state onto its
      // own expression and the next deploy would see NO_CHANGE. See the
      // generation table on `PathSourceRules`.
      const ownSecrets = secrets ?? new Map<string, string>();
      const positioned = templateProps
        ? {
            ...record,
            properties: redactSecretsForState(
              record.properties,
              ownSecrets,
              templateProps,
              TEMPLATE_SOURCED_RULES
            ),
          }
        : record;
      // STATE_SOURCED_CROSS_GENERATION rules for the observed walk (issue #1917
      // review). `scrubResourceRecord` would otherwise DERIVE
      // `STATE_SOURCED_READBACK_RULES` from the absent source argument — right
      // for every other caller, wrong here, because `positioned.properties`
      // above has already been moved onto TODAY's template. Taking that as the
      // observed source for a leaf that already holds an expression would
      // rewrite the drift baseline onto a reference the stack may never have
      // deployed, which `cdkd drift --revert` then pushes to AWS. The
      // trust-any-expression relaxation is kept — that source is still a STATE
      // bag — because it is what cleans a legacy PLAINTEXT observed leaf.
      const scrubbed =
        secrets || templateProps
          ? scrubResourceRecord(
              positioned,
              ownSecrets,
              undefined,
              STATE_SOURCED_CROSS_GENERATION_RULES
            )
          : record;
      if (JSON.stringify(scrubbed) !== JSON.stringify(record)) recordsChanged++;
      newResources[logicalId] = scrubbed;
    }
    // The DEFAULT rules, deliberately, and the reasoning is worth recording
    // because the constant's name argues against it. `state.outputs` is a
    // PERSISTED bag while `outputsTemplateSource` is TODAY's template, so
    // `TEMPLATE_DERIVED_RULES` — "the bag was produced by resolving the
    // source" — is not literally true of this pair. It is nonetheless the right
    // call, because the two constants differ on `descendArrays` ALONE
    // (`sourceIsSameGeneration` is already false in both), and that flag cannot
    // fire here: `outputsTemplateSource[name]` is a template Output's `Value`,
    // which CloudFormation requires to be a string or an intrinsic OBJECT — a
    // list-valued output is an `Fn::GetAtt`, never a literal array — so the
    // array arm is never reached however the bag is shaped. Measured across
    // every reachable shape (list bag against an `Fn::GetAtt` source, scalar,
    // `Fn::Join` source): byte-identical output under both constants. Switching
    // it would put a third, INERT behavior-shaped change in a PR that ships
    // two issues.
    //
    // What would make this wrong: `outputsTemplateSource` gaining a source
    // whose value can be an ARRAY. At that point the bag really is a persisted
    // generation walked against today's template, positional descent stops
    // being sound, and this call site needs `TEMPLATE_SOURCED_RULES`.
    const newOutputs =
      outputSecrets.size > 0
        ? redactSecretsForState(state.outputs, outputSecrets, outputsTemplateSource)
        : state.outputs;
    const outputsChanged = JSON.stringify(newOutputs) !== JSON.stringify(state.outputs);
    if (outputsChanged) recordsChanged++;

    if (recordsChanged > 0 && !opts.dryRun) {
      const nextState: StackState = {
        ...state,
        resources: newResources,
        outputs: newOutputs,
        lastModified: Date.now(),
      };
      await stateBackend.saveState(stack.stackName, region, nextState, {
        expectedEtag: loaded.etag,
      });
    }

    return { recordsChanged, secretsFound: totalSecrets };
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

  cmd.action(withErrorHandling(scrubCommand));
  return cmd;
}
