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
import { foldRegionOption, namedCliRegion } from '../region-options.js';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';
import { matchStacks, describeStack } from '../stack-matcher.js';
import { IntrinsicFunctionResolver } from '../../deployment/intrinsic-function-resolver.js';
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
import type { StackInfo } from '../../synthesis/assembly-reader.js';
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
  // Counted SEPARATELY from the stacks actually rewritten. A key-holding-
  // plaintext finding is a finding the command cannot remedy (issue #1919), and
  // folding it into the scrubbed count made the summary claim a remediation it
  // had not performed — the same invariant the export-name warning enforces:
  // a message must never assert what it did not do.
  let totalStacksWithUnscrubbableKeys = 0;
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
    } else if (scrubbed.secretBearingKeys === 0) {
      logger.info(`No plaintext secrets found in ${stack.stackName}`);
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

  if (totalStacksScrubbed === 0 && totalStacksWithUnscrubbableKeys === 0) {
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

  if (options.dryRun) {
    // Gated like its non-dry-run twin: with only key findings this would plan
    // to scrub nothing, and "0 stack(s) ... would be scrubbed" reads as a clean
    // result directly above a warning that says otherwise.
    if (totalStacksScrubbed > 0) {
      logger.info(
        `\nPlan: ${totalStacksScrubbed} stack(s) hold plaintext secrets and would be scrubbed ` +
          `(--dry-run, no state written).${keyNote}${failureNote} ROTATE any exposed secret in Secrets Manager.`
      );
    } else {
      logger.info(
        `\nPlan: nothing can be scrubbed.${keyNote}${failureNote} ROTATE any exposed secret.`
      );
    }
    // The refusal outranks the `--fail` gate: it is an ERROR (exit 2) about
    // state this run could not examine, while `ScrubNeededError` (exit 1) is a
    // finding about state it did.
    if (failures.length > 0) throw scrubStacksFailedError(failures);
    if (options.fail) throw new ScrubNeededError();
    return;
  }

  // Gated: with only key findings this rewrote nothing, and asserting that "the
  // plaintext is no longer stored" would be the same false claim the masking
  // invariant forbids.
  if (totalStacksScrubbed > 0) {
    logger.info(
      `\nDone: scrubbed ${totalStacksScrubbed} stack(s). ` +
        `The plaintext is no longer stored there, but a value that was ever persisted should be ` +
        `treated as compromised — ROTATE it in Secrets Manager (scrub matches the current ` +
        `value, so scrub BEFORE rotating).${keyNote}${failureNote}`
    );
  } else {
    logger.info(`\nNothing could be rewritten.${keyNote}${failureNote} ROTATE any exposed secret.`);
  }
  // `--fail` is documented as a --dry-run CI gate, but a REAL run over a
  // key-only leak would otherwise exit 0 — and that is the one finding class a
  // real run cannot fix, so exiting clean is exactly backwards.
  if (failures.length > 0) throw scrubStacksFailedError(failures);
  if (options.fail && totalStacksWithUnscrubbableKeys > 0) throw new ScrubNeededError();
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
 * The producer regions that are genuinely FOREIGN to this stack, canonicalized
 * and de-duplicated (issue #2109 review).
 *
 * The same filter {@link classifyReplaySecretRegion} applies to its own
 * `importedProducerRegions` argument, spelled here because the
 * unclassifiable-reference guard needs the answer WITHOUT an expression to hand
 * to the classifier. A same-region cross-stack read is the common case and
 * raises no cross-region question, so it must not arm a refusal.
 */
function foreignRegionsOf(
  producerRegions: readonly string[],
  stackRegion: string
): readonly string[] {
  const seen = new Set<string>();
  const foreign: string[] = [];
  for (const candidate of producerRegions) {
    const canonical = canonicalizeRegion(candidate);
    if (!canonical || canonical === canonicalizeRegion(stackRegion)) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    foreign.push(candidate);
  }
  return foreign;
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
  /**
   * The subset of {@link producerRegions} that is NOT this stack's own region,
   * canonicalized and de-duplicated — the same filter
   * {@link classifyReplaySecretRegion} applies internally, computed once here
   * because {@link resolveForeignRegionTokens}'s unclassifiable-reference guard
   * has to ask the question WITHOUT a classifiable expression to hand to the
   * classifier. Same-region cross-stack reads are extremely common and carry no
   * cross-region question at all, so a guard keyed on the UNFILTERED list would
   * refuse ordinary single-region apps.
   */
  foreignProducerRegions: readonly string[];
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
 * {@link unclassifiableScrubSecretError}.
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
 * `secretsmanager` / `ssm` mirror `REPLAY_SECRET_SERVICES` in
 * `rollback-executor.ts`, whose {@link classifyReplaySecretRegion} is what
 * classifies the tokens below — the same set on both sides, so the count and
 * the classification never disagree about what is in scope. `ssm-secure` is
 * added on top: it IS a CloudFormation secret spelling, and although cdkd does
 * not resolve it today (the resolver's unsupported-service arm leaves it
 * verbatim, so it can never become a wrong-region needle), counting it costs
 * only an assembled `ssm-secure` reference in a cross-region stack and keeps
 * the guard correct the day that arm changes.
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
 * the third assembled shape — see {@link unclassifiableScrubSecretError}.
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
 * The refusal an ASSEMBLED reference raises (issue #2109 review): a leaf that
 * OPENS more SECRET references than the scan found COMPLETE tokens of that
 * class in it, or a whole token that still carries an `Fn::Sub` placeholder.
 *
 * WHY THIS EXISTS, and it is the load-bearing half of this pre-pass rather than
 * an edge case. The region split runs on the RAW template leaf, BEFORE intrinsic
 * resolution, and the shared token scan is `\{\{resolve:[^}]+\}\}` — a class
 * that cannot cross a `}`. So none of the three shapes that assemble a
 * reference out of parts yields the ONE WHOLE token a literal reference does,
 * and the third one is why this guard needs two tests rather than one
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
 * literally spelled `${...}` in a leaf that is NOT under an `Fn::Sub` — and
 * this guard is the fail-closed side of a command whose subject is a leaked
 * plaintext.
 *
 * With no token there is nothing to classify: {@link pinCrossRegionSecrets}
 * returns the leaf BY IDENTITY, and `resolveJoin` / `resolveSub` then call
 * `resolveDynamicReferences` on the PRIMARY resolver once they have joined the
 * parts — issue #2109 verbatim, with the `ambiguous` refusal never firing. The
 * trailing-placeholder row got there a different way before this guard's second
 * test: the token WAS classified, and only downstream luck kept it safe (the
 * name form then classifies `ambiguous`, the ARN form fails into
 * `SCRUB_CROSS_REGION_SECRET_UNRESOLVED` because the id it looks up still has a
 * literal `${Field}` in it). Both are pinned by the suite rather than assumed.
 * Fixing all of this inside the resolver (classify AFTER assembly) is the
 * structurally right answer and is NOT what this does: the resolver's
 * dynamic-reference path is shared with deploy and is out of this change's
 * scope. This guard buys the same SAFETY property — a reference whose region
 * cannot be established is never resolved in the stack's own region — by
 * refusing instead.
 *
 * GATED ON A FOREIGN PRODUCER REGION BEING ON RECORD, which is what keeps it
 * from refusing the world. With no foreign region on record there is no
 * cross-region question to get wrong: every reference in the stack resolves
 * locally, which is what an assembled one would have done anyway, so proceeding
 * is exactly today's behavior. Two residuals, stated rather than hidden:
 * an assembled reference that names a FOREIGN ARN inside an `Fn::Sub` in a
 * stack with NO cross-stack read on record is still resolved locally; and an
 * `Fn::Join` that splits BEFORE the service name is not counted at all (see
 * {@link SECRET_REFERENCE_OPENINGS}). Closing either needs the resolver-side
 * classification above — issue
 * [#2134](https://github.com/go-to-k/cdkd/issues/2134).
 */
function unclassifiableScrubSecretError(
  origin: string,
  leafPath: string,
  stackName: string,
  foreignProducerRegions: readonly string[],
  stackRegion: string
): CdkdError {
  return new ScrubRefusalError(
    `Scrub of ${stackName} cannot classify a secret reference in ${origin}` +
      `${leafPath ? ` at '${leafPath}'` : ''}: the value opens a '{{resolve:...}}' reference that ` +
      `is ASSEMBLED by an intrinsic (an Fn::Sub placeholder inside it, or an Fn::Join that splits ` +
      `it across parts), so the reference does not exist as a complete expression until AFTER it ` +
      `is resolved — and its region therefore cannot be determined before resolution. This stack ` +
      `read across a region boundary (producer region(s) on record: ` +
      `${foreignProducerRegions.join(', ')}), so resolving it in '${stackRegion}' may look for a ` +
      `different region's secret: scrub would then miss the plaintext it exists to remove and ` +
      `report the stack clean. Refusing instead. Spell the reference as one complete literal ` +
      `'{{resolve:secretsmanager:<full ARN>:SecretString:...}}' — an ARN names its own region — ` +
      `then re-run 'cdkd scrub'.`,
    'SCRUB_SECRET_REFERENCE_UNCLASSIFIABLE'
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
  ctx: CrossRegionSecretContext,
  leafPath: string
): Promise<string> {
  // ONE spelling of the token scan, shared with `secret-redaction.ts` and the
  // rollback replay (issue #1936): a private regex here would answer a
  // different question from the one the resolver is about to ask.
  const tokens = dynamicReferenceTokens(leaf);
  // FIRST, before any classification: does every SECRET reference this leaf
  // OPENS exist as a complete, already-assembled token the scan could see? Two
  // tests, because the shapes fail in two different ways — see
  // {@link unclassifiableScrubSecretError} for the measured table, for the
  // false positive counting bare `{{resolve:` produced, and for why the guard
  // is gated on foreign-region evidence.
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
  const secretTokens = tokens.filter(isSecretReferenceToken);
  if (
    (countSecretReferenceOpenings(leaf) !== secretTokens.length ||
      secretTokens.some((token) => token.includes(SUB_PLACEHOLDER_OPENING))) &&
    ctx.foreignProducerRegions.length > 0
  ) {
    throw unclassifiableScrubSecretError(
      ctx.origin,
      leafPath,
      stackName,
      ctx.foreignProducerRegions,
      ctx.stackRegion
    );
  }
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
  // The PATH is carried for the refusal messages alone (issue #2109 review):
  // `origin` names the resource or output, and an assembled reference is often
  // one leaf of a large `Properties` bag, so "resource 'Db'" on its own leaves
  // the operator grepping. Built in the ordinary `a.b[0].c` spelling; empty at
  // the root, which is the shape a scalar `Export.Name` / output `Value` bag
  // has.
  const walk = async (v: unknown, path: string): Promise<unknown> => {
    if (typeof v === 'string') {
      // THIS LINE BOUNDS THE WHOLE PRE-PASS, guard included (issue #2109
      // review). Everything below — the region split AND the assembled-reference
      // refusal in `resolveForeignRegionTokens` — arms only when the RAW leaf
      // ITSELF carries a `{{resolve:` opening. A leaf whose opening is
      // CONTRIBUTED by another intrinsic is returned by identity here and never
      // reaches either, EVEN WITH a foreign producer region on record. So the
      // guard does NOT cover assembled references generally; it covers the ones
      // whose opening is visible in the template text.
      //
      // The reachable shape, measured: a parameter `DbSecretRef` whose `Default`
      // is a full foreign-ARN reference, used as
      // `MasterUserPassword: { "Fn::Sub": "${DbSecretRef}" }`. This walk sees
      // only `"${DbSecretRef}"`, returns it, and `resolveSub` then re-scans the
      // SUBSTITUTED string and resolves the reference on the PRIMARY resolver —
      // the stack is reported clean over the surviving plaintext. The same holds
      // for a `Ref` / `Fn::FindInMap` that yields the opening. Closing it needs
      // the resolver-side "classify AFTER assembly" fix, which is shared with
      // deploy and is tracked by issue
      // [#2134](https://github.com/go-to-k/cdkd/issues/2134).
      if (!v.includes(DYNAMIC_REFERENCE_OPENING)) return v;
      return await resolveForeignRegionTokens(v, stackName, ctx, path);
    }
    if (Array.isArray(v)) {
      const out: unknown[] = new Array(v.length) as unknown[];
      let changed = false;
      for (let i = 0; i < v.length; i++) {
        out[i] = await walk(v[i], `${path}[${i}]`);
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
        out[k] = await walk(val, path ? `${path}.${k}` : k);
        if (out[k] !== val) changed = true;
      }
      return changed ? out : v;
    }
    return v;
  };
  return (await walk(bag, '')) as T;
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
  opts: { dryRun: boolean; roleArn?: string | undefined; logger: ReturnType<typeof getLogger> }
): Promise<{ recordsChanged: number; secretsFound: number; secretBearingKeys: number }> {
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
  try {
    const loaded = await stateBackend.getState(stack.stackName, region);
    if (!loaded) {
      logger.debug(`No state for ${stack.stackName} (${region}) — skipping`);
      return { recordsChanged: 0, secretsFound: 0, secretBearingKeys: 0 };
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
    const foreignProducerRegions = foreignRegionsOf(producerRegions, region);
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
          foreignProducerRegions,
          resolvers,
          recordedSecretValues,
          origin: `resource '${logicalId}'`,
        }
      );
      try {
        await resolver.resolve(resolveInput, {
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
        // Issue #2109, same treatment as the resource bag above and outside the
        // catch for the same reason. An `Export.Name` is rarely secret-bearing,
        // but the region question is the expression's, not the position's — and
        // this resolution's RESULT becomes a state key, so a wrong-region answer
        // here mis-keys the whole positioned outputs pass.
        const nameSource = await pinCrossRegionSecrets(declaredExportName, stack.stackName, {
          stackRegion: region,
          producerRegions,
          foreignProducerRegions,
          resolvers,
          recordedSecretValues: outputSecrets,
          origin: `Export.Name of output '${name}'`,
        });
        try {
          exportName = await resolver.resolve(nameSource, {
            template: stack.template,
            resources: state.resources,
            ...(Object.keys(parameters).length > 0 && { parameters }),
            ...(Object.keys(conditions).length > 0 && { conditions }),
            stackName: stack.stackName,
            // Records into the SAME map the value loop below fills, and that is
            // load-bearing rather than tidiness: this loop runs FIRST, so a
            // dynamic reference first resolved here warms the resolver's cache,
            // and its cache-hit arm re-records only what it can still prove is
            // secret. An unpinned ssm reference (#1901) would then be invisible
            // when the value loop meets it, and its plaintext would survive the
            // command that exists to remove it — `--dry-run --fail` reporting
            // CLEAN on a leaking stack.
            recordedSecretValues: outputSecrets,
            bestEffort: true,
          });
        } catch (err) {
          // No key to mark ambiguous — the name the deploy used is unknown and
          // could be any output's — so the whole source bag becomes untrusted.
          outputsSourceUntrusted = true;
          // MASKED, and this is the one of the three that prints at DEFAULT
          // verbosity: `nameSource` is a bag `pinCrossRegionSecrets` may
          // already have substituted a foreign plaintext into, so a resolver
          // error echoing its input reaches the terminal of a command whose
          // entire subject is removing that plaintext. `outputSecrets` is the
          // map that pin recorded into, so it is the right needle set.
          logger.warn(
            `Export.Name of output ${name} could not be resolved during scrub ` +
              `(${maskSecretsInText(err instanceof Error ? err.message : String(err), outputSecrets)}) — ` +
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
      // Issue #2109, same treatment and same placement as the two above. The
      // POSITION source written just above is the ORIGINAL `value`, never this
      // copy: `redactSecretsForState` reads UNRESOLVED expressions off it.
      const valueSource = await pinCrossRegionSecrets(value, stack.stackName, {
        stackRegion: region,
        producerRegions,
        foreignProducerRegions,
        resolvers,
        recordedSecretValues: outputSecrets,
        origin: `output '${name}'`,
      });
      try {
        await resolver.resolve(valueSource, {
          template: stack.template,
          resources: state.resources,
          ...(Object.keys(parameters).length > 0 && { parameters }),
          ...(Object.keys(conditions).length > 0 && { conditions }),
          stackName: stack.stackName,
          recordedSecretValues: outputSecrets,
          bestEffort: true,
        });
      } catch (err) {
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
      return { recordsChanged: 0, secretsFound: 0, secretBearingKeys: 0 };
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
