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
  if (value === undefined || value === null) return '';
  // `String(value)` is NOT total: an object whose `toString` is not callable —
  // `{"toString": null}`, reachable through `JSON.parse` of a hand-edited record
  // (issue #2947) — makes it throw, and a display helper that throws takes the
  // whole render with it. The fallback is `Object.prototype.toString`, which
  // calls none of the object's own methods — it reads only
  // `Symbol.toStringTag`, a key `JSON.parse` cannot produce — so it cannot
  // throw for any JSON-derived value. Every value `String` already handled
  // renders exactly as before; only the throwing ones change.
  let text: string;
  try {
    text = String(value);
  } catch {
    text = Object.prototype.toString.call(value);
  }
  const stripped = opts?.asciiOnly
    ? // Printable ASCII only. Correct for a stack name or an AWS region, both
      // of which have a known charset.
      text.replace(/[^ -~]/g, ' ')
    : text.replace(
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
        ' '
      );
  return stripped.trim();
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
 * segment per nesting level. CloudFormation allows five levels of nesting, so
 * the longest legitimate name is a 128-character root plus four
 * `~` + 255-character-logical-id segments:
 *
 *     128 + 4 * (1 + 255) = 1152
 *
 * The bound is not theoretical padding. CDK's generated nested-stack logical
 * ids run ~60 characters (`XNestedStackXNestedStackResource<hash>`), so even a
 * 20-character root passes 255 at the fourth level -- and a name cut there
 * would print `[cut: N more characters withheld]` in the middle of a row that
 * `cdkd state list | while read -r ref` consumes, which is a worse outcome than
 * a long line. Every value under this cap renders byte-identically, which is
 * the property the boundary rendering is only safe BECAUSE of.
 *
 * A planted value is still bounded: 1152 is a cap, not its absence.
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
 *    is CUT there and the count of withheld characters appended. Unbounded, a
 *    planted id pushed the line's genuine trailing `(type)` off a narrow
 *    terminal. A caller whose identifier has a LONGER legitimate grammar passes
 *    its own cap -- `STACK_REF_MAX_CODE_POINTS` is the one such caller today --
 *    because a cut that fires on a LEGITIMATE value breaks the byte-identity
 *    that makes rule 3 safe to adopt at all.
 * 3. A value that is NOT a `PLAIN_IDENT` -- one carrying a space, a bracket, a
 *    quote -- is rendered as a JSON string literal, so its BOUNDARY is
 *    visible. The allowlist alone cannot stop an all-ASCII
 *    `X (AWS::RDS::DBInstance) -- already reverted` from reading as cdkd's own
 *    annotation inside a real row; quoting it makes the row read
 *    `"X (AWS::RDS::DBInstance) -- already reverted" (AWS::S3::Bucket)`, and
 *    JSON escaping keeps an embedded `"` from faking the closing quote.
 *    Conditional on purpose: every legitimate value is a plain identifier and
 *    renders exactly as it always did, so no fixture, no unit pin and no
 *    operator's grep changes -- only a value that could spoof gains quotes.
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
  const clean = displaySafe(value, { asciiOnly: true });
  if (!clean) return UNRENDERABLE;
  const { text, truncated } = truncateCodePoints(
    clean,
    opts?.maxCodePoints ?? IDENT_MAX_CODE_POINTS
  );
  const shown = PLAIN_IDENT.test(text) ? text : JSON.stringify(text);
  // `clean` is ASCII here, so `.length` counts characters.
  return truncated
    ? `${shown} [cut: ${clean.length - text.length} more characters withheld]`
    : shown;
}
