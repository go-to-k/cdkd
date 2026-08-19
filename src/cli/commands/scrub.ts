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
  MIN_NEEDLE_LENGTH,
  type RecordedSecretValues,
} from '../../deployment/secret-redaction.js';
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
  // Counted SEPARATELY from the stacks actually rewritten. A key-holding-
  // plaintext finding is a finding the command cannot remedy (issue #1919), and
  // folding it into the scrubbed count made the summary claim a remediation it
  // had not performed — the same invariant the export-name warning enforces:
  // a message must never assert what it did not do.
  let totalStacksWithUnscrubbableKeys = 0;

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
    logger.info('\nNo plaintext secrets found in any target stack state. Nothing to scrub.');
    return;
  }

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
          `(--dry-run, no state written).${keyNote} ROTATE any exposed secret in Secrets Manager.`
      );
    } else {
      logger.info(`\nPlan: nothing can be scrubbed.${keyNote} ROTATE any exposed secret.`);
    }
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
        `value, so scrub BEFORE rotating).${keyNote}`
    );
  } else {
    logger.info(`\nNothing could be rewritten.${keyNote} ROTATE any exposed secret.`);
  }
  // `--fail` is documented as a --dry-run CI gate, but a REAL run over a
  // key-only leak would otherwise exit 0 — and that is the one finding class a
  // real run cannot fix, so exiting clean is exactly backwards.
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
  try {
    const loaded = await stateBackend.getState(stack.stackName, region);
    if (!loaded) {
      logger.debug(`No state for ${stack.stackName} (${region}) — skipping`);
      return { recordsChanged: 0, secretsFound: 0, secretBearingKeys: 0 };
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
        try {
          exportName = await resolver.resolve(declaredExportName, {
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
          logger.warn(
            `Export.Name of output ${name} could not be resolved during scrub (${err instanceof Error ? err.message : String(err)}) — ` +
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
    const positionedOutputs =
      outputSecrets.size > 0
        ? redactSecretsForState(
            state.outputs,
            outputSecrets,
            outputsSourceUntrusted ? undefined : outputsTemplateSource
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
