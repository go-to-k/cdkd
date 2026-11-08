import type { CdkdError } from '../../../utils/error-handler.js';
import type { ExportIndexStore, ExportIndexEntry } from '../../../state/export-index-store.js';
import { carriesDynamicReference } from '../../../deployment/intrinsic-function-resolver.js';
import { carriesSecretMask } from '../../../deployment/secret-redaction.js';
// An export NAME is a template-controlled RESOLVED value and an index read's
// error message interpolates a bucket / key, so both reach the terminal only
// through the same control-byte strip `export-index-store.ts` uses for the
// name it logs.
import { displayIdent } from '../../../utils/display-safe.js';
import { ScrubIndexInvariantError, ScrubRefusalError } from './errors.js';

/**
 * One exports-index entry owned by a stack this run scrubbed, and what the
 * convergence rule made of it (issue
 * [#2667](https://github.com/go-to-k/cdkd/issues/2667)).
 *
 * `converge` carries the value the stack's post-scrub `state.outputs` holds
 * under that export name; a real run writes it. `absent` is an owned entry
 * whose name is not a key of that bag at all — there is no value to write, so
 * the entry is reported and left holding whatever it holds.
 */
export type ExportIndexFinding =
  | { kind: 'converge'; exportName: string; stateValue: unknown; entryValue: unknown }
  | { kind: 'absent'; exportName: string; entryValue: unknown };

/** What one stack's pass over one region's exports index examined and found. */
export interface ExportIndexRepairPlan {
  /**
   * Every entry name this pass decided about, INCLUDING the ones it left
   * alone. What is not in here was not examined — the run's coverage report
   * subtracts this set rather than re-deriving ownership.
   */
  examined: string[];
  findings: ExportIndexFinding[];
}

/**
 * Which of `entries` this stack's post-scrub `outputs` bag disagrees with.
 *
 * OWNERSHIP is read off the entry (`producerStack` / `producerRegion`), never
 * inferred from the name: a pre-v9 state record makes `importableOutputKeys`
 * return every output key (`src/types/state.ts`), so a rebuild can key an entry
 * by a plain output name, and on a name collision the index keeps the latest
 * writer — so a name alone says nothing about whose entry it is.
 *
 * The rule is CONVERGENCE, not a match against scrub's plaintext map. The map
 * is built by LIVE RESOLUTION against Secrets Manager / SSM, so it holds the
 * secret's value AS IT IS NOW; an index entry written before a rotation holds
 * the value as it was THEN, and the two are different strings. Keying on
 * `state.outputs` instead means the rule reads the record a redeploy and
 * `ExportIndexStore.rebuild()` both write, and the plaintext map is not
 * consulted here at all.
 *
 * The lookup runs in ONE direction, and the inverse is not available: an
 * `Export.Name` alias is written into the outputs bag itself
 * (`deploy-engine/outputs/resolve.ts`, beside `resolvedExportNames.push(exportName)`), so an
 * index entry NAME is a key of that bag — while `ExportIndexEntry` carries no
 * output-key field, so nothing maps an entry back to the output it came from.
 *
 * WHAT CAN STILL GO WRONG. A name absent from `outputs` is reported and
 * nothing is written for it, so an entry in that position keeps its value —
 * `outputs` is `undefined` here whenever the stack has no state record at all,
 * which puts every one of its entries in that arm. An entry whose state value
 * carries no `{{resolve:` is left alone, so a plaintext an index entry holds
 * whose state counterpart is also plaintext is not reported by this pass and
 * not written by it. And `entries` is one region's index: an entry in another
 * region's `exports.json` is outside this call.
 */
export function planExportIndexRepair(
  entries: ReadonlyMap<string, ExportIndexEntry>,
  stackName: string,
  producerRegion: string,
  outputs: Record<string, unknown> | undefined
): ExportIndexRepairPlan {
  const examined: string[] = [];
  const findings: ExportIndexFinding[] = [];
  for (const [exportName, entry] of entries) {
    if (entry.producerStack !== stackName || entry.producerRegion !== producerRegion) continue;
    examined.push(exportName);
    if (outputs === undefined || !Object.hasOwn(outputs, exportName)) {
      findings.push({ kind: 'absent', exportName, entryValue: entry.value });
      continue;
    }
    const stateValue = outputs[exportName];
    // The state record is the canonical side only where it holds an
    // expression: a bag still holding the resolved value is what `scrubStack`
    // has just rewritten, or one this run recorded no needle for, and
    // converging an entry onto a plaintext would move a plaintext INTO the
    // shared object rather than out of it.
    //
    // The redaction MASK is canonical the same way (go-to-k/cdkd#4043 Phase
    // C): a `NoEcho`-served output scrub masked, which a deploy also publishes
    // to the index as `***` (`redactOutputs`), so an entry still holding the
    // value converges onto the mask.
    if (!carriesDynamicReference(stateValue) && !carriesSecretMask(stateValue)) continue;
    // `JSON.stringify` for the same reason `mapsEqual` uses it in the store:
    // an Output value is `unknown` and a list-valued `Fn::GetAtt` persists an
    // array, so `!==` alone reports every array as divergent.
    if (JSON.stringify(entry.value) === JSON.stringify(stateValue)) continue;
    findings.push({ kind: 'converge', exportName, stateValue, entryValue: entry.value });
  }
  return { examined, findings };
}

/**
 * The error a run ends with when `state.json` was rewritten and the exports
 * index was not (issue #2667).
 *
 * EXPLICIT rather than a warn: an entry this run went to converge and did not
 * keeps the value it held, in a region-wide object every principal with
 * `s3:GetObject` on the state bucket can read. `ExportIndexStore.patchEntry`
 * does not throw on a non-retryable S3 failure or an exhausted If-Match budget
 * — it logs and returns `false` — so without this the command would exit 0
 * over exactly that.
 *
 * Naming the remainder is what makes the re-run instruction actionable: the
 * convergence rule reads `state.outputs`, which a completed half already
 * matches, so a second invocation of the same command decides `converge` only
 * for the entries still differing.
 */
export function exportIndexIncompleteError(
  unwritten: ReadonlyArray<{ region: string; shown: string }>,
  unreadable: ReadonlyArray<{ region: string; reason: string }>,
  dryRun: boolean
): CdkdError {
  // `state.json complete` is a claim about a WRITE, so it is false under
  // `--dry-run`, where nothing was written and the only way to reach this
  // error is an index that could not be READ.
  const parts: string[] = [dryRun ? 'no state written (--dry-run)' : 'state.json complete'];
  if (unwritten.length > 0) {
    parts.push(
      `${unwritten.length} exports index entr${unwritten.length === 1 ? 'y' : 'ies'} unwritten ` +
        `(${unwritten.map((u) => `${u.shown} in ${displayIdent(u.region)}`).join(', ')})`
    );
  }
  if (unreadable.length > 0) {
    parts.push(
      `${unreadable.length} region(s) whose exports index could not be read ` +
        `(${unreadable.map((u) => `${displayIdent(u.region)}: ${u.reason}`).join('; ')})`
    );
  }
  return new ScrubRefusalError(
    `${parts.join('; ')}. Re-run the same command once the cause is cleared: each entry is ` +
      `written only while its value differs from the producer's state.outputs, so a re-run ` +
      `writes the remainder and leaves the rest alone.`,
    'SCRUB_EXPORT_INDEX_INCOMPLETE'
  );
}

/**
 * Converge one scrubbed stack's entries in one region's exports index.
 *
 * Run as its OWN step by `scrubCommand`, after `scrubStack` returned — never
 * from inside the resolver. `scrubStack`'s resolve contexts deliberately
 * withhold `exportIndex` so `resolveImportValue`'s scan arm cannot `patchEntry`
 * as a side effect of resolution, at a point in the run nothing chose; that
 * withholding is unchanged, and this is a separate call with its own condition.
 *
 * Under `dryRun` no `patchEntry` is issued. The READ still happens:
 * `readPersistedEntries` is a GET that does not rebuild, so the audit half runs
 * without an S3 write.
 *
 * TWO PROPERTIES OF THE WRITE a reader will ask about. It runs OUTSIDE the
 * stack lock — `scrubStack` releases that in its own `finally` — because the
 * lock guards `state.json`, one key per stack, while `exports.json` is shared
 * region-wide and carries its own If-Match optimistic lock plus bounded retry;
 * that is the same concurrency control the deploy path's index write relies on.
 * And it is ONE PutObject PER ENTRY rather than one for the batch: `patchEntry`
 * is the operation that changes a value without touching membership, and a
 * remediation command pays that round trip so a failure names the entry it
 * could not write.
 */
export async function repairExportIndexForStack(
  store: ExportIndexStore,
  stackName: string,
  producerRegion: string,
  outputs: Record<string, unknown> | undefined,
  opts: { dryRun: boolean; onWriteAttempt?: () => void }
): Promise<ExportIndexRepairPlan & { unwritten: string[] }> {
  const entries = await store.readPersistedEntries();
  if (!entries) return { examined: [], findings: [], unwritten: [] };
  const plan = planExportIndexRepair(entries, stackName, producerRegion, outputs);
  const unwritten: string[] = [];
  if (opts.dryRun) return { ...plan, unwritten };
  for (const finding of plan.findings) {
    if (finding.kind !== 'converge') continue;
    const entry = entries.get(finding.exportName);
    if (!entry) {
      // UNREACHABLE by construction — every finding was produced by walking
      // `entries` — and thrown rather than skipped precisely because of that:
      // a `continue` here would silently DROP a repair the plan decided on if
      // the two ever came apart, which is the fail-quiet shape this whole
      // change exists to remove. The name is not interpolated: it may hold
      // secret plaintext (see `secretSafeKeyDisplay`).
      throw new ScrubIndexInvariantError(
        'exports index repair: a planned entry is absent from the snapshot it was planned from'
      );
    }
    // Value only. `producerStack` / `producerRegion` are carried over from the
    // entry that is already there, and no name is added or removed — scrub
    // takes no `--parameters` and reads a state record whose template may not
    // be the one that produced it, so any export SET it derived would be a
    // guess, and a guessed change to index MEMBERSHIP is the wrong-rewrite
    // hazard one level up from the value it went to fix.
    //
    // `requireOwner` re-asserts, inside the write and on every retry attempt,
    // the ownership the PLAN read off a snapshot: an If-Match conflict reloads
    // the index under the retry, and a concurrent deploy that claimed this
    // export name in that window is kept by the store with only a warning
    // (issue #2193). Without it the retry would resurrect this stack's value
    // over the new producer's.
    //
    // Reported BEFORE the write, so a write that fails still has its region's
    // superseded versions purged (go-to-k/cdkd#2624).
    opts.onWriteAttempt?.();
    const written = await store.patchEntry(
      finding.exportName,
      { ...entry, value: finding.stateValue },
      { requireOwner: { producerStack: stackName, producerRegion } }
    );
    if (!written) unwritten.push(finding.exportName);
  }
  return { ...plan, unwritten };
}
