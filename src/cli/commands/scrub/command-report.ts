import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type { getLogger } from '../../../utils/logger.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import type { ExportIndexStore, ExportIndexEntry } from '../../../state/export-index-store.js';
// An export NAME is a template-controlled RESOLVED value and an index read's
// error message interpolates a bucket / key, so both reach the terminal only
// through the same control-byte strip `export-index-store.ts` uses for the
// name it logs.
import { displayIdent, displaySafe, safeMsg } from '../../../utils/display-safe.js';
import {
  ScrubNeededError,
  scrubStacksFailedError,
  droppedOutputReadersUnverifiedError,
  damagedProducerRecordsError,
  malformedRecordsAuditedError,
} from './errors.js';
import type { ScrubOptions } from './command.js';
import { exportIndexIncompleteError } from './export-index.js';
import {
  SCRUBBED_EXPORT_INDEX_OBJECT_DESCRIPTION,
  scrubbedExportIndexKey,
  SCRUB_CLEAN_SCOPE_NOTE,
} from './save-state.js';
import type { ScrubWorkItem } from './nested.js';

/** What {@link runScrubTargets} counted, read by {@link reportScrubOutcome}. */
interface ScrubOutcomeInput {
  options: ScrubOptions;
  logger: ReturnType<typeof getLogger>;
  stateBackend: S3StateBackend;
  totalStacksScrubbed: number;
  rewrittenStacks: Set<string>;
  totalParentAttributesUnmatched: number;
  totalStacksWithUnscrubbableKeys: number;
  totalStacksWithUnverifiableReads: number;
  totalStacksWithUnverifiableLeaves: number;
  totalStacksWithUnrepairedReadNames: number;
  totalOutputKeysDropped: number;
  totalStacksWithReadOutputKeys: number;
  droppedReadersUnverifiedStacks: string[];
  malformedRecords: string[];
  malformedOutputRecords: string[];
  malformedOrphanRecords: string[];
  damagedProducerStacks: string[];
  failures: Array<{ stackName: string }>;
  exportIndexStores: Map<string, ExportIndexStore>;
  examinedIndexNames: Map<string, Set<string>>;
  totalIndexEntriesConverged: number;
  historyPurgedStacks: Set<string>;
  totalIndexEntriesAbsent: number;
  totalIndexEntriesAbsentWithSecret: number;
  indexUnwritten: Array<{ region: string; shown: string }>;
  indexUnreadable: Array<{ region: string; reason: string }>;
  indexRegionsWritten: Set<string>;
  work: ScrubWorkItem[];
}

/**
 * {@link scrubCommand}'s closing report, moved verbatim (go-to-k/cdkd#5835):
 * the exports-index history purge, the summary, and the throws that decide the
 * exit code (`--fail`'s exit 1 among them).
 */
export async function reportScrubOutcome({
  options,
  logger,
  stateBackend,
  totalStacksScrubbed,
  rewrittenStacks,
  totalParentAttributesUnmatched,
  totalStacksWithUnscrubbableKeys,
  totalStacksWithUnverifiableReads,
  totalStacksWithUnverifiableLeaves,
  totalStacksWithUnrepairedReadNames,
  totalOutputKeysDropped,
  totalStacksWithReadOutputKeys,
  droppedReadersUnverifiedStacks,
  malformedRecords,
  malformedOutputRecords,
  malformedOrphanRecords,
  damagedProducerStacks,
  failures,
  exportIndexStores,
  examinedIndexNames,
  totalIndexEntriesConverged,
  historyPurgedStacks,
  totalIndexEntriesAbsent,
  totalIndexEntriesAbsentWithSecret,
  indexUnwritten,
  indexUnreadable,
  indexRegionsWritten,
  work,
}: ScrubOutcomeInput): Promise<void> {
  let totalIndexEntriesUnexamined = 0;

  // The exports index's superseded versions, once per region this run wrote
  // (go-to-k/cdkd#2624). Each `patchEntry` PUT supersedes the body that held
  // the plaintext, as `saveScrubbedState` explains for `state.json`. The index
  // is a SHARED object per region, so its history also carries other stacks'
  // entries; purging it costs no recovery capability, because the index is a
  // derived view `ExportIndexStore.rebuild()` regenerates from the state
  // records, and the `IsLatest` filter leaves a concurrent writer's current
  // object alone. Here, after the per-stack loop, so a region several stacks
  // patched is walked once, and above the summary so the purge's own warnings
  // print before it.
  for (const indexRegion of indexRegionsWritten) {
    await stateBackend.purgeNoncurrentVersions(
      [scrubbedExportIndexKey(stateBackend, indexRegion)],
      {
        objectDescription: SCRUBBED_EXPORT_INDEX_OBJECT_DESCRIPTION,
      }
    );
  }

  // What `--purge-history` did beyond the rewrites, for every summary line.
  // Counted per record from `historyPurged`, so it never claims a record the
  // run refused; bounded by the purge's own warnings like the rewrite claim.
  const historyNote = (): string => {
    const purgedOnly = [...historyPurgedStacks].filter((n) => !rewrittenStacks.has(n)).length;
    return purgedOnly > 0
      ? ` --purge-history: on a VERSIONED state bucket, the earlier state.json versions of ` +
          `${purgedOnly} examined record(s) scrub did not rewrite were purged too, unless a ` +
          `warning above says otherwise.`
      : '';
  };

  // COVERAGE, not detection (issue #2667). `--all` targets every stack in the
  // SYNTHESIZED APP (`docs/cli-scrub.md`), not every stack with a state
  // record, and one bucket and region are legitimately shared by several CDK
  // apps — so an entry whose producer is outside this app is one no run from
  // here decided about. It is REPORTED and never turns `--fail` red: a gate
  // that reddens on another app's entries is one nobody running this app can
  // clear, which is the same defect as a gate that stays green over a
  // divergence. Each app clears its own entries by running its own scrub.
  //
  // The count comes from the names a pass actually EXAMINED, so a stack whose
  // scrub threw leaves its entries in this bucket rather than in a set derived
  // from ownership it never checked.
  for (const [indexRegion, store] of exportIndexStores) {
    if (indexUnreadable.some((u) => u.region === indexRegion)) continue;
    // Usually served from the snapshot the per-stack pass already loaded on
    // this instance — but NOT always: a region whose per-stack read returned
    // `undefined` (no index object) left `loadState` unloaded, so this issues
    // a second GET, and a transient S3 failure there would otherwise throw
    // past the summary and out of the command with `state.json` already
    // rewritten. Recorded like any other unreadable index instead.
    let entries: ReadonlyMap<string, ExportIndexEntry> | undefined;
    try {
      entries = await store.readPersistedEntries();
    } catch (err) {
      const reason = displaySafe(describeAwsFailure(err).detail);
      indexUnreadable.push({ region: indexRegion, reason });
      logger.error(
        `Exports index for ${displayIdent(indexRegion)} could not be read for the coverage report: ${reason}`
      );
      continue;
    }
    if (!entries) continue;
    const examined = examinedIndexNames.get(indexRegion) ?? new Set<string>();
    const unexamined = [...entries.keys()].filter((name) => !examined.has(name));
    if (unexamined.length === 0) continue;
    totalIndexEntriesUnexamined += unexamined.length;
    logger.info(
      `Exports index (${displayIdent(indexRegion)}): ${unexamined.length} entr${unexamined.length === 1 ? 'y is' : 'ies are'} ` +
        `published by a producer this run did not scrub, so nothing here read ${unexamined.length === 1 ? 'its' : 'their'} ` +
        `value. Coverage composes across the apps sharing this bucket and region — run each app's ` +
        `own cdkd scrub to reach its entries.`
    );
  }

  if (
    totalStacksScrubbed === 0 &&
    totalStacksWithUnscrubbableKeys === 0 &&
    totalStacksWithUnverifiableReads === 0 &&
    totalStacksWithUnverifiableLeaves === 0 &&
    totalStacksWithUnrepairedReadNames === 0 &&
    totalStacksWithReadOutputKeys === 0 &&
    totalIndexEntriesAbsentWithSecret === 0 &&
    droppedReadersUnverifiedStacks.length === 0 &&
    totalParentAttributesUnmatched === 0 &&
    totalIndexEntriesConverged === 0 &&
    indexUnwritten.length === 0 &&
    indexUnreadable.length === 0 &&
    // A dry run that proceeded over an unreadable resources map has every
    // counter above legitimately at zero, so without this it would land here
    // and print `No plaintext secrets found in any target stack state` -- a
    // claim about records it never read.
    malformedRecords.length === 0 &&
    // The `outputs` half of exactly that (go-to-k/cdkd#3192): the repaired bag
    // is empty, so the secret-bearing-key scan and both redaction passes walk
    // nothing and every outputs-side counter is legitimately zero too.
    malformedOutputRecords.length === 0 &&
    // The `orphans` half of the same (go-to-k/cdkd#3379): the repaired list is
    // empty, so no orphan row is reported and every counter stays zero.
    malformedOrphanRecords.length === 0
  ) {
    // `totalIndexEntriesAbsent` and `totalIndexEntriesUnexamined` are
    // deliberately NOT in this condition (issue #2667). Past it, the `--dry-run
    // --fail` arm below throws on `options.fail` alone, so adding either would
    // redden the documented CI gate on a coverage report no run can clear —
    // the outcome the locked direction refuses. Both were already logged per
    // entry above.
    // "in any target stack state" would be a claim about stacks this run never
    // got through, which is the same false-success the refusal exists to
    // prevent — so the sentence narrows to the stacks it actually reached.
    if (failures.length === 0) {
      logger.info(
        safeMsg`\nNo plaintext secrets found in any target stack state${SCRUB_CLEAN_SCOPE_NOTE}. Nothing to scrub.${historyNote()}`
      );
      return;
    }
    logger.info(
      `\nNo plaintext secrets found in the ${work.length - failures.length} stack(s) this ` +
        `run could examine${SCRUB_CLEAN_SCOPE_NOTE}. ${failures.length} stack(s) could NOT be scrubbed — see the errors above.${historyNote()}`
    );
    throw scrubStacksFailedError(failures);
  }

  // Carried into every summary line below for the same reason `keyNote` is: a
  // count that says "scrubbed" must never be read as covering stacks this run
  // could not examine at all.
  const failureNote =
    failures.length > 0
      ? ` ${failures.length} stack(s) could NOT be scrubbed at all and are NOT covered by this ` +
        `summary — see the errors above.`
      : '';
  // Named separately in every summary line below, so the count that says
  // "scrubbed" only ever covers state this command actually rewrote.
  const keyNote =
    totalStacksWithUnscrubbableKeys > 0
      ? ` ${totalStacksWithUnscrubbableKeys} stack(s) hold plaintext in an output KEY, which cdkd scrub ` +
        `cannot rewrite — rename that output's Export.Name and redeploy.`
      : '';
  // Same discipline as `keyNote`: a summary must never let a finding it could
  // not remedy read as a clean result (issue #2133 review).
  const leafNote =
    totalStacksWithUnverifiableLeaves > 0
      ? ` ${totalStacksWithUnverifiableLeaves} stack(s) had a {{resolve:...}} scan ABANDONED ` +
        `mid-value, so part of their state was never examined (see the warnings above).`
      : '';
  // The TWIN of the per-stack line, and it was missed when that one was fixed
  // (review of go-to-k/cdkd#3206 round 6) — one screen apart, same false
  // assertion. This bucket no longer holds only by-design refusals: a producer
  // whose `outputs` map cannot be READ lands here too, and that one is
  // REPAIRABLE, so naming the cross-account remedy is both wrong and
  // actionless for it. The remedy differs per member, so the note stops
  // prescribing one and points at the per-read warnings, which state it.
  const unverifiableNote =
    totalStacksWithUnverifiableReads > 0
      ? ` ${totalStacksWithUnverifiableReads} stack(s) carry a cross-stack read that could NOT ` +
        `be verified, so their imported values were not checked — see the warnings above for ` +
        `which read, why, and what to do about it.`
      : '';
  const outputKeyNote =
    (totalOutputKeysDropped > 0
      ? ` ${totalOutputKeysDropped} output key(s) the template no longer declares ` +
        `${options.dryRun ? 'would be' : 'were'} dropped: their values could not be identified, ` +
        `and they are not necessarily secrets (see the lines above).`
      : '') +
    (totalStacksWithReadOutputKeys > 0
      ? ` ${totalStacksWithReadOutputKeys} stack(s) keep an undeclared output key another ` +
        `stack still reads, or one that may be a live export alias — its value can still be ` +
        `printed by cdkd diff; see the warnings above.`
      : '');
  const readNameNote =
    totalStacksWithUnrepairedReadNames > 0
      ? ` ${totalStacksWithUnrepairedReadNames} stack(s) hold a cross-stack read name in ` +
        `plaintext that scrub could NOT repair, most likely a secret's value from before a ` +
        `rotation — see the warnings above.`
      : '';
  const parentAttributeNote =
    totalParentAttributesUnmatched > 0
      ? ` ${totalParentAttributesUnmatched} nested-stack output attribute(s) in a parent record ` +
        `hold a plaintext scrub could NOT match to its child's output — see the warnings above.`
      : '';
  // The exports index half (issue #2667). Three separate statements, because
  // they carry different obligations: an entry this run wrote, an entry it
  // read a name for and wrote nothing, and an entry it never read. Kept out of
  // every "scrubbed N stack(s)" count — that count is about state records, and
  // an index entry is a different object.
  const indexNote = ((): string => {
    const parts: string[] = [];
    if (totalIndexEntriesConverged > 0) {
      parts.push(
        options.dryRun
          ? ` ${totalIndexEntriesConverged} exports index entr${totalIndexEntriesConverged === 1 ? 'y' : 'ies'} ` +
              `differ from the producer's scrubbed state.outputs and would be converged to it ` +
              `(--dry-run, nothing written).`
          : ` ${totalIndexEntriesConverged} exports index entr${totalIndexEntriesConverged === 1 ? 'y' : 'ies'} ` +
              `converged to the producer's state.outputs value, and on a VERSIONED bucket the ` +
              `index's earlier versions were purged, unless a warning above says otherwise.`
      );
    }
    if (totalIndexEntriesAbsent > 0) {
      parts.push(
        ` ${totalIndexEntriesAbsent} exports index entr${totalIndexEntriesAbsent === 1 ? 'y is' : 'ies are'} ` +
          `published by a scrubbed stack under a name its state.outputs does not carry; nothing ` +
          `was written for ${totalIndexEntriesAbsent === 1 ? 'it' : 'them'} — redeploy that producer.`
      );
    }
    if (totalIndexEntriesAbsentWithSecret > 0) {
      parts.push(
        ` ${totalIndexEntriesAbsentWithSecret === 1 ? 'One such entry still holds' : `${totalIndexEntriesAbsentWithSecret} such entries still hold`} ` +
          `a secret this run recorded — see the warnings above.`
      );
    }
    if (totalIndexEntriesUnexamined > 0) {
      parts.push(
        ` ${totalIndexEntriesUnexamined} exports index entr${totalIndexEntriesUnexamined === 1 ? 'y' : 'ies'} ` +
          `belong to producers outside this run and were NOT examined.`
      );
    }
    return parts.join('');
  })();

  if (options.dryRun) {
    // Gated like its non-dry-run twin: with only key findings this would plan
    // to scrub nothing, and "0 stack(s) ... would be scrubbed" reads as a clean
    // result directly above a warning that says otherwise.
    if (totalStacksScrubbed > 0) {
      logger.info(
        `\nPlan: ${totalStacksScrubbed} stack(s) hold plaintext secrets and would be scrubbed ` +
          `(--dry-run, no state written).${keyNote}${unverifiableNote}${readNameNote}${outputKeyNote}${parentAttributeNote}${leafNote}${indexNote}${failureNote} ROTATE any exposed secret in Secrets Manager.`
      );
    } else {
      logger.info(
        `\nPlan: no state record can be rewritten.${keyNote}${unverifiableNote}${readNameNote}${outputKeyNote}${parentAttributeNote}${leafNote}${indexNote}${failureNote} ROTATE any exposed secret.`
      );
    }
    // The refusal outranks the `--fail` gate: it is an ERROR (exit 2) about
    // state this run could not examine, while `ScrubNeededError` (exit 1) is a
    // finding about state it did.
    if (failures.length > 0) throw scrubStacksFailedError(failures);
    // Same rank as the refusal above, and reachable under `--dry-run` through
    // the READ alone: no `patchEntry` is issued here, so `indexUnwritten` is
    // empty, while an index this run could not open leaves `indexUnreadable`
    // set and the audit unperformed.
    if (indexUnwritten.length > 0 || indexUnreadable.length > 0) {
      throw exportIndexIncompleteError(indexUnwritten, indexUnreadable, true);
    }
    // Same rank, and this is the ONLY branch that can raise it: the repair
    // fires only under `--dry-run`, and this branch RETURNS -- so the copy
    // below the `if` is unreachable for it. Above `options.fail` because
    // `ScrubNeededError` is exit 1 AND silent: leaving it lower would report
    // "scrub found a leak" for a record scrub could not read, and swallow this
    // message on the way out.
    if (
      malformedRecords.length > 0 ||
      malformedOutputRecords.length > 0 ||
      malformedOrphanRecords.length > 0
    ) {
      throw malformedRecordsAuditedError(
        malformedRecords,
        malformedOutputRecords,
        malformedOrphanRecords
      );
    }
    // UNGATED by `--fail`, and above it for the same rank reason the refusals
    // here already are: exit 2 is "cdkd could not finish", exit 1 is "cdkd
    // looked and found something". Before the bag was guarded the LIST shape
    // exited 2 unconditionally (through the producer-plaintext refusal) and
    // the STRING shape died with a raw `TypeError`, which `error-handler.ts`
    // maps to exit 1 — so neither shape ever reached a `--fail`-gated exit,
    // and gating this would be the regression the guard was supposed to
    // prevent (go-to-k/cdkd#3192 review rounds 5 and 10).
    if (damagedProducerStacks.length > 0) {
      throw damagedProducerRecordsError(damagedProducerStacks);
    }
    if (droppedReadersUnverifiedStacks.length > 0) {
      throw droppedOutputReadersUnverifiedError(droppedReadersUnverifiedStacks);
    }
    if (options.fail) throw new ScrubNeededError();
    return;
  }

  // Gated: with only key findings this rewrote nothing, and asserting that the
  // plaintext was removed would be the same false claim the masking invariant
  // forbids.
  //
  // What a successful run CAN claim (go-to-k/cdkd#2624). The rewrite is a
  // `PutObject` on a bucket `cdkd bootstrap` versions, so it supersedes the
  // pre-scrub body rather than erasing it; `saveScrubbedState` and the index
  // pass then purge the rewritten keys' noncurrent versions. That purge is
  // fail-soft and warns for itself (missing grants, a replicated bucket) ABOVE
  // this line, so the claim is qualified by those warnings rather than made
  // unconditionally. Rotation stays the remedy for every copy cdkd cannot
  // reach. See docs/cli-scrub.md, "What a real run removes, and what it cannot".
  if (totalStacksScrubbed > 0) {
    logger.info(
      `\nDone: scrubbed ${totalStacksScrubbed} stack(s). ` +
        `The rewritten state.json no longer holds the plaintext, and on a VERSIONED state ` +
        `bucket its earlier versions were purged, unless a warning above says otherwise. ` +
        `A value that was ` +
        `ever persisted must still be treated as compromised — ROTATE it in Secrets ` +
        `Manager (scrub matches the current value, so scrub BEFORE rotating); rotation is ` +
        `what makes any copy cdkd cannot reach harmless.${historyNote()}${keyNote}${unverifiableNote}${readNameNote}${outputKeyNote}${parentAttributeNote}${leafNote}${indexNote}${failureNote}`
    );
  } else {
    logger.info(
      `\nNo state record was rewritten.${historyNote()}${keyNote}${unverifiableNote}${readNameNote}${outputKeyNote}${parentAttributeNote}${leafNote}${indexNote}${failureNote} ROTATE any exposed secret.`
    );
  }
  // `--fail` is documented as a --dry-run CI gate, but a REAL run over a
  // key-only leak would otherwise exit 0 — and that is the one finding class a
  // real run cannot fix, so exiting clean is exactly backwards.
  if (failures.length > 0) throw scrubStacksFailedError(failures);
  // An index entry this run went to converge and did not is raised here rather
  // than warned, whatever `--fail` says: the entry keeps the value it holds, in
  // a region-wide object readable with `s3:GetObject` and no version id, and a
  // swallowed failure there is the shape issue #2667 is about. Above `--fail`
  // for the same rank reason the stack refusal is — exit 2 is "cdkd did not
  // finish", exit 1 is "cdkd looked and found something".
  if (indexUnwritten.length > 0 || indexUnreadable.length > 0) {
    throw exportIndexIncompleteError(indexUnwritten, indexUnreadable, false);
  }
  // Unreachable today -- only the `--dry-run` branch above repairs, and it
  // returns. Kept so a later writer of the flag on the real-run path cannot
  // drop the finding silently; `tests/unit/state/malformed-resources-bag.test.ts`
  // pins that the dry-run copy is the one that fires.
  if (
    malformedRecords.length > 0 ||
    malformedOutputRecords.length > 0 ||
    malformedOrphanRecords.length > 0
  ) {
    throw malformedRecordsAuditedError(
      malformedRecords,
      malformedOutputRecords,
      malformedOrphanRecords
    );
  }
  // The real-run copy, and unlike the line above it this one IS reachable:
  // nothing about a damaged PRODUCER record is `--dry-run`-only. Ungated by
  // `--fail` and above it, for the reason the dry-run copy states.
  if (damagedProducerStacks.length > 0) {
    throw damagedProducerRecordsError(damagedProducerStacks);
  }
  if (droppedReadersUnverifiedStacks.length > 0) {
    throw droppedOutputReadersUnverifiedError(droppedReadersUnverifiedStacks);
  }
  // `totalStacksWithUnverifiableReads` joins the key-only leak here for the
  // reason stated on that counter: a real run cannot fix either one, so exiting
  // 0 over them is exactly backwards (issue #2133 review).
  if (
    options.fail &&
    (totalStacksWithUnscrubbableKeys > 0 ||
      totalStacksWithUnverifiableReads > 0 ||
      totalStacksWithUnrepairedReadNames > 0 ||
      totalStacksWithReadOutputKeys > 0 ||
      totalIndexEntriesAbsentWithSecret > 0 ||
      totalParentAttributesUnmatched > 0 ||
      totalStacksWithUnverifiableLeaves > 0)
  ) {
    throw new ScrubNeededError();
  }
}
