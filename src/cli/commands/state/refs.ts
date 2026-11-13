import {
  cdkdRemedy,
  commandHole,
  pasteableCommand,
  plainOrDescribed,
  withheldTargetClause,
  proseQuoted,
} from '../../../utils/pasteable-command.js';
import { type StackStateRef } from '../../../state/s3-state-backend.js';
import {
  displayIdent,
  displayStackName,
  isPasteableIdent,
  STACK_REF_MAX_CODE_POINTS,
} from '../../../utils/display-safe.js';

/**
 * Detail row for a single stack when --long is requested.
 *
 * The record read and the lock read degrade SEPARATELY (issue #3069): one
 * unreadable stack used to reject the whole listing, and a single conflated
 * failure field would withhold a row's real counts when only its lock failed.
 */
export interface StackDetail {
  stackName: string;
  /**
   * Region recorded for this state record. `null` for legacy `version: 1`
   * state where no region was persisted in the state body.
   */
  region: string | null;
  /**
   * `null` exactly when {@link stateReadError} is set: the record could not be
   * read, or its `resources` is not a JSON object.
   */
  resourceCount: number | null;
  lastModified: string | null;
  /** `null` when the lock could not be read ({@link lockReadError}). */
  locked: boolean | null;
  /**
   * A fixed, class-level reason when the record read failed or its
   * `resources` is not a JSON object, else `null`.
   */
  stateReadError: string | null;
  /**
   * Which failure {@link stateReadError} describes, for a machine consumer that
   * must not string-match the prose: `null` exactly when `stateReadError` is.
   * The two want opposite handling -- a failed read may be transient and is
   * worth retrying, a malformed `resources` is persistent -- so a consumer that
   * retried on any `stateReadError` would re-read a malformed record forever
   * (go-to-k/cdkd#3163).
   */
  stateReadErrorKind: StateReadErrorKind | null;
  /** A fixed, class-level reason when the lock read failed, else `null`. */
  lockReadError: string | null;
}

/**
 * The reasons a `--long` row carries for a failed read. FIXED text, never the
 * caught error's message: `getState`'s invalid-JSON refusal interpolates V8's
 * `SyntaxError`, which quotes bytes of the state body, and anyone with
 * `s3:PutObject` on the bucket chooses those bytes. Sanitizing or truncating
 * that message does not redact it, so a planted plaintext would reach both
 * `--long` and `--long --json` (issue #3069). `cdkd state show` for the one
 * stack is where the specific error is reported.
 *
 * The failure is deliberately not classified further: `getState` wraps a parse
 * refusal, the unsupported-version refusal and an AWS read failure in the same
 * `StateError`, so any finer reason would be a guess about the class.
 */
function stateReadFailedReason(): string {
  return `state record could not be read; run ${proseQuoted(stateShowCommand(), '`')} for the error`;
}
export function lockReadFailedReason(): string {
  return `lock could not be read; run ${proseQuoted(stateShowCommand(), '`')} for the error`;
}
function stateShowCommand(): string {
  return cdkdRemedy('cdkd state show');
}
/**
 * The lock reason for a LEGACY row (no region). `cdkd state show` refuses such
 * a record before it reads the lock, so pointing there would send the user to
 * a command that never shows the error.
 */
export const LEGACY_LOCK_READ_FAILED_REASON = 'lock could not be read';
/**
 * The record-side reason for a record that WAS read but whose `resources` is
 * present and not a JSON object. `parseStateBody` validates nothing inside the
 * root, so `Object.keys` would count a planted string per character or a list
 * per element -- a made-up number, and for a string of millions of characters
 * an array of that many keys, built outside {@link readOrFailure}'s `try`. It
 * reuses `stateReadError` so `resourceCount` stays `null` exactly when a reason
 * is set: the text row never prints `Resources: null`, and the warning counts
 * the row (issue #3069).
 */
function resourcesMalformedReason(): string {
  return `resources is not a JSON object; run ${proseQuoted(cdkdRemedy('cdkd state show', '--json'), '`')} to see the record`;
}

/**
 * The machine-readable half of `stateReadError` under `--long --json`. A
 * string union rather than a boolean so a later failure class is ADDITIVE: a
 * consumer switching on it has a default arm to fall into.
 */
export type StateReadErrorKind = 'read-failed' | 'resources-malformed';

/** The fixed `stateReadError` text for each {@link StateReadErrorKind}. */
export function stateReadReasons(): Record<StateReadErrorKind, string> {
  return {
    'read-failed': stateReadFailedReason(),
    'resources-malformed': resourcesMalformedReason(),
  };
}

/**
 * A record's resource count, or `null` when its `resources` is not a JSON
 * object ({@link resourcesMalformedReason}). An absent or `null` bag counts
 * as zero, the tolerance `docs/cli-state.md` documents for it.
 */
/**
 * The records `cdkd state destroy` destroys for one stack: with
 * `--stack-region`, every record in that region (a legacy record with no
 * region included); without, the only record. `undefined` when there are
 * several and none is chosen (the command refuses). The cross-prefix
 * pre-start (go-to-k/cdkd#4705) and the loop share it.
 */
export function stateDestroyTargets<T extends { region?: string | undefined }>(
  refs: readonly T[],
  stackRegion: string | undefined
): T[] | undefined {
  if (stackRegion) return refs.filter((r) => r.region === stackRegion || !r.region);
  return refs.length === 1 ? [...refs] : undefined;
}

export function resourceCountOrNull(resources: unknown): number | null {
  if (resources === undefined || resources === null) return 0;
  if (typeof resources !== 'object' || Array.isArray(resources)) return null;
  return Object.keys(resources).length;
}

/**
 * Run one read and report whether it threw, WITHOUT keeping the error. The
 * error is dropped on purpose ({@link stateReadFailedReason} says why): a
 * caller that never holds it cannot copy it into a row.
 */
export async function readOrFailure<T>(
  read: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
}

/**
 * A record's `lastModified` as an ISO string, or `null` when it is not a
 * timestamp `Date` can represent. `parseStateBody` does not validate the
 * field, and `toISOString()` THROWS a `RangeError` for any number outside
 * JavaScript's date range (`1e300`, `NaN`-producing values, `-1e20`). That
 * throw sits AFTER {@link readOrFailure} reported success, so without this
 * check one planted record would still reject the whole `--long` listing
 * (issue #3069, security review).
 */
export function isoTimestampOrNull(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Detail row for a single resource emitted by `state resources`.
 *
 * Mirrors the public-facing fields of `ResourceState` minus `properties` —
 * properties are reserved for `state show`, which does include them.
 */
export interface ResourceDetail {
  logicalId: string;
  resourceType: string;
  physicalId: string;
  dependencies: string[];
  attributes: Record<string, unknown>;
}

/**
 * Render `Stack` or `Stack (region)` for a line a terminal renders: every
 * `state list` text view -- the default one-reference-per-line listing and the
 * `--long` / `--tree` rows (issue #3069) -- and every refusal, log line and
 * warning in this file that names a record by its reference
 * (go-to-k/cdkd#3179). The unsanitized twin it replaced lost its last caller.
 *
 * Both halves come from an S3 key segment (or, for a legacy record, a state
 * body), so both are attacker-influenced in exactly the way issue #2170 round
 * 4 found for a lock error: a planted `\n` forged a whole line inside that
 * sentence.
 *
 * BOTH halves go through `displayIdent`, not the bare `asciiOnly` allowlist
 * (issue #3164). The allowlist closes line FORGERY and nothing else: it is the
 * identity on printable ASCII, and this function's ` (` / `)` is cdkd's OWN
 * annotation of the line, so a planted 2-segment legacy key
 * `cdkd/ProdStack (us-east-1)/state.json` yields a region-LESS ref whose
 * `stackName` is literally `ProdStack (us-east-1)` and renders BYTE-EQUAL to
 * the genuine `ProdStack` in `us-east-1`. A `while read -r ref` cleanup loop —
 * the consumer the sanitization exists for — cannot tell the two apart, so it
 * acts on the reference the operator believes is real and the planted record
 * survives the sweep.
 *
 * The two confirmation prompts no longer render through this helper: they sit
 * beside a labelled pasteable line, where a value that is not a plain
 * identifier is DESCRIBED rather than shown ({@link describedStackRef},
 * go-to-k/cdkd#3760). That also closes the joined-list forgery those prompts
 * had -- `ProdStack,` beside the formatter's own ` (region)` read as an extra
 * entry -- since a described value carries no `,` (go-to-k/cdkd#3179).
 *
 * `displayIdent` makes the boundary VISIBLE by JSON-quoting anything that is
 * not a plain identifier, so the row above reads `"ProdStack (us-east-1)"` and
 * no longer collides. It is applied to the REGION half too: a region is an S3
 * key segment (or, for a legacy record, the state body via `readLegacyRegion`),
 * so it is attacker-chosen in exactly the same way, and a planted region alone
 * renders `Decoy (x) (us-east-1)` — the same spoof from the right-hand side.
 *
 * Every legitimate row is byte-identical, because `displayIdent` is the
 * identity on a plain identifier and CloudFormation stack names
 * (`Parent~Child` included) and AWS region codes all are — so no fixture, no
 * script's grep and no round-trip into `cdkd state show` changes. A value
 * sanitising leaves empty renders `UNRENDERABLE`, since an empty `()` would
 * read as "no region" rather than "a region cdkd will not print".
 *
 * The NAME half passes `STACK_REF_MAX_CODE_POINTS` rather than taking
 * `displayIdent`'s 255 default, and that is load-bearing for the paragraph
 * above rather than a tuning knob: a cdkd state-record name is not a
 * CloudFormation stack name, because `deriveChildStackName` appends
 * `~<logicalId>` per nesting level, so a legitimate deep nested-stack child
 * exceeds 255 and would be rendered CUT — a byte change on a legitimate row, in
 * the middle of a line `while read -r ref` consumes. The REGION half keeps the
 * default; an AWS region code is at most 25 characters.
 *
 * What the quoting is NOT: shell-safe. A JSON string literal is visually
 * indistinguishable from a shell DOUBLE-quoted argument, in which `$(...)`,
 * backticks and `!` still expand — so `"Prod$(touch /tmp/pwn)" (us-east-1)`
 * must not be pasted into a command line, and this rendering makes no claim
 * that it may be. The repo's answer for a value that has to survive a command
 * line is elsewhere and is SUPPRESSION, not quoting: `buildForceUnlockCommand`
 * declines to print a command at all unless sanitisation was the identity, and
 * `rollback-executor/messages.ts`'s `PASTEABLE_LOGICAL_ID` records why identity alone is
 * still not enough (`~user` and `=x` expand). What this function provides is a
 * visible BOUNDARY for a value a human is reading, which is a different job.
 */
export function formatStackRefSafe(ref: StackStateRef): string {
  const name = displayIdent(ref.stackName, { maxCodePoints: STACK_REF_MAX_CODE_POINTS });
  return ref.region ? `${name} (${displayIdent(ref.region)})` : name;
}

/**
 * A stack name or region cdkd's own `', '` joins into a list: `displayIdent`
 * with `listMember`, so a value carrying a bare `,` is quoted rather than read
 * as a separator (go-to-k/cdkd#3179). `(legacy)` is this file's own literal
 * for a region-less record, never a value from a key.
 *
 * Every value a refusal or log line in this file names -- a stack name or a
 * region out of `listStacks()`, a state body, or the operator's argv -- renders
 * through `displayIdent`'s boundary and never inside cdkd's own `'...'`: the
 * `asciiOnly` allowlist keeps `'`, `$`, `(` and `;`, so a value carrying `'`
 * closed a hand-written quote and whatever followed ran when the sentence was
 * pasted (go-to-k/cdkd#3950), and it keeps a space, so a value could carry
 * cdkd's own ` (region)` annotation (go-to-k/cdkd#3179). A plain value renders
 * bare and byte-identically.
 */
export function listedStackName(stackName: string): string {
  return displayIdent(stackName, { maxCodePoints: STACK_REF_MAX_CODE_POINTS, listMember: true });
}

function listedRegion(region: string | undefined): string {
  return region === undefined ? '(legacy)' : displayIdent(region, { listMember: true });
}

/**
 * A target reference for a sentence printed BESIDE a labelled pasteable line
 * (`state orphan`'s `Destroy with:` banner and prompt and every line of the
 * same run, `state refresh-observed`'s prompt ahead of the legacy refusal's
 * `Migrate with:`). `displayIdent`'s
 * boundary is not enough there: it keeps interior spaces, so a padded name or
 * region can WRAP on screen into a counterfeit labelled row. Each half is
 * therefore shown only when `isPasteableIdent` admits it and DESCRIBED
 * otherwise (go-to-k/cdkd#3760, option 1) -- which also means no rendered half
 * carries a `,` into the joined list (go-to-k/cdkd#3179).
 */
export function describedStackRef(ref: StackStateRef): string {
  const name = plainOrDescribed(ref.stackName, 'stack name');
  return ref.region ? `${name} (${plainOrDescribed(ref.region, 'region')})` : name;
}

/**
 * The subject of a legacy-record refusal, which sits beside a labelled
 * `Migrate with:` line: the name only when `isPasteableIdent` admits it, the
 * same predicate the command's `plainIdent` gate applies, so the prose never
 * names a value the command withholds (go-to-k/cdkd#3696, go-to-k/cdkd#3760).
 */
export function legacyRecordSubject(stackName: string): string {
  return isPasteableIdent(stackName)
    ? `Stack ${stackName}`
    : `A stack whose name is not a plain identifier (see ${proseQuoted(cdkdRemedy('cdkd state list', '--long'))})`;
}

/**
 * `state resources` / `state show` refusing a legacy region-less record. The
 * `cdkd deploy` beside the labelled line takes `plainIdent`, as
 * `refresh-observed`'s legacy refusal does (go-to-k/cdkd#3696), so all three
 * decide "may I name this target" by one predicate and explain a hole with the
 * gate's own reason.
 */
export function legacyRecordRefusal(stackName: string): Error {
  const migrate = pasteableCommand('cdkd deploy', [
    { value: stackName, hole: 'stack', opts: { patternMatched: true, plainIdent: true } },
  ]);
  return new Error(
    `${legacyRecordSubject(stackName)} has only a legacy state record without a region. ` +
      `A cdkd write migrates it to the region-scoped layout; re-run this command ` +
      `after it.` +
      withheldTargetClause(migrate, 'stack', 'cdkd deploy') +
      `\nMigrate with: ${migrate.command}`
  );
}

/**
 * The sentence a message adds when it DESCRIBED a value rather than showing it:
 * a description is not an identity, so two records whose names or regions are
 * both described read the same, and the operator needs the route to the
 * records as stored.
 */
export function stateListPointer(): string {
  return `${proseQuoted(cdkdRemedy('cdkd state list', '--long'))} shows the records as stored.`;
}

/** Whether `describedStackRef` describes either half of `ref`. */
export function refIsDescribed(ref: StackStateRef): boolean {
  // The same region test `describedStackRef` applies, so the two agree.
  return !isPasteableIdent(ref.stackName) || (ref.region ? !isPasteableIdent(ref.region) : false);
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * `stack <name>` for a plain identifier, else a description that reads as a
 * noun phrase in the same slot (`a stack whose name is not a plain
 * identifier`) -- `plainOrDescribed` there would print `stack a stack name
 * that is not a plain identifier`.
 */
export function describedStackSubject(stackName: string): string {
  return isPasteableIdent(stackName)
    ? `stack ${stackName}`
    : 'a stack whose name is not a plain identifier';
}

/**
 * `--stack-region` named a region the stack has no record in. One spelling for
 * the three commands that refuse it (`resolveSingleRegion`, `state orphan`;
 * `state refresh-observed` reaches it through `resolveSingleRegion`).
 *
 * `described` is for `state orphan`, whose refusal for one stack can print
 * below an earlier stack's `Destroy with:` row in the same run: there every
 * value takes `plainOrDescribed`, because a padded region inside
 * `displayIdent`'s quotes still wraps into a counterfeit row
 * (go-to-k/cdkd#3760). Elsewhere no labelled row is near, and the candidate
 * list keeps each region's identity.
 */
export function noStateInRegionError(
  stackName: string,
  requestedRegion: string,
  matches: readonly StackStateRef[],
  opts?: { described?: boolean }
): Error {
  const described = opts?.described === true;
  const subject = described
    ? describedStackSubject(stackName)
    : `stack ${displayStackName(stackName)}`;
  const requested = described
    ? plainOrDescribed(requestedRegion, 'region')
    : displayIdent(requestedRegion);
  const candidates = matches.map((r) =>
    r.region === undefined
      ? '(legacy)'
      : described
        ? plainOrDescribed(r.region, 'region')
        : listedRegion(r.region)
  );
  // A described value is not identity: several non-plain candidates read the
  // same, so say where the records can be seen as stored.
  const anyDescribed =
    described &&
    [stackName, requestedRegion, ...matches.flatMap((r) => (r.region ? [r.region] : []))].some(
      (v) => !isPasteableIdent(v)
    );
  return new Error(
    `No state found for ${subject} in region ${requested}. ` +
      `Available regions: ${candidates.join(', ')}.` +
      (anyDescribed ? ` ${stateListPointer()}` : '')
  );
}

/**
 * The stack has records in several regions and no `--stack-region` picked one.
 * The candidate regions are raw S3 key segments from `listStacks()`
 * (go-to-k/cdkd#3027); `remedy` is the caller's own sentence, and spells its
 * placeholder as `commandHole`'s QUOTED hole -- a bare `<region> to` pasted
 * from the sentence reads the file `region` and truncates one named `to`.
 *
 * The remedy goes on its OWN line, as it does after every hostile-name head
 * in this file that names no ` (region)` right after the name: a JSON
 * boundary makes a `'` or a `;` in the name literal but not a `$( )` or a
 * backtick, so a pasted LINE holding both the name and a `--flag` remedy ran
 * the name's substitution beside a command fragment (go-to-k/cdkd#3950). On
 * its own line the name's display residual is all a span can run.
 */
export function multipleRegionsError(
  stackName: string,
  matches: readonly StackStateRef[],
  remedy: string
): Error {
  return new Error(
    `Stack ${displayStackName(stackName)} has state in multiple regions: ` +
      `${matches.map((r) => listedRegion(r.region)).join(', ')}.\n${remedy}`
  );
}

/**
 * Resolve a stack name + optional region flag against the `listStacks` index
 * built up front. When a name resolves to multiple regions and the caller
 * didn't pin one, surface a clear error listing the candidates so the user
 * knows exactly which `--stack-region X` to add.
 */
export function resolveSingleRegion(
  stackName: string,
  refs: StackStateRef[],
  requestedRegion: string | undefined
): StackStateRef {
  const matches = refs.filter((r) => r.stackName === stackName);
  if (matches.length === 0) {
    throw new Error(
      `No state found for stack ${displayStackName(stackName)}.\n` +
        `Run 'cdkd state list' to see available stacks.`
    );
  }
  if (requestedRegion) {
    const ref = matches.find((r) => r.region === requestedRegion);
    if (!ref) throw noStateInRegionError(stackName, requestedRegion, matches);
    return ref;
  }
  if (matches.length === 1) return matches[0]!;
  throw multipleRegionsError(
    stackName,
    matches,
    `Re-run with --stack-region ${commandHole('region')} to disambiguate.`
  );
}
