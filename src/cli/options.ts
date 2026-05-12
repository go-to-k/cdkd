import { Option } from 'commander';
import {
  DEFAULT_RESOURCE_WARN_AFTER_MS,
  DEFAULT_RESOURCE_TIMEOUT_MS,
} from '../deployment/deploy-engine.js';
import { getLogger } from '../utils/logger.js';

/**
 * Parse context key=value pairs from CLI arguments into a Record
 */
export function parseContextOptions(contextArgs?: string[]): Record<string, string> {
  const context: Record<string, string> = {};
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
    'IAM role ARN to assume for AWS API calls (env: CDKD_ROLE_ARN); the role MUST have admin-equivalent permissions because cdkd issues raw service API calls and does not route through CloudFormation, so CDK CLI deploy-roles will NOT work'
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
 * `--region` do not break. The value is parsed but ignored — see
 * `warnIfDeprecatedRegion` for the runtime warning. Final removal is
 * tracked in PR 99 (see `docs/plans/05-region-flag-cleanup.md`).
 */
export const deprecatedRegionOption = new Option(
  '--region <region>',
  '[deprecated] No effect on this command; use AWS_REGION or your AWS profile'
).hideHelp();

/**
 * Emit a one-shot stderr warning when a non-bootstrap command receives
 * `--region`. PR 5 consolidates `--region` to bootstrap-only; everywhere
 * else the SDK picks up the region from `AWS_REGION` / profile, and
 * passing the flag does nothing useful.
 */
export function warnIfDeprecatedRegion(options: { region?: string }): void {
  if (options.region !== undefined) {
    process.stderr.write(
      'Warning: --region is deprecated for this command and has no effect. ' +
        'Use the AWS_REGION environment variable or your AWS profile to override the SDK default region.\n'
    );
  }
}

/**
 * App options
 *
 * --app is optional: falls back to CDKD_APP env var, then cdk.json "app" field.
 * Accepts either a shell command (e.g. "npx ts-node app.ts") or a path to a
 * pre-synthesized cloud assembly directory (e.g. "cdk.out").
 */
export const appOptions = [
  new Option(
    '-a, --app <command>',
    'CDK app command (e.g., "npx ts-node app.ts") or path to a pre-synthesized cloud assembly directory. Falls back to cdk.json or CDKD_APP env'
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
  new Option('--state-prefix <prefix>', 'S3 key prefix for state files').default('cdkd'),
];

/**
 * Stack options
 */
export const stackOptions = [new Option('--stack <name>', 'Stack name to operate on')];

/**
 * Parse a duration string with a unit suffix into milliseconds.
 *
 * Accepted forms:
 *   - `<number>s` — seconds (e.g. `30s`)
 *   - `<number>m` — minutes (e.g. `5m`)
 *   - `<number>h` — hours   (e.g. `1h`)
 *
 * The numeric portion may be a positive integer or decimal (`1.5h`). Zero,
 * negative, NaN, missing-unit, and unknown-unit values are all rejected so
 * that `--resource-timeout 0`, `--resource-timeout -5m`, and
 * `--resource-timeout 30` (no unit) fail at parse time rather than turning
 * into a useless / zero-budget deadline at runtime.
 */
export function parseDuration(value: string): number {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Invalid duration "${value}": expected <number>s, <number>m, or <number>h (e.g. 30s, 5m, 1h)`
    );
  }
  const match = /^(\d+(?:\.\d+)?)([smh])$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid duration "${value}": expected <number>s, <number>m, or <number>h (e.g. 30s, 5m, 1h)`
    );
  }
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Invalid duration "${value}": must be greater than zero`);
  }
  const unit = match[2];
  const multiplier = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;
  return Math.round(num * multiplier);
}

/**
 * Resolved per-resource timeout / warn-after value, separated into a
 * single global default and a `resourceType -> ms` override map.
 *
 * Both flags are repeatable. Each invocation may take one of two forms:
 *   - **Bare duration** (e.g. `30m`) — sets the global default. The last
 *     bare value wins (standard Commander semantics for non-repeatable
 *     forms applied to a flag we made repeatable).
 *   - **TYPE=DURATION** (e.g. `AWS::CloudFront::Distribution=1h`) — adds
 *     a per-resource-type override that supersedes the global default at
 *     the call site for resources of that type only.
 *
 * The global default is `undefined` when the user supplied per-type
 * entries only (no bare value); the call site falls back to the v1
 * compile-time defaults (`DEFAULT_RESOURCE_*_MS`).
 */
export interface ResourceTimeoutOption {
  /** Global default in milliseconds (last bare-duration token wins). */
  globalMs?: number;
  /** Per-resource-type override map (`AWS::Service::Resource` -> ms). */
  perTypeMs: Record<string, number>;
}

/**
 * Validate that a token's left-hand side looks like a CloudFormation
 * resource type (e.g. `AWS::S3::Bucket`). The check is intentionally
 * loose — we don't maintain a closed list of types — but it does reject
 * obvious typos / missing scopes so users see the error at parse time
 * rather than silently storing `s3:bucket=30m` and never matching.
 */
const RESOURCE_TYPE_REGEX = /^[A-Z][A-Za-z0-9]+::[A-Z][A-Za-z0-9]+::[A-Z][A-Za-z0-9]+$/;

/**
 * Custom commander `argParser` for the repeatable timeout flags.
 *
 * Accepts either form on each invocation:
 *   - `30m` -> sets / overwrites `globalMs`
 *   - `AWS::X::Y=30m` -> adds an entry to `perTypeMs`
 *
 * `previous` carries the accumulator across repeated invocations. The
 * first time commander calls us it passes whatever `default(...)` was
 * set — see `resourceTimeoutOptions` below for why the default is
 * `undefined` (we pre-seed the default global value at the call site
 * instead).
 */
function parseResourceTimeoutToken(flagName: string) {
  return (raw: string, previous: ResourceTimeoutOption | undefined): ResourceTimeoutOption => {
    const acc: ResourceTimeoutOption = previous ?? { perTypeMs: {} };
    if (!acc.perTypeMs) acc.perTypeMs = {};

    const eqIndex = raw.indexOf('=');
    if (eqIndex === -1) {
      // Bare duration: global default. parseDuration validates the unit /
      // numeric portion and throws on malformed input.
      acc.globalMs = parseDuration(raw);
      return acc;
    }

    const typePart = raw.substring(0, eqIndex).trim();
    const durationPart = raw.substring(eqIndex + 1).trim();

    if (!RESOURCE_TYPE_REGEX.test(typePart)) {
      throw new Error(
        `Invalid ${flagName} value "${raw}": ` +
          `left-hand side must be a CloudFormation resource type like AWS::Service::Resource ` +
          `(got "${typePart}")`
      );
    }
    if (durationPart.length === 0) {
      throw new Error(
        `Invalid ${flagName} value "${raw}": missing duration after '=' (e.g. ${typePart}=1h)`
      );
    }

    // parseDuration throws on malformed durations. Wrap with extra context
    // so the user knows which TYPE entry triggered the failure.
    let ms: number;
    try {
      ms = parseDuration(durationPart);
    } catch (err) {
      const inner = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid ${flagName} value "${raw}": ${inner}`);
    }

    acc.perTypeMs[typePart] = ms;
    return acc;
  };
}

/**
 * Per-resource timeout options shared by `deploy` and `destroy`.
 *
 * - `--resource-warn-after` (default `5m`): when an individual resource has
 *   been in flight this long, the live renderer's task label is suffixed
 *   with `[taking longer than expected, Nm+]` and a `logger.warn` line is
 *   emitted (via `printAbove` so it does not collide with the in-flight
 *   task display).
 * - `--resource-timeout` (default `30m`): when an individual resource
 *   exceeds this, throw `ResourceTimeoutError` (caught and wrapped in
 *   `ProvisioningError` at the same site as any other provider failure)
 *   and trigger the existing rollback path.
 *
 * Both flags are **repeatable** and accept either a bare `<duration>`
 * (sets the global default) or `<TYPE>=<duration>` (adds a per-type
 * override). At the call site, the per-type override wins for matching
 * resources; everything else falls back to the global default. See
 * {@link ResourceTimeoutOption}.
 *
 * The default 30m timeout is below the Custom Resource provider's 1-hour
 * polling cap on purpose — Custom-Resource-heavy stacks should pass
 * `--resource-timeout 1h` (or higher) explicitly when they expect handlers
 * to run for longer. Per-type overrides like
 * `--resource-timeout AWS::CloudFront::Distribution=1h` keep the global
 * cap tight while raising it only where it's needed.
 */
export const resourceTimeoutOptions = [
  // Default is `undefined` (NOT a pre-seeded ResourceTimeoutOption) — the
  // command handler resolves missing globalMs to DEFAULT_RESOURCE_*_MS
  // at the call site. Pre-seeding here would force every accumulator
  // call to carry a snapshot, and would also surprise unit tests that
  // expect `opts.resourceTimeout` to be `undefined` when the flag is not
  // passed.
  new Option(
    '--resource-warn-after <duration_or_type=duration>',
    'Warn when a single resource operation exceeds this wall-clock duration. ' +
      'Repeatable: pass a bare duration (e.g. 5m) to set the global default, or ' +
      'TYPE=DURATION (e.g. AWS::CloudFront::Distribution=10m) for a per-type override.'
  )
    .default(undefined, '5m')
    .argParser(parseResourceTimeoutToken('--resource-warn-after')),
  new Option(
    '--resource-timeout <duration_or_type=duration>',
    'Abort a single resource operation that exceeds this wall-clock duration. ' +
      'Repeatable: pass a bare duration (e.g. 30m) to set the global default, or ' +
      'TYPE=DURATION (e.g. AWS::CloudFront::Distribution=1h) for a per-type override. ' +
      'Custom-Resource-heavy stacks may need to raise this above the default 30m ' +
      "(the Custom Resource provider's polling cap is 1h). " +
      'When this is shorter than the 5m --resource-warn-after default, ' +
      '--resource-warn-after is auto-lowered to min(5m, 0.5*timeout) and a ' +
      'warning is logged so the user can override explicitly.'
  )
    .default(undefined, '30m')
    .argParser(parseResourceTimeoutToken('--resource-timeout')),
];

/**
 * Format a millisecond duration as a human-readable string for log output
 * (`120000` -> `120s`). Mirrors the input grammar of `parseDuration` so the
 * suggestion in the warning matches what a user would type.
 */
function formatMs(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1_000)}s`;
}

/**
 * Pick a safe auto-lowered warn value for a given timeout: half the
 * timeout, but never above the compile-time default warn. This keeps the
 * "still running" warning fire well before the deadline without quietly
 * raising it past what the user would normally see.
 *
 * `Math.max(1, ...)` guarantees the result is positive (so the runtime
 * `withResourceDeadline` validator still accepts it) even for absurdly
 * short timeouts. The runtime check enforces `warn < timeout` strictly,
 * so a 1ms warn against a 1ms timeout would still fail — that case is
 * physically meaningless and rejected one layer below.
 */
function autoLoweredWarnMs(timeoutMs: number): number {
  return Math.max(1, Math.min(DEFAULT_RESOURCE_WARN_AFTER_MS, Math.floor(timeoutMs / 2)));
}

/**
 * Validate `--resource-warn-after` / `--resource-timeout` pairs and
 * auto-lower the inherited warn-after when the user shortened only the
 * timeout side.
 *
 * Resolution rules at every check site (global and per-type):
 *
 *   - **Both sides explicit** (user set warn AND timeout, either at the
 *     global or per-type level): require `warn < timeout`. A reversed
 *     pair is a hard user error and rejected at parse time — cdkd does
 *     not silently rewrite a value the user typed.
 *   - **Only timeout explicit, warn inherited** (the `--resource-timeout 2m`
 *     UX gap this helper closes): if the inherited warn would violate
 *     `warn < timeout`, auto-lower the warn to
 *     `min(DEFAULT_RESOURCE_WARN_AFTER_MS, 0.5 * timeout)` and emit a
 *     `logger.warn(...)` line so the user understands what cdkd did.
 *     Per-type timeout overrides write a per-type warn entry; the global
 *     timeout writes the global warn.
 *   - **Only warn explicit, timeout inherited**: rare but possible
 *     (`--resource-warn-after 45m` with no `--resource-timeout`). This is
 *     a hard user error — auto-raising the timeout would silently grant
 *     the user more budget than they asked for, which is the wrong
 *     direction (see `feedback_no_remove_features.md`-style reasoning).
 *
 * Mutates `opts.resourceWarnAfter` in place when auto-lowering: callers
 * are expected to pass the live `options.resourceWarnAfter` reference so
 * the downstream `DeployEngine` constructor sees the lowered value.
 *
 * Receives values that have already been parsed (milliseconds). Throws
 * an `Error` on hard rejection (commander surfaces this without a stack
 * trace).
 */
export function validateResourceTimeouts(opts: {
  resourceWarnAfter?: ResourceTimeoutOption;
  resourceTimeout?: ResourceTimeoutOption;
}): void {
  const timeout = opts.resourceTimeout;

  // Global-level check.
  const globalWarn = opts.resourceWarnAfter?.globalMs;
  const globalTimeout = timeout?.globalMs;

  if (typeof globalWarn === 'number' && typeof globalTimeout === 'number') {
    // Both sides explicit: hard-reject reversed pair.
    if (globalWarn >= globalTimeout) {
      throw new Error(
        `--resource-warn-after (${globalWarn}ms) must be less than --resource-timeout (${globalTimeout}ms)`
      );
    }
  } else if (typeof globalTimeout === 'number') {
    // Only timeout explicit: check the inherited warn (default 5m) and
    // auto-lower if it would violate.
    if (DEFAULT_RESOURCE_WARN_AFTER_MS >= globalTimeout) {
      const lowered = autoLoweredWarnMs(globalTimeout);
      ensureWarnAfter(opts).globalMs = lowered;
      getLogger().warn(
        `--resource-warn-after defaulted to ${formatMs(lowered)} because --resource-timeout ` +
          `${formatMs(globalTimeout)} is shorter than the ${formatMs(DEFAULT_RESOURCE_WARN_AFTER_MS)} default. ` +
          `Pass --resource-warn-after <duration> explicitly to override.`
      );
    }
  } else if (typeof globalWarn === 'number' && globalWarn >= DEFAULT_RESOURCE_TIMEOUT_MS) {
    // Only warn explicit, set above the default timeout. Hard-reject —
    // we will not silently raise the timeout side.
    throw new Error(
      `--resource-warn-after (${formatMs(globalWarn)}) must be less than --resource-timeout ` +
        `(default ${formatMs(DEFAULT_RESOURCE_TIMEOUT_MS)}). ` +
        `Pass --resource-timeout <duration> alongside it to raise the deadline.`
    );
  }

  // Per-type check: union of every type mentioned by either flag.
  const warnPerType = opts.resourceWarnAfter?.perTypeMs ?? {};
  const timeoutPerType = timeout?.perTypeMs ?? {};
  const types = new Set<string>([...Object.keys(warnPerType), ...Object.keys(timeoutPerType)]);

  for (const t of types) {
    const explicitPerTypeWarn = warnPerType[t]; // undefined => not user-set
    const explicitPerTypeTimeout = timeoutPerType[t];

    // Re-read the (possibly auto-lowered) global warn so per-type
    // resolution uses the post-mutation value.
    const effectiveGlobalWarn = opts.resourceWarnAfter?.globalMs;

    const effectiveWarn =
      explicitPerTypeWarn ?? effectiveGlobalWarn ?? DEFAULT_RESOURCE_WARN_AFTER_MS;
    const effectiveTimeout = explicitPerTypeTimeout ?? globalTimeout ?? DEFAULT_RESOURCE_TIMEOUT_MS;

    if (effectiveWarn < effectiveTimeout) continue;

    if (explicitPerTypeWarn !== undefined && explicitPerTypeTimeout !== undefined) {
      // Both per-type sides explicit and reversed — hard-reject.
      throw new Error(
        `--resource-warn-after for ${t} (${formatMs(explicitPerTypeWarn)}) must be less than ` +
          `--resource-timeout for ${t} (${formatMs(explicitPerTypeTimeout)})`
      );
    }
    if (explicitPerTypeWarn !== undefined) {
      // Per-type warn explicit, but the resolved timeout (global or default)
      // is too low. Hard-reject — same direction as the global rule.
      throw new Error(
        `--resource-warn-after for ${t} (${formatMs(explicitPerTypeWarn)}) must be less than ` +
          `--resource-timeout for ${t} (${formatMs(effectiveTimeout)}). ` +
          `Pass --resource-timeout ${t}=<duration> alongside it to raise the deadline.`
      );
    }
    // Per-type timeout explicit (or both implicit but the inherited warn
    // exceeds the inherited timeout — only possible if the global pair
    // somehow passed the earlier check, which it cannot). Auto-lower the
    // per-type warn to a safe value so this type's deadline is usable.
    const lowered = autoLoweredWarnMs(effectiveTimeout);
    ensureWarnAfter(opts).perTypeMs[t] = lowered;
    getLogger().warn(
      `--resource-warn-after for ${t} defaulted to ${formatMs(lowered)} because ` +
        `--resource-timeout for ${t} (${formatMs(effectiveTimeout)}) is shorter than ` +
        `the inherited ${formatMs(effectiveWarn)} warn. ` +
        `Pass --resource-warn-after ${t}=<duration> explicitly to override.`
    );
  }
}

/**
 * Lazily initialize `opts.resourceWarnAfter` so the auto-lowering branch
 * can write into it even when the user did not pass the flag at all.
 * Mutates the caller's options object so the downstream call site (which
 * reads `options.resourceWarnAfter.globalMs` / `.perTypeMs`) sees the
 * lowered value.
 */
function ensureWarnAfter(opts: {
  resourceWarnAfter?: ResourceTimeoutOption;
}): ResourceTimeoutOption {
  if (!opts.resourceWarnAfter) {
    opts.resourceWarnAfter = { perTypeMs: {} };
  }
  if (!opts.resourceWarnAfter.perTypeMs) {
    opts.resourceWarnAfter.perTypeMs = {};
  }
  return opts.resourceWarnAfter;
}

/**
 * Resolve the effective wall-clock budget for a single resource operation.
 *
 * Resolution order:
 *   1. Per-resource-type override (`opt.perTypeMs[resourceType]`).
 *   2. Caller-supplied global (`opt.globalMs`).
 *   3. Caller-supplied fallback (`fallbackMs`) — typically
 *      `DEFAULT_RESOURCE_*_MS` from `deploy-engine.ts`.
 */
export function effectiveResourceTimeoutMs(
  resourceType: string,
  opt: ResourceTimeoutOption | undefined,
  fallbackMs: number
): number {
  if (opt) {
    const perType = opt.perTypeMs?.[resourceType];
    if (typeof perType === 'number') return perType;
    if (typeof opt.globalMs === 'number') return opt.globalMs;
  }
  return fallbackMs;
}

/**
 * Skip waiting for async-stabilization resources (CloudFront, RDS,
 * ElastiCache, NAT Gateway) on deploy. Setting the flag mutates
 * `process.env.CDKD_NO_WAIT='true'`; provider code checks that env
 * var, not the parsed CLI option (this lets nested call paths — e.g.
 * asset publish, lifecycle hooks — see the same setting without
 * threading the flag through every function signature).
 *
 * Deploy-only. NAT Gateway destroy always waits regardless (a
 * still-`deleting` gateway blocks downstream Subnet / IGW / VPC
 * delete with DependencyViolation), and CloudFront / RDS / ElastiCache
 * destroy paths don't wait to begin with — so `destroy --no-wait`
 * would be a no-op flag.
 */
export const noWaitOption = new Option(
  '--no-wait',
  'Skip waiting for async resources to stabilize (CloudFront, RDS, ElastiCache, NAT Gateway)'
);

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
 * Deploy options
 */
export const deployOptions = [
  new Option('--concurrency <number>', 'Maximum concurrent resource operations')
    .default(10)
    .argParser((value) => parseInt(value, 10)),
  new Option('--stack-concurrency <number>', 'Maximum concurrent stack deployments')
    .default(4)
    .argParser((value) => parseInt(value, 10)),
  new Option(
    '--asset-publish-concurrency <number>',
    'Maximum concurrent asset publish operations (S3 uploads + ECR push)'
  )
    .default(8)
    .argParser((value) => parseInt(value, 10)),
  new Option('--image-build-concurrency <number>', 'Maximum concurrent Docker image builds')
    .default(4)
    .argParser((value) => parseInt(value, 10)),
  new Option('--dry-run', 'Show changes without applying').default(false),
  new Option('--skip-assets', 'Skip asset publishing').default(false),
  new Option('--no-rollback', 'Skip rollback on deployment failure'),
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
    '--no-prefix-user-supplied-names',
    'Do NOT prepend the stack name to physical names the user explicitly ' +
      'supplied in their CDK code (e.g. `new iam.Role(this, "X", { roleName: ' +
      '"my-role" })` → AWS resource named `my-role` instead of `MyStack-my-role`). ' +
      'Auto-generated-name resources (where the user did not declare a physical ' +
      'name) keep the prefix unchanged. Off by default for backward compatibility; ' +
      'enable via this flag, CDKD_NO_PREFIX_USER_SUPPLIED_NAMES=true, or ' +
      'cdk.json context.cdkd.noPrefixUserSuppliedNames=true. Applies to ' +
      '`cdkd deploy` only.'
  ),
  noWaitOption,
  aggressiveVpcParallelOption,
  new Option(
    '-e, --exclusively',
    'Only deploy requested stacks, do not include dependencies'
  ).default(false),
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
 * Per-Lambda + global `--assume-role` parser used by `cdkd local
 * start-api` (D8.2). Mirrors the `--resource-timeout` parser shape:
 * each invocation is either a bare ARN (sets / overwrites the global
 * default) or `<LogicalId>=<arn>` (per-Lambda override). Per-Lambda
 * always wins over global; global is the fallback when no per-Lambda
 * entry exists.
 */
export interface AssumeRoleOption {
  /** Global ARN — last bare-arn token wins. */
  globalArn?: string;
  /** Per-Lambda override map (`LogicalId` -> ARN). */
  perLambda: Record<string, string>;
}

const IAM_ROLE_ARN_REGEX = /^arn:[^:]+:iam::\d+:role\//;

/**
 * Argparse for the repeatable `--assume-role` flag.
 *
 * Validates that:
 *   - bare values look like an IAM role ARN;
 *   - `<LogicalId>=<arn>` left-hand sides look like a CFn logical ID
 *     (alphanumeric, no separators);
 *   - the right-hand side ARN is well-shaped.
 */
export function parseAssumeRoleToken(
  raw: string,
  previous: AssumeRoleOption | undefined
): AssumeRoleOption {
  const acc: AssumeRoleOption = previous ?? { perLambda: {} };
  if (!acc.perLambda) acc.perLambda = {};

  const eqIndex = raw.indexOf('=');
  if (eqIndex === -1) {
    if (!IAM_ROLE_ARN_REGEX.test(raw)) {
      throw new Error(
        `Invalid --assume-role value "${raw}": expected an IAM role ARN like arn:aws:iam::123456789012:role/MyRole, or LogicalId=<arn>.`
      );
    }
    acc.globalArn = raw;
    return acc;
  }

  const logicalId = raw.substring(0, eqIndex).trim();
  const arn = raw.substring(eqIndex + 1).trim();
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(logicalId)) {
    throw new Error(
      `Invalid --assume-role value "${raw}": left-hand side "${logicalId}" must be a CloudFormation logical ID (alphanumeric, leading letter).`
    );
  }
  if (!IAM_ROLE_ARN_REGEX.test(arn)) {
    throw new Error(
      `Invalid --assume-role value "${raw}": right-hand side "${arn}" must be an IAM role ARN like arn:aws:iam::123456789012:role/MyRole.`
    );
  }
  acc.perLambda[logicalId] = arn;
  return acc;
}

/**
 * Resolve the effective IAM role ARN for a given Lambda. Per-Lambda
 * override wins; otherwise the global default; otherwise `undefined`
 * (no role to assume — pass developer creds through).
 */
export function effectiveAssumeRoleArn(
  logicalId: string,
  opt: AssumeRoleOption | undefined
): string | undefined {
  if (!opt) return undefined;
  return opt.perLambda?.[logicalId] ?? opt.globalArn;
}

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
      '(CDK property) and resource-level protection on AWS::Logs::LogGroup, AWS::RDS::DBInstance, ' +
      'AWS::RDS::DBCluster, AWS::DocDB::DBCluster, AWS::Neptune::DBCluster, ' +
      'AWS::Neptune::DBInstance, AWS::DynamoDB::Table, AWS::EC2::Instance, ' +
      'AWS::Cognito::UserPool, AWS::AutoScaling::AutoScalingGroup, and ' +
      'AWS::ElasticLoadBalancingV2::LoadBalancer.'
  ).default(false),
];
