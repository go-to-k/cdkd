import {
  printingCorpusOf,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import {
  secretSafeKeyDisplay,
  type SecretSafeKeyDisplay,
} from '../../../deployment/outputs-export-alias.js';
import type { NestedChildScrubTarget } from './nested.js';
import { addStoredStringLeaves } from './outputs.js';

/** What one stack's scrub found. */
export interface ScrubStackResult {
  /**
   * The record's `resources` map could not be READ, and this `--dry-run`
   * proceeded over an empty one (issue go-to-k/cdkd#3018).
   *
   * Carried out to the caller rather than warned-and-forgotten because
   * `--dry-run --fail` is documented as a STANDING CI gate: the repair makes
   * every downstream counter legitimately zero, which lands on the clean-exit
   * arm and prints `No plaintext secrets found in any target stack state`,
   * exit 0 — over a record whose resources this run never examined. A real run
   * REFUSES this record, so without the flag the dry run would be the one mode
   * that reports a false success, and it is the mode CI uses.
   */
  malformedResources?: true;
  /**
   * The record's `outputs` map could not be READ, and this `--dry-run`
   * proceeded over an empty one (issue go-to-k/cdkd#3192).
   *
   * Carried out for exactly {@link malformedResources}' reason, applied to the
   * other container: the repair makes the secret-bearing-key scan and both
   * redaction passes walk `{}`, so every outputs-side counter is legitimately
   * zero and the run lands on the clean-exit arm — reporting a stack clean
   * whose stored outputs it never read. A real run REFUSES this record, so
   * without the flag `--dry-run --fail` would be the one mode that reports a
   * false success, and it is the mode CI uses.
   *
   * SEPARATE from {@link malformedResources} rather than folded into it: a
   * record can be malformed in either container alone, and the audited-error
   * text has to name the one that is broken.
   */
  malformedOutputs?: true;
  /**
   * The `orphans` CONTAINER could not be read (go-to-k/cdkd#3379).
   *
   * A THIRD field for the reason {@link malformedOutputs} is a second one: a
   * record can be malformed in this container alone, and what it costs differs
   * — the list is the record's only evidence that an earlier failed deploy left
   * resources live in AWS.
   */
  malformedOrphans?: true;

  /**
   * A readable `orphans` list held a record no reader can use, dropped under
   * `--dry-run` (go-to-k/cdkd#3500). Separate from {@link malformedOrphans}: a
   * run can meet either alone and the remedies differ.
   */
  malformedOrphanRows?: true;
  /**
   * A readable `resources` map held a row that is not a resource record,
   * dropped under `--dry-run` (go-to-k/cdkd#3202). Separate from
   * {@link malformedResources} for the reason the orphan pair is: a run can
   * meet either alone and the remedies differ — a non-object map has to be
   * rewritten, a torn row repaired inside an otherwise good map.
   */
  malformedResourceRows?: true;
  recordsChanged: number;
  secretsFound: number;
  secretBearingKeys: number;
  /**
   * Cross-stack references this run could NOT verify. A FINDING, not a
   * refusal: the stack is still scrubbed for everything else, but it must not
   * be reported clean, so the run exits non-zero exactly as a
   * `secretBearingKeys` finding does.
   *
   * TWO shapes, and the remedy differs, which is why every message about this
   * count points at the per-read warnings instead of prescribing one:
   *
   * - a read cdkd declines BY DESIGN (issue #2133 review) — the cross-account
   *   case, where no re-run can change the answer;
   * - a PRODUCER whose own `outputs` map cannot be read (go-to-k/cdkd#3192
   *   review), which IS repairable. It is counted rather than refused because
   *   refusing would strand THIS stack's plaintext over another stack's
   *   record; and it is counted rather than ignored because both damaged
   *   shapes were already non-clean before that guard existed — an array bag
   *   raised the producer-plaintext refusal, a string bag threw an escaping
   *   `TypeError` — so guarding the read without recording anything would
   *   have bought a false clean.
   */
  unverifiableReads: number;
  /**
   * The SUBSET of {@link ScrubStackResult.unverifiableReads} caused by a
   * PRODUCER record whose `outputs` map could not be read
   * (go-to-k/cdkd#3192 review).
   *
   * Carried separately because it earns a different EXIT CODE: **2,
   * unconditionally**, where the by-design half earns 1 and only under
   * `--fail`. See {@link CrossStackPrePassFindings.damagedProducerRecords} for
   * why, and `docs/cli-reference.md` for what the two codes mean to a CI gate.
   */
  unverifiableProducerRecords: number;
  /**
   * Leaves whose `{{resolve:...}}` scan was ABANDONED mid-token because one
   * reference failed to RESOLVE (issue go-to-k/cdkd#3160). A FINDING like
   * {@link ScrubStackResult.unverifiableReads}, not a refusal: the rest of the
   * stack is scrubbed, but a real secret sitting after the failing token in
   * the same leaf recorded no needle, so the record must not be reported
   * clean. Refusing instead would refuse healthy stacks — see
   * `abandonedScanVerdict`. Also counts a reference an `Fn::Sub` placeholder
   * left unresolvable, which throws nothing (issue #2166).
   */
  unverifiableLeaves: number;
  /**
   * Stored `imports` / `outputReads` entries whose name still holds a
   * plaintext this run could not repair — most likely a secret's value from
   * before a ROTATION (go-to-k/cdkd#3382, see
   * {@link findUnrepairedCrossStackReadNames}). A FINDING like
   * {@link ScrubStackResult.unverifiableReads}: no re-run of scrub clears it,
   * so the stack is not reported clean and `--fail` exits 1.
   */
  unrepairedReadNames: number;
  /** Output keys this run dropped (would drop, under `--dry-run`) (go-to-k/cdkd#4120). */
  droppedOutputKeys?: number;
  /**
   * Keys it would have dropped that another stack's record still reads
   * (go-to-k/cdkd#4120). KEPT, and a FINDING: `--fail` exits 1 over them.
   */
  keptReadOutputKeys?: number;
  /**
   * Undeclared keys KEPT because each may be a live export alias this run
   * could not reproduce (go-to-k/cdkd#4120). A FINDING like
   * {@link keptReadOutputKeys}: `cdkd diff` can still print their values.
   */
  keptAliasOutputKeys?: number;
  /**
   * The other records could not be read, so no key was dropped
   * (go-to-k/cdkd#4120). Exit 2 whatever `--fail` says: scrub could not look.
   */
  droppedOutputReadersUnverified?: true;
  /**
   * `state.outputs` as this run leaves it — the bag written on a real run, and
   * the bag a real run WOULD write under `--dry-run` (issue #2667).
   *
   * The exports-index step converges an entry to the value stored under its
   * own name in HERE, so under `--dry-run` it has to be the post-scrub bag:
   * the PERSISTED bag still holds the plaintext, an index entry holding that
   * same plaintext compares equal to it, and the audit would then report
   * nothing over exactly the records the same run is reporting as needing a
   * scrub.
   *
   * `undefined` when the stack has no state record, which puts every entry the
   * index publishes for that stack in the `absent` arm.
   */
  outputs?: Record<string, unknown> | undefined;
  /**
   * How to SHOW an export name this stack publishes (issue #2667 review).
   *
   * An export name is a key of `state.outputs`, and a key holding secret
   * plaintext is the residue this command reports and cannot rewrite (issue
   * #1919). The exports-index step names entries in `info` / `warn` lines and
   * in its failure message — `--dry-run --fail` prints them on every run of
   * the documented CI gate, into CI logs — so those names go through the same
   * test `secretBearingStateKeyWarning` applies, never through a bare
   * control-character strip.
   *
   * REQUIRED, not optional: the secrets bag lives in `scrubStack`, so a caller
   * that forgot this field would have no way to mask and would print the raw
   * name. Returning a closure keeps the plaintexts captured here rather than
   * handing the bag out as data.
   */
  exportNameDisplay: (exportName: string, alsoMask?: unknown) => SecretSafeKeyDisplay;
  /**
   * The nested children this stack deploys, for `scrubCommand` to visit next
   * (go-to-k/cdkd#2252). Every `AWS::CloudFormation::Stack` row in the
   * template OR in state, so a child whose row either side has lost is still
   * visited — as a refusal target, raised only if its record exists. Empty
   * when the stack has no state record: a parent that was never deployed
   * deployed no child either.
   */
  nestedChildren: NestedChildScrubTarget[];
  /**
   * Replace every `{{resolve:...}}` expression THIS run recorded with the
   * plaintext it resolved to (go-to-k/cdkd#3961) — what the parent-row repair uses to test that a
   * parent's `Outputs.<Name>` attribute is exactly the plaintext of this
   * child's output. A closure, like {@link exportNameDisplay}, so the bags
   * are never handed out as data.
   */
  resolveRecordedExpressions: (value: unknown) => unknown;
  /** Whether a value holds any plaintext THIS run recorded (go-to-k/cdkd#3961). */
  holdsRecordedPlaintext: (value: unknown) => boolean;
  /**
   * The stack has no state record at all — so a `<stack>~...` record under it
   * is reached by no row, and the refusal says why in those words.
   */
  noRecord?: true;
  /**
   * `--purge-history` purged this record's noncurrent versions although the
   * run did not rewrite it (go-to-k/cdkd#2624).
   */
  historyPurged?: true;
}

/**
 * The `exportNameDisplay` closure over a stack's outputs bag
 * (go-to-k/cdkd#4049): names are tested against the PRINTING corpus, so a
 * `NoEcho` parameter's value (a log-only needle) is masked in the index-repair
 * lines. Built once per result, after resolution has finished recording into
 * the bag. Printing only: the secret-bearing KEY scan reads the map alone.
 */
export function exportNameDisplayOver(
  outputSecrets: RecordedSecretValues,
  /**
   * More text to mask (go-to-k/cdkd#4120): every plaintext this run recorded
   * and the stored values of the output keys it dropped, so an index entry left
   * under a dropped key's name is masked as the drop line masked it.
   */
  extra?: RecordedSecretValues,
  /**
   * Names WITHHELD outright (go-to-k/cdkd#4120): the alias-shaped keys this
   * run dropped or kept, which its own lines withheld — an index line must
   * not print what the line before it declined to.
   */
  withheld?: ReadonlySet<string>
): (exportName: string, alsoMask?: unknown) => SecretSafeKeyDisplay {
  const corpus = new Map([...printingCorpusOf(outputSecrets), ...(extra ?? [])]);
  return (exportName, alsoMask) => {
    if (withheld?.has(exportName)) return { kind: 'withheld' };
    if (alsoMask === undefined) return secretSafeKeyDisplay(exportName, corpus);
    // An index entry's own VALUE: a name built around it would print it.
    const withValue = new Map(corpus);
    addStoredStringLeaves(alsoMask, withValue);
    return secretSafeKeyDisplay(exportName, withValue);
  };
}
