/**
 * `LocalStateProvider` — abstraction over the substitution input the
 * `cdkd local *` commands feed to `state-resolver.ts`.
 *
 * Two implementations:
 *
 *   - {@link S3LocalStateProvider} (default for `--from-state`) — reads
 *     cdkd's S3 state for stacks deployed via `cdkd deploy`. Same
 *     behavior as the pre-issue-#606 code path; the S3 implementation is
 *     a thin wrapper around the existing `loadStateForStack` +
 *     `buildCrossStackResolver` helpers in
 *     `src/cli/commands/local-state-loader.ts`.
 *
 *   - {@link CfnLocalStateProvider} (new for `--from-cfn-stack`) — reads
 *     a deployed CloudFormation stack via `DescribeStackResources` +
 *     `DescribeStacks --Outputs` + `ListExports`. Lets the `local *`
 *     commands substitute deployed physical IDs from a CDK app deployed
 *     via the upstream CDK CLI (`cdk deploy` → CloudFormation), so users
 *     migrating between cdkd and CFn (or running cdkd local against an
 *     existing CFn-managed CDK app) get the same UX they get with
 *     `--from-state` against cdkd-deployed stacks.
 *
 * The interface intentionally mirrors what `state-resolver.ts` consumes:
 * a `Record<string, ResourceState>` (covers `Ref`), an outputs map
 * (cross-stack `Fn::GetStackOutput` source), and an optional cross-stack
 * resolver (`Fn::ImportValue` / `Fn::GetStackOutput`). The four `cdkd
 * local *` command files build a single context off of whatever provider
 * fired and pass it through the substitution engine unchanged.
 *
 * `--from-cfn-stack` is mutually exclusive with `--from-state` at the
 * CLI layer (each command file enforces this); the interface itself
 * carries no notion of which flag was the source so the same provider
 * could in principle drive both flags in the future.
 */

import type { ResourceState } from '../types/state.js';
import type { CrossStackResolver } from './state-resolver.js';

/**
 * Result of loading state for a specific (stack, region) pair. The
 * shape is intentionally a strict subset of cdkd's `StackState` so the
 * substituter doesn't depend on schema fields irrelevant to local
 * execution (lock state, version, lastModified, etc.).
 */
export interface LocalStateRecord {
  /**
   * Per-logical-id resource records. Covers `Ref: <logicalId>` lookups
   * via `physicalId`. The CFn provider also leaves `attributes` empty —
   * `DescribeStackResources` does not return per-attribute values, and
   * the v1 policy is warn-and-drop for unresolvable `Fn::GetAtt` (per
   * issue #606's recommendation (a)).
   */
  resources: Record<string, ResourceState>;
  /**
   * Stack outputs map. Sourced from cdkd state for the S3 provider and
   * from `DescribeStacks.Outputs[]` for the CFn provider. Consumed by
   * `Fn::GetStackOutput` and by the cross-stack resolver when no
   * persistent exports index is available.
   */
  outputs: Record<string, string>;
  /**
   * Region the state record was actually loaded from. For the S3
   * provider this resolves multi-region ambiguity (the same stack name
   * can have state in multiple regions); for the CFn provider it's the
   * region the `cloudformation:DescribeStacks` call hit.
   */
  region: string;
}

/**
 * Source for substitution inputs. Implementations encapsulate both the
 * single-stack load AND the optional cross-stack resolver — the two
 * code paths share the same client / region / credential context, so
 * an implementation can decide internally whether to share a single
 * AWS client across both lookups (the CFn provider does — only one
 * `CloudFormationClient` instance).
 *
 * Failures from `load` are best-effort warn-and-drop: an implementation
 * is expected to log a warning and return `undefined` so the caller
 * falls back to PR 1's "intrinsic-valued env var dropped" behavior.
 * Genuine programmer errors (e.g. mutual-exclusion violation at the
 * CLI layer) are caught earlier.
 *
 * `dispose` is called by the CLI layer when the substitution pass is
 * over so providers can close any AWS clients they own. Implementations
 * MUST tolerate being disposed even when `load` was never called (the
 * caller may construct the provider before deciding whether to use it).
 */
export interface LocalStateProvider {
  /**
   * Short label surfaced in warn messages so users can tell which
   * source produced the substitution they're looking at. Always one of
   * `'--from-state'` / `'--from-cfn-stack'`.
   */
  readonly label: string;
  /**
   * Load the state record for `stackName`. `synthRegion` is the
   * synth-derived stack region (`env.region` on the CDK stack); the
   * implementation may use it as a fallback when no explicit region
   * override is set. Returns `undefined` on any expected miss (no
   * record, ambiguous region, bucket / stack resolution failure).
   */
  load(stackName: string, synthRegion: string | undefined): Promise<LocalStateRecord | undefined>;
  /**
   * Build a cross-stack resolver for `Fn::ImportValue` /
   * `Fn::GetStackOutput`. The S3 provider reads cdkd's exports index +
   * per-stack state; the CFn provider uses `ListExports` (paginated)
   * for `Fn::ImportValue` and rejects `Fn::GetStackOutput` (cdkd-specific
   * intrinsic — CFn has no equivalent). `consumerRegion` is the
   * region the consumer Lambda / ECS task lives in.
   *
   * Returns `undefined` when the resolver could not be built; the
   * caller treats every cross-stack intrinsic as unresolved in that
   * case.
   */
  buildCrossStackResolver(consumerRegion: string): Promise<CrossStackResolver | undefined>;
  /**
   * Release any AWS clients the provider owns. Always called by the
   * CLI layer in the outer `finally`. Idempotent.
   */
  dispose(): void;
}
