/**
 * The `AWS::DynamoDB::Table` `ContributorInsightsSpecification` rules, in ONE
 * spelling for the table-level block and the per-index
 * (`GlobalSecondaryIndexes[].ContributorInsightsSpecification`) one (issue
 * [#1782](https://github.com/go-to-k/cdkd/issues/1782)).
 *
 * Neither block rides `CreateTable` / `UpdateTable`: DynamoDB applies it
 * through `UpdateContributorInsights` and reports it through
 * `DescribeContributorInsights`, and both calls address an index by adding
 * `IndexName`. The SDK's `GlobalSecondaryIndex` shape has NO such member, so a
 * per-index block left inside the forwarded index entry is discarded by the
 * serializer — a template asking for per-index Contributor Insights deployed
 * green with the feature off.
 *
 * Pure, so the write plan and the drift read-back gate cannot answer "does
 * this index declare the block" differently.
 */
import { configBooleanRefusal, configStringRefusal, coerceCfnBoolean } from './config-shape.js';

/** The CFn property name, shared by the table-level and the per-index block. */
export const CONTRIBUTOR_INSIGHTS_KEY = 'ContributorInsightsSpecification';

/** One read of a declared `ContributorInsightsSpecification`. */
export type ContributorInsightsSpecRead =
  /** Not declared (`undefined` / `null`). On an UPDATE this is a REMOVAL. */
  | { kind: 'absent' }
  /** Declared and readable. `mode` is set only when the block declares one. */
  | { kind: 'usable'; enabled: boolean; mode?: string }
  /**
   * Declared but unreadable (a scalar, an array, an unresolved intrinsic, a
   * non-boolean `Enabled`, a non-string `Mode`). Never read as a default:
   * `Boolean('false')` is `true`, which ENABLES what the template disabled.
   */
  | { kind: 'unusable'; reason: string };

/**
 * Read a `ContributorInsightsSpecification` block.
 *
 * An ABSENT `Enabled` reads as `false` — the member is required by the CFn
 * schema, and disabling is the answer that cannot start a billed feature.
 */
export function readContributorInsightsSpec(
  value: unknown,
  path: string
): ContributorInsightsSpecRead {
  if (value === undefined || value === null) return { kind: 'absent' };
  const refusal =
    configBooleanRefusal(value, 'Enabled', path) ?? configStringRefusal(value, 'Mode', '', path);
  if (refusal !== undefined) return { kind: 'unusable', reason: refusal };
  const block = value as Record<string, unknown>;
  const enabled = coerceCfnBoolean(block['Enabled']) ?? false;
  const mode = block['Mode'];
  return typeof mode === 'string' && mode.length > 0
    ? { kind: 'usable', enabled, mode }
    : { kind: 'usable', enabled };
}

/** One `UpdateContributorInsights` call to issue. */
export interface ContributorInsightsOp {
  /** `undefined` addresses the TABLE; a name addresses that index. */
  indexName?: string;
  action: 'ENABLE' | 'DISABLE';
  /** Only ever set alongside `ENABLE`: AWS rejects a mode on `DISABLE`. */
  mode?: string;
}

/**
 * The call one block needs, given the block the PREVIOUS side recorded.
 *
 * - `absent` with a DECLARED previous (usable or not) is a template REMOVAL and
 *   DISABLES — the rule this provider's other post-ACTIVE blocks (PITR, TTL,
 *   Kinesis) and the table-level block already follow. Because the rule is
 *   symmetric in its two sides, a rollback — which replays `update()` with the
 *   sides SWAPPED — restores the old setting through the same arms.
 * - `unusable` issues NOTHING and reports through `onUnusable`: the live
 *   setting is left alone rather than overwritten with a guess.
 * - An unchanged usable block issues nothing. `mode` takes part only while
 *   enabled, since it is never sent with `DISABLE`.
 */
export function planContributorInsightsOp(
  desired: ContributorInsightsSpecRead,
  previous: ContributorInsightsSpecRead,
  onUnusable: (reason: string) => void
): Omit<ContributorInsightsOp, 'indexName'> | undefined {
  if (desired.kind === 'unusable') {
    onUnusable(desired.reason);
    return undefined;
  }
  if (desired.kind === 'absent') {
    return previous.kind === 'absent' ? undefined : { action: 'DISABLE' };
  }
  if (
    previous.kind === 'usable' &&
    previous.enabled === desired.enabled &&
    (!desired.enabled || previous.mode === desired.mode)
  ) {
    return undefined;
  }
  if (!desired.enabled) return { action: 'DISABLE' };
  return desired.mode === undefined
    ? { action: 'ENABLE' }
    : { action: 'ENABLE', mode: desired.mode };
}

/** Index a CFn `GlobalSecondaryIndexes` value by `IndexName`. */
function indexEntriesByName(value: unknown): Map<string, Record<string, unknown>> {
  const byName = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(value)) return byName;
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const name = (entry as Record<string, unknown>)['IndexName'];
    if (typeof name === 'string') byName.set(name, entry as Record<string, unknown>);
  }
  return byName;
}

/**
 * The per-index calls an index list needs, in DESIRED order.
 *
 * Only an index the DESIRED list still names can produce a call: an index the
 * update removed takes its Contributor Insights rules with it, and a call
 * naming it fails with `ResourceNotFoundException`. An index that is NEW in
 * the desired list has an `absent` previous side, so its declared block is
 * always applied.
 */
export function planIndexContributorInsightsOps(
  desiredIndexes: unknown,
  previousIndexes: unknown,
  onUnusable: (indexName: string, reason: string) => void
): ContributorInsightsOp[] {
  const previousByName = indexEntriesByName(previousIndexes);
  const ops: ContributorInsightsOp[] = [];
  for (const [indexName, entry] of indexEntriesByName(desiredIndexes)) {
    const path = `GlobalSecondaryIndexes[${indexName}].${CONTRIBUTOR_INSIGHTS_KEY}`;
    const op = planContributorInsightsOp(
      readContributorInsightsSpec(entry[CONTRIBUTOR_INSIGHTS_KEY], path),
      readContributorInsightsSpec(previousByName.get(indexName)?.[CONTRIBUTOR_INSIGHTS_KEY], path),
      (reason) => onUnusable(indexName, reason)
    );
    if (op !== undefined) ops.push({ indexName, ...op });
  }
  return ops;
}

/**
 * One index entry WITHOUT its `ContributorInsightsSpecification`, for the
 * `CreateTable` forward.
 *
 * Explicit so nothing relies on the SDK serializer discarding a member its
 * `GlobalSecondaryIndex` shape does not have. Returns the entry UNCHANGED —
 * identity included — when there is nothing to strip, and never mutates it: the
 * bag is the caller's resolved template, which the engine records into state.
 */
export function stripIndexContributorInsights<T>(entry: T): T {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
  if (!(CONTRIBUTOR_INSIGHTS_KEY in entry)) return entry;
  const { [CONTRIBUTOR_INSIGHTS_KEY]: _stripped, ...rest } = entry as Record<string, unknown>;
  return rest as T;
}

/**
 * Does this DESIRED index entry declare a block cdkd would act on — the gate
 * for the per-index drift read-back, which costs one API call per index?
 *
 * The same reader the write plan runs, so an `unusable` block (never sent) is
 * never read back either.
 */
export function indexDeclaresContributorInsights(
  desiredEntry: Record<string, unknown> | undefined
): boolean {
  return readContributorInsightsSpec(desiredEntry?.[CONTRIBUTOR_INSIGHTS_KEY], '').kind === 'usable';
}

/** How {@link reverseMapContributorInsights} treats what AWS reports. */
export interface ContributorInsightsReverseMapOptions {
  /**
   * Emit `Mode`. AWS reports a mode for every enabled rule set (its default
   * when none was sent), so the per-index caller passes whether the DESIRED
   * block declares one: that block is compared inside an ARRAY entry whose key
   * set must match exactly, where an undeclared `Mode` is permanent one-sided
   * drift against a `properties` baseline.
   */
  emitMode: boolean;
  /**
   * Read `ENABLING` as enabled and `DISABLING` as disabled instead of omitting
   * the block. The per-index caller needs this: the deploy does not wait for
   * the toggle to settle, so the post-deploy `observedProperties` capture
   * usually sees `ENABLING`, and an omitted block would freeze a baseline the
   * settled index can never equal (the entry is compared as a whole).
   */
  transientAsTarget: boolean;
}

/**
 * Reverse-map one `DescribeContributorInsights` answer to the CFn block, or
 * `undefined` when there is nothing to report.
 *
 * `FAILED` (and an absent status) is never a setting, so it maps to nothing.
 * `Mode` is emitted only for an enabled block: it is never sent with
 * `DISABLE`, and a disabled block carrying one is a CFn-invalid placeholder.
 */
export function reverseMapContributorInsights(
  status: string | undefined,
  mode: string | undefined,
  options: ContributorInsightsReverseMapOptions
): Record<string, unknown> | undefined {
  const enabled =
    status === 'ENABLED' || (options.transientAsTarget && status === 'ENABLING')
      ? true
      : status === 'DISABLED' || (options.transientAsTarget && status === 'DISABLING')
        ? false
        : undefined;
  if (enabled === undefined) return undefined;
  const block: Record<string, unknown> = { Enabled: enabled };
  if (enabled && options.emitMode && mode !== undefined) block['Mode'] = mode;
  return block;
}
