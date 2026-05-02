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
 * The default 30m timeout is below the Custom Resource provider's 1-hour
 * polling cap on purpose — Custom-Resource-heavy stacks should pass
 * `--resource-timeout 1h` (or higher) explicitly when they expect handlers
 * to run for longer. The error message names this override.
 */
export const resourceTimeoutOptions = [
  // Default values are stored as parsed milliseconds (NOT the source
  // string) because commander's `argParser` only runs on user-supplied
  // values, never on defaults — without this every command handler
  // would see `'5m'` (string) when the user did not pass the flag and
  // `300_000` (number) when they did. The second `defaultValueDescription`
  // argument keeps `--help` showing the human-readable form.
  new Option(
    '--resource-warn-after <duration>',
    'Warn when a single resource operation exceeds this wall-clock duration (e.g. 5m, 90s, 1h)'
  )
    .default(parseDuration('5m'), '5m')
    .argParser(parseDuration),
  new Option(
    '--resource-timeout <duration>',
    'Abort a single resource operation that exceeds this wall-clock duration. ' +
      'Custom-Resource-heavy stacks may need to raise this above the default 30m ' +
      "(the Custom Resource provider's polling cap is 1h)."
  )
    .default(parseDuration('30m'), '30m')
    .argParser(parseDuration),
];

/**
 * Validate that `--resource-warn-after` < `--resource-timeout`. Mis-ordered
 * values make the warning useless (it would never fire before the abort).
 *
 * Receives values that have already been parsed by `parseDuration`, i.e.
 * milliseconds. Throws an `Error` (commander surfaces this to the user
 * without a stack trace).
 */
export function validateResourceTimeouts(opts: {
  resourceWarnAfter?: number;
  resourceTimeout?: number;
}): void {
  const warn = opts.resourceWarnAfter;
  const timeout = opts.resourceTimeout;
  if (typeof warn === 'number' && typeof timeout === 'number' && warn >= timeout) {
    throw new Error(
      `--resource-warn-after (${warn}ms) must be less than --resource-timeout (${timeout}ms)`
    );
  }
}

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
  new Option('--no-wait', 'Skip waiting for async resources (CloudFront, RDS, etc.)'),
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
