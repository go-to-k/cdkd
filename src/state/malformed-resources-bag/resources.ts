/**
 * The `resources` container: its read-only repair, refusals per command, and warnings.
 *
 * Part of `src/state/malformed-resources-bag.ts`, which re-exports every public name here.
 */
import { CdkdError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import type { LockRecoveryContext } from '../lock-contention-message.js';
import type { StackState } from '../../types/state.js';
import {
  STATE_RESOURCES_MALFORMED,
  hasReadableResources,
  SHORT_NAME_MAX_CODE_POINTS,
  safeIdentifier,
  absentIfEmpty,
} from './core.js';
import {
  dropRecordLine,
  withheldListingPointer,
  confirmKeyListing,
  destroyAccountClause,
} from './account-args.js';
import {
  mayNameTargetWithDestructiveRemedy,
  stackClause,
  inspectCommand,
  inspectClause,
} from './inspect-command.js';
import { inspectTail } from './orphan-refusal.js';

/**
 * The DIAGNOSIS sentence itself, with no identity and no remedy in it.
 *
 * ONE spelling, because two copies of a diagnosis are what drift. Its two
 * consumers are the arms of {@link malformedStateDiagnosis}, which differ by
 * the IDENTITY they may name and not by this sentence — since
 * go-to-k/cdkd#3516 neither arm carries a command at all, so there is nothing
 * else for them to differ in.
 */
const MALFORMED_RESOURCES_DIAGNOSIS =
  `has no readable 'resources' map — the record is malformed or truncated. Both 'cdkd deploy' ` +
  `and 'cdkd destroy' REFUSE such a record rather than acting on it: they read the same map, ` +
  `an unreadable one is indistinguishable from an empty stack, and acting on that reading ` +
  `would make a deploy re-CREATE every resource and a destroy delete none of them.`;

/**
 * Identity plus the diagnosis, and NO command — every consumer appends prose
 * after this half, so a command baked in here can only land mid-sentence
 * (go-to-k/cdkd#3516). It used to end on a substituted `cdkd state show`, which
 * put the one runnable command in four messages one space from the next clause:
 * a line-select paste then handed `cdkd state show` the following sentence as
 * positional arguments. The command is {@link inspectCommand}'s, and the
 * caller ends ON it — the contract that function's own note states, and the
 * shape {@link malformedDestroyOutputsRefusalMessage} already had. Its
 * `orphans` twin had it too until this change gave both DESTROY refusals a
 * per-line shape instead, so that one is no longer the example to copy.
 *
 * `stackName` is optional so the withhold arm of
 * {@link malformedDestroyResourcesRefusalMessage} takes this same helper: that
 * arm must state the diagnosis under an identity it does not trust, which is
 * {@link stackClause}'s no-identity form rather than a second spelling.
 */
export function malformedStateDiagnosis(
  stackName: string | undefined,
  region: string | undefined
): string {
  return `${stackClause(stackName, region)} ${MALFORMED_RESOURCES_DIAGNOSIS}`;
}

/**
 * For a READ-ONLY command: give the record an empty resource bag so the
 * command can report on it, and say so (issue go-to-k/cdkd#3018).
 *
 * `parseStateBody` deliberately does not validate the inner shape, so a
 * hand-edited or truncated record reaches a command with `resources` absent,
 * `null`, or some other non-object. Every such command then died on a raw
 * `TypeError` from the first `Object.keys` / `in` / index read — the exact
 * wording differs per shape (`Cannot convert undefined or null to object`,
 * `Cannot use 'in' operator`, `Cannot read properties of null`), and none of
 * them names a stack, a key or a remedy, from exactly the commands a user
 * reaches for WHEN the state is broken.
 *
 * WHY AT THE LOAD AND NOT AT EACH LOOP. The first cut of #3018 put `?? {}` on
 * the twelve `Object.entries(state.resources)` loops, which was inert: every
 * one of those flows dereferences the bag EARLIER — `!(id in state.resources)`,
 * `hasOwnProperty.call(...)`, `state.resources[logicalId]` — so the abort still
 * happened one line up and the guards only made it look handled. One call per
 * load dominates the whole flow behind it, including the helpers that take the
 * state as a parameter (`orphan-rewriter`, `diff-calculator`,
 * `collectCcApiRoutes`).
 *
 * Mutates in place and returns whether it repaired anything; the caller warns
 * on `true`. A silent repair is its own defect — an empty resource set is
 * indistinguishable from a healthy empty stack in every later line of output,
 * so `No changes detected` over an unreadable record is a clean verdict about
 * nothing.
 *
 * **Only for a command that cannot WRITE state.** Anything that can persist
 * uses {@link refuseMalformedState} instead; see its note.
 */
export function repairMalformedResourcesForReadOnly(state: StackState): boolean {
  if (hasReadableResources(state)) return false;
  state.resources = {};
  return true;
}

/**
 * The refusal TEXT, for a command whose own exit-code contract means this
 * cannot be a plain `CdkdError`.
 *
 * `cdkd scrub` is the case: its exit `1` is SPOKEN FOR ("--fail found
 * plaintext") and every one of its refusals carries `exitCode = 2`, because a
 * CI gate reading the code alone must be able to tell "scrub looked and found
 * a leak" from "scrub refused to look" — the two call for opposite responses.
 * So scrub tests {@link hasReadableResources} and raises its own class around
 * this text rather than calling {@link refuseMalformedState}.
 *
 * The other three refusing commands do NOT share that need, and giving them a
 * single shared code would be wrong in the other direction: `cdkd rollback`
 * documents `2` as "PARTIAL — journal kept, idempotent re-run", so a `2` here
 * would tell an operator to re-run a command that attempted nothing.
 */
export function malformedStateRefusalMessage(
  rawStackName: string,
  rawRegion: string | undefined,
  /**
   * The caller's account flags: the inspect command carries them, and the
   * region-less legacy arm names the bucket from them — see {@link inspectTail}.
   */
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return inspectTail(
    `${malformedStateDiagnosis(stackName, region)} This command can WRITE state, so it refuses ` +
      `rather than continuing: saving over a record whose resource map could not be read would ` +
      `replace the evidence with a well-formed empty one and lose it permanently. Repair or ` +
      `remove the record first.`,
    stackName,
    region,
    recovery
  );
}

/**
 * The DESTROY refusal text for the `resources` bag (issue
 * [#3161](https://github.com/go-to-k/cdkd/issues/3161)).
 *
 * A SECOND `resources` refusal beside {@link malformedStateRefusalMessage},
 * for the reason every split in this module is its own: that text says saving
 * over the record "would replace the evidence with a well-formed empty one",
 * which is not what a destroy does. A destroy DELETES the record, and it does
 * so down a path the other four refusing commands never take.
 *
 * What the runner does with the bag is COUNT it —
 * `Object.keys(state.resources).length` — and route on the count. The count is
 * the list of what to delete, so an unreadable bag counts ZERO and the run
 * takes the EMPTY-STACK FAST PATH, which deletes `state.json` outright. Every
 * resource the record named stays live in AWS, now unreferenced, and the
 * destroy reports success.
 *
 * **Reading the bag as EMPTY — the read-only repair — IS that outcome rather
 * than an alternative to it**, which is why no repair is available here.
 * Measured rather than reasoned: `[]`, `5` and `true` all enumerate no keys,
 * so they already ARE the repaired-to-`{}` shape, and each one reaches the
 * fast path today. The same measurement
 * {@link refuseMalformedResourceProperties} records one container down.
 *
 * It NAMES `cdkd state orphan`, which the sibling refusals do not, and
 * that answers the objection go-to-k/cdkd#3161 raises against refusing at all
 * — that a cleanup command refusing leaves the user with no supported way to
 * tear the stack down. Proceeding would not tear anything down either, and
 * that is per-shape rather than a slogan: `[]` / a number / a boolean name no
 * resource at all, while a STRING names one fabricated logical id per
 * character whose ENTRY is a single character — so `resourceType` and
 * `physicalId` are both `undefined` and `ProviderRegistry.getProviderFor`
 * throws before any provider is selected, which means no AWS delete is issued
 * and no live resource can be addressed. (Measured 2026-09-17 against the real
 * registry: `Cannot read properties of undefined (reading 'startsWith')`, out
 * of the `isCustomResource` test — a routing failure, NOT a `provider.delete`
 * rejection, which an earlier revision of this note claimed.) What a forced
 * run would do is therefore bounded by the record: on the first three shapes
 * it deletes `state.json` and nothing else, and on a string every fabricated
 * id fails and `errorCount > 0` keeps a record — but keeps it LAUNDERED, since
 * the preserve-write spreads the bag (`{ ...state.resources }`) and `'ab'`
 * comes back as a well-formed `{"0":"a","1":"b"}`. So "it preserves the
 * evidence" would be the wrong defence of proceeding; the string shape reaches
 * the same laundering by another route, which strengthens the refusal rather
 * than weakening it (review round 2 of go-to-k/cdkd#3332). The only outcome
 * worth offering is the record's removal, and `cdkd state orphan` is the
 * supported command for it, leaving the live resources in place. It reads
 * `state.resources` nowhere, which is what makes the pointer true and is
 * fenced in `tests/unit/state/malformed-resources-bag.test.ts`.
 *
 * **That remedy is a TEMPLATE, not a substituted command, and the asymmetry
 * with the `cdkd state show` line above it is the point.** `state orphan`
 * DELETES a record; `state show` reads one. The `region` this function is
 * handed comes from `destroy-runner/run.ts`'s `state.region ?? ctx.baseRegion` —
 * which WAS record-body content `getState` did not check against the key it
 * loaded from, measured 2026-09-17: a record planted at
 * `.../us-east-1/state.json` carrying `"region": "eu-west-1"` rendered a
 * pasteable `cdkd state orphan <stack> --stack-region eu-west-1`, aiming a
 * destructive command at a DIFFERENT region's record for the same stack. That
 * is the misdirection class {@link stackClause} records for stack names, one
 * field over. Substituting into the read-only `state show` line is the
 * pre-existing behaviour of {@link inspectCommand} and is left alone;
 * what this lane must not add is a destructive one.
 *
 * **go-to-k/cdkd#3328 closed the BODY half of that, and the template stays
 * anyway** — the measurement above is now history, not a live repro.
 * `S3StateBackend.getState` normalizes a region-scoped record's `region` to
 * its KEY's and warns on a body that disagreed, so `state.region` reaching
 * this function is the key's region. But the key is an S3 KEY SEGMENT, which
 * is bucket-plantable in its own right (`cdkd/<stack>/<anything>/state.json`
 * lists as a region), and a legacy record still falls through to
 * `ctx.baseRegion`. So the value is still not this process's own, and a
 * DELETING command built from it is still the thing not to hand over.
 *
 * **A template is not enough on its own, because the name the reader would
 * type into it comes from the clause ABOVE.** `safeIdentifier` composes
 * `displaySafe` with a cap, and `displaySafe` TRIMS — so a planted
 * `resources["..."]` record keyed `"prod-api "` opens this message as
 * `State for 'prod-api' (...)`, byte-identical to a HEALTHY sibling spelled
 * `prod-api`. An operator who then orphans "the record the line above names"
 * deletes the intact one. That is exactly the identity failure `displayIdent`
 * exists for and {@link namedPropertyBagsDiagnosis} applies to logical ids. So
 * the remedy sentence is GATED on the identity rendering EXACTLY: when it does
 * not, the text names no removal target at all and opens on
 * {@link stackClause}'s no-identity form, ending on
 * {@link inspectCommand}'s TEMPLATE rather than on a command built from the
 * very identity it just called untrustworthy. The same call
 * `buildForceUnlockCommand` makes when a value would render misleadingly.
 *
 * **Rendering exactly is not the same as being TRUE, and the EXACT arm must
 * not claim it is.** `exact` answers a question about this message's own text;
 * it says nothing about PROVENANCE. A planted `"region": "eu-west-1"` on a
 * `.../us-east-1/` key is an ordinary region string, so it renders exactly and
 * the arm fires — and an earlier revision then said to run `cdkd state orphan`
 * "with the stack and region this message NAMES", which is the attacker's
 * region (review round 2 of go-to-k/cdkd#3332: templating had removed the
 * paste, not the aim). The arm therefore points at the record's S3 KEY, which
 * `getState` resolved and a record body cannot forge.
 *
 * Since go-to-k/cdkd#3328 the printed region IS that key's — `getState`
 * normalizes a region-scoped record's `region` to the key's region and warns
 * on a body that disagreed — so the arm no longer has to warn the reader that
 * the two may differ, and its text no longer does. It still says WHERE the
 * region comes from and still sends the reader to `cdkd state list --long` to
 * confirm the key, because a key segment is itself bucket-plantable and
 * because a LEGACY record has no key region at all, in which case the value
 * printed is the CLI's own and `--stack-region` must be omitted.
 *
 * **The VERDICT is {@link mayNameTargetWithDestructiveRemedy}** — the identifier
 * caps AND pasteability, since go-to-k/cdkd#3516 — so the stack name is
 * measured at `STACK_REF_MAX_CODE_POINTS` and the region at a region's 128,
 * which no real region approaches. Measuring the STACK at 128 instead is the
 * trap: an ordinary multi-level CDK nested child
 * (`<root>~<...NestedStackResource><hash>~<...>`, measured past 150 code
 * points) WOULD truncate there and take the withhold arm on a HEALTHY record,
 * making the fallback the common path for exactly the nested destroys this
 * lane added a guard to (review round 2 of go-to-k/cdkd#3332). The bound is
 * still a bound: a planted multi-kilobyte name is truncated at 1152 and lands
 * in the withhold arm.
 *
 * Identifiers are sanitized in the PROSE and, where a command names one,
 * gated and shell-quoted ({@link inspectCommand}, behind
 * {@link mayNameTargetWithDestructiveRemedy}), for the reasons
 * {@link safeIdentifier}'s note gives.
 *
 * `recovery` is the caller's `--profile` / resolved bucket / `--state-prefix`
 * (go-to-k/cdkd#3909): every command line carries them through
 * {@link accountArgs}, and the withhold arm's listing becomes a
 * `Find the exact name:` line carrying them too, so none of the three reads
 * the default profile's bucket when pasted.
 */
export function malformedDestroyResourcesRefusalMessage(
  stackName: string,
  region: string,
  recovery?: LockRecoveryContext
): string {
  // EXACTNESS, not merely printability: `safeIdentifier` may trim, substitute
  // or truncate, and each of those can render a planted identifier as a
  // healthy one. Compared against the RAW value, so any divergence at all
  // suppresses the target-naming half.
  // Through the per-kind helpers: this arm's VERDICT turns on the caps, and a
  // stack name capped at a region's 128 would send an ordinary multi-level
  // nested child down the withhold arm.
  const exact = mayNameTargetWithDestructiveRemedy(stackName, region);
  // The DIAGNOSIS half, one helper for both arms: it carries no command, so the
  // only difference is the identity it is allowed to name. The withhold arm must
  // name none — a message that has just said "another record may render
  // identically" cannot then hand over a command built from that rendering, since
  // following it would READ the healthy sibling, return a clean record, and raise
  // the operator's confidence right before the destructive step.
  const detail = malformedStateDiagnosis(exact ? stackName : undefined, exact ? region : undefined);
  const listing = withheldListingPointer(recovery);
  const remedy = exact
    ? `To drop the record deliberately and leave the live resources standing, run ` +
      `'cdkd state orphan' against the stack and the region THE RECORD'S S3 KEY holds. It is ` +
      `spelled as a template on its own line below rather than handed over ready to run, ` +
      `because that command DELETES a record and a key segment is chosen by anyone who can ` +
      `write this bucket: the key says WHICH record this is, which is not the same as ` +
      `vouching for it as a delete target. Confirm the key with ` +
      `${confirmKeyListing(recovery)} — a legacy record shows none, and for one of those the ` +
      `flag must be OMITTED or it selects nothing.`
    : `This record's stack name or region does NOT render exactly — what is printed above is a ` +
      `sanitized form, and another record may render identically — so this message names no ` +
      `target and offers no command against one. List the records with ` +
      `${listing.pointer}.`;
  const prose =
    `${detail} This command DELETES state, so it refuses ` +
    `rather than continuing: the resource map IS the list of what to delete, so an unreadable ` +
    `one counts as ZERO resources and the run takes the empty-stack fast path, which removes ` +
    `state.json and reports success while every resource the record named is still live in AWS ` +
    `and no longer referenced by anything. Reading the bag as EMPTY is that same outcome rather ` +
    `than an alternative to it, so there is no repair available here. Repair or remove the ` +
    `record first. ${remedy}` +
    destroyAccountClause(recovery);
  // ONE COMMAND PER LINE, the shape
  // {@link malformedOrphanResourcePropertiesRefusalMessage} already takes
  // (go-to-k/cdkd#3516). A single line cannot hold both: the pasteable READ has
  // to end its line or a line-select paste hands it the next clause as
  // positional arguments, and the destructive TEMPLATE has to be the last thing
  // on its own line or the substituted region sitting after it is the value an
  // operator fills the holes with — the warning above it says not to, and
  // "above" stops covering what follows. Separate lines answer both.
  // The inspect command takes the SAME arguments the diagnosis did: on the
  // withhold arm it must stay a template, or the message hands over a read
  // built from a rendering it has just said may name a healthy sibling.
  return [
    prose,
    // The listing first: the Inspect command's holes are filled from it.
    ...(!exact && listing.line !== undefined ? [listing.line] : []),
    `Inspect the record: ${inspectCommand(exact ? stackName : undefined, exact ? region : undefined, recovery)}`,
    // Only the exact arm offers it. The withhold arm names no target, so a
    // destructive template there would be an instruction with nothing to fill
    // the holes from.
    ...(exact ? [dropRecordLine(recovery)] : []),
  ].join('\n');
}

/**
 * For `cdkd destroy` / `cdkd state destroy`: refuse a record whose `resources`
 * bag cannot be read (issue
 * [#3161](https://github.com/go-to-k/cdkd/issues/3161)).
 *
 * The `resources` twin of {@link refuseMalformedOutputsForDestroy}, and a
 * SEPARATE call from it for the reason that one is separate from
 * {@link refuseMalformedOutputs}: a record can be malformed in either
 * container alone and the refusal must name the one that is broken.
 *
 * CALL IT AT THE TOP OF THE DESTROY, **above the `resourceCount` read**. The
 * placement rule is {@link repairMalformedResourcesForReadOnly}'s and it is
 * not decoration here: the empty-stack fast path sits immediately below that
 * read and DELETES the record, so a guard written anywhere below it refuses a
 * record that is already gone.
 */
export function refuseMalformedResourcesForDestroy(
  state: StackState,
  stackName: string,
  region: string,
  /** See {@link malformedDestroyResourcesRefusalMessage}. */
  recovery?: LockRecoveryContext
): void {
  if (hasReadableResources(state)) return;
  // `markNonRetryable` for the reason `refuseMalformedOutputsForDestroy`
  // carries it: the verdict comes from a PERSISTED record, so no retry can
  // change it, while the message interpolates caller-derived identifiers a
  // SUBSTRING-matching retry classifier can read as transient. Issue #1838.
  throw markNonRetryable(
    new CdkdError(
      malformedDestroyResourcesRefusalMessage(stackName, region, recovery),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/**
 * The DEPLOY refusal text for the `resources` bag (issue
 * [#3161](https://github.com/go-to-k/cdkd/issues/3161)).
 *
 * A THIRD `resources` text, and not {@link malformedStateRefusalMessage}'s for
 * the same reason the destroy one is not: that text describes the SAVE as the
 * harm, and here the save is the last thing that happens rather than the
 * first. An unreadable map reads as zero RECORDED resources, so the change
 * calculation plans every resource the template declares as a CREATE and the
 * deploy re-provisions the whole stack against live AWS — colliding on every
 * deterministic name and duplicating the rest — before saving a well-formed
 * record over the only evidence anything was wrong. An operator told their
 * record would be "replaced with a well-formed empty one" would not know that
 * running anyway duplicates their stack.
 *
 * **It must be true under `cdkd deploy --dry-run` as well**, which it is: the
 * guard sits at the state LOAD, above the diff and above the `if
 * (this.options.dryRun)` return, so a dry run reaches it. Refusing there is
 * the decision {@link malformedResourcePropertiesRefusalMessage} records for
 * the sibling container, for the same reason — the repaired PREVIEW is
 * available one command over from `cdkd diff`, which repairs this bag and
 * warns, so refusing here costs nothing that is not already offered, while a
 * plausible `--dry-run` plan followed by a refusal the moment the flag comes
 * off would be the worst arm of all.
 *
 * Identifiers are sanitized in the PROSE and gated in the command — named
 * shell-quoted only when the shared gate admits them, a quoted hole otherwise
 * ({@link inspectCommand}) — and the command is emitted LAST, for the reasons
 * {@link safeIdentifier}'s note gives.
 */
export function malformedDeployResourcesRefusalMessage(
  rawStackName: string,
  rawRegion: string,
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${malformedStateDiagnosis(stackName, region)} 'cdkd deploy' can WRITE state and AWS ` +
    `resources, so it refuses rather than continuing — under '--dry-run' too, because the plan ` +
    `a dry run would print is the wrong one: an unreadable map reads as ZERO recorded ` +
    `resources, so every resource the template declares is planned as a CREATE and the deploy ` +
    `re-provisions a stack that already exists, colliding on each deterministic name and ` +
    `duplicating the rest, then saves a well-formed record over the only evidence anything was ` +
    `wrong. Reading the bag as EMPTY produces that same plan rather than avoiding it. Nothing ` +
    `was provisioned and no state was written FOR THIS STACK. Repair or remove the record ` +
    `first; 'cdkd diff' previews the stack with this map read as EMPTY and warns that it did. ` +
    `${inspectClause(stackName, region, recovery)}Inspect it with: ${inspectCommand(stackName, region, recovery)}`
  );
}

/**
 * For `cdkd deploy`: refuse a record whose `resources` bag cannot be read
 * (issue [#3161](https://github.com/go-to-k/cdkd/issues/3161)).
 *
 * The gap go-to-k/cdkd#3317's review named and left: that lane closed the
 * per-entry `properties` container at `DiffCalculator.calculateDiff`, and
 * {@link unreadableResourcePropertyBags} deliberately returns `[]` for a
 * record whose ROOT bag is unreadable — so `"resources": "abcdef"` reached the
 * deploy diff, enumerated two fabricated logical ids, and re-created the
 * stack. {@link refuseMalformedState}'s callers are `import.ts`, `orphan.ts`
 * and `rollback.ts`, none of which is on this path.
 *
 * CALL IT AT THE LOAD, beside {@link refuseMalformedOutputs} — the placement
 * rule {@link repairMalformedResourcesForReadOnly}'s note records. Not at
 * `calculateDiff`: the engine's own load dominates that call AND the twelve
 * reads between them — five, measured 2026-09-17 over comment-stripped source;
 * re-derive rather than trusting the figure — the first of which
 * (`Object.keys(currentState.resources)` in a debug line) is where a `null`
 * bag raised the bare `TypeError` #3018 exists to remove.
 */
export function refuseMalformedResourcesForDeploy(
  state: StackState,
  stackName: string,
  region: string,
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): void {
  if (hasReadableResources(state)) return;
  // `markNonRetryable` for the reason `refuseMalformedResourceProperties`
  // carries it: a nested child's deploy runs inside the parent's
  // `withRetry(provider.create)`, the verdict comes from a persisted record no
  // retry can change, and the message interpolates identifiers a
  // SUBSTRING-matching classifier can read as transient. Issue #1838.
  throw markNonRetryable(
    new CdkdError(
      malformedDeployResourcesRefusalMessage(stackName, region, recovery),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/**
 * How {@link inspectTail}'s region-less arm opens for a record `cdkd export`
 * LOADED from the legacy key (go-to-k/cdkd#4181). Export never lists: it asks
 * for the region-keyed record and falls back to `<prefix>/<stack>/state.json`,
 * whose body names either the region the export targets or none at all
 * (`tryGetLegacy` accepts both). The listing sentence
 * {@link orphanInspectClause} opens with by default would describe a listing
 * that never happened, and would say the body names no region when it may.
 */
export const EXPORT_LEGACY_LEAD =
  `The record was loaded from its legacy key, which carries no region segment — ` +
  `'cdkd state show' reads such a record only when its body names a region, and a ` +
  `'cdkd deploy' will not migrate it while it is torn — so inspect the object directly`;

/**
 * What `cdkd export` does with a record, and why "remove it" is no way out
 * there — the half the two export refusals share (go-to-k/cdkd#4181). Removing
 * the ROOT record leaves the export nothing to migrate, and removing a nested
 * CHILD's makes `walkCdkdStateStackTree` refuse the tree as missing that child,
 * so the only remedy that lets the export run is a repaired record.
 */
export const EXPORT_DELETES_STATE =
  `'cdkd export' migrates the resources this record lists into CloudFormation and then ` +
  `DELETES the cdkd state, so it refuses rather than continuing, under '--dry-run' too.`;

/**
 * The text {@link refuseMalformedResourcesForExport} raises (go-to-k/cdkd#4181).
 *
 * A FOURTH `resources` text, for the reason each of the others exists: none
 * describes what an export does. {@link malformedStateRefusalMessage} names a
 * SAVE over the record as the harm and offers "repair or remove" — export saves
 * nothing over it, it DELETES it after migrating, and removing a record is a
 * dead end there ({@link EXPORT_DELETES_STATE}'s note). What is at stake is
 * migrating a truncated record: an unreadable map lists no resources, and for
 * a nested stack `walkCdkdStateStackTree` returns such a node CHILDLESS, so
 * every stack below it would drop out of the migration.
 *
 * `rawRegion` is `undefined` for a record loaded from the legacy key; that arm
 * ends on the object key rather than a `cdkd state show` command, opening with
 * {@link EXPORT_LEGACY_LEAD}.
 */
export function malformedExportResourcesRefusalMessage(
  rawStackName: string,
  rawRegion: string | undefined,
  /** See {@link malformedStateRefusalMessage}. */
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return inspectTail(
    `${malformedStateDiagnosis(stackName, region)} ${EXPORT_DELETES_STATE} An unreadable map ` +
      `lists no resources, so the export would migrate a truncated record — and, for a nested ` +
      `stack, a truncated tree: every stack below this record would drop out of the ` +
      `migration. Nothing was imported and no state was written. ` +
      `Repair the record by hand before exporting. Removing it does not unblock the export: ` +
      `without the root record there is nothing to migrate, and without the record of a nested ` +
      `child the export refuses the tree as missing that child.`,
    stackName,
    region,
    recovery,
    EXPORT_LEGACY_LEAD
  );
}

/**
 * For `cdkd export`: refuse a record whose `resources` bag cannot be read, at
 * the root state load and over every node of a nested tree (go-to-k/cdkd#3188,
 * go-to-k/cdkd#4181).
 *
 * The same predicate as {@link refuseMalformedState}, and a separate entry
 * point for the MESSAGE — {@link malformedExportResourcesRefusalMessage} says
 * why that one's text is false here.
 *
 * `region` is `undefined` for a record export loaded from the legacy key
 * (`migrationPending`).
 */
export function refuseMalformedResourcesForExport(
  state: StackState,
  stackName: string,
  region: string | undefined,
  recovery?: LockRecoveryContext
): void {
  if (hasReadableResources(state)) return;
  // NOT `markNonRetryable`: `cdkd export` raises it from its own flow, outside
  // any `withRetry`, so the marker would fence nothing — at the root load
  // before any lock, and over a nested tree's nodes under the ROOT lock the
  // command took, which its `finally` releases. Named in the test file's
  // UNMARKED table.
  throw new CdkdError(
    malformedExportResourcesRefusalMessage(stackName, region, recovery),
    STATE_RESOURCES_MALFORMED
  );
}

/**
 * A record container a TEXT view walks with `Object.entries`, other than the
 * `resources` bag the rest of this module is about.
 *
 * A CLOSED union because a container name is the VIEW's own vocabulary — the
 * set of blocks it renders — not anything a record can name. Widening it to
 * `string` would let a caller hand the warning below a key read out of a
 * hand-edited record, which is a different message from the one this is.
 *
 * That is a design reason and NOT a safety one, and the distinction is
 * load-bearing: {@link malformedRenderedContainersWarning} sanitizes every name
 * it prints, so the closed union is not what stops a forged one from forging a
 * line. Do not read this note as licence to drop that sanitizing — an earlier
 * revision of this comment said the opposite and would have licensed exactly
 * that (review of go-to-k/cdkd#3190).
 */
export type RenderedStateContainer = 'outputs' | 'skippedOutputs' | 'attributes' | 'properties';

/**
 * The warning a view emits when it emptied one or more {@link
 * RenderedStateContainer}s it could not walk (go-to-k/cdkd#3187).
 *
 * Deliberately NOT {@link malformedResourcesWarning}'s text, and the reason is
 * narrower than it looks. That one tells the reader not to run `cdkd deploy` /
 * `cdkd destroy` because an unreadable `resources` MAP is indistinguishable
 * from an empty stack: deploy would re-CREATE everything and destroy would
 * delete nothing. No container named here can produce that specific confusion —
 * the resource SET is still readable — so borrowing that sentence would attach
 * a re-create-the-world warning to a record whose resource list is intact.
 *
 * It is NOT that these containers are display-only. `properties` is read by the
 * deploy change calculation (`src/analyzer/diff-calculator.ts`), where a
 * non-object compares unequal to any
 * desired object and yields a spurious property-change set — measured there as
 * a REPLACEMENT of the live resource, and closed by
 * {@link refuseMalformedResourceProperties} (go-to-k/cdkd#3191). An earlier
 * revision of this comment asserted the display-only premise, which would have
 * read as licence to drop a guard on that path (review of go-to-k/cdkd#3190).
 * That the path is now guarded does not restore the premise: this text is still
 * not the one to borrow, because the deploy path REFUSES where these views
 * continue.
 *
 * What stays the same is the remedy: `--json` is the mode that shows the
 * stored value.
 *
 * ONE warning per record however many containers it names — a stack whose 500
 * resources all carry a hand-edited `properties` gets one line, not 500. The
 * caller FILTERS a fixed order (`RENDERED_CONTAINER_ORDER`), so the text is
 * stable across records. Not `.sort()` — that order is deliberately not
 * alphabetical, and its own JSDoc says so.
 *
 * Both identifiers are sanitized in the PROSE and gated in the command —
 * named shell-quoted only when the shared gate admits them, a quoted hole
 * otherwise ({@link inspectCommand}) — and the command is emitted LAST and
 * UNWRAPPED, for the reasons {@link safeIdentifier}'s own note gives.
 *
 * The container NAMES take {@link safeIdentifier} too — the SAME helper, so
 * they cannot drift from it — but NOT `shellQuote`, because they appear in the
 * PROSE and never inside the command this text tells the reader to run; the
 * command carries the two identifiers and nothing else.
 *
 * Sanitizing them is not dead code written for a case that cannot happen. The
 * union above is closed at COMPILE time, so without this the guarantee would
 * live in a comment, and the day a caller derives a name from a record instead
 * of from a literal an unsanitized element could forge a line, render as empty
 * quotes naming nothing, or run to kilobytes and push the remedy command off
 * the reader's screen. `safeIdentifier` closes all three and is the identity on
 * all four literals, so no user-visible text moves.
 *
 * What it does NOT close, stated rather than reassured away: a forged name made
 * only of printable ASCII still renders verbatim inside its quotes and could
 * read as prose. That residual is bounded to the PROSE — the command the reader
 * pastes is built from the two shell-quoted identifiers alone — and closing it
 * would mean JSON-quoting a name in the one place the text is meant to read as
 * English (review of go-to-k/cdkd#3190).
 */
export function malformedRenderedContainersWarning(
  rawStackName: string,
  rawRegion: string,
  containers: readonly RenderedStateContainer[],
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  const names = containers
    .map((name) => `'${safeIdentifier(name, SHORT_NAME_MAX_CODE_POINTS)}'`)
    .join(', ');
  return (
    `${stackClause(stackName, region)} has a non-object ${names} — the record ` +
    `is malformed or truncated. 'Object.entries' walks a string or a list as readily as a map, ` +
    `so rendering one INVENTS a row per character or element. Continuing with it EMPTY: this ` +
    `view shows no rows there, which is not the same as the record holding none. A per-resource ` +
    `container is named once however many resources hold one. ${inspectClause(stackName, region, recovery)}See the stored values with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/** The warning a caller of {@link repairMalformedResourcesForReadOnly} emits. */
export function malformedResourcesWarning(
  rawStackName: string,
  rawRegion: string | undefined,
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${malformedStateDiagnosis(stackName, region)} Continuing with an EMPTY resource set: this ` +
    `command's output describes zero resources, which is not the same as the stack having none. ` +
    `${inspectClause(stackName, region, recovery)}Inspect it with: ${inspectCommand(stackName, region, recovery)}`
  );
}

/**
 * For a command that can WRITE state: refuse the record by name instead of
 * repairing it.
 *
 * Repairing is actively DANGEROUS here, and the PR that introduced this module
 * shipped that danger for one round before its security review caught it.
 * `cdkd scrub` gates its `saveState` on `recordsChanged > 0`, which an OUTPUTS
 * change alone satisfies — so a record holding `"resources": null` and a
 * plaintext secret in `outputs` would be scrubbed, and then saved back with a
 * repaired, WELL-FORMED `resources: {}`. The malformed record is the only
 * signal that anything is wrong; laundering it into a legitimate-looking empty
 * one is permanent and silent. The next `cdkd deploy` then reads zero resources
 * and CREATES the whole stack a second time, and the next `cdkd destroy`
 * deletes nothing and orphans every live resource — and the one-shot warning
 * that would have said so is long gone, quite possibly for a different
 * operator. `cdkd import --force` launders it the same way.
 *
 * Refusing still satisfies #3018, whose complaint was the BARE `TypeError`:
 * this names the stack, the region, the defect and the remedy, and exits on a
 * code rather than on a stack trace.
 */
export function refuseMalformedState(
  state: StackState,
  stackName: string,
  /**
   * `undefined` only from `cdkd orphan`, for a legacy record listed with no
   * region — the region the remedy must select by (go-to-k/cdkd#3388). Every
   * other caller holds a real one.
   */
  region: string | undefined,
  /** See {@link malformedStateRefusalMessage}. */
  recovery?: LockRecoveryContext
): void {
  if (hasReadableResources(state)) return;
  // NOT `markNonRetryable`, and that is the DECISION rather than the omission
  // it reads as: its callers — `cdkd import`, `cdkd orphan`, `cdkd rollback`,
  // `cdkd state refresh-observed` and `cdkd drift --accept` / `--revert` — each
  // raise it from the command's own flow, outside any `withRetry`, so the
  // marker would fence nothing there. {@link refuseMalformedResourceEntries}
  // and {@link refuseMalformedResourcePropertiesForOrphan} are the other two
  // unmarked refusals, for the same reason. Revisit if a retrying caller is
  // added; `tests/unit/state/malformed-resources-bag.test.ts` names all three
  // exemptions so another refusal cannot join them silently (review round 2 of
  // go-to-k/cdkd#3332).
  throw new CdkdError(
    malformedStateRefusalMessage(stackName, region, recovery),
    STATE_RESOURCES_MALFORMED
  );
}
