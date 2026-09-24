/**
 * Pasteable-command SHAPE critic (issue
 * [#3436](https://github.com/go-to-k/cdkd/issues/3436)).
 *
 * WHAT THIS CHECKS
 * ----------------
 * A `cdkd ...` command cdkd tells an operator to PASTE is a shell-injection
 * surface when it is printed inside a prose `'...'` span, because the operator
 * selects the span WITH its quotes. go-to-k/cdkd#3363 measured it: a value
 * carrying `'` inverts the wrapper, and
 * `'cdkd state orphan S --state-bucket 'b; printf X; #''` ran `printf X`. The
 * maintainer reproduced it over 324 arms.
 *
 * go-to-k/cdkd#3499 gave the repo `pasteableCommand`, which gates each value
 * and prints the command LAST and UNWRAPPED on a labelled line. That closed the
 * sites it converted. It does NOT stop the next one being written, and a
 * per-predicate grep cannot find them all — measured on go-to-k/cdkd#3436's
 * record, where `gc.ts` builds a real pasteable `cdkd state show` behind its
 * own gate and is returned by NEITHER of that record's two greps: no
 * `pasteableCommand` call, and no ` with: ` label. **A fence keys on the SHAPE
 * and does not need to know what anyone named the gate**, which is why this
 * exists rather than a third grep.
 *
 * THREE SHAPES, each measured on its own representative
 * -----------------------------------------------------
 * **A — `quoted-command`.** A single-quoted span that holds a `cdkd` verb AND
 * an interpolation. This is go-to-k/cdkd#3363's measured instance. Sanitizing
 * the value does not close it (`displaySafe` keeps `'`), and neither does
 * `displayIdent`, whose JSON quotes escape `'` for JSON and not for the
 * surrounding shell wrapper.
 *
 * **B — `quoted-interpolation`.** A single-quoted span whose content is
 * nothing but interpolations and separators — `` `'${command} ${t}'` `` is
 * `destroy-runner.ts`'s pre-go-to-k/cdkd#3499 `hintFor`. It is shape A with the
 * verb itself interpolated, so a grep for `'cdkd ` misses it entirely, and it
 * ALSO catches the regression this issue most expects: a caller taking
 * `pasteableCommand`'s gated result and wrapping it in quotes by hand, which
 * throws away everything the gate bought.
 *
 * **Bounded, and the bound excludes that regression's SIMPLEST instance.**
 * `` `'${built.command}'` `` is ONE hole with nothing between, which is
 * character-for-character what a quoted DISPLAY value looks like to a source
 * shape — so it is NOT reported, and saying "this catches the hand re-wrap"
 * without that clause over-claims. What is caught is a re-wrap with a second
 * interpolation and a space inside the same quotes. The bound is a negative
 * self-probe below, so it is pinned rather than remembered.
 *
 * **C — `open-hole`.** A bare `<word>` placeholder with more words after it
 * inside a `cdkd` command. `<name>` is two shell REDIRECTIONS; with a flag
 * appended the `>` gets a target, and
 * `cdkd events S --run <runId> --extra` read stdin from a file `runId`, created
 * a file named `--extra` and swallowed stdout (measured under bash with a stub
 * `cdkd`). A hole that ENDS a command is only a syntax error — which is why
 * `commandHole` renders `'<name>'` and why this shape is about what FOLLOWS.
 *
 * WHAT THIS DOES NOT CHECK
 * ------------------------
 * **Shape C of the issue — a `shellQuote`d value in PROSE whose quote context
 * an English apostrophe already flipped — is out of scope here, deliberately.**
 * It needs no command and no placeholder: `this stack's name` opens a shell
 * quote that closes at the value's own opening quote and leaves the value bare
 * (measured on go-to-k/cdkd#3363's `c5f07636`). Finding it needs the RENDERED
 * message, pasted at sentence and clause granularity — a source shape cannot
 * see it, and the issue says so. The per-site paste cases carry it.
 *
 * KNOWN BOUNDS, measured rather than claimed away
 * -----------------------------------------------
 * **A command split across CONCATENATED literals used to be a bound and is no
 * longer one.** A `+` run is folded into ONE reconstructed literal before it is
 * examined, with a non-literal operand standing in as a hole. An earlier
 * revision recorded the split as a stated bound on the grounds that the site
 * was still reported (as `open-hole`) and only its CLASSIFICATION was lost, and
 * that the population the fold would add was zero. Both halves stopped being
 * true when review sharpened the quote model: once a quoted run stopped being
 * scanned for holes, a prose-quoted command whose opening quote and
 * interpolation sit in different literals reported NOTHING. Folding it found a
 * real site the whole lane had missed — `export.ts`'s `buildImportPlan`
 * redaction-mask refusal, the twin of a site gated three PRs earlier.
 *
 * **What the fold cost, and how it is paid.** Merging a `+` run makes spans
 * long enough that an English APOSTROPHE starts pairing with one several
 * sentences away: eight false `quoted-command` findings, every one a sentence
 * bracketed by two possessives. {@link isQuoteDelimiter} excludes an apostrophe
 * with a word character on its left and a letter on its right. It is a
 * HEURISTIC, and the honest statement of it is that a source shape cannot tell
 * a possessive from an opening quote — which is the same limit that puts shape
 * C out of scope, one layer down.
 *
 * **A LONE re-wrapped command is not reported.** `` `'${built.command}'` `` is
 * one hole with nothing between, character-for-character a quoted DISPLAY
 * value. See the `quoted-interpolation` note below.
 *
 * **The quote model is an APPROXIMATION of shell lexing, biased toward INERT.**
 * {@link quoteRegions} and {@link blankInertText} implement the rules that a
 * measured case needed — single quotes literal, backticks substituting and
 * recursing, backslash escapes outside single quotes, a substitution's own
 * quotes belonging to it — and stop there. They are a hand-rolled lexer, and
 * five review rounds each found one nesting level deeper than the last, which
 * is the signal `check-docs-error-strings.ts` recorded as "stop patching a
 * hand-rolled parser". There is no shell parser to hand the job to, so the line
 * is drawn deliberately instead: the remaining gaps are UNDER-reports on
 * nestings no message in `src/` contains, and an under-report costs one missed
 * shape while an over-report costs the fence's credibility. Do not read a clean
 * run as "no pasted line can redirect"; read it as "no message takes one of the
 * three shapes this file recognises".
 *
 * REFUSALS, NOT SKIPS
 * -------------------
 * Every unreadable input is a refusal: a file that does not parse, and an
 * exemption whose target no longer exists. A checker that skips what it cannot
 * read is green for the wrong reason, and a stale exemption is how a fence goes
 * quiet without anyone editing it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript-v6';

/** One shape a site can be in. */
export type PasteableShape = 'quoted-command' | 'quoted-interpolation' | 'open-hole';

/** One site the critic reports. */
export interface PasteableFinding {
  readonly file: string;
  readonly line: number;
  readonly shape: PasteableShape;
  /** The offending span, trimmed and capped, for the report. */
  readonly excerpt: string;
}

/** What {@link checkPasteableCommandShapes} returns. */
export interface PasteableReport {
  readonly findings: readonly PasteableFinding[];
  /** Files parsed. A floor on this is what stops a vacuous green. */
  readonly filesScanned: number;
  /** Quoted spans examined, across every file. The second floor. */
  readonly spansExamined: number;
  /** Command literals examined for shape C. The third floor. */
  readonly commandLiteralsExamined: number;
  /** Exemptions whose target no longer exists — a refusal, not a warning. */
  readonly staleExemptions: readonly string[];
}

/**
 * The marker standing for an interpolation inside a reconstructed literal.
 *
 * `U+0000` because it cannot occur in the SOURCE text of a template literal:
 * a real NUL would be written `\\0` or `\\u0000` and arrive in `node.text` as the
 * character, so this is checked rather than assumed — a file carrying one is a
 * refusal below, not a silent mis-parse.
 */
const HOLE = '\u0000';

/**
 * Sites deliberately not fixed, by `file:shape:excerpt-prefix`. Each needs a
 * reason, and a stale entry is a REFUSAL — an exemption outliving its target is
 * how a fence goes quiet without anyone editing it.
 *
 * NOT empty. Its one entry is a go-to-k/cdkd#3436 own-copy gate the maintainer
 * asked to land in a follow-up PR rather than widen go-to-k/cdkd#3613, so the
 * exemption is how that decision stays on the record instead of becoming a
 * blind spot.
 */
export const EXEMPTIONS: ReadonlyArray<{
  file: string;
  shape: PasteableShape;
  contains: string;
  why: string;
}> = [
  {
    file: 'cli/commands/export.ts',
    shape: 'quoted-command',
    contains: 'cdkd import <stack> --resource',
    why:
      "buildImportPlan's redaction-mask refusal, the twin of the site " +
      'maskedIdentifierAttributeReason fixes in the same PR. Gating it is a ' +
      'one-line change and it is NOT done here: the maintainer asked this PR ' +
      'to stop widening, and the remaining go-to-k/cdkd#3436 own-copy gates ' +
      '(export.ts among them) are follow-up PRs. Tracked by go-to-k/cdkd#3436, ' +
      'which stays open until they land. This entry is what keeps the decision ' +
      'on the record instead of leaving a blind spot: when the gate lands the ' +
      'entry goes STALE and the run refuses until it is deleted.',
  },
];

/** A `cdkd` verb, as it appears at the head of a pasteable command. */
const CDKD_VERB = /\bcdkd\s+[a-z][a-z-]*/;

/**
 * A `<placeholder>` followed by more non-space content — shape C.
 *
 * The trailing `[^\s'"\`]` is what makes this about what FOLLOWS: a hole ENDING
 * the command is only a syntax error when pasted, and `commandHole`'s `'<x>'`
 * form is quoted and inert. Both are correct and must not be reported.
 *
 * **DOTS are part of the name.** The charset omitted them until review (M7),
 * which made `<stacks...>` -- Commander's own rendering of a variadic
 * argument, and the spelling this very PR wrote into four USAGE messages --
 * invisible. Measured under bash with a file named `stacks...` present:
 * `cdkd state orphan <stacks...> --all` exits 0 and CREATES a file called
 * `--all`, exactly as the dotless form does. An earlier round of this PR
 * claimed the dots "leave no redirection"; they do not, and that claim was
 * reasoned rather than run.
 */
const OPEN_HOLE = /<[A-Za-z][A-Za-z0-9_.-]*>\s+[^\s'"`]/;

/**
 * Whether the quote character at `i` is a DELIMITER rather than English.
 *
 * An apostrophe with a word character on its left and a letter on its right is
 * a possessive or a contraction -- `cdkd's`, `doesn't`, `EC2's`, `${want}'s` -- and
 * pairing it opens a span that runs to the next apostrophe anywhere in the
 * message. Measured: once `+` runs are
 * folded into one literal, that produced EIGHT false `quoted-command` findings
 * across `src/`, every one of them a sentence bracketed by two possessives.
 *
 * Nothing the repo's own gates emit is excluded by this: `shellQuote` opens
 * after a space or `=` and closes before a space, and `commandHole` writes
 * `'<name>'`, so neither delimiter has letters on both sides.
 *
 * It is deliberately NOT applied to `"` or a backtick, which have no English
 * use in the middle of a word.
 *
 * The same apostrophe is what makes shape C of go-to-k/cdkd#3436 dangerous at
 * PASTE time, and excluding it here is not a claim that it is harmless -- only
 * that a SOURCE shape cannot tell the two uses apart well enough to report on
 * the possessive one, which is the judgement the rendered-message tests exist
 * to carry instead.
 */
function isQuoteDelimiter(text: string, i: number): boolean {
  if (text[i] !== "'") return true;
  // The character BEFORE may also be an interpolation: `${want}'s asset bucket`
  // is a possessive on a rendered value, and the real tree carries it. So a
  // HOLE counts as a word character on the left -- which is sound in the other
  // direction too, since a value is not something a message quotes AND
  // immediately follows with a bare letter.
  const before = text[i - 1] ?? '';
  const after = text[i + 1] ?? '';
  // DIGITS count on the left: `EC2's`, `S3's`, `us-east-1's`. Review measured
  // that a letters-only test left those pairing across sentences, which is the
  // same false finding with a different word.
  const leftIsWord = /[A-Za-z0-9]/.test(before) || before === HOLE;
  return !(leftIsWord && /[A-Za-z]/.test(after));
}

/**
 * The reconstructed text split into QUOTED and UNQUOTED regions, left to right.
 *
 * One scan, shared by both halves of shape C's recognizer, because the two
 * questions it answers are the same question. Review found each of them broken
 * in its own way when they were answered separately:
 *
 *  - **A hole INSIDE quotes is inert**, and reporting one tells the caller to
 *    undo go-to-k/cdkd#3363's fix. `cdkd deploy '<stack> --all'` was reported
 *    as `open-hole` though neither bracket redirects. `commandHole`'s own
 *    `'<x>'` survived only because the hole is followed immediately by the
 *    closing quote, so the regex's "words after it" clause happened to miss.
 *  - **A command must not be joined across quotes.**
 *    `Run 'cdkd state list'. The '<name> value' is required.` paired the
 *    CLOSING quote of the command with the OPENING quote of an unrelated
 *    phrase, swallowed the prose between them, and reported the hole.
 *
 * Inside a double-quoted or backtick run a backslash ESCAPES the delimiter, and
 * that is not pedantry: `displayIdent` renders through `JSON.stringify`, so a
 * value carrying a quote reaches the message as `"a\\"b"` — and closing the run
 * at the escaped quote left the real one looking unmatched, which truncated the
 * command and hid the hole after it (measured). Inside a SINGLE-quoted run a
 * backslash is literal, as in POSIX sh, so no escape is honoured there.
 */
interface QuoteRegion {
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
  readonly quoted: boolean;
  /** The delimiter that opened it, or `undefined` for an unquoted stretch. */
  readonly delimiter?: "'" | '"' | '`';
}

function quoteRegions(text: string): QuoteRegion[] {
  const out: QuoteRegion[] = [];
  let plain = 0;
  let i = 0;
  // No `upto > plain` test: an empty unquoted region carries no text, matches
  // no position in `regionAt` (`pos < r.end` is false for it) and runs the
  // boundary scan zero times, so suppressing it changes nothing a probe can
  // see. Eighth clause removed for surviving its own mutant.
  const pushPlain = (upto: number): void => {
    out.push({ start: plain, end: upto, quoted: false });
  };
  while (i < text.length) {
    const c = text[i] as string;
    // OUTSIDE a quoted run a backslash escapes the next character, and this is
    // not a corner: `shellQuote` renders a value carrying an apostrophe as
    // `'O'\\''Brien'`, whose middle `\\'` is exactly that. Review measured the
    // whole rest of the command being swallowed by the mis-paired quote, which
    // hid the bare hole after it -- the fence going quiet on its own gate's
    // output.
    if (c === '\\') {
      i += 2;
      continue;
    }
    if ((c !== "'" && c !== '"' && c !== '`') || !isQuoteDelimiter(text, i)) {
      i++;
      continue;
    }
    pushPlain(i);
    let j = i + 1;
    let close = -1;
    while (j < text.length) {
      const d = text[j] as string;
      if (d === '\\' && c !== "'") {
        j += 2;
        continue;
      }
      // A backtick SUBSTITUTION inside `"..."` is its own context, and its
      // quotes belong to the command it runs, not to the enclosing string.
      // Without this jump, `` Run "`cdkd deploy "safe" <stack> --all`" `` closed
      // the outer run at `"safe"`, split the substitution, and the hole after
      // it was never examined -- a real redirection, confirmed under /bin/sh.
      if (d === '`' && c === '"') {
        // The backslash skip is HERE and stays. A round of review removed it on
        // the reasoning that ending a substitution early "preserves less and so
        // errs toward INERT" -- which is FALSE, and the next round measured
        // why: closing early puts the text AFTER the false closer back outside
        // the substitution, where it is scanned, so the mutant OVER-reports.
        // `` Run "`echo \`echo\` "cdkd deploy <stack> --all"`" `` is the
        // discriminator, and it is a self-probe below.
        let k = j + 1;
        while (k < text.length) {
          if (text[k] === '\\') {
            k += 2;
            continue;
          }
          if (text[k] === '`') break;
          k++;
        }
        if (k < text.length) {
          j = k + 1;
          continue;
        }
      }
      if (d === c && isQuoteDelimiter(text, j)) {
        close = j;
        break;
      }
      j++;
    }
    // An UNTERMINATED run runs to the end of the literal. It is still QUOTED:
    // the text after the opener is inside a span the operator would select
    // with it, which is shape A's territory, not a place to look for holes.
    const stop = close === -1 ? text.length : close + 1;
    out.push({ start: i, end: stop, quoted: true, delimiter: c as "'" | '"' | '`' });
    i = stop;
    plain = stop;
  }
  pushPlain(text.length);
  return out;
}

/** What a blanked-out character becomes. Chosen in {@link scanSource}'s note. */
const FILL = '\uFFFD';

/**
 * Blank everything a shell would NOT execute, keeping what it would, and do it
 * RECURSIVELY — a quoted run's interior is its own shell context.
 *
 * Length-preserving, because the caller slices this by the offsets of the
 * unblanked text.
 *
 * The arms are SHELL semantics, not symmetry, and each came from a measured
 * over- or under-report:
 *
 *  - `'...'` blanks WHOLE. Nothing substitutes inside single quotes, and a
 *    `<hole>` there is `commandHole`'s own remedy.
 *  - `` `...` `` keeps its delimiters and RECURSES on the interior. A backtick
 *    is command SUBSTITUTION: its contents EXECUTE, so a hole there redirects
 *    exactly as a bare one does — and backticks are also how this repo's prose
 *    marks up a command, so treating them as inert reported nothing for
 *    `` Run `cdkd events <stack> --all` ``. Recursing is what stops the other
 *    direction: `` `cdkd deploy '<stack> --all'` `` is executed, and the hole
 *    inside it is STILL single-quoted.
 *  - `"..."` blanks, except an UNESCAPED backtick sub-run, whose interior
 *    recurses. A shell substitutes inside double quotes — but `\\`` there is an
 *    escaped backtick and substitutes nothing, which is why the escape is
 *    honoured rather than the character.
 */
export function blankInertText(text: string): string {
  const regions = quoteRegions(text);
  let out = '';
  for (const r of regions) {
    const span = text.slice(r.start, r.end);
    if (!r.quoted) {
      out += span;
      continue;
    }
    if (r.delimiter === "'") {
      // EVERY single-quoted span blanks, including one that holds a `cdkd`
      // verb -- and NOT reporting the hole inside a prose-quoted command is a
      // known disagreement with go-to-k/cdkd#3613's M7, recorded here rather
      // than papered over.
      //
      // M7 is right that `Re-run 'cdkd drift <stack> --revert'` redirects when
      // an operator selects the INNER text. Three attempts to report it
      // without reporting inert shapes each failed on a case a critic
      // measured: keying on the span holding a verb reported
      // `cdkd deploy 'a \`cdkd events <stack>\` b'`, an ARGUMENT bash passes
      // literally; adding "no unquoted verb precedes it" still reported
      // `echo 'cdkd drift <stack> --revert'` and went SILENT on a remedy
      // whenever any earlier line mentioned a command, because the flag never
      // reset at a sentence boundary. The distinction M7 needs is PROSE versus
      // a command word, which is not a shell property and not one a source
      // shape can read.
      //
      // So the model stays the defensible one -- the operator takes the span
      // WITH its quotes, which is also shape A's premise -- and the SITE M7
      // named is fixed in `drift.ts` regardless. Widening this is a decision
      // for the maintainer with those measurements in hand, not a heuristic to
      // keep guessing at.
      out += FILL.repeat(span.length);
      continue;
    }
    // `span.length > 1` keeps a LONE unmatched delimiter from counting as its
    // own closer, which would emit two fill characters for one and break the
    // length invariant this function's callers slice by. It cannot change a
    // VERDICT -- such a span is the last character of the literal, so nothing
    // follows it to shift -- so the length test is what pins it, not a finding.
    const closed = span.length > 1 && span[span.length - 1] === r.delimiter;
    const inner = span.slice(1, closed ? span.length - 1 : span.length);
    if (r.delimiter === '`') {
      out += '`' + blankInertText(inner) + (closed ? '`' : '');
      continue;
    }
    out += FILL + blankInsideDoubleQuotes(inner) + (closed ? FILL : '');
  }
  return out;
}

/** The `"..."` interior: inert except an UNESCAPED backtick substitution. */
function blankInsideDoubleQuotes(inner: string): string {
  let out = '';
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === '\\') {
      out += FILL.repeat(Math.min(2, inner.length - i));
      i += 2;
      continue;
    }
    if (inner[i] === '`') {
      // Same clause, kept for the OPPOSITE measured reason -- worth stating,
      // because a shared "same reason" comment is how the wrong half gets
      // believed. In the jump-scan above, closing early hands the remainder
      // back OUTSIDE the substitution, where it is scanned: an OVER-report.
      // Here the walk blanks whatever is not inside a backtick run, so closing
      // early cuts the command short and the hole falls into blanked text: an
      // UNDER-report. Each direction has its own probe.
      let j = i + 1;
      let close = -1;
      while (j < inner.length) {
        if (inner[j] === '\\') {
          j += 2;
          continue;
        }
        if (inner[j] === '`') {
          close = j;
          break;
        }
        j++;
      }
      // `close !== -1` is a TERMINATION guard as much as a verdict one: with no
      // closer, `i = close + 1` is 0, so dropping it re-enters the enclosing
      // walk at index 0 FOREVER. (The recursive slice shrinks, which is what
      // made me report the mutant as terminating on one round; it does not --
      // the enclosing input never moves.) Nothing on a test worker's own event
      // loop can report that, so the length-preservation check runs in an
      // externally bounded CHILD, and a self-probe here carries an unterminated
      // backtick inside double quotes so the spawned binary reaches this arm.
      if (close !== -1) {
        out += '`' + blankInertText(inner.slice(i + 1, close)) + '`';
        i = close + 1;
        continue;
      }
    }
    out += FILL;
    i++;
  }
  return out;
}

/**
 * EVERY command in a literal, as `{ tail, scan }`.
 *
 * `tail` is the command's own text, for the excerpt. `scan` is the same text
 * with every quoted run BLANKED to `U+FFFD`, which is what the open-hole regex
 * reads: blanking keeps the offsets while making a quoted hole unmatchable,
 * and `U+FFFD` is neither whitespace nor an angle bracket so it can create no
 * match of its own.
 *
 * A command STARTING inside a quoted run ends with that run — the span is the
 * whole command. Outside one, a balanced quoted run is PART of the command
 * (`shellQuote` and `commandHole` both emit one), and the command ends at a
 * sentence end, a newline or an opening parenthesis found OUTSIDE quotes.
 *
 * Every command is walked, not only the first: a message naming two remedies
 * had its second unexamined, and the second is the one a later edit appends.
 */
function commandTails(text: string): Array<{ tail: string; scan: string }> {
  const regions = quoteRegions(text);
  const blanked = blankInertText(text);

  // The regions PARTITION the text in source order. Two consequences, and both
  // were clauses no mutant could red: the lower bound `pos >= r.start` is
  // implied by taking the FIRST region whose end is past `pos`, and the `??`
  // fallback is unreachable, since every caller passes the offset of a `cdkd`
  // match found INSIDE this same text. `!` rather than a fallback object, so
  // the invariant is stated once and there is no second shape to keep true.
  const regionAt = (pos: number): QuoteRegion => regions.find((r) => pos < r.end)!;

  const out: Array<{ tail: string; scan: string }> = [];
  let from = 0;
  while (from < text.length) {
    const rel = text.slice(from).search(CDKD_VERB);
    if (rel === -1) break;
    const start = from + rel;
    const host = regionAt(start);
    let end: number;
    if (host.quoted) {
      end = host.end;
    } else {
      end = text.length;
      for (const region of regions) {
        // NO `region.end <= start` test: `Math.max` below already starts an
        // earlier region's scan past its own end, so the loop runs zero times
        // there. Sixth clause this lane has removed for surviving its probe.
        if (region.quoted) continue;
        const scanFrom = Math.max(region.start, start);
        let k = scanFrom;
        let stop = -1;
        while (k < region.end) {
          const c = text[k] as string;
          if (c === '\n' || c === '(') {
            stop = k;
            break;
          }
          // A sentence end needs the following space, so a trailing `.` -- or
          // one inside `us-east-1.amazonaws.com` -- does not cut it short.
          if ((c === '.' || c === '!' || c === '?') && /\s/.test(text[k + 1] ?? '')) {
            stop = k;
            break;
          }
          k++;
        }
        if (stop !== -1) {
          end = stop;
          break;
        }
      }
    }
    out.push({ tail: text.slice(start, end), scan: blanked.slice(start, end) });
    // `from = end`, with NO `end > start` fallback: a matched command's host
    // region ends after `start` by construction, and the boundary walk cannot
    // stop on the `c` of `cdkd`, so `end > start` always holds. The fallback
    // read as loop protection and protected nothing -- seventh such clause.
    from = end;
  }
  return out;
}

/** Parse, or refuse — a file that does not parse is never silently skipped. */
function parseOrRefuse(file: string, text: string): ts.SourceFile {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // `createSourceFile` does not throw on a syntax error; it records one.
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (diagnostics !== undefined && diagnostics.length > 0) {
    throw new Error(
      `check-pasteable-command-shapes: ${file} did not parse (${diagnostics.length} diagnostics). ` +
        `A file this critic cannot read is a refusal, not a skip — fix the file or the critic.`
    );
  }
  return sf;
}

/** Every `.ts` file under a directory, sorted, excluding `.d.ts`. */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * Every quoted span in a reconstructed literal, with the offset it starts at.
 *
 * Single quotes ONLY, and the reason is NOT that a double-quoted span is safe.
 * An earlier revision said `"..."` in prose "does not open a shell quote the way
 * `'...'` does", which is simply false — it opens one, and worse: `$( )` and
 * backticks still SUBSTITUTE inside it, where a single-quoted span makes them
 * literal. Review caught the claim.
 *
 * The real reason is that a source shape cannot see the case that matters. The
 * repo's double quotes around an interpolated value are put there at RUNTIME by
 * `displayIdent`, which JSON-quotes what it renders, so the source literal
 * carries no `"` at all. This lane shipped exactly that defect and measured it:
 * `export.ts`'s `maskedIdentifierAttributeReason` rendered a logical id through
 * `displayIdent` INSIDE a `cdkd import` line, and a `$(touch OWNED)` id ran when
 * the line was pasted. No arrangement of THIS check would have reported it.
 *
 * Measured at this head: 176 double-quoted spans in `src/`, ZERO of them holding
 * a `cdkd` verb with an interpolation — so admitting the source-level shape
 * would add no coverage either. What covers the runtime case is a PASTE test —
 * the rendered message fed to a real shell, contrasting `displayIdent` (live)
 * with `pasteableCommand` (inert) — which is go-to-k/cdkd#3436's own-copy half
 * and is deliberately not in this tree. No path is named here rather than one
 * that does not resolve yet.
 */
function quotedSpans(reconstructed: string): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  let open = -1;
  for (let i = 0; i < reconstructed.length; i++) {
    if (reconstructed[i] !== "'" || !isQuoteDelimiter(reconstructed, i)) continue;
    if (open === -1) {
      open = i;
      continue;
    }
    out.push({ text: reconstructed.slice(open + 1, i), at: open });
    open = -1;
  }
  return out;
}

/**
 * Whether a span is the `hintFor` shape: a quoted span ASSEMBLED entirely out
 * of interpolations, with TWO OR MORE of them.
 *
 * The two-hole floor is the whole discriminator and it was measured. A span
 * holding ONE hole and nothing else is `'${stackName}'` — a quoted DISPLAY
 * value in prose, go-to-k/cdkd#3232's class and not this one, and it vastly
 * outnumbers the real sites. Reporting it here would bury every one of them
 * under a class this fence does not own and cannot fix. (An earlier revision
 * gave a count of 944 and a count of the real sites; the critic measured the
 * first differently, neither figure reproduced, and both are gone from the
 * test and the PR body — this docstring was the third copy.)
 * Two or more holes with only separators between them is a command being
 * BUILT — `` `'${command} ${t}'` `` is `destroy-runner.ts`'s pre-#3499
 * `hintFor` — and there is no display idiom that spells one that way.
 *
 * What this deliberately does NOT do is key on the interpolated expression's
 * NAME (`pasteableCommand(...)`, `...Command`, `...Hint`). That is the
 * degrading shape go-to-k/cdkd#3436's record measured on `gc.ts`: a list of
 * the predicate names that exist today goes quiet the moment someone coins a
 * new one. The hole COUNT is a property of the shape.
 */
function isAssembledCommand(span: string): boolean {
  const chunks = span.split(HOLE);
  // No early return on the hole COUNT: it would be subsumed. One hole gives
  // `['', '']`, whose interior slice below is empty, so the space test already
  // rejects it — and a line no mutant can red is a line that reads as a guard
  // while guarding nothing. The space test is the single discriminator.
  // Separators only, AND at least one of them a SPACE. The space is what makes
  // this a command rather than a compound display value: argv words are
  // space-separated, while `'${containerId}:${workdir}'` — a real
  // `invoke-agentcore-watch-loop.ts` message naming a docker cp target — is two
  // holes joined by a colon and is not a command at all. Measured: without the
  // space requirement that site is the classifier's only false positive in this
  // shape across `src/`.
  if (!chunks.every((chunk) => /^[\s\-=:,/]*$/.test(chunk))) return false;
  return chunks.slice(1, -1).some((chunk) => /\s/.test(chunk));
}

/** Cap an excerpt so a report line stays readable. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

/**
 * Scan one file's source text.
 *
 * Exported for the fence's own tests, which plant each shape in a fixture
 * rather than relying on the real tree — and then ALSO assert a floor over the
 * real tree, because a synthetic fixture and the classifier can share a blind
 * spot.
 */
export function scanSource(
  file: string,
  text: string
): { findings: PasteableFinding[]; spans: number; commandLiterals: number } {
  // A RAW NUL byte in the source is a refusal, and stays one: it is
  // `check-source-control-bytes.ts`'s class (grep and rg treat the whole FILE
  // as binary and skip it at exit 0), so a file carrying one is unreadable by
  // half the repo's tooling and this critic should not paper over it. A NUL
  // written as an ESCAPE is a different fact and is handled in the walk below.
  if (text.includes(HOLE)) {
    throw new Error(
      `check-pasteable-command-shapes: ${file} contains a literal NUL, which this critic uses as ` +
        `its interpolation marker. Refusing rather than mis-parsing.`
    );
  }
  const sf = parseOrRefuse(file, text);
  const findings: PasteableFinding[] = [];
  let spans = 0;
  let commandLiterals = 0;

  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const consider = (reconstructed: string, start: number): void => {
    // Shape C first: it is about the command literal, quoted or not.
    const tails = commandTails(reconstructed);
    // Counted per LITERAL rather than per command, so the floor keeps the
    // magnitude it was calibrated against when the walk found only the first.
    if (tails.length > 0) commandLiterals++;
    for (const { tail, scan } of tails) {
      // `scan`, not `tail`: a hole inside quotes is inert, and `commandHole`'s
      // `'<x>'` IS the remedy. Reporting it would tell callers to undo it.
      if (OPEN_HOLE.test(scan)) {
        findings.push({
          file,
          line: lineOf(start),
          shape: 'open-hole',
          excerpt: excerpt(tail),
        });
      }
    }
    for (const span of quotedSpans(reconstructed)) {
      spans++;
      if (CDKD_VERB.test(span.text) && span.text.includes(HOLE)) {
        findings.push({
          file,
          line: lineOf(start),
          shape: 'quoted-command',
          excerpt: excerpt(span.text),
        });
        continue;
      }
      if (isAssembledCommand(span.text)) {
        findings.push({
          file,
          line: lineOf(start),
          shape: 'quoted-interpolation',
          excerpt: excerpt(span.text),
        });
      }
    }
  };

  // The raw-source test above is necessary and NOT sufficient, which review
  // measured: TypeScript DECODES `\\0` and `\\u0000` while the source carries only
  // the escape, so `node.text` can hold a real NUL from a file the first test
  // passed -- and that NUL is indistinguishable from this critic's own hole
  // marker, which is a mis-parse rather than a miss.
  //
  // It is a SUBSTITUTION and not a refusal, because the first cut refused and
  // the real tree immediately disagreed: `deploy-engine.ts` builds its
  // export-index keys as `${stack}\\u0000${region}\\u0000${name}`, the same
  // separator trick for the same reason, in three live literals. Refusing would
  // have made the fence unrunnable over `src/` -- the shape a checker must
  // never take, since the pressure is then to delete the check.
  //
  // `U+FFFD` is inert for every recognizer here: it is not a quote, not
  // whitespace, not a sentence end, not `<` or `>`. So it can neither END a
  // command early nor CREATE an open hole, and the only text it can alter is a
  // message that already carries a NUL, which no operator pastes.
  const decoded = (t: string): string => t.replaceAll(HOLE, '\uFFFD');

  /**
   * Strip parentheses. `(\`a\`) + b` and `a + (b + \`c\`)` are the same message as
   * their unparenthesised twins, and review measured both returning NO findings
   * where the twin reported one: a parenthesised operand became an opaque hole
   * and took the quote boundaries with it.
   */
  const unparen = (node: ts.Node): ts.Node =>
    ts.isParenthesizedExpression(node) ? unparen(node.expression) : node;

  /**
   * One literal's own reconstruction: its text, with a HOLE per interpolation.
   *
   * It does NOT call `unparen` itself. Its only caller maps it over
   * `plusOperands`, which already unwraps every operand, so the second call was
   * a normalization the parenthesis probes pin one layer up and nothing here
   * could red -- the tenth such clause.
   */
  const reconstruct = (node: ts.Node): string | undefined => {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
      return decoded(node.text);
    }
    if (ts.isTemplateExpression(node)) {
      return [
        decoded(node.head.text),
        ...node.templateSpans.map((sp) => decoded(sp.literal.text)),
      ].join(HOLE);
    }
    return undefined;
  };

  /** Flatten a left-nested `a + b + c` run into its operands, in source order. */
  const plusOperands = (node: ts.BinaryExpression): ts.Expression[] => {
    const out: ts.Expression[] = [];
    const walk = (raw: ts.Expression): void => {
      const n = unparen(raw) as ts.Expression;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        walk(n.left);
        walk(n.right);
        return;
      }
      out.push(n);
    };
    walk(node.left);
    walk(node.right);
    return out;
  };

  const isPlusRun = (n: ts.Node): boolean =>
    ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;


  const visit = (node: ts.Node): void => {
    // A `+` RUN is folded into ONE literal before it is examined. Until review
    // sharpened the quote model this was a stated bound and nothing more -- the
    // classification was lost, the site still reported as `open-hole`. Once a
    // quoted run stopped being scanned for holes, the bound got WORSE than
    // stated: a prose-quoted command whose opening quote is in one literal and
    // whose interpolation is in the next reported NOTHING at all. (The header
    // used to cite `export.ts:2205` as the live instance; that site was fixed
    // by this PR, so the shape is described and no line number is given --
    // go-to-k/cdkd#3613's M8.) A bound that hides the shape the fence exists for is not
    // a bound to record, so the fold the header named as the remedy is done.
    //
    // A non-literal operand becomes a HOLE, which is exactly what it is: the
    // run `\`... \` + value + \`...\`` interpolates `value` between two literals.
    // That also makes the mixed run work without a second code path.
    if (isPlusRun(node)) {
      const operands = plusOperands(node as ts.BinaryExpression);
      const parts = operands.map(reconstruct);
      // NO "this is the run's ROOT" guard either. `plusOperands` FLATTENS a
      // nested run, and this arm returns without walking its children, so an
      // inner `+` is never visited on its own and the test could not red --
      // review measured it surviving against every probe, all 20 unit fixtures
      // and the whole tree. Its `effectiveParent` helper went with it.
      //
      // NO "at least one operand is a literal" guard. It read as one and
      // guarded nothing: a run with NO literal folds to holes only, which
      // carries no quote and no verb, so `a + 1 + b` yields the same nothing
      // either way -- its mutation probe SURVIVED, and its test passed on the
      // fixture being inert rather than on arithmetic being excluded. Fourth
      // such line this lane has written and removed.
      consider(parts.map((part) => part ?? HOLE).join(''), node.getStart(sf));
      for (const [i, operand] of operands.entries()) {
        // A literal operand's own text is already folded in; only its
        // interpolated expressions are separate sites. A non-literal operand is
        // walked whole.
        if (parts[i] === undefined) visit(operand);
        else if (ts.isTemplateExpression(operand)) {
          operand.templateSpans.forEach((sp) => visit(sp.expression));
        }
      }
      return;
    }
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
      consider(decoded(node.text), node.getStart(sf));
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const parts = [
        decoded(node.head.text),
        ...node.templateSpans.map((s) => decoded(s.literal.text)),
      ];
      consider(parts.join(HOLE), node.getStart(sf));
      // Descend anyway: an interpolated expression can hold its own literal,
      // and that literal is a site in its own right. ONCE -- an earlier
      // revision also walked each expression's CHILDREN separately, so a nested
      // literal was considered twice: duplicate findings, and both floors
      // inflated by whatever the tree happens to nest. Review measured it.
      node.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return { findings, spans, commandLiterals };
}

/**
 * Floors, over the REAL tree, so a classifier that stopped matching cannot
 * report "0 findings" and pass.
 *
 * Three of them, one per input SHAPE the parser claims to handle, because an
 * aggregate floor hides one dead shape: `spansExamined` can stay high while the
 * command-literal walk dies, and vice versa. Measured 2026-09-24 at 359 / 1498 /
 * 859; the floors sit well below so an ordinary deletion does not false-fire.
 * Both non-file magnitudes moved DOWN twice during review and neither move was
 * a narrowing: removing a duplicate visit of nested literals took 1532 / 1047
 * to 1511 / 1022, and folding `+` runs merges several literals into one, which
 * is the command counter's whole subject.
 */
export const FLOORS = { filesScanned: 300, spansExamined: 1200, commandLiteralsExamined: 700 } as const;

/** One fixed source with a known verdict, analysed BEFORE the real tree. */
export interface ProbeCase {
  readonly label: string;
  readonly source: string;
  /** The shapes this source must produce, in any order. */
  readonly expect: readonly PasteableShape[];
}

/**
 * Sources with known verdicts, INCLUDING negatives.
 *
 * The floors above catch a collapse toward ZERO. These catch the opposite — a
 * classifier that reports everything leaves every floor satisfied and the
 * counts LARGER, so nothing else would see it.
 *
 * The property that matters is NEAR-MISS coverage, not a headcount: for each
 * shape there is an accept case AND a negative carrying that shape's own
 * trigger, so neither a report-nothing nor a report-everything classifier
 * survives the set. This comment used to claim a NEGATIVE MAJORITY, which went
 * false as real accept arms were added (19 of 39 at this head) and said nothing
 * about coverage even while it was true. The test asserts the near-miss
 * property directly.
 */
export const SELF_PROBE_CASES: readonly ProbeCase[] = [
  // --- quoted-command -------------------------------------------------------
  {
    label: 'a quoted cdkd command carrying an interpolation',
    source: 'const m = `Run \'cdkd deploy ${name}\' to migrate it.`;',
    expect: ['quoted-command'],
  },
  {
    label: 'the same command UNWRAPPED on its own line is the remedy, not a defect',
    source: 'const m = `Migrate with: cdkd deploy ${name}`;',
    expect: [],
  },
  {
    label: 'a quoted cdkd command with no interpolation is prose, not a hazard',
    source: "const m = `Run 'cdkd state list --long' and act on the match.`;",
    expect: [],
  },
  // --- quoted-interpolation -------------------------------------------------
  {
    label: "the hintFor shape: a span assembled from two holes",
    source: 'const m = targets.map((t) => `\'${command} ${t}\'`);',
    expect: ['quoted-interpolation'],
  },
  {
    label: 'a gated command re-wrapped in quotes by hand',
    source: 'const m = `\'${pasteableCommand(verb, args).command} ${suffix}\'`;',
    expect: ['quoted-interpolation'],
  },
  {
    // The re-wrap bound, as a case rather than a sentence. This IS the
    // regression the shape claims to catch, in its simplest form, and the
    // classifier cannot see it: one hole, nothing between, identical to a
    // quoted display value. Pinned so the bound cannot be quietly widened in
    // the prose without the probe disagreeing.
    label: 'a LONE gated command re-wrapped in quotes is one hole, and NOT reported',
    source: 'const m = `Run \'${pasteableCommand(verb, args).command}\'`;',
    expect: [],
  },
  {
    // The decoded-NUL substitution, as a case. `deploy-engine.ts` writes this
    // exact shape for its export-index keys, so a refusal here would make the
    // fence unrunnable over the real tree; the substitute is inert, so the
    // literal still classifies as what it is -- nothing.
    label: 'a literal using \\u0000 as its own separator is substituted, not refused',
    source: 'const key = `${stack}\\u0000${region}\\u0000${name}`;',
    expect: [],
  },
  {
    // The DISCRIMINATING half, and the one that pins the substitution rather
    // than the refusal. Review corrected the claim this comment used to make:
    // the source already holds TWO real interpolations, so the NUL is not
    // "a second" one. What it does is make the span look ASSEMBLED PURELY from
    // interpolations and separators -- read as a marker, the NUL leaves behind
    // an empty chunk, every chunk passes the separators-only test, and the span
    // is reported as a command whose only separator is invisible message
    // CONTENT. Substituted, the chunk holds `U+FFFD` and fails that test.
    // Its twin below is the same span WITHOUT the NUL, which is a real
    // assembled command and IS reported -- so the pair fails in one direction
    // if the substitution goes and in the other if the shape does.
    label: 'a decoded NUL makes a span look separator-only, and the substitution stops that',
    source: 'const m = `\'${a} \\u0000${b}\'`;',
    expect: [],
  },
  {
    label: 'the same span WITHOUT the NUL is the assembled shape, and IS reported',
    source: 'const m = `\'${a} ${b}\'`;',
    expect: ['quoted-interpolation'],
  },
  {
    label: 'ONE hole in quotes is a display value, not a command',
    source: 'const m = `Stack \'${stackName}\' has no region.`;',
    expect: [],
  },
  {
    label: 'two holes joined by a colon is a display value, not a command',
    source: 'const m = `docker cp into \'${containerId}:${workdir}\' failed`;',
    expect: [],
  },
  // --- open-hole ------------------------------------------------------------
  {
    label: 'a bare hole with a flag after it',
    source: 'const m = `Run cdkd force-unlock <stackName> --stack-region <region>`;',
    expect: ['open-hole'],
  },
  {
    label: 'a QUOTED hole with a flag after it is what commandHole emits',
    source: "const m = `Run cdkd force-unlock '<stackName>' --stack-region '<region>'`;",
    expect: [],
  },
  {
    label: 'a bare hole ENDING the command is a syntax error, not a redirection',
    source: 'const m = `Run cdkd force-unlock <stackName>`;',
    expect: [],
  },
  {
    label: 'a hole and a cdkd verb in different sentences are not one command',
    source: 'const m = `Pass --state-bucket <name> (cdkd deploy uses the same bucket).`;',
    expect: [],
  },
  {
    // The first tail correction review forced: a BALANCED quoted run is part of
    // the command. `shellQuote` and `commandHole` both emit one, so ending the
    // command at the first quote made the fence silent on a gated command
    // carrying a bare hole -- the exact shape it exists for.
    label: 'a quoted VALUE earlier in the command does not end it before the hole',
    source: "const m = `Run cdkd deploy 'My Stack' --resource <id> --force`;",
    expect: ['open-hole'],
  },
  {
    // The second: only the FIRST command was examined, so a message naming two
    // remedies left the second unchecked -- and the second is the one a later
    // edit appends.
    label: 'the SECOND command in one literal is examined too',
    source: 'const m = `Run cdkd state show MyStack. Or run cdkd events <stack> --all.`;',
    expect: ['open-hole'],
  },
  {
    // Review's finding, and the reason the open-hole scan reads the BLANKED
    // text: a hole inside quotes is inert, and this spelling -- hole, space,
    // flag, all inside one quoted run -- is what slipped past the earlier
    // `commandHole` case, where the hole is followed immediately by its own
    // closing quote.
    label: 'a hole with a flag after it INSIDE one quoted run is inert',
    source: "const m = `Run cdkd deploy '<stack> --all'`;",
    expect: [],
  },
  {
    // The other half of the same finding: a command must not be joined across
    // quotes. Pairing this literal's quotes naively made the command swallow
    // `. The ` and report the unrelated phrase's hole.
    label: 'a command is not joined to a later quoted phrase across the prose between them',
    source: "const m = `Run 'cdkd state list'. The '<name> value' is required.`;",
    expect: [],
  },
  {
    // An escaped delimiter does not close a double-quoted run. `displayIdent`
    // renders through `JSON.stringify`, so a value carrying a quote reaches
    // the message as `\\"`; closing the run there left the real closer looking
    // unmatched, truncated the command and hid the hole after it.
    label: 'an escaped quote inside a double-quoted run does not truncate the command',
    source: 'const m = `Run cdkd deploy "a\\\\"b" --resource <id> --force`;',
    expect: ['open-hole'],
  },
  {
    // `shellQuote`'s own escape for a value carrying an apostrophe. OUTSIDE a
    // quoted run a backslash escapes the next character; reading the escaped
    // quote as an opener mis-paired everything after it and swallowed the hole.
    label: "shellQuote's `'\\''` escape does not swallow the rest of the command",
    source: "const m = `Run cdkd deploy 'O'\\\\''Brien' --resource <id> --force`;",
    expect: ['open-hole'],
  },
  {
    // Parentheses are not a message boundary. Both spellings returned NOTHING
    // while their unparenthesised twin reported, because a parenthesised
    // operand became an opaque hole and took the quote boundaries with it.
    label: 'a parenthesised operand does not defeat the + fold (right)',
    source: "const m = `Run 'cdkd deploy ` + (name + `' now.`);",
    expect: ['quoted-command'],
  },
  {
    label: 'a parenthesised operand does not defeat the + fold (left)',
    source: "const m = (`Run 'cdkd deploy `) + name + `' now.`;",
    expect: ['quoted-command'],
  },
  {
    // DIGITS are word characters for the possessive test. `EC2's` / `S3's` are
    // the spellings this repo actually writes, and a letters-only test left
    // them pairing across sentences.
    label: "a possessive on a DIGIT-ending word is English, not a quote",
    source: "const m = `EC2's region is ${region}. ` + `cdkd deploy cannot use S3's bucket.`;",
    expect: [],
  },
  {
    // A BACKTICK is command substitution, not a quote. Its contents execute, so
    // a hole in there redirects exactly as a bare one does -- and this repo's
    // prose marks up commands with backticks, so the shape is everywhere.
    label: 'a hole inside BACKTICKS is live, because backticks substitute',
    source: 'const m = "Run `cdkd events <stack> --all`";',
    expect: ['open-hole'],
  },
  {
    // ...including inside a double-quoted span, where blanking would otherwise
    // hide it: a shell substitutes inside `"..."` too.
    label: 'a backtick sub-run inside a double-quoted span is not blanked',
    source: "const m = 'He said \"run `cdkd events <stack> --all` now\"';",
    expect: ['open-hole'],
  },
  {
    // A backtick run EXECUTES, but a hole single-quoted INSIDE it is still
    // single-quoted. Copying the run verbatim reported it; recursing does not.
    label: 'a hole single-quoted INSIDE a backtick substitution is inert',
    source: 'const m = "Run `cdkd deploy \'<stack> --all\'`";',
    expect: [],
  },
  {
    // An ESCAPED backtick inside double quotes substitutes nothing, so the
    // whole value is a literal. Honouring the character rather than the escape
    // reported it.
    label: 'an ESCAPED backtick inside double quotes substitutes nothing',
    source: "const m = 'Run \"literal \\\\`cdkd events <stack> --all\\\\`\"';",
    expect: [],
  },
  {
    // The ESCAPE arm of the double-quoted walk, and its only discriminator. It
    // is contrived -- an escaped backtick immediately before a real
    // substitution -- and it is here because the plain escaped-backtick case
    // above is decided by the INNER close-scan, so deleting this arm reds
    // nothing without it (measured). Shell verdict: the first backtick is a
    // literal, the pair after it opens and closes a real substitution, and the
    // hole inside that substitution redirects.
    label: 'an escaped backtick does not consume the REAL substitution after it',
    source: "const m = 'Run \"\\\\` `cdkd events <stack> --all`\"';",
    expect: ['open-hole'],
  },
  {
    // A substitution's OWN quotes belong to the command it runs, not to the
    // string around it. Closing the outer run at the inner `"safe"` split the
    // substitution and the hole after it was never examined.
    label: "a substitution's inner double quotes do not close the run around it",
    source: "const m = 'Run \"`cdkd deploy \"safe\" <stack> --all`\"';",
    expect: ['open-hole'],
  },
  {
    // Inside `'...'` a backslash is LITERAL, so the run closes at the very next
    // apostrophe and everything after it is unquoted. Honouring the escape
    // there swallowed the rest of the command and the hole with it -- the one
    // arm of the close-scan escape reachable from an ordinary message -- the
    // two nested siblings need a contrived nesting, and each carries its own
    // probe below rather than being taken on trust.
    label: 'a backslash inside single quotes does not escape the closing quote',
    source: "const m = 'Run cdkd deploy \\'a\\\\\\' <stack> --all';",
    expect: ['open-hole'],
  },
  {
    // The escaped-backtick skip in the substitution close-scan, and its
    // discriminator -- which also disproves the reasoning a round of review had
    // used to delete it. Taking the escaped backtick as a closer ends the
    // substitution early and hands the `"cdkd deploy <stack> --all"` after it
    // back to the scanner as executable text, so the mutant OVER-reports. A
    // real shell treats that placeholder as quoted.
    label: 'an escaped backtick inside a substitution does not close it early',
    source: "const m = 'Run \"`echo \\\\`echo\\\\` \"cdkd deploy <stack> --all\"`\"';",
    expect: [],
  },
  {
    // The SIBLING escape skip, inside the double-quoted walk's own close-scan,
    // which the case above does not reach. Here the escaped backtick sits
    // INSIDE the substitution: closing there would cut the command short and
    // leave the hole outside any executable span, so the mutant UNDER-reports
    // where the one above over-reports. A shell runs `cdkd deploy ` <stack>
    // --all` and the placeholder redirects.
    label: 'an escaped backtick inside a double-quoted substitution does not end it',
    source: "const m = 'Run \"`cdkd deploy \\\\` <stack> --all`\"';",
    expect: ['open-hole'],
  },
  {
    // The `k < text.length` arm of the substitution jump: an UNTERMINATED
    // backtick must NOT consume the rest of the run, or the closing quote is
    // never found and everything after it -- including a second, real command
    // -- is swallowed as quoted.
    label: 'an unterminated substitution does not swallow the command after the quote',
    source: "const m = 'Run \"`cdkd deploy\" and cdkd events <stack> --all';",
    expect: ['open-hole'],
  },
  {
    // The fold's descent into a NON-LITERAL operand. The literal that carries
    // the command sits inside a call, so it is reached only by walking that
    // operand.
    label: 'the fold descends into a non-literal operand',
    source: "const m = `a ` + f(`Run 'cdkd deploy ${x}' now`) + `b`;",
    expect: ['quoted-command'],
  },
  {
    // ...and into a folded TEMPLATE operand's own interpolations, which is the
    // other descent and a different line.
    label: "the fold descends into a template operand's interpolations",
    source: "const m = `a ${f(`Run 'cdkd deploy ${x}' now`)} b` + `c`;",
    expect: ['quoted-command'],
  },
  {
    // An UNTERMINATED backtick inside double quotes: there is no sub-run to
    // recurse into, so the walk must fall through to its single-character step.
    // A mutant that recurses anyway re-enters at the same index forever, and
    // this is the source that makes the SPAWNED binary hang on it -- which its
    // own external timeout turns into a failure, where Vitest's in-process one
    // could not (review's finding).
    label: 'an unterminated backtick inside double quotes terminates the walk',
    source: "const m = 'Run \"`cdkd events <stack> --all\"';",
    expect: [],
  },
  {
    // The `!` half of the sentence boundary. The period case pins ONE instance
    // of the rule; review measured that deleting either of the other two
    // terminators left every probe green while both mis-reported this line.
    label: 'a hole after a sentence ending in ! is not inside the command',
    source: 'const m = `Run cdkd deploy MyStack! Then pass --resource <id> --force by hand.`;',
    expect: [],
  },
  {
    label: 'a hole after a sentence ending in ? is not inside the command',
    source: 'const m = `Run cdkd deploy MyStack? Then pass --resource <id> --force by hand.`;',
    expect: [],
  },
  {
    // The possessive rule is for APOSTROPHES only. A double quote between two
    // letters still OPENS a run, so the hole after it is inside quotes and
    // inert; applying the rule to `"` leaves the run closed and reports it.
    label: 'a double quote between letters still opens a run',
    source: 'const m = `Run cdkd deploy a"b <stack> --all"`;',
    expect: [],
  },
  {
    // The `closed` test in the blanking, whose other half (`span.length > 1`)
    // the length corpus pins. This half cannot show up as a length change: an
    // UNTERMINATED run's last character is treated as its closer, so the
    // content shrinks by one and a fill takes its place. Here that eats the
    // word after the hole and the finding with it.
    label: 'an unterminated backtick run does not treat its last character as a closer',
    source: 'const m = "Run `cdkd events <stack> x";',
    expect: ['open-hole'],
  },
  {
    // The `region.quoted` skip in the command-end walk: a sentence terminator
    // INSIDE a quoted value is not the end of the command. Every other quoted
    // value case here is terminator-free, so without this one the skip is free
    // to delete.
    label: 'a period inside a quoted VALUE does not end the command',
    source: 'const m = `Run cdkd deploy "a. b" --resource <id> --force`;',
    expect: ['open-hole'],
  },
  {
    // The other half of the sentence-boundary conjunction. The `!` and `?`
    // cases pin WHICH characters end a sentence; this pins that one of them
    // needs whitespace after it, or `us-east-1.amazonaws.com` and
    // `host.example` cut the command in two.
    label: 'a period with no space after it is not a sentence end',
    source: 'const m = `Run cdkd deploy host.example --resource <id> --force`;',
    expect: ['open-hole'],
  },
  {
    // The CLOSING side of the possessive heuristic, which the opening-side
    // cases do not reach: `'bucket's ...'` closes at the apostrophe in
    // `bucket's` unless the same rule is applied there too, and the hole then
    // falls outside the run and is reported.
    label: "a possessive does not CLOSE a run either",
    source: "const m = `Run cdkd deploy 'bucket's <stack> --all'`;",
    expect: [],
  },
  {
    // Only `+` CONCATENATES. A comparison joins nothing, so folding one
    // manufactures a message that no code path can emit — and the arithmetic
    // fixture cannot pin this, since it carries only `+`. Two cases, because
    // the operator is tested at the run's ROOT and again while flattening it.
    label: 'a comparison between literals is not folded (root)',
    source: "const m = `Run 'cdkd deploy ` === `${name}' now.`;",
    expect: [],
  },
  {
    label: 'a comparison nested inside a + run is not flattened into it',
    source: "const m = (`Run 'cdkd deploy ` === name) + `' now.`;",
    expect: [],
  },
  {
    // The fold's other literal KIND. Every concatenation fixture here used
    // template literals, so dropping `isStringLiteral` from the reconstructor
    // left this whole shape unexamined while the tree stayed clean.
    label: 'an ORDINARY-string concatenation folds like a template one',
    source: 'const m = "Run \'cdkd deploy " + name + "\' now.";',
    expect: ['quoted-command'],
  },
  {
    // The three decoded-NUL substitutions inside the FOLD are separate lines
    // from the ordinary walk's own three, and each needs its own case: read as
    // the marker, the NUL makes the span look assembled and manufactures a
    // finding from inert message content. One per reconstruction path, and the
    // note below counts them.
    label: 'a decoded NUL in a folded STRING literal is content, not a hole',
    source: 'const m = "\'cdkd deploy \\u0000\'" + "";',
    expect: [],
  },
  {
    label: 'a decoded NUL in a folded template HEAD is content, not a hole',
    source: 'const m = `\'cdkd deploy \\u0000\' ${x}` + "";',
    expect: [],
  },
  {
    label: 'a decoded NUL in a folded template SPAN is content, not a hole',
    source: 'const m = `${x} \'cdkd deploy \\u0000\'` + "";',
    expect: [],
  },
  {
    // The ORDINARY walk's two remaining NUL substitutions, which the folded
    // cases do not reach: a plain literal and a template HEAD outside any
    // `+` run. Its span path is covered by the quoted-span case above.
    //
    // SIX reconstruction paths carry the substitution — plain literal, template
    // head and template span, in each of the two walks — and each needs its own
    // case, because relaxing any one of them alone manufactures a finding from
    // inert message content while every other probe stays green. (This comment
    // said FOUR until review counted them; the count was written when only the
    // folded three plus one existed.)
    label: 'a decoded NUL in a plain literal is content, not a hole',
    source: 'const m = "\'cdkd deploy \\u0000\'";',
    expect: [],
  },
  {
    label: 'a decoded NUL in an unfolded template HEAD is content, not a hole',
    source: 'const m = `\'cdkd deploy \\u0000\' ${x}`;',
    expect: [],
  },
  {
    // M7's OTHER two shapes, one case each; both returned [] before this round.
    // The third -- a bare hole inside a prose-quoted command -- is NOT here,
    // and `blankInertText`'s single-quote arm says why: three attempts to
    // report it each reported an inert shape a critic then measured, so the
    // disagreement is recorded rather than approximated.
    //
    // First: a hole followed by a QUOTED hole. The trailing-character test used
    // to reject it, so the first hole's redirection went unseen.
    label: 'a bare hole followed by a QUOTED hole is still a redirection',
    source: "const m = `Run cdkd force-unlock <a> '<b>'`;",
    expect: ['open-hole'],
  },
  {
    // Second: DOTS in the name. `<stacks...>` is Commander's own variadic
    // rendering and redirects exactly as `<stack>` does -- measured under bash,
    // where it creates the file named by the next word.
    label: 'a DOTTED hole followed by a flag redirects like any other',
    source: 'const m = `Run cdkd state orphan <stacks...> --all`;',
    expect: ['open-hole'],
  },
  {
    // The single-quote arm of the blanking, and its only discriminator: inside
    // `'...'` a backtick is a LITERAL, so the substitution never happens and
    // the hole is inert. Without this case, deleting that arm reds nothing
    // (measured) -- the sibling arm would preserve the backtick run and the
    // fence would report a line a shell cannot execute.
    label: 'a backtick run inside SINGLE quotes is literal, so its hole is inert',
    source: 'const m = "Run cdkd deploy \'a `<stack> --all` b\'";',
    expect: [],
  },
  {
    // The REGION half of the backtick decision, which the blanking half does
    // not cover. A command inside backticks ENDS with them, so a hole in the
    // prose after it is not part of the command -- exactly the bound the
    // sentence-end rule serves for unquoted text. Without this case, deleting
    // the backtick from the delimiter set reds nothing (measured), because
    // blanking already preserves the run.
    label: 'a hole in the prose AFTER a backticked command is not inside it',
    source: 'const m = "Run `cdkd events` then edit <file> manually.";',
    expect: [],
  },
  {
    // The same rule from the OTHER side, and the one the first draft left
    // unpinned: here the verb comes FIRST and the hole follows a sentence end,
    // so only the command's own TAIL bound rejects it. Removing that bound
    // reddens nothing without this case (measured).
    label: 'a hole AFTER the command sentence ends is not inside the command',
    source: 'const m = `Run cdkd deploy MyStack. Then pass --resource <id> --force by hand.`;',
    expect: [],
  },
];

/**
 * A case that MUST fail, injected by `CDKD_SELF_PROBE_INJECT_MISMATCH=1`.
 *
 * Derived from the first accept case rather than written out, so it cannot
 * drift into agreeing with its own expectation.
 */
export const MISMATCH_CONTROL: ProbeCase = {
  label: 'injected control: a known-positive source declared to produce nothing',
  // `!`, not `?? ''`: the empty fallback would be an inert source with an
  // `expect: []` that PASSES, so the one case documented as "MUST fail" would
  // silently stop failing -- the twelfth clause removed here for guarding
  // nothing, and the only one whose fallback contradicted its own docstring.
  source: SELF_PROBE_CASES[0]!.source,
  expect: [],
};

/**
 * Run the self-probes.
 *
 * `CDKD_SELF_PROBE_FORCE_FAIL=1` is the seam proving the BINARY still consults
 * them, and `CDKD_SELF_PROBE_INJECT_MISMATCH=1` that it still READS their
 * verdicts. The unit suite reaches this function ONLY through a spawned run --
 * it used to call it directly, and that call was deleted because the probe set
 * carries a source reaching {@link blankInsideDoubleQuotes}'s termination
 * guard, so an in-process call would HANG a test worker under the mutant
 * instead of failing it.
 */
export function runSelfProbes(): string[] {
  const failures: string[] = [];
  if (process.env['CDKD_SELF_PROBE_FORCE_FAIL'] === '1') {
    failures.push('forced by CDKD_SELF_PROBE_FORCE_FAIL');
  }
  // A SECOND seam, and a different one. `FORCE_FAIL` appends its failure and
  // the loop below still runs -- it does not short-circuit, a claim review
  // corrected -- but the ASSERTION on it passes whether or not the comparison
  // works, so it proves the binary CALLS the probes and nothing about whether
  // it READS their verdicts. Review measured that: replacing the comparison
  // below with `false` left every case green. This seam injects a case whose
  // expectation is knowingly WRONG -- a real accept source declared to produce
  // nothing -- so the comparison itself has to run for the binary to report it.
  const cases =
    process.env['CDKD_SELF_PROBE_INJECT_MISMATCH'] === '1'
      ? [...SELF_PROBE_CASES, MISMATCH_CONTROL]
      : SELF_PROBE_CASES;
  for (const probe of cases) {
    const got = scanSource('probe.ts', probe.source)
      .findings.map((f) => f.shape)
      .sort();
    const want = [...probe.expect].sort();
    if (got.join(',') !== want.join(',')) {
      failures.push(`${probe.label}: expected [${want.join(', ')}], got [${got.join(', ')}]`);
    }
  }
  return failures;
}

/**
 * Match findings against exemptions, returning what survives and what has gone
 * STALE.
 *
 * Exported and taking its list as a PARAMETER so the mechanism can be exercised
 * in BOTH directions against a list a test controls. It was written when
 * `EXEMPTIONS` was empty and a `staleExemptions` assertion over the real tree
 * compared `[]` against `[]`, pinning nothing; the live list is no longer
 * empty, and the seam is still the only way to drive a near-miss per term.
 */
export function applyExemptions(
  findings: readonly PasteableFinding[],
  exemptions: typeof EXEMPTIONS
): { kept: PasteableFinding[]; stale: string[] } {
  const kept: PasteableFinding[] = [];
  const used = new Set<number>();
  for (const finding of findings) {
    const index = exemptions.findIndex(
      (e) =>
        e.file === finding.file && e.shape === finding.shape && finding.excerpt.includes(e.contains)
    );
    if (index === -1) kept.push(finding);
    else used.add(index);
  }
  return {
    kept,
    stale: exemptions.filter((_, i) => !used.has(i)).map((e) => `${e.file}:${e.shape}:${e.contains}`),
  };
}

/** Run the critic over a source root. */
export function checkPasteableCommandShapes(root: string): PasteableReport {
  const files = sourceFiles(root);
  const findings: PasteableFinding[] = [];
  let spansExamined = 0;
  let commandLiteralsExamined = 0;

  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    const result = scanSource(rel, readFileSync(file, 'utf8'));
    findings.push(...result.findings);
    spansExamined += result.spans;
    commandLiteralsExamined += result.commandLiterals;
  }

  const { kept, stale: staleExemptions } = applyExemptions(findings, EXEMPTIONS);

  return {
    findings: kept,
    filesScanned: files.length,
    spansExamined,
    commandLiteralsExamined,
    staleExemptions,
  };
}

/**
 * The CLI, and the reason `runSelfProbes` has a FORCE_FAIL seam at all.
 *
 * Without an entry point that calls it, the probes are a function the test
 * happens to invoke — they cannot fail a run, and the seam proves nothing
 * about enforcement. This runs them BEFORE the tree is read, so a classifier
 * that reports everything (leaving every floor satisfied and the counts
 * LARGER) dies on a known verdict rather than on a magnitude.
 *
 * Exit codes: 0 clean, 1 findings or stale exemptions, 2 the probes or a floor
 * failed — a distinction worth having, since the second means the critic is
 * broken rather than the tree.
 */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const rootFlag = argv.find((a) => a.startsWith('--root='))?.slice('--root='.length);
  const root = rootFlag ?? 'src';
  // The FLOORS attest that the REAL tree was read. They are meaningless over a
  // caller-supplied root -- a scratch tree of one file legitimately has one
  // file -- and applying them there turns every `--root=` run into exit 2, so
  // "the critic is broken" would swallow "this tree is dirty". Measured: the
  // dirty-tree case below reported 2 until this distinction existed.
  const enforceFloors = rootFlag === undefined;
  const probeFailures = runSelfProbes();
  if (probeFailures.length > 0) {
    for (const failure of probeFailures) process.stderr.write(`self-probe: ${failure}\n`);
    return 2;
  }
  const report = checkPasteableCommandShapes(root);
  // Test seams, and the only way to observe floor ENFORCEMENT: the real tree
  // always clears the floors, so nothing else distinguishes "enforced" from
  // "not enforced" (measured -- disabling enforcement left every case green).
  // ONE seam per floor, which review forced: with only the file seam, deleting
  // either of the other two clauses reddened nothing, so two thirds of the
  // "per SHAPE, not one aggregate" claim was itself unpinned.
  const floorFor = (env: string, fallback: number): number => {
    const raw = process.env[env];
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`check-pasteable-command-shapes: ${env}=${raw} is not a number`);
    }
    return parsed;
  };
  if (
    enforceFloors &&
    (report.filesScanned < floorFor('CDKD_PASTEABLE_FLOOR_FILES', FLOORS.filesScanned) ||
      report.spansExamined < floorFor('CDKD_PASTEABLE_FLOOR_SPANS', FLOORS.spansExamined) ||
      report.commandLiteralsExamined <
        floorFor('CDKD_PASTEABLE_FLOOR_COMMANDS', FLOORS.commandLiteralsExamined))
  ) {
    process.stderr.write(
      `floor not met: ${report.filesScanned} files, ${report.spansExamined} spans, ` +
        `${report.commandLiteralsExamined} command literals — the scan attests to nothing\n`
    );
    return 2;
  }
  for (const stale of report.staleExemptions) {
    process.stderr.write(`stale exemption (its target is gone): ${stale}\n`);
  }
  for (const f of report.findings) {
    process.stderr.write(`${f.file}:${f.line} [${f.shape}] ${f.excerpt}\n`);
  }
  if (report.findings.length > 0 || report.staleExemptions.length > 0) return 1;
  process.stdout.write(
    `check OK — ${report.filesScanned} files, ${report.spansExamined} quoted spans, ` +
      `${report.commandLiteralsExamined} command literals, 0 findings\n`
  );
  return 0;
}

// `endsWith` rather than an equality: the path arrives differently under a
// direct `node scripts/...` run and under a task runner.
if (process.argv[1]?.endsWith('check-pasteable-command-shapes.ts') === true) {
  process.exit(main());
}
