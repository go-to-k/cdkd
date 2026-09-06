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
import {
  withErrorHandling,
  CdkdError,
  CrossAccountSecretRefusalError,
  DynamicReferenceRegionAmbiguousError,
} from '../../utils/error-handler.js';
import {
  Synthesizer,
  synthesisStatusMessage,
  type SynthesisOptions,
} from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { foldRegionOption, namedCliRegion } from '../region-options.js';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';
import { matchStacks, describeStack } from '../stack-matcher.js';
import {
  IntrinsicFunctionResolver,
  carriesDynamicReference,
  type ResolverContext,
} from '../../deployment/intrinsic-function-resolver.js';
import {
  scrubResourceRecord,
  redactSecretsForState,
  dynamicReferenceTokens,
  errorCauseChain,
  maskSecretsInError,
  maskSecretsInText,
  TEMPLATE_SOURCED_RULES,
  STATE_SOURCED_CROSS_GENERATION_RULES,
  MIN_NEEDLE_LENGTH,
  type RecordedSecretValues,
} from '../../deployment/secret-redaction.js';
// Issue #2109: the region split is #2057's, imported rather than re-spelled —
// one answer to "which region must answer for this `{{resolve:...}}`
// expression", shared by the rollback replay and by `cdkd scrub`.
import {
  classifyReplaySecretRegion,
  producerRegionsFromState,
} from '../../deployment/rollback-executor.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import type { StackState } from '../../types/state.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
// Issue #2133 review: the SAME edge inference `cdkd deploy` orders with, so
// scrub's `--all` order is producer-before-consumer for a RAW
// `cdk.Fn.importValue` too — CDK emits no manifest dependency for one.
import { inferCrossStackStackDeps } from '../../analyzer/cross-stack-deps.js';
import { isUnresolvedValue, templateUsesSub } from '../../analyzer/outputs-diff.js';
import {
  collectDeclaredOutputNames,
  exportAliasCollisionScrubWarning,
  isExportAliasCollision,
  secretBearingStateKeyWarning,
  stateKeySecretExposure,
} from '../../deployment/outputs-export-alias.js';

/**
 * Signals `cdkd scrub` found plaintext it is reporting rather than removing.
 * Thrown under `--fail`: with `--dry-run` when any plaintext secret is in state,
 * and on a REAL run when a leak was found that scrub cannot rewrite (a
 * secret-bearing output KEY, issue #1919). Carries no message — the plan was
 * already printed — and maps to a non-zero exit so CI can gate on it.
 */
// Exported alongside `scrubCommand` so a test can assert the CI gate fails on
// the exact error type the CLI maps to a non-zero exit, rather than on any throw.
export class ScrubNeededError extends CdkdError {
  readonly silent: boolean = true;

  constructor() {
    super('scrub needed', 'SCRUB_NEEDED');
    this.name = 'ScrubNeededError';
    Object.setPrototypeOf(this, ScrubNeededError.prototype);
  }
}

/**
 * Every `cdkd scrub` REFUSAL — a reference this command cannot safely
 * re-resolve, and the per-stack failures that refusal produces under `--all`
 * (issue [#2109](https://github.com/go-to-k/cdkd/issues/2109) review).
 *
 * `exitCode = 2` rather than `CdkdError`'s default of 1, because 1 is already
 * SPOKEN FOR: `--fail` throws {@link ScrubNeededError} for "plaintext is in
 * state", and `docs/cli-reference.md` documents the pair as `1` (`--fail` found
 * plaintext) / `2` (error). A refusal is the second one, and left on the default
 * a CI gate reading the exit code alone could not tell "scrub looked and found a
 * leak" from "scrub refused to look" — the two call for opposite responses
 * (rotate the secret vs. re-spell the reference and re-run).
 */
class ScrubRefusalError extends CdkdError {
  readonly exitCode: number = 2;

  constructor(message: string, code: string) {
    super(message, code);
    this.name = 'ScrubRefusalError';
    Object.setPrototypeOf(this, ScrubRefusalError.prototype);
  }
}

export interface ScrubOptions {
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
 * One failed stack's reason, INCLUDING its `cause` chain (issue #2109 review).
 *
 * `err.message` alone drops the actionable half of a wrapped failure: a
 * provider or AWS error is routinely a generic sentence over the link that
 * names the role, the bucket or the denied action. The chain is walked with
 * `errorCauseChain` rather than a local loop so the links PRINTED are exactly
 * the links `maskSecretsInError` masked at `scrubStack`'s boundary — a private
 * walk would eventually render a link past that function's depth cap, which
 * still carries its original, unmasked message.
 */
function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return errorCauseChain(err)
    .map((link, i) => (i === 0 ? link.message : `\n    Caused by: ${link.message}`))
    .join('');
}

/**
 * The error a `--all` run ends with when one or more stacks could not be
 * scrubbed (issue #2109 review).
 *
 * Every stack is NAMED: the per-stack boundary keeps the run going, and a
 * single "3 stacks failed" line would make the operator re-run the command to
 * find out which. `exitCode = 2` for the same reason every other scrub refusal
 * carries it — `1` means "`--fail` found plaintext".
 *
 * The REASONS are deliberately not repeated here. Each was already logged at
 * `error` level, in run order, next to the progress lines for the stacks around
 * it; `handleError` then prints this message, so restating every reason made
 * the whole failure set appear TWICE in one terminal — directly under a summary
 * whose own note says "see the errors above". Names are kept because they are
 * what a reader needs to FIND those lines, and because the count alone is the
 * thing the paragraph above rejects.
 */
function scrubStacksFailedError(failures: ReadonlyArray<{ stackName: string }>): CdkdError {
  return new ScrubRefusalError(
    `${failures.length} stack(s) could not be scrubbed: ` +
      `${failures.map((f) => f.stackName).join(', ')}. ` +
      `Each one's reason was logged as it happened — see the ` +
      `'Scrub of <stack> failed:' line above for it.`,
    'SCRUB_STACKS_FAILED'
  );
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
 * OUTPUTS: `state.outputs` is scrubbed alongside the resource records, and its
 * repair scope is WIDER than today's declared outputs (issue #2005). A stored
 * output key the template can still name is redacted BY POSITION against that
 * template; a key it cannot name is repaired when its stored value MATCHES a
 * secret plaintext recorded anywhere this run, including one only a RESOURCE
 * still references. The motivating member of that population is an output
 * DELETED in an ordinary refactor, but it is not the only one — a key this run
 * cannot COMPUTE is in it too, and a parameterized `Export.Name` (scrub has
 * only template defaults) leaves the deploy's real alias key unaccounted on
 * EVERY run. When nothing recorded the plaintext the value is left exactly as
 * it is: a scrub that cannot identify the needle must not guess, because
 * `state.outputs` is re-applied VERBATIM to consumer stacks — by the exports
 * index (`src/state/export-index-store.ts`) and by `Fn::ImportValue` /
 * `Fn::GetStackOutput` (`src/deployment/intrinsic-function-resolver.ts`) — so a
 * fabricated redaction ships a literal `{{resolve:...}}` token into a
 * consumer's own AWS call. (`cdkd drift` is NOT one of those readers: it reads
 * `state.resources`, never `state.outputs`.) See `redactUnaccountedOutputs`.
 *
 * A FOURTH re-apply reader exists and is recorded here so the next audit does
 * not have to re-derive it: `NestedStackProvider.buildOutputsAttributes`
 * projects a CHILD record's `state.outputs` into the PARENT's
 * `Fn::GetAtt Outputs.X` attributes, i.e. into a parent resource property. It
 * is OUT of this command's reach, not exempt from the hazard — `scrubCommand`
 * targets synth STACK ARTIFACTS, and a nested child is a `nestedTemplates`
 * entry on its parent's `StackInfo` rather than an `aws:cloudformation:stack`
 * artifact of its own (`src/synthesis/assembly-reader.ts`), so the
 * `{parent}~{Child}` record this walk reads is never a stack scrub writes. If
 * scrub ever gains nested-child targets, this reader joins the list above and
 * the fabrication bound has to be re-argued for it.
 *
 * ORDERING: scrub matches the CURRENT resolved secret value against what state
 * holds, so run it BEFORE rotating. Once the secret is rotated, the value in
 * state no longer matches the current one and scrub cannot find it (it reports
 * "nothing to scrub"). A rotated-away stale value in state is invalidated by
 * the rotation, but to remove it, redeploy the stack (which rewrites the record
 * with the expression).
 */
// Exported for tests: the `--dry-run --fail` CI gate lives in this function, not
// in `scrubStack`, so pinning it at the helper's return value proves nothing
// about whether a finding actually fails the build (issue #1919 review).
export async function scrubCommand(stacks: string[], options: ScrubOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');
  warnIfDeprecatedRegion(options);
  // Issue #2065 - fold `--region` ONCE, at the boundary, so no raw spelling
  // reaches an SDK client, an ARN segment or a state key. Rationale (and why
  // this is per-command rather than per-consumer) in `src/cli/region-options.ts`.
  foldRegionOption(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  const app = resolveApp(options.app);
  if (!app) {
    throw new Error(
      'CDK app is required (scrub needs the template to identify secret references). ' +
        'Pass --app, set CDKD_APP, or add "app" to cdk.json.'
    );
  }

  const region = namedCliRegion(options.region) ?? 'us-east-1';
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

  // MACROS FIRST, then ordering (issue #2133 review). `expandMacrosForStacks`
  // rewrites each target's template IN PLACE, and `orderScrubTargets` decides
  // the order by SCANNING those templates for `Fn::ImportValue` — so ordering
  // first meant a macro-introduced import was invisible to the sort and its
  // producer could be scrubbed second. Expansion itself is order-independent
  // (it takes the whole array and returns void), so the swap costs nothing.
  //
  // Residual: `appStacks` below is `allStacks`, and only the TARGETS are
  // expanded, so a macro-introduced `{{resolve:` in a NON-target producer's
  // template is still invisible to `producerPublishesSecretExpression`. That
  // errs toward not refusing, i.e. the pre-#2133 outcome for that reference.
  await synthesizer.expandMacrosForStacks(targetStacks, synthOptions);

  // PRODUCER FIRST (issue #2133 review). A consumer can only learn an imported
  // secret's expression from a producer whose state has ALREADY been scrubbed,
  // so the order decides whether one `--all` run finishes a legacy app or
  // refuses half of it for a second run. See `orderScrubTargets`.
  targetStacks = orderScrubTargets(targetStacks);

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
  // Counted SEPARATELY from the stacks actually rewritten. A key-holding-
  // plaintext finding is a finding the command cannot remedy (issue #1919), and
  // folding it into the scrubbed count made the summary claim a remediation it
  // had not performed — the same invariant the export-name warning enforces:
  // a message must never assert what it did not do.
  let totalStacksWithUnscrubbableKeys = 0;
  // Stacks carrying a cross-stack read cdkd DECLINED to perform by design
  // (issue #2133 review) — today the cross-account `Fn::GetStackOutput` of a
  // redacted value. Counted like `totalStacksWithUnscrubbableKeys` and for the
  // same reason: it is a real finding no re-run can clear, so the summary must
  // not read as clean and `--fail` must not exit 0, but the stack itself was
  // still scrubbed for everything else and must not be refused outright.
  let totalStacksWithUnverifiableReads = 0;
  // Stacks this run could not scrub at all, one entry per stack (issue #2109
  // review). A refusal is per-REFERENCE evidence but is raised for the whole
  // STACK, and without a boundary here one refused stack in a `--all` run
  // abandoned every stack after it — silently, since the ones before it had
  // already been written. The rollback replay's twin refusal does not behave
  // that way: it is per-op and the remaining ops still run.
  //
  // The run still ends NON-ZERO (see the throw after the summary), so the
  // "never report success over a document it did not scrub" property is kept —
  // it is only the BLAST RADIUS of one refusal that narrows.
  const failures: Array<{ stackName: string }> = [];

  for (const stack of targetStacks) {
    const stackRegion = stack.region || region;
    let scrubbed: Awaited<ReturnType<typeof scrubStack>>;
    try {
      scrubbed = await scrubStack(stack, stackRegion, stateBackend, lockManager, {
        dryRun: options.dryRun ?? false,
        roleArn: options.roleArn,
        logger,
        // Every stack of the APP, not just this run's targets: the producer of
        // an import may be one the user did not name (issue #2133 review).
        appStacks: allStacks,
      });
    } catch (err) {
      // EVERY error, not only a `CdkdError` refusal. A stack whose state could
      // not be read, or whose lock is held, is in the same position as a
      // refused one: nothing was written for it, the remaining stacks are
      // independent, and the run must not exit 0. `scrubStack` releases its own
      // lock in a `finally`, so nothing is left held.
      //
      // The CAUSE CHAIN, not just `err.message` (issue #2109 review). This is
      // the only place a per-stack failure is rendered — the aggregate error
      // names stacks and stops there — so keeping the top message alone drops
      // the actionable half of a provider / AWS failure whose generic wrapper
      // says nothing ("the call failed" over an `AccessDenied` naming the role).
      // Safe to print because `scrubStack` masks every error that escapes it
      // against everything it recorded; this loop holds no secrets map and
      // could not mask anything itself.
      failures.push({ stackName: stack.stackName });
      logger.error(`Scrub of ${stack.stackName} failed: ${describeFailure(err)}`);
      // Verbose-only, mirroring `handleError`: the trace is what locates a
      // failure that is a cdkd bug rather than an AWS refusal, and `scrubStack`
      // masked it along with the messages.
      if (err instanceof Error && err.stack) logger.debug('Stack trace:', err.stack);
      continue;
    }
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
    } else if (scrubbed.secretBearingKeys === 0 && scrubbed.unverifiableReads === 0) {
      // BOTH findings gate this line (issue #2133 review). An unverifiable read
      // is a cross-stack reference cdkd declined to perform, so scrub does not
      // know what that leaf carries — printing "No plaintext secrets found"
      // over it is the same unearned clean claim the `secretBearingKeys` gate
      // already prevents for a key holding plaintext. The warning below still
      // fires either way; this only stops the two lines contradicting each
      // other.
      logger.info(`No plaintext secrets found in ${stack.stackName}`);
    }
    if (scrubbed.unverifiableReads > 0) {
      totalStacksWithUnverifiableReads++;
      logger.warn(
        `${scrubbed.unverifiableReads} cross-stack read(s) in ${stack.stackName} could NOT be ` +
          `verified — cdkd declines them by design (see the warnings above), so this stack is ` +
          `not reported clean.`
      );
    }
    if (scrubbed.secretBearingKeys > 0) {
      // A leak this command cannot remedy still counts as a FINDING — the CI
      // gate below must not call a state clean while `state.json` holds
      // plaintext in an output KEY (issue #1919) — but never as a scrub. No
      // state is written for it: the remedy is a template change, named in the
      // warning already logged. Reported outside the if/else above because a
      // stack can both hold scrubbable records AND carry such a key.
      totalStacksWithUnscrubbableKeys++;
      logger.warn(
        `${scrubbed.secretBearingKeys} output KEY(s) in ${stack.stackName} hold plaintext and CANNOT be scrubbed — ` +
          `rename the Export.Name and redeploy (see the warning above).`
      );
    }
  }

  if (
    totalStacksScrubbed === 0 &&
    totalStacksWithUnscrubbableKeys === 0 &&
    totalStacksWithUnverifiableReads === 0
  ) {
    // "in any target stack state" would be a claim about stacks this run never
    // got through, which is the same false-success the refusal exists to
    // prevent — so the sentence narrows to the stacks it actually reached.
    if (failures.length === 0) {
      logger.info('\nNo plaintext secrets found in any target stack state. Nothing to scrub.');
      return;
    }
    logger.info(
      `\nNo plaintext secrets found in the ${targetStacks.length - failures.length} stack(s) this ` +
        `run could examine. ${failures.length} stack(s) could NOT be scrubbed — see the errors above.`
    );
    throw scrubStacksFailedError(failures);
  }

  // Carried into every summary line below for the same reason `keyNote` is: a
  // count that says "scrubbed" must never be read as covering stacks this run
  // could not examine at all.
  const failureNote =
    failures.length > 0
      ? ` ${failures.length} stack(s) could NOT be scrubbed at all and are NOT covered by this ` +
        `summary — see the errors above.`
      : '';
  // Named separately in every summary line below, so the count that says
  // "scrubbed" only ever covers state this command actually rewrote.
  const keyNote =
    totalStacksWithUnscrubbableKeys > 0
      ? ` ${totalStacksWithUnscrubbableKeys} stack(s) hold plaintext in an output KEY, which cdkd scrub ` +
        `cannot rewrite — rename that output's Export.Name and redeploy.`
      : '';
  // Same discipline as `keyNote`: a summary must never let a finding it could
  // not remedy read as a clean result (issue #2133 review).
  const unverifiableNote =
    totalStacksWithUnverifiableReads > 0
      ? ` ${totalStacksWithUnverifiableReads} stack(s) carry a cross-stack read cdkd declines to ` +
        `perform, so their imported values could NOT be checked — export a non-secret value ` +
        `(e.g. the secret's ARN) from the producer, or reference it from within its own account.`
      : '';

  if (options.dryRun) {
    // Gated like its non-dry-run twin: with only key findings this would plan
    // to scrub nothing, and "0 stack(s) ... would be scrubbed" reads as a clean
    // result directly above a warning that says otherwise.
    if (totalStacksScrubbed > 0) {
      logger.info(
        `\nPlan: ${totalStacksScrubbed} stack(s) hold plaintext secrets and would be scrubbed ` +
          `(--dry-run, no state written).${keyNote}${unverifiableNote}${failureNote} ROTATE any exposed secret in Secrets Manager.`
      );
    } else {
      logger.info(
        `\nPlan: nothing can be scrubbed.${keyNote}${unverifiableNote}${failureNote} ROTATE any exposed secret.`
      );
    }
    // The refusal outranks the `--fail` gate: it is an ERROR (exit 2) about
    // state this run could not examine, while `ScrubNeededError` (exit 1) is a
    // finding about state it did.
    if (failures.length > 0) throw scrubStacksFailedError(failures);
    if (options.fail) throw new ScrubNeededError();
    return;
  }

  // Gated: with only key findings this rewrote nothing, and asserting that the
  // plaintext was removed would be the same false claim the masking invariant
  // forbids.
  //
  // What a successful run CAN claim is bounded by S3 versioning, which is why
  // this line no longer says "the plaintext is no longer stored there" (issue
  // [#2624](https://github.com/go-to-k/cdkd/issues/2624)). The rewrite is
  // `saveState`, a plain `PutObjectCommand`, and `cdkd bootstrap` turns
  // versioning on: the PUT makes the pre-scrub body NONCURRENT, not gone, and
  // it stays readable to anyone who can `GetObject` the state key with a
  // `VersionId`. Nothing here purges it — whether it SHOULD is the open half of
  // that issue — so the message states the bound and names rotation as the
  // remedy that actually applies to a copy cdkd cannot reach. See
  // docs/cli-scrub.md, "Scrubbing supersedes the plaintext, it does not erase it".
  if (totalStacksScrubbed > 0) {
    logger.info(
      `\nDone: scrubbed ${totalStacksScrubbed} stack(s). ` +
        `The CURRENT state.json no longer holds the plaintext. Where the state bucket is ` +
        `VERSIONED — which cdkd bootstrap enables — the pre-scrub body survives as a ` +
        `noncurrent version, stays readable with GetObject and a VersionId, and scrub does ` +
        `not purge it. So a value that was ever persisted must be treated as compromised — ` +
        `ROTATE it in Secrets Manager (scrub matches the current value, so scrub BEFORE ` +
        `rotating); rotation is what makes any surviving version ` +
        `harmless.${keyNote}${unverifiableNote}${failureNote}`
    );
  } else {
    logger.info(
      `\nNothing could be rewritten.${keyNote}${unverifiableNote}${failureNote} ROTATE any exposed secret.`
    );
  }
  // `--fail` is documented as a --dry-run CI gate, but a REAL run over a
  // key-only leak would otherwise exit 0 — and that is the one finding class a
  // real run cannot fix, so exiting clean is exactly backwards.
  if (failures.length > 0) throw scrubStacksFailedError(failures);
  // `totalStacksWithUnverifiableReads` joins the key-only leak here for the
  // reason stated on that counter: a real run cannot fix either one, so exiting
  // 0 over them is exactly backwards (issue #2133 review).
  if (
    options.fail &&
    (totalStacksWithUnscrubbableKeys > 0 || totalStacksWithUnverifiableReads > 0)
  ) {
    throw new ScrubNeededError();
  }
}

/**
 * Every secret plaintext this run recorded, from ANY position in the template
 * (issue #2005) — the outputs' own map plus every resource's, filtered to the
 * values long enough to be a safe needle.
 *
 * Used ONLY by {@link redactUnaccountedOutputs}, which is why the union is built
 * here rather than kept as the pass's input everywhere: `outputSecrets` and
 * `perResourceSecrets` are deliberately SEPARATE bags so one resource's secret
 * value cannot rewrite another resource's coinciding literal (the collision the
 * deploy engine's `perResourceSecrets` doc describes), and widening the bag the
 * RESOURCE walk uses would re-open exactly that.
 *
 * On a value collision the outputs' expression wins: it is written last, and an
 * output KEY is the closest kin of the bag this map is scanned against. Both
 * expressions resolve to the same plaintext by construction (that is what makes
 * them collide), so the choice costs precision, not correctness — the residual
 * documented for the ambiguous-key fallback one screen up. A resource-vs-
 * resource collision is NOT ordered by anything: `perResourceSecrets` is
 * iterated in map order and the LAST logical id wins, so between two resources
 * resolving one plaintext the surviving expression is whichever the walk
 * reached last. Same trade as above (both resolve to the same value), stated
 * because only the outputs-vs-resource half used to be.
 *
 * **The needle floor is the security half, and it looks like it contradicts
 * repo policy without doing so.** `redactSecretsForState`'s no-source arm
 * matches a WHOLE VALUE at ANY length; only its substring arm honors
 * {@link MIN_NEEDLE_LENGTH}. That is sound for a POSITION-SCOPED bag, where the
 * candidate leaf is already known to belong to the reference. This union has no
 * position source at all, so an unfiltered 1-3 character plaintext recorded by
 * ANY resource would whole-value-match an unrelated stored output and rewrite
 * it onto that resource's expression. Issues #2012 / #2036 do say that with no
 * evidence OVER-redaction is the right failure, because it is "visible,
 * recoverable, and not a disclosure" — but that asymmetry is about a DRIFT
 * BASELINE, and it does not transfer here: `state.outputs` is re-applied
 * VERBATIM to consumer stacks by the exports index
 * (`src/state/export-index-store.ts`) and by `Fn::ImportValue` /
 * `Fn::GetStackOutput` (`src/deployment/intrinsic-function-resolver.ts`), so a
 * false redaction ships a literal `{{resolve:...}}` token into a consumer's own
 * AWS call — the #1934 class, a BREAK rather than a recoverable mismatch. (Two
 * readers, not the whole list: the module doc records a third that is out of
 * this command's reach, with the derivation.)
 *
 * The floor is applied to the WHOLE union, `outputSecrets` included, and that
 * narrows NOTHING that worked before. The positioning pass still runs FIRST
 * over the same bag with the UNFILTERED `outputSecrets`, whole-value-matching
 * at any length, and {@link redactUnaccountedOutputs} scans the STORED value —
 * so a sub-floor output secret it cannot see compares equal, falls through, and
 * the positioned leaf survives into `repaired ?? positioned`. Pinned by the
 * suite's "still repairs a SCALAR unaccounted key holding a sub-floor OUTPUT
 * secret" case (`ab1` -> its expression — the exact shape the false note
 * described) and by its non-scalar sibling "keeps the POSITIONED value". The
 * floor's effect is therefore confined to CROSS-RESOURCE needles: a sub-floor
 * plaintext recorded only by a RESOURCE never becomes a needle for the outputs
 * bag. Stated because an earlier revision claimed a narrowing here, and a false
 * "we gave this up" note is how a capability gets removed for real later.
 *
 * **What the floor does NOT bound, stated plainly because it is the residual a
 * reader will otherwise assume away.** `redactSecretsForState`'s SUBSTRING arm
 * runs over this union too, so a recorded plaintext of {@link
 * MIN_NEEDLE_LENGTH} characters or more occurring ANYWHERE inside an unrelated
 * unaccounted output WILL be rewritten. `secretValueFromJson('username')`
 * resolving `admin` turns a stored `https://admin.example.com` into
 * `https://{{resolve:secretsmanager:...}}.example.com`, which the exports index
 * republishes and a consumer's `Fn::ImportValue` then ships to AWS as a literal
 * token — the #1934 BREAK class, from a value that was never a secret.
 *
 * That arm is kept, and raising the floor for this union alone was considered
 * and REJECTED, on three grounds:
 *
 * - **Substring matching is what makes the repair work at all.** A connection
 *   string embedding a password is #2005's own target shape and this suite's
 *   own `DbUrl` case; gutting the arm would leave the motivating population
 *   unrepairable, which is the disclosure the command exists to remove.
 * - **Length is a weak proxy for the hazard, in both directions.** The values
 *   that collide with unrelated text are common tokens — `admin`, `prod`,
 *   `root` — and raising the bar to 8 admits `password`, `postgres`,
 *   `localhost`, which are longer AND likelier to occur inside a stored URL. A
 *   higher floor would refuse genuine short secrets while still admitting the
 *   colliding ones.
 * - **4 is the repo's ONE answer, and a second number would have no
 *   derivation.** `secret-redaction.ts`'s own needles, `stateKeySecretExposure`
 *   (#1919) and `drift.ts`'s `carriesRecordedSecret` all use it. A union-only 8
 *   would be the only such constant in the tree justified by taste, and a later
 *   reader could not tell which is authoritative.
 *
 * The trade is right for a GHSA repair command because the two failure
 * directions differ on REVERSIBILITY, not on likelihood. A fabricated rewrite
 * is loud and remediable: the consumer's next deploy fails on an unresolvable
 * token, and the operator fixes the template or edits the key out of state. An
 * unrepaired plaintext is silent and permanent — the key is one today's
 * template does not declare, so no redeploy ever rewrites it, and no other
 * command can. Refusing the substring arm here would trade the irreversible
 * failure for the reversible one in the wrong direction.
 */
function allRecordedSecrets(
  outputSecrets: RecordedSecretValues,
  perResourceSecrets: ReadonlyMap<string, RecordedSecretValues>
): RecordedSecretValues {
  const union: RecordedSecretValues = new Map();
  for (const recorded of perResourceSecrets.values()) {
    for (const [value, expression] of recorded) union.set(value, expression);
  }
  for (const [value, expression] of outputSecrets) union.set(value, expression);
  for (const value of union.keys()) {
    if (value.length < MIN_NEEDLE_LENGTH) union.delete(value);
  }
  return union;
}

/**
 * Repair a stored output key today's template cannot ACCOUNT for (issue
 * [#2005](https://github.com/go-to-k/cdkd/issues/2005)) — the population `cdkd
 * scrub` is documented as the remedy for and could not actually remedy.
 *
 * `outputSecrets` is built from today's DECLARED outputs, and the outputs
 * redaction above is gated on it being non-empty. An output DELETED from the
 * template contributes nothing to that set, so a record whose only
 * secret-bearing output has since been removed was reported CLEAN by the
 * command whose job is to clean it, while the plaintext stayed in
 * `state.outputs` until an unrelated deploy happened to rewrite the bag. That
 * is precisely the record `cdkd diff` withholds from display
 * ([#1948](https://github.com/go-to-k/cdkd/issues/1948)): correctly hidden, and
 * until now not repairable.
 *
 * TWO scope decisions, and both are load-bearing.
 *
 * 1. **WHICH keys.** Only keys today's template cannot name — not in
 *    `accountedKeys` (every declared output name plus every `Export.Name` this
 *    run could compute). A key the template DOES name is left exactly as the
 *    pass above leaves it, deliberately, because that pass POSITIONS it against
 *    the template and this one cannot: scanning an accounted key against the
 *    union bag would let one resource's secret plaintext rewrite a declared
 *    output's coinciding literal onto that resource's expression — a value
 *    state was never meant to hold, in the command that exists to make state
 *    trustworthy. The accepted residual, stated because narrowing is what buys
 *    the safety: a DECLARED output whose template value no longer resolves a
 *    secret, but whose STORED value is still the stale plaintext of one a
 *    resource carries, is not repaired here either. A redeploy rewrites it.
 *
 * 2. **WHAT may be rewritten.** Only a value that genuinely MATCHES a recorded
 *    plaintext — `redactSecretsForState`'s value scan with no source, i.e. a
 *    whole-value match and an embedded one, both bounded at
 *    {@link MIN_NEEDLE_LENGTH} by {@link allRecordedSecrets}. A scrub that
 *    cannot identify the needle must not guess: `state.outputs` is re-applied
 *    VERBATIM to consumer stacks by the exports index and by `Fn::ImportValue`
 *    / `Fn::GetStackOutput` (and by one more reader out of this command's
 *    reach — see the module doc), so a fabricated redaction ships a literal
 *    `{{resolve:...}}` token into a consumer's AWS call. No key is invented and
 *    no key is removed for the same reason. When nothing this run recorded the
 *    plaintext (the secret was deleted, rotated away, or the reference is gone
 *    from the template too) the value is LEFT ALONE — but note that behavior
 *    does NOT live in this function's `secrets.size === 0` guard, which is one
 *    of three redundant reasons and fences none of them; see the guard's own
 *    comment for what actually reaches it.
 *
 * **The scanned VALUE is the STORED one, never the positioned pass's output**
 * (blocker found in review). Scanning an already-positioned leaf means scanning
 * an expression the first pass just INSERTED, and `redactSecretsForState`'s
 * token guard protects only a WHOLE-VALUE token — so a MIXED leaf
 * (`postgres://admin:{{resolve:secretsmanager:prod/db:...}}@app-db`, the
 * `Fn::Join` shape CDK emits) gets re-scanned and any union needle occurring
 * INSIDE the inserted reference is spliced into it, corrupting the expression
 * into one no service can resolve (the corruption `secret-redaction.ts`'s own
 * token guard documents). A single union scan of the STORED value subsumes the
 * first pass for these keys rather than composing with it: the union is a
 * superset of `outputSecrets` with the outputs' expression winning a collision,
 * and an unaccounted key by construction has no position source in
 * `outputsTemplateSource` (every key that bag carries — a declared output name
 * or a literal `Export.Name` — is in `accountedKeys`), so the first pass could
 * only ever have value-scanned it too.
 *
 * **The repaired population is WIDER than "an output you deleted."** Any stored
 * key today's template cannot COMPUTE is in it, and a parameterized
 * `Export.Name` is the standing example: `scrub` has only template defaults, so
 * a name resolving to the literal `prefix-${Foo}` leaves the REAL alias key the
 * deploy wrote unaccounted on EVERY run, and that key gets cross-resource value
 * matching for as long as the parameter stays unresolvable here. That is the
 * accepted cost of not being able to reproduce the key — the alternative is
 * leaving a permanently unrepairable key — but it is a standing exposure to the
 * fabrication risk above rather than a one-off after a refactor.
 *
 * Returns the input by IDENTITY when nothing changed. That is worth doing on
 * its own terms (no churn, no needless clone), but it is NOT what keeps the
 * caller honest: the caller compares with `JSON.stringify` unconditionally, so
 * an identity return cannot make it cheaper and a fresh-but-equal object could
 * not make it report a repair it did not perform.
 */
function redactUnaccountedOutputs(
  positioned: Record<string, unknown> | undefined,
  stored: Record<string, unknown> | undefined,
  accountedKeys: ReadonlySet<string>,
  secrets: RecordedSecretValues
): Record<string, unknown> | undefined {
  // `?? {}` nowhere: this must be able to return its input by identity, and
  // every other consumer treats the field as optional, so an absent bag is
  // returned untouched rather than materialized into an empty object. The
  // parameter and return types say `| undefined` because that is what the
  // runtime accepts and returns — `state.outputs` is optional in practice on a
  // state file that simply has no outputs.
  //
  // `!stored` cannot fire independently of `!positioned` and is a TYPE
  // narrowing rather than a second guard: `positioned` is DERIVED from
  // `stored`, and `redactSecretsForState` returns `undefined` for an absent bag
  // on both its arms (measured, with and without a position source). Stated so
  // nobody reads it as covering a case the other half does not.
  //
  // `secrets.size === 0` IS reachable, and its trigger is narrower than
  // "nothing was recorded this run". `scrubStack` early-returns at
  // `totalSecrets === 0`, but `totalSecrets` counts the RAW maps while this
  // union is additionally filtered to {@link MIN_NEEDLE_LENGTH} — so a stack
  // whose every recorded plaintext is SUB-FLOOR (a SecureString holding `ab1`
  // gives `totalSecrets === 1`) walks past that return and arrives here with an
  // empty union. That is the line's real trigger; an earlier revision of this
  // comment called it unreachable, which was true only before the floor existed
  // and which would have suppressed the retest that found this shape.
  //
  // It is still not the thing that protects an unrecoverable needle, and that
  // part is measured rather than assumed: delete this guard, or delete the
  // early return, and the record still comes out byte-identical, because an
  // empty secrets map makes every scan the identity. Three redundant reasons,
  // no single fence — stated because a comment claiming one would suppress the
  // next retest.
  if (secrets.size === 0 || !positioned || !stored) return positioned;
  let repaired: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(stored)) {
    if (accountedKeys.has(key)) continue;
    const next = redactSecretsForState(value, secrets);
    // NOT `next === value`: the value scan returns a string by identity when
    // nothing matched, but it CLONES every object / array it walks (an output
    // can hold a JSON array — a list-valued `Fn::GetAtt`), so an identity test
    // would rewrite `repaired[key]` for every non-scalar output. Harmless for
    // the reported COUNT (the caller re-compares by value), but it would
    // replace the positioned bag's clone with this pass's clone for keys this
    // pass did not change — churn in the persisted record for no reason, and a
    // needless divergence between two bags that should stay the same object.
    if (JSON.stringify(next) === JSON.stringify(value)) continue;
    repaired ??= { ...positioned };
    repaired[key] = next;
  }
  return repaired ?? positioned;
}

/**
 * The `cdkd scrub` resolvers: the stack's own, plus one pinned sibling per
 * FOREIGN region an ARN-named secret reference asks for (issue
 * [#2109](https://github.com/go-to-k/cdkd/issues/2109)).
 *
 * The same shape as `rollback-executor.ts`'s `ReplayResolvers`, and for the
 * same reasons. One instance per stack rather than per reference, because the
 * resolved-value cache lives on the resolver INSTANCE (issue #1933) — a
 * resolver per reference would re-fetch every secret once per reference. And
 * the pinned sibling is a PLAIN resolver, not a `producerRegionGuest`: it is
 * reached ONLY from a `named-region` verdict, which
 * {@link classifyReplaySecretRegion} returns only for an expression whose
 * SECRET_ID / parameter name starts with `arn:` and carries a region, so a
 * sibling only ever resolves an expression whose key EMBEDS the region it is
 * being resolved in. The process-global verdict store is keyed by the
 * expression STRING alone, and an ARN-form key cannot be shared by two regions,
 * so a sibling can never pin one region's verdict for another region's key. If
 * a future change ever routes a region-LESS expression here, that argument dies
 * with it and the sibling needs the guest flag.
 */
class ScrubResolvers {
  /** The stack's own resolver — every `local` verdict resolves through this. */
  readonly primary: IntrinsicFunctionResolver;
  private readonly pinned = new Map<string, IntrinsicFunctionResolver>();
  private readonly stackRegion: string;

  constructor(stackRegion: string) {
    this.stackRegion = stackRegion;
    this.primary = new IntrinsicFunctionResolver(stackRegion);
  }

  /** The resolver that must answer for `region` — `primary` when it is the stack's own. */
  forRegion(region: string): IntrinsicFunctionResolver {
    const target = canonicalizeRegion(region);
    if (target === canonicalizeRegion(this.stackRegion)) return this.primary;
    const cached = this.pinned.get(target);
    if (cached) return cached;
    const scoped = new IntrinsicFunctionResolver(target);
    this.pinned.set(target, scoped);
    return scoped;
  }
}

/**
 * What {@link pinCrossRegionSecrets} needs to decide, and then act on, the
 * region question for one template bag (issue #2109).
 */
interface CrossRegionSecretContext {
  /** The region the STACK is deployed in — the consumer's, and the primary resolver's. */
  stackRegion: string;
  /** Producer regions this stack's persisted cross-stack reads name. */
  producerRegions: readonly string[];
  resolvers: ScrubResolvers;
  /**
   * The SAME map the primary resolution records into, so a producer-region
   * plaintext becomes a redaction needle exactly like a local one. This is the
   * whole point of resolving here rather than merely classifying: scrub's
   * product is the needle map, not the resolved bag.
   */
  recordedSecretValues: RecordedSecretValues;
  /** Where the bag came from, for the refusal message ("resource 'Db'"). */
  origin: string;
}

/**
 * The refusal a region-AMBIGUOUS reference raises (issue #2109), the twin of
 * `rollback-executor.ts`'s `regionAmbiguousReplaySecretError`.
 *
 * A `CdkdError`, so it leaves `scrubStack` -> `scrubCommand` ->
 * `withErrorHandling` as a NON-ZERO EXIT with the message printed. That
 * visibility is the acceptance criterion of the issue, not a detail of it: the
 * one outcome that must not survive is scrub reporting success over a document
 * it did not scrub, and a debug log next to a `Done: scrubbed 0 stack(s)` line
 * IS that outcome.
 *
 * It refuses the whole STACK rather than the one reference, which is wider than
 * it needs to be and is the deliberate side of the trade. Scrubbing the rest
 * and reporting success would leave the operator with "no plaintext secrets
 * found" over state that still holds one — the failure this command exists to
 * prevent, arriving through the remediation. Names the reference, both regions
 * and the remedy so the refusal is actionable.
 *
 * Never the resolved value: nothing has been resolved for this reference, and
 * the expression is the same string `state.json` already stores in the clear.
 */
function regionAmbiguousScrubSecretError(
  origin: string,
  stackName: string,
  secretName: string,
  foreignProducerRegions: readonly string[],
  stackRegion: string
): CdkdError {
  return new ScrubRefusalError(
    `Scrub of ${stackName} cannot re-resolve the secret reference '${secretName}' in ${origin}: ` +
      `the reference carries no region of its own, and this stack read across a region boundary ` +
      `(producer region(s) on record: ${foreignProducerRegions.join(', ')}), so it may have been ` +
      `resolved in one of those rather than in '${stackRegion}'. A secret of the same name in two ` +
      `regions is two independent values, so scrub would look for the WRONG plaintext — leaving ` +
      `the real one in state while reporting the stack clean, and using the foreign value as a ` +
      `needle that can rewrite an unrelated literal. Refusing instead. Spell the reference as a ` +
      `full ARN, which names its region and is resolved there, then re-run 'cdkd scrub'.`,
    'SCRUB_SECRET_REGION_AMBIGUOUS'
  );
}

/**
 * The refusal a `named-region` reference raises when its OWN region cannot
 * answer for it (issue #2109).
 *
 * Continuing would hand the leaf back to the stack's own resolver, which is
 * issue #2109 verbatim — so this fails closed for the same reason the ambiguous
 * arm does. The cause is echoed because it is the actionable half (a denied
 * read in the producer region reads very differently from a missing secret) —
 * but MASKED against everything this run has recorded so far (issue #2109
 * review). No resolver error carries a plaintext today; the rule on this repo is
 * that a path which interpolates a foreign message into user-visible text masks
 * it anyway, because the day one does is the day the remediation command prints
 * the secret it exists to remove. The map is the SAME one the resolution records
 * into, so a value recorded a moment earlier in this very leaf is covered.
 */
function unresolvableForeignScrubSecretError(
  origin: string,
  stackName: string,
  secretName: string,
  region: string,
  cause: unknown,
  secrets: RecordedSecretValues
): CdkdError {
  return new ScrubRefusalError(
    `Scrub of ${stackName} could not resolve the secret reference '${secretName}' in ${origin} ` +
      `in the region its ARN names ('${region}'): ` +
      `${maskSecretsInText(cause instanceof Error ? cause.message : String(cause), secrets)}. ` +
      `Refusing rather than resolving ` +
      `it in the stack's own region, which would look for a different secret's value and report ` +
      `the stack clean over state that still holds the plaintext.`,
    'SCRUB_CROSS_REGION_SECRET_UNRESOLVED'
  );
}

/**
 * The literal that OPENS a dynamic reference. Used as the CHEAP pre-filter that
 * decides whether a leaf is walked at all — see {@link pinCrossRegionSecrets}.
 */
const DYNAMIC_REFERENCE_OPENING = '{{resolve:';

/**
 * The openings the assembled-reference guard actually COUNTS: `{{resolve:`
 * followed by a service whose VALUE CloudFormation defines as a secret. Counted
 * against the number of WHOLE tokens of the same class the scan matched, which
 * is how an ASSEMBLED reference is detected without parsing intrinsics — see
 * {@link isAssembledSecretReference}.
 *
 * WHY THE SERVICE IS PART OF THE OPENING (issue #2109 review). Counting the bare
 * `{{resolve:` made the guard fire on any leaf that merely MENTIONS the syntax
 * — measured: `Use the {{resolve: prefix for dynamic references` and
 * `{{resolve:}}` both count one opening and zero tokens. A description, an IAM
 * policy document, a UserData script or an environment variable saying that is
 * ordinary, and the refusal is permanent for the whole stack (exit 2, no bypass
 * flag) with a remedy — "spell the reference as one complete literal" — that is
 * unactionable for prose. Requiring the service makes the count a count of
 * SECRET references rather than of the characters `{{resolve:`.
 *
 * All three mirror `REPLAY_SECRET_SERVICES` in
 * `secret-region-classification.ts`, whose {@link classifyReplaySecretRegion}
 * is what classifies the tokens below — the same set on both sides, so the
 * count and the classification never disagree about what is in scope. Until
 * issue #2482 `ssm-secure` was counted here AHEAD of that set (cdkd did not
 * resolve it, so it could never become a wrong-region needle, and counting it
 * kept the guard correct for the day the resolver's arm changed); that day
 * came, and the two lists agree again.
 *
 * THE TRADE, stated rather than hidden: an `Fn::Join` that splits BEFORE the
 * service name (`['{{resolve:', 'secretsmanager:db:SecretString:pw}}']`) has no
 * counted opening in either part and stops being caught by this guard. The part
 * carrying the service has no `{{resolve:` at all, so `pinCrossRegionSecrets`
 * returns it by identity too. That shape falls to the same resolver-side
 * classification issue [#2134](https://github.com/go-to-k/cdkd/issues/2134)
 * tracks.
 */
const SECRET_REFERENCE_OPENINGS = [
  `${DYNAMIC_REFERENCE_OPENING}secretsmanager:`,
  `${DYNAMIC_REFERENCE_OPENING}ssm:`,
  `${DYNAMIC_REFERENCE_OPENING}ssm-secure:`,
] as const;

/**
 * What an `Fn::Sub` placeholder opens with. A whole token that CONTAINS one is
 * the third assembled shape — see {@link isAssembledSecretReference}.
 */
const SUB_PLACEHOLDER_OPENING = '${';

/** How many SECRET references {@link SECRET_REFERENCE_OPENINGS} `leaf` opens. */
function countSecretReferenceOpenings(leaf: string): number {
  let count = 0;
  for (const opening of SECRET_REFERENCE_OPENINGS) count += leaf.split(opening).length - 1;
  return count;
}

/** Whether a WHOLE token the scan matched is one of the secret spellings. */
function isSecretReferenceToken(token: string): boolean {
  return SECRET_REFERENCE_OPENINGS.some((opening) => token.startsWith(opening));
}

/**
 * Does this leaf ASSEMBLE a secret reference out of parts (issue #2109 review)
 * — i.e. does it OPEN more SECRET references than the scan found COMPLETE
 * tokens of that class in it, or carry a whole token that still holds an
 * `Fn::Sub` placeholder?
 *
 * WHY THIS EXISTS, and it is the load-bearing half of this pre-pass rather than
 * an edge case. The region split runs on the RAW template leaf, BEFORE intrinsic
 * resolution, and the shared token scan is `\{\{resolve:[^}]+\}\}` — a class
 * that cannot cross a `}`. So none of the three shapes that assemble a
 * reference out of parts yields the ONE WHOLE token a literal reference does,
 * and the third one is why this predicate needs two tests rather than one
 * (all four rows MEASURED):
 *
 * ```text
 *   "{{resolve:secretsmanager:my-secret:SecretString:pw}}"        1 opening, 1 token   literal
 *   "{{resolve:secretsmanager:${Env}-db:SecretString:password}}"  1 opening, 0 tokens  Fn::Sub, MID-string
 *   "{{resolve:secretsmanager:"  (one Fn::Join part)              1 opening, 0 tokens  Fn::Join split
 *   "{{resolve:secretsmanager:x:SecretString:${Field}}}"          1 opening, 1 token   Fn::Sub, TRAILING
 * ```
 *
 * The first two assembled rows are caught by the COUNT. The fourth is not, and
 * the count can never catch it: `[^}]+` stops at the `}` of `${Field}` and the
 * `}}` that follows closes the match one brace short, so the scan returns
 * `"{{resolve:secretsmanager:x:SecretString:${Field}"` + `}` — a token, of the
 * right class, exactly one per opening. It is caught instead by the second
 * test: a WHOLE token that still contains `${` has not been assembled yet.
 * Neither a Secrets Manager secret name nor an SSM parameter name may contain
 * `$` or `{`, so the only false positive that test can produce is a JSON key
 * literally spelled `${...}` in a leaf that is NOT under an `Fn::Sub` — and a
 * false positive here now costs a DEFERRAL rather than a refusal, so it is
 * cheaper than it was when this predicate raised
 * `SCRUB_SECRET_REFERENCE_UNCLASSIFIABLE`.
 *
 * WHAT A `true` MEANS FOR THE CALLER, and it changed with issue
 * [#2157](https://github.com/go-to-k/cdkd/issues/2157): the leaf is handed on
 * BY IDENTITY, so the PRIMARY resolver classifies the reference once
 * `resolveSub` / `resolveJoin` have assembled it. Before issue
 * [#2134](https://github.com/go-to-k/cdkd/issues/2134) that was issue #2109
 * verbatim — the resolver had no region question at all, so an identity return
 * meant a foreign secret fetched against the stack's own endpoint, and this
 * predicate therefore had to REFUSE (gated on a foreign producer region being
 * on record, to keep it from refusing the world). #2134 put the classification
 * in `resolveDynamicReferences`, which sees the COMPLETE expression, so the
 * safety property the refusal bought — a reference whose region cannot be
 * established is never resolved in the stack's own region — is now bought
 * downstream over strictly more information.
 *
 * The trailing-placeholder row reached the resolver a different way before that
 * second test existed: the truncated token WAS classified here, and only
 * downstream luck kept it safe (the name form classifies `ambiguous`, the ARN
 * form fails into `SCRUB_CROSS_REGION_SECRET_UNRESOLVED` because the id it
 * looks up still has a literal `${Field}` in it). Post-#2157 it is deferred
 * like the other three, and the resolver answers it on the assembled
 * expression instead of on a token one brace short. Every row is pinned by the
 * suite rather than assumed.
 *
 * Residual, unchanged and stated rather than hidden: an `Fn::Join` that splits
 * BEFORE the service name opens no counted reference at all (see
 * {@link SECRET_REFERENCE_OPENINGS}), so this predicate returns `false` for it
 * and the leaf is returned by identity anyway — the same destination, reached
 * without being noticed.
 */
function isAssembledSecretReference(leaf: string, secretTokens: readonly string[]): boolean {
  return (
    countSecretReferenceOpenings(leaf) !== secretTokens.length ||
    secretTokens.some((token) => token.includes(SUB_PLACEHOLDER_OPENING))
  );
}

/**
 * Resolve every FOREIGN-region `{{resolve:...}}` reference in one leaf through
 * a resolver pinned to the region the expression NAMES, and refuse the ones
 * whose region cannot be established (issue #2109).
 *
 * The returned string is what the primary resolver is handed, so a foreign
 * reference is already a value by the time the stack's own region sees the
 * leaf — the local endpoint is never asked about it at all. A leaf with no
 * foreign reference is returned BY IDENTITY and takes exactly the pre-#2109
 * path: `resolveDynamicReferences` has well-tested substitution semantics (it
 * collects matches from the ORIGINAL string, so a resolved plaintext that is
 * itself token-shaped is never re-resolved — issue #1917) and this change does
 * not relitigate any of it.
 *
 * That #1917 guarantee does NOT cross this seam — the primary receives a string
 * this function already substituted into — so the result is re-scanned and a
 * token the substitution INTRODUCED is refused rather than passed on. Fail
 * closed: a stopped scrub is recoverable, a lookup for a secret id spliced
 * together out of a plaintext is not.
 */
async function resolveForeignRegionTokens(
  leaf: string,
  stackName: string,
  ctx: CrossRegionSecretContext
): Promise<string> {
  // ONE spelling of the token scan, shared with `secret-redaction.ts` and the
  // rollback replay (issue #1936): a private regex here would answer a
  // different question from the one the resolver is about to ask.
  const tokens = dynamicReferenceTokens(leaf);
  // FIRST, before any classification: does every SECRET reference this leaf
  // OPENS exist as a complete, already-assembled token the scan could see? Two
  // tests, because the shapes fail in two different ways — see
  // {@link isAssembledSecretReference} for the measured table and for the
  // false positive counting bare `{{resolve:` produced.
  //
  // 1. COUNT. Openings and tokens are filtered to the SAME secret spellings, so
  //    a complete non-secret reference cannot make the two disagree. `!==`
  //    rather than `>` is not a stronger test today: matches are
  //    non-overlapping and each one BEGINS at a counted opening, so tokens can
  //    never exceed openings — the nested spelling gives 2 openings and 1 token,
  //    which `>` catches too. It is kept because that anchoring is a property of
  //    today's scan rather than of this function, and `!==` is the spelling that
  //    still refuses if a future scanner emits a token this count did not see.
  // 2. PLACEHOLDER. A whole token that still contains `${` is a TRAILING
  //    `Fn::Sub` placeholder, which the count provably cannot see.
  //
  // NOT A REFUSAL ANY MORE — it DEFERS (issue
  // [#2157](https://github.com/go-to-k/cdkd/issues/2157)). Until issue
  // [#2134](https://github.com/go-to-k/cdkd/issues/2134) this same condition
  // threw `SCRUB_SECRET_REFERENCE_UNCLASSIFIABLE` whenever a foreign producer
  // region was also on record, because there was then genuinely nowhere else
  // the question could be asked: the reference did not exist as a complete
  // expression anywhere, so nothing downstream could classify it either.
  // #2134 moved the classification INTO `resolveDynamicReferences`, which runs
  // on the ASSEMBLED expression (`resolveSub` / `resolveJoin` re-enter it with
  // their result), and `scrubStack` supplies that resolver the same
  // `producerRegions` evidence this pre-pass holds. So the leaf is now handed
  // on BY IDENTITY and answered where the whole expression exists — routed to
  // the region its ARN names, or refused per reference by the resolver's own
  // `DYNAMIC_REFERENCE_REGION_AMBIGUOUS`.
  //
  // WHAT IS PRESERVED, AND WHAT IS NOT -- stated because the first three cuts of
  // this change each asserted the wrong half of it.
  //
  // PRESERVED, and over strictly MORE information: a reference whose region
  // cannot be established is never resolved in the stack's own region. The
  // resolver classifies the ASSEMBLED expression rather than the raw leaf, and
  // `classifyReplaySecretRegion` verdicts an ARN-form token `named-region`
  // whatever evidence it holds, so a deferred reference cannot be answered by
  // the wrong region.
  //
  // NOT PRESERVED: LOUDNESS when the downstream lookup FAILS. The refusal fired
  // BEFORE any attempt; deferring moves the attempt inside `scrubStack`'s
  // best-effort `catch { logger.debug }`, so a producer region answering
  // AccessDenied becomes a VERBOSE-ONLY line under a `No plaintext secrets
  // found` summary. The neighbouring shape -- an `Fn::Sub` placeholder scrub
  // cannot evaluate, which `resolveSub` warn-and-KEEPS without throwing at all
  // -- is less bad than that, and worth stating separately rather than lumping
  // in: `resolveSub` warns at DEFAULT verbosity (`subPlaceholderWarning`), so
  // the user does see a line, just not one that stops the summary from claiming
  // the stack is clean.
  //
  // That residual is TRACKED, not fixed here, and the reason is worth recording
  // because three rounds of review were spent on it: every attempt to detect
  // "this reference went unresolved" from OUTSIDE the resolver was a proxy, and
  // each proxy was wrong in BOTH directions. Keying on "the resolution threw"
  // missed the warn-and-keep shape and over-reported an unrelated `Ref` failure
  // sharing the bag; keying on "the raw leaf text survived" missed a leaf a
  // downstream intrinsic rewrote without resolving, broke on JSON escaping, and
  // -- worst -- fired permanently on PROSE that merely mentions
  // `{{resolve:secretsmanager:`, which is the unactionable-refusal class
  // {@link SECRET_REFERENCE_OPENINGS} already records as unacceptable. Only the
  // resolver knows which references it declined, so the fix belongs there:
  // issue [#2166](https://github.com/go-to-k/cdkd/issues/2166).
  //
  // Shipping without it is not a new silent class. `classifyReplaySecretRegion`
  // verdicts an ARN-form token `named-region` regardless of evidence, so a stack
  // with no cross-stack read on record ALREADY reached the same silent outcome
  // for the same leaf; this widens that existing population rather than creating
  // one, which is the same inconsistency the paragraph below removes.
  //
  // Deferring is unconditional on evidence, unlike the refusal it replaces.
  // The refusal was gated on `foreignProducerRegions.length > 0` to keep it
  // from refusing the world; deferral needs no such gate, because the reason
  // to defer is that THIS pass cannot classify an unassembled leaf, which is
  // true whatever evidence is on record. With no foreign region the two paths
  // agree anyway: a leaf whose scan yields no token produced empty `verdicts`
  // and fell out of the `named-region` test below by identity already.
  const secretTokens = tokens.filter(isSecretReferenceToken);
  if (isAssembledSecretReference(leaf, secretTokens)) return leaf;
  const verdicts = tokens.map(
    (token) =>
      [token, classifyReplaySecretRegion(token, ctx.stackRegion, ctx.producerRegions)] as const
  );

  // Refuse FIRST, over the whole leaf, before any reference is read — a leaf
  // can splice several references together, and reading the safe ones first
  // would leave a credential fetched and cached for a leaf that is about to be
  // refused anyway.
  for (const [, verdict] of verdicts) {
    if (verdict.kind === 'ambiguous') {
      throw regionAmbiguousScrubSecretError(
        ctx.origin,
        stackName,
        verdict.secretName,
        verdict.foreignProducerRegions,
        ctx.stackRegion
      );
    }
  }
  if (!verdicts.some(([, verdict]) => verdict.kind === 'named-region')) return leaf;

  const localTokens: string[] = [];
  let out = '';
  let cursor = 0;
  for (const [token, verdict] of verdicts) {
    const at = leaf.indexOf(token, cursor);
    // Unreachable while the tokens come from a scan of THIS string, so this
    // guards a future scanner change — and the direction it fails in is the
    // point. Handing the leaf back to the primary resolver would send a token
    // whose foreign region is already KNOWN to the stack's own region: issue
    // #2109 reintroduced by the guard meant to prevent a regression.
    if (at < 0) {
      throw new ScrubRefusalError(
        `Scrub of ${stackName} could not locate a scanned dynamic reference in ${ctx.origin}, ` +
          `in the value it was scanned from. Refusing rather than resolving it in ` +
          `'${ctx.stackRegion}', which would be the wrong region for a reference that names ` +
          `another one. This is an internal invariant failure — please report it with the ` +
          `resource type and property path.`,
        'SCRUB_SECRET_TOKEN_SCAN_MISMATCH'
      );
    }
    out += leaf.slice(cursor, at);
    if (verdict.kind === 'named-region') {
      const resolver = ctx.resolvers.forRegion(verdict.region);
      try {
        // The SAME `recordedSecretValues` map the primary records into, and the
        // resolver's own recording rules apply: an `ssm` reference is recorded
        // only when the producer region says `SecureString`, which is precisely
        // the verdict the stack's own region cannot be trusted to give (#1957).
        out += await resolver.resolveDynamicReferences(token, {
          template: { Resources: {} },
          resources: {},
          recordedSecretValues: ctx.recordedSecretValues,
        });
      } catch (err) {
        throw unresolvableForeignScrubSecretError(
          ctx.origin,
          stackName,
          verdict.secretName,
          verdict.region,
          err,
          ctx.recordedSecretValues
        );
      }
    } else {
      out += token;
      localTokens.push(token);
    }
    cursor = at + token.length;
  }
  out += leaf.slice(cursor);

  const surviving = dynamicReferenceTokens(out);
  if (
    surviving.length !== localTokens.length ||
    surviving.some((token, i) => token !== localTokens[i])
  ) {
    throw new ScrubRefusalError(
      `Scrub of ${stackName} refused ${ctx.origin}: resolving a cross-region secret reference ` +
        `produced a value that is itself dynamic-reference shaped, which the stack's own ` +
        `resolver would then resolve as if it were a reference of this stack's. Refusing rather ` +
        `than passing it on.`,
      'SCRUB_SECRET_RESOLUTION_REINTRODUCED_TOKEN'
    );
  }
  return out;
}

/**
 * Rewrite one template bag so every FOREIGN-region secret reference in it is
 * already resolved — in the region the expression NAMES — before the stack's
 * own resolver walks it (issue
 * [#2109](https://github.com/go-to-k/cdkd/issues/2109)).
 *
 * WHY SCRUB NEEDS THIS AT ALL. `scrubStack` learns which plaintexts to look for
 * by RE-RESOLVING the template through one resolver built from the stack's own
 * region, and `resolveSecretsManagerReference` builds its client from that
 * region and passes the SECRET_ID through as an opaque string — the AWS SDK's
 * endpoint ruleset has no ARN-derived endpoint rule, so a reference naming
 * another region's ARN is sent to this stack's regional endpoint. Both halves
 * of that go wrong at once, and the second is the one that is easy to miss: the
 * plaintext scrub exists to remove is never found (the needle is the wrong
 * region's value), so the command reports the stack CLEAN over state that still
 * holds the secret; and the foreign value is a real string, so scanning for it
 * can rewrite an unrelated stored literal that happens to coincide.
 *
 * The split is `classifyReplaySecretRegion`'s, imported from
 * `rollback-executor.ts` rather than re-spelled — one answer to "which region
 * must answer for this expression", shared by the rollback replay (#2057) and
 * by scrub. Its known OVER-refusal is inherited with it: a name-form reference
 * in a stack with ANY foreign producer region on record is refused even when it
 * is the stack's own purely-local secret, because the evidence
 * (`state.imports` / `state.outputReads`) is per-STACK and not per-reference.
 * That is the fail-closed side of a trade whose other side is a silently
 * unscrubbed state file.
 *
 * Returns the bag BY IDENTITY when nothing was foreign, which is every bag on
 * every existing code path. The caller keeps the ORIGINAL bag as its position
 * source either way — a substituted copy must never reach
 * `redactSecretsForState`, whose whole job is to read UNRESOLVED expressions
 * off it.
 */
async function pinCrossRegionSecrets<T>(
  bag: T,
  stackName: string,
  ctx: CrossRegionSecretContext
): Promise<T> {
  // NO PATH IS THREADED HERE, and its absence is a decision rather than an
  // oversight (issue #2109 review, revisited by issue
  // [#2157](https://github.com/go-to-k/cdkd/issues/2157)). The walk used to
  // build an `a.b[0].c` spelling for exactly ONE consumer: the
  // assembled-reference REFUSAL, which named the leaf because such a reference
  // is often one leaf of a `Properties` bag carrying hundreds. That refusal is
  // now a DEFERRAL, and the two refusals left in `resolveForeignRegionTokens`
  // (`ambiguous`, and a token the substitution introduced) name `ctx.origin`
  // only -- so the path had no reader left and was being built at every node of
  // every bag for nothing.
  //
  // Giving those two refusals a leaf path would be a real improvement and is a
  // DELIBERATE non-goal here: it changes user-visible message TEXT, which is a
  // different subject from relaxing an over-refusal. The cross-stack pre-pass
  // below keeps its own `path` because its refusals do read it.
  const walk = async (v: unknown): Promise<unknown> => {
    if (typeof v === 'string') {
      // THIS LINE BOUNDS THE WHOLE PRE-PASS (issue #2109 review). The region
      // split below arms only when the RAW leaf ITSELF carries a `{{resolve:`
      // opening; a leaf whose opening is CONTRIBUTED by another intrinsic is
      // returned by identity here and never reaches it.
      //
      // NOT A GAP ANY MORE, and the reachable shape was measured: a parameter
      // `DbSecretRef` whose `Default` is a full foreign-ARN reference, used as
      // `MasterUserPassword: { "Fn::Sub": "${DbSecretRef}" }`. This walk sees
      // only `"${DbSecretRef}"` and returns it, and `resolveSub` then re-scans
      // the SUBSTITUTED string — where, since issue
      // [#2134](https://github.com/go-to-k/cdkd/issues/2134),
      // `resolveDynamicReferences` classifies the assembled reference and routes
      // it to the region its ARN names (or refuses it as `ambiguous`). Before
      // #2134 this same path resolved the foreign reference against the stack's
      // own endpoint and reported the stack clean over surviving plaintext. The
      // same holds for a `Ref` / `Fn::FindInMap` that yields the opening, and it
      // is why the assembled-reference refusal this pass used to raise could be
      // relaxed to a deferral (issue #2157): the destination now answers.
      if (!v.includes(DYNAMIC_REFERENCE_OPENING)) return v;
      return await resolveForeignRegionTokens(v, stackName, ctx);
    }
    if (Array.isArray(v)) {
      const out: unknown[] = new Array(v.length) as unknown[];
      let changed = false;
      for (let i = 0; i < v.length; i++) {
        out[i] = await walk(v[i]);
        if (out[i] !== v[i]) changed = true;
      }
      return changed ? out : v;
    }
    if (v !== null && typeof v === 'object') {
      // `Object.create(null)`, the same `__proto__` hazard `redactByPath` and
      // `reresolveCrossStackValue` answer this way: a JSON-parsed bag can carry
      // an OWN `__proto__` key, and assigning it onto an object literal walks
      // the prototype setter instead of defining the key.
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      let changed = false;
      for (const [k, val] of Object.entries(v)) {
        out[k] = await walk(val);
        if (out[k] !== val) changed = true;
      }
      return changed ? out : v;
    }
    return v;
  };
  return (await walk(bag)) as T;
}

/**
 * Order scrub targets PRODUCER-BEFORE-CONSUMER (issue
 * [#2133](https://github.com/go-to-k/cdkd/issues/2133) review).
 *
 * `cdkd scrub --all` used to walk the assembly's artifact order, which is not
 * topological — `getAllStacks` iterates the manifest, and only `cdkd deploy`
 * sorts. That ordering decides whether a legacy multi-stack app can be scrubbed
 * in ONE run: a consumer importing a secret learns its expression only by
 * reading the producer's state, and that state holds the expression only once
 * the PRODUCER has been scrubbed. Reached in the other order the consumer gets
 * a plaintext, has no needle, and is refused
 * ({@link plaintextProducerCrossStackReadError}) until the user re-runs. Both
 * orders are SAFE — the refusal is what makes them safe — but only one of them
 * finishes the job in a single command.
 *
 * Edges come from BOTH sources `cdkd deploy` uses: CDK's own manifest
 * dependencies (`dependencyNames`, emitted for a strong reference through
 * `exportValue`) and {@link inferCrossStackStackDeps}, which scans the
 * synthesized templates for a RAW `cdk.Fn.importValue` / `Fn::GetStackOutput`
 * that CDK records no dependency for. Edges to stacks outside the target set
 * are ignored: a producer that is not being scrubbed cannot be ordered.
 *
 * Cycles cannot happen through `Fn::ImportValue` on a deployable app, but a
 * cycle in the INFERRED graph is possible (two stacks reading each other's
 * outputs weakly), so the sort degrades to input order for whatever it cannot
 * place rather than dropping or duplicating a stack. Ties keep input order, so
 * a single-stack or dependency-free `--all` run is byte-identical to before.
 */
export function orderScrubTargets<
  T extends {
    stackName: string;
    /**
     * Optional HERE though `StackInfo` types it as required: the assembly
     * reader always supplies it, but a caller assembling a stack record by
     * hand may not, and an ordering helper must not be the thing that throws.
     */
    dependencyNames?: string[] | undefined;
    template: CloudFormationTemplate;
  },
>(targets: readonly T[]): T[] {
  if (targets.length < 2) return [...targets];
  const inSet = new Set(targets.map((t) => t.stackName));
  const inferred = inferCrossStackStackDeps(targets);
  const producersOf = new Map<string, Set<string>>();
  for (const target of targets) {
    const producers = new Set<string>();
    for (const dep of target.dependencyNames ?? []) {
      if (inSet.has(dep) && dep !== target.stackName) producers.add(dep);
    }
    for (const dep of inferred.get(target.stackName) ?? []) {
      if (inSet.has(dep) && dep !== target.stackName) producers.add(dep);
    }
    producersOf.set(target.stackName, producers);
  }
  const ordered: T[] = [];
  const emitted = new Set<string>();
  const pending = [...targets];
  while (pending.length > 0) {
    // First stack, IN INPUT ORDER, whose producers are all already emitted.
    let index = pending.findIndex((t) =>
      [...(producersOf.get(t.stackName) ?? [])].every((p) => emitted.has(p))
    );
    // A cycle in the inferred graph: nothing is ready, so take the head and
    // keep going rather than looping forever or losing a stack.
    if (index === -1) index = 0;
    const [next] = pending.splice(index, 1);
    if (!next) break;
    ordered.push(next);
    emitted.add(next.stackName);
  }
  return ordered;
}

/**
 * A memoizing READ view over the state backend, for the resolutions ONE
 * `scrubStack` call performs (issue #2133 review).
 *
 * `resolveImportValue` has no lookup cache of its own: each reference costs a
 * `listStacks()` plus up to N `getState()` calls, and scrub resolves every
 * cross-stack reference TWICE — once in the pre-pass (which must run before the
 * best-effort catch can swallow a failure) and once in the main resolution
 * (which must run because the pre-pass deliberately does not rewrite the bag).
 * The view collapses both into one scan and one `getState` per (stack, region).
 *
 * `Object.create` rather than a hand-written wrapper object: the resolver also
 * reads `stateBackend.prefix` and could reach for more, and a literal cast to
 * `S3StateBackend` would turn the next such call into `undefined is not a
 * function`. Prototype delegation keeps every other member — and
 * `instanceof S3StateBackend` — intact.
 *
 * Deliberately NOT used for this stack's own `getState` / `saveState`: those go
 * through the real backend, so the read-modify-write still sees S3 rather than
 * a cache, and its ETag precondition still means what it says.
 */
function memoizeCrossStackStateReads(backend: S3StateBackend): S3StateBackend {
  const view = Object.create(backend) as S3StateBackend;
  let listed: ReturnType<S3StateBackend['listStacks']> | undefined;
  const states = new Map<string, ReturnType<S3StateBackend['getState']>>();
  view.listStacks = (): ReturnType<S3StateBackend['listStacks']> => {
    listed ??= backend.listStacks();
    return listed;
  };
  view.getState = (
    stackName: string,
    stateRegion: string
  ): ReturnType<S3StateBackend['getState']> => {
    const key = `${stackName}\u0000${stateRegion}`;
    let pending = states.get(key);
    if (!pending) {
      pending = backend.getState(stackName, stateRegion);
      states.set(key, pending);
    }
    return pending;
  };
  return view;
}

/**
 * Is this template output one the deploy would NOT have written (issue #2133
 * review)?
 *
 * The outputs passes deliberately run over EVERY declared output regardless of
 * its `Condition`, so a secret carried by a (possibly spuriously) suppressed
 * output still becomes a needle for the resource records that share it. That
 * argument justifies RESOLVING a suppressed output, and nothing more — it does
 * not justify REFUSING the whole stack when such a resolution fails, because a
 * suppressed output produced no `state.outputs` key and so has nothing at risk.
 * A dev-environment scrub would otherwise be refused outright by a prod-only
 * `Value: {Fn::ImportValue: ProdOnlyExport}` whose producer does not exist in
 * dev. So: resolve it best-effort, but disarm the refusal.
 *
 * An UNKNOWN condition counts as suppressed, matching `resolveIf`'s
 * unknown-selects-FALSE rule and erring toward not refusing.
 *
 * STATE OVERRULES THE CONDITION (issue #2133 review). `conditions` degrades to
 * `{}` whenever `evaluateConditions` throws, and even when it succeeds it is
 * evaluated from TEMPLATE PARAMETER DEFAULTS — scrub takes no `--parameters` —
 * so an output the deploy really did write reads as suppressed on any stack
 * deployed with non-default parameters, which silently disarms the refusal for
 * that position. `state.outputs` is the record of what the deploy ACTUALLY
 * wrote (keyed by output NAME, plus the export-name alias), so a key present
 * there is proof the output was not suppressed, whatever this run's
 * best-effort condition evaluation concluded.
 */
function isOutputSuppressed(
  name: string,
  output: { Condition?: unknown },
  conditions: Record<string, boolean>,
  stateOutputs: Record<string, unknown>
): boolean {
  const condition = output.Condition;
  if (typeof condition !== 'string') return false;
  if (conditions[condition] === true) return false;
  return !(name in stateOutputs);
}

/**
 * The intrinsics that read ANOTHER stack's state (issue
 * [#2133](https://github.com/go-to-k/cdkd/issues/2133)).
 *
 * Both require `context.stateBackend` — `resolveImportValue` throws without it,
 * and `Fn::GetStackOutput` reaches the same requirement through
 * `getSameAccountStackState` — which is exactly what scrub's three resolve
 * contexts did not supply, so neither could ever resolve here.
 */
const CROSS_STACK_INTRINSIC_KEYS = ['Fn::ImportValue', 'Fn::GetStackOutput'] as const;

/**
 * The intrinsic keys {@link IntrinsicFunctionResolver}'s `resolveValue`
 * dispatches on, IN ITS ORDER (issue #2133 review).
 *
 * The pre-pass below must decide which key of a multi-key node the RESOLVER
 * would act on, because a node carrying a higher-precedence sibling never
 * reaches its `Fn::ImportValue` at all. Testing the cross-stack keys first — as
 * the first cut did — makes the pre-pass perform a READ the main resolution
 * never performs, and a read that fails is a refusal over a reference the
 * deploy never made. Isolation (`{ [key]: node[key] }`) does not answer this:
 * it stops the pre-pass resolving something ELSE, it does not stop it resolving
 * something EXTRA.
 *
 * `Condition` is deliberately absent. The resolver's `{Condition: <name>}` arm
 * is gated on `context.conditionResolver`, which only `evaluateConditions`
 * threads; in every context this pre-pass runs under, such a node is an
 * ordinary object property literally named `Condition`.
 *
 * Fenced against the resolver's own dispatch order by
 * `tests/unit/cli/commands/scrub-import-value-secret.test.ts`, so a new
 * intrinsic added there cannot silently leave this copy behind.
 */
const RESOLVER_INTRINSIC_PRECEDENCE = [
  'Ref',
  'Fn::GetAtt',
  'Fn::Join',
  'Fn::Sub',
  'Fn::Select',
  'Fn::Split',
  'Fn::If',
  'Fn::Equals',
  'Fn::And',
  'Fn::Or',
  'Fn::Not',
  'Fn::ImportValue',
  'Fn::GetStackOutput',
  'Fn::FindInMap',
  'Fn::Base64',
  'Fn::GetAZs',
  'Fn::Cidr',
] as const;

/** The key `resolveValue` would dispatch on for `node`, or `undefined`. */
function effectiveIntrinsicKey(node: Record<string, unknown>): string | undefined {
  return RESOLVER_INTRINSIC_PRECEDENCE.find((key) => key in node);
}

/**
 * The refusal a cross-stack read raises when scrub cannot PERFORM it (issue
 * [#2133](https://github.com/go-to-k/cdkd/issues/2133)).
 *
 * The value behind such a reference MAY be a secret — a producer stack exporting
 * a `{{resolve:...}}` expression is exactly the shape issue #1934 persists — and
 * scrub learns its plaintext ONLY by performing the read. A read that fails
 * therefore leaves the command with no needle for that value, so a stored
 * plaintext survives and the stack is reported clean. Refusing is the same bar
 * issue #2109 sets for the cross-region case: reporting success over a document
 * scrub could not examine is the one outcome that must not survive.
 *
 * MASKED for the reason `unresolvableForeignScrubSecretError` states — the bag
 * this resolved through is one `pinCrossRegionSecrets` may already have
 * substituted a foreign plaintext into, so a resolver error echoing its input
 * can carry one, and the map is the same one this pass records into.
 */
function unresolvableCrossStackReadError(
  origin: string,
  stackName: string,
  intrinsic: string,
  path: string,
  cause: unknown,
  secrets: RecordedSecretValues
): CdkdError {
  return new ScrubRefusalError(
    `Scrub of ${stackName} could not resolve the ${intrinsic} in ${origin}` +
      `${path ? ` at ${path}` : ''}: ` +
      `${maskSecretsInText(cause instanceof Error ? cause.message : String(cause), secrets)}. ` +
      `Refusing rather than continuing: the value that reference carries may be a secret, and ` +
      `scrub would then have no plaintext to look for — reporting the stack clean over state ` +
      `that still holds it. Deploy the producer stack (or correct the reference) and re-run ` +
      `'cdkd scrub'.`,
    'SCRUB_CROSS_STACK_READ_UNRESOLVED'
  );
}

/**
 * The two sentences the plaintext-producer refusal is built from: what the
 * producer's TEMPLATE is being claimed to say, and the remedy that clears it
 * (issues [#2133](https://github.com/go-to-k/cdkd/issues/2133) review and
 * [#2146](https://github.com/go-to-k/cdkd/issues/2146) review).
 *
 * SEPARATE FROM THE ERROR BUILDER so both can be tested over verdict shapes the
 * walk does not produce today. The one below — `chained` with an EMPTY `via` —
 * is exactly such a shape: unreachable, because `chained` only ever returns
 * from a non-root frame whose `via` therefore has at least one entry, and yet
 * the arm that used to catch it was the WIDENED wording, which asserts "this run
 * could not match '<key>' to a declared output" — false of every `chained`
 * verdict, since a chained one matched the key and left through its value.
 *
 * WHICH SIGNAL KEYS WHICH ARM, since this file has now been round-tripped on it
 * once. The CLAIM keys on `kind`: only `widened` may say "could not say which",
 * and no amount of chain changes that. WHAT the claim names keys on the chain:
 * a `widened` verdict CAN have crossed a re-export, and saying "publishes at
 * least one output from a `{{resolve:...}}` expression" when the walk has just
 * established that none of its outputs does is the same over-claim in the other
 * direction.
 *
 * `via` IS DE-DUPLICATED, and may name the producer itself (issue #2146 review).
 * A chain that returns to the direct producer under a DIFFERENT output key —
 * `A -> B -> A`, or a self-import `A -> A` — is a real walk result, since the
 * visited set is keyed by `(stack, key)` rather than by stack. Left as-is it
 * rendered "producer 'A' ... RE-EXPORTING a value that 'A' declares ... (through
 * 'A')" and a remedy running `cdkd scrub A` two or three times, which reads as a
 * bug in the tool rather than as advice. The claim de-duplicates
 * ORDER-PRESERVINGLY keeping the FIRST occurrence (so the stack that declares
 * the expression stays last, where `chainRoot` reads it), and the remedy keeps
 * the LAST (so the DIRECT producer — the one actually holding the plaintext —
 * stays at the end of the order, where the user must scrub it).
 *
 * Naming the producer inside its own chain is left standing rather than
 * filtered: for `A -> B -> A` it is A that declares the expression, under an
 * output the consumer's key did not match, so dropping it would move the claim
 * onto B, which declares nothing.
 */
export function scrubRefusalWording(
  verdict: SecretExpressionVerdict,
  loggedExportKey: string,
  loggedProducerStack: string,
  loggedVia: readonly string[]
): { templateClaim: string; remedy: string } {
  const chain = dedupePreservingOrder(loggedVia, 'first');
  const chainRoot = chain[chain.length - 1];
  const through =
    chain.length > 1
      ? ` (through ${chain
          .slice(0, -1)
          .map((s) => `'${s}'`)
          .join(', ')})`
      : '';
  const templateClaim =
    verdict.kind === 'declared'
      ? `declares '${loggedExportKey}' from a {{resolve:...}} expression`
      : verdict.kind === 'chained'
        ? chainRoot !== undefined
          ? `publishes '${loggedExportKey}' by RE-EXPORTING a value that '${chainRoot}' declares ` +
            `from a {{resolve:...}} expression${through}`
          : `publishes '${loggedExportKey}' by RE-EXPORTING a value another stack of this app ` +
            `declares from a {{resolve:...}} expression`
        : chainRoot !== undefined
          ? `publishes at least one output that RE-EXPORTS a value '${chainRoot}' declares from ` +
            `a {{resolve:...}} expression${through} (this run could not match ` +
            `'${loggedExportKey}' to a declared output, so it cannot say which)`
          : `publishes at least one output from a {{resolve:...}} expression (this run could not ` +
            `match '${loggedExportKey}' to a declared output, so it cannot say which)`;
  // A CHAIN is scrubbed from its HEAD, and naming only the direct producer would
  // send the user into a second refusal: that producer can only store the
  // expression once ITS own producer has been scrubbed down to one.
  const scrubOrder = dedupePreservingOrder(
    [...chain].reverse().concat(loggedProducerStack),
    'last'
  );
  const remedy =
    scrubOrder.length > 1
      ? `Scrub the producers first, from the head of the chain (` +
        `${scrubOrder.map((s) => `'cdkd scrub ${s}'`).join(', then ')})`
      : `Scrub the producer first ('cdkd scrub ${loggedProducerStack}')`;
  return { templateClaim, remedy };
}

/**
 * `values` with repeats removed, keeping either the FIRST or the LAST occurrence
 * of each and preserving the order of the ones kept.
 */
function dedupePreservingOrder(values: readonly string[], keep: 'first' | 'last'): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const ordered = keep === 'last' ? [...values].reverse() : values;
  for (const value of ordered) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return keep === 'last' ? out.reverse() : out;
}

/**
 * The refusal a cross-stack read raises when it SUCCEEDED but the PRODUCER's
 * own state record still stores the PLAINTEXT (issue
 * [#2133](https://github.com/go-to-k/cdkd/issues/2133) review).
 *
 * That producer state is precisely the population `cdkd scrub` exists for:
 * state an older binary wrote. Reading it hands the consumer a bare string,
 * nothing lands in `recordedSecretValues`, `totalSecrets` stays 0 and the
 * consumer is reported "No plaintext secrets found" while its record still
 * holds that plaintext. That is the same silent success the issue exists to
 * kill, reached one step later.
 *
 * There is no correct value to write here instead. What scrub must persist for
 * an imported secret is the PRODUCER's `{{resolve:...}}` expression, and that
 * expression exists only in the producer's state — the consumer's template
 * carries `{"Fn::ImportValue": ...}`, which is a REFERENCE, not an expression.
 * Writing the reference into a state leaf would fabricate an expression that
 * `Fn::ImportValue` and the exports index re-apply verbatim to further
 * consumers, the #1934 BREAK class this file already refuses one class over.
 * So: refuse, and name the fix that actually works — scrub the producer first,
 * which turns its stored plaintext into the expression this read then resolves.
 */
function plaintextProducerCrossStackReadError(
  origin: string,
  stackName: string,
  intrinsic: string,
  path: string,
  producerStack: string,
  exportKey: string,
  verdict: SecretExpressionVerdict,
  secrets: RecordedSecretValues
): CdkdError {
  // MASKED, for the reason its sibling `unresolvableCrossStackReadError`
  // already gives (issue #2133 review — this builder interpolated both
  // identifiers RAW while the sibling masked).
  //
  // `exportKey` is the REACHABLE half: it is a RESOLVED export name, so an
  // `Fn::ImportValue` over a `{{resolve:...}}` string (or an `Fn::Sub` /
  // `Fn::Join` assembling one) makes it a resolved secret verbatim — which is
  // exactly why the resolver half of this same lane masks resolved export names
  // at EVERY log site. `maskSecretsInError` at `scrubStack`'s boundary is the
  // outermost net, not the rule, and it is provably NOT sufficient here:
  // `allRecordedSecrets` DROPS every needle below `MIN_NEEDLE_LENGTH`, while
  // the whole-value arm of `maskSecretsInText` matches at any length, so a
  // short secret is masked by this call and by nothing else.
  //
  // `producerStack` is masked because it is REACHABLE too — not, as an earlier
  // revision of this comment claimed, merely for uniformity with `exportKey`.
  // The claim held for ONE of the two arms that reach here. An
  // `Fn::ImportValue` producer name comes from the state-bucket listing
  // (`recordImport` is handed `entry.producerStack` / `refStack`), and that is
  // never a resolved value. An `Fn::GetStackOutput` producer name is
  // RESOLVED before it is recorded: `recordOutputRead(context, stackName, ...)`
  // is fed `await this.resolveValue(args['StackName'], context)`, so an
  // `Fn::Sub` / `Fn::Join` assembling a `{{resolve:...}}` into `StackName`
  // makes the recorded producer name a resolved secret exactly the way
  // `exportKey` can be.
  //
  // Nothing leaks today, because both identifiers are masked at every site
  // that prints them. What was wrong was the RATIONALE — and a wrong one is
  // worse here than none at all, since "never a resolved value" reads as
  // licence to drop the call the next time this line is touched.
  const loggedExportKey = maskSecretsInText(exportKey, secrets);
  const loggedProducerStack = maskSecretsInText(producerStack, secrets);
  // The claim about the producer's TEMPLATE is only as precise as the match
  // that produced it (issue #2133 review). `declared` matched an output by name
  // or by literal `Export.Name`, so naming the key is exact; `widened` matched
  // NO output — an intrinsic `Export.Name` scrub cannot reproduce — and the
  // verdict came from scanning every output of the producer, so asserting that
  // this key in particular is declared from an expression would be a statement
  // the code did not check.
  //
  // The RE-EXPORT case (issue #2146): the direct producer's own outputs carry no
  // `{{resolve:`, and the evidence came from following its re-exported import up
  // to the stack that does declare one. The message names THAT stack, because
  // the remedy differs — see below.
  //
  // Both halves are built by {@link scrubRefusalWording}, which is where the
  // `widened` / `chained` split and the chain de-duplication live.
  const { templateClaim, remedy } = scrubRefusalWording(
    verdict,
    loggedExportKey,
    loggedProducerStack,
    verdict.via.map((s) => maskSecretsInText(s, secrets))
  );
  return new ScrubRefusalError(
    `Scrub of ${stackName} resolved the ${intrinsic} in ${origin}` +
      `${path ? ` at ${path}` : ''} to a PLAINTEXT value: the producer stack ` +
      `'${loggedProducerStack}' ` +
      `${templateClaim}, but its own state still stores ` +
      `the resolved plaintext rather than that expression. scrub has no expression to write in ` +
      `this stack's place, so it cannot redact the imported secret and must not report this ` +
      `stack clean. ${remedy}, then re-run ` +
      `'cdkd scrub ${stackName}' — the read will then return the expression and this stack is ` +
      `scrubbed normally.`,
    'SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT'
  );
}

/**
 * How confidently the producer's TEMPLATE says its export is secret-bearing
 * (issue #2133 review).
 *
 * - `declared` — an output matched `key` by name or by literal `Export.Name`,
 *   and ITS declared `Value` carries a `{{resolve:` expression.
 * - `widened` — NO output matched `key`, so the test fell back to scanning
 *   every output of the producer, and one of them carries a `{{resolve:`
 *   expression or RE-EXPORTS a value some stack up the chain declares from one.
 *   The key is secret-bearing only by over-approximation, which the refusal
 *   message must not overstate. `via` is populated when the evidence came from
 *   up the chain, for the reason the `chained` entry gives — WITHOUT it the
 *   message claimed the producer "publishes at least one output from a
 *   `{{resolve:...}}` expression" when the walk had just established that none
 *   of them does, and the remedy degraded to the single `cdkd scrub <producer>`
 *   that sends the user into a second refusal.
 * - `chained` — no output of the producer carries a `{{resolve:` expression
 *   itself, but a matched output RE-EXPORTS an import whose own producer (or
 *   one further up the chain) declares one (issue
 *   [#2146](https://github.com/go-to-k/cdkd/issues/2146)). `via` names the
 *   stacks the walk crossed, nearest first, ending at the one whose template
 *   carries the literal expression.
 * - `no` — neither the producer's outputs nor anything reachable from them by
 *   re-export carries a `{{resolve:` expression.
 */
interface SecretExpressionVerdict {
  kind: 'declared' | 'widened' | 'chained' | 'no';
  /**
   * The stacks the evidence was followed THROUGH, nearest producer first, the
   * stack that declares the expression last. Populated for `chained` and for a
   * `widened` verdict whose evidence came from up the chain; EMPTY otherwise,
   * so the refusal message can never name a chain the walk did not cross.
   */
  via: readonly string[];
}

/** The `no` verdict, shared so the walk allocates nothing for the common case. */
const NO_SECRET_EXPRESSION: SecretExpressionVerdict = { kind: 'no', via: [] };

/**
 * Can the producer's STORED value be a legacy plaintext secret at all (issue
 * #2133 review)?
 *
 * `false` for a value that carries no text: `null` / `undefined`, the empty
 * string, and every non-string scalar. A resolved `{{resolve:...}}` reference
 * is always a STRING — `resolveDynamicReferences` substitutes text — so a
 * number or a boolean cannot be one, and an empty string holds nothing to
 * redact. Without this, `carriesDynamicReference` being false for those shapes
 * made a `widened` verdict refuse the consumer over a value with nothing behind
 * it, in a refusal that no re-run could clear (scrubbing the producer cannot
 * turn an empty value into an expression).
 *
 * Containers are NOT included: an array or object can nest a plaintext string,
 * and `carriesDynamicReference` already walks them, so the classification for
 * those is left exactly as it was.
 */
function storedValueCarriesNoPlaintext(stored: unknown): boolean {
  if (stored === null || stored === undefined) return true;
  if (typeof stored === 'string') return stored === '';
  return typeof stored !== 'object';
}

/**
 * Is `key` an export the producer's TEMPLATE declares from a `{{resolve:...}}`
 * expression (issue #2133 review)?
 *
 * This is HALF the discriminator, and the half the direct state read below
 * cannot supply. From the consumer's side, "the producer stored a plaintext
 * SECRET" and "the producer stored an ordinary non-secret value" are
 * indistinguishable — a bucket name and a leaked password are both bare
 * strings — so a refusal keyed on the producer's STORED value alone would fire
 * on every multi-stack app that imports anything at all. An export whose
 * declared `Value` contains no `{{resolve:` anywhere cannot be secret-bearing,
 * so its plaintext is nothing to redact.
 *
 * What it deliberately does NOT answer is whether the producer's own STATE has
 * been scrubbed down to that expression yet, which is the other half and the
 * one the three earlier cuts of this file each got wrong. See the discriminator
 * in {@link makeCrossStackPrePass}.
 *
 * `key` is the state.outputs KEY the read matched, which the deploy engine
 * writes under BOTH the output name and the literal `Export.Name` — hence both
 * are matched. When no output matches (an INTRINSIC `Export.Name`, which scrub
 * cannot reproduce from here) the test widens to every output of the producer,
 * which over-approximates in the SAFE direction: it can refuse a stack that
 * imports a non-secret export from a producer that has some other secret
 * output, and it never lets a secret-bearing one through. The widening is
 * REPORTED rather than folded into a boolean, because the refusal message
 * asserts what the producer declares and only the `declared` verdict has
 * checked that for THIS key.
 *
 * RE-EXPORT CHAINS ARE FOLLOWED (issue
 * [#2146](https://github.com/go-to-k/cdkd/issues/2146)). A MIDDLE stack whose
 * output is `{"Fn::ImportValue": "<upstream export>"}` declares no literal
 * `{{resolve:` of its own, so the single-template test returned `no` for it and
 * the consumer at the END of the chain was reported CLEAN over its surviving
 * plaintext — the #2133 silent success, reached through a re-export instead of
 * a direct import. (`cdkd scrub --all` masks it: `orderScrubTargets` scrubs
 * producers first, so the middle stack stores the expression by the time the
 * consumer is reached. `cdkd scrub <one stack>` does not.) This walk therefore
 * follows a matched output's `Fn::ImportValue` (through the export-name index)
 * and its `Fn::GetStackOutput` (through the literal `StackName` / `OutputName`)
 * into the next producer's template, and keeps going until it finds an
 * expression or runs out of reachable outputs.
 *
 * TERMINATION IS A VISITED SET over `(stack, key)` pairs, NOT a hop cap. Each
 * pair expands deterministically, so a second visit can never yield evidence
 * the first did not, and the pair space is finite (stacks x outputs) — so the
 * walk halts on a CYCLE (two stacks re-exporting each other; no deploy can
 * produce one, a template can express one) while losing no reach. A depth cap
 * was rejected because it is lossy in the one direction that matters: a chain
 * longer than the cap would return `no`, which is exactly the silent success
 * this walk exists to kill.
 *
 * WIDENING IS ROOT-ONLY, and that means WHERE THE FALLBACK FIRES, not what a
 * widened subject may expand into. The all-outputs fallback fires for the DIRECT
 * producer alone, where the key came from a read and may match nothing because
 * the producer's `Export.Name` is an intrinsic scrub cannot reproduce. One hop
 * up the key is a LITERAL export / output name read out of a template, so a miss
 * there means that template genuinely does not declare it, and widening THERE
 * would refuse the consumer over an unrelated secret two stacks away that no
 * scrub could ever clear.
 *
 * A widened root's subjects DO still expand into hops, deliberately, and the
 * trade is stated rather than hidden (issue #2146 review — an earlier revision
 * of this comment read as if they did not, which contradicted the code). Not
 * expanding them would make an intrinsic-`Export.Name` producer that re-exports
 * a secret undetectable — the exact silent success this walk exists to kill,
 * reintroduced for the one population the widening exists for. Expanding them
 * extends #2133's accepted over-approximation ("it can refuse a stack that
 * imports a non-secret export from a producer that has some other secret
 * output") by one hop, in the direction that repo rule calls safe; and the
 * refusal it produces now names the head of the chain and the order to scrub it
 * in, so it is at least as actionable as the root widening it extends.
 *
 * Residuals, stated rather than hidden. Each keeps the pre-#2133 outcome for
 * that one reference — a possible false CLEAN, never a refusal:
 * - a producer that publishes a secret with NO literal `{{resolve:` and no
 *   followable re-export: one reading it through `Ref` to a parameter, or
 *   re-exporting an export whose producer is outside this app (whose template
 *   scrub never sees), and a producer outside this app at all;
 * - a NON-LITERAL `Fn::ImportValue` argument (an `Fn::Sub`-assembled export
 *   name) and a NON-LITERAL or foreign `Fn::GetStackOutput` `StackName` /
 *   `OutputName`: the hop cannot be resolved statically, and guessing one would
 *   refuse over a reference the walk never established;
 * - a `Fn::GetStackOutput` naming a stack of this app in ANOTHER REGION:
 *   {@link buildExportOwnerIndex} and `producerTemplates` are keyed by stack
 *   NAME alone, so the walk reads that name's template regardless of `Region`;
 * - a secret reachable only through the TRUE branch of an `Fn::If` in a
 *   producer's output: see {@link selectTakenConditionalBranches}, which takes
 *   the FALSE branch for a condition it cannot evaluate -- and which, since
 *   issue [#2150](https://github.com/go-to-k/cdkd/issues/2150), feeds BOTH the
 *   literal scan below and {@link collectReExportHops} from that one
 *   selection.
 */
export function producerPublishesSecretExpression(
  templates: ReadonlyMap<string, CloudFormationTemplate>,
  exportOwners: ReadonlyMap<string, readonly string[]>,
  producerStack: string,
  key: string
): SecretExpressionVerdict {
  interface Frame {
    stack: string;
    key: string;
    /** Stacks crossed to reach this frame, nearest first. Empty at the root. */
    via: readonly string[];
  }
  const seen = new Set<string>([`${producerStack}\u0000${key}`]);
  const queue: Frame[] = [{ stack: producerStack, key, via: [] }];
  // Set by the ROOT frame only (BFS visits it first), and read by every later
  // frame: a widened root can only ever justify the widened claim, however
  // precise the hop that finally found the expression was.
  let widened = false;
  while (queue.length > 0) {
    const frame = queue.shift();
    if (!frame) break;
    const template = templates.get(frame.stack);
    if (!template) continue;
    const outputs = (template.Outputs ?? {}) as Record<
      string,
      { Value?: unknown; Export?: { Name?: unknown } }
    >;
    const matched: unknown[] = [];
    for (const [name, output] of Object.entries(outputs)) {
      const exportName = output?.Export?.Name;
      if (name === frame.key || (typeof exportName === 'string' && exportName === frame.key)) {
        matched.push(output?.Value);
      }
    }
    const isRoot = frame.via.length === 0;
    let subjects: unknown[];
    if (matched.length > 0) {
      subjects = matched;
    } else if (isRoot) {
      widened = true;
      subjects = Object.values(outputs).map((o) => o?.Value);
    } else {
      // A hop that matched nothing: see WIDENING IS ROOT-ONLY above.
      continue;
    }
    for (const rawSubject of subjects) {
      // THE ONE SELECTION SITE (issue #2150), feeding BOTH halves of the
      // question below — the literal scan and the hop walk. See
      // {@link selectTakenConditionalBranches} for why an `Fn::If`'s untaken arm
      // must not answer either, and for the residual that accepts.
      const subject = selectTakenConditionalBranches(rawSubject);
      if (JSON.stringify(subject ?? null).includes('{{resolve:')) {
        // `via` is carried on the WIDENED verdict too (issue #2146 review).
        // Dropping it made the message assert the producer "publishes at least
        // one output from a {{resolve:...}} expression" in the one case the
        // walk had just proven otherwise, and cut the remedy back to the single
        // command the chain remedy exists to replace.
        if (widened) return { kind: 'widened', via: frame.via };
        return isRoot ? { kind: 'declared', via: [] } : { kind: 'chained', via: frame.via };
      }
      for (const hop of collectReExportHops(subject, templates, exportOwners)) {
        const id = `${hop.stack}\u0000${hop.key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push({ stack: hop.stack, key: hop.key, via: [...frame.via, hop.stack] });
      }
    }
  }
  return NO_SECRET_EXPRESSION;
}

/**
 * One node with every `Fn::If` collapsed to the branch scrub would TAKE
 * (issues #2146 and [#2150](https://github.com/go-to-k/cdkd/issues/2150)).
 *
 * ONE SPELLING, consumed verbatim by both halves of "does this producer publish
 * a secret expression?" — {@link collectReExportHops}, which follows the value
 * onward, and {@link producerPublishesSecretExpression}'s literal
 * `{{resolve:` scan, which tests the value itself. Those two are one question
 * asked twice, and they DISAGREED between #2146 and #2150: the hop walk took
 * the false branch while the scan `JSON.stringify`d the whole node and saw
 * both. A producer whose output is
 * `{"Fn::If": ["IsProd", "{{resolve:...}}", "plain"]}` deployed with `IsProd`
 * false therefore verdicted `declared`, the discriminator read the deployed
 * value `plain`, and scrub refused with `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT`
 * — an UNCLEARABLE refusal, because no `cdkd scrub` of the producer can turn
 * `plain` into an expression and there is no bypass flag, so every other secret
 * in the consumer stack was stranded. A second spelling of the selection would
 * only move where the two can drift apart again, so there is exactly one.
 *
 * WHICH BRANCH: the FALSE one, unconditionally, mirroring `resolveIf`'s
 * unknown-condition arm. Every condition met on this path belongs to ANOTHER
 * stack, and scrub evaluates conditions only for the stack it is scrubbing,
 * from that template's parameter DEFAULTS (it takes no `--parameters`), so a
 * producer's condition is not evaluable here.
 *
 * TWO SHAPES COLLAPSE MORE THAN THE SELECTED BRANCH, both fail-OPEN, both
 * stated rather than implied because the old whole-node `JSON.stringify` saw
 * them and this does not. Neither is CloudFormation-emittable, which is why
 * they are accepted rather than fixed:
 *
 * - a MALFORMED `Fn::If` (args not a 3-tuple) collapses to `null` -- NO branch.
 *   Which branch is live is unknowable, so neither a hop nor a `{{resolve:`
 *   sighting may be claimed from it. CloudFormation refuses such a template, so
 *   a producer that reads this way cannot have been deployed carrying one.
 * - an object carrying `Fn::If` ALONGSIDE sibling keys keeps only the selected
 *   branch, so a `{{resolve:` under a sibling is not seen. An intrinsic node has
 *   exactly one key in any template CloudFormation accepts, and the hop walk
 *   dropped those siblings before this function existed (its `Fn::If` arm
 *   `return`ed rather than falling through), so this preserves that behaviour
 *   rather than introducing it.
 *
 * Residual, and it is the direction this file accepts elsewhere: a secret
 * reachable only through the TRUE branch is not detected, so that reference
 * keeps its pre-#2133 outcome. The hop walk already took this trade for the
 * chain it follows; #2150 extends it to the scan so that the two agree.
 */
function selectTakenConditionalBranches(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(selectTakenConditionalBranches);
  if (node === null || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  if ('Fn::If' in obj) {
    const args = obj['Fn::If'];
    return Array.isArray(args) && args.length === 3
      ? selectTakenConditionalBranches(args[2])
      : null;
  }
  // `Object.create(null)`, the same `__proto__` hazard `pinCrossRegionSecrets`,
  // `redactByPath` and `reresolveCrossStackValue` answer this way: a JSON-parsed
  // template can carry an OWN `__proto__` key, and assigning it onto an object
  // LITERAL walks the prototype setter instead of defining the key -- so the
  // key, and any `{{resolve:` under it, would vanish from the pruned copy and
  // both consumers would go blind on that subtree. Fail-OPEN, which is the
  // direction that matters: the verdict comes back `no` and the producer looks
  // plaintext-free.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(obj)) out[key] = selectTakenConditionalBranches(child);
  return out;
}

/** One step of a re-export chain: whose template to read next, under which key. */
interface ReExportHop {
  stack: string;
  key: string;
}

/**
 * The re-export hops one output VALUE carries (issue #2146).
 *
 * Only STATICALLY resolvable references produce a hop, mirroring
 * {@link inferCrossStackStackDeps}: an `Fn::ImportValue` of a literal export
 * name (looked up in `exportOwners`) and an `Fn::GetStackOutput` whose
 * `StackName` and `OutputName` are both literal strings and whose stack is one
 * of this app's. An assembled name resolves to a hop the walk cannot follow,
 * which keeps the pre-#2146 outcome for that value rather than guessing.
 *
 * EVERY owner of a duplicated export name is returned, not the first (issue
 * #2146 review). See {@link buildExportOwnerIndex}: picking one silently
 * decides the verdict on insertion order, and the visited set makes following
 * all of them cheap and terminating.
 *
 * The WHOLE node is walked, not just its top level, because a re-export is
 * routinely wrapped — `Fn::Join`ing an imported password into a URL is the
 * shape the live fixture uses.
 *
 * `Fn::If` NEVER REACHES THIS WALK, and the selection that used to live here
 * is load-bearing rather than tidy (issue #2146 review). `makeCrossStackPrePass`
 * deliberately mirrors
 * `resolveIf` — selected branch only — so that a conditional import of a
 * not-yet-deployed producer cannot refuse a whole stack, unbypassably, over a
 * reference the deploy never read. A hop walk that descended into both arms
 * broke that mirror and produced something worse: a producer whose output is
 * `{"Fn::If": ["IsProd", {"Fn::ImportValue": "ProdSecret"}, {"Fn::ImportValue":
 * "DevPlain"}]}`, deployed in dev with a benign stored value, yielded a
 * `chained` verdict and a refusal NO `cdkd scrub` can clear — nothing can turn
 * that producer's non-secret value into an expression, and there is no bypass
 * flag. On main the same input answered `no`, so it would have been a
 * regression this change introduced.
 *
 * `selectedValue` IS THE CONTRACT, and it is why this function carries no
 * `Fn::If` handling of its own: the only caller,
 * {@link producerPublishesSecretExpression}, applies
 * {@link selectTakenConditionalBranches} ONCE and hands the result to BOTH the
 * literal `{{resolve:` scan and this walk, so a node reaching here holds no
 * `Fn::If` at all. Issue [#2150](https://github.com/go-to-k/cdkd/issues/2150)
 * collapsed the two to one site deliberately: the scan used to `JSON.stringify`
 * the whole subject and therefore see BOTH arms while this walk took only the
 * false one, and two spellings of one question are exactly how they came to
 * disagree. A second selection HERE would restore that, and be worse than
 * useless — measured on the #2150 lane, a per-site copy was invisible to every
 * test in the suite, because the caller had already pruned, so deleting it
 * changed nothing and no probe could fence it.
 * {@link selectTakenConditionalBranches}'s own doc carries which branch is
 * selected, what a malformed `Fn::If` yields, and the TRUE-branch residual both
 * halves accept.
 */
function collectReExportHops(
  selectedValue: unknown,
  templates: ReadonlyMap<string, CloudFormationTemplate>,
  exportOwners: ReadonlyMap<string, readonly string[]>
): ReExportHop[] {
  const hops: ReExportHop[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const imported = obj['Fn::ImportValue'];
    if (typeof imported === 'string') {
      for (const owner of exportOwners.get(imported) ?? []) {
        hops.push({ stack: owner, key: imported });
      }
    }
    const read = obj['Fn::GetStackOutput'];
    if (read !== null && typeof read === 'object' && !Array.isArray(read)) {
      const args = read as Record<string, unknown>;
      const stack = args['StackName'];
      const outputName = args['OutputName'];
      if (typeof stack === 'string' && typeof outputName === 'string' && templates.has(stack)) {
        hops.push({ stack, key: outputName });
      }
    }
    for (const child of Object.values(obj)) walk(child);
  };
  walk(selectedValue);
  return hops;
}

/**
 * `Export.Name` -> EVERY app stack that declares it (issue #2146), for literal
 * export names only. Built ONCE per stack scrub rather than per reference,
 * since {@link producerPublishesSecretExpression} needs it on every cross-stack
 * read the pre-pass performs.
 *
 * ALL OWNERS, not the first (issue #2146 review). `inferCrossStackStackDeps`
 * keeps one because it is choosing a deploy EDGE and either choice orders the
 * graph; this index decides whether a value is SECRET-BEARING, where following
 * the wrong twin returns `no` and reports a stack clean over surviving
 * plaintext. Two stacks declaring one export name is an AWS-side error, but
 * scrub reads TEMPLATES — an app that has never been deployed, or one deployed
 * to two regions, presents it routinely — so there IS a better answer than the
 * first writer: take the over-approximation and follow both. The visited set
 * bounds the cost and guarantees termination either way.
 *
 * Keyed by stack NAME with no region, which is the residual
 * {@link producerPublishesSecretExpression} lists: an `Fn::GetStackOutput`
 * naming this app's stack in another region reads the template of the name,
 * since `producerTemplates` has no region either.
 */
export function buildExportOwnerIndex(
  templates: ReadonlyMap<string, CloudFormationTemplate>
): ReadonlyMap<string, readonly string[]> {
  const owners = new Map<string, string[]>();
  for (const [stackName, template] of templates) {
    const outputs = (template.Outputs ?? {}) as Record<string, { Export?: { Name?: unknown } }>;
    for (const output of Object.values(outputs)) {
      const name = output?.Export?.Name;
      if (typeof name !== 'string' || name === '') continue;
      const existing = owners.get(name);
      if (existing) {
        if (!existing.includes(stackName)) existing.push(stackName);
      } else {
        owners.set(name, [stackName]);
      }
    }
  }
  return owners;
}

/** What one stack's cross-stack pre-pass recorded that is not a refusal. */
interface CrossStackPrePassFindings {
  /**
   * References cdkd DECLINED to resolve BY DESIGN (issue #2133 review) — today
   * only the cross-account `Fn::GetStackOutput` of a redacted value, which
   * `resolveGetStackOutput` refuses so a producer account's secret is never
   * looked up with the consumer's credentials. Reported as a FINDING rather
   * than a stack refusal: see {@link makeCrossStackPrePass}.
   */
  unverifiable: string[];
}

/**
 * Is this the issue #2134 refusal -- a `{{resolve:...}}` reference whose region
 * cdkd cannot establish?
 *
 * WHY IT IS NOT BEST-EFFORT, which is the whole reason this predicate exists.
 * `scrubStack` wraps each resolution pass in a `catch { logger.debug }` so one
 * unresolvable resource does not abandon the rest of the scrub. Every other
 * error reaching those catches means "this resource resolved partially, carry
 * on". This one means cdkd could not tell which region owns a secret reference,
 * so NO NEEDLE was recorded for it and the plaintext is still in `state.json` --
 * and swallowed, the command then reports `No plaintext secrets found` and
 * exits 0 over exactly the state it exists to clean. That is why the pre-pass
 * refusals are placed OUTSIDE those catches; this one is raised from inside
 * `resolveDynamicReferences`, so it cannot be placed and has to be re-raised.
 *
 * By CAUSE CHAIN rather than a bare `instanceof`, for the reason
 * {@link isByDesignRefusal} states: the refusal reaches those catches through
 * `resolver.resolve`, which wraps in several places, so a top-link-only test
 * silently swallows a wrapped one.
 *
 * TWO SITES IN THIS CALL GRAPH STILL SWALLOW IT, named rather than left to be
 * rediscovered (issue #2134 review round 2):
 *
 * - `evaluateConditions` (`intrinsic-function-resolver.ts`) warns and degrades
 *   the condition to `false`. Accepted for now: a condition evaluates to a
 *   boolean and carries no secret INTO state, and this file's own note above
 *   `resolveCrossStackReads` records why the conditions pass is deliberately
 *   not refusal-armed -- it runs BEFORE scrub knows which branch the deploy
 *   took, so refusing there can reject a whole stack over a branch never taken.
 *   The residual is that the FALSE branch is then selected, which that note
 *   already states.
 * - the `!nodeCanRefuse` arm of the cross-stack pre-pass, which debugs and
 *   returns. Defensible: a SUPPRESSED output writes no state key, so there is
 *   no persisted plaintext for a missing needle to leave behind.
 */
/**
 * A secrets map with its OWN identity whose entries ARE `target`'s (issue
 * #2531): every read and write goes to `target`; nothing is stored here.
 *
 * The outputs pass resolves each `Export.Name` through one of these rather
 * than through the pass map itself. The resolver records the uncollapsed
 * `expression -> plaintext` PAIR beside each entry, keyed by the map INSTANCE
 * (`recordResolvedPair`), and a second write of one expression with a
 * different plaintext marks that pair conflicting — so a name's resolution
 * recording straight into the pass map could conflict the pair a literal
 * Output embedding the same token needs. Pairs recorded through this view
 * hang off THIS instance and are discarded with it (a name never positions a
 * leaf); the entries are the pass map's, live, in both directions. The
 * cross-stack associations the pre-pass records (`recordCrossStackExpression`)
 * are keyed by instance the same way and die with the view too — consistent
 * with the pairs: a value leaf re-resolves and records its own.
 *
 * Live sharing rather than a private map with a copy: the resolver records
 * as it goes and `Fn::Join` resolves its parts concurrently, so a part that
 * rejects while a secret part is still pending ends the name's block before
 * that part records — a copy at the end of the block misses the late entry,
 * and a private map SEEDED from the pass map is a snapshot that a LATER
 * name's resolution would not see the late entry through either. Every
 * reader in the block (the cross-region pin, the cross-stack pre-pass, the
 * resolver, the masking of their messages) needs exactly what the pass map
 * holds at the moment it reads, which is what a view gives.
 */
class SharedEntriesSecrets extends Map<string, string> {
  private readonly target: RecordedSecretValues;

  constructor(target: RecordedSecretValues) {
    super();
    this.target = target;
  }

  override get size(): number {
    return this.target.size;
  }

  override get(plaintext: string): string | undefined {
    return this.target.get(plaintext);
  }

  override has(plaintext: string): boolean {
    return this.target.has(plaintext);
  }

  override set(plaintext: string, expression: string): this {
    this.target.set(plaintext, expression);
    return this;
  }

  override delete(plaintext: string): boolean {
    return this.target.delete(plaintext);
  }

  override clear(): void {
    this.target.clear();
  }

  override keys(): MapIterator<string> {
    return this.target.keys();
  }

  override values(): MapIterator<string> {
    return this.target.values();
  }

  override entries(): MapIterator<[string, string]> {
    return this.target.entries();
  }

  override forEach(
    callback: (value: string, key: string, map: Map<string, string>) => void,
    thisArg?: unknown
  ): void {
    this.target.forEach((value, key) => callback.call(thisArg, value, key, this));
  }

  override [Symbol.iterator](): MapIterator<[string, string]> {
    return this.target[Symbol.iterator]();
  }
}

function isRegionAmbiguousRefusal(err: unknown): boolean {
  return (
    err instanceof Error &&
    errorCauseChain(err).some((link) => link instanceof DynamicReferenceRegionAmbiguousError)
  );
}

/**
 * Build the CROSS-STACK pre-pass for ONE stack's scrub (issue
 * [#2133](https://github.com/go-to-k/cdkd/issues/2133)).
 *
 * WHY THIS RUNS AT ALL, given the wiring in `scrubStack` already lets the main
 * resolution perform these reads. The wiring is what makes an
 * `Fn::ImportValue`-sourced secret RESOLVE; this pass is what makes a FAILED
 * one LOUD, and what catches a SUCCEEDING one that produced no needle. A
 * cross-stack read that throws inside `resolver.resolve` lands in the caller's
 * best-effort `catch { logger.debug(...) }`, and that catch cannot tell "a
 * `Ref` to a resource that is not in state" — which it exists for — from "the
 * producer's state could not be read", which silently costs the command its
 * needle. Lifting the second class OUT of the catch is the same placement issue
 * #2109 uses for its own refusals, and it keeps the catch doing its job:
 * everything it still swallows is now provably NOT a cross-stack read.
 *
 * THREE OUTCOMES per reference, and the split is the whole design:
 * - the read FAILS for a reason a user can fix (producer not deployed, wrong
 *   reference, an `AccessDenied` on the producer's state or on
 *   `cloudformation:ListExports`, an unassumable `RoleArn`) — REFUSE the stack.
 *   A re-run after the fix scrubs it, so refusing costs reachability only until
 *   the cause is addressed.
 * - the read is DECLINED BY DESIGN (`CrossAccountSecretRefusalError`) — record
 *   an UNVERIFIABLE finding, scrub the rest of the stack, and let the run exit
 *   non-zero. No user action can make that read succeed, so refusing the whole
 *   stack would strand every OTHER secret in it forever — a reachability
 *   regression against the pre-#2133 best-effort behaviour, in the command that
 *   exists to remediate. This is the `secretBearingKeys` treatment (issue
 *   #1919), applied to the same shape of finding: real, reported, unremediable.
 *   The match is on that SUBCLASS, never on `IntrinsicResolutionRefusalError`:
 *   five of its six throw sites are USER-FIXABLE and are reachable from here
 *   whenever a cross-stack node's ARGUMENT is an `Fn::Sub` / `Fn::GetAtt` /
 *   `Fn::Split` (`resolveSub` re-raises the class), so matching the base class
 *   downgraded a fixable refusal to a finding and let scrub print
 *   `No plaintext secrets found` and exit 0 over surviving plaintext.
 * - the read SUCCEEDS but the PRODUCER's own state record still holds the
 *   plaintext, for an export the producer's template declares from a
 *   `{{resolve:...}}` expression — REFUSE, see
 *   {@link plaintextProducerCrossStackReadError}.
 *
 * Each node is resolved on its OWN — `{ [key]: node[key] }` rather than the
 * enclosing object — so a bag carrying an unrelated sibling key cannot make
 * this pass resolve something else, and so a failure names the cross-stack read
 * rather than whatever the whole node resolves to. Which key of a multi-key
 * node is even eligible is decided by {@link RESOLVER_INTRINSIC_PRECEDENCE},
 * mirroring the resolver — so for the CHOICE OF KEY the pass never reads
 * through an intrinsic the main resolution would ignore.
 *
 * That is the whole of the invariant, and it is deliberately narrower than
 * "this pass performs no read the main resolution would not" (issue #2133
 * review — the earlier, overstated wording). `resolveValue` walks a plain
 * object's properties SEQUENTIALLY and aborts the whole bag at the first one
 * that throws, and it THROWS on an unknown intrinsic (`Fn::ToJsonString`,
 * `Fn::ForEach`) before descending into its argument at all; this pass resolves
 * each node on its own and keeps walking in both cases. So it can read a
 * reference the main resolution never reaches — after a sibling `Ref` to a
 * resource absent from state, which is the routine case, or beneath an
 * intrinsic cdkd cannot resolve. The DIRECTION is safe (the deploy made those
 * reads, so refusing over one names a real unscrubbed producer rather than a
 * fabricated one) but the sentence is load-bearing for the refusal, so it is
 * stated as what it is rather than as the stronger claim.
 *
 * The bag is NOT rewritten. The main resolution re-resolves these references
 * itself, and the S3 reads behind them are shared with this pass by the
 * memoizing backend view `scrubStack` builds (issue #2133 review — before that
 * every reference cost `listStacks()` plus up to N `getState()` TWICE). What
 * not rewriting buys back is the whole class of hazard a substituted value
 * carries: a resolved cross-stack value that is itself intrinsic- or
 * reference-shaped would be re-interpreted by the stack's own resolver, which
 * is the shape `SCRUB_SECRET_RESOLUTION_REINTRODUCED_TOKEN` guards against one
 * class over. The needles this records survive the main resolution failing for
 * an unrelated reason, since `recordedSecretValues` is filled in place.
 *
 * `Fn::If` is walked the way {@link IntrinsicFunctionResolver} walks it — the
 * SELECTED branch only, with an unknown condition selecting the FALSE branch,
 * mirroring `resolveIf`. Reading a reference the main resolution would never
 * touch would refuse a stack over a conditional import the deploy never made.
 * A MALFORMED `Fn::If` (args not a 3-tuple) is walked with refusals DISARMED
 * rather than skipped: which branch is live is unknowable, so a read inside it
 * may be one the deploy never made — the exact hazard the selected-branch
 * mirror exists to prevent — but any needle it does yield is still worth having.
 */
function makeCrossStackPrePass(deps: {
  stackName: string;
  resolver: IntrinsicFunctionResolver;
  producerTemplates: ReadonlyMap<string, CloudFormationTemplate>;
  findings: CrossStackPrePassFindings;
  logger: ReturnType<typeof getLogger>;
}): (
  bag: unknown,
  context: ResolverContext,
  origin: string,
  opts?: { canRefuse?: boolean }
) => Promise<void> {
  const { stackName, resolver, producerTemplates, findings, logger } = deps;
  // Built once per stack scrub: every cross-stack read this pass performs asks
  // the same question of the same set of templates (issue #2146).
  const exportOwners = buildExportOwnerIndex(producerTemplates);
  // ...and the ANSWER is memoized per (producer, key) too (issue #2146 review).
  // The walk is pure in `producerTemplates` / `exportOwners`, which do not
  // change during one stack's scrub, while `readOne` runs once per REFERENCE
  // OCCURRENCE — so a template importing one export at ten leaves re-walked the
  // reachable space and `JSON.stringify`d every output of a widened root ten
  // times.
  const verdicts = new Map<string, SecretExpressionVerdict>();
  const secretExpressionVerdict = (stack: string, key: string): SecretExpressionVerdict => {
    const id = `${stack}\u0000${key}`;
    let verdict = verdicts.get(id);
    if (!verdict) {
      verdict = producerPublishesSecretExpression(producerTemplates, exportOwners, stack, key);
      verdicts.set(id, verdict);
    }
    return verdict;
  };

  /**
   * Is this a refusal NO RE-RUN can clear (issue #2133 review)?
   *
   * The predicate is the SUBCLASS, not `IntrinsicResolutionRefusalError`. That
   * class has six throw sites and only ONE — `resolveGetStackOutput`'s
   * cross-account arm — is permanent; the other five (a stale placeholder ARN,
   * a fabricated account id, an unenriched `Fn::GetAtt`, `--strict-getatt`, a
   * malformed `Fn::Split`) are all fixed by editing the template or deploying
   * the producer. They are REACHABLE here, because `resolveSub` re-raises the
   * class, so any cross-stack node whose ARGUMENT is an `Fn::Sub` /
   * `Fn::GetAtt` / `Fn::Split` can carry one up to this catch. Matching the
   * base class downgraded every one of them to a finding logged as "cdkd
   * declines this read by design, so no re-run can change it" — false — and
   * scrub then printed `No plaintext secrets found` and exited 0 without
   * `--fail` while the consumer's state.json still held the imported plaintext.
   *
   * The CAUSE CHAIN rather than a bare `instanceof`: the refusal reaches this
   * catch through `resolver.resolve`, which wraps in several places, and a
   * top-link-only test silently reclassifies a wrapped permanent refusal as
   * user-fixable — i.e. refuses the whole stack over something no user can fix.
   */
  const isByDesignRefusal = (err: unknown): boolean =>
    err instanceof Error &&
    errorCauseChain(err).some((link) => link instanceof CrossAccountSecretRefusalError);

  return async function resolveCrossStackReads(bag, context, origin, opts): Promise<void> {
    const canRefuse = opts?.canRefuse ?? true;
    // The needle set this pass MASKS its messages against. It is no longer part
    // of any verdict (issue #2133 review replaced the needle-count
    // discriminator with a direct read of the producer's stored value), so the
    // `?? new Map()` fallback now means "nothing to mask against" rather than
    // "every read refuses".
    const secrets = context.recordedSecretValues ?? new Map<string, string>();

    /**
     * The producer this reference actually resolved through, and the KEY it
     * matched — read back out of the resolver's own recording bags.
     *
     * Keyed on the intrinsic UNDER TEST rather than "imports first, then output
     * reads": `resolveImportValue` / `resolveGetStackOutput` each resolve their
     * ARGUMENTS before recording their own read, so a nested cross-stack read
     * inside the argument lands in the OTHER family's bag (or earlier in the
     * same one). Preferring imports unconditionally made an
     * `Fn::GetStackOutput` whose `StackName` contains an `Fn::ImportValue`
     * report the INNER producer.
     *
     * `.at(-1)` for the same reason within one family: the outer read is
     * recorded LAST, after its argument has resolved.
     *
     * An empty bag means the value did NOT come from a cdkd state record, and
     * the two arms that produce one are NOT unreadable for the same reason
     * (issue #2133 review — one rationale used to cover both, and it was false
     * of the second):
     *
     * - the CloudFormation `ListExports` / `DescribeStacks` FALLBACKS record
     *   nothing deliberately, a CFn-managed producer being a weak reference.
     *   Here "no expression to restore" is literally true: the value came from
     *   CloudFormation, which cdkd never redacted, so no `{{resolve:...}}`
     *   expression exists anywhere for scrub to write in its place.
     * - the CROSS-ACCOUNT `Fn::GetStackOutput` arm records nothing for a
     *   different reason, and a post-#1934 producer in the other account DOES
     *   store the expression — which is precisely why
     *   `CrossAccountSecretRefusalError` exists, and why it fires BEFORE this
     *   point whenever the stored value carries one. What can reach here is a
     *   value that carried none, and scrub cannot classify it any further: the
     *   producer's `state.json` lives in another account and the only
     *   credentials in hand are the consumer's, so reading it is the
     *   wrong-account lookup that refusal exists to prevent.
     *
     * The OUTCOME is the same today either way — a cross-account producer is
     * never in `appStacks`, so the `producerTemplates.has(...)` return below
     * fires first regardless — but a future change that widened `producerTemplates` would
     * be relying on this sentence, so it must not claim the second arm has no
     * expression behind it.
     *
     * Residual: an OUTER read that fell through to a CloudFormation fallback
     * while its ARGUMENT performed a same-family cdkd read leaves the inner
     * entry last, so the check below consults the wrong producer. Bounded by
     * the key test — the inner key must also exist in the inner producer's
     * outputs, which it does — and it can only produce a false REFUSAL naming a
     * real unscrubbed producer, never a false clean.
     */
    const recordedProducer = (
      key: string,
      probe: ResolverContext
    ): { stack: string; region: string; key: string } | undefined => {
      if (key === 'Fn::GetStackOutput') {
        const read = probe.recordedOutputReads?.at(-1);
        return read
          ? { stack: read.sourceStack, region: read.sourceRegion, key: read.outputName }
          : undefined;
      }
      const imported = probe.recordedImports?.at(-1);
      return imported
        ? { stack: imported.sourceStack, region: imported.sourceRegion, key: imported.exportName }
        : undefined;
    };

    /**
     * The producer's STORED value for `key` — what its `state.json` actually
     * holds, as opposed to what the read RETURNED.
     *
     * `undefined` when the producer's record cannot be read or does not carry
     * the key, which is treated as "cannot classify" by the caller rather than
     * as evidence of anything. Both are near-unreachable on the arms that get
     * here (the read just succeeded against that record, through the SAME
     * memoized `getState` promise this call resolves), so the read costs no
     * extra AWS call.
     */
    const storedProducerValue = async (
      producer: { stack: string; region: string; key: string },
      backend: ResolverContext['stateBackend']
    ): Promise<{ stored: unknown } | undefined> => {
      if (!backend) return undefined;
      let loaded: Awaited<ReturnType<NonNullable<ResolverContext['stateBackend']>['getState']>>;
      try {
        loaded = await backend.getState(producer.stack, producer.region);
      } catch (err) {
        logger.debug(
          `Scrub of ${stackName}: could not re-read producer ` +
            `'${maskSecretsInText(producer.stack, secrets)}' ` +
            `(${producer.region}) to classify its stored value: ` +
            `${maskSecretsInText(err instanceof Error ? err.message : String(err), secrets)}`
        );
        return undefined;
      }
      const outputs = loaded?.state?.outputs;
      if (!outputs || !(producer.key in outputs)) return undefined;
      return { stored: outputs[producer.key] };
    };

    const readOne = async (
      key: string,
      node: Record<string, unknown>,
      path: string,
      nodeCanRefuse: boolean
    ): Promise<void> => {
      // A FRESH pair of recording bags per read, so the producer this
      // particular reference resolved through is readable back out. They are
      // the resolver's own bookkeeping (`recordImport` / `recordOutputRead`),
      // not scrub's, and scrub persists neither — it only asks WHO answered.
      const probe: ResolverContext = {
        ...context,
        recordedImports: [],
        recordedOutputReads: [],
      };
      // WHERE THE READ IS, spelled once and hoisted above the `try` so all
      // nine log/finding sites below share one spelling (issue #2163 review --
      // the first cut hoisted it only past the `catch`, leaving four re-spelled
      // copies of the identical expression behind).
      const where = `${key} in ${origin}${path ? ` at ${path}` : ''}`;
      try {
        await resolver.resolve({ [key]: node[key] }, probe);
      } catch (err) {
        // The `!nodeCanRefuse` test runs FIRST, ahead of the by-design branch
        // (issue #2133 review). A finding is a PERMANENT exit-1 for the run,
        // and the positions that carry `canRefuse: false` — a
        // condition-suppressed output, a malformed `Fn::If` — are exactly the
        // ones that wrote no `state.outputs` key and may name a read the deploy
        // never made. Recording a finding there produces a standing failure
        // over a reference with nothing at risk, which is what
        // {@link isOutputSuppressed} exists to spare.
        if (!nodeCanRefuse) {
          logger.debug(
            `Scrub of ${stackName}: ${where} could not be resolved, and this position ` +
              `cannot refuse: ${maskSecretsInText(
                err instanceof Error ? err.message : String(err),
                secrets
              )}`
          );
          return;
        }
        if (isByDesignRefusal(err)) {
          const detail = `${where}: ${maskSecretsInText(
            err instanceof Error ? err.message : String(err),
            secrets
          )}`;
          findings.unverifiable.push(detail);
          logger.warn(
            `Scrub of ${stackName} cannot verify ${detail} — cdkd declines this read by design, ` +
              `so no re-run can change it. The rest of the stack is still scrubbed; this stack ` +
              `is NOT reported clean.`
          );
          return;
        }
        throw unresolvableCrossStackReadError(origin, stackName, key, path, err, secrets);
      }
      // FIVE declining arms used to return in silence -- issue #2163 named
      // three of them and reasoned from "every arm that classifies and then
      // declines logs a debug line" that the failing live run must have taken
      // one of those three. That premise was false for the other two, which is
      // why isolating #2163 cost four real-AWS runs and still did not settle
      // which one fired. All five name themselves below.
      const producer = recordedProducer(key, probe);
      if (!producer) {
        logger.debug(
          `Scrub of ${stackName}: ${where} resolved, but the resolver recorded no cdkd ` +
            `cross-stack read for it — the value came from a CloudFormation fallback or a ` +
            `cross-account arm that records nothing, so scrub cannot name a producer to ` +
            `classify. Not classified as a plaintext producer.`
        );
        return;
      }
      // MASKED, for the reason {@link plaintextProducerCrossStackReadError} already
      // gives for the REFUSAL that shares these two identifiers, and it applies
      // with more force here: a `logger.debug` line has no boundary net at all,
      // where the refusal at least passes through `maskSecretsInError` at
      // `scrubStack`'s edge.
      //
      // `producer.key` is the REACHABLE half: it is `recordedImports.at(-1)
      // .exportName` / `recordedOutputReads.at(-1).outputName`, i.e. the
      // POST-resolution name, and `resolveImportValue` sets it from
      // `resolveValue(importValueArg)` -- so an `Fn::ImportValue` over an
      // `Fn::Sub` / `Fn::Join` / bare string assembling a `{{resolve:...}}`
      // makes it a resolved secret verbatim. The needle is present by then:
      // `probe` shares this function's `secrets` map object (it spreads
      // `context`), the resolver fills that map IN PLACE, and the
      // `resolver.resolve` call above is what performs the resolution.
      // `maskSecretsInError` would not cover it anyway -- `allRecordedSecrets`
      // DROPS every needle below `MIN_NEEDLE_LENGTH`, while the whole-value arm
      // of `maskSecretsInText` matches at any length.
      //
      // `producer.stack` is masked because it is REACHABLE too — not merely
      // for uniformity, which is what an earlier revision of this comment
      // claimed. That claim held for ONE of the two arms `recordedProducer`
      // reads. `Fn::ImportValue` takes the producer name from the state-bucket
      // listing, so it really is a state record's own stack name.
      // `Fn::GetStackOutput` RESOLVES it first:
      // `recordOutputRead(context, stackName, ...)` is fed
      // `await this.resolveValue(args['StackName'], context)`, so an
      // `Fn::Sub` / `Fn::Join` assembling a `{{resolve:...}}` into `StackName`
      // makes `producer.stack` a resolved secret exactly the way
      // `producer.key` can be.
      //
      // Nothing leaks today — both are masked at every site below. The
      // RATIONALE was the defect, and a wrong one is worse than none: "never a
      // resolved value" reads as licence to drop the mask.
      //
      // `producer.region` is the one that genuinely cannot carry a secret, and
      // it is interpolated raw for that reason. `Fn::GetStackOutput` gates its
      // region through `isClientSafeRegion` (`/^[a-z0-9][a-z0-9-]{0,30}$/`,
      // which no `{{resolve:...}}` token can satisfy) and THROWS rather than
      // falling back; `Fn::ImportValue` takes it from the same state-bucket
      // listing the stack name comes from.
      const loggedKey = maskSecretsInText(producer.key, secrets);
      const loggedStack = maskSecretsInText(producer.stack, secrets);
      // The producer is not a stack of this app, so scrub has no template to
      // classify the export with — and no chain to follow out of it either.
      // Documented residual — see {@link producerPublishesSecretExpression}.
      if (!producerTemplates.has(producer.stack)) {
        logger.debug(
          `Scrub of ${stackName}: ${where} resolved through producer '${loggedStack}' ` +
            `(${producer.region}), which is not a stack of this app — scrub has no template to ` +
            `classify export '${loggedKey}' with. Not classified as a plaintext producer.`
        );
        return;
      }
      const verdict = secretExpressionVerdict(producer.stack, producer.key);
      if (verdict.kind === 'no') {
        logger.debug(
          `Scrub of ${stackName}: ${where} resolved through producer '${loggedStack}', whose ` +
            `template declares no {{resolve:...}} expression for '${loggedKey}' and no ` +
            `re-export chain reaching one. Not classified as a plaintext producer.`
        );
        return;
      }
      // THE DISCRIMINATOR: read the producer's STORED value and test IT.
      //
      // The RESOLVED value cannot answer this, and neither can the template.
      // `reresolveCrossStackValue` RESOLVES a stored expression to plaintext
      // before returning it (issue #1934's whole point), so the healthy case
      // (producer scrubbed, state holds the expression) and the broken one
      // (producer unscrubbed, state holds the plaintext) BOTH arrive here with
      // a plaintext in hand and both satisfy the template test. Three earlier
      // cuts each tried to INFER the difference from the consumer's side and
      // each was wrong in a different way: `carriesDynamicReference(resolved)`
      // was inverted, the template test was true of both, and the needle-count
      // test was wrong in BOTH directions — a COMPOSITE export keys the needle
      // by the embedded SUBSTRING while `resolved` is the whole URI (so
      // `secrets.has(resolved)` is false and a repeat reference refused a
      // healthy producer), a NON-STRING resolved value could not be tested at
      // all, and a needle recorded while resolving the reference's own ARGUMENT
      // satisfied the count and suppressed a refusal that should have fired.
      //
      // Since round 1 wired `stateBackend` into these contexts, the proposition
      // can be OBSERVED instead of inferred: the producer's stored value either
      // carries a `{{resolve:` expression or it does not. That is exact for a
      // composite value, for a non-string one, for the second reference to one
      // export, and for an argument that records needles of its own — and it
      // costs no extra AWS call, since the read below hits the same memoized
      // `getState` promise the resolution just used.
      //
      // This SUBSUMES the old `carriesDynamicReference(resolved)` fast path:
      // resolution never introduces an expression, so a resolved value carrying
      // one (a spelling cdkd resolves for nobody — since issue #2482 that is
      // no CloudFormation service, only text that merely looks like one)
      // implies the stored value carries one too, and this arm returns for it.
      const stored = await storedProducerValue(producer, context.stateBackend);
      // No readable producer record, or no such key in it — cannot classify, so
      // do not refuse. DELIBERATELY UNFENCED, and measured rather than assumed:
      // making this arm throw leaves all 60 tests in
      // `scrub-import-value-secret.test.ts` green, because every arm that
      // reaches here just read that record through the SAME memoized `getState`
      // promise and matched that very key. The one route that could reach it is
      // a stale exports INDEX (whose entry carries a value the producer's state
      // no longer has), and `scrubStack` deliberately supplies no `exportIndex`
      // — so writing a test for it would mean fabricating a state scrub cannot
      // produce. Kept as the fail-open guard for a future caller that does.
      if (!stored) {
        logger.debug(
          `Scrub of ${stackName}: ${where} resolved through producer '${loggedStack}' ` +
            `(${producer.region}), whose state record could not be read or does not carry the ` +
            `key '${loggedKey}' — cannot classify, so this is not classified as a plaintext ` +
            `producer.`
        );
        return;
      }
      // The producer's state holds the EXPRESSION: it has been scrubbed, the
      // read handed this stack a resolvable secret, and there is nothing wrong.
      if (carriesDynamicReference(stored.stored)) {
        logger.debug(
          `Scrub of ${stackName}: ${where} resolved through producer '${loggedStack}', whose ` +
            `stored value for '${loggedKey}' already carries a {{resolve:...}} expression — ` +
            `the producer is scrubbed and there is nothing wrong with this read.`
        );
        return;
      }
      // ...and neither is it a plaintext when it carries no text at ALL (issue
      // #2133 review). `carriesDynamicReference` is false for `null`, `''` and
      // every non-string scalar, so under a `widened` verdict — where the
      // producer merely has SOME secret-bearing output and this key matched no
      // declared one — a stored `null` or `''` raised
      // `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT` claiming the read "resolved to a
      // PLAINTEXT value". That refusal is both false and UNCLEARABLE: scrubbing
      // the producer cannot turn an empty value into an expression, so the
      // re-run the message prescribes refuses identically forever.
      //
      // A resolved dynamic reference is always a STRING, so a non-string scalar
      // cannot be a legacy plaintext secret either, and an empty string holds
      // nothing to redact. Same fail-open shape as `!stored` above: cannot
      // classify, so do not refuse. CONTAINERS are deliberately NOT covered —
      // an array or object can nest a plaintext string, and `[]` / `{}` reach
      // this arm only through a producer that publishes an empty collection,
      // which no shape here can distinguish from a populated one worth testing.
      if (storedValueCarriesNoPlaintext(stored.stored)) {
        logger.debug(
          `Scrub of ${stackName}: ${where} resolved through producer '${loggedStack}', ` +
            `whose stored value for that key carries no ` +
            `text — nothing to redact, so this is not classified as a plaintext producer.`
        );
        return;
      }
      if (!nodeCanRefuse) {
        logger.debug(
          `Scrub of ${stackName}: ${where} resolved to a plaintext from unscrubbed ` +
            `producer '${loggedStack}', and this position cannot refuse.`
        );
        return;
      }
      throw plaintextProducerCrossStackReadError(
        origin,
        stackName,
        key,
        path,
        producer.stack,
        producer.key,
        verdict,
        secrets
      );
    };

    const walk = async (v: unknown, path: string, nodeCanRefuse: boolean): Promise<void> => {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) await walk(v[i], `${path}[${i}]`, nodeCanRefuse);
        return;
      }
      if (v === null || typeof v !== 'object') return;
      const node = v as Record<string, unknown>;
      const key = effectiveIntrinsicKey(node);
      if (key === undefined) {
        for (const [k, val] of Object.entries(node)) {
          await walk(val, path ? `${path}.${k}` : k, nodeCanRefuse);
        }
        return;
      }
      if (key === 'Fn::If') {
        const args = node['Fn::If'];
        if (Array.isArray(args) && args.length === 3) {
          const [conditionName, ifTrue, ifFalse] = args as [unknown, unknown, unknown];
          const selected =
            typeof conditionName === 'string' && context.conditions?.[conditionName] === true
              ? ifTrue
              : ifFalse;
          await walk(selected, `${path}['Fn::If']`, nodeCanRefuse);
          return;
        }
        // Malformed: walk the args with refusals DISARMED. Falling through to
        // the plain object walk (the first cut's behaviour) let an unreadable
        // import in the UNTAKEN branch refuse the stack — the exact hazard the
        // selected-branch mirror exists to prevent.
        await walk(args, `${path}['Fn::If']`, false);
        return;
      }
      if ((CROSS_STACK_INTRINSIC_KEYS as readonly string[]).includes(key)) {
        await readOne(key, node, path, nodeCanRefuse);
        return;
      }
      // Some OTHER intrinsic wins this node, so the resolver resolves that
      // one's ARGUMENT and never looks at a sibling key. Descend into the
      // argument only — a cross-stack read nested inside an `Fn::Join` list is
      // one the main resolution reaches, unlike a read under a sibling key it
      // never dispatches on. Reaching it is not the same as performing it: an
      // earlier element of that same `Fn::Join` list can throw and abort the
      // rest, per the narrowed invariant on {@link makeCrossStackPrePass}.
      await walk(node[key], `${path}['${key}']`, nodeCanRefuse);
    };

    await walk(bag, '', canRefuse);
  };
}

/** What one stack's scrub found. */
export interface ScrubStackResult {
  recordsChanged: number;
  secretsFound: number;
  secretBearingKeys: number;
  /**
   * Cross-stack references cdkd declined to resolve BY DESIGN (issue #2133
   * review). A FINDING, not a refusal: the stack is still scrubbed for
   * everything else, but it must not be reported clean, so the run exits
   * non-zero exactly as a `secretBearingKeys` finding does.
   */
  unverifiableReads: number;
}

/**
 * Scrub one stack's state. Re-resolves the template's per-resource properties to
 * learn the resolved secret VALUES, then replaces those values in the state
 * record with their `{{resolve:...}}` expressions. Returns counts; performs no
 * AWS mutation. Acquires the stack lock for the read-modify-write unless
 * `dryRun`.
 *
 * The stack OUTPUTS bag is scrubbed too, in two passes: today's declared
 * outputs are redacted BY POSITION against the template, and a stored key
 * today's template cannot account for is repaired by VALUE MATCH alone — see
 * {@link redactUnaccountedOutputs} for why the two are separate and what each
 * deliberately declines to do.
 */
export async function scrubStack(
  stack: StackInfo,
  region: string,
  stateBackend: S3StateBackend,
  lockManager: LockManager,
  opts: {
    dryRun: boolean;
    roleArn?: string | undefined;
    logger: ReturnType<typeof getLogger>;
    /**
     * Every stack of the synthesized app, NOT only this run's targets (issue
     * #2133 review). Used for ONE question: when a cross-stack read comes back
     * carrying no dynamic reference, does the PRODUCER's template declare that
     * export from a `{{resolve:...}}` expression — i.e. is the plaintext scrub
     * just received a secret whose expression the producer's own state has not
     * been scrubbed down to yet? See `producerPublishesSecretExpression`.
     * Optional so a caller that has no assembly in hand keeps the pre-#2133
     * outcome (no refusal) rather than failing.
     */
    appStacks?: readonly StackInfo[] | undefined;
  }
): Promise<ScrubStackResult> {
  const { logger } = opts;
  const acquired = !opts.dryRun;
  if (acquired) {
    await lockManager.acquireLockWithRetry(stack.stackName, region, undefined, 'scrub');
  }
  // PER-RESOURCE secrets (keyed by logicalId) + a separate outputs map, so a
  // whole-secret value from one resource cannot rewrite another's literal —
  // the cross-resource collision the deploy engine's `perResourceSecrets` doc
  // describes.
  //
  // Declared OUTSIDE the try so the catch below can mask against whatever was
  // recorded before the throw. Both are filled in place, so hoisting them
  // changes nothing about how the body reads them.
  const perResourceSecrets = new Map<string, Map<string, string>>();
  const outputSecrets = new Map<string, string>();
  // Filled by the cross-stack pre-pass; read by the return sites below. Hoisted
  // beside the secret maps for the same reason they are: the value is needed
  // after a throw could have happened.
  const prePassFindings: CrossStackPrePassFindings = { unverifiable: [] };
  try {
    const loaded = await stateBackend.getState(stack.stackName, region);
    if (!loaded) {
      logger.debug(`No state for ${stack.stackName} (${region}) — skipping`);
      return { recordsChanged: 0, secretsFound: 0, secretBearingKeys: 0, unverifiableReads: 0 };
    }
    const state = loaded.state;

    // Re-resolve each resource's TEMPLATE properties to collect the resolved
    // secret plaintext -> expression map (into the two maps hoisted above). The
    // resolved output is discarded; only the recorded secrets matter.
    const perResourceTemplateProps = new Map<string, Record<string, unknown>>();
    const outputsTemplateSource: Record<string, unknown> = {};
    // Issue #2109: the stack's own resolver plus one pinned sibling per FOREIGN
    // region a reference NAMES. `producerRegionsFromState` is the same
    // per-stack evidence the rollback replay uses (#2057) — every region this
    // stack read a cross-stack value out of, from `state.imports` (the strong
    // `Fn::ImportValue` edge) and `state.outputReads` (the weak
    // `Fn::GetStackOutput` one).
    const resolvers = new ScrubResolvers(region);
    const resolver = resolvers.primary;
    const producerRegions = producerRegionsFromState(state);
    let parameters: Record<string, unknown> = {};
    let conditions: Record<string, boolean> = {};
    try {
      parameters = await resolver.resolveParameters(stack.template);
    } catch (err) {
      logger.debug(
        `Parameter resolution skipped for ${stack.stackName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // Issue #2133: the ONE resolve context every resolution in this function
    // uses, spelled once. The three inline copies it replaces were identical but
    // for their secrets map, and all three were missing `stateBackend` — so
    // `Fn::ImportValue` and `Fn::GetStackOutput` threw for want of a dependency
    // in EVERY context scrub builds, the plaintext behind a cross-stack read
    // never became a needle, and the command reported success over state that
    // may still hold it. One factory is the fix for the CLASS rather than for
    // the three instances: a fourth context cannot be written without the
    // wiring, which is how the first three came to lack it.
    //
    // `exportIndex` is deliberately NOT supplied. It is a PERFORMANCE hint — the
    // resolver falls back to the per-stack `state.json` scan, which is the
    // pre-index behavior — and supplying it would let `resolveImportValue`'s
    // scan arm PATCH the index, i.e. an S3 write from a command documented to
    // perform no AWS mutation, `--dry-run` included.
    //
    // NOT quite "equally correct", which an earlier revision claimed (issue
    // #2133 review). The scan walks `listStacks()` — every stack in EVERY
    // region — and takes the FIRST record whose `state.outputs` carries the
    // export name, while the index is keyed by export name alone. Two regions
    // publishing the same export name can therefore make scrub resolve a
    // DIFFERENT producer than the deploy did, and a wrong producer means a
    // wrong needle: at best a miss, at worst the coinciding-literal rewrite
    // issue #2109 is about. Not fixed here because the ordering lives in
    // `resolveImportValue`'s scan and a deterministic tie-break is a resolver
    // change (a lane owns that file), and because supplying the index is the
    // one alternative and it costs the no-AWS-mutation property above. In
    // practice a duplicate export name across regions is already an ambiguity
    // the deploy shares.
    //
    // `recordedSecretValues` is optional because `evaluateConditions` passes
    // none: it is PRODUCING `conditions` (so the spread below is empty there)
    // and records no secrets today, which this issue does not change.
    //
    // The backend handed to the RESOLVER is a memoizing VIEW, not the real one
    // (issue #2133 review). `resolveImportValue` has no lookup cache: every
    // reference costs `listStacks()` plus up to N `getState()`, and the
    // pre-pass and the main resolution each perform the read — so a template
    // with k imports paid 2k scans. The view collapses them to one scan and one
    // `getState` per (stack, region) for the whole of this function. It caches
    // OTHER stacks' reads only in the sense that it caches every read the
    // resolver makes; this stack's own state load and its `saveState` go
    // through the REAL backend above and below, untouched. Sharing is safe
    // because scrub mutates no other stack's state while this runs.
    //
    // Note this is a read cache, NOT a needle cache: the resolve itself still
    // runs per reference, so each resource's own `recordedSecretValues` gets
    // its own needles. Caching the RESOLVE instead would give the second
    // consumer of one import no needle at all.
    const resolverStateBackend = memoizeCrossStackStateReads(stateBackend);
    const resolverContext = (recordedSecretValues?: RecordedSecretValues): ResolverContext => ({
      template: stack.template,
      resources: state.resources,
      ...(Object.keys(parameters).length > 0 && { parameters }),
      ...(Object.keys(conditions).length > 0 && { conditions }),
      stackName: stack.stackName,
      stateBackend: resolverStateBackend,
      ...(recordedSecretValues && { recordedSecretValues }),
      // Issue #2134: the evidence that arms the resolver's own region
      // classification, which is what finally covers an ASSEMBLED reference.
      // The pre-pass above (`pinCrossRegionSecrets`) can only classify a
      // reference that is already whole in the raw template leaf; a reference
      // built by `Fn::Sub` / `Fn::Join` / `Ref` does not exist until the
      // resolver assembles it, and the resolver is where it is now judged.
      //
      // Passed UNFILTERED (`producerRegions`, not `foreignProducerRegions`):
      // `classifyReplaySecretRegion` drops the consumer's own region itself,
      // and handing it the pre-filtered list would work only by coincidence of
      // the two filters agreeing. Scrub supplies it because a wrong-region
      // answer here is a silent MISS -- the stack reported clean over
      // plaintext it still holds -- so failing closed is the point.
      producerRegions,
      bestEffort: true,
    });
    const resolveCrossStackReads = makeCrossStackPrePass({
      stackName: stack.stackName,
      resolver,
      producerTemplates: new Map(
        (opts.appStacks ?? []).map((s) => [s.stackName, s.template] as const)
      ),
      findings: prePassFindings,
      logger,
    });
    // NO cross-stack pre-pass over the CONDITIONS, and that is a decision
    // rather than the omission it looks like (issue
    // [#2133](https://github.com/go-to-k/cdkd/issues/2133) review). This call
    // PRODUCES `conditions`, which the pre-pass itself consumes to decide which
    // `Fn::If` branch is live — so a refusing pass here would have to run
    // before scrub knows which references the deploy actually read, i.e. it
    // could refuse the whole stack over a branch that was never taken, the
    // exact hazard the selected-branch mirror exists to prevent. A condition
    // also carries no secret INTO state: it evaluates to a boolean, and its
    // operands are compared rather than persisted.
    //
    // The residual is real and named here rather than hidden: a cross-stack
    // read inside a condition that cannot be performed degrades that condition
    // to `false` (`bestEffort`), which then selects the FALSE branch of every
    // `Fn::If` in BOTH passes below — so a needle living in the TRUE branch is
    // silently not recorded. Bounded by the fact that scrub's branch selection
    // is at least self-consistent, and that the condition resolves normally now
    // that this context carries a `stateBackend` at all; what it cannot promise
    // is agreeing with what the DEPLOY selected. Making that loud means
    // deciding what an unevaluatable condition should do to a whole scrub,
    // which is a different question from this issue's.
    try {
      // Pass `outputSecrets` so the condition pass has a needle map to mask
      // AGAINST. A condition can resolve a cross-stack read now that this
      // context carries a `stateBackend` (issue #2133), and a masker with an
      // empty map is a no-op that reads as safe in a diff. `outputSecrets` is
      // the run-scoped map, registered before anything that can throw.
      conditions = await resolver.evaluateConditions(resolverContext(outputSecrets));
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
      // REGISTERED BEFORE the pin and the pre-pass, not after them (issue #2133
      // review). The map is filled IN PLACE, so registering it early changes
      // nothing about what the loop below reads — but `maskSecretsInError` at
      // the bottom of this function masks against
      // `allRecordedSecrets(outputSecrets, perResourceSecrets)`, and both
      // `pinCrossRegionSecrets` and the cross-stack pre-pass can THROW after
      // recording a foreign plaintext into this map. Registering afterwards
      // left exactly that window unmasked: the escaping error, and every link
      // of its cause chain that `formatError` / `util.inspect` walks, could
      // carry a plaintext the boundary had no needle for.
      //
      // Unconditional, where the old registration was gated on
      // `size > 0`. An empty map is what every reader already substitutes for a
      // missing entry (`secrets ?? new Map()`), and `allRecordedSecrets`
      // filters by needle length, so an empty entry contributes nothing.
      perResourceSecrets.set(logicalId, recordedSecretValues);
      // Issue #2109: resolve any FOREIGN-region reference in its own region
      // first, and REFUSE one whose region cannot be established. Deliberately
      // OUTSIDE the best-effort catch below — a refusal that a `logger.debug`
      // swallowed would leave the command reporting success over a state file
      // it never scrubbed, which is the one outcome the issue says must not
      // survive.
      const resolveInput = await pinCrossRegionSecrets(
        templateResource.Properties,
        stack.stackName,
        {
          stackRegion: region,
          producerRegions,
          resolvers,
          recordedSecretValues,
          origin: `resource '${logicalId}'`,
        }
      );
      const resourceContext = resolverContext(recordedSecretValues);
      // Issue #2133, and OUTSIDE the best-effort catch below for the same reason
      // the pin above is: a cross-stack read that failed silently would leave
      // scrub with no needle for whatever that reference carries, and the
      // command would report success over a state file it could not examine.
      // REFUSAL ARMED here, unlike the two OUTPUT sites below, and the
      // asymmetry is the point: this loop iterates `state.resources`, so the
      // record EXISTS — the deploy created it and may have persisted the
      // imported plaintext into it. A suppressed OUTPUT was never written at
      // all, so a read it needs is one the deploy never made.
      await resolveCrossStackReads(resolveInput, resourceContext, `resource '${logicalId}'`);
      try {
        await resolver.resolve(resolveInput, resourceContext);
      } catch (err) {
        // A region-AMBIGUOUS refusal is not best-effort -- see
        // `isRegionAmbiguousRefusal`.
        if (isRegionAmbiguousRefusal(err)) throw err;
        // Best-effort: a resource whose intrinsics cannot resolve (a Ref to
        // something not in state) still has its own {{resolve:...}} leaves
        // recorded along the way; leave the rest untouched.
        //
        // MASKED, for the reason `unresolvableForeignScrubSecretError` states:
        // `resolveInput` is a bag `pinCrossRegionSecrets` may already have
        // SUBSTITUTED a foreign plaintext into, so a resolver error that echoes
        // what it was handed can carry one — and `recordedSecretValues` holds
        // exactly the plaintexts this resource's pin recorded. Verbose-only, so
        // this is the lower-severity sibling of the `Export.Name` warn below,
        // but it is the same site class.
        logger.debug(
          `Resolution of ${logicalId} during scrub was partial: ` +
            `${maskSecretsInText(err instanceof Error ? err.message : String(err), recordedSecretValues)}`
        );
      }
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
    // Three rules differ from the engine's on purpose, and all follow from what
    // scrub can KNOW about state some earlier binary wrote:
    //
    // 1. A colliding key gets NO source at all, rather than the owning output's.
    //    The engine just resolved that key's value and knows whose it is; scrub
    //    does not, and in the corrupted-legacy case — the case it exists for —
    //    the alias may well have WON the key. So the key falls to the VALUE
    //    scan, which reads the plaintext actually stored and maps it back to
    //    the expression that produced it — as far as a value scan can, which is
    //    exactly: a WHOLE-value match always, and an EMBEDDED one only for
    //    secrets at or above `secret-redaction`'s minimum needle length. A
    //    short secret embedded in a longer stored value therefore survives this
    //    fallback, and the stack is reported clean; that bound is the value
    //    scan's, not this rule's, but this rule is what exposes the key to it.
    //    That is the pre-#1910 behavior, which
    //    for this key is what the issue calls "weaker but not wrong: it
    //    returned an expression that at least resolved to the value it
    //    replaced". The residual it accepts is stated exactly, because an
    //    earlier revision understated it: when two DISTINCT secrets happen to
    //    resolve to one plaintext, the value map keeps one of them, so the
    //    ambiguous key can be persisted holding a reference naming the OTHER
    //    secret — not merely a lost precision bound. Neither rule dominates
    //    (position can name the wrong secret on this key too, from the other
    //    direction), and the test file pins both sides of the trade.
    //
    // 2. Collisions are tested against every DECLARED output name, conditions
    //    ignored, and an INTRINSIC `Export.Name` is best-effort resolved for
    //    that test alone — see `collectDeclaredOutputNames` for why scrub must
    //    over-approximate here, and note the legacy population is exactly the
    //    binaries that DID resolve intrinsic export names into state keys, so a
    //    literal-only test leaves the original corruption reachable. The
    //    resolved name is never written as a source key: it is only compared.
    //
    // 3. If an intrinsic `Export.Name` cannot be resolved at all, the WHOLE
    //    outputs source bag is dropped and every output key falls to the value
    //    scan. The deploy keyed state under a name scrub then cannot reproduce,
    //    and that name could be ANY output's — so there is no key to mark
    //    ambiguous and no honest way to keep positioning the rest. A residual
    //    remains and is documented rather than hidden: a name that resolves
    //    SUCCESSFULLY but differently from what the deploy resolved (a
    //    parameterized prefix, since scrub has only template defaults) is
    //    undetectable from here.
    const declaredOutputNames = collectDeclaredOutputNames(templateOutputs);
    // Which `state.outputs` KEYS today's template can account for (issue #2005).
    // Every declared output name, plus every `Export.Name` this run could
    // FULLY compute — the literal ones AND the intrinsic ones whose best-effort
    // resolution actually landed. That is still wider than the set that gets a
    // position source below (only a LITERAL export name may be written under),
    // but NOT wider than what the template can name: a name that did not fully
    // resolve is excluded, because over-approximating there SUPPRESSES the
    // repair rather than merely widening it (see the per-name comment below).
    // The widened outputs pass at the end of this function fires ONLY on keys
    // that are in NEITHER set.
    const accountedOutputKeys = new Set<string>(declaredOutputNames);
    const ambiguousKeys = new Set<string>();
    const collisions: Array<[outputKey: string, exportName: string]> = [];
    let outputsSourceUntrusted = false;
    for (const [name, output] of Object.entries(templateOutputs)) {
      // The declared type says `string`, but templates carry intrinsics here and
      // the pre-fix binary resolved them into state keys.
      const declaredExportName = (output as { Export?: { Name?: unknown } }).Export?.Name;
      let exportName: unknown = declaredExportName;
      if (declaredExportName !== undefined && typeof declaredExportName !== 'string') {
        // Resolved through a VIEW of the pass map (issue #2531): the entries
        // are the pass map's, live, but the resolved PAIRS the resolver
        // records beside them hang off this instance and die with it — see
        // `SharedEntriesSecrets` for why both halves matter. This loop runs
        // FIRST and re-asks AWS for a reference the resolver never caches (an
        // unclassifiable-`Type` `ssm` parameter), so a value that moves
        // between this resolution and the value loop's would, recorded
        // straight into the pass map, conflict the pair a literal Output
        // embedding the token needs. (An earlier comment here grounded the
        // shared map on the cache-hit arm re-recording "only what it can
        // still prove is secret"; since issue #1933 the cache carries the
        // verdict beside the value, so the hit arm re-records a cached secret
        // too, and the never-cached reference above re-asks AWS regardless.
        // The entries are shared either way, without leaning on that.)
        const nameSecrets: RecordedSecretValues = new SharedEntriesSecrets(outputSecrets);
        // Whether the name's resolution threw (a swallowed, best-effort
        // failure). A boolean rather than the error's presence: `undefined`
        // is a legal thrown value, and the old catch warned for it too.
        let nameFailed = false;
        let nameError: unknown;
        // Issue #2109, same treatment as the resource bag above and outside
        // the catch for the same reason. An `Export.Name` is rarely
        // secret-bearing, but the region question is the expression's, not
        // the position's — and this resolution's RESULT becomes a state key,
        // so a wrong-region answer here mis-keys the whole positioned outputs
        // pass.
        const nameSource = await pinCrossRegionSecrets(declaredExportName, stack.stackName, {
          stackRegion: region,
          producerRegions,
          resolvers,
          recordedSecretValues: nameSecrets,
          origin: `Export.Name of output '${name}'`,
        });
        const nameContext = resolverContext(nameSecrets);
        // Issue #2133, same treatment and same placement as the resource bag
        // above: a name assembled from a cross-stack read that scrub cannot
        // perform is a name it cannot reproduce, and swallowing that is how
        // the whole outputs pass came to be positioned against a key the
        // deploy never wrote.
        await resolveCrossStackReads(nameSource, nameContext, `Export.Name of output '${name}'`, {
          canRefuse: !isOutputSuppressed(name, output, conditions, state.outputs ?? {}),
        });
        try {
          exportName = await resolver.resolve(nameSource, nameContext);
        } catch (err) {
          // A region-AMBIGUOUS refusal is not best-effort -- see
          // `isRegionAmbiguousRefusal`.
          if (isRegionAmbiguousRefusal(err)) throw err;
          nameFailed = true;
          nameError = err;
        }
        if (nameFailed) {
          // No key to mark ambiguous — the name the deploy used is unknown and
          // could be any output's — so the whole source bag becomes untrusted.
          outputsSourceUntrusted = true;
          // MASKED, and this is the one of the three that prints at DEFAULT
          // verbosity: `nameSource` is a bag `pinCrossRegionSecrets` may
          // already have substituted a foreign plaintext into, so a resolver
          // error echoing its input reaches the terminal of a command whose
          // entire subject is removing that plaintext. `outputSecrets` holds
          // everything the pin and the resolution recorded (the view writes
          // through), so it is the right needle set.
          logger.warn(
            `Export.Name of output ${name} could not be resolved during scrub ` +
              `(${maskSecretsInText(nameError instanceof Error ? nameError.message : String(nameError), outputSecrets)}) — ` +
              `redacting this stack's outputs by value match instead of by template position, since state may be keyed under a name this run cannot reproduce.`
          );
        }
      }
      if (declaredExportName !== undefined && typeof exportName !== 'string') {
        // Same reasoning as the catch: a name that resolved to a non-string is
        // a name scrub cannot reproduce.
        outputsSourceUntrusted = true;
      }
      // A resolution that came BACK is not the same as one that SUCCEEDED:
      // `resolveSub` does not throw on an unresolvable placeholder, it warns and
      // keeps `${Foo}` in the string. Scrub takes no `--parameters`, so that is
      // the COMMON shape for a parameterized export name — and trusting it would
      // run the collision test against a name scrub provably could not
      // reproduce, re-enabling the wrong-secret rewrite in the remediation
      // command. Same rule the diff twin applies, imported rather than
      // re-spelled.
      const exportNameUnresolved =
        declaredExportName !== undefined &&
        typeof exportName === 'string' &&
        isUnresolvedValue(exportName, templateUsesSub(declaredExportName));
      // ACCOUNTED regardless of what the collision check below decides about
      // trusting it as a position SOURCE (issue #2005): the question here is
      // only "could today's template have produced this state key", and a name
      // that FULLY resolved is a name the deploy could have keyed under.
      //
      // A name that did NOT fully resolve is deliberately NOT added, and the
      // first cut of this got it backwards on a premise that is false: it added
      // the literal `${Foo}` too, calling it inert because "that is not a key
      // any deploy wrote". It can be — `deploy-engine.ts`'s alias write guards
      // only on `typeof exportName !== 'string'`, with no `isUnresolvedValue`
      // test, so a deploy whose `Fn::Sub` warn-and-KEPT `${Foo}` writes that
      // literal into `state.outputs` as a key. Marking it accounted then
      // EXCLUDES it from the widened pass while the positioned pass runs
      // source-less against `outputSecrets` alone — so a secret living only in
      // `perResourceSecrets`, which is exactly issue #2005's population, is
      // never repaired and `--dry-run --fail` exits clean over surviving
      // plaintext. Not adding it is strictly narrowing: the key it could not
      // compute was already unaccounted, and now the literal one is too.
      if (typeof exportName === 'string' && !exportNameUnresolved) {
        accountedOutputKeys.add(exportName);
      }
      if (exportNameUnresolved) {
        outputsSourceUntrusted = true;
        logger.warn(
          `Export.Name of output ${name} did not fully resolve during scrub — ` +
            `redacting this stack's outputs by value match instead of by template position, since state may be keyed under a name this run cannot reproduce.`
        );
      } else if (
        typeof exportName === 'string' &&
        isExportAliasCollision(exportName, name, declaredOutputNames)
      ) {
        ambiguousKeys.add(exportName);
        // The WARNING is deferred to after the value loop below, for the same
        // reason the deploy engine decides aliases in a second pass: this loop
        // runs first, so `outputSecrets` is not yet complete, and the message
        // masks its name against that map. Warning here would print a resolved
        // name whose plaintext had not been recorded yet.
        collisions.push([name, exportName]);
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
      //
      // BOTH HALVES, because the first cut stated only this one and then let it
      // carry more weight than it can (issue #2133 review). "Resolve a
      // suppressed output for its needles" does NOT imply "refuse the stack
      // when that resolution fails": a suppressed output wrote no
      // `state.outputs` key, so there is no stored plaintext behind it to
      // protect, while refusing would make a prod-only
      // `Fn::ImportValue` unscrubbable in dev — every OTHER secret in the stack
      // stranded over a reference the deploy never read. Hence the
      // `canRefuse` flag on the pre-pass call below; see
      // {@link isOutputSuppressed}.
      // Issue #2109, same treatment and same placement as the two above. The
      // POSITION source written just above is the ORIGINAL `value`, never this
      // copy: `redactSecretsForState` reads UNRESOLVED expressions off it.
      const valueSource = await pinCrossRegionSecrets(value, stack.stackName, {
        stackRegion: region,
        producerRegions,
        resolvers,
        recordedSecretValues: outputSecrets,
        origin: `output '${name}'`,
      });
      const valueContext = resolverContext(outputSecrets);
      // Issue #2133, same treatment and same placement as the two above. An
      // output that re-publishes an imported value is the ordinary shape here,
      // and its plaintext becomes a needle only if the read succeeds.
      await resolveCrossStackReads(valueSource, valueContext, `output '${name}'`, {
        canRefuse: !isOutputSuppressed(name, output, conditions, state.outputs ?? {}),
      });
      try {
        await resolver.resolve(valueSource, valueContext);
      } catch (err) {
        // A region-AMBIGUOUS refusal is not best-effort -- see
        // `isRegionAmbiguousRefusal`.
        if (isRegionAmbiguousRefusal(err)) throw err;
        // MASKED for the same reason as the two above — `valueSource` is a
        // post-pin bag. Verbose-only.
        logger.debug(
          `Resolution of output ${name} during scrub was partial: ` +
            `${maskSecretsInText(err instanceof Error ? err.message : String(err), outputSecrets)}`
        );
      }
    }

    for (const [name, exportName] of collisions) {
      logger.warn(exportAliasCollisionScrubWarning(name, exportName, outputSecrets));
    }

    // A KEY that already holds plaintext is the residue of an earlier binary
    // publishing an export name that resolved to a secret (issue #1919). No
    // redaction pass can reach it — they all walk values — so this is REPORTED,
    // never rewritten: see `secretBearingStateKeyWarning` for why renaming a key
    // here would be worse than leaving it, and for the template-side remedy.
    // Counted so a state that leaks only through a key cannot be reported clean
    // by `--dry-run --fail`.
    // `state.outputs ?? {}`: every other consumer treats the field as optional
    // (`export-index-store.ts`, `state.ts`, `nested-stack-provider.ts`) and so
    // does this function's own redaction call below, so indexing it directly
    // would make the REMEDIATION command throw on a state file that simply has
    // no outputs — refusing to scrub the resources it could have scrubbed.
    // `outputSecrets`, NOT the widened union issue #2005 introduces for the
    // VALUE pass below, and that is a decision rather than an oversight. The
    // union would also flag a KEY holding a plaintext only a RESOURCE still
    // references — the same detection gap one class over — but this scan feeds
    // the `--fail` exit code on a REAL run, so widening it would start failing
    // builds over a finding no scrub can remedy (a key is never rewritten; the
    // remedy is an `Export.Name` change plus a redeploy, per #1919). Repairing
    // a value and re-classifying a build are different changes and the second
    // one is not this issue's.
    const secretBearingKeys: string[] = [];
    for (const key of Object.keys(state.outputs ?? {})) {
      const exposure = stateKeySecretExposure(key, outputSecrets);
      if (!exposure) continue;
      secretBearingKeys.push(key);
      logger.warn(secretBearingStateKeyWarning(stack.stackName, key, exposure));
    }

    const totalSecrets =
      outputSecrets.size + [...perResourceSecrets.values()].reduce((n, m) => n + m.size, 0);
    if (totalSecrets === 0) {
      // NOT a blanket "nothing found": `unverifiableReads` is carried out even
      // here, because a stack whose only cross-stack read cdkd declined by
      // design has exactly this shape — zero needles — and reporting it clean
      // is the outcome issue #2133 exists to prevent.
      //
      // `secretBearingKeys.length` is provably 0 on this branch and is carried
      // for SHAPE only (issue #2133 review): `totalSecrets === 0` implies
      // `outputSecrets.size === 0`, and `stateKeySecretExposure` needs a needle
      // from that very map, so the loop above pushed nothing. The rationale
      // above therefore covers `unverifiableReads` alone — it is the one field
      // that can be non-zero here.
      return {
        recordsChanged: 0,
        secretsFound: 0,
        secretBearingKeys: secretBearingKeys.length,
        unverifiableReads: prePassFindings.unverifiable.length,
      };
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
    // `TEMPLATE_SOURCED_RULES`, converging this call with its deploy-side twin
    // `DeployEngine.redactOutputs` (issues
    // [#1943](https://github.com/go-to-k/cdkd/issues/1943) /
    // [#2099](https://github.com/go-to-k/cdkd/issues/2099)). `state.outputs` is
    // a PERSISTED bag while `outputsTemplateSource` is TODAY's template, so
    // `TEMPLATE_DERIVED_RULES` — "the bag was produced by resolving the
    // source" — is not true of this pair. The two constants differ on
    // `descendArrays` ALONE (`sourceIsSameGeneration` is already false in
    // both), so that flag is the whole question here.
    //
    // **The premise this call site used to rest on is FALSE.** It read: the
    // array arm cannot fire because `outputsTemplateSource[name]` is a template
    // Output's `Value`, "which CloudFormation requires to be a string or an
    // intrinsic OBJECT". CloudFormation does require that; cdkd does not
    // ENFORCE it. `TemplateOutput.Value` is typed `unknown`, the resolver walks
    // an array elementwise with no string coercion, and `StackState.outputs` is
    // deliberately not string-coerced — so a list-valued output (an escape
    // hatch, a hand-written or imported template) puts an array on BOTH sides
    // and the arm IS reachable. The measurement that produced the claim
    // enumerated the shapes CDK emits, not the shapes this code accepts. And
    // this is the pair positional descent is least sound for: the bag is a
    // previous generation's persisted array and the source is today's template
    // array, so a stored literal at index `i` would be rewritten to today's
    // expression at index `i` — `redactByPath` returns a known-secret source
    // leaf VERBATIM — with nothing but equal length connecting the two.
    //
    // **THE TRADE, stated rather than re-decided.** Turning `descendArrays` off
    // gives up a legitimate positional descent, and on the deploy side that
    // cost lands on the 2 of 3 `redactOutputs` sites whose bag WAS freshly
    // resolved from today's template. This call site can never be one of those
    // — its bag is always persisted state — but it does NOT follow that the
    // swap is free here. When state happens to be current, the stored array and
    // the template array line up, and the descent that is now refused would
    // have rewritten an element whose plaintext this run did not record — a
    // value rotated away at its source since the deploy, which the value scan
    // cannot identify and therefore leaves in place. That is the accepted cost;
    // the ORDERING command doc above already tells operators to scrub BEFORE
    // rotating for the same reason. It is bought with the elimination of a
    // FABRICATED expression written into `state.outputs`, which the exports
    // index and `Fn::ImportValue` re-apply VERBATIM to consumer stacks — the
    // #1934 BREAK class, irreversible in a way an unredacted leaf is not.
    const positionedOutputs =
      outputSecrets.size > 0
        ? redactSecretsForState(
            state.outputs,
            outputSecrets,
            outputsSourceUntrusted ? undefined : outputsTemplateSource,
            TEMPLATE_SOURCED_RULES
          )
        : state.outputs;
    // The widened pass (issue #2005): repair a stored output key today's
    // template cannot account for. See `redactUnaccountedOutputs` for both
    // halves of the scope decision, and for why the values it scans come from
    // `state.outputs` (the STORED bag) while its result is written over
    // `positionedOutputs`.
    const newOutputs = redactUnaccountedOutputs(
      positionedOutputs,
      state.outputs,
      accountedOutputKeys,
      allRecordedSecrets(outputSecrets, perResourceSecrets)
    );
    const outputsChanged = JSON.stringify(newOutputs) !== JSON.stringify(state.outputs);
    if (outputsChanged) recordsChanged++;

    if (recordsChanged > 0 && !opts.dryRun) {
      const nextState: StackState = {
        ...state,
        resources: newResources,
        // The cast restates what `StackState` already gets wrong rather than
        // introducing a lie: `outputs` is TYPED as required while every
        // consumer treats it as optional, and a state file that simply has no
        // outputs must round-trip WITHOUT gaining an empty bag — materializing
        // `{}` here would be a write this command never intended to make.
        // `newOutputs` IS `state.outputs`, unchanged, in exactly that case.
        outputs: newOutputs as StackState['outputs'],
        lastModified: Date.now(),
      };
      await stateBackend.saveState(stack.stackName, region, nextState, {
        expectedEtag: loaded.etag,
      });
    }

    return {
      recordsChanged,
      secretsFound: totalSecrets,
      secretBearingKeys: secretBearingKeys.length,
      unverifiableReads: prePassFindings.unverifiable.length,
    };
  } catch (err) {
    // THE MASKING BOUNDARY for everything that ESCAPES this function (issue
    // #2109 review). Every log site inside masks the string it interpolates,
    // and that is not sufficient on its own: an error thrown out of here is
    // rendered as an OBJECT by `formatError` (`Caused by: <cause.message>`) and
    // by `src/cli/index.ts`'s top-level `console.error`, which walks the whole
    // `cause` chain and every link's `stack` through `util.inspect` — the
    // reader that `maskSecretsInError`'s own doc says a per-site mask cannot
    // close. It also makes the `--all` loop's cause-chain rendering safe: that
    // caller has no secrets map of its own and cannot mask what it prints.
    //
    // The union is the same one the widened outputs pass uses, so the needle
    // FLOOR (`MIN_NEEDLE_LENGTH`) is applied here too — a secret too short to
    // be a safe needle is not masked, exactly as it is not redacted. Returns
    // the original error by identity when nothing matched, so the ordinary
    // "no state for this stack" failure keeps its identity.
    throw maskSecretsInError(err, allRecordedSecrets(outputSecrets, perResourceSecrets));
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
    .option(
      '--fail',
      'With --dry-run, exit non-zero if any plaintext secret is found (CI gate). ' +
        'Also exits non-zero on a real run when a leak was found that scrub cannot rewrite.'
    );

  [...commonOptions, ...appOptions, ...stateOptions, ...stackOptions, ...contextOptions].forEach(
    (opt) => cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);

  cmd.action(withErrorHandling(scrubCommand));
  return cmd;
}
