/**
 * Make an untrusted value safe to render in a terminal or persist into a log.
 *
 * A LEAF module importing nothing from cdkd (only `node:crypto`, for
 * {@link cutMarker}'s digest), and deliberately in `src/utils/` rather than
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
 * `src/deployment/outputs-export-alias/secret-scan.ts` deletes a class derived from
 * `\p{Cc}` / `\p{Cf}` / `\p{Zl}` / `\p{Zp}` /
 * `\p{Default_Ignorable_Code_Point}`, because on THAT path the subject is a possibly
 * secret-bearing name in an operator's log: a plaintext split by a zero-width
 * character is READ as if it were contiguous, so it is disclosed without any
 * paste, and the command-forgery reasoning above does not transfer (issue
 * [#2874](https://github.com/go-to-k/cdkd/issues/2874)). Nothing here changes
 * -- widening this helper would alter every caller that merely wants a
 * terminal-safe string.
 */

import { createHash } from 'node:crypto';

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
 *
 * `safeStringify` in `aws-failure-text.ts` guards the SAME coercion and is not
 * the same helper: it answers a failed conversion with a sentence rather than
 * `[object Object]`, because its output is a persisted failure reason an
 * operator reads rather than terminal output, and it sanitises nothing. This
 * one stays the answer on any path that RENDERS or LOGS the value.
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
      return UNRENDERABLE;
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
 * A JOINED LIST SANITIZES PER ELEMENT, and the reason is FORMATTING rather than
 * safety. Stated here once because three callers stated it for themselves and
 * one of the three copies had already drifted into a false claim.
 *
 * This function replaces GLOBALLY, so a character in the middle of an element is
 * stripped whether the caller sanitizes each element or the joined string. The
 * two differ only at an element EDGE, where the joined form leaves the
 * replacement space beside the separator: `['A<NEL>', 'B']` renders `A, B` per
 * element and `A , B` joined. Sanitizing per element is what keeps the
 * separator byte-exact.
 *
 * For `displayIdent` the same shape IS load-bearing rather than cosmetic, since
 * the boundary it adds is per value.
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
 * Every code point {@link stringifyJsonPayload} escapes: control (`Cc`), format
 * (`Cf`), line separator and paragraph separator. It is WIDER than the class
 * `displaySafe` strips -- it also takes the invisible formatters and bidi marks
 * that function's note records as a residual -- because escaping loses nothing:
 * a residual there is the cost of REPLACING a byte, and here nothing is
 * replaced. The replacer leaves a raw `\n` alone: `JSON.stringify` escapes
 * all of C0 inside a string, so a raw `\n` in its output is always LAYOUT,
 * outside any string literal.
 */
const JSON_PAYLOAD_ESCAPED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Serialize a `--json` PAYLOAD for stdout (issue go-to-k/cdkd#3163).
 *
 * `JSON.stringify` escapes only C0, `"`, `\` and lone surrogates, so DEL, the
 * C1 range (`U+009B` is a live CSI in xterm's UTF-8 mode), `U+2028` /
 * `U+2029`, the bidi overrides and isolates and the zero-width characters all
 * reach the terminal verbatim when an operator runs the command bare or pipes it
 * into a viewer. This emits each of them as a `\uXXXX` escape instead (an astral
 * one as its surrogate pair).
 *
 * ESCAPING, NOT SANITIZING, because `--json` is a machine contract: the output
 * is still valid JSON and `JSON.parse` returns values IDENTICAL to what
 * `JSON.stringify` alone would have produced, so a consumer matching on a value
 * sees no change. Only the bytes a terminal or log viewer would act on differ.
 * Indentation is `JSON.stringify`'s two spaces, the shape every caller used.
 *
 * Why a post-pass over the text is sound: outside a string literal the output
 * holds only ASCII punctuation, digits, literals, spaces and `\n`, so every
 * matched character sits INSIDE a string, where `\uXXXX` is a valid escape; and
 * an escape `JSON.stringify` wrote is always complete, so a raw character never
 * follows a dangling backslash.
 *
 * POLICY: every `--json` payload cdkd writes to stdout goes through this rather
 * than calling `JSON.stringify` itself -- `cdkd state`, `events`, `diff`,
 * `drift` and `list` (go-to-k/cdkd#4045).
 */
export function stringifyJsonPayload(value: object): string {
  return JSON.stringify(value, null, 2).replace(JSON_PAYLOAD_ESCAPED, (match) => {
    if (match === '\n') return match;
    let out = '';
    for (let i = 0; i < match.length; i++) {
      out += `\\u${match.charCodeAt(i).toString(16).padStart(4, '0')}`;
    }
    return out;
  });
}

/**
 * The escape sequences cdkd itself emits (`src/utils/colors.ts` and the level
 * prefixes in `logger.ts`). An ALLOWLIST: every other CSI is removed whole, so
 * a value carrying cursor movement or a screen clear cannot drive the terminal.
 * A value can still SPELL one of these colours — harmless, and the price of
 * keeping cdkd's own colours on the same line.
 *
 * A foreign SGR becomes a full reset rather than nothing: a coloured CDK-app
 * stderr line (`\x1b[33mwarn\x1b[39m`) would otherwise keep its allowlisted
 * opener and lose its closer, colouring every line after it.
 *
 * An OSC is removed whole only inside ONE value ({@link safeMsg}). On a whole
 * message two raw values can open and close one, deleting cdkd's own text
 * between them, so the sink replaces only its ESC.
 */
// eslint-disable-next-line no-control-regex
const OWN_SGR = /^\x1b\[(?:0|1|2|3[1-6]|90)m$/;
const SGR_RESET = '\x1b[0m';
const CSI = String.raw`\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]`;
const OSC = String.raw`\x1b\][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)`;
const CONTROL_EXCEPT_NEWLINE_AND_TAB = String.raw`[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]`;
const TERMINAL_UNSAFE = new RegExp(`${CSI}|${CONTROL_EXCEPT_NEWLINE_AND_TAB}`, 'g');
/**
 * Every CHARACTER {@link safeMsg} acts on in an interpolated value (a CSI or
 * an OSC starts with one of them, ESC or C1 CSI): the sink's denylist plus
 * newline and tab. Exported so a caller that must show such a value some
 * other way — `cdkd drift`'s `reportValue` quotes it — decides from this set
 * rather than a copy of it that a widened denylist here would leave behind.
 * Not global, so `.test` carries no `lastIndex` between calls.
 */
export const SAFE_MSG_ALTERED_CHAR = new RegExp(`${CONTROL_EXCEPT_NEWLINE_AND_TAB}|[\\t\\n]`);
const TERMINAL_UNSAFE_OR_LINE_BREAK = new RegExp(
  `${CSI}|${OSC}|${CONTROL_EXCEPT_NEWLINE_AND_TAB}|[\\t\\n]`,
  'g'
);

function replaceUnsafe(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => {
    if (match.length === 1) return ' ';
    if (OWN_SGR.test(match)) return match;
    // Only a CSI ends in `m`; an OSC ends in its terminator.
    return match.endsWith('m') ? SGR_RESET : '';
  });
}

/**
 * The SINK rule `ConsoleLogger` applies to every message it prints: the
 * `displaySafe` denylist minus newline and tab, and minus cdkd's own colours.
 *
 * It cannot tell cdkd's newline from one a value carried in, so it stops the
 * terminal-control class for every log line but not line forging; that half
 * needs the value marked at the call site, which is what {@link safeMsg} is.
 */
export function terminalSafe(text: string): string {
  return replaceUnsafe(text, TERMINAL_UNSAFE);
}

/**
 * Tagged template for a log or error message: the literal parts are cdkd's
 * own and render verbatim (newlines included), every interpolated value is
 * flattened to one line. A value cannot then forge a row, however many
 * newlines the template itself uses.
 *
 * No trim, unlike `displaySafe`: a message's spacing is the template's, and a
 * value's own padding is visible text rather than a boundary question. A value
 * whose BOUNDARY matters (an identifier beside cdkd's annotation) still goes
 * through `displayIdent` first.
 */
export function safeMsg(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    out += replaceUnsafe(toDisplayText(value), TERMINAL_UNSAFE_OR_LINE_BREAK) + strings[i + 1];
  });
  return out;
}

/**
 * Cut `text` to at most `maxCodePoints` CODE POINTS, never splitting a
 * surrogate pair.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a cut landing between
 * the two halves of an astral character leaves a lone high surrogate at the
 * end — rendered as a replacement character or dropped, depending on the
 * terminal (issue #2947). One helper rather than a fix at each call site: a
 * truncation site adopts the rule by calling it. go-to-k/cdkd#3018 tracked
 * `describeOverlayValueShape` in `src/cli/commands/export.ts`, which now does.
 *
 * ADOPTION, not coverage — and the distinction is the whole reason this note
 * no longer counts sites. Other `slice`-based display truncations exist
 * (`src/local/websocket-server.ts`, several message caps in
 * `src/deployment/intrinsic-resolver/*.ts`), and
 * nothing here or in CI stops another being written. An earlier revision named
 * a remaining count; a count is exactly what goes stale unwatched, so what is
 * stated is the RULE and where it is owned.
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
 *    class, but the cap does not close it either (go-to-k/cdkd#3179). Beside a
 *    labelled pasteable line the answer is to not print a non-plain value at
 *    all (`plainOrDescribed`, go-to-k/cdkd#3760). What the cap still does is
 *    bound the PAYLOAD.
 *
 * Its second GRAMMAR (it already has several call sites) is a Stage's path
 * (`renderStagePath` in `src/synthesis/failed-stages.ts`), a different
 * grammar reusing this cap
 * deliberately: a hierarchical construct path nests without a fixed bound in
 * the same way, and both need "a legitimate value is longer than 255". Named
 * here rather than given its own constant so a retune for one is a decision
 * about the other — which is the whole point of the rule above.
 */
export const STACK_REF_MAX_CODE_POINTS = 128 + 4 * (1 + IDENT_MAX_CODE_POINTS);

/**
 * The cap for an IAM ROLE ARN, which the 255 default TRUNCATES while still
 * legal.
 *
 * AWS bounds a role PATH at 512 characters and a role NAME at 64, on top of the
 * `arn:<partition>:iam::<12-digit account>:role` prefix -- so a perfectly valid
 * ARN reaches ~612 and `displayIdent`'s default would render
 * `[cut: N more characters withheld, ...]` inside the very message that says WHICH
 * role failed to assume (go-to-k/cdkd#3390 round 3). Cutting the identifier out
 * of the sentence whose only job is to identify it is the failure this constant
 * exists to avoid, and it is the same argument `STACK_REF_MAX_CODE_POINTS`
 * makes for a nested-stack child's name.
 *
 * Derived rather than rounded, so the arithmetic is auditable: the longest
 * partition cdkd knows is `aws-us-gov` (10), and the fixed segments are
 * `arn:` + `:iam::` + 12 + `:role` = 27.
 *
 * It read `aws-iso-e` (9) until go-to-k/cdkd#3397's review, which is one short
 * and wrong by inspection of `PARTITION_TABLE` in `src/utils/aws-partition.ts`
 * -- `aws-us-gov` is in that table and is a character longer. The consequence
 * was the exact failure this constant exists to prevent, on exactly one input:
 * a maximal GovCloud role ARN (613 code points) rendered
 * `[cut: 1 more characters withheld]`. Counting the longest entry of the table
 * rather than naming one is what would have avoided it, but the table is in a
 * module this leaf must not import, so the number stays transcribed -- and
 * `tests/unit/utils/display-safe-role-arn-cap.test.ts` now derives the maximum
 * from `PARTITION_TABLE` and fails if this falls behind it again.
 *
 * It bounds the PAYLOAD, which is all a cap can do -- the wrapping caveat on
 * `STACK_REF_MAX_CODE_POINTS` applies here unchanged.
 */
export const ROLE_ARN_MAX_CODE_POINTS = 27 + 10 + 512 + 64;

/**
 * The cap for a SECRET REFERENCE -- an ECS task definition's `ValueFrom`, the
 * Secrets Manager ARN it classifies to, or the SSM parameter name.
 *
 * A separate constant from {@link ROLE_ARN_MAX_CODE_POINTS} because the grammar
 * is genuinely different and the role figure is too small: an SSM parameter NAME
 * runs to 1011 characters on its own, and AWS caps an ARN at 2048. Rendering
 * `[cut: N more characters withheld, ...]` in the message that says WHICH secret
 * failed to resolve is the failure both constants exist to avoid
 * (go-to-k/cdkd#3390 round 4).
 *
 * 2048 is AWS's documented ARN ceiling, which bounds every shape this cap
 * serves -- the ARN forms by definition, and the bare parameter name by being
 * shorter than the ARN containing it.
 */
export const SECRET_REF_MAX_CODE_POINTS = 2048;

/**
 * The cap for AWS's OWN error text when it is rendered beside a sanitized
 * identifier (issue go-to-k/cdkd#3397 review).
 *
 * `displaySafe` takes no `maxCodePoints` — it is the free-form-text helper and
 * its output is normally an SDK sentence of bounded length. That stops being
 * true wherever AWS ECHOES A SUBMITTED VALUE VERBATIM, which is the class this
 * constant serves: the message's length is then chosen by whoever supplied the
 * value. It started with STS and IAM quoting a `RoleArn` back — those sites
 * sanitize the ARN with `ROLE_ARN_MAX_CODE_POINTS` and then print AWS's reply
 * next to it, where an oversized input returned UNBOUNDED past the cap the ARN
 * itself just paid, the guard defeated by its own neighbour in the length
 * dimension rather than the charset one — and has since taken CloudFormation's
 * `StatusReason` and a context provider's failure text, both of which quote a
 * TEMPLATE-supplied value back. `grep displayAwsMessage` answers the population;
 * a count here would only go stale, as this sentence's did.
 *
 * Deliberately generous. The message is the DIAGNOSIS, so cutting it costs the
 * user the answer; this is a flood stop, not a formatting rule. A genuine AWS
 * error is far below it — the value only bites on a message carrying an echoed
 * payload, which is exactly the case that should be cut.
 */
export const AWS_MESSAGE_MAX_CODE_POINTS = 4096;

/**
 * AWS's own error text, sanitized AND bounded, with the cut MARKED.
 *
 * One helper rather than the expression spelled at each site, for the reason
 * `displayIdent`'s own truncation gives: a reader has to be able to tell a
 * message that ENDED from one that was CUT. `truncateCodePoints` reports
 * `truncated`, and round 2 of go-to-k/cdkd#3408 found both call sites taking
 * `.text` and discarding it, so a bounded message ended mid-sentence looking
 * complete — which on a diagnostic is worse than the flood it prevents, since
 * the reader acts on a sentence whose second half is missing.
 *
 * The marker is {@link cutMarker}'s, so the two cannot teach a reader two
 * different things about the same event — WITHOUT the tail digest, which is
 * for an identity (see there).
 */
export function displayAwsMessage(value: unknown): string {
  const sanitized = displaySafe(value);
  const { text, truncated } = truncateCodePoints(sanitized, AWS_MESSAGE_MAX_CODE_POINTS);
  if (!truncated) return text;
  const withheld = Array.from(sanitized).length - Array.from(text).length;
  return `${text} ${cutMarker(withheld)}`;
}

/**
 * How many hex characters of the tail's SHA-256 {@link cutMarker} prints: 128
 * bits. The two values it separates are BOTH planted — no legitimate value
 * reaches an identifier cap — so the property needed is collision resistance
 * against a party choosing both inputs, and a birthday search on a short
 * prefix is cheap (8 hex characters falls to about 2^16 tries).
 */
const CUT_DIGEST_HEX_CHARS = 32;

/**
 * The ONE spelling of the marker a display cap appends where it cut a value:
 * `[cut: N more characters withheld]`, with no leading space (the caller
 * separates it from the kept text).
 *
 * `digestOf` is the WITHHELD TAIL, and passing it appends
 * `, tail sha256:<hex>` (go-to-k/cdkd#4002). Without it, two values sharing
 * the kept prefix and their length rendered byte-identically — the collapse
 * go-to-k/cdkd#3164 closed below the cap, reopened above it. The digest names
 * the tail without showing any of it.
 *
 * Pass it ONLY where the rendering serves as an IDENTITY (`displayIdent` and
 * `export.ts`'s record-value renderer), over text that either has ALREADY
 * been through whatever masking its site applies or is an identifier that
 * holds no secret. A message-level masker running DOWNSTREAM of the render
 * (`maskSecretsInError`, the logger's whole-line mask) never sees the tail:
 * the digest is a CONFIRM and brute-force ORACLE over whatever reaches it
 * unmasked (a secret under the needle floor, a derived spelling a mask missed)
 * — the concern go-to-k/cdkd#3729 records for a salted hash beside a mask.
 * That is accepted only because every digesting site renders an identifier,
 * or masks before the cut (or replaces the whole rendered token, as
 * `stack-output.ts` does), and no legitimate value reaches an identifier cap.
 * Free-form text — AWS's error messages, which can echo a submitted payload a
 * BOUNDED masker missed — takes the bare marker:
 * two messages rendering alike spoof no identity, so the digest would buy
 * nothing there.
 *
 * `digestOf` must be ASCII or otherwise free of lone surrogates: hashing
 * encodes it as UTF-8, which maps each one to U+FFFD.
 */
export function cutMarker(withheld: number, digestOf?: string): string {
  const digest =
    digestOf === undefined
      ? ''
      : `, tail sha256:${createHash('sha256').update(digestOf).digest('hex').slice(0, CUT_DIGEST_HEX_CHARS)}`;
  return `[cut: ${withheld} more characters withheld${digest}]`;
}

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
 * `,` STAYS IN THIS SET. Removing it was tried and regresses a LEGITIMATE
 * value class: an IAM role name allows `[\w+=,.@-]`, so
 * `arn:aws:iam::…:role/cdkd-deploy+role,x=y` is a real role ARN this module
 * renders and `display-safe.test.ts` pins as an identity shape. A bare `,` is
 * a boundary character only where cdkd JOINS values with `', '` — there
 * `ProdStack,` beside the formatter's own ` (region)` reads as an extra entry —
 * so the fix sits at the JOIN: `displayIdent`'s `listMember` option
 * (go-to-k/cdkd#3179).
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
 *    is CUT there and {@link cutMarker} appended with the count of withheld
 *    characters and a digest of them, bounding the PAYLOAD a planted id can
 *    put on the line while two cut values sharing the kept prefix and length
 *    still render apart. It does not bound what a
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
 *    genuine `ProdStack` in `us-east-1`; `listStacks` keys its dedupe on the
 *    `(stackName, region)` PAIR — injectively since go-to-k/cdkd#3323, by a
 *    separator before it — so both refs survive to the output and a
 *    `sort -u`-ing consumer collapses them. What matters to THIS note is only
 *    that the two refs are distinct to the dedupe and identical once printed,
 *    which is as true of the encoded key as it was of the separated one.
 *    Leading space, a tab, a NUL, an ESC
 *    and a padded REGION all did the same with a one-character input. Comparing
 *    against the raw text closes the class at its root rather than per padding
 *    character. `src/state/lock-contention-message.ts` reached the same rule
 *    first, for the same reason.
 *
 * `listMember` is for a value cdkd joins into a `', '`-separated list: a bare
 * `,` then reads as a separator, so a value carrying one takes the boundary
 * too. Off by default because a role ARN legitimately carries one (see
 * `PLAIN_IDENT`); no stack name or region does, so a legitimate list member
 * still renders byte-identically.
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
export function displayIdent(
  value: unknown,
  opts?: { maxCodePoints?: number; listMember?: boolean }
): string {
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
  // Floor the caller's cap at 1, and fall back to the default for a non-finite
  // one. Stated precisely, because the first revision of this comment guessed:
  // `truncateCodePoints` slices, so a cap at or below `-length` yields the
  // EMPTY string and the value collapses to `""` (the withheld count stays
  // accurate throughout -- that part was never wrong). `Math.floor` matters
  // only for `0 < cap < 1`, where an unfloored `slice(0, 0.5)` is also empty.
  //
  // `Infinity` deliberately takes the DEFAULT rather than meaning "no cap": a
  // caller asking for no cap gets 255 and a cut, which is the opposite of the
  // intent -- recorded rather than silently reinterpreted, since no caller
  // passes one and guessing which way they meant it is how a display helper
  // acquires a second contract.
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
  const plain = PLAIN_IDENT.test(text) && !(opts?.listMember === true && text.includes(','));
  const shown = !altered && plain ? text : JSON.stringify(text);
  // `clean` is ASCII here, so `.length` counts characters, and `text` is its
  // prefix, so the slice is exactly the withheld tail.
  return truncated
    ? `${shown} ${cutMarker(clean.length - text.length, clean.slice(text.length))}`
    : shown;
}

/**
 * {@link displayIdent} for a STACK NAME or a construct path: the same rule, with
 * the cap a nested `Parent~Child~Grandchild` name or a Stage path legitimately
 * needs ({@link STACK_REF_MAX_CODE_POINTS}). The caller writes NO quotes around
 * the result, since `displayIdent` supplies its own boundary for any value that
 * needs one (go-to-k/cdkd#3617).
 */
export function displayStackName(value: unknown): string {
  return displayIdent(value, { maxCodePoints: STACK_REF_MAX_CODE_POINTS });
}

/**
 * `value` when it is a plain identifier (no whitespace, and {@link displayIdent}
 * renders it unchanged), `description` otherwise. For a record value printed
 * BARE beside cdkd's own clauses, where a space-carrying value reads as one of
 * them: a `lock.json` owner `x (operation: deploy), expired 3h ago` made a live
 * lock read as expired. Wider than `isPasteableIdent`, which refuses the `@`
 * and `:` a genuine `user@host:pid` owner carries. Whitespace is refused first
 * so that `displayIdent`'s own cut output is refused without resting on the
 * cut marker's tail digest, which is what makes the round-trip alone refuse it
 * (go-to-k/cdkd#4109, go-to-k/cdkd#4115, go-to-k/cdkd#4002).
 */
export function plainIdentOr(
  value: string,
  description: string,
  opts?: { maxCodePoints?: number }
): string {
  return isPlainIdent(value, opts) ? value : description;
}

/**
 * The predicate {@link plainIdentOr} answers with: no whitespace, and
 * {@link displayIdent} renders the value unchanged under the caller's cap.
 * One spelling, so a caller needing a wider cap (an ARN, at
 * `SECRET_REF_MAX_CODE_POINTS`) passes it here instead of re-spelling the test
 * (go-to-k/cdkd#4226).
 */
export function isPlainIdent(value: string, opts?: { maxCodePoints?: number }): boolean {
  return !/\s/.test(value) && displayIdent(value, opts) === value;
}

/**
 * The shape a state-key segment must have before it may be interpolated into a
 * command cdkd invites an operator to PASTE.
 *
 * An ALLOW-LIST, and deliberately so: the first cut of this predicate was a
 * deny-list that refused a leading `-`, and review defeated it with a leading
 * `~`. A deny-list has to enumerate every character a shell treats specially
 * BEFORE cdkd sees the word, and the set of things nobody thought of is
 * unbounded. The repo already settled this once — `rollback-executor/messages.ts`'s
 * `PASTEABLE_LOGICAL_ID` is `/^[A-Za-z0-9]{1,255}$/`, with a comment naming
 * `~user` and `=x` by name.
 *
 * This one is wider than that because the values here are not logical ids: a
 * cdkd state record's stack name carries `~` (a nested-stack child is minted
 * `${parent}~${logicalId}`) and a region carries `-`. What it keeps from the
 * precedent is the LEADING character, which is where the danger is. MEASURED
 * in bash on a real host rather than reasoned:
 *
 *     ~root        -> /var/root        ~/x  -> $HOME/x       ~-  -> $OLDPWD
 *     a=~/x        -> a=$HOME/x
 *     Parent~Child -> inert            a:~/x -> inert
 *
 * So `~` is dangerous only in the leading position or straight after `=`,
 * which is why a medial `~` stays in the set and `=` stays out of it entirely.
 * A leading digit or letter also closes the option case: `--state-bucket=x`
 * cannot match, and that one is NOT about shell quoting — it is still an
 * OPTION after quoting, which is why the answer is refusal rather than quoting.
 */
const PASTEABLE_STATE_IDENT = /^[A-Za-z0-9][A-Za-z0-9~_.-]*$/;

/**
 * Is this value safe to interpolate into a command we tell an operator to RUN?
 *
 * Two independent tests, and BOTH are load-bearing:
 *
 * 1. {@link PASTEABLE_STATE_IDENT}, which decides the shell question — see its
 *    own note for why it is an allow-list and what was measured.
 * 2. It renders byte-identically through `displayIdent`, which adds the LENGTH
 *    cap and the ASCII rule the regex does not carry, asked through the public
 *    API rather than by re-spelling `PLAIN_IDENT` (a second spelling of a
 *    security predicate is how the two drift).
 *
 * Deliberately NOT shell-quoting instead. Quoting answers test 2's population
 * and none of the option case — `'--state-bucket=attacker'` is still parsed as
 * a flag — and a command that LOOKS runnable is the thing being handed over, so
 * the honest answer for a value failing either test is to print the S3 key and
 * let the operator decide.
 */
export function isPasteableIdent(value: string): boolean {
  if (!PASTEABLE_STATE_IDENT.test(value)) return false;
  return displayIdent(value, { maxCodePoints: STACK_REF_MAX_CODE_POINTS }) === value;
}
