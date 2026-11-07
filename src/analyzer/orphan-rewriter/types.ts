import type { StackState } from '../../types/state.js';

/**
 * One rewrite the orphan rewriter has applied (or wanted to apply but
 * couldn't). Rendered as the audit table that `cdkd orphan` prints before
 * (and during) state save.
 *
 * - `kind: 'ref'` — a `{Ref: O}` was replaced with the value CFn's `Ref`
 *   returns for O (its physicalId for most types; see
 *   {@link cfnRefValueFromPhysicalId} for the exceptions).
 * - `kind: 'getAtt'` — a `{Fn::GetAtt: [O, attr]}` (array OR string form)
 *   was replaced with the attribute value: the recorded one when servable,
 *   otherwise a live read.
 * - `kind: 'sub'` — an `${O}` or `${O.attr}` placeholder inside an
 *   `Fn::Sub` template string was substituted in place. The substituted
 *   sub-template (rather than the whole Fn::Sub block) is recorded so the
 *   audit row shows exactly what changed.
 * - `kind: 'dependency'` — the orphan's logicalId was removed from the
 *   `dependencies` array of another resource.
 *
 * `before` and `after` are JSON-serializable snapshots; the CLI renders
 * them as `JSON.stringify(value)` in the audit table.
 */
export interface OrphanRewrite {
  /** logicalId of the resource whose state was rewritten. */
  logicalId: string;
  /** Dotted JSON-pointer-ish path within the resource (e.g. `properties.Bucket`). */
  path: string;
  kind: 'ref' | 'getAtt' | 'sub' | 'dependency';
  before: unknown;
  after: unknown;
  /**
   * logicalId of the orphan that this rewrite resolved. Useful for the
   * audit table header ("rewrites caused by orphaning O") and for
   * grouping unresolvable-attribute errors by orphan.
   */
  orphanLogicalId: string;
}

/**
 * One reference to an orphan that the rewriter could not resolve.
 *
 * Collected up front (rather than thrown immediately) so a single failed
 * orphan run can list every unresolvable site at once instead of forcing
 * the user through one fix-rerun-fix cycle per attribute.
 */
export interface UnresolvableReference {
  /** logicalId of the resource that holds the unresolvable reference. */
  logicalId: string;
  path: string;
  /** logicalId of the orphan whose attribute could not be fetched. */
  orphanLogicalId: string;
  /** The CFn attribute name (`Arn`, `Ref`, `WebsiteURL`, …). `Ref` for `{Ref: O}` and Fn::Sub `${O}`. */
  attribute: string;
  /** Human-readable reason. */
  reason: string;
}

/**
 * Result of {@link rewriteResourceReferences}.
 *
 * `state` is a brand-new `StackState` value (input is not mutated). When
 * `unresolvable` is non-empty the caller decides whether to abort
 * (default) or to fall back to cached attributes via `--force`. The
 * `rewrites` audit log is always populated even on failure so users see
 * what _would_ have changed.
 */
export interface OrphanRewriteResult {
  state: StackState;
  rewrites: OrphanRewrite[];
  unresolvable: UnresolvableReference[];
}

/**
 * Caller-supplied options that control how unresolvable references are
 * handled.
 *
 * - `force = false` (default): unresolvable references are collected and
 *   returned via `unresolvable`; the caller is expected to abort.
 * - `force = true`: the rewriter consults the orphan's
 *   `state.attributes` cache as a fallback. If the cache holds a value
 *   for the attribute, the original intrinsic is replaced with that
 *   value and a warning is logged. If the cache also lacks the attr,
 *   the rewriter leaves the original intrinsic untouched (it does NOT
 *   substitute a literal `undefined` / `null`) and surfaces the site
 *   via `unresolvable` for visibility.
 */
export interface OrphanRewriteOptions {
  force?: boolean;
}
