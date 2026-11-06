import { parseContextOptions, warnIfDeprecatedRegion } from '../../options.js';
import { getLogger } from '../../../utils/logger.js';
import {
  Synthesizer,
  synthesisStatusMessage,
  type SynthesisOptions,
} from '../../../synthesis/synthesizer.js';
import { refuseFailedLookups } from '../../../synthesis/failed-lookups.js';
import { StageLoadError } from '../../../synthesis/failed-stages.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { LockManager } from '../../../state/lock-manager.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import { setAwsClients, AwsClients } from '../../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../../utils/role-arn.js';
import {
  exportInferredRegionForSdk,
  foldRegionOption,
  legacyStateBucketFallbackRegion,
  resolveEffectiveRegion,
} from '../../region-options.js';
import { resolveApp, resolveStateBucketWithDefault } from '../../config-loader.js';
import { matchStacks, describeStack, renderNoStackMatch } from '../../stack-matcher.js';
// An export NAME is a template-controlled RESOLVED value and an index read's
// error message interpolates a bucket / key, so both reach the terminal only
// through the same control-byte strip `export-index-store.ts` uses for the
// name it logs.
import { displayStackName, safeMsg } from '../../../utils/display-safe.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import { ScrubRefusalError } from './errors.js';
import { nestedStackPatternHint } from './nested.js';
import { runScrubTargets } from './command-loop.js';
import { orderScrubTargets } from './cross-stack-refusals.js';

export interface ScrubOptions {
  app?: string;
  output: string;
  stateBucket?: string;
  statePrefix: string;
  stack?: string;
  all?: boolean;
  dryRun?: boolean;
  fail?: boolean;
  /** go-to-k/cdkd#2624: also purge the history of every record examined, rewritten or not. */
  purgeHistory?: boolean;
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
 * expression. No AWS resource is created, updated, or deleted. What it WRITES
 * is the state bucket: each targeted stack's state.json, and — since issue
 * [#2667](https://github.com/go-to-k/cdkd/issues/2667) — the entries a scrubbed
 * stack publishes in the shared exports index at
 * `{prefix}/_index/{region}/exports.json`, as a separate step after that
 * stack's state.json write. This is why it is a top-level command and not
 * `cdkd state scrub` — the `cdkd state ...` family operates on the state bucket
 * alone and deliberately needs no CDK code.
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
 * EVERY run. When nothing recorded the plaintext the value is never rewritten
 * onto a reference — the key is DROPPED instead, or kept when it may be a live
 * export alias (go-to-k/cdkd#4120, `planUnnamedOutputDrop`) — because a scrub
 * that cannot identify the needle must not guess:
 * `state.outputs` is re-applied VERBATIM to consumer stacks — by the exports
 * index (`src/state/export-index-store.ts`) and by `Fn::ImportValue` /
 * `Fn::GetStackOutput` (`src/deployment/intrinsic-resolver/{cross-stack,stack-output}.ts`) — so a
 * fabricated redaction ships a literal `{{resolve:...}}` token into a
 * consumer's own AWS call. (`cdkd drift` is NOT one of those readers: it reads
 * `state.resources`, never `state.outputs`.) See `redactUnaccountedOutputs`.
 *
 * NESTED CHILDREN (go-to-k/cdkd#2252). A nested stack is not a synth stack
 * artifact — it is a `nestedTemplates` entry on its parent's `StackInfo` — so
 * scrub reaches its `{parent}~{Child}` record THROUGH the parent: scrubbing a
 * stack scrubs every nested child under it, depth first, right after the
 * parent. The child's needles come from the parent: the parent's resolution of
 * the child's `Parameters` block is the only place the `{{resolve:...}}`
 * expression behind a `{Ref: <Param>}` in the child is visible, so that row's
 * per-resource bag is handed down as the child resolver's `inheritedSecrets`,
 * exactly as `NestedStackProvider.runChildDeploy` hands it to the child
 * engine. A child whose parameters cannot be derived is REFUSED (exit 2) when
 * its record exists, never reported clean — see `nestedChildRefusal`.
 *
 * That makes a FOURTH re-apply reader of `state.outputs` reachable:
 * `NestedStackProvider.buildOutputsAttributes` projects a CHILD record's
 * outputs into the PARENT's `Fn::GetAtt Outputs.X` attributes. It carries the
 * bound of the `Fn::ImportValue` / `Fn::GetStackOutput` readers and no wider
 * one: the parent's read site (`resolveGetAtt`) hands a value carrying
 * `{{resolve:` to the same re-resolution helper those two arms use (issue
 * #2055), so the child's outputs are exposed to exactly the substring residual
 * `allRecordedSecrets` documents for theirs.
 *
 * ORDERING: scrub matches the CURRENT resolved secret value against what state
 * holds, so run it BEFORE rotating. Once the secret is rotated, the value in
 * state no longer matches the current one and scrub cannot rewrite it. Only a
 * cross-stack read NAME left that way is REPORTED (go-to-k/cdkd#3382,
 * `findUnrepairedCrossStackReadNames`); elsewhere a rotated-away value is
 * invisible to scrub. To remove it, redeploy the stack (which rewrites the
 * record with the expression).
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

  // go-to-k/cdkd#2100: the profile's region when none is named, not a
  // `us-east-1` literal (`resolveEffectiveRegion`).
  const effectiveRegion = await resolveEffectiveRegion(options);
  exportInferredRegionForSdk(effectiveRegion);
  const region = effectiveRegion.region;
  const stateBucket = await resolveStateBucketWithDefault(
    options.stateBucket,
    region,
    legacyStateBucketFallbackRegion(effectiveRegion)
  );

  // go-to-k/cdkd#2100: the resolved region, explicitly. A region-less bag
  // follows the SDK's chain, which never reads AWS_DEFAULT_REGION, so it would
  // disagree with a region inferred from it.
  const awsClients = new AwsClients({
    region: effectiveRegion.region,
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
    failedLookupsCheckedByCaller: true,
  };
  // A CDK Stage that failed to load leaves the app partly unreadable, so the
  // run DECLINES TO LOOK: a refusal (exit 2), never a plain error, whose exit 1
  // is `--fail`'s "plaintext found -- rotate the secret" (#3507).
  let result: Awaited<ReturnType<typeof synthesizer.synthesize>>;
  try {
    result = await synthesizer.synthesize(synthOptions);
  } catch (error) {
    if (error instanceof StageLoadError) {
      throw new ScrubRefusalError(error.message, 'SCRUB_STAGE_LOAD_FAILED');
    }
    throw error;
  }
  const allStacks = result.stacks;

  const stackPatterns = stacks.length > 0 ? stacks : options.stack ? [options.stack] : [];
  if (allStacks.length === 0) {
    // Reached before the branch chain below, as in `deploy`: with zero stacks
    // and no pattern the `else` arm would answer `Multiple stacks found: .`,
    // and `--all` would answer `No stacks matched.`.
    throw new Error(renderNoStackMatch(stackPatterns, allStacks));
  }
  let targetStacks: StackInfo[];
  if (options.all) {
    targetStacks = allStacks;
  } else if (stackPatterns.length > 0) {
    // Every selected stack: two sharing a physical name in two regions are two
    // state records, each scrubbed in its own region (#5176).
    targetStacks = matchStacks(allStacks, stackPatterns, { dedupe: 'identity' });
  } else if (allStacks.length === 1) {
    targetStacks = allStacks;
  } else {
    throw new Error(
      `Multiple stacks found: ${allStacks.map(describeStack).join(', ')}. ` +
        `Specify stack name(s) or use --all`
    );
  }
  if (targetStacks.length === 0) {
    // The shared renderer names the patterns and the available stacks. A
    // pattern spelling a nested child's state name (`<parent>~<Child>`) earns
    // one more line: a child is not a synth stack, and it is scrubbed with its
    // parent (go-to-k/cdkd#2252).
    const nestedSpellings = stackPatterns.filter((p) => p.includes('~'));
    const nestedHint =
      nestedSpellings.length > 0 ? ` ${nestedStackPatternHint(nestedSpellings)}` : '';
    throw new Error(`${renderNoStackMatch(stackPatterns, allStacks)}${nestedHint}`);
  }
  // The same hint when OTHER patterns matched (review of go-to-k/cdkd#3958):
  // `matchStacks` drops a pattern that matches nothing, so `Parent~Child
  // Other` would scrub `Other` alone, silently leaving the child unvisited.
  const unmatchedNested = stackPatterns.filter(
    (p) => p.includes('~') && matchStacks(allStacks, [p]).length === 0
  );
  if (unmatchedNested.length > 0) {
    logger.warn(
      safeMsg`${unmatchedNested.map((p) => displayStackName(p)).join(', ')} matched no stack and was NOT scrubbed. ${nestedStackPatternHint(unmatchedNested)}`
    );
  }
  // A failed context lookup blocks only the stacks it scrubs (go-to-k/cdkd#5807).
  refuseFailedLookups(targetStacks, allStacks, result.failedLookups);

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
  // The account flags each malformed-record refusal or warning prints on its
  // `cdkd state show` / `cdkd state list` pointers, so a pasted command reads
  // the bucket this run read (go-to-k/cdkd#4159).
  const refusalRecovery: LockRecoveryContext = {
    profile: options.profile,
    stateBucket,
    statePrefix: options.statePrefix,
  };
  const stateS3 = new AwsClients({
    region,
    ...(options.profile && { profile: options.profile }),
  });
  const stateBackend = new S3StateBackend(stateS3.s3, stateConfig, {
    region,
    ...(options.profile && { profile: options.profile }),
  });
  const lockManager = new LockManager(stateS3.s3, stateConfig);
  await runScrubTargets({
    options,
    logger,
    effectiveRegion,
    region,
    stateBucket,
    allStacks,
    targetStacks,
    refusalRecovery,
    stateS3,
    stateBackend,
    lockManager,
  });
}
