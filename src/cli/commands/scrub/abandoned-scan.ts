import { DynamicReferenceRegionAmbiguousError } from '../../../utils/error-handler.js';
import { verboseAwareText } from '../../../utils/aws-failure-text.js';
import {
  carriesDynamicReference,
  carriesFetchableDynamicReference,
  isNamelessDynamicReferenceError,
  type AbandonedResolution,
} from '../../../deployment/intrinsic-function-resolver.js';
import {
  errorCauseChain,
  maskSecretsInText,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
// An export NAME is a template-controlled RESOLVED value and an index read's
// error message interpolates a bucket / key, so both reach the terminal only
// through the same control-byte strip `export-index-store.ts` uses for the
// name it logs.
import {
  STACK_REF_MAX_CODE_POINTS,
  displayIdent,
  displaySafe,
} from '../../../utils/display-safe.js';

/**
 * Is this the issue #2134 refusal -- a `{{resolve:...}}` reference whose region
 * cdkd cannot establish?
 *
 * WHY IT IS NOT BEST-EFFORT, which is the whole reason this predicate exists.
 * `scrubStack` wraps each resolution pass in a `catch { logger.debug }` so one
 * unresolvable resource does not abandon the rest of the scrub. Every other
 * error reaching those catches means "this resource resolved partially, carry
 * on". This one means cdkd could not tell which region owns a secret reference,
 * so NO NEEDLE was recorded for it and the plaintext is still in `state.json` --
 * and swallowed, the command then reports `No plaintext secrets found` and
 * exits 0 over exactly the state it exists to clean. That is why the pre-pass
 * refusals are placed OUTSIDE those catches; this one is raised from inside
 * `resolveDynamicReferences`, so it cannot be placed and has to be re-raised.
 *
 * By CAUSE CHAIN rather than a bare `instanceof`, for the reason
 * {@link isByDesignRefusal} states: the refusal reaches those catches through
 * `resolver.resolve`, which wraps in several places, so a top-link-only test
 * silently swallows a wrapped one.
 *
 * TWO SITES IN THIS CALL GRAPH STILL SWALLOW IT, named rather than left to be
 * rediscovered (issue #2134 review round 2):
 *
 * - `evaluateConditions` (`intrinsic-resolver/params-conditions.ts`) warns and degrades
 *   the condition to `false`. Accepted for now: a condition evaluates to a
 *   boolean and carries no secret INTO state, and this file's own note above
 *   `resolveCrossStackReads` records why the conditions pass is deliberately
 *   not refusal-armed -- it runs BEFORE scrub knows which branch the deploy
 *   took, so refusing there can reject a whole stack over a branch never taken.
 *   The residual is that the FALSE branch is then selected, which that note
 *   already states.
 * - the `!nodeCanRefuse` arm of the cross-stack pre-pass, which debugs and
 *   returns. Defensible: a SUPPRESSED output writes no state key, so there is
 *   no persisted plaintext for a missing needle to leave behind.
 */
export function isRegionAmbiguousRefusal(err: unknown): boolean {
  return (
    err instanceof Error &&
    errorCauseChain(err).some((link) => link instanceof DynamicReferenceRegionAmbiguousError)
  );
}

// `NAMELESS_DYNAMIC_REFERENCE_MARKERS` and `DYNAMIC_REFERENCE_PREFIX` used to
// be declared here. Neither is imported any more: scrub delegates the whole
// PREDICATE to `isNamelessDynamicReferenceError`, which lives in
// `intrinsic-resolver/context.ts`, beside the resolver whose throws it reads
// (issue go-to-k/cdkd#3181). They moved
// BESIDE the throws when the resolver grew the same partition internally: two
// spellings of one predicate is what issue #1936 forbids, and the consumer
// copy is the half that goes silently stale.
//
// Both carried a doc here explaining why scrub keys on them. That reasoning
// did not move with them because it is no longer scrub's: the prefix is
// required because a bare marker tail is reachable from text the resolver did
// not write (`resolveParameters` raises `Parameter <name> is required but no
// value was provided`), which is a fact about the THROWS, so it is stated at
// the definitions.
//
// `tests/unit/cli/scrub-nameless-dynamic-ref.test.ts` still pins the set
// against the resolver's own throw literals, and checks that scrub imports the
// shared PREDICATE rather than re-declaring the list or re-spelling the
// conjunction over it.

/**
 * A NAMELESS dynamic reference is NOT a best-effort miss, however unresolvable
 * the rest of the resource is (issue go-to-k/cdkd#2692) — `{{resolve:ssm-secure}}`
 * with no parameter name, or `{{resolve:secretsmanager}}` /
 * `{{resolve:secretsmanager:}}` with no secret id.
 *
 * The resolver raises a bare `Error` for both, so they fall through the
 * typed-refusal test above into the `debug` below and `cdkd scrub` reports the
 * run CLEAN.
 *
 * WHY THAT STILL MATTERS AFTER go-to-k/cdkd#3181, which changed the reason. It
 * used to be about POSITION: the token loop had no per-token `try`, so a
 * nameless throw abandoned every remaining `{{resolve:...}}` token in the leaf
 * and a real reference behind it recorded no needle. That is no longer true —
 * the loop recovers per token for every opted-in caller. What survives is the
 * NAMELESS reference itself: it is a structurally broken template that no
 * substitution produces, the resolver re-raises it through
 * `isDeliberateResolutionRefusal` rather than recording it, and scrub must not
 * report a run clean over one. The predicate below is what turns that re-raise
 * into a refusal instead of a `debug` line.
 *
 * BOTH spellings are matched, and the second is the DOMINANT one. The first
 * cut matched `PARAMETER_NAME is required` alone, leaving the more common way
 * to write a secret silent — and the fence certified that as deliberate by
 * asserting the marker occurred exactly once in the resolver, which passed
 * precisely BECAUSE the other throw spells it differently.
 *
 * WHY THE SET STOPS AT "is required", having once been widened to the whole
 * `Dynamic reference:` family and reverted. Four SIBLING failures — a deleted SSM parameter, a secret with no
 * `SecretString`, a missing `JSON_KEY`, a non-JSON secret — abandon the leaf
 * exactly the same way, so on the surface they belong here. They do not,
 * because scrub resolves with template DEFAULTS and takes no `--parameters`:
 * an `Fn::Sub` that warn-and-KEEPS its raw `${Field}` produces a JSON_KEY miss
 * on a perfectly healthy stack, so refusing on that class refuses ordinary
 * stacks (measured — it reddened
 * `tests/unit/cli/commands/scrub-cross-region-secret.test.ts`). A nameless
 * reference is far narrower: an UNBOUND variable keeps its literal `${...}`
 * rather than vanishing, so ordinary missing-parameter resolution cannot
 * produce one.
 *
 * That is narrower, NOT universal, and the difference is stated rather than
 * glossed: a parameter DECLARED with `Default: ''` binds the empty string
 * verbatim (`isUnboundTemplateParameter` returns false once `Default` is
 * present), so `{{resolve:ssm-secure:${P}}}` assembles to
 * `{{resolve:ssm-secure:}}` and refuses here — while the same stack deploys
 * fine through the AWS CDK CLI (`cdk deploy --parameters P=/real/name`); cdkd
 * deploy takes no `--parameters`. The failure is fail-CLOSED (a
 * refusal, never a silent clean run) and the shape is a rare one, so it is
 * accepted rather than worked around; go-to-k/cdkd#3160 carries it alongside
 * the sibling class, which needs a countable unverifiable-leaf finding rather
 * than a refusal. `bindDefaultedParametersOneByOne` does NOT widen it: beside a
 * `Default`-less sibling it leaves a `Default: ''` parameter unbound, as the
 * failed whole-bag call always did (issue #2166).
 *
 * It is a loudness REGRESSION rather than a new gap: before go-to-k/cdkd#2689
 * fixed `ssmParameterName`, this input produced a bogus `secretName` and
 * therefore an `ambiguous` verdict, whose typed error scrub already re-raises.
 * The old, wrong-in-substance refusal was backstopping this one.
 */
export function isNamelessDynamicReferenceFailure(err: unknown): boolean {
  // Delegates to the resolver's own arm (issue go-to-k/cdkd#3181). The
  // constants moved there when the resolver grew the same partition; the
  // CONJUNCTION over them stayed here, spelled byte-identically, which is the
  // #1936 drift one level up — two copies, one of which goes stale silently.
  // This wrapper survives because the NAME is what the sites here read.
  return isNamelessDynamicReferenceError(err);
}

// Background for `abandonedScanVerdict` below.
//
// How this counter came to be shaped the way it is (issue go-to-k/cdkd#3160),
// and the two residuals it still carries. The verdict itself is
// {@link abandonedScanVerdict} below.
//
// POSITIONAL, not message-matched, and the first cut of this got that wrong in
// a way that missed its own headline case. The resolver's token loop has no
// per-token `try`, so ANY throw abandons every remaining token in the leaf —
// and most of those throws are not the resolver's own prose. `GetParameter` /
// `GetSecretValue` go through `sendWithThrottleRetry`, which **rethrows an AWS
// rejection RAW**: a genuinely deleted parameter raises `ParameterNotFound`
// from the SDK, never the `Dynamic reference: SSM parameter '...' not found`
// string, which fires only on a 200 whose `Parameter.Value` is absent. Keying
// on that prefix therefore counted the MINORITY case and let
// `ResourceNotFoundException`, `AccessDeniedException`, `DecryptionFailure`,
// a pending-deletion `InvalidRequestException` and exhausted throttling all
// stay silent — plus the `Refusing to resolve` arm for an `ssm-secure` over a
// public parameter.
//
// So the first half of the question is not what the error SAYS but whether the
// value being resolved had a dynamic reference in it at all: if it did and the
// resolve threw, the remaining tokens in that leaf were not fetched and
// recorded no needle. The two classes that must NOT count are the ones that
// re-raise instead — checked by the caller before this is reached.
//
// The POSITION alone is not enough, though, and a cut that used it alone was
// wrong in the opposite direction from the message-matched one. This catch
// exists for the ORDINARY failure the comment beside it names — a `Ref` to
// something not in state — and that throw is not a dynamic-reference failure
// however many `{{resolve:...}}` leaves the same bag happens to carry. The
// population is not exotic: `scrubStack` takes no `--parameters`, so every
// `{Ref: <param>}` to a parameter with no `Default` throws (since issue
// #2166 the defaulted ones are still bound, one by one). Counting those
// would red `--dry-run --fail`, the documented STANDING CI gate, on stacks
// that are entirely healthy and with no way for the operator to clear it. That is the same outcome
// go-to-k/cdkd#3160 gives as the reason NOT to widen into a refusal.
//
// Hence the conjunction, and note WHO OWNS each half. The excluded set is
// cdkd's OWN refusal prose, which cdkd controls and
// `scrub-abandoned-scan-origin.test.ts` fences against the resolver's throw
// sites. The included set is left unnamed on purpose, because it is AWS's:
// enumerating SDK error names is what the first cut did, and a name AWS adds
// later would silently rejoin the false-clean population this issue is about.
// The asymmetry is deliberate — an error we cannot classify counts, and the
// residual is a WARN on a healthy stack rather than a plaintext under `clean`.
//
// STATED RESIDUAL, in the other direction: `carriesDynamicReference` tests for
// the literal `{{resolve:` in the RAW bag, so an ASSEMBLED reference is not seen
// — a parameter whose `Default` holds the whole token, used as
// `{'Fn::Sub': '${DbSecretRef}'}` (the shape `pinCrossRegionSecrets` documents).
// A failed resolve there is NOT counted and the stack still reports clean. That
// is the original bug, surviving in a narrower population; closing it means
// composing `isAssembledSecretReference`, which is not a drive-by because it
// changes what the counter claims about every leaf, not just this one.
// Recorded rather than papered over: go-to-k/cdkd#3178 security review.
/**
 * An assembly-chosen NAME (a logical id, a property or output name, a property
 * path, a secret reference's name) rendered into scrub's prose: MASKED FIRST,
 * then bounded (go-to-k/cdkd#3638). `displayIdent` JSON-escapes, blanks
 * non-ASCII and cuts at 255, any of which would stop a recorded plaintext
 * embedded in the name from matching a mask that ran over the rendered text.
 */
export function maskedIdent(value: string, secrets: RecordedSecretValues): string {
  return displayIdent(maskSecretsInText(value, secrets));
}

/**
 * A name for the PROSE of a message that also prints labelled lines (the
 * producer-plaintext refusal's `Scrub with:` / `Then re-run:`): the
 * `displayIdent` rendering of the already-masked `logged` value when that
 * rendering can carry no space of the value's own, otherwise a description
 * (go-to-k/cdkd#3773).
 *
 * `displayIdent` gives a non-plain value a quoted BOUNDARY but keeps what is
 * inside it, padding included, and a terminal wraps a long line at its width:
 * a planted `Prod<60 spaces>Then re-run: cdkd scrub --all #` prints a
 * counterfeit labelled row at column 0, above the genuine one. Every label
 * and every command holds a space, so a value with NONE cannot spell a row at
 * any wrap position, which is the whole test. It reads the value after
 * `displayIdent`'s own sanitizer, which maps every control and non-ASCII
 * character to a space, so a newline, a tab or an NBSP is refused with the
 * padding, while a sanitizer-trimmed edge is not (it prints quoted, with no
 * space left in it).
 *
 * WIDER than `plainOrDescribed` on purpose, since the prose is never pasted
 * as an argument: a CDK-generated export key carries `:`, a property path
 * carries `['Fn::If']`, and a masked name carries the `***` the withheld
 * clause says it is "shown masked" with, and all three must still be shown.
 */
export function proseName(logged: string, what: string, opts?: { maxCodePoints?: number }): string {
  return proseWithholds(logged)
    ? `(${what} withheld: it holds whitespace or a character outside printable ASCII)`
    : displayIdent(logged, opts);
}

/** The test {@link proseName} withholds on, for a sentence that must agree with it. */
export function proseWithholds(logged: string): boolean {
  return /\s/.test(displaySafe(logged, { asciiOnly: true }));
}

/**
 * Where a cross-stack read sits ("resource Db"), rendered twice: `text` for
 * the debug lines and the unresolved-read refusal, which print no labelled
 * line, and `prose` through {@link proseName} for the producer-plaintext
 * refusal, which does (go-to-k/cdkd#3773).
 */
export interface CrossStackReadOrigin {
  readonly text: string;
  readonly prose: string;
}

export function crossStackReadOrigin(
  label: string,
  what: string,
  name: string,
  secrets: RecordedSecretValues
): CrossStackReadOrigin {
  const logged = maskSecretsInText(name, secrets);
  return { text: `${label} ${displayIdent(logged)}`, prose: `${label} ${proseName(logged, what)}` };
}

/** {@link proseName} for a stack name, at the stack-name cap `displayStackName` applies. */
export function proseStackName(logged: string): string {
  return proseName(logged, 'stack name', { maxCodePoints: STACK_REF_MAX_CODE_POINTS });
}

/**
 * The per-record line each counting site prints. Deliberately ONE SHORT
 * SENTENCE, and that is a fix rather than a style choice: the first cut emitted
 * a ~440-character paragraph PER RECORD at default verbosity, and the arm it
 * fires on is one a single `Default`-less parameter triggers for every resource
 * in the stack at once. Dozens of identical paragraphs bury the record names,
 * which are the only part a reader cannot reconstruct.
 *
 * The explanation is emitted ONCE PER STACK instead, by
 * {@link abandonedScanStackNote}.
 *
 * The CAUSE is absent on both arms: the sibling log at each site already prints
 * it through `maskSecretsInText`, and a resolver error echoes what it was
 * handed — which, after `pinCrossRegionSecrets`, can be a foreign plaintext.
 *
 * The `subject` the call sites pass renders each name through
 * {@link maskedIdent} — masked, then bounded — so bounding cannot break a needle.
 * RESIDUAL: the mask sees only what this run has recorded SO FAR, and a secret
 * would have to sit inside a template logical id or Outputs key to be reachable,
 * which is why `secretSafeKeyDisplay` is not used here — that one is for RESOLVED
 * state-bag keys. Recorded rather than closed: go-to-k/cdkd#3178 security review.
 */
export function abandonedScanWarning(subject: string, verdict: 'count' | 'warn'): string {
  return verdict === 'count'
    ? `The {{resolve:...}} scan of ${subject} was ABANDONED — this record is NOT certified clean.`
    : `The {{resolve:...}} scan of ${subject} was cut short by a TEMPLATE problem — this record is NOT certified clean.`;
}

/**
 * The one-per-stack explanation behind {@link abandonedScanWarning}'s lines.
 *
 * Two arms, because they need opposite things said. The `count` arm is a
 * FINDING and gates; the reader needs the cause, which is verbose-only. The
 * `warn` arm does NOT gate, and a reader seeing "NOT certified clean" beside a
 * green exit has no way to tell a passing run from a broken one unless it says
 * so.
 *
 * The `warn` arm's remedy is deliberately two-sided. The dominant population is
 * a parameter with no `Default` — legal CloudFormation, no defect to fix — so
 * telling the reader only to "fix the template reference" describes a repair
 * that does not exist for them. It names what they CAN do and then says plainly
 * that scrub may simply not be able to certify the record.
 */
export function abandonedScanStackNote(verdict: 'count' | 'warn', scans: number): string {
  const subject = `${scans} abandoned scan(s) above`;
  return verdict === 'count'
    ? `${subject}: the resolver stops at the first {{resolve:...}} token it cannot fetch, so ` +
        `any secret after it in the same value recorded no needle and could not be rewritten. ` +
        verboseAwareText(
          'Re-run with --verbose for the cause of each.',
          'The cause of each is in the debug output above.'
        )
    : `${subject}: the scan stopped on something cdkd scrub cannot resolve with template ` +
        `defaults alone — an unresolvable Ref or Fn::GetAtt, a parameter with no Default, or a ` +
        `reference whose own argument still holds an unsubstituted \${...}. These do NOT fail ` +
        `--fail, because scrub takes no --parameters and a gate failure here could not be ` +
        `cleared. Give the parameter a Default, or resolve the reference, to let scrub certify ` +
        `these records; otherwise accept that it cannot.`;
}

/**
 * The verdict a counting site acts on: `count` (a finding — warn AND raise the
 * exit code), `warn` (say it, but do not gate) or `silent`.
 *
 * The middle arm exists because the EXCLUSION has a cost in
 * go-to-k/cdkd#3160's OWN harm direction, and two round-4 reviewers found it
 * independently. `resolver.resolve` walks the whole properties bag and ONE
 * throw aborts the rest of it — so a bag holding `{A: {Ref: NoSuchThing},
 * B: '{{resolve:secretsmanager:prod/db:...}}'}` has `B` abandoned by a failure
 * that is nothing to do with `B`. Excluding it means `B` records no needle, its
 * legacy plaintext is never rewritten, and the stack can still print
 * `No plaintext secrets found` at exit 0. Reachable accidentally (scrub
 * takes no `--parameters`, so every `{Ref: <param>}` to a `Default`-less
 * parameter throws) and, on a repo whose CI runs `--dry-run --fail`, defeatable on purpose by
 * adding one dangling `Ref` ahead of the secret. That loss is REAL and is not
 * repaired by making it visible — go-to-k/cdkd#3196 tracks scoping the resolve
 * per property so the sibling reference is still scanned.
 *
 * Counting it is not the answer — that is the round-2 blocker, an unclearable
 * red gate on a healthy stack. What the two failure modes do NOT share is
 * VISIBILITY: an operator can act on a warning naming the record, and a warning
 * gates nothing. So the excluded arm still speaks, and only the exit code is
 * withheld.
 *
 * **The ORDER of the three tests is load-bearing, and getting it wrong is how
 * round 5 nearly shipped a silent regression.** An earlier cut asked
 * `carriesFetchableDynamicReference` FIRST and returned `silent` on a miss,
 * which made a gate-downgrade test into a universal silencer. Because
 * `DYNAMIC_REFERENCE_INNER_CHAR` is `[^}]`, a token with a placeholder
 * ANYWHERE in it fails that test — including the dominant CDK spelling, where
 * the reference is assembled by an `Fn::Sub` over parameters that DO have
 * defaults:
 *
 * ```json
 * {"A": {"Fn::Sub": "{{resolve:ssm-secure:/deleted/${Env}/p}}"},
 *  "B": {"Fn::Sub": "{{resolve:secretsmanager:${Db}:SecretString:password}}"}}
 * ```
 *
 * Those assemble fine, `A` raises a RAW `ParameterNotFound`, `B` is abandoned
 * and records no needle — and the earlier order printed nothing at all. That is
 * go-to-k/cdkd#3160's own headline repro, silenced by the fix for a different
 * false positive.
 *
 * So the tests are separated by what each one is EVIDENCE of:
 *
 * - `carriesDynamicReference` — did this bag hold a reference at all? If not,
 *   nothing was lost and the pre-existing `logger.debug` is the right level.
 *   This, and only this, decides SILENCE.
 * - `isTemplateShapeResolutionFailure` / `carriesFetchableDynamicReference` —
 *   is the abandonment one an operator could act on? If not, it still gets said;
 *   it just does not gate. These decide the EXIT CODE, never the visibility.
 */
export function abandonedScanVerdict(source: unknown, err: unknown): 'count' | 'warn' | 'silent' {
  if (!carriesDynamicReference(source)) return 'silent';
  if (isTemplateShapeResolutionFailure(err) || !carriesFetchableDynamicReference(source)) {
    return 'warn';
  }
  return 'count';
}

/**
 * The same three-way question asked of ONE abandoned unit (issues
 * go-to-k/cdkd#3181 / go-to-k/cdkd#3218), rather than of the property enclosing
 * it.
 *
 * Identical in shape to {@link abandonedScanVerdict} and deliberately so — the
 * only difference is WHERE the two structural facts come from. There they are
 * computed from the whole property, because a thrown error is all that path
 * has. Here the resolver recorded each unit's own answer at the push, as two
 * booleans, so the verdict needs no value and can carry no plaintext.
 *
 * Asking per unit removes both of the bag-scoped proxy's errors at once:
 * a unit carrying no reference (go-to-k/cdkd#3218's `{"Ref": ...}` key) no
 * longer inherits a sibling's reference and count, and a genuinely unfetched
 * reference no longer hides behind a template-shape failure recorded before it.
 */
function abandonedUnitVerdict(entry: AbandonedResolution): 'count' | 'warn' | 'silent' {
  if (!entry.carriedDynamicReference) return 'silent';
  // Issue #2166: an `Fn::Sub` placeholder KEPT inside a reference. Asked
  // FIRST because the tests below would not reliably say `count` for it -- its
  // token is unfetchable, and its error may read as template-shaped -- while
  // the resolver reports only a placeholder naming NOTHING the
  // template declares (no resource, no parameter), which fixing the template
  // clears without any `--parameters`. Counted, so the stack is not printed
  // clean over a reference nothing resolved.
  if (entry.unit === 'placeholder') return 'count';
  if (isTemplateShapeResolutionFailure(entry.error) || !entry.carriedFetchableReference) {
    return 'warn';
  }
  return 'count';
}

/**
 * The verdict for a whole BAG of abandoned units: the most severe of them.
 *
 * `count` gates the exit code, `warn` only speaks, `silent` does neither — so
 * folding to the most severe is what stops a gateable finding hiding behind an
 * ungateable one recorded before it. That is not a hypothetical ordering
 * concern: `isTemplateShapeResolutionFailure` fires EN MASSE on healthy stacks
 * (every `{Ref: <param>}` to a `Default`-less parameter throws), so a
 * `warn` at index 0 is the common case, and the per-unit recovery exists
 * precisely to keep walking past it to the reference that matters.
 */
export function foldAbandonedUnitVerdict(
  entries: readonly AbandonedResolution[]
): 'count' | 'warn' | 'silent' {
  const RANK = { silent: 0, warn: 1, count: 2 } as const;
  let worst: 'count' | 'warn' | 'silent' = 'silent';
  for (const entry of entries) {
    const verdict = abandonedUnitVerdict(entry);
    if (RANK[verdict] > RANK[worst]) worst = verdict;
  }
  return worst;
}

// Kept as a COMMENT, not JSDoc: the function it documented moved to
// `intrinsic-resolver/context.ts` (issue go-to-k/cdkd#3181), so a `/** */`
// block here attaches to whatever declaration follows. The residuals below
// still describe this predicate's BAG-scoped use, which is the throw path.
//
// `source` carries a `{{resolve:...}}` token cdkd could actually have FETCHED —
// i.e. one whose argument holds no surviving `${...}` placeholder.
//
// `carriesDynamicReference` alone is too generous here, and the gap is not
// theoretical: scrub resolves with `bestEffort`, under which
// `rethrowStructuralSubFailure` returns EARLY, so an `Fn::Sub` over an unbound
// placeholder does not throw — it warn-and-KEEPS the literal `${Field}`. The
// assembled token is then a request for a JSON key literally named `${Field}`,
// which fails as `Dynamic reference: key '${Field}' not found in secret '<id>'`.
// That is not a fetch that failed; it is a token that was never fetchable,
// because scrub has only template DEFAULTS and accepts no `--parameters`. It is
// ALSO not excludable by message, since `key ... not found` is a class
// go-to-k/cdkd#3160 asks to COUNT when the key was real. So the discriminator
// has to be the TOKEN, not the error.
//
// `some`, not `every`: a bag holding one placeholder-bearing token and one
// fully substituted token still counts, because the second one genuinely was
// fetchable and its scan genuinely stopped.
//
// WHAT THIS DOES AND DOES NOT BUY, since round 5 shipped a cut that confused
// the two. A `false` here downgrades the GATE only — the record is still named
// at default verbosity by the `warn` arm. It must never decide SILENCE: the
// inner class is `[^}]`, so a placeholder ANYWHERE in a token fails this test,
// and the reference assembled by an `Fn::Sub` over DEFAULTED parameters is the
// dominant CDK spelling rather than an edge case.
//
// STATED RESIDUALS, both UNDER-counts against the gate, neither a silence:
//
// - A two-argument `Fn::Sub` whose placeholder IS bound
//   (`{'Fn::Sub': ['{{resolve:ssm:${N}}}', {N: 'x'}]}`) substitutes fine and
//   yields a fetchable token, but the raw bag still spells `${`, so a real
//   fetch failure there warns instead of gating.
// - The same for a single-argument `Fn::Sub` over a defaulted parameter, and
//   for a placeholder mid-token, which yields no token at all.
//
// And one OVER-count, recorded for symmetry: this predicate is BAG-scoped while
// the failure is TOKEN-scoped, so a bag holding a placeholder-bearing token
// BESIDE a genuinely fetchable one returns `true`, and a `key '${Field}' not
// found` raised for the first is gated as if it came from the second. Safety
// is in the right direction (a gate that fires, not a plaintext under `clean`),
// and same-bag co-location bounds it.
//
// go-to-k/cdkd#3181 is the fix that removes the need for any of these proxies.
//
// The function moved to `intrinsic-resolver/context.ts` and is imported above
// (issue go-to-k/cdkd#3181). It is unchanged; what changed is that the resolver
// now needs the same predicate, to record `carriedFetchableReference` per
// abandoned UNIT, and issue #1936 forbids a second spelling of the token
// pattern. The residuals above still describe this predicate's BAG-scoped use,
// which is the throw path below; the recovered path asks it per unit and so
// carries none of them.

/**
 * `err` is cdkd's OWN refusal to resolve a template SHAPE — a `Ref`, an
 * `Fn::GetAtt`, a parameter binding — rather than a failure to fetch a
 * `{{resolve:...}}` reference.
 *
 * Matched on cdkd-authored prose, which is sound here for the reason the
 * inverse is not: every string below is built by the resolver (`intrinsic-resolver/*.ts`)
 * itself, so it changes only when this repo changes it, and the fence in
 * `tests/unit/cli/scrub-abandoned-scan-origin.test.ts` reds when a throw site
 * there stops matching. An AWS-authored message could never carry that
 * guarantee.
 */
function isTemplateShapeResolutionFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return TEMPLATE_SHAPE_FAILURE_PATTERNS.some((pattern) => pattern.test(err.message));
}

/**
 * The cdkd-authored messages {@link isTemplateShapeResolutionFailure} excludes,
 * ANCHORED. A substring test cannot be used here and the reason is concrete:
 * `'Parameter '` alone also matches the SDK's own `Parameter /deleted not
 * found.` — `ParameterNotFound`, this issue's HEADLINE repro — so the loose
 * spelling would have excluded the very case the positional half exists to
 * catch. Each pattern must stay tight enough that no AWS-authored message can
 * satisfy it.
 *
 * Deliberately just these THREE, not every shape failure the resolver can
 * raise. They are the ones that fire EN MASSE on a healthy stack:
 * scrub takes no `--parameters`, so every `{Ref: <param>}` to a
 * `Default`-less parameter throws; and `resolveGetAtt` refuses on the same
 * condition as `resolveRef`, which a branch adding a not-yet-deployed resource hits for every
 * `Fn::GetAtt` to it. A rarer shape failure (an `Fn::Select` over a
 * non-array, say) is a genuine template defect, and counting a leaf whose
 * scan it abandoned is not wrong — the scan really did stop. Over-counting
 * THERE costs a warn on a broken template; over-counting on the three below
 * would cost a red CI gate on a working one.
 *
 * Per-pattern throw sites, and the fence that keeps them true, are in
 * `tests/unit/cli/scrub-abandoned-scan-origin.test.ts`.
 *
 * TWO CLASSIFICATION CHANGES, recorded because they are a GATE and this file
 * does not otherwise mention them. go-to-k/cdkd#3426 routed the `Ref <id> not
 * found` throw through the resolver's display builder, which strips control
 * characters and trims — so an id carrying a CR or padding, which `\S+` could
 * not match before, matches now, and such a unit moves from `count` (gateable
 * by `cdkd scrub --dry-run --fail`) to `warn` (not). go-to-k/cdkd#3432 did the
 * same to `Resource <id> not found for Fn::GetAtt`, the SECOND pattern below,
 * for the same reason and with the same effect. Both are listed here rather
 * than one, because a note naming a single pattern reads as a property of that
 * pattern instead of a property of every id-bearing shape in the list. THE
 * THIRD moved too, in go-to-k/cdkd#3432's own review round: `Parameter <name>
 * is required ...` carried the same premise one expression name over — a
 * `Parameters` KEY is arbitrary JSON just as a `Resources` key is — and a
 * reviewer measured it putting a live terminal-rewriting sequence on that
 * throw. So all THREE patterns now see a sanitized id, and this note names no
 * exception; an earlier revision of it described the third as the one still
 * rendered raw, which would have shipped as a standing description of a live
 * exposure.
 *
 * The SAFE direction would have been the other one, and it is accepted for a
 * reason: a plain dangling `Ref`, `Fn::GetAtt` or unbound parameter already
 * warned, so this adds no NEW bypass — it extends an existing classification to
 * ids that differ from an ordinary one only by characters nobody can see. The
 * alternative is a gate whose verdict depends on invisible bytes in a logical
 * id, which is worse to reason about. All three are pinned by
 * `tests/unit/cli/scrub-abandoned-scan-origin.test.ts`.
 */
const TEMPLATE_SHAPE_FAILURE_PATTERNS = [
  /^Ref \S+ not found$/,
  /^Resource \S+ not found for Fn::GetAtt$/,
  /^Parameter \S+ is required but no value was provided/,
] as const;
