/**
 * Make an untrusted value safe to render in a terminal or persist into a log.
 *
 * A LEAF module with no imports, and deliberately in `src/utils/` rather than
 * beside its first caller: issue [#2170](https://github.com/go-to-k/cdkd/issues/2170)'s
 * review found the same rule being widened BY HAND one module at a time and
 * missing an instance every round — the change sanitized 1 of 5 readers of
 * `LockInfo.owner`. One shared definition, imported by everything that renders
 * such a value, is what stops the next reader from inheriting nothing.
 *
 * The stripped class is wider than C0 + DEL, which a first cut used and which
 * misses every mechanism that actually forges a line:
 *
 * - `U+0085` (NEL) and the C1 range — xterm reads `U+009B` as CSI in UTF-8;
 * - `U+2028` / `U+2029` — this text is PERSISTED and re-rendered by JSON and
 *   web log viewers, where both are line terminators;
 * - `U+202A`-`U+202E` / `U+2066`-`U+2069` — the Trojan-Source bidi overrides
 *   and isolates, which visually REORDER the command being pasted.
 *
 * Known residual, recorded rather than implied away: the invisible formatters
 * (`U+200B`-`U+200D`, `U+FEFF`) and the bidi MARKS (`U+200E` / `U+200F` /
 * `U+061C`) survive, as do bare RTL letters, which no denylist can reach. All
 * of them can only make a rendered name differ visually from its bytes — the
 * command a user pastes still acts on exactly what is shown, and the blast
 * radius stays the attacker's own stack name.
 *
 * A caller whose value has a KNOWN ASCII charset (a stack name, an AWS region)
 * should pass `asciiOnly`, which is a positive allowlist and therefore has no
 * such residual at all.
 *
 * ONE CALLER DELIBERATELY GOES WIDER, and it is recorded here so an editor of
 * the residual note above knows a second module now disagrees with it.
 * `src/deployment/outputs-export-alias.ts` deletes a class derived from
 * `\p{Cc}` / `\p{Cf}` / `\p{Zl}` / `\p{Zp}` /
 * `\p{Default_Ignorable_Code_Point}`, because on THAT path the subject is a possibly
 * secret-bearing name in an operator's log: a plaintext split by a zero-width
 * character is READ as if it were contiguous, so it is disclosed without any
 * paste, and the command-forgery reasoning above does not transfer (issue
 * [#2874](https://github.com/go-to-k/cdkd/issues/2874)). Nothing here changes
 * -- widening this helper would alter every caller that merely wants a
 * terminal-safe string.
 */
/**
 * The RAW text a value would render as, before any sanitization.
 *
 * Shared by `displaySafe` and `displayIdent` so the two agree on what the input
 * WAS. `displayIdent` needs that to answer "did sanitization change anything?",
 * and answering it by comparing against the caller's `unknown` would be wrong
 * for every non-string: the comparison must be against the STRINGIFIED form,
 * which is what `displaySafe` actually sanitizes.
 *
 * ABSENT means nothing to display, not the WORD -- `displaySafe`'s own comment
 * below carries why, and this is the function that implements it.
 *
 * `String(value)` is NOT total: an object whose `toString` is not callable —
 * `{"toString": null}`, reachable through `JSON.parse` of a hand-edited record
 * (issue #2947) — makes it throw, and a display helper that throws takes the
 * whole render with it. The fallback is `Object.prototype.toString`, which
 * calls none of the object's own methods — it reads only
 * `Symbol.toStringTag`, a key `JSON.parse` cannot produce — so it cannot
 * throw for any JSON-derived value. Every value `String` already handled
 * renders exactly as before; only the throwing ones change.
 */
function toDisplayText(value: unknown): string {
  if (value === undefined || value === null) return '';
  try {
    return String(value);
  } catch {
    // The fallback can throw TOO -- a throwing `Symbol.toStringTag` getter, or
    // a Proxy whose `get` trap throws -- and an escaping exception from a
    // DISPLAY helper takes the whole render with it, which is the failure mode
    // the first fallback was added to prevent. A second `catch` ends the
    // regress: there is no third expression to evaluate.
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return UNRENDERABLE_SOURCE;
    }
  }
}

/**
 * The ONE sanitizing step, shared so `displaySafe` and `displayIdent` cannot
 * drift: `displayIdent` must sanitize the SAME text it compares against, and it
 * can only do that by holding the raw text itself (see its rule 3).
 */
function sanitizeAsciiOnly(text: string): string {
  // Printable ASCII only. Correct for a stack name or an AWS region, both of
  // which have a known charset.
  return text.replace(/[^ -~]/g, ' ').trim();
}

/**
 * What an un-stringifiable value renders as before sanitization. A literal
 * distinct from `UNRENDERABLE` would let the two drift; reusing it means a
 * value that cannot be stringified renders exactly like one sanitization
 * emptied, which is the same statement to a reader.
 */
const UNRENDERABLE_SOURCE = '<unrenderable>';

export function displaySafe(value: unknown, opts?: { asciiOnly?: boolean }): string {
  // ABSENT means nothing to display, not the WORD. `String(undefined)` is
  // `'undefined'` — a truthy string — so a caller keying its
  // "is there anything here?" decision on the result was silently answered
  // "yes" for a lock.json with no `owner`, printing `held by undefined` while
  // certifying that the holder was live. The callers that key a decision on
  // emptiness — the lock summary, and every refusal that falls back to
  // `UNRENDERABLE` — would each need this same rule, so it lives here rather
  // than at each of them. Not all of them do: `ConsoleLogger` concatenates the
  // result and `sameLockIdentity` only compares two of them, and neither is
  // harmed by it.
  const text = toDisplayText(value);
  if (text === '') return '';
  if (opts?.asciiOnly) return sanitizeAsciiOnly(text);
  return text
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
      ' '
    )
    .trim();
}

/**
 * Cut `text` to at most `maxCodePoints` CODE POINTS, never splitting a
 * surrogate pair.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a cut landing between
 * the two halves of an astral character leaves a lone high surrogate at the
 * end — rendered as a replacement character or dropped, depending on the
 * terminal (issue #2947). One helper rather than a fix at each call site: a
 * truncation site adopts the rule by calling it, and go-to-k/cdkd#3018 tracks
 * the one known site that does not yet.
 *
 * `truncated` reports whether anything was actually cut, so a caller marking
 * the cut (`…`) does not mark a value that was exactly the window's length.
 */
export function truncateCodePoints(
  text: string,
  maxCodePoints: number
): { text: string; truncated: boolean } {
  const codePoints = Array.from(text);
  if (codePoints.length <= maxCodePoints) return { text, truncated: false };
  return { text: codePoints.slice(0, maxCodePoints).join(''), truncated: true };
}

/**
 * Stand-in for a value with nothing renderable left after sanitization. Named
 * rather than inlined so two messages cannot disagree about what
 * "unrenderable" looks like.
 *
 * Homed HERE, in the leaf, since issue #3064: it used to live in
 * `src/state/lock-contention-message.ts`, which meant `src/utils/` and
 * `src/types/` could not use it without inverting the layering -- so
 * `formatError` dropped a clause instead, and a `src/types/` parser rendered
 * an unrenderable field as EMPTY, which reads as absent. That file re-exports
 * it, so its existing importers are unchanged.
 */
export const UNRENDERABLE = '<unrenderable>';

/**
 * The DEFAULT longest an identifier this module renders can legitimately be.
 * 255 is CloudFormation's cap on a logical id, the longest of the identifier
 * shapes `displayIdent` sees by default (a resource type is at most
 * `64::64::64::MODULE`, a CloudFormation stack name 128, a region 25, a run id
 * ~40); a longer value is not one of those identifiers, whatever else it is.
 *
 * It is a DEFAULT and not a universal because one caller's identifier is
 * legitimately longer -- see `STACK_REF_MAX_CODE_POINTS`. A caller whose value
 * has a different grammar passes its own `maxCodePoints` rather than widening
 * this one, so the shapes above keep the tightest cap their grammar allows.
 */
export const IDENT_MAX_CODE_POINTS = 255;

/**
 * The cap for a cdkd STATE-RECORD stack name, which is NOT bounded by
 * CloudFormation's 128-character stack-name limit.
 *
 * `NestedStackProvider.deriveChildStackName` mints a child record's name as
 * `${parentStackName}~${nestedLogicalId}` and applies that RECURSIVELY, one `~`
 * segment per nesting level, so the length grows with nesting depth:
 *
 *     128 + 4 * (1 + 255) = 1152
 *
 * -- a 128-character CloudFormation root name plus four `~` + 255-character
 * logical-id segments, reading CloudFormation's five-level nesting quota as
 * root + 4.
 *
 * Why it needs to be past 255 at all: CDK's generated nested-stack logical ids
 * run ~60 characters (`XNestedStackXNestedStackResource<hash>`), so even a
 * 20-character root passes 255 at the fourth level -- and a name cut there
 * prints `[cut: N more characters withheld]` in the middle of a row that
 * `cdkd state list | while read -r ref` consumes. Every LEGITIMATE value under
 * this cap renders byte-identically (a spoofing value still gains quotes --
 * that is rule 3's whole job), and byte-identity on legitimate rows is what
 * makes the boundary rendering safe to adopt at all.
 *
 * TWO THINGS THIS IS NOT, both stated because the first revision of this
 * comment claimed them:
 *
 * 1. It is not an ENFORCED bound. cdkd never calls CloudFormation, and nothing
 *    in `src/` validates stack-name length or nesting depth, so the cap is a
 *    budget rather than a guarantee. It is NOT reachable by nesting deeper: at
 *    CDK's ~60-character generated logical ids even a SIX-level chain is ~494
 *    code points, so depth alone does not approach 1152. What reaches it is
 *    length -- HAND-WRITTEN logical ids near CloudFormation's own 255-character
 *    ceiling, stacked several levels deep. Reading the nesting quota as five
 *    levels BELOW the root would put the figure at 1408. Treat 1152 as CDK
 *    practice with a wide margin, not a proof.
 * 2. It does not keep the genuine trailing annotation on screen. At 255 that
 *    was arguable; at 1152 the `(region)` is many wrapped lines away, and a
 *    terminal WRAPPING a long quoted name can put a visual line that reads
 *    exactly like a genuine row on screen with both quotes scrolled out of
 *    view -- reachable well under either cap, so the raise does not create the
 *    class, but the cap does not close it either. Tracked on
 *    go-to-k/cdkd#3179. What the cap still does is bound the PAYLOAD.
 */
export const STACK_REF_MAX_CODE_POINTS = 128 + 4 * (1 + IDENT_MAX_CODE_POINTS);

/**
 * The shape of a value that renders WITHOUT a visible boundary: the characters
 * a CloudFormation logical id, a resource type (`AWS::S3::Bucket`,
 * `Custom::my-thing_v2@x`), a change type, a stack name -- including the
 * `Parent~Child` name cdkd mints for a nested-stack child -- a region, a
 * `deployments/` run id, an S3 key or a role ARN may contain. No space, no
 * bracket, no quote -- so a value matching it cannot plant a `(type)` /
 * `-- reason` annotation of the surrounding line inside itself. Known
 * residual, cosmetic: an IAM path may legally carry `!#$%&'()*`, so a role ARN
 * with one renders quoted; those characters are exactly the boundary-forging
 * set, so they stay out.
 *
 * `,` STAYS IN THIS SET, and issue #3164's review measured the cost of that.
 * Two callers join rendered values with `', '`, and the separator is split
 * across the value and the formatter -- a name ending in a bare `,` is followed
 * by the formatter's own ` (region)`, so `ProdStack,` renders
 * `ProdStack, (us-east-1)` and a two-target prompt reads as THREE entries
 * against a printed count of two. Removing `,` would close that, and was tried:
 * it regresses a LEGITIMATE value class, because an IAM role name allows
 * `[\w+=,.@-]`, so `arn:aws:iam::…:role/cdkd-deploy+role,x=y` is a real role
 * ARN this module renders and `display-safe.test.ts` pins as an identity shape.
 * Quoting every such ARN to disambiguate a list that does not contain ARNs is
 * the wrong trade, so the joined-list ambiguity is recorded on
 * go-to-k/cdkd#3179 rather than paid for here.
 */
const PLAIN_IDENT = /^[A-Za-z0-9:_@./+=,~-]+$/;

/**
 * Render an untrusted IDENTIFIER -- a journal or S3-key field with a known
 * ASCII charset -- into a message a terminal will show (issues
 * [#3064](https://github.com/go-to-k/cdkd/issues/3064) /
 * [#3092](https://github.com/go-to-k/cdkd/issues/3092)). Three rules, applied
 * in this order:
 *
 * 1. `displaySafe(value, { asciiOnly: true })`, then `UNRENDERABLE` for a value
 *    with nothing renderable left -- the same allowlist + fallback every
 *    caller used to spell for itself.
 * 2. A value longer than `opts.maxCodePoints` (default `IDENT_MAX_CODE_POINTS`)
 *    is CUT there and the count of withheld characters appended, bounding the
 *    PAYLOAD a planted id can put on the line. It does not bound what a
 *    terminal then WRAPS: a long quoted value can still wrap so that a visual
 *    line reads like a genuine row with the quotes off-screen, at either cap.
 *    A caller whose identifier has a LONGER legitimate grammar passes its own
 *    cap -- `STACK_REF_MAX_CODE_POINTS` is the one such caller today -- because
 *    a cut that fires on a LEGITIMATE value breaks the byte-identity that makes
 *    rule 3 safe to adopt at all.
 * 3. A value is rendered as a JSON string literal -- so its BOUNDARY is
 *    visible -- unless BOTH of these hold: sanitization was the IDENTITY on it,
 *    and what is left is a `PLAIN_IDENT`. The allowlist alone cannot stop an
 *    all-ASCII `X (AWS::RDS::DBInstance) -- already reverted` from reading as
 *    cdkd's own annotation inside a real row; quoting it makes the row read
 *    `"X (AWS::RDS::DBInstance) -- already reverted" (AWS::S3::Bucket)`, and
 *    JSON escaping keeps an embedded `"` from faking the closing quote.
 *    Conditional on purpose: every legitimate value survives sanitization
 *    unchanged AND is a plain identifier, so it renders exactly as it always
 *    did -- no fixture, no unit pin and no operator's grep changes, and only a
 *    value that could spoof gains quotes.
 *
 *    THE IDENTITY HALF IS NOT REDUNDANT WITH THE ALLOWLIST, and omitting it was
 *    a live spoof (issue #3164 review): `displaySafe` maps every
 *    non-printable-ASCII character to a space and then TRIMS, so padding is
 *    ERASED before the `PLAIN_IDENT` test ever runs. A planted
 *    `cdkd/ProdStack /us-east-1/state.json` -- one trailing space -- therefore
 *    tested as plain, rendered UNQUOTED, and printed byte-identical to the
 *    genuine `ProdStack` in `us-east-1`; `listStacks` keys its dedupe on
 *    `stackName\0region`, so both refs survive to the output and a
 *    `sort -u`-ing consumer collapses them. Leading space, a tab, a NUL, an ESC
 *    and a padded REGION all did the same with a one-character input. Comparing
 *    against the raw text closes the class at its root rather than per padding
 *    character. `src/state/lock-contention-message.ts` reached the same rule
 *    first, for the same reason.
 *
 * A caller comparing the result against the input (the `--orphan <id>` remedy
 * prints its id only when this function is the identity on it) inherits all
 * three: a quoted, cut or fallback rendering is never pasted as a command
 * argument.
 *
 * NOT for a value that is USED rather than shown (a lookup key, a provider
 * argument), and NOT for free-form text (an SDK error message legitimately
 * carries spaces and non-ASCII; it takes `displaySafe()` directly).
 */
export function displayIdent(value: unknown, opts?: { maxCodePoints?: number }): string {
  // Evaluate the input ONCE. Two calls would read `value.toString()` twice, and
  // a non-deterministic one then re-opens the very spoof rule 3 exists to
  // close: `{ toString: () => n++ === 0 ? 'ProdStack ' : 'ProdStack' }` renders
  // the PADDED text and compares it against the UNPADDED second reading, so
  // `altered` is false and the value goes out bare. Unreachable from today's
  // callers, which pass S3-key strings and `JSON.parse` output -- but a control
  // that a hostile `toString` can switch off is not a control, and this
  // function IS the control.
  const raw = toDisplayText(value);
  if (raw === '') return UNRENDERABLE;
  const clean = sanitizeAsciiOnly(raw);
  if (!clean) return UNRENDERABLE;
  // Floor the caller's cap at 1. `truncateCodePoints` slices, so a negative
  // value would cut from the END and report a nonsense withheld count -- a
  // display helper must not be able to produce that, even though no caller
  // passes one today and the parameter exists only to WIDEN the default.
  const requested = opts?.maxCodePoints ?? IDENT_MAX_CODE_POINTS;
  const cap = Number.isFinite(requested)
    ? Math.max(1, Math.floor(requested))
    : IDENT_MAX_CODE_POINTS;
  const { text, truncated } = truncateCodePoints(clean, cap);
  // Rule 3. `altered` is the half the allowlist cannot supply: sanitization
  // trims, so padding is gone from `clean` and `PLAIN_IDENT` would pass a value
  // that did NOT arrive plain. Compared against `raw` -- the SAME text that was
  // sanitized, read once above -- so neither a non-string nor a
  // non-deterministic `toString` can make the two operands disagree.
  const altered = clean !== raw;
  const shown = !altered && PLAIN_IDENT.test(text) ? text : JSON.stringify(text);
  // `clean` is ASCII here, so `.length` counts characters.
  return truncated
    ? `${shown} [cut: ${clean.length - text.length} more characters withheld]`
    : shown;
}
