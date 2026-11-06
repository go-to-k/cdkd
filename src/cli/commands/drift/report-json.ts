/**
 * `cdkd drift`: the `--json` report.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import { stringifyJsonPayload } from '../../../utils/display-safe.js';
import type { ResourceProvider } from '../../../types/resource.js';
import type { ResourceState } from '../../../types/state.js';
import {
  unsettledPropertiesOf,
  withUnsettledProperties,
  withoutUnsettledProperties,
  unsettledItemsField,
} from '../../../state/unsettled-properties.js';
import {
  type NotComparedCause,
  type StackDriftReport,
  matchOutcome,
  notComparedOutcomes,
  ANY_OF_IT_COMPARED,
} from './outcome.js';
import { displayDriftPath, displayDriftValue } from './report.js';

/**
 * JSON output shape — stable contract for tooling. Each stack carries
 * separate `drifted` / `notSupported` arrays so consumers don't have to
 * filter by `kind`.
 *
 * Issue [#2108](https://github.com/go-to-k/cdkd/issues/2108) added
 * `referencesUnresolved` to every `drifted` and `clean` entry, plus the
 * `notCompared` roll-up, because `clean` was ambiguous in the one direction
 * that matters: a resource whose secret-bearing properties cdkd REFUSED to
 * resolve (so they were never compared) landed in `clean` looking exactly like
 * a resource that was compared and matched. A CI job gating on
 * `drifted.length === 0` therefore read a skipped comparison as a pass. The
 * roll-up is there so such a job needs ONE key rather than a filter over two
 * arrays: `notCompared.length === 0` is the honest "everything was actually
 * checked" predicate.
 *
 * Issue [#2135](https://github.com/go-to-k/cdkd/issues/2135) then took the
 * ambiguity out of `clean` itself: an uncompared resource is now reported ONLY
 * under `notCompared`, never in `clean`, because a flag a reader has to
 * remember to consult defaults to the wrong answer when they forget. Every key
 * keeps its name and meaning; what changed is which ARRAY such a resource
 * appears in. `clean[].referencesUnresolved` is therefore `false` for every
 * entry now — kept rather than dropped so a consumer reading the documented key
 * still finds it, and narrowed to the literal `false` so the invariant is
 * stated where the contract is.
 */
interface StackDriftJson {
  stack: string;
  region: string;
  drifted: Array<{
    logicalId: string;
    type: string;
    changes: Array<{ path: string; stateValue: unknown; awsValue: unknown }>;
    referencesUnresolved: boolean;
  }>;
  /**
   * Compared against AWS and MATCHED — every entry, since #2135. The flag is
   * `false` by construction here; see the note above the interface.
   */
  clean: Array<{ logicalId: string; type: string; referencesUnresolved: false }>;
  /**
   * Resources AWS reports do NOT EXIST — deleted outside cdkd — and nested
   * stack rows whose own record is gone (`nestedStackRecordMissing`, go-to-k/cdkd#4533)
   * (go-to-k/cdkd#4283). Drift: a non-empty array is what exits detection `1`
   * alongside `drifted`. Never in `notSupported`, where they used to land.
   */
  deleted: Array<{ logicalId: string; type: string; nestedStackRecordMissing?: true }>;
  notSupported: Array<{ logicalId: string; type: string }>;
  /**
   * Stack-level advisories, verbatim (issue
   * [#3011](https://github.com/go-to-k/cdkd/issues/3011)). OMITTED when empty,
   * so an ordinary payload is byte-identical to what a pre-#3011 consumer
   * parsed.
   *
   * It exists because the warnings go to STDERR and this payload goes to
   * STDOUT: a consumer capturing only stdout — the CI-in-a-pipeline shape, and
   * the one most exposed to the disclosure these advise about — could not see
   * them at all. Strings rather than a structured shape on purpose: they are an
   * advisory for a human reading a log, not a field to branch on, and inventing
   * a schema for them would invite exactly that.
   */
  warnings?: string[];
  /**
   * go-to-k/cdkd#5380: resources whose record names properties a failed
   * deploy's update left unsettled (AWS may hold either side), with those
   * property names. OMITTED when empty. Informational: the next `cdkd deploy`
   * sends them again, and a successful `--accept` / `--revert` of the
   * resource clears them.
   */
  unsettled?: Array<{ logicalId: string; type: string; properties: string[] }>;
  /** Issue #323: Custom Resources (drift not applicable); nested stack rows covered by their own block (#4533). */
  skipped: Array<{ logicalId: string; type: string }>;
  /**
   * Every resource cdkd did not fully compare: the `notCompared` outcomes, plus
   * any `drifted` one carrying a `notComparedCause`. A drifted one belongs here
   * too — the changes it DOES report are real, but they are not the whole
   * comparison.
   *
   * Issues [#2151](https://github.com/go-to-k/cdkd/issues/2151) /
   * [#1945](https://github.com/go-to-k/cdkd/issues/1945) widened this array's
   * population beyond dynamic references, and two keys move with it.
   *
   * `referencesUnresolved` was the literal `true`, which stopped being a fact
   * about the entry the moment a `readFailed` one could sit here: nothing about
   * that resource's references is unresolved, its READ threw. It is now computed
   * per entry and typed `boolean`. The key keeps its name and its meaning — a
   * consumer reading it gets the true answer rather than a constant — and the
   * documented honest predicate is unaffected, because it was never this key:
   * `notCompared.length === 0` is still "everything was actually checked".
   *
   * `cause` is ADDITIVE and is what a CI job should key on when it wants to
   * distinguish them, because the three differ in whether a re-run can clear
   * them: `readFailed` and `refused` can, `unresolvedToken` never will. Without
   * it that distinction was readable only off the exit code, which is per RUN
   * and cannot say WHICH resource.
   */
  notCompared: Array<{
    logicalId: string;
    type: string;
    referencesUnresolved: boolean;
    cause: NotComparedCause;
  }>;
}

/**
 * go-to-k/cdkd#5380: `record` after a successful `--accept` / `--revert` of
 * it: its `unsettledProperties` keep only the names its provider reports AWS
 * is still changing (`unsettledInTransition`), and the field goes when none
 * is. A provider without the hook has none in transition; a hook that throws
 * keeps every name, which only costs the next deploy a re-send. Returns
 * `record` itself when nothing would change.
 */
export async function settleUnsettled(
  record: ResourceState,
  logicalId: string,
  providerOf: () => ResourceProvider | undefined
): Promise<ResourceState> {
  const names = unsettledPropertiesOf(record);
  if (names.size === 0) return record;
  let kept: ReadonlySet<string> = new Set();
  try {
    const provider = providerOf();
    if (provider?.unsettledInTransition !== undefined) {
      kept = await provider.unsettledInTransition(
        record.physicalId,
        logicalId,
        record.resourceType,
        names,
        record.properties
      );
    }
  } catch {
    kept = names;
  }
  const keep = [...names].filter((name) => kept.has(name));
  if (keep.length === names.size) return record;
  // go-to-k/cdkd#5498: a kept name keeps its attempted items; a cleared one's go.
  return {
    ...withUnsettledProperties(withoutUnsettledProperties(record), keep),
    ...unsettledItemsField(record, keep),
  };
}

/**
 * go-to-k/cdkd#5380: the stack's records that carry `unsettledProperties`, in
 * logical-id order, for both renderings of the report.
 */
export function unsettledRowsOf(
  report: StackDriftReport
): Array<{ logicalId: string; type: string; properties: string[] }> {
  const rows: Array<{ logicalId: string; type: string; properties: string[] }> = [];
  const resources = report.state.resources ?? {};
  for (const logicalId of Object.keys(resources).sort()) {
    const record = resources[logicalId];
    const names = unsettledPropertiesOf(record);
    if (names.size === 0) continue;
    rows.push({
      logicalId,
      type: typeof record?.resourceType === 'string' ? record.resourceType : 'unknown',
      properties: [...names].sort(),
    });
  }
  return rows;
}

export function writeJsonReport(reports: StackDriftReport[]): void {
  const payload: StackDriftJson[] = reports.map((r) => {
    const unsettled = unsettledRowsOf(r);
    const drifted: StackDriftJson['drifted'] = [];
    const clean: StackDriftJson['clean'] = [];
    const deleted: StackDriftJson['deleted'] = [];
    const notSupported: StackDriftJson['notSupported'] = [];
    const skipped: StackDriftJson['skipped'] = [];
    // Issue #2135: ONE exhaustive pass instead of four `kind` filters, so a new
    // outcome variant cannot be omitted from the payload by nobody noticing —
    // the mapped-type handler record refuses to compile until it is named here.
    for (const o of r.outcomes) {
      matchOutcome<void>(o, {
        drifted: (d) => {
          drifted.push({
            logicalId: d.logicalId,
            type: d.resourceType,
            changes: d.changes.map((change) => ({
              ...change,
              path: displayDriftPath(d, change.path),
              stateValue: displayDriftValue(d, change.stateValue),
              awsValue: displayDriftValue(d, change.awsValue),
            })),
            referencesUnresolved: d.notComparedCause !== undefined,
          });
        },
        // `false` is not a fact about this resource any more, it is a fact about
        // the array: since #2135 an uncompared resource is never in it.
        clean: (c) => {
          clean.push({ logicalId: c.logicalId, type: c.resourceType, referencesUnresolved: false });
        },
        // Rolled up below, together with the drifted-but-incomplete ones, by
        // the single spelling both renderings share.
        notCompared: () => {},
        unsupported: (u) => {
          notSupported.push({ logicalId: u.logicalId, type: u.resourceType });
        },
        skipped: (sk) => {
          skipped.push({ logicalId: sk.logicalId, type: sk.resourceType });
        },
        deleted: (del) => {
          // Present only on a nested row with no record, so an ordinary
          // payload is byte-identical (go-to-k/cdkd#4533).
          deleted.push({
            logicalId: del.logicalId,
            type: del.resourceType,
            ...(del.nestedStackRecordMissing === true && {
              nestedStackRecordMissing: true as const,
            }),
          });
        },
      });
    }
    const notCompared: StackDriftJson['notCompared'] = notComparedOutcomes(r).map(
      ({ outcome, cause }) => ({
        logicalId: outcome.logicalId,
        type: outcome.resourceType,
        // Read off `ANY_OF_IT_COMPARED` rather than a third hand-written cause
        // list: the two partitions are the same one. A row is PARTIALLY
        // compared exactly when a dynamic reference is what stopped it, and
        // `readFailed` / `baselineRefused` / `unreadableRecord` /
        // `unreadableMap` are about no reference at all (issue #2952;
        // go-to-k/cdkd#3018, whose new cause an exclusion list here would have
        // reported as `true`).
        referencesUnresolved: ANY_OF_IT_COMPARED[cause],
        cause,
      })
    );
    return {
      stack: r.stackName,
      region: r.region,
      // Omitted when empty — see the field's doc.
      ...(r.warnings.length > 0 && { warnings: r.warnings }),
      ...(unsettled.length > 0 && { unsettled }),
      drifted,
      deleted,
      clean,
      notSupported,
      skipped,
      notCompared,
    };
  });
  // Escaped, not sanitised (go-to-k/cdkd#4045): the values parse back
  // unchanged, but DEL, C1, a line separator or a bidi control in a stored
  // value reaches the terminal as `\uXXXX` escape text.
  process.stdout.write(`${stringifyJsonPayload(payload)}\n`);
}
