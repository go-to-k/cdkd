import { Command, InvalidArgumentError, Option } from 'commander';
import { DEFAULT_STATE_PREFIX } from './commands/state-file-keys.js';
import { nullPrototypeRecord } from '../utils/own-keys.js';
import { removeProtectionTypeList } from '../provisioning/remove-protection-types.js';
import { resourceTimeoutOptions } from './options/resource-timeout.js';
import { parsePositiveIntegerOption } from './arg-parser.js';
import {
  allowUnsupportedTypesOption,
  preferSdkRouteOption,
  allowUnsupportedPropertiesOption,
  recreateViaCcApiOption,
  pinCcApiOption,
  recreateViaSdkProviderOption,
} from './options/provisioning-route.js';

export {
  parseDuration,
  resourceTimeoutOptions,
  validateResourceTimeouts,
  effectiveResourceTimeoutMs,
} from './options/resource-timeout.js';
export type { ResourceTimeoutOption } from './options/resource-timeout.js';
export {
  parseAllowUnsupportedTypesToken,
  allowUnsupportedTypesOption,
  parsePreferSdkRouteToken,
  resetDeprecatedAliasWarning,
  parseAllowUnsupportedPropertiesToken,
  preferSdkRouteOption,
  allowUnsupportedPropertiesOption,
  parseRecreateViaCcApiToken,
  recreateViaCcApiOption,
  parseRecreateViaSdkProviderToken,
  parsePinCcApiToken,
  pinCcApiOption,
  recreateViaSdkProviderOption,
} from './options/provisioning-route.js';
export {
  parseAssumeRoleToken,
  normalizeStartApiAssumeRole,
  effectiveAssumeRoleArn,
} from './options/assume-role.js';
export type { AssumeRoleOption } from './options/assume-role.js';

/**
 * Parse context key=value pairs from CLI arguments into a Record
 */
export function parseContextOptions(contextArgs?: string[]): Record<string, string> {
  // Null prototype: on a `{}` literal `-c __proto__=x` ran `Object.prototype`'s
  // setter and the value never reached the app, the same class the synth
  // context loop had (issue [#3522](https://github.com/go-to-k/cdkd/issues/3522)).
  const context = nullPrototypeRecord<string>();
  if (contextArgs) {
    for (const arg of contextArgs) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex > 0) {
        context[arg.substring(0, eqIndex)] = arg.substring(eqIndex + 1);
      }
    }
  }
  return context;
}

/**
 * Common CLI options.
 *
 * Note: `--region` is intentionally NOT in `commonOptions`. Since PR 3
 * (dynamic region resolution) and PR 4 (region-free default state bucket
 * name), `--region` no longer has a useful role on most commands. It is
 * still required by `cdkd bootstrap` (which needs to know where to create
 * a new bucket) and is added directly there. Other commands accept it for
 * backward compatibility via `deprecatedRegionOption` and emit a
 * deprecation warning when it is passed; the value is otherwise ignored.
 */
export const commonOptions = [
  new Option('--verbose', 'Enable verbose logging').default(false),
  new Option('--profile <profile>', 'AWS profile'),
  new Option(
    '--role-arn <arn>',
    'IAM role ARN to assume for AWS API calls (env: CDKD_ROLE_ARN); the role needs the actions for the resource types you deploy plus the bookkeeping actions cdkd itself issues, because cdkd makes raw service API calls and does not route through CloudFormation, so CDK CLI deploy-roles will NOT work. Combines with --profile: the profile supplies the base credentials the role is assumed FROM, and the role is what every later AWS call runs as'
  ),
  new Option(
    '-y, --yes',
    'Automatically answer interactive prompts with the recommended response (e.g. confirm destroy)'
  ).default(false),
];

/**
 * Deprecated `--region` option attached to non-bootstrap commands.
 *
 * Kept (rather than fully removed) so that scripts or muscle memory passing
 * `--region` do not break. The value IS still honored — every non-bootstrap
 * command consumes `options.region` as the highest-precedence region source
 * (`--region` -> `AWS_REGION` -> `AWS_DEFAULT_REGION` -> the profile's region
 * -> `us-east-1`, `resolveEffectiveRegion`, issues #2029 / #2100; the value is
 * folded to its canonical spelling at each handler's entry, issue #2065): it
 * sets the region of the
 * provisioning / state-bucket SDK clients, the `applyRoleArnIfSet` STS hop,
 * and (for `deploy` / `destroy` / `import` / `export` / `orphan`) the
 * `AWS_REGION` env var inherited by the CDK synth subprocess. The flag is
 * *deprecated* — the recommended way to choose the region is `AWS_REGION` or
 * your AWS profile — but passing it is NOT a no-op. See
 * `warnIfDeprecatedRegion` for the runtime warning. Final removal is
 * tracked in PR 99 (see `docs/plans/05-region-flag-cleanup.md`).
 */
export const deprecatedRegionOption = new Option(
  '--region <region>',
  '[deprecated] Prefer AWS_REGION or your AWS profile; --region is still honored but will be removed in a future release'
).hideHelp();

/**
 * Emit a one-shot stderr warning when a non-bootstrap command receives
 * `--region`. The flag is deprecated in favor of `AWS_REGION` / profile, but
 * — contrary to an earlier message that claimed "no effect" — it is NOT a
 * no-op: every non-bootstrap command consumes `options.region` as the
 * highest-precedence region source (see `deprecatedRegionOption`). So the
 * warning steers users toward the recommended mechanism WITHOUT falsely
 * telling them their flag had no effect (issue #818).
 */
export function warnIfDeprecatedRegion(options: { region?: string }): void {
  if (options.region !== undefined) {
    process.stderr.write(
      'Warning: --region is deprecated and will be removed in a future release. ' +
        'It is still honored for now (it overrides AWS_REGION / your AWS profile), ' +
        'but prefer the AWS_REGION environment variable or your AWS profile to choose the region.\n'
    );
  }
}

/**
 * App options
 *
 * --app is optional: falls back to CDKD_APP env var, then cdk.json "app" field.
 * Accepts either a shell command (e.g. "node app.ts") or a path to a
 * pre-synthesized cloud assembly directory (e.g. "cdk.out").
 */
export const appOptions = [
  new Option(
    '-a, --app <command>',
    'CDK app command (e.g., "node app.ts") or path to a pre-synthesized cloud assembly directory. Falls back to cdk.json or CDKD_APP env'
  ),
  new Option('--output <path>', 'Output directory for synthesis').default('cdk.out'),
];

/**
 * State backend options
 *
 * --state-bucket is optional: falls back to CDKD_STATE_BUCKET env var,
 * then cdk.json context.cdkd.stateBucket
 */
export const stateOptions = [
  new Option(
    '--state-bucket <bucket>',
    'S3 bucket for state storage. Falls back to CDKD_STATE_BUCKET env or cdk.json'
  ),
  new Option('--state-prefix <prefix>', 'S3 key prefix for state files')
    .default(DEFAULT_STATE_PREFIX)
    .argParser(parseStatePrefix),
];

/**
 * Refuse a `--state-prefix` holding `<` or `>`, and return every other value
 * VERBATIM (an empty one included: `--state-prefix ''` keys records under `/`,
 * and a rewrite would desynchronise every printed hint from the key it
 * selects).
 *
 * The refusal is what makes cdkd's `'<prefix>'` placeholder fail CLOSED. A
 * pasted hint prints that placeholder where the run's prefix cannot be shown
 * safely, and unrefused it is a valid key prefix: `cdkd deploy --state-prefix
 * '<prefix>'` would find no state and CREATE every resource again
 * (go-to-k/cdkd#4177's review).
 */
export function parseStatePrefix(value: string): string {
  if (value.includes('<') || value.includes('>')) {
    throw new InvalidArgumentError(
      "a state prefix cannot contain '<' or '>': that is a placeholder cdkd printed in a " +
        'suggested command for a value it could not show. Replace it with your actual prefix.'
    );
  }
  return value;
}

/**
 * Stack options
 */
export const stackOptions = [new Option('--stack <name>', 'Stack name to operate on')];

/**
 * Commander `argParser` for `--stack-region` (issue #2556).
 *
 * Refuses a value carrying no region name at all, at PARSE time rather than
 * in each consumer. `--stack-region ''` is falsy, so every consumer that
 * tested the option for truthiness read it as ABSENT — and absent means "all
 * regions" on the commands that take `--all`, so a flag passed to NARROW a
 * destructive operation silently WIDENED it. `drift --all --revert
 * --stack-region ''` wrote cdkd state values into AWS across every stack in
 * every region.
 *
 * Here rather than in the consumers because there are more consumers than
 * declarations, the value is threaded through helpers that cannot see how it
 * was spelled, and the empty value has no legitimate meaning — so it never
 * needs to reach them. `guardStackRegionOptions` extends the same guard to
 * declarations cdkd does not own.
 *
 * The rule is only "this is not a name": empty and whitespace-only are
 * refused, and everything else is passed through UNCHANGED — cdkd keeps no
 * list of region names, so a value that looks wrong is the caller's to own,
 * and trimming one would be the silent reinterpretation this whole class
 * started as.
 */
export function parseStackRegion(value: string): string {
  if (value.trim() === '') {
    throw new InvalidArgumentError(
      `expected a region name (e.g. us-east-1), got ${value === '' ? 'an empty value' : 'whitespace only'}. ` +
        'Omit the flag entirely to operate on every region a stack has state in.'
    );
  }
  return value;
}

/**
 * Attach {@link parseStackRegion} to every `--stack-region` the command tree
 * carries, including ones cdkd never declared.
 *
 * `cdkd local start-{service,alb,cloudfront,agentcore}` inherit the option
 * from cdk-local, so there is no declaration in this repo to hang a parser on
 * and a grep for the flag string does not find them. They are the worst place
 * to miss it: cdk-local resolves the CloudFormation client's region with
 * `options.stackRegion ?? options.region ?? AWS_REGION`, and `''` is not
 * nullish — so an empty value WINS over both fallbacks and reaches the client.
 *
 * Idempotent, and it never replaces a parser a declaration already set.
 */
export function guardStackRegionOptions(cmd: Command): void {
  for (const option of cmd.options) {
    if (option.long === '--stack-region' && option.parseArg === undefined) {
      option.argParser(parseStackRegion);
    }
  }
  for (const sub of cmd.commands) guardStackRegionOptions(sub);
}

/**
 * Skip waiting for async-stabilization resources (RDS, ElastiCache,
 * NAT Gateway, EC2 Instance, ELBv2 LoadBalancer, Lambda MicroVM Image,
 * ECS Service steady state) on deploy. Setting the flag mutates
 * `process.env.CDKD_NO_WAIT='true'`; provider code checks that env
 * var, not the parsed CLI option (this lets nested call paths — e.g.
 * asset publish, lifecycle hooks — see the same setting without
 * threading the flag through every function signature).
 *
 * CloudFront Distribution left this list with issue #1282: its
 * `Deployed` wait is skipped by DEFAULT now, so under `--no-wait` it
 * simply behaves the same as the default (`--full-wait` opts back in).
 * ECS Service joined it with go-to-k/cdkd#5571: its steady-state wait is
 * the default now, because a failing rollout surfaces only there.
 *
 * Deploy-only. NAT Gateway destroy always waits regardless (a
 * still-`deleting` gateway blocks downstream Subnet / IGW / VPC
 * delete with DependencyViolation), RDS / ElastiCache destroy paths
 * don't wait to begin with, and CloudFront's destroy-side
 * disable-then-wait is an API requirement no flag may skip — so
 * `destroy --no-wait` would be a no-op flag.
 */
export const noWaitOption = new Option(
  '--no-wait',
  'Skip waiting for async resources to stabilize (RDS, ElastiCache, NAT Gateway, EC2 Instance, ELBv2 LoadBalancer, Lambda MicroVM Image, ECS Service steady state)'
);

/**
 * Opt in to the stabilization waits cdkd deliberately SKIPS by default.
 * Today that is CloudFront Distribution `Deployed` (create and update;
 * both engines wait, but once the call is accepted the outcome is
 * settled — configuration errors are refused by the call itself — and the
 * wait changes only WHEN the edges serve it, never WHETHER: the fast-side
 * clause, issue #1282), and a Multi-AZ RDS DB cluster leaving
 * `storage-optimization` after an instance class or storage change (the
 * cluster already serves on the new class and storage; go-to-k/cdkd#5639;
 * a long optimization needs `--resource-timeout AWS::RDS::DBCluster=<n>h`).
 * ECS Service steady state is NOT in this list: its
 * outcome is still open when `CreateService` / `UpdateService` returns, so
 * the default waits for it (go-to-k/cdkd#5571).
 *
 * `--no-wait`, the default, and `--full-wait` are three points on one
 * axis, from least to most waiting:
 *
 * - `--no-wait`      skip the stabilization waits cdkd performs by default
 * - (default)        wait where the outcome is still open when the API
 *                    call returns (a later step needs the result, or the
 *                    resource can still fail)
 * - `--full-wait`    also wait everywhere CloudFormation waits
 *
 * Which one is right depends on whether anything downstream needs the
 * resource to actually be serving, NOT on where the deploy runs: cutting
 * billed CI minutes is a legitimate reason to pass `--no-wait` in CI, and
 * a local smoke test is a legitimate reason to pass `--full-wait` on a
 * laptop.
 *
 * Setting the flag mutates `process.env.CDKD_FULL_WAIT='true'`, the same
 * mechanism `--no-wait` uses, so nested call paths see it without
 * threading it through every signature.
 *
 * Mutually exclusive with `--no-wait` (see {@link validateWaitFlags}).
 * Per-resource-type wait control is deliberately NOT expressible with
 * these two whole-run flags; that would be a separate feature.
 *
 * Deploy-only, like `--no-wait`.
 */
export const fullWaitOption = new Option(
  '--full-wait',
  'Also wait for stabilizations cdkd skips by default, matching CloudFormation (CloudFront Distribution Deployed, RDS Multi-AZ DB cluster storage optimization; raise --resource-timeout AWS::RDS::DBCluster for a long one)'
);

/**
 * Reject `--no-wait --full-wait`. They sit at opposite ends of one axis,
 * so a combination has no coherent meaning: the user is asking to both
 * skip waits and add waits in the same run.
 *
 * Note the Commander shape: `--no-wait` is the negation form of a boolean
 * `wait` option, so it surfaces as `wait === false` rather than as a
 * `noWait` key.
 */
export function validateWaitFlags(opts: { wait?: boolean; fullWait?: boolean }): void {
  if (opts.wait === false && opts.fullWait === true) {
    throw new Error(
      '--no-wait and --full-wait cannot be combined: --no-wait skips stabilization waits, --full-wait adds them. Pick one.'
    );
  }
}

/**
 * Validate the wait-flag pair and project it onto the process env the
 * providers read. One helper instead of three separate lines in deploy.ts
 * so the validation, the two mode envs, and the availability marker cannot
 * drift apart individually (issue #1291 item 6 — the wiring had no unit
 * coverage because it lived inline in the deploy command's action).
 *
 * - `CDKD_NO_WAIT` — set when `--no-wait` was passed; providers skip
 *   convenience stabilization waits.
 * - `CDKD_FULL_WAIT` — set when `--full-wait` was passed; providers add
 *   the CloudFormation-side waits cdkd skips by default.
 * - `CDKD_WAIT_FLAGS_AVAILABLE` — set unconditionally by commands that
 *   DECLARE the wait flags (today: deploy). Providers gate flag-mentioning
 *   hints on it, so `cdkd drift --revert` reaching the same provider code
 *   never advertises a flag drift does not accept (issue #1291 item 1).
 */
export function applyWaitFlagEnv(opts: { wait?: boolean; fullWait?: boolean }): void {
  validateWaitFlags(opts);
  process.env['CDKD_WAIT_FLAGS_AVAILABLE'] = 'true';
  if (opts.wait === false) {
    process.env['CDKD_NO_WAIT'] = 'true';
  }
  if (opts.fullWait === true) {
    process.env['CDKD_FULL_WAIT'] = 'true';
  }
}

/**
 * Drop the CDK-injected defensive `DependsOn` edges from VPC Lambdas (and
 * adjacent IAM Role / Policy / Lambda::Url / EventSourceMapping resources)
 * onto the private subnet's `DefaultRoute` / `RouteTableAssociation`. CDK
 * adds these conservatively for runtime egress, but `CreateFunction` /
 * `CreateFunctionUrlConfig` / `AddPermission` / `CreateEventSourceMapping`
 * all accept a function in `Pending` state — relaxing the edges lets
 * downstream resources (notably `CloudFront::Distribution` whose Origin is
 * a Function URL) start their own ~3-min propagation in parallel with NAT
 * GW stabilization. Measured −54.6% on `bench-cdk-sample` (398.59s → 181.03s).
 *
 * **On by default.** This is the conservative-pessimist trap that PR #126
 * v1 fell into: shipping the optimization opt-in meant users had to know
 * about a flag to get the win, which defeats the point. Burn-in via
 * `/run-integ bench-cdk-sample --deploy-args "--aggressive-vpc-parallel"`
 * already validated the AWS-side behavior end-to-end. Pass
 * `--no-aggressive-vpc-parallel` to opt out (escape hatch for stacks where
 * the user wants the strict CDK-defensive ordering — e.g. a Custom Resource
 * that synchronously invokes a VPC Lambda outside of cdkd's
 * Lambda-ServiceToken Active wait).
 *
 * Deploy-only. The relaxation has no effect on destroy ordering (CDK route
 * DependsOn doesn't constrain delete-time correctness — Lambda hyperplane
 * ENI release is the actual destroy bottleneck and is handled separately
 * by `lambda-vpc-deps.ts`).
 *
 * See `src/analyzer/cdk-defensive-deps.ts` for the type-pair allowlist.
 */
export const aggressiveVpcParallelOption = new Option(
  '--no-aggressive-vpc-parallel',
  'Disable the default relaxation of CDK-injected VPC route DependsOn (on by default; opt out to keep the strict CDK ordering)'
);

/**
 * Issue [#615] — `--force-stateful-recreation` (boolean) confirms a
 * data-losing destroy + recreate of a stateful resource (RDS / DynamoDB /
 * EFS / S3 with data / etc.).
 *
 * It started as the second flag `--recreate-via-cc-api` needs, and that
 * two-flag shape still holds for the `--recreate-via-*` / `--replace`
 * opt-ins. But the guard now runs on the mid-deploy replacement paths
 * too — not only the flag-gated ones, and with its own exemptions (a
 * property-driven replacement under `UpdateReplacePolicy: Retain` creates
 * first, so it is skipped there) (see
 * `docs/cli-deploy-safety.md#stateful-resource-guard`), and some of them
 * reach a replacement with NO flag at all: a property-driven replacement
 * (an immutable / createOnly property changed in the template) and the
 * update-failure fallback's Cloud Control trigger (issue [#2514]). On
 * those, a plain `cdkd deploy` asks for this flag on its own — so the
 * help text must not describe it as scoped to `--recreate-via-cc-api`
 * targets.
 *
 * The guard list of "stateful" types lives in
 * `src/provisioning/stateful-types.ts` so it can be queried from both
 * the CLI pre-flight and the deploy engine, and it is published — as the
 * only enumeration users read — in `docs/cli-deploy-safety.md`, which a
 * set-equality fence keeps in step with the source. Prose elsewhere
 * (this help string included) names EXAMPLES and points there; it must
 * not read as exhaustive, because a widened guard would silently make it
 * wrong.
 *
 * There is no per-resource granularity on the force flag — when set,
 * EVERY named recreate target bypasses the stateful guard. Per-resource
 * force would create a false sense of granularity (the user is opting
 * into a footgun; pretending to scope it per-resource is misleading).
 */
export const forceStatefulRecreationOption = new Option(
  '--force-stateful-recreation',
  'Confirm a data-losing destroy + recreate of a stateful resource. Required ' +
    'whenever a replacement target is a stateful type on the ' +
    '--recreate-via-cc-api / --recreate-via-sdk-provider pre-flight, with ' +
    '--replace, AND on the paths a plain deploy reaches with no flag: a ' +
    'template immutable-property change, and an in-place update the ' +
    'provisioning layer rejects. Stateful types are databases, filesystems, ' +
    'KMS keys, table / vector storage, source repositories, and more; ' +
    'https://cdkd.dev/cli-deploy-safety/ carries the full list. S3 buckets and log ' +
    'groups are the conditional cases: at pre-flight, a non-empty bucket, or ' +
    'a log group with retention, with log streams, or whose emptiness the ' +
    'probe could not settle; mid-deploy, ANY bucket or log group, because the ' +
    'emptiness probe cannot run there. The two probes differ on failure — the ' +
    'bucket fails open, the log group closed. Destroy + recreate loses ALL ' +
    'data in the resource — no automatic data migration. Full opt-in for CI ' +
    "use: --recreate-via-cc-api '<id>' --force-stateful-recreation --yes."
).default(false);

export const replaceOption = new Option(
  '--replace',
  'Replace (DELETE + CREATE) a resource whose in-place update is rejected because an ' +
    'immutable property changed and AWS exposes no update API for it (e.g. Lambda LayerVersion ' +
    'content, EFS AccessPoint, ECS TaskDefinition, ApiGatewayV2 immutable fields). Without this ' +
    'flag such a change fails the deploy. Stateful types (RDS / DynamoDB / EFS / any S3 bucket / ' +
    'any Logs log group / etc.) ALSO require --force-stateful-recreation since the replacement ' +
    'is a data-losing DELETE + CREATE — mid-deploy neither emptiness probe can run, so both ' +
    'conditional types count as stateful there.'
).default(false);

/**
 * Issue #1002 PR 2 — per-invocation legacy pin for asset destinations
 * (design §4.2). Shared by `deploy`, `diff`, `import`, and `publish-assets`
 * (every command the redirection / rewrite affects) so the CLI surface stays
 * consistent; the per-app pin is `cdk.json context.cdkd.useCdkBootstrapAssets`
 * (see `resolveUseCdkBootstrapAssets` in config-loader.ts).
 */
export const useCdkBootstrapAssetsOption = new Option(
  '--use-cdk-bootstrap-assets',
  'Publish assets to the CDK bootstrap bucket/repo named by the asset manifest verbatim, ' +
    'skipping the cdkd asset-storage redirection even when this region is opted in via ' +
    "'cdkd bootstrap'. For apps deployed via both CloudFormation and cdkd during a migration " +
    'window. Per-app pin: cdk.json context.cdkd.useCdkBootstrapAssets. Also suppresses the ' +
    "legacy-mode 'cdk gc' notice."
).default(false);

/**
 * Issue #1111 — `--strict-getatt` (deploy only). By default, an
 * `Fn::GetAtt` for an attribute cdkd cannot construct falls back to the
 * resource's physical ID with a warning (hard-failing only on knowably-wrong
 * shapes: `*Arn` attributes with a non-ARN fallback, `*Url` with a
 * non-http(s) fallback — issue #1106). This flag promotes EVERY such
 * fallback to a hard error, and additionally fails the deploy when a stack
 * Output cannot be resolved (default: warn and store no value).
 */
export const strictGetattOption = new Option(
  '--strict-getatt',
  'Fail the deploy on ANY Fn::GetAtt that falls back to the physical ID because cdkd cannot ' +
    'construct the attribute (default: warn and use the physical ID, hard-failing only when ' +
    'the fallback is knowably wrong — an *Arn attribute with a non-ARN value or a *Url ' +
    'attribute with a non-http(s) value). Also fails the deploy when a stack Output cannot ' +
    'be resolved (default: warn and store no value).'
).default(false);

/**
 * Issue [#1960](https://github.com/go-to-k/cdkd/issues/1960) —
 * `--allow-unaddressed` (deploy only). A deploy that finishes having left a
 * resource cdkd was responsible for ALIVE in AWS and no longer in state exits
 * 2 (partial failure), matching what `cdkd destroy` has done for the identical
 * outcome since issue #1752. Two cases produce it:
 *
 *  - a skipped DELETE (issue #1762) — a resource removed from the template
 *    whose provider could not issue the delete, typically because the state
 *    record is malformed (see `src/provisioning/composite-id.ts`);
 *  - a partial UPDATE (issue #1819) — a replacement whose new resource was
 *    created and whose OLD one survives untracked, most commonly an ACM
 *    certificate a consumer still references.
 *
 * This flag forces exit 0 for both. It exists because the partial-UPDATE case
 * has a legitimate not-yet-fixable window: an ACM replacement blocked on
 * `DescribeCertificate.InUseBy` clears itself once the consumer (e.g. a
 * CloudFront distribution in another stack) finishes updating, so a pipeline
 * can be red for a cause it cannot act on. Wrapping the command in a shell
 * exit-code test is NOT an equivalent workaround — `cdkd deploy` also exits 2
 * for `MacroExpansionError` and `ResourceUpdateNotSupportedError`, so a
 * `|| [ $? -eq 2 ]` wrapper silences unrelated real failures; this flag is
 * scoped to the one cause.
 *
 * The flag suppresses only the EXIT CODE. The summary rows
 * (`Skipped (not deleted)` / `of which left an orphaned predecessor` /
 * `Left an orphaned predecessor in a nested stack`), the
 * per-resource warnings, and the `RunCounts.skipped` figure in `cdkd events`
 * are all emitted unchanged, so a run that used it still says in its log that
 * a resource survived.
 */
export const allowUnaddressedOption = new Option(
  '--allow-unaddressed',
  'Exit 0 even when the deploy left a resource unaddressed — a DELETE the provider could ' +
    'not issue, or a replacement whose old resource survives untracked (default: exit 2, ' +
    'matching cdkd destroy). The summary rows and warnings are printed either way; only the ' +
    'exit code changes.'
).default(false);

/**
 * Issue #1697 — `--no-cfn-fallback` (deploy + diff). By default, a
 * cross-stack reference (`Fn::ImportValue` / `Fn::GetStackOutput`) that is
 * not found in cdkd state falls back to CloudFormation (`ListExports` /
 * `DescribeStacks` outputs) so a cdkd-deployed consumer can reference a
 * producer stack still managed by CloudFormation (`cdk deploy` / raw CFn).
 * The fallback fires only after a cdkd-state miss (cdkd-first precedence),
 * resolves as a WEAK reference (not recorded into `state.imports` /
 * `state.outputReads`; no destroy-time protection on either side), and
 * degrades gracefully when the caller lacks the CloudFormation read
 * permissions (warning + the original not-found error). This flag disables
 * the fallback entirely for users who want cdkd-state-only resolution —
 * e.g. to keep IAM minimal or to keep an export-name typo failing fast
 * instead of accidentally matching an unrelated CloudFormation export.
 */
export const noCfnFallbackOption = new Option(
  '--no-cfn-fallback',
  'Do not fall back to CloudFormation (ListExports / stack outputs) when an Fn::ImportValue / ' +
    'Fn::GetStackOutput reference is not found in cdkd state (default: fall back, so producers ' +
    'still managed by CloudFormation can be referenced)'
);

/**
 * CDK annotation-message behavior flags (issue #1230, CDK CLI parity).
 * Shared by `cdkd synth` and `cdkd deploy` — the two commands that fail on
 * `Annotations.addError` (issue #1228). `--strict` additionally fails when
 * any WARNING annotation exists (`Found warnings (--strict mode)`);
 * `--ignore-errors` displays every message but never fails the run. When
 * both are passed, strict wins (matches the CDK CLI's failAt resolution).
 */
export const annotationMessageOptions = [
  new Option('--strict', 'Do not proceed with stacks carrying warning annotations').default(false),
  new Option(
    '--ignore-errors',
    'Ignore error annotations from stack synthesis, which will likely produce an invalid deployment'
  ).default(false),
];

/**
 * `-e, --exclusively`, shared by `cdkd deploy` and `cdkd destroy` (CDK CLI
 * parity). Selection is widened along the cloud assembly's stack dependencies
 * by default: deploy adds the stacks a selected stack DEPENDS ON (upstream),
 * destroy adds the stacks that depend ON a selected stack (downstream,
 * go-to-k/cdkd#6115). The flag keeps the selection to the named stacks.
 */
export function exclusivelyOption(command: 'deploy' | 'destroy'): Option {
  return new Option(
    '-e, --exclusively',
    command === 'deploy'
      ? 'Only deploy requested stacks, do not include dependencies'
      : 'Only destroy requested stacks, do not include the stacks that depend on them'
  ).default(false);
}

export const deployOptions = [
  // go-to-k/cdkd#5242: measured on 48 independent resources, Cloud Control
  // route: the resource DAG took 103s at 10, 68s at 20, and 72s at 30, where
  // Cloud Control began answering with retryable failures.
  new Option('--concurrency <number>', 'Maximum concurrent resource operations')
    .default(20)
    .argParser(parsePositiveIntegerOption),
  new Option('--stack-concurrency <number>', 'Maximum concurrent stack deployments')
    .default(4)
    .argParser(parsePositiveIntegerOption),
  new Option(
    '--asset-publish-concurrency <number>',
    'Maximum concurrent asset publish operations (S3 uploads + ECR push)'
  )
    .default(8)
    .argParser(parsePositiveIntegerOption),
  new Option('--image-build-concurrency <number>', 'Maximum concurrent Docker image builds')
    .default(4)
    .argParser(parsePositiveIntegerOption),
  new Option('--dry-run', 'Show changes without applying').default(false),
  new Option('--skip-assets', 'Skip asset publishing').default(false),
  new Option('--no-rollback', 'Skip rollback on deployment failure'),
  // Issue #1007 — deploy-only (diff / import / publish-assets never create
  // resources). Per-app opt-out: cdk.json context.cdkd.autoAssetStorage:
  // false (see resolveAutoAssetStorage in config-loader.ts).
  new Option(
    '--no-auto-asset-storage',
    'Do not auto-create cdkd-owned asset storage (asset bucket + container-asset ECR repo + ' +
      "marker) on the first deploy into a region not yet opted in via 'cdkd bootstrap'. " +
      'Deploys into such regions stay in legacy mode (CDK bootstrap destinations). ' +
      'Per-app opt-out: cdk.json context.cdkd.autoAssetStorage: false.'
  ),
  new Option(
    '--no-capture-observed-state',
    'Skip capturing AWS-current properties after each create/update ' +
      '(adds a fire-and-forget readCurrentState per resource so cdkd drift can ' +
      'compare against the real deploy-time AWS snapshot instead of the ' +
      'template). On by default. Disable when deploy speed matters more than ' +
      'rich drift detection — falls back to comparing against template ' +
      'properties (the pre-v3 behavior).'
  ),
  new Option(
    '--prefix-user-supplied-names',
    'Opt in to LEGACY behavior: prepend the stack name to physical names the ' +
      'user explicitly supplied in their CDK code (e.g. `new iam.Role(this, ' +
      '"X", { roleName: "my-role" })` → AWS resource named `MyStack-my-role` ' +
      'instead of `my-role`). Since v0.94.0 the default is to NOT prefix ' +
      'user-supplied names — this flag restores the pre-v0.94.0 behavior on ' +
      'Pattern B providers (IAM Role / User / Group / InstanceProfile / ManagedPolicy / ELBv2 ' +
      'LoadBalancer / TargetGroup). Enable via this flag, ' +
      'CDKD_PREFIX_USER_SUPPLIED_NAMES=true, or ' +
      'cdk.json context.cdkd.prefixUserSuppliedNames=true. Applies to ' +
      '`cdkd deploy` only.'
  ).default(false),
  // Note: the deprecated `--no-prefix-user-supplied-names` flag is NOT
  // declared as a separate Option. Commander's automatic `--no-X`
  // negation lets users still pass it without error — it negates the
  // new `--prefix-user-supplied-names` flag, leaving its default
  // `false` (= skip prefix) unchanged, which matches the v0.94.0
  // default. Detection of the literal `--no-prefix-user-supplied-names`
  // flag for the deprecation warning happens via the pre-parse argv
  // walk in `warnDeprecatedNoPrefixCliFlag` (src/cli/config-loader.ts) —
  // declaring both Options together would have collapsed both onto a
  // single Commander key, making `noPrefixUserSuppliedNames` permanently
  // `undefined` and silencing the warning.
  noWaitOption,
  fullWaitOption,
  aggressiveVpcParallelOption,
  exclusivelyOption('deploy'),
  allowUnsupportedTypesOption,
  preferSdkRouteOption,
  allowUnsupportedPropertiesOption,
  recreateViaCcApiOption,
  recreateViaSdkProviderOption,
  pinCcApiOption,
  forceStatefulRecreationOption,
  replaceOption,
  useCdkBootstrapAssetsOption,
  strictGetattOption,
  noCfnFallbackOption,
  allowUnaddressedOption,
  ...resourceTimeoutOptions,
];

/**
 * Context options
 *
 * -c / --context can be specified multiple times to pass context key=value pairs
 */
export const contextOptions = [
  new Option(
    '-c, --context <key=value...>',
    'Set context values (can be specified multiple times)'
  ),
];

/**
 * Destroy options
 *
 * Note: `resourceTimeoutOptions` is intentionally NOT spread in here. It is
 * added directly by `createDestroyCommand` (and by `cdkd state destroy`) so
 * that `cdkd orphan` — which reuses `destroyOptions` for `-f/--force` but
 * never calls `provider.delete()` — does not advertise per-resource timeout
 * flags it would silently ignore.
 */
export const destroyOptions = [
  new Option('-f, --force', 'Do not ask for confirmation before destroying the stacks').default(
    false
  ),
  new Option(
    '--remove-protection',
    'Bypass deletion protection on protected resources by flipping the per-resource ' +
      'protection flag off in-place before delete. Covers stack-level terminationProtection ' +
      `(CDK property) and resource-level protection on ${removeProtectionTypeList()}.`
  ).default(false),
  allowUnsupportedTypesOption,
];

/**
 * `--skip-final-snapshot` (issues #1352 / #1353 / #1354) — the explicit
 * data-loss opt-out for `DeletionPolicy: Snapshot` (and, on the replacement
 * paths, `UpdateReplacePolicy: Snapshot`) resources. By default the delete
 * paths honor the policy (CloudFormation parity): an atomic final-snapshot
 * delete parameter for RDS DBInstance / DBCluster, Neptune / DocDB clusters
 * and ElastiCache CacheCluster; a pre-delete snapshot+wait for
 * `AWS::EC2::Volume`, `AWS::Redshift::Cluster` and
 * `AWS::ElastiCache::ReplicationGroup`; and a refusal when cdkd cannot
 * honor the policy (a Cloud-Control-routed atomic type — its delete has no
 * final-snapshot parameter). Attached to `cdkd deploy` (template-removal +
 * replacement deletes), `cdkd destroy`, `cdkd state destroy`, and
 * `cdkd rollback` (issue #1358 — a rolled-back CREATE under
 * `DeletionPolicy: Snapshot` is snapshotted, then deleted) — NOT to the
 * shared `destroyOptions` array, which `cdkd orphan` also consumes (orphan
 * never deletes AWS resources, so the flag would be inert noise there).
 */
export const skipFinalSnapshotOption = new Option(
  '--skip-final-snapshot',
  'Delete resources whose DeletionPolicy (or, on replacements, UpdateReplacePolicy) is ' +
    "'Snapshot' — including an RDS DB cluster or standalone DB instance with no " +
    "DeletionPolicy, whose CloudFormation default is 'Snapshot' — WITHOUT creating " +
    'the final snapshot the policy promises (DATA LOSS — ' +
    'explicit opt-out of CloudFormation parity). By default cdkd creates the final ' +
    'snapshot for every CloudFormation-supported type (RDS DBInstance / DBCluster, ' +
    'Neptune / DocDB clusters, ElastiCache CacheCluster / ReplicationGroup, Redshift ' +
    'Cluster, EC2 Volume) and refuses the delete when it cannot — e.g. a resource ' +
    'managed via the Cloud Control API route, whose delete has no final-snapshot ' +
    "parameter. On 'cdkd rollback' the flag governs the rolled-back CREATE's " +
    'DeletionPolicy; a reverse-replacement delete of the NEW resource keeps its own ' +
    'bounded UpdateReplacePolicy behavior and is unaffected.'
).default(false);

/**
 * `--no-local-custom-resources` (go-to-k/cdkd#6206). Under `--aws-emulator`, a
 * custom resource's `ServiceToken` function runs in the official Lambda
 * runtime image on this machine by default (`src/local/custom-resource-runtime.ts`);
 * this flag sends the event to the emulator's own runtime instead. A no-op
 * without `--aws-emulator`. Attached to every command that can invoke a custom
 * resource: `cdkd deploy`, `cdkd destroy`, `cdkd state destroy`, `cdkd rollback`.
 */
export const noLocalCustomResourcesOption = new Option(
  '--no-local-custom-resources',
  "Under --aws-emulator, invoke custom resource functions in AWS Emulator's own Lambda runtime " +
    'instead of running them locally in the official Lambda runtime image (Docker). A no-op ' +
    'without --aws-emulator.'
);
