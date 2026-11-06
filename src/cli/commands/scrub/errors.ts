import { safeStringify } from '../../../utils/aws-failure-text.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { errorCauseChain } from '../../../deployment/secret-redaction.js';
// An export NAME is a template-controlled RESOLVED value and an index read's
// error message interpolates a bucket / key, so both reach the terminal only
// through the same control-byte strip `export-index-store.ts` uses for the
// name it logs.
import { displayIdent, displayStackName } from '../../../utils/display-safe.js';
import type { SecretSafeKeyDisplay } from '../../../deployment/outputs-export-alias.js';
import { STATE_RESOURCES_MALFORMED } from '../../../state/malformed-resources-bag.js';

/**
 * Signals `cdkd scrub` found plaintext it is reporting rather than removing.
 * Thrown under `--fail`: with `--dry-run` when a value the template names through
 * a `{{resolve:...}}` reference is in state as plaintext,
 * and on a REAL run when a leak was found that scrub cannot rewrite (a
 * secret-bearing output KEY, issue #1919). Carries no message — the plan was
 * already printed — and maps to a non-zero exit so CI can gate on it.
 */
// Exported alongside `scrubCommand` so a test can assert the CI gate fails on
// the exact error type the CLI maps to a non-zero exit, rather than on any throw.
export class ScrubNeededError extends CdkdError {
  readonly silent: boolean = true;

  constructor() {
    super('scrub needed', 'SCRUB_NEEDED');
    this.name = 'ScrubNeededError';
    Object.setPrototypeOf(this, ScrubNeededError.prototype);
  }
}

/**
 * Every `cdkd scrub` REFUSAL — a reference this command cannot safely
 * re-resolve, and the per-stack failures that refusal produces under `--all`
 * (issue [#2109](https://github.com/go-to-k/cdkd/issues/2109) review).
 *
 * `exitCode = 2` rather than `CdkdError`'s default of 1, because 1 is already
 * SPOKEN FOR: `--fail` throws {@link ScrubNeededError} for "plaintext is in
 * state", and `docs/cli-reference.md` documents the pair as `1` (`--fail` found
 * plaintext) / `2` (error). A refusal is the second one, and left on the default
 * a CI gate reading the exit code alone could not tell "scrub looked and found a
 * leak" from "scrub refused to look" — the two call for opposite responses
 * (rotate the secret vs. re-spell the reference and re-run).
 */
/**
 * An internal invariant of the exports-index repair, thrown where this code
 * believes a case is unreachable (issue #2667 review).
 *
 * A distinct CLASS because the repair runs inside the per-stack `try` whose
 * `catch` attributes everything to "the exports index could not be READ": a
 * plain `Error` there is reported as an S3 read failure, sending an operator to
 * their bucket policy over a bug in cdkd. That catch rethrows this class
 * instead, so it surfaces as the per-stack failure it actually is.
 */
// Exported for tests, for the same reason `ScrubNeededError` is: the
// classification is the behaviour under test — an invariant must NOT surface
// as "the index could not be read" — and asserting it on the error's identity
// rather than on its message text keeps the fence from drifting with wording.
export class ScrubIndexInvariantError extends CdkdError {
  readonly exitCode: number = 2;

  constructor(message: string) {
    super(message, 'SCRUB_EXPORT_INDEX_INVARIANT');
    this.name = 'ScrubIndexInvariantError';
    Object.setPrototypeOf(this, ScrubIndexInvariantError.prototype);
  }
}

/**
 * A state-bag KEY (an export name, an output key) as one log line may print it,
 * from the verdict `secretSafeKeyDisplay` returned for it.
 *
 * NON-ASCII IS WITHHELD on BOTH printable arms, the rule `maskedLabel` in
 * `outputs-export-alias/warnings.ts` applies to the warnings: `displayIdent` blanks such
 * a character to a space AFTER the verdict, so the printed text is no longer
 * the tested text -- a name spelling `correct` + U+09BC (or NBSP) + `horse`
 * beside a recorded `correct horse` printed the passphrase byte for byte.
 */
export function renderStateKeyForLine(
  shown: SecretSafeKeyDisplay,
  withheldBecause = 'it holds a secret this run recorded'
): string {
  if (shown.kind !== 'withheld' && /[^ -~]/.test(shown.text)) {
    return '(name withheld: it carries characters this line cannot show as tested)';
  }
  switch (shown.kind) {
    case 'safe':
      return displayIdent(shown.text);
    case 'masked':
      return `(masked: ${displayIdent(shown.text)})`;
    // Masking left the name unchanged, so printing it would publish the
    // secret under a label claiming it had been masked. The name is WITHHELD
    // and the message still identifies the stack and region.
    case 'withheld':
      return `(name withheld: ${withheldBecause})`;
  }
}

export class ScrubRefusalError extends CdkdError {
  readonly exitCode: number = 2;

  constructor(message: string, code: string) {
    super(message, code);
    this.name = 'ScrubRefusalError';
    Object.setPrototypeOf(this, ScrubRefusalError.prototype);
  }
}

/**
 * One failed stack's reason, INCLUDING its `cause` chain (issue #2109 review).
 *
 * `err.message` alone drops the actionable half of a wrapped failure: a
 * provider or AWS error is routinely a generic sentence over the link that
 * names the role, the bucket or the denied action. The chain is walked with
 * `errorCauseChain` rather than a local loop so the links PRINTED are exactly
 * the links `maskSecretsInError` masked at `scrubStack`'s boundary — a private
 * walk would eventually render a link past that function's depth cap, which
 * still carries its original, unmasked message.
 */
export function describeFailure(err: unknown): string {
  // `safeStringify`, not `String`: every caller is a per-stack failure
  // boundary that logs and moves on to the next stack, so a value `String`
  // cannot convert would abort the whole `--all` run from inside it (#3361).
  if (!(err instanceof Error)) return safeStringify(err);
  return errorCauseChain(err)
    .map((link, i) => (i === 0 ? link.message : `\n    Caused by: ${link.message}`))
    .join('');
}

/**
 * The error a `--all` run ends with when one or more stacks could not be
 * scrubbed (issue #2109 review).
 *
 * Every stack is NAMED: the per-stack boundary keeps the run going, and a
 * single "3 stacks failed" line would make the operator re-run the command to
 * find out which. `exitCode = 2` for the same reason every other scrub refusal
 * carries it — `1` means "`--fail` found plaintext".
 *
 * The REASONS are deliberately not repeated here. Each was already logged at
 * `error` level, in run order, next to the progress lines for the stacks around
 * it; `handleError` then prints this message, so restating every reason made
 * the whole failure set appear TWICE in one terminal — directly under a summary
 * whose own note says "see the errors above". Names are kept because they are
 * what a reader needs to FIND those lines, and because the count alone is the
 * thing the paragraph above rejects.
 */
export function scrubStacksFailedError(failures: ReadonlyArray<{ stackName: string }>): CdkdError {
  return new ScrubRefusalError(
    `${failures.length} stack(s) could not be scrubbed: ` +
      `${failures.map((f) => displayStackName(f.stackName)).join(', ')}. ` +
      `Each one's reason was logged as it happened — see the ` +
      `'Scrub of <stack> failed:' line above for it.`,
    'SCRUB_STACKS_FAILED'
  );
}

/**
 * A memoizing READ view over the state backend, for the resolutions ONE
 * `scrubStack` call performs (issue #2133 review).
 *
 * `resolveImportValue` has no lookup cache of its own: each reference costs a
 * `listStacks()` plus up to N `getState()` calls, and scrub resolves every
 * cross-stack reference TWICE — once in the pre-pass (which must run before the
 * best-effort catch can swallow a failure) and once in the main resolution
 * (which must run because the pre-pass deliberately does not rewrite the bag).
 * The view collapses both into one scan and one `getState` per (stack, region).
 *
 * `Object.create` rather than a hand-written wrapper object: the resolver also
 * reads `stateBackend.prefix` and could reach for more, and a literal cast to
 * `S3StateBackend` would turn the next such call into `undefined is not a
 * function`. Prototype delegation keeps every other member — and
 * `instanceof S3StateBackend` — intact.
 *
 * Deliberately NOT used for this stack's own `getState` / `saveState`: those go
 * through the real backend, so the read-modify-write still sees S3 rather than
 * a cache, and its ETag precondition still means what it says.
 */
/**
 * The finding a `--dry-run` raises for a record whose resources map it could
 * not read (issue go-to-k/cdkd#3018).
 *
 * `ScrubRefusalError`, so it carries scrub's exit **2**: `1` means "--fail
 * looked and found a leak -- rotate the secret", and this is the opposite
 * remedy ("repair the record and re-run"). Without it the run exits 0, or 1
 * under `--fail` via the SILENT `ScrubNeededError`, whose suppression would
 * also swallow this text.
 */
/**
 * A producer record this run could not classify (go-to-k/cdkd#3192 review).
 *
 * `ScrubRefusalError`, so it carries scrub's exit **2** — and UNGATED by
 * `--fail`, which is the whole point. Before the `outputs` bag was guarded,
 * both damaged shapes already exited 2 unconditionally: the ARRAY shape
 * resolved its element and raised `plaintextProducerCrossStackReadError`, the
 * STRING shape threw a `TypeError` the pre-pass deliberately does not catch.
 * Routing them into `unverifiableReads` alone made a plain `cdkd scrub` exit
 * 0 — and the `--fail` path exit 1, which `docs/cli-reference.md` teaches as
 * the opposite remedy (1 = rotate the secret, 2 = repair and re-run).
 *
 * Names are rendered through `displayIdent` for the reason
 * {@link malformedRecordsAuditedError} gives: a stack name reaching a
 * comma-joined list needs a boundary it cannot close from inside.
 */
/**
 * Stacks whose undeclared output keys were NOT dropped because the other
 * state records could not be read to rule out a reader (go-to-k/cdkd#4120).
 * Exit 2 whatever `--fail` says: scrub could not look.
 */
export function droppedOutputReadersUnverifiedError(
  stackNames: readonly string[]
): ScrubRefusalError {
  const names = stackNames.map((n) => displayIdent(n)).join(', ');
  return new ScrubRefusalError(
    `${stackNames.length} stack(s) hold output keys their template no longer declares, and ` +
      `the other stacks' state could not be read to confirm none of them reads one, so none ` +
      `was dropped: ${names}. Those stacks were scrubbed for everything else. Fix the read ` +
      `(see the warnings above) and re-run.`,
    'SCRUB_DROPPED_OUTPUT_READERS_UNVERIFIED'
  );
}

export function damagedProducerRecordsError(stackNames: readonly string[]): ScrubRefusalError {
  const names = stackNames.map((n) => displayIdent(n)).join(', ');
  return new ScrubRefusalError(
    `${stackNames.length} stack(s) import a value from a PRODUCER whose state record has no ` +
      `readable 'outputs' map, so this run could not tell whether that producer still holds ` +
      `the plaintext: ${names}. Those stacks were scrubbed for everything else and are NOT ` +
      `reported clean. Repair the producer record and scrub it first, then re-run. See the ` +
      `warnings above for which producer.`,
    'SCRUB_PRODUCER_RECORD_UNREADABLE'
  );
}

export function malformedRecordsAuditedError(
  stackNames: readonly string[],
  // No DEFAULT: the function is module-private, both call sites pass both
  // lists, and a default was the only way to reach `parts.length === 0` —
  // which renders a message with a leading space and no subject (review of
  // go-to-k/cdkd#3206). Two empty arrays are still type-legal, so what makes
  // that unreachable is the CALL SITES, each guarded by
  // `malformedRecords.length > 0 || malformedOutputRecords.length > 0`;
  // requiring the argument only stops a third caller from omitting it by
  // accident.
  outputStackNames: readonly string[],
  // The `orphans` CONTAINER's list (go-to-k/cdkd#3379), a third parameter for
  // the reason the second one is not a default: both call sites pass all three.
  orphanStackNames: readonly string[]
): ScrubRefusalError {
  // One sentence per CONTAINER, and only for a container that actually has
  // names (issue go-to-k/cdkd#3192). A record can be malformed in either alone,
  // so a single merged sentence would tell the reader nothing is known about
  // resources whose map was perfectly readable — and the two remedies point at
  // different parts of the same file.
  // SANITIZED, CAPPED and BOUNDED before interpolation (review of
  // go-to-k/cdkd#3206). These two sentences had interpolated raw since
  // go-to-k/cdkd#3018. Two rounds of review moved this: a first cut used
  // `displaySafe` alone and dropped the CAP, so one run rendered the same
  // stack name capped in the per-record warning and unbounded here; a second
  // hand-quoted the shared `safeIdentifier`, which leaves the quote inside the
  // name.
  //
  // Provenance, stated correctly: these names are `stack.stackName` off the
  // synthesized Cloud Assembly, NOT an S3 key — scrub's targets come from the
  // app. That makes a forged name unlikely rather than impossible (a CDK
  // construct id is not validated against control characters), and the cap is
  // the half that matters either way, because a nested child is `Parent~Child`
  // recursively.
  //
  // `displayIdent`, not `'${safeIdentifier(n)}'`: hand-quoting leaves the
  // quote character itself INSIDE the name, so a stack literally named
  // `a', 'b` forges an extra list entry (review round 4). `displayIdent`
  // JSON-quotes, which escapes the delimiter it adds, and carries its own cap
  // and `UNRENDERABLE` fallback — the same three properties `safeIdentifier`
  // gives, plus a boundary that cannot be closed from inside. It composes here
  // precisely because there is no `shellQuote` to conflict with: this message
  // contains no pasteable command.
  //
  // Every other stack name in this file renders through `displayStackName`
  // (go-to-k/cdkd#3638).
  const safeNames = (names: readonly string[]): string =>
    names.map((n) => displayIdent(n)).join(', ');
  const parts: string[] = [];
  if (stackNames.length > 0) {
    // WIDENED by go-to-k/cdkd#3202 from "an EMPTY resource set" to an INCOMPLETE
    // one, the way go-to-k/cdkd#3500 widened the orphan arm: a readable map can
    // hold a row no reader can use, and the dry-run arm DROPS that row and
    // reports it through this same list.
    parts.push(
      `${stackNames.length} stack(s) were audited with an INCOMPLETE resource set because ` +
        `their state record has no readable 'resources' map, or a row inside it that cannot ` +
        `be read as a resource: ${safeNames(stackNames)}. Whichever it was, the warning above ` +
        `names it per stack. The report above describes their readable resources and their ` +
        `outputs only — nothing is known about the rest, so this run cannot certify them clean.`
    );
  }
  if (outputStackNames.length > 0) {
    parts.push(
      `${outputStackNames.length} stack(s) were audited with an EMPTY outputs bag because ` +
        `their state record has no readable 'outputs' map: ${safeNames(outputStackNames)}. ` +
        `The report above describes their resources only — nothing is known about the values ` +
        `their outputs hold, and those values are what the exports index republishes to ` +
        `consumer stacks, so this run cannot certify them clean.`
    );
  }
  if (orphanStackNames.length > 0) {
    parts.push(
      `${orphanStackNames.length} stack(s) were audited with an INCOMPLETE orphan list because ` +
        `their state record has no readable 'orphans' list, or a record inside it that no ` +
        `reader can use: ${safeNames(orphanStackNames)}. Whichever it was, the warning above ` +
        `names it per stack. Nothing is known about the resources those records describe — ` +
        `resources an earlier failed deploy may have left live in AWS — so this run cannot ` +
        `certify them clean.`
    );
  }
  return new ScrubRefusalError(
    `${parts.join(' ')} See the warnings above for the record to inspect.`,
    STATE_RESOURCES_MALFORMED
  );
}
