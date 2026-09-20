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

/**
 * The path a per-index refusal names. Deliberately WITHOUT the index name: the
 * name is a RESOLVED template value, the caller's message already carries it
 * through a whole-value mask, and a copy embedded here would reach only the
 * substring mask, which ignores a name shorter than its minimum needle.
 */
export const INDEX_CONTRIBUTOR_INSIGHTS_PATH = `GlobalSecondaryIndexes[].${CONTRIBUTOR_INSIGHTS_KEY}`;

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
    const path = INDEX_CONTRIBUTOR_INSIGHTS_PATH;
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
 * Every refusal a CREATE must raise before `CreateTable` goes out: the
 * table-level block's and each index's. A create has no live setting to leave
 * alone, so an unreadable block there is a template error, not a skip.
 */
export function contributorInsightsRefusals(tableBlock: unknown, indexes: unknown): string[] {
  const refusals: string[] = [];
  const table = readContributorInsightsSpec(tableBlock, CONTRIBUTOR_INSIGHTS_KEY);
  if (table.kind === 'unusable') refusals.push(table.reason);
  if (!Array.isArray(indexes)) return refusals;
  // By POSITION, never by name: see {@link INDEX_CONTRIBUTOR_INSIGHTS_PATH}.
  (indexes as unknown[]).forEach((entry, position) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return;
    const read = readContributorInsightsSpec(
      (entry as Record<string, unknown>)[CONTRIBUTOR_INSIGHTS_KEY],
      `GlobalSecondaryIndexes[${position}].${CONTRIBUTOR_INSIGHTS_KEY}`
    );
    if (read.kind === 'unusable') refusals.push(read.reason);
  });
  return refusals;
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
  return (
    readContributorInsightsSpec(desiredEntry?.[CONTRIBUTOR_INSIGHTS_KEY], '').kind === 'usable'
  );
}

/** The setting a `ContributorInsightsStatus` stands for, if any. */
function enabledForStatus(
  status: string | undefined,
  transientAsTarget: boolean
): boolean | undefined {
  if (status === 'ENABLED' || (transientAsTarget && status === 'ENABLING')) return true;
  if (status === 'DISABLED' || (transientAsTarget && status === 'DISABLING')) return false;
  // `FAILED` (and an absent status) is not a setting.
  return undefined;
}

/**
 * Reverse-map the TABLE-level `DescribeContributorInsights` answer to the CFn
 * block, or `undefined` when there is nothing stable to report.
 *
 * Only the terminal statuses are mapped, and `Mode` is emitted whenever AWS
 * reports one for an enabled table — the block is a TOP-LEVEL key, which the
 * comparator walks by the baseline's own keys. `Mode` is never emitted for a
 * disabled block: it is not sent with `DISABLE`, and a disabled block carrying
 * one is a CFn-invalid placeholder.
 */
export function reverseMapTableContributorInsights(
  status: string | undefined,
  mode: string | undefined
): Record<string, unknown> | undefined {
  const enabled = enabledForStatus(status, false);
  if (enabled === undefined) return undefined;
  const block: Record<string, unknown> = { Enabled: enabled };
  if (enabled && mode !== undefined) block['Mode'] = mode;
  return block;
}

/**
 * Reverse-map one PER-INDEX `DescribeContributorInsights` answer, shaped by
 * the block the DESIRED entry declares. `undefined` when there is nothing to
 * report or the declared block is not one cdkd acts on.
 *
 * The per-index block sits inside an ARRAY entry, which the comparator matches
 * as a whole and by exact key set, so everything here exists to make the
 * read-back equal the declaration whenever AWS holds what was declared:
 *
 *  - `ENABLING` / `DISABLING` read as their TARGET. The deploy does not wait
 *    for the toggle, so the post-deploy `observedProperties` capture usually
 *    sees `ENABLING`; omitting the block would freeze an entry the settled
 *    index can never equal.
 *  - `Mode` is emitted only when the declared block carries one: AWS reports a
 *    mode for every enabled rule set (its default when none was sent). While
 *    `ENABLING`, a mode AWS does not report yet reads as the declared one —
 *    the one that was just sent.
 *  - `Enabled` keeps the declared SPELLING when the template wrote a string
 *    (`'true'`), since the comparator does not coerce.
 */
export function reverseMapIndexContributorInsights(
  status: string | undefined,
  mode: string | undefined,
  declaredBlock: unknown
): Record<string, unknown> | undefined {
  const declared = readContributorInsightsSpec(declaredBlock, INDEX_CONTRIBUTOR_INSIGHTS_PATH);
  if (declared.kind !== 'usable') return undefined;
  const enabled = enabledForStatus(status, true);
  if (enabled === undefined) return undefined;
  const declaredEnabled = (declaredBlock as Record<string, unknown>)['Enabled'];
  const block: Record<string, unknown> = {
    Enabled:
      typeof declaredEnabled !== 'string'
        ? enabled
        : declared.enabled === enabled
          ? declaredEnabled
          : String(enabled),
  };
  if (enabled && declared.mode !== undefined) {
    const liveMode = mode ?? (status === 'ENABLING' ? declared.mode : undefined);
    if (liveMode !== undefined) block['Mode'] = liveMode;
  }
  return block;
}
