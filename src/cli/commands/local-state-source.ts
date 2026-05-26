/**
 * Single-source-of-truth helper that picks a {@link LocalStateProvider}
 * for the `cdkd local *` family from CLI flags (issue #606).
 *
 * The four `cdkd local *` commands all support two mutually-exclusive
 * state-source flags:
 *
 *   - `--from-state` (S3-backed; reads cdkd's state for a stack
 *     deployed via `cdkd deploy`).
 *   - `--from-cfn-stack [<cfn-stack-name>]` (CFn-backed; reads a
 *     deployed CloudFormation stack via `DescribeStackResources`).
 *
 * This module centralizes:
 *
 *   - The mutual-exclusion check (rejected at the CLI layer before any
 *     synth / AWS call fires).
 *   - The bare-vs-explicit `--from-cfn-stack` resolution: bare flag uses
 *     the cdkd stack name; explicit value overrides. Matches the
 *     `cdkd import --migrate-from-cloudformation` precedent.
 *   - Region resolution for the CFn client: reuses the existing
 *     `--stack-region` flag (no separate `--cfn-stack-region`) per
 *     issue #606 recommendation.
 *
 * Returns `undefined` when neither flag is set — the caller skips the
 * substitution pass entirely (which is the pre-issue-#606 behavior
 * when `--from-state` was absent).
 */

import { S3LocalStateProvider } from '../../local/s3-local-state-provider.js';
import { CfnLocalStateProvider } from '../../local/cfn-local-state-provider.js';
import type { LocalStateProvider } from '../../local/local-state-provider.js';

/**
 * Options the four `cdkd local *` commands gather from their flag set.
 * Every field is optional except `statePrefix` (which always has a
 * default). The helper inspects `fromState` / `fromCfnStack` to decide
 * which provider to construct.
 */
export interface LocalStateSourceOptions {
  /** True when `--from-state` was passed. */
  fromState: boolean;
  /**
   * `--from-cfn-stack` flag value. Commander maps:
   *   - flag absent → `undefined`
   *   - `--from-cfn-stack` (bare) → `true`
   *   - `--from-cfn-stack <name>` → `'<name>'`
   */
  fromCfnStack?: string | boolean;
  /** S3 bucket for `--from-state`. */
  stateBucket?: string;
  /** S3 key prefix for `--from-state`; commander always supplies the default. */
  statePrefix: string;
  /** Inherited `--region`. */
  region?: string;
  /** Inherited `--profile`. */
  profile?: string;
  /**
   * Inherited `--stack-region`. Used by `--from-state` (multi-region
   * disambiguation) AND by `--from-cfn-stack` (the CFn client's
   * region). When unset for `--from-cfn-stack`, the helper falls back
   * to `--region` > `AWS_REGION` > `AWS_DEFAULT_REGION` > the
   * synth-derived stack region.
   */
  stackRegion?: string;
}

/**
 * Default cdkd stack name → CFn stack name. Matches the
 * `cdkd import --migrate-from-cloudformation` bare-form precedent:
 * bare `--from-cfn-stack` uses the cdkd stack name verbatim as the CFn
 * stack name (typical for CDK apps where the names are the same).
 * Override by passing `--from-cfn-stack <explicit-name>`.
 *
 * Exported for unit testing.
 */
export function resolveCfnStackName(fromCfnStack: string | boolean, cdkdStackName: string): string {
  if (typeof fromCfnStack === 'string') return fromCfnStack;
  return cdkdStackName;
}

/**
 * Single source of truth for "is the user asking for `--from-cfn-stack`?".
 * Commander maps the flag to one of `undefined` (absent) / `true` (bare) /
 * `'<name>'` (explicit). Everything except `undefined` / `false` means the
 * flag is present. Extracted so the `local-start-api` "state source
 * active" check (the parent call site that decides whether to load any
 * state at all) and `createLocalStateProvider`'s own branch logic stay
 * in lock-step — a previous duplication of this predicate motivated the
 * extraction (issue #611 NIT 5).
 *
 * Exported for use by `local-start-api` and unit testing.
 */
export function isCfnFlagPresent(opts: Pick<LocalStateSourceOptions, 'fromCfnStack'>): boolean {
  const v = opts.fromCfnStack;
  return v !== undefined && v !== false;
}

/**
 * Resolve the region used for the CFn client. The CFn provider is
 * region-bound at construction time; we apply the precedence chain
 * `--stack-region` > `--region` > `AWS_REGION` > `AWS_DEFAULT_REGION`
 * > the synth-derived stack region. Throws `LocalStateSourceError`
 * when none of these signals is set — the CFn API call needs a
 * concrete region and silently picking `us-east-1` would query the
 * wrong stack environment (worst case: succeed against the wrong
 * stack and return wrong physical IDs). Distinct from
 * `loadStateForStack`'s behavior: the S3 state bucket name is
 * account-scoped (not region-scoped) and the bucket's region is
 * auto-discovered via `GetBucketLocation`, so the S3 provider can
 * tolerate a missing region. The CFn provider cannot.
 *
 * Exported for unit testing.
 */
export function resolveCfnRegion(
  options: Pick<LocalStateSourceOptions, 'stackRegion' | 'region'>,
  synthRegion: string | undefined
): string {
  const region =
    options.stackRegion ??
    options.region ??
    process.env['AWS_REGION'] ??
    process.env['AWS_DEFAULT_REGION'] ??
    synthRegion;
  if (region === undefined) {
    throw new LocalStateSourceError(
      '--from-cfn-stack requires a region to query CloudFormation. ' +
        'Set one of: --stack-region <region>, --region <region>, AWS_REGION env var, AWS_DEFAULT_REGION env var, or an env.region on the target CDK stack.'
    );
  }
  return region;
}

/**
 * Common error class for the mutual-exclusion check so the CLI layer
 * can surface a consistent error message from all four commands.
 */
export class LocalStateSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalStateSourceError';
  }
}

/**
 * Pre-flight check for `--from-cfn-stack <explicit-name>` when the
 * caller will construct one provider per routed stack (`local
 * start-api` / `local start-service`). An explicit value applies to
 * the SINGLE CFn stack named — when multiple cdkd stacks are routed,
 * every one of them would query the same CFn stack, yielding silent
 * wrong-physical-id substitutions for any logical id that happens to
 * collide between the user's stacks. Reject at the CLI layer instead.
 *
 * Bare `--from-cfn-stack` (the cdkdStackName-default) is fine for
 * multi-stack: each routed stack reads its own CFn counterpart.
 * `--from-state` is also fine: cdkd's state is per-(stack, region).
 *
 * Call this from `start-api` / `start-service` BEFORE the per-stack
 * `createLocalStateProvider` loop when `routedStackCount > 1`.
 */
export function rejectExplicitCfnStackWithMultipleStacks(
  options: Pick<LocalStateSourceOptions, 'fromCfnStack'>,
  routedStackCount: number
): void {
  if (routedStackCount <= 1) return;
  if (typeof options.fromCfnStack !== 'string') return;
  throw new LocalStateSourceError(
    `--from-cfn-stack <name> cannot be used with multiple routed stacks (got ${routedStackCount}). ` +
      'An explicit CFn stack name applies to one stack only and would silently mismap logical IDs across siblings. ' +
      'Use bare --from-cfn-stack (each cdkd stack uses its own name as the CFn stack name) or run one cdkd local invocation per stack.'
  );
}

/**
 * Pick and construct the right `LocalStateProvider` for the supplied
 * flag set. Returns `undefined` when neither flag is set (caller skips
 * the substitution pass). Throws `LocalStateSourceError` when both
 * flags are set (mutually exclusive — different state sources, asking
 * for both is ambiguous about precedence).
 *
 * `cdkdStackName` is the cdkd-side stack name the local command
 * resolved to its target — needed to apply the bare-`--from-cfn-stack`
 * default. `synthRegion` is the synth-derived stack region (`env.region`
 * on the CDK stack) — fallback for the CFn client when no explicit
 * region override is set.
 *
 * For multi-stack callers (`local start-api` / `local start-service`)
 * also invoke `rejectExplicitCfnStackWithMultipleStacks` BEFORE the
 * per-stack loop — see that helper's docstring for the rationale.
 */
export function createLocalStateProvider(
  options: LocalStateSourceOptions,
  cdkdStackName: string,
  synthRegion: string | undefined
): LocalStateProvider | undefined {
  const cfnStackOpt = options.fromCfnStack;
  const cfnFlagPresent = isCfnFlagPresent(options);
  if (options.fromState && cfnFlagPresent) {
    throw new LocalStateSourceError(
      '--from-state and --from-cfn-stack are mutually exclusive. ' +
        'Use --from-state for stacks deployed via `cdkd deploy`; use --from-cfn-stack for stacks deployed via `cdk deploy` (CloudFormation).'
    );
  }

  // Issue #611 NIT 1: reject empty `--from-cfn-stack ""`. The string is
  // truthy in the `cfnFlagPresent` check (Commander only collapses
  // boolean `true` / `undefined` for absent / bare flags — an explicit
  // empty argument lands here as `''`). Letting it through would
  // construct a `CfnLocalStateProvider` with `cfnStackName: ''` and the
  // SDK's `DescribeStackResources({ StackName: '' })` rejects with a
  // generic ValidationError far from the call site. Reject at the
  // dispatcher with a clear remediation message instead.
  if (cfnStackOpt === '') {
    throw new LocalStateSourceError(
      '--from-cfn-stack requires a non-empty stack name when an explicit value is provided. ' +
        'Drop the value to use the cdkd stack name, or pass --from-cfn-stack <name>.'
    );
  }

  if (options.fromState) {
    return new S3LocalStateProvider({
      statePrefix: options.statePrefix,
      ...(options.stateBucket !== undefined && { stateBucket: options.stateBucket }),
      ...(options.region !== undefined && { region: options.region }),
      ...(options.profile !== undefined && { profile: options.profile }),
      ...(options.stackRegion !== undefined && { stackRegion: options.stackRegion }),
    });
  }

  if (cfnFlagPresent) {
    const cfnStackName = resolveCfnStackName(cfnStackOpt as string | boolean, cdkdStackName);
    const region = resolveCfnRegion(options, synthRegion);
    return new CfnLocalStateProvider({
      cfnStackName,
      region,
      ...(options.profile !== undefined && { profile: options.profile }),
    });
  }

  return undefined;
}
