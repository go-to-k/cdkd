import { Option } from 'commander';

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
      "(the Custom Resource provider's polling cap is 1h)."
  )
    .default(undefined, '30m')
    .argParser(parseResourceTimeoutToken('--resource-timeout')),
];

/**
 * Validate that warn < timeout, both at the global level and per-type.
 *
 * - Global: `globalMs(warn) < globalMs(timeout)` if both are user-set.
 * - Per-type: for every type that appears in either map, the resolved
 *   warn (per-type-or-global) must be less than the resolved timeout
 *   (per-type-or-global). A `--resource-warn-after AWS::X=10m` without a
 *   matching `--resource-timeout AWS::X=...` is OK — it's compared
 *   against the global timeout.
 *
 * Receives values that have already been parsed (milliseconds). Throws
 * an `Error` (commander surfaces this to the user without a stack trace).
 */
export function validateResourceTimeouts(opts: {
  resourceWarnAfter?: ResourceTimeoutOption;
  resourceTimeout?: ResourceTimeoutOption;
}): void {
  const warn = opts.resourceWarnAfter;
  const timeout = opts.resourceTimeout;

  // Global-level check (only when both globals are user-set; we don't
  // know the v1 default here so we can't compare against it).
  const globalWarn = warn?.globalMs;
  const globalTimeout = timeout?.globalMs;
  if (typeof globalWarn === 'number' && typeof globalTimeout === 'number') {
    if (globalWarn >= globalTimeout) {
      throw new Error(
        `--resource-warn-after (${globalWarn}ms) must be less than --resource-timeout (${globalTimeout}ms)`
      );
    }
  }

  // Per-type check: union of every type mentioned by either flag. For
  // each, resolve the effective warn / timeout (per-type ?? global) and
  // make sure warn < timeout. Skip the check when either side is missing
  // entirely (no global default + no per-type entry).
  const warnPerType = warn?.perTypeMs ?? {};
  const timeoutPerType = timeout?.perTypeMs ?? {};
  const types = new Set<string>([...Object.keys(warnPerType), ...Object.keys(timeoutPerType)]);
  for (const t of types) {
    const effectiveWarn = warnPerType[t] ?? globalWarn;
    const effectiveTimeout = timeoutPerType[t] ?? globalTimeout;
    if (typeof effectiveWarn !== 'number' || typeof effectiveTimeout !== 'number') {
      // Without both sides resolved we can't compare; defer to the v1
      // compile-time defaults which are known to be ordered correctly.
      continue;
    }
    if (effectiveWarn >= effectiveTimeout) {
      throw new Error(
        `--resource-warn-after for ${t} (${effectiveWarn}ms) must be less than ` +
          `--resource-timeout for ${t} (${effectiveTimeout}ms)`
      );
    }
  }
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
 * GW stabilization. Measured −45.6% on `bench-cdk-sample` (387s → 211s).
 *
 * Off by default: relaxation is opt-in for v1 because CloudFront
 * `Create` / `Delete` are each ~5 min and the rollback cost of a
 * Lambda-side async failure is correspondingly high. Will likely flip to
 * default-on after burn-in.
 *
 * Deploy-only. The relaxation has no effect on destroy ordering (CDK route
 * DependsOn doesn't constrain delete-time correctness — Lambda hyperplane
 * ENI release is the actual destroy bottleneck and is handled separately
 * by `lambda-vpc-deps.ts`).
 *
 * See `src/analyzer/cdk-defensive-deps.ts` for the type-pair allowlist.
 */
export const aggressiveVpcParallelOption = new Option(
  '--aggressive-vpc-parallel',
  'Relax CDK-injected VPC route DependsOn to let CloudFront/Lambda::Url create in parallel with NAT GW stabilization'
).default(false);

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
];
