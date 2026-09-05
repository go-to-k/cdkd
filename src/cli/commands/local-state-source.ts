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
 *     deployed CloudFormation stack via `ListStackResources`).
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
  type ExtraStateProviders,
  type LocalStateProvider,
  type LocalStateProviderFactory,
  type LocalStateSourceOptions as LocalStateSourceOptionsBase,
} from 'cdk-local';
import { S3LocalStateProvider } from '../../local/s3-local-state-provider.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';

export {
  CfnLocalStateProvider,
  type CfnLocalStateProviderOptions,
  type ExtraStateProviders,
  isCfnFlagPresent,
  LocalStateSourceError,
  type LocalStateProvider,
  type LocalStateProviderFactory,
  type LocalStateRecord,
  rejectExplicitCfnStackWithMultipleStacks,
  resolveCfnFallbackRegion,
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
  /**
   * The user's UNFOLDED `--stack-region` spelling, captured by each command's
   * handler BEFORE it folds the flag (issue #1836 round 3). Consumed only by
   * the state-record match in `local-state-loader.ts` — see
   * `LoadStateForStackOptions.rawStackRegion` for the full rationale.
   *
   * Since issue [#2522](https://github.com/go-to-k/cdkd/issues/2522) the four
   * ECS / CloudFront / AgentCore ENGINE commands capture it too, from the
   * `preAction` hook `adoptDeprecatedRegionFlag` installs — cdk-local owns
   * their handler, so the hook is their only cdkd-owned point BEFORE the fold.
   * The factory's fallback to the raw `stackRegion` below therefore no longer
   * has a caller in this repo, and is kept as the correct answer for a bag that
   * reached the factory without passing a capture point at all (a direct
   * `createLocalStateProvider` call from a test or a future embedder).
   */
  rawStackRegion?: string;
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
  const clientRegion = canonicalizeRegion(opts.region) || undefined;
  // Issue #1836 round 4: the FOLDED half is gated on blank-is-absent too, so the
  // `rawStackRegion` line below can honestly claim to match it. Round 3's gate
  // was `opts.stackRegion !== undefined`, so `--stack-region ''` still forwarded
  // `stackRegion: ''` while the comment beside it claimed parity with the raw
  // half. That was harmless downstream (`loadStateForStack` gates on
  // TRUTHINESS), but a false parity claim is exactly what the round-3 review
  // found twice, and this branch already adopted blank-is-absent at the four
  // client boundaries — a blank names no region at any of them.
  const stackRegion = canonicalizeRegion(opts.stackRegion) || undefined;
  // The RAW `--stack-region` spelling for the state-record match (issue #1836
  // round 3). Every cdkd `local *` command now captures it before its own fold —
  // the four that own their handler do it there, the four ENGINE commands from
  // the `preAction` hook `adoptDeprecatedRegionFlag` installs (issue #2522). The
  // fallback to the still-raw `stackRegion` remains for a bag that reached this
  // factory without passing either capture point. Blank counts as absent,
  // matching the `stackRegion` gate above.
  const rawStackRegion = opts.rawStackRegion || opts.stackRegion || undefined;
  return new S3LocalStateProvider({
    statePrefix: opts.statePrefix,
    ...(opts.stateBucket !== undefined && { stateBucket: opts.stateBucket }),
    // Issue #1836: `--region` needs the SAME boundary fold as `--stack-region`
    // below, and for a consequence one step worse than a missed compare: it
    // builds the `AwsClients` + `S3StateBackend` in `local-state-loader.ts`, and
    // SDK endpoint resolution is case-SENSITIVE — so `cdkd local start-service
    // --from-state --region CN-NORTH-1` reached a COMMERCIAL endpoint. The four
    // commands with their own handler fold `--region` on entry (#1795) and the
    // ENGINE commands fold it in their `preAction` hook (#2522), so this is
    // idempotent for all eight — and still the last stop for a direct call.
    // A blank `--region ''` is treated as ABSENT rather than forwarded: it names
    // no endpoint, and omitting it is what lets the SDK's own chain resolve the
    // profile's region.
    ...(clientRegion !== undefined && { region: clientRegion }),
    ...(opts.profile !== undefined && { profile: opts.profile }),
    // Issue #1836: fold `--stack-region` at THIS boundary as well as at each
    // command's handler entry. The four `cdkd local` commands that declare the
    // flag themselves (`invoke` / `start-api` / `run-task` / `invoke-agentcore`)
    // fold it on entry, and since issue #2522 the ECS / CloudFront / AgentCore
    // ENGINE commands (`start-service` / `start-alb` / `start-cloudfront` /
    // `start-agentcore`) fold it in the `preAction` hook cdkd installs on top of
    // cdk-local's handler — so this boundary is now a second, idempotent fold
    // rather than the only cdkd-owned point. Downstream it is compared
    // against a state record's region and used to build the state key, both
    // case-SENSITIVE. A blank `--stack-region ''` is ABSENT here — see the
    // `stackRegion` binding above.
    ...(stackRegion !== undefined && { stackRegion }),
    // ... and carry the RAW spelling beside it, because the folded value is the
    // one an endpoint needs and the raw one is the only thing that can make
    // "an exactly-spelled region wins over a case-variant record" true.
    ...(rawStackRegion !== undefined && { rawStackRegion }),
  });
};

/**
 * Cdkd's `extraStateProviders` map for cdk-local's engine entry points
 * (e.g. `runEcsServiceEmulator`) that accept a state-source factory
 * registry directly instead of going through `createLocalStateProvider`.
 * The engine calls `createLocalStateProvider` internally with this map,
 * so cdkd's `--from-state` flow is wired in transparently.
 */
export const cdkdExtraStateProviders: ExtraStateProviders = {
  fromState: fromStateFactory,
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
    cdkdExtraStateProviders
  );
}
