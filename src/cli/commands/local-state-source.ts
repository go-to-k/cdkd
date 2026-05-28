/**
 * Single-source-of-truth helper that picks a {@link LocalStateProvider}
 * for the `cdkd local *` family from CLI flags (issue #606).
 *
 * The four `cdkd local *` commands all support two mutually-exclusive
 * state-source flags:
 *
 *   - `--from-state` (S3-backed; reads cdkd's state for a stack
 *     deployed via `cdkd deploy`). cdkd-specific.
 *   - `--from-cfn-stack [<cfn-stack-name>]` (CFn-backed; reads a
 *     deployed CloudFormation stack via `DescribeStackResources`).
 *     Inherited from `cdk-local`.
 *
 * This module is a thin shim around `cdk-local`'s state-source
 * dispatcher: it re-exports the shared helpers verbatim and adds a
 * cdkd-specific `createLocalStateProvider` that injects the
 * S3-backed `--from-state` factory via `cdk-local`'s
 * `extraStateProviders` hook.
 */

import {
  createLocalStateProvider as createLocalStateProviderBase,
  type LocalStateProvider,
  type LocalStateProviderFactory,
  type LocalStateSourceOptions as LocalStateSourceOptionsBase,
} from 'cdk-local';
import { S3LocalStateProvider } from '../../local/s3-local-state-provider.js';

export {
  CfnLocalStateProvider,
  type CfnLocalStateProviderOptions,
  isCfnFlagPresent,
  LocalStateSourceError,
  type LocalStateProvider,
  type LocalStateProviderFactory,
  type LocalStateRecord,
  rejectExplicitCfnStackWithMultipleStacks,
  resolveCfnRegion,
  resolveCfnStackName,
} from 'cdk-local';

/**
 * Options the four `cdkd local *` commands gather from their flag set.
 *
 * Declared as a closed shape (no `[key: string]: unknown` index
 * signature inherited from cdk-local) so the existing command-option
 * interfaces (`LocalInvokeOptions` / `LocalStartApiOptions` / etc.)
 * stay assignable without each one needing to open up its own index
 * signature. The cdk-local boundary requires the index signature for
 * host extensibility; the shim's `createLocalStateProvider` performs
 * the (semantically safe) cast at the boundary.
 */
export interface LocalStateSourceOptions {
  /** True when `--from-state` was passed. */
  fromState: boolean;
  /** S3 bucket for `--from-state`. */
  stateBucket?: string;
  /** S3 key prefix for `--from-state`; commander always supplies the default. */
  statePrefix: string;
  /**
   * `--from-cfn-stack` flag value. Commander maps:
   *   - flag absent → `undefined`
   *   - `--from-cfn-stack` (bare) → `true`
   *   - `--from-cfn-stack <name>` → `'<name>'`
   */
  fromCfnStack?: string | boolean;
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
 * cdkd's `--from-state` factory. Reads cdkd-specific fields off the
 * options bag (carried through cdk-local's `LocalStateSourceOptions`
 * index signature) to construct an `S3LocalStateProvider`. Bound into
 * cdk-local's dispatcher via `extraStateProviders: { fromState }` so
 * cdk-local can treat it identically to its built-in `--from-cfn-stack`.
 */
const fromStateFactory: LocalStateProviderFactory = (options) => {
  // Narrow back to the cdkd-augmented shape. Safe because cdk-local
  // only ever invokes this factory with the options bag the shim
  // wrapper passed in, which carries every cdkd field.
  const opts = options as unknown as LocalStateSourceOptions;
  return new S3LocalStateProvider({
    statePrefix: opts.statePrefix,
    ...(opts.stateBucket !== undefined && { stateBucket: opts.stateBucket }),
    ...(opts.region !== undefined && { region: opts.region }),
    ...(opts.profile !== undefined && { profile: opts.profile }),
    ...(opts.stackRegion !== undefined && { stackRegion: opts.stackRegion }),
  });
};

/**
 * Pick and construct the right `LocalStateProvider` for the supplied
 * flag set. Delegates to cdk-local's dispatcher with cdkd's
 * `--from-state` factory wired in. Returns `undefined` when neither
 * flag is set (caller skips the substitution pass). Throws
 * `LocalStateSourceError` when both flags are set (mutually exclusive)
 * or when `--from-cfn-stack` is given an explicit empty string.
 *
 * `cdkdStackName` is the cdkd-side stack name the local command
 * resolved to its target — used for the bare-`--from-cfn-stack`
 * default. `synthRegion` is the synth-derived stack region
 * (`env.region` on the CDK stack) — fallback for the CFn client when
 * no explicit region override is set.
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
  // Cast at the cdk-local boundary: cdk-local's LocalStateSourceOptions
  // declares `[key: string]: unknown` so hosts can stash extra
  // option fields, but cdkd's options interfaces are intentionally
  // closed-shape (so unknown property accesses are TS errors, not
  // `unknown` reads). The cast is semantically safe — cdkd's interface
  // has every base field cdk-local reads.
  return createLocalStateProviderBase(
    options as unknown as LocalStateSourceOptionsBase,
    cdkdStackName,
    synthRegion,
    { fromState: fromStateFactory }
  );
}
