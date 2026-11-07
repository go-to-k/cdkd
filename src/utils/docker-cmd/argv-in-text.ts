import { inspect } from 'node:util';
import {
  ARGV_VALUE_TOKEN_RE,
  REDACTED_ARGV_VALUE,
  redactDockerArgvValues,
} from './argv-redaction.js';

/**
 * Masking docker argv values inside an error TEXT. Part of the `docker-cmd.ts`
 * split (go-to-k/cdkd#5835); import from `../docker-cmd.js`, not from here.
 */

/**
 * Redact argv-borne values inside an error TEXT before it reaches the user.
 *
 * **Wrap EVERY `execFile`-derived docker failure text in this**, including one
 * whose argv carries no user data today — `execFile` puts the WHOLE command
 * line into `err.message` (`Command failed: <file> <args joined by ' '>\n<stderr>`,
 * measured on Node 24), so any argv that later gains a `-e` pair starts leaking
 * with no edit to the error site. That silent-gap shape is exactly what
 * [#2440](https://github.com/go-to-k/cdkd/issues/2440) reported: the debug log
 * one screen earlier redacted the same argv and the error path did not.
 *
 * Two passes, both structural (positional), never value-based — matching on a
 * secret's VALUE would also blank an unrelated string that happens to equal it:
 *
 * 1. **Exact command-line substitution** (only when `args` is given). The raw
 *    `args.join(' ')` is replaced by {@link redactDockerArgvValues}' rendering
 *    of the same array. This is the pass that matters, because it is the only
 *    one that can mask a value CONTAINING WHITESPACE (`-e CFG={"a": 1}`), which
 *    no token scan of a space-joined string can delimit.
 * 2. **Token scan** ({@link ARGV_VALUE_TOKEN_RE}) over the result. Catches an
 *    argv echoed in a shape pass 1 cannot see — a future Node message format,
 *    a docker stderr quoting the flag back, or a call site with no `args` to
 *    hand. Deliberately fail-loud rather than fail-open: a `-e X=y` occurring
 *    in unrelated stderr prose loses its value and keeps its key.
 *
 * Idempotent (`-e KEY=***` re-masks to itself), so double-wrapping is safe.
 *
 * **Call sites should use a composer** ({@link describeDockerFailure} and its
 * siblings) rather than this function: the composers take a REQUIRED `args`,
 * which is what makes the redaction impossible to forget. This is the
 * primitive they are built from, exported so the four passes can be tested
 * against Node's real message shapes directly — it has no other caller in
 * `src/`, and that is deliberate rather than an oversight.
 */
export function redactDockerArgvInText(text: string, args?: readonly string[]): string {
  let out = text;
  if (args && args.length > 0) {
    const maskedArgs = redactDockerArgvValues(args);
    const raw = args.join(' ');
    const masked = maskedArgs.join(' ');
    if (masked !== raw) out = out.split(raw).join(masked);
    // Pass 1b — per-TOKEN, for a message that quotes ONE argv element instead
    // of the joined command line. Node does exactly that when it refuses to
    // spawn at all: a NUL anywhere in an argv element rejects with a
    // TypeError and no joined command line for pass 1, no `-e ` prefix for
    // pass 2. MEASURED on Node 24.19.0 (`scripts`-free probe, this repo,
    // 2026-09-05):
    //
    //   The argument 'args[3]' must be a string without null bytes.
    //   Received 'K=abc\x00SUPERSECRET'
    //
    // Note the `\x00`: Node ESCAPES the control character, so the needle has
    // to be the escaped rendering as well as the raw one. The first cut
    // substituted only the raw token and left the value fully exposed — its
    // unit fixture had been built by interpolating the raw argv element, a
    // shape Node never emits, so the test passed for the wrong reason.
    //
    // The needle is the whole `KEY=VALUE` token cdkd itself built, not the
    // secret's value alone, so this stays a structural match: an unrelated
    // literal would have to reproduce the key too.
    for (let i = 0; i < args.length; i++) {
      const rawArg = args[i]!;
      const maskedArg = maskedArgs[i]!;
      if (maskedArg === rawArg) continue;
      if (!isSubstitutableToken(rawArg)) continue;
      out = out.split(rawArg).join(maskedArg);
      const escapedRaw = nodeQuotedRendering(rawArg);
      const escapedMasked = nodeQuotedRendering(maskedArg);
      if (escapedRaw !== undefined && escapedMasked !== undefined && escapedRaw !== rawArg) {
        out = out.split(escapedRaw).join(escapedMasked);
      }
    }
    out = repairSpawnRefusal(out, args, maskedArgs);
  }
  return out.replace(
    ARGV_VALUE_TOKEN_RE,
    (_match, lead: string, flag: string, gap: string, key: string) =>
      `${lead}${flag}${gap}${key}=${REDACTED_ARGV_VALUE}`
  );
}

/**
 * Shortest VALUE that pass 1b will substitute as a bare token.
 *
 * Pass 1b's needle is the whole `KEY=VALUE` element, and it is replaced
 * EVERYWHERE in the text — so a tiny needle is a liability rather than a
 * protection. The empty-key case makes that concrete: a non-sensitive
 * `{ Name: '', Value: '1' }` produces the two-character token `=1`, and
 * substituting that rewrites every `=1` in the message (`--cpus=1`,
 * `status=1`, a path segment). Below this floor the value is not worth
 * protecting by substring match, and passes 1 and 3 still cover it in the
 * message shapes that carry a `-e ` prefix or the joined command line.
 */
const MIN_SUBSTITUTABLE_VALUE_LENGTH = 4;

/** Is this `KEY=VALUE` element long enough to substitute as a bare token? */
function isSubstitutableToken(arg: string): boolean {
  const eqIdx = arg.indexOf('=');
  if (eqIdx < 0) return false;
  return arg.length - eqIdx - 1 >= MIN_SUBSTITUTABLE_VALUE_LENGTH;
}

/**
 * Render `value` the way Node renders an argv element it quotes back at you —
 * i.e. with the SAME function Node used, `util.inspect`, minus the quote
 * characters it chose.
 *
 * This started as a hand-rolled `\xNN` escaper and it was WRONG for 16 of the
 * first 128 code points. Measured against real `execFile` rejections on Node
 * 24.19.0 (this repo, 2026-09-05): hand-rolled matched 4 of 13 cases,
 * `inspect` matched 13 of 13.
 *
 *   input        Node emits          hand-rolled built
 *   LF           `K=a\nb\x00S`        `K=a\x0ab\x00S`   (Node uses a short escape)
 *   DEL          `K=a\x7Fb\x00S`      `K=a\x7fb\x00S`   (Node uses UPPERCASE hex)
 *   backslash    `K=a\\b\x00S`        `K=a\b\x00S`     (not escaped at all)
 *
 * Every miss printed the whole secret. The trigger for this path is a NUL in
 * a value — binary-ish data, which almost always carries a second control
 * byte or a backslash — so the table missed the REALISTIC case and hit only
 * the synthetic NUL-alone one its own fixture happened to use.
 *
 * `slice(1, -1)` is safe across the quote Node picks: `inspect` switches
 * between `'`, `"` and a backtick depending on content and escapes whichever
 * it chose; because this is the same call Node made, the rendering matches
 * whatever it picked (verified for a value containing a single quote, a
 * double quote, both, and a backtick).
 *
 * The general lesson, and why this is no longer a table: do not re-implement
 * another program's formatter — call it.
 */
function nodeQuotedRendering(value: string): string | undefined {
  const rendered = inspect(value);
  // `inspect` does not always produce a single quoted token: past
  // `breakLength` with a newline in the value it emits CONCATENATED CHUNKS
  // (`'a\n' +\n  'b'`), and past `maxStringLength` it appends
  // `... N more characters`. `slice(1, -1)` on either yields a needle that is
  // a substring of nothing — harmless, but it would make this function
  // quietly useless exactly where the value is long enough to matter. Say so
  // instead: `repairSpawnRefusal` handles those shapes by INDEX, needing no
  // needle at all.
  const quote = rendered[0];
  if (quote === undefined || !`'"\``.includes(quote)) return undefined;
  if (rendered.length < 2 || !rendered.endsWith(quote)) return undefined;
  const inner = rendered.slice(1, -1);
  return inner.includes(`${quote} +`) ? undefined : inner;
}

/**
 * Node's refusal to spawn, which QUOTES ONE argv element and names its INDEX:
 *
 *   The argument 'args[2]' must be a string without null bytes. Received '…'
 *
 * The one message shape where the index tells us exactly which of OUR args is
 * being echoed — so the clause can be REWRITTEN from cdkd's own copy of the
 * element rather than searched for. That matters because Node does not print
 * the element whole: it truncates near 200 characters and renders a
 * newline-bearing value as concatenated chunks, so no needle can match it.
 *
 * Global, and scanned to exhaustion rather than bailing on the first match.
 * Anchoring at `^` was an earlier attempt at forgery resistance and it was
 * WORSE: it made a refusal anywhere but position 0 unrepairable, which is a
 * LEAK, and a leak beats a truncated message every time. Pinning Node's
 * literal prefix keeps the forgery bar high without that trade.
 *
 * Pinning the wording has its own cost: if Node rewords the message the repair
 * silently stops firing. That is why `tests/unit/utils/docker-cmd.test.ts`
 * drives this path from a REAL rejection — a reword turns CI red instead of
 * turning the redaction off.
 */
const SPAWN_REFUSAL_RE = /The argument 'args\[(\d+)\]'[^']*?Received /g;

/**
 * The quoted element Node prints after `Received `.
 *
 * Three shapes, and the third is the one that matters. `inspect` renders a
 * newline-bearing value as chunks joined by ` +`, and Node then SLICES the
 * whole rendering at 128 characters and appends `...` — so the last chunk is
 * usually UNTERMINATED:
 *
 *   Received 'DB_URL=AAA…\n' +
 *     'hunter2SECRETCCC...
 *
 * A pattern that only accepts complete chunks stops after the second `'` and
 * leaves that tail in place. Measured on a real rejection: 272 of 288 probe
 * shapes leaked the secret verbatim, and the end-of-string version this
 * replaced did not — the bound was a regression, not a hardening, until the
 * trailing open chunk was admitted.
 *
 * The separator is Node's own (` +\n  `) with HORIZONTAL space only, and an
 * open chunk runs to end of LINE. Both are deliberate: `\s*\+\s*` and an
 * unbounded tail let a crafted value swallow the diagnostic lines that follow
 * the clause.
 */
const QUOTED_CHUNK = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\`(?:[^\`\\\n]|\\.)*\``;
/** An opening quote whose closing one was truncated away; bounded to its line. */
const OPEN_CHUNK = String.raw`['"\`](?:[^\\\n]|\\.)*`;
/** Node's chunk join: horizontal space, `+`, at most one newline, horizontal space. */
const CHUNK_SEPARATOR = String.raw`[^\S\n]*\+[^\S\n]*\n?[^\S\n]*`;
const QUOTED_ELEMENT_RE = new RegExp(
  `^(?:(?:${QUOTED_CHUNK})(?:${CHUNK_SEPARATOR}(?:${QUOTED_CHUNK}))*` +
    `(?:${CHUNK_SEPARATOR}(?:${OPEN_CHUNK}))?|(?:${OPEN_CHUNK}))`
);

/**
 * Replace the quoted argv element in a spawn-refusal message with the masked
 * rendering of the arg its OWN index names.
 *
 * Known cosmetic effect: the replacement prints the FULL key where Node had
 * truncated, so a pathologically long env-var NAME makes the message longer
 * than Node's ~200 characters. Keys are not secret, and the width is not worth
 * a second truncation rule with its own edge cases.
 */
function repairSpawnRefusal(
  text: string,
  args: readonly string[],
  maskedArgs: readonly string[]
): string {
  // A fresh regex per call: the shared one is global, so its `lastIndex`
  // would make a second call on the same text start midway.
  const scanner = new RegExp(SPAWN_REFUSAL_RE.source, 'g');
  let out = '';
  let cursor = 0;
  for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) {
    // Every clause is repaired, not just the first. Returning after one left a
    // SECOND refusal in the same text leaking whole — and the loop was already
    // written to skip clauses it could not resolve, so stopping at the first
    // one it COULD was the odd case out.
    if (match.index < cursor) continue;
    const index = Number(match[1]);
    const rawArg = args[index];
    const maskedArg = maskedArgs[index];
    // A resolvable, NON value-bearing element is left alone: rewriting it
    // would replace the truncated prefix Node printed with the FULL value.
    if (rawArg !== undefined && maskedArg === rawArg) continue;
    const clauseEnd = match.index + match[0].length;
    const quoted = QUOTED_ELEMENT_RE.exec(text.slice(clauseEnd));
    // Node ALWAYS quotes after `Received `, so no match means this clause is
    // not Node's — a forged lookalike in an env KEY (which survives redaction
    // by design) reaches here with no NUL involved. Skipping it is what stops
    // the repair from becoming a diagnostic-destruction primitive: an earlier
    // version deleted to end-of-string here, and a crafted key erased both
    // real docker error lines.
    if (quoted === null) continue;
    // Fail CLOSED on an index that does not resolve (forged or out of range):
    // the clause matched Node's own wording, so something is quoting an argv
    // element and we cannot say which. Leaving it would keep it verbatim.
    const replacement = maskedArg === undefined ? `'${REDACTED_ARGV_VALUE}'` : inspect(maskedArg);
    out += text.slice(cursor, clauseEnd) + replacement;
    cursor = clauseEnd + quoted[0].length;
    scanner.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}
