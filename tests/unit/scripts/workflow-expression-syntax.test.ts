/**
 * Issue [#3195](https://github.com/go-to-k/cdkd/issues/3195) — every `${{ … }}`
 * in `.github/workflows/**` must carry something the Actions expression parser
 * can read.
 *
 * WHY A FENCE AND NOT A REVIEW NOTE. go-to-k/cdkd#3173 added a step whose
 * `run:` body contained the SHELL COMMENT
 * `# … NOT interpolated with \`${{ }}\` — the same rule …`. Actions scans the
 * whole `run:` string for expression openers and does not care that one sits
 * behind a `#`, so the empty body is a parse error:
 *
 *     Invalid workflow file: .github/workflows/cfn-schema-refresh.yml#L1
 *     (Line: 588, Col: 14): An expression was expected
 *
 * One parse error invalidates the WHOLE file, so the daily schema-drift job
 * stopped being scheduled — the silent watch failure its own header says it
 * exists to prevent — and every push to every branch minted a zero-job failing
 * run. Nothing local caught it, and NOT for want of a workflow reader: plenty
 * of suites under `tests/unit/**` read these files, one of them
 * (`workflow-registration.test.ts`) `readdirSync`ing the whole directory and
 * `yaml`-parsing every file. No count is given, because two successive attempts
 * at one here were both wrong (2, then 7, against a measured 20-odd) and the
 * obvious `grep -rl '\.github/workflows' tests/unit` answers a DIFFERENT
 * question — files MENTIONING the path — over-counting a prose mention and
 * missing a reader that builds the path with `join`. What is load-bearing needs
 * no number: they read STRUCTURE and named literals, and the YAML is
 * WELL-FORMED, so the defect lives one layer further in, inside a scalar every
 * one of them parsed successfully.
 *
 * What makes it worth a fence rather than a one-line fix is that the SAME PROSE
 * sat twice more in the same file and was HARMLESS both times: two real YAML
 * comments, which never reach the expression parser at all. So the sequence was
 * correct on one line and fatal forty lines later, told apart only by whether
 * the reader had noticed they were inside a block scalar. A rule re-derived
 * from indentation on every edit is one that comes back, so this scans the RAW
 * TEXT and refuses the shape EVERYWHERE, YAML comments included — a deliberate
 * OVER-refusal, and the cheaper half of the trade. The alternative is a
 * comment-aware scanner that has to get right the same distinction a human just
 * got wrong, and the cost of the over-refusal is one reworded sentence.
 *
 * WHAT THE ORACLE IS. The PARSER'S question, not this repo's style preference:
 * a real opener in a `run:` body is legal and two exist on purpose
 * (`github.repository_owner` in the refresh's PR guard, `matrix.node-version`
 * in `ci.yml`'s runtime-compat job), so a blanket "no opener in a shell body"
 * would red on working code.
 *
 * It is a GRAMMAR check and not a character-set one, because a character set is
 * wrong in both directions at once and the review that measured it found both:
 *
 *   * it ACCEPTS punctuation-free prose. `${{ github expressions }}` and
 *     `${{ the same rule }}` — the nearest neighbours of the shipped defect,
 *     the same sentence with one word between the braces instead of none —
 *     carry the identical blast radius and passed a letters-and-spaces class.
 *   * it REJECTS ordinary Actions. `format('{0}-{1}', …)`,
 *     `fromJSON('{"a":1}')` and `steps.x.outputs.y || 'default: none'` all
 *     carry characters no reasonable class admits, so the first workflow to
 *     use one would red a CI-blocking fence with a false diagnosis.
 *
 * The token walk below settles both from one rule — operands and operators must
 * ALTERNATE — because prose is a run of adjacent operands while `{`, `}`, `:`
 * and `@` only ever appear inside a quoted string, which is one token.
 *
 * WHAT THIS FILE CANNOT PIN ABOUT ITSELF. Several helpers here exist so that a
 * hostile workflow file's bytes cannot forge a line in a CI log: `safeName`,
 * `safeRender`, `readWorkflow`, `setDifference`, `renderOffences`. Each has its
 * own cases, and mutating their BODIES reds — with the boundaries named beside
 * each case, since a claim of "every mutation" was measured false once and is
 * not worth making. Their WIRING did not red at all:
 * replacing a call with the raw expression it wraps — `readFileSync` instead of
 * `readWorkflow`, a bare list instead of `setDifference` — reds nothing,
 * measured.
 *
 * No ordinary case can close that, because the thing it would assert is the
 * thing being mutated. So the wiring is fenced by SHAPE instead: the block at
 * the end reads this file's own source and counts the exact TEXT of each raw
 * primitive. The members are NOT listed here — a list in two places is a list
 * that goes stale in one, which is what happened to the renderer count and then
 * again to this very sentence, which named six of the ten. Read the block; it
 * is one screen and each count carries the mistake it is there for.
 *
 * WHAT THOSE COUNTS DO AND DO NOT CATCH, stated exactly, because two earlier
 * versions of this paragraph overstated it and the second overstated it while
 * correcting the first. They catch the mistakes that ACTUALLY HAPPENED here,
 * every one of which was a subtraction: re-inlining a helper, applying a fix to
 * one of two readers, one of two lists, one of two conjuncts. They do NOT catch
 * an ADDITION written differently — `.at(i)` beside `[i]`, `readFileSync (join`
 * with a space, an aliased import, a renderer added after the marker, or a raw
 * second argument to an `expect`. All five were measured green.
 *
 * That is not a gap a textual count can close: any such count is satisfiable by
 * a spelling it does not name, which is why chasing it was abandoned rather
 * than iterated. The counts are a ratchet against regression, not a proof of
 * absence. Same instrument `scripts/check-source-control-bytes.ts` uses on the
 * tree, turned on one file, and with the same character.
 *
 * WHERE THIS STOPS, stated because the alternative is pretending otherwise.
 * Eleven renderers of one class — a hostile workflow file forging a line in the
 * CI log — were found across five review rounds, each by a different ad-hoc
 * search: reading the code, grepping every binding, running the suite against a
 * hostile file and reading the output bytes. Every one is closed and the counts
 * above make a twelfth of the SAME SHAPE red. What has no completeness argument
 * is the search itself: a renderer that prints file-derived text through some
 * construct none of those counts names would not be caught.
 *
 * That residual is accepted deliberately. The harm is a misleading line in the
 * log of an already-failing run on a PUBLIC repository's CI — no secret, no
 * write, no bypass of the fence's verdict, which is computed from the file and
 * not from what it prints. What the verdict does NOT cover is output VOLUME: a
 * renderer the counts do not reach could still be a size bomb, and its worst
 * case is a killed runner — a failing run failing louder, not a passing one.
 * Instance-hunting stopped here on that judgement rather than on exhaustion;
 * the structural half is the counts, and they are what a future reader should
 * extend if a new renderer is added.
 */
import { describe, expect, it } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

/**
 * One token of an Actions expression, in priority order: whitespace, a
 * single-quoted string (with `''` as the escape), a dotted context path, a
 * number, a two-character operator, then a one-character one.
 *
 * A path segment admits `-` because `ci.yml` writes `matrix.node-version` and
 * Actions accepts it. Nothing is lost if a future reader prefers to call that
 * subtraction: `a.node - version` is operand / operator / operand, which
 * alternates either way.
 */
const TOKEN =
  /\s+|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_-]*(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|\*))*|[0-9]+(?:\.[0-9]+)?|==|!=|<=|>=|&&|\|\||[<>!(),.[\]*+/%-]/y;

const OPEN = new Set(['(', '[']);
const CLOSE = new Set([')', ']']);
const INFIX = new Set([
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '<',
  '>',
  '*',
  '+',
  '-',
  '/',
  '%',
  ',',
  '.',
]);

/**
 * The documented roots of an Actions expression: every context, every built-in
 * function, and the three literals. A bare identifier that is none of these is
 * `Unrecognized named-value` to Actions, which invalidates the file exactly as
 * an empty body does.
 *
 * This is what closes the ONE-WORD hole, and the hole matters more than its
 * size suggests: `${{ expression }}` / `${{ opener }}` / `${{ context }}` is
 * the likeliest wording of a REINTRODUCTION — a future editor writing the very
 * sentence this fence exists because of, with one word between the braces
 * instead of none. The alternation rule cannot reach it, because one token is
 * not a run of adjacent operands.
 *
 * CONTEXTS AND FUNCTIONS ARE SEPARATE SETS, and collapsing them into one left
 * the hole half open. A function name is not a named VALUE: Actions answers
 * `Unrecognized named-value: 'format'` to `${{ format }}` and refuses the file
 * exactly as it does for the empty body. Seven of the twelve — `format`,
 * `join`, `contains`, `always`, `success`, `failure`, `cancelled` — are
 * ordinary English words, so a single set readmitted the very class this arm
 * exists to close. A function head therefore counts only when a `(` follows it.
 *
 * RESIDUAL: when GitHub adds a context or function, the first workflow to use
 * it reds here. That is an over-refusal on working code — the failure mode this
 * file's header is about — so that case gets its own message naming the remedy
 * (add the root) instead of calling the body prose. THREE messages, not two: a
 * root that is a known FUNCTION reached without a call gets its own, because
 * naming it as a missing root prints a remedy that changes nothing — the root
 * is already in the set — and the fence stays red under a true verdict and a
 * false diagnosis.
 *
 * Prose and a missing root are told apart by SHAPE, not by the word: a bare
 * one-word body is prose, and anything else is settled by re-reading the body
 * with the unrecognised roots allowed. Cost measured at zero: every body in
 * the tree leads with `github`,
 * `steps`, `secrets`, `cancelled`, `needs`, `matrix` or `join`, and cases below
 * pin the corpus heads AND every member of both sets, so neither can silently
 * stop matching.
 */
const CONTEXT_HEADS = new Set([
  'github',
  'env',
  'vars',
  'job',
  'jobs',
  'steps',
  'runner',
  'secrets',
  'strategy',
  'matrix',
  'needs',
  'inputs',
]);

const FUNCTION_HEADS = new Set([
  'contains',
  'startsWith',
  'endsWith',
  'format',
  'join',
  'toJSON',
  'fromJSON',
  'hashFiles',
  'success',
  'always',
  'cancelled',
  'failure',
]);

const LITERAL_HEADS = new Set(['true', 'false', 'null']);

/**
 * A refusal that also says WHY, so the two refusals can hand the reader
 * opposite remedies. `unknownRoot` means "this looks like an expression naming
 * something I do not know" — rewrite nothing, add the root; its absence means
 * prose.
 */
type Verdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** An identifier in value position that no root set knows. */
      readonly unknownRoot?: string;
      /** A root that IS a known function, reached without a call. */
      readonly uncalledFunction?: string;
    };

/**
 * Whether `body` could be an Actions expression, and if not, which kind of not.
 *
 * DELIBERATELY PERMISSIVE where it is unsure — it accepts a TRAILING empty
 * argument (`format(github.sha,)`, `(github.sha,)`), which no grammar does. A
 * LEADING one (`format(,github.sha)`, `(,github.sha)`) is refused, at the arm
 * that refuses a body opening with an operator. The asymmetry is measured
 * rather than designed, and the examples are spelled with a real root on
 * purpose: written as `(a,)` / `f(,b)` the sentence became FALSE the moment the
 * root check landed, since `a` and `f` are not roots — which is the third time
 * a bound in this file was stated opposite to the measurement.
 *
 * Permissiveness is the safe direction for a fence: an over-acceptance costs
 * the coverage of a shape nobody writes, while an over-refusal reds CI on
 * working code with a message blaming the author. What it must never do is
 * accept two operands in a row, because that is what prose is.
 */
export const analyseExpression = (
  body: string,
  /**
   * Read the body as if every unrecognised root were a documented one: the walk
   * continues past each instead of returning at the first.
   *
   * That is how the caller asks "is this shaped like a real reference, with
   * only the root missing, or is it prose?" in a CONSTANT number of reads.
   * Asking one root at a time needed a loop and was quadratic in
   * attacker-controlled input — measured 35.5 s on a 200 KB body of distinct
   * roots against 0.02 s for every other 200 KB shape, four-fold per doubling —
   * and `ci.yml` runs on `pull_request` with no `timeout-minutes`, so a fork PR
   * adding one large workflow file burned runner-hours up to the six-hour
   * ceiling. Vitest cannot preempt it either: a synchronous loop runs to
   * completion and the 5 s `testTimeout` only reports afterwards.
   *
   * A BOOLEAN, after two rounds of being a Set — and the two rounds were dead
   * in OPPOSITE ways. As `extraRoots` the walker DID read it (`extraRoots.has`
   * opened the `known` disjunction); it died when the loop that populated it
   * went away and every caller started passing an empty set. As `collect` it
   * was populated and never read. Only the second was write-only, and an
   * earlier version of this paragraph claimed both were.
   *
   * It does NOT make prose readable: `the same rule` still refuses, because
   * `same` then arrives where an operator is due.
   */
  treatUnknownRootsAsKnown = false,
): Verdict => {
  TOKEN.lastIndex = 0;
  let at = 0;
  let expect: 'operand' | 'operator' = 'operand';
  let depth = 0;
  // Whether the token now due is a PROPERTY rather than a root. The path token
  // swallows `a.b.c` whole, but a `.` after a `)` or `]` arrives on its own —
  // `fromJSON(x).a`, `fromJSON(x).*.name` — and the identifier after it names a
  // member, not a context.
  let afterDot = false;
  let seen = 0;
  while (at < body.length) {
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(body);
    // No token matches here, so the body carries a character that appears in no
    // expression outside a string — `#`, `$`, `{`, `"`, an em dash, a backtick.
    if (m === null) return { ok: false };
    at = TOKEN.lastIndex;
    const tok = m[0];
    if (/^\s+$/.test(tok)) continue;
    const wasAfterDot = afterDot;
    const isFirst = seen === 0;
    seen++;
    // ONE assignment for the whole loop. Set per-branch it leaked through every
    // arm that `continue`s early (`!`, a unary sign, `*`, `(`), which let
    // `github.x . ( prose )` through — and the single line that cleared it was
    // itself unobservable, since no case distinguished it.
    afterDot = tok === '.';
    if (expect === 'operand') {
      if (tok === '!') continue;
      // Unary sign: `${{ -1 }}`, `${{ x > -1 }}`. Legal Actions (JSON numbers).
      if (tok === '-' || tok === '+') continue;
      // An object filter reached from a call or an index: `fromJSON(x).*.name`.
      // Inside a path the `*` belongs to the path token; after a `)` or `]` it
      // arrives on its own.
      if (tok === '*') {
        expect = 'operator';
        continue;
      }
      if (OPEN.has(tok)) {
        depth++;
        continue;
      }
      // An empty argument list: `always()` reaches `)` still expecting an
      // operand. Only inside a group — a bare `)` is unbalanced.
      if (CLOSE.has(tok)) {
        if (depth === 0) return { ok: false };
        depth--;
        expect = 'operator';
        continue;
      }
      if (INFIX.has(tok)) return { ok: false };
      // An identifier or dotted path in VALUE position. Strings and numbers are
      // exempt — they are literals, not named values — and so is a member name
      // reached through a `.`.
      if (!wasAfterDot && /^[A-Za-z_]/.test(tok)) {
        const root = tok.split('.')[0]!;
        // A function is a name Actions only accepts when CALLED. Bare, it is an
        // unrecognized named-value like any other word, and SEVEN of the twelve
        // are ordinary English (`format`, `join`, `contains`, `always`,
        // `success`, `failure`, `cancelled`).
        const called = /^\s*\(/.test(body.slice(at));
        const known =
          CONTEXT_HEADS.has(root) ||
          LITERAL_HEADS.has(tok) ||
          (FUNCTION_HEADS.has(tok) && called);
        if (!known) {
          // A known FUNCTION reached without a call is its own case. Reporting
          // it as an unknown root names a root that IS in the set, so the
          // remedy it prints ("add it") changes nothing and the fence stays
          // red — a true verdict under a false diagnosis. Covers both
          // `${{ format }}` and `${{ always.foo }}`.
          if (FUNCTION_HEADS.has(root)) return { ok: false, uncalledFunction: root };
          // A BARE one-word body is prose, full stop — no context is ever used
          // that way, and this is the headline reintroduction wording, where
          // saying "add the root" would permanently re-open the hole. Anything
          // with more shape (a dotted path, or a word among others) MIGHT be a
          // root GitHub has newly documented; the caller settles which by
          // re-reading the body with this root allowed.
          const bareWord = isFirst && !tok.includes('.') && body.slice(at).trim() === '';
          if (bareWord) return { ok: false };
          if (treatUnknownRootsAsKnown) {
            expect = 'operator';
            continue;
          }
          return { ok: false, unknownRoot: root };
        }
      }
      expect = 'operator';
      continue;
    }
    // A call or an index: `format(` / `github.event['x']`.
    if (OPEN.has(tok)) {
      depth++;
      expect = 'operand';
      continue;
    }
    if (CLOSE.has(tok)) {
      if (depth === 0) return { ok: false };
      depth--;
      continue;
    }
    if (INFIX.has(tok)) {
      expect = 'operand';
      continue;
    }
    // Two operands in a row — the prose shape.
    return { ok: false };
  }
  return expect === 'operator' && depth === 0 ? { ok: true } : { ok: false };
};

export const isReadableExpression = (body: string): boolean => analyseExpression(body).ok;

/**
 * Every `${{ … }}` in `source`, as (opener index, closer index, body).
 *
 * ONE walk, shared by the scanner and by the corpus the grammar cases are
 * measured against. They were separate and DISAGREED: the corpus kept an
 * earlier `at + 3` resume, so a workflow writing `format('${{', github.sha)`
 * left the scanner clean while the corpus case redded on the manufactured body
 * `', github.sha) ` — a false red on legal Actions, the direction this file's
 * header calls dangerous.
 *
 * Resuming after the CLOSER is the reading Actions takes. An opener nested
 * inside a swallowed body is not lost: either it sits in a quoted string, where
 * it is literal text, or the body that swallowed it carries a `$` and a `{` and
 * is itself refused.
 */
const forEachExpression = (
  source: string,
  visit: (at: number, close: number, body: string) => void,
): void => {
  let at = source.indexOf('${{');
  while (at !== -1) {
    const close = source.indexOf('}}', at + 3);
    if (close === -1) {
      // No later opener can find a closer either — `indexOf` is monotonic — so
      // there is nothing after this worth scanning for.
      visit(at, -1, '');
      return;
    }
    visit(at, close, source.slice(at + 3, close));
    at = source.indexOf('${{', close + 2);
  }
};

/**
 * Everything that can move the cursor, break the line, or reorder it, collapsed
 * to one space: whitespace (including the Unicode line separators), every C0
 * and C1 control byte, DEL, and every bidi control — the overrides, the
 * isolates, the marks, and the Arabic letter mark.
 *
 * The codepoints are tested by VALUE and the rest by `/\s/`, with no
 * backslash-u escape anywhere — one typed into this file is exactly how a raw
 * NUL got into the source twice while writing this very helper, the second
 * time inside the comment warning about it. grep and rg then classify the whole
 * file as BINARY and skip it at exit 0, which is the class
 * scripts/check-source-control-bytes.ts exists for.
 *
 * THREE separate reasons, because the first version of this covered only one
 * and its comment claimed all of them:
 *   * `/\s/` alone does not reach ESC, and raw ESC-bracket-1A ESC-bracket-2K
 *     is cursor-up plus erase-line, overwriting the line above the finding;
 *   * a codepoint test alone does not reach U+00A0, U+2028, U+2029, U+3000,
 *     U+FEFF and the rest of Unicode whitespace — and U+2028 / U+2029 ARE line
 *     separators to a Unicode-aware log reader, so dropping them from the
 *     class put the forged second line straight back;
 *   * neither reaches a bidi control, which reorders the rendered line in any
 *     bidi-aware renderer (the Trojan-source shape). That one was open in both
 *     earlier versions, and a later one covered only the OVERRIDES while the
 *     marks and U+061C went through — as did U+0085, a line break that is
 *     neither `<= 0x20` nor `\s` and which `JSON.stringify` leaves alone.
 */
const flatten = (s: string): string => {
  let out = '';
  let blank = false;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    const unsafe =
      code <= 0x20 ||
      // DEL, and the C1 range: U+0085 is NEL, a line break to a Unicode-aware
      // reader, and it is neither `<= 0x20` nor `\s`.
      (code >= 0x7f && code <= 0x9f) ||
      // Every bidi control, not only the overrides: the marks (U+200E, U+200F,
      // U+061C) and the isolates reorder a rendered line too.
      code === 0x61c ||
      (code >= 0x200e && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      /\s/.test(ch);
    if (unsafe) {
      if (!blank) out += ' ';
      blank = true;
    } else {
      out += ch;
      blank = false;
    }
  }
  return out;
};

/**
 * A file name as it may appear in a finding.
 *
 * CONSTRAINED, not flattened — the distinction cost two rounds. `flatten` is a
 * control-byte guard, and a workflow file can be named in PURE ASCII that reads
 * as a complete finding against a different file. A tracked file called
 *
 *     ci.yml:412: empty expression body - and no more - hooks.yml
 *
 * passes the `.ya?ml` filter, passes the tracked-set equality case, is a
 * `flatten` no-op, and renders a line opening as a false report about `ci.yml`.
 * The example is spelled with ASCII hyphens on purpose: written with em dashes
 * it was neither pure ASCII nor able to pass the tracked-set case, because
 * `git ls-files` C-quotes a non-ASCII path and the two listings then disagree —
 * a comment that did not exhibit the shape it described.
 *
 * A real workflow file name is a short, dull thing. Anything else is quoted, so
 * it can only ever be read as one field, and clamped on that arm — a name that
 * PASSES is emitted whole, which is bounded only by the filesystem's 255 and is
 * a cost rather than a hazard. Said plainly because an earlier version of this
 * sentence claimed a bound the accept path does not have.
 */
const WORKFLOW_NAME = /^[A-Za-z0-9._-]+\.ya?ml$/;
const safeName = (name: string): string =>
  WORKFLOW_NAME.test(name) ? name : JSON.stringify(flatten(name).slice(0, 120));

/**
 * Any fork-controlled string, rendered so it cannot forge a second line or
 * erase the one above: flattened and clamped, with the clip marked.
 *
 * NOT identical to `excerpt`, though they look it: `excerpt` clamps the raw
 * slice and then flattens, marking the clip from the RAW extent, while this
 * flattens first and marks from the flattened length. On whitespace-heavy input
 * they disagree about whether a clip happened. The duplication is deliberate —
 * `excerpt`'s marker needs the un-flattened end offset, and flattening 80 KB to
 * take 120 characters is the cost its own comment cites.
 *
 * Hoisted to module scope because renderers of this one forgery were found and
 * closed ONE AT A TIME — the excerpt, the root, the finding's file field, the
 * test title, the tracked-set difference, Node's `ENOENT`, the corpus bodies,
 * the corpus heads, the probe lines — and each fix reached exactly the field it
 * was written for. The header's "WHERE THIS STOPS" carries the count and the
 * residual; it is not repeated here, because a number in two places is a number
 * that goes stale in one (this sentence said "six" for two rounds after it was
 * eleven). Anything that prints a workflow's bytes or its name goes through
 * this or through `safeName`.
 */
const safeRender = (s: string): string => {
  const flat = flatten(s);
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
};

/**
 * Read a workflow, naming it SAFELY if the read fails.
 *
 * Node puts the raw path in an `ENOENT`, which is this forgery one layer below
 * the fields the offence renders — reachable through a dangling symlink, which
 * git tracks and `readdirSync` lists.
 *
 * The original error is NOT attached as `cause`: vitest prints a cause chain in
 * its own `Caused by:` block, raw, so attaching it moved the forgery down two
 * lines rather than closing it. The `code` is what a reader needs and is the
 * only part that cannot carry a path.
 */
export const readWorkflow = (name: string): string => {
  try {
    return readFileSync(join(WORKFLOW_DIR, name), 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code ?? 'no code';
    throw new Error(`could not read workflow ${safeName(name)}: ${code}`);
  }
};

/**
 * The two listings' difference, COMPARED raw so the check stays exact and
 * RENDERED through `safeName` so a failure cannot forge a line.
 *
 * Extracted rather than written inline because inline it could not be pinned:
 * the rendering only matters when the sets DISAGREE, and on a healthy tree they
 * never do — reverting it to a raw `toEqual` of both lists redded nothing.
 *
 * Not a hypothetical, either: `git ls-files` output is split on newlines, so a
 * newline-bearing path can never reconstruct, the sets ALWAYS mismatch, and the
 * assertion is guaranteed to fail and guaranteed to print.
 *
 * KNOWN BOUND: `includes` collapses duplicates, so two identical names on one
 * side and one on the other compare equal where the `sort()` + `toEqual` this
 * replaced would have differed. It costs nothing WHILE the directory is flat:
 * `readdirSync` yields distinct names, and `git ls-files` RECURSES, so a
 * workflow in a subdirectory would reduce to a basename that could collide.
 * There is none today. Two earlier attempts at this sentence were both wrong —
 * "basenames from a flat directory" ignored the recursion, and "paths that are
 * themselves distinct" does not imply distinct basenames — so the condition is
 * named here rather than the reason. Stated at all because the docstring once
 * said the comparison "stays exact", which is true of the CONTENT and not of
 * the multiplicity.
 */
export const setDifference = (
  found: readonly string[],
  tracked: readonly string[],
): { missing: string[]; extra: string[] } => ({
  missing: tracked.filter((t) => !found.includes(t)).map(safeName),
  extra: found.filter((f) => !tracked.includes(f)).map(safeName),
});

/**
 * Where the wiring fence stops reading. Everything BEFORE this string is the
 * code that fence judges; the fence's own assertions sit after it, and must not
 * be counted as uses of the things they name.
 */
const WIRING_FENCE_MARKER = 'the sanitising helpers are actually wired in';

/** How many findings one file may print before the rest become a count. */
const MAX_RENDERED_OFFENCES = 20;

/**
 * Findings as lines, BOUNDED in number as well as in width.
 *
 * Every field is already clamped, but the count was not: a 1 MB file of empty
 * openers yields ~131 k findings and ~18 MB of output, which buries everything
 * else the run printed. The overflow is reported as a count so nothing is
 * silently dropped.
 */
export const boundedList = (lines: readonly string[]): string[] =>
  lines.length > MAX_RENDERED_OFFENCES
    ? [
        ...lines.slice(0, MAX_RENDERED_OFFENCES),
        `… and ${lines.length - MAX_RENDERED_OFFENCES} more`,
      ]
    : [...lines];

export const renderOffences = (offences: readonly Offence[]): string[] =>
  boundedList(offences.map((o) => `${o.file}:${o.line}: ${o.reason} — ${o.text}`));

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
  readonly text: string;
}

/**
 * Scans RAW TEXT rather than the parsed document, because the two places the
 * sequence can appear — a YAML comment and a block scalar — are
 * indistinguishable after parsing in the direction that matters: the comment is
 * simply gone. Reading the text is what lets a case say WHERE it is, which is
 * the whole difficulty of the class.
 */
export const findExpressionOffences = (rawFile: string, source: string): Offence[] => {
  const offences: Offence[] = [];
  // The NAME is a forgery surface too, and it was the field left open when the
  // excerpt was clamped — the same defect one field over, measured in a real
  // vitest run. Flattening it was the FIRST attempt and it was not enough: see
  // `safeName`, which constrains the shape instead.
  const file = safeName(rawFile);
  /**
   * Line starts, computed ONCE. The obvious `source.slice(0, i).split('\n')`
   * is O(offences x bytes): measured 2026-09-16 at 15 s on a 256 KB file of
   * repeated empty openers, which a fork PR could hand to CI. Unreachable on a
   * tree that PASSES — a clean tree has no offences at all — so this is about
   * the run that reports a real defect. The figure is a DATED measurement, not
   * a pinned one: what a case can hold is the offence COUNT, which the
   * dangling-opener and nested-opener cases below do.
   */
  const lineStarts = [0];
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) {
    lineStarts.push(i + 1);
  }
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  /**
   * A quoted excerpt, CLAMPED and single-line.
   *
   * The raw slice was a forgery surface (a body carrying a newline rendered a
   * second line reading as a finding against another file) and, on the tree it
   * was written against, a size bomb: with the `at + 3` resume of 84a5848f,
   * 20k openers sharing one trailing `}}` (80 KB in) produced ~800 M characters
   * and the assertion threw `Invalid string length` INSTEAD of reporting.
   *
   * THAT BOMB IS GONE, and the date on the measurement was wrong for the tree
   * it named: the single forward pass landed in the same commit as the clamp,
   * and re-measured with the clamp removed at 461c2211 the same input yields
   * one offence of 80,002 characters. What still justifies the clamp is the
   * ordinary case — an offence per line of a large file, each quoting its whole
   * line — plus the forgery half, which no resume point touches.
   */
  const excerpt = (from: number, to: number): string => {
    const end = Math.min(to, source.length);
    const raw = flatten(source.slice(from, Math.min(end, from + 120)));
    return end > from + 120 ? `${raw}…` : raw;
  };
  forEachExpression(source, (at, close, body) => {
    if (close === -1) {
      offences.push({
        file,
        line: lineOf(at),
        reason: 'expression opener is never closed',
        // To END OF FILE, not to a fixed window. Two earlier attempts at this
        // line both clipped at exactly the ellipsis threshold — first 60, then
        // 120 — which makes `end > from + 120` false by construction, so the
        // arm truncated silently and a clipped excerpt read as complete. The
        // second attempt shipped a comment asserting the opposite.
        text: excerpt(at, source.length),
      });
      return;
    }
    if (body.trim() === '') {
      offences.push({
        file,
        line: lineOf(at),
        // The MEASURED message, from the run that reported the shipped defect.
        reason:
          'empty expression body — inside a `run:` body Actions answers "An expression was expected" and refuses the whole file',
        text: excerpt(at, close + 2),
      });
      return;
    }
    const verdict = analyseExpression(body);
    if (!verdict.ok) {
      // Does the body read as an expression once the unrecognised roots are
      // allowed? If yes it is shaped like a real reference and the roots are
      // the only thing missing; if no, the shape is prose and naming a root
      // would send the reader after the wrong thing.
      //
      // ITERATED, because a body can name more than one. Two narrower versions
      // were each wrong on an ordinary condition: substituting the single
      // occurrence at a recorded offset failed `newctx.a == newctx.b` (same
      // root twice), and allowing one root failed `newa.foo && newb.bar`.
      //
      // ONE extra read, whatever the body names. Asking the question a root at
      // a time needed a loop, and every bound on that loop was wrong in one
      // direction or the other: a `round < 10` count was not outcome-neutral
      // (eleven distinct roots fell to the PROSE message), and a
      // progress-bounded loop was quadratic in attacker-controlled input,
      // re-tokenising the whole body per root. Reading once with every
      // unrecognised root treated as known settles it in constant cost, and
      // leaves no loop to terminate.
      //
      // `verdict` — the read WITHOUT that relaxation — stays the guard, so the
      // second read can only choose the message, never clear an offence.
      // Annotated because `verdict` is narrowed to the refusing arm here while
      // the re-read may well succeed.
      let probe: Verdict = verdict;
      let plausibleRoot = false;
      if (verdict.unknownRoot !== undefined) {
        probe = analyseExpression(body, true);
        plausibleRoot = probe.ok;
      }
      // The two refusals want OPPOSITE actions from the reader — rewrite the
      // prose, or add a root GitHub has newly documented — so a single message
      // would be a false diagnosis for one of them. The walker decides which,
      // at the token it actually refused: deriving it from the body's FIRST
      // token instead told the bare one-word case — the headline
      // reintroduction wording — to add `expression` to the root set, which
      // would have permanently re-opened the hole this arm closes.
      // `probe` alone, not `verdict.uncalledFunction ?? probe.uncalledFunction`.
      // That first arm was REDUNDANT rather than unreachable, and the
      // difference is worth stating because the earlier wording of this comment
      // got it backwards: when `verdict` names an uncalled function it also has
      // no `unknownRoot`, so the re-read never happens and `probe` IS
      // `verdict`. The chain could only ever agree with itself.
      //
      // Only the ROOT is clamped. A root is attacker-supplied and can be
      // 200 k characters; an uncalled function is a member of `FUNCTION_HEADS`,
      // so it is at most ten, and clamping it was dead code whose comment
      // claimed a bound it did not need.
      const namedFn = probe.ok ? undefined : probe.uncalledFunction;
      const namedRoot = verdict.unknownRoot?.slice(0, 60);
      offences.push({
        file,
        line: lineOf(at),
        reason:
          namedFn !== undefined
            ? `expression body names \`${namedFn}\`, an Actions FUNCTION, which is a value only when called — bare it is "Unrecognized named-value" and refuses the whole file. Write \`${namedFn}(…)\`, or if this is prose in a comment, say it in words`
            : plausibleRoot
              ? `expression body names \`${namedRoot}\`, which is no Actions context or function — Actions answers "Unrecognized named-value" and refuses the whole file. If GitHub has added it, add it to CONTEXT_HEADS or FUNCTION_HEADS`
              : 'expression body is prose, not an expression — inside a `run:` body this refuses the whole file the same way an empty one does',
        text: excerpt(at, close + 2),
      });
    }
  });
  return offences;
};

const workflowFiles = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name));

/**
 * Every expression body the repository actually writes, through the SAME walk
 * the scanner uses — two walks with different resume points disagreed about
 * what an expression even is.
 */
const bodies = workflowFiles.flatMap((name) => {
  // `readWorkflow`, not a raw read. This is the UN-HARDENED TWIN the previous
  // round left behind: it runs at COLLECTION time, before any case registers,
  // so the guarded read one screen down was unreachable and a dangling symlink
  // collapsed the suite to `(0 test)` with a forged path on the way out —
  // forged AND the fence disabled. A fence applied to one of two readers is the
  // shape this file keeps rediscovering.
  const source = readWorkflow(name);
  const found: string[] = [];
  forEachExpression(source, (_at, close, body) => {
    if (close !== -1) found.push(body);
  });
  return found;
});

describe('workflow expression syntax', () => {
  /**
   * CAPACITY, from two directions because either alone goes quiet. A floor
   * catches a read that came back empty; it does NOT catch a read that came
   * back SHORT, and a floor set to today's count would red on the next
   * legitimate deletion — the ratchet this repo has been bitten by. So the SET
   * is compared against what git tracks, which cannot drift, and the floor is
   * left loose to cover the case where BOTH reads collapse together.
   */
  it('reads every workflow file the repository tracks', () => {
    expect(workflowFiles.length).toBeGreaterThanOrEqual(8);
    const tracked = execFileSync('git', ['ls-files', '--', '.github/workflows'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((p) => /\.ya?ml$/.test(p))
      .map((p) => p.slice(p.lastIndexOf('/') + 1));
    expect(setDifference(workflowFiles, tracked)).toEqual({ missing: [], extra: [] });
  });

  /**
   * The TEST TITLE renders the name too, and it was the last field still raw —
   * `it.each(workflowFiles)('%s …')` interpolates it unescaped, so a file named
   * with a newline printed the same forged second line `safeName` closes in the
   * finding, and a raw ESC in a name erased the line above (where a sibling
   * failure prints). Measured in a real vitest run. The safe name titles the
   * case; the raw one still opens the file.
   */
  it.each(workflowFiles.map((name) => [safeName(name), name]))(
    '%s carries no unreadable expression',
    (_title, name) => {
      const source = readWorkflow(name);
      const offences = findExpressionOffences(name, source);
      expect(
        // The first 20 only. Each line is clamped, but the COUNT is not: a
        // 1 MB file of empty openers is 131 k findings and ~18 MB of output,
        // which buries the rest of the run. Twenty is enough to act on, and the
        // total says how many more there are.
        renderOffences(offences),
        'an expression Actions cannot read invalidates the ENTIRE workflow file, so the job simply stops being scheduled. A real YAML comment is refused too, deliberately: write "expression" in words there — the header says why',
      ).toEqual([]);
    },
  );

  /**
   * The grammar's ACCEPT side, measured against the corpus rather than against
   * examples chosen to suit it. Without this a validator that refused
   * everything would still pass every case above on a clean tree, since a clean
   * tree's offence list is empty either way — only real bodies discriminate.
   */
  describe('accepts every expression the repository actually writes', () => {
    it('found a corpus worth checking', () => {
      // Measured 2026-09-16 at 86. Floored well under, since the number moves
      // with ordinary workflow edits; its job is to catch a collapse to zero,
      // which would make every case below vacuous.
      expect(bodies.length).toBeGreaterThanOrEqual(40);
    });

    it('every one of them is readable', () => {
      // RENDERED, not raw. `bodies` holds verbatim file bytes, and this
      // assertion prints them on exactly the run that reports a real defect —
      // so an unsanitised body here erases the sanitised findings printing
      // beside it. Measured against the real file: a raw newline and a live
      // `ESC[1A ESC[2K`. Unclamped, one body can be the whole file.
      //
      // BOUNDED IN COUNT as well as in width, through the same helper the
      // per-file arm uses. Mapping alone left the count free, and this list
      // aggregates the whole DIRECTORY — 1 MB of empty openers is ~105 k
      // elements, worse than the arm that was bounded first. One of two lists,
      // again.
      expect(boundedList(bodies.filter((b) => !isReadableExpression(b)).map(safeRender))).toEqual(
        [],
      );
    });
  });

  /**
   * The shapes the corpus does not contain, so the grammar is not calibrated
   * only against what happens to be in the tree today. The rejects are the half
   * that matters: they are what a permissive validator gets wrong.
   */
  describe('grammar, on shapes outside the corpus', () => {
    it.each([
      "format('{0}-{1}', github.repository, github.sha)",
      'fromJSON(\'{"a":1}\').a',
      "steps.x.outputs.y || 'default: none'",
      "contains(github.event.pull_request.labels.*.name, 'skip')",
      '!cancelled() && needs.build.result == \'success\'',
      "github.event.issue.user.login == 'dependabot[bot]'",
      'matrix.node-version',
      "toJSON(fromJSON(steps.x.outputs.y)['a'])",
      // A PARENTHESISED SUB-EXPRESSION. No body in the corpus opens a group in
      // operand position, so without this case the arm that handles one had no
      // coverage at all — deleting its `depth++` made the grammar REJECT every
      // grouped condition while all 37 cases stayed green. That is exactly the
      // over-refusal the header says this design exists to avoid.
      "(github.event_name == 'push') && github.actor != 'dependabot[bot]'",
      "!(github.ref == 'refs/heads/main')",
      // Unary sign and a filter off a call result: legal Actions. `-` and `+`
      // need one case EACH — dropping only the `+` half redded nothing, since
      // every other case exercises `-`.
      'github.run_attempt > -1',
      'github.run_attempt > +1',
      // The standalone `*` arm, reached where a filter follows a CALL. In
      // `contains(...labels.*.name, ...)` above, `.*` is swallowed by the path
      // token instead — so that case exercises a different route to the same
      // verdict, and deleting `|\*` from the path alternative reds nothing.
      // That is an EQUIVALENT mutation, not a coverage gap: with the
      // alternative gone the standalone arm absorbs the filter and the answer
      // is unchanged. Recorded because the comment here used to claim the case
      // above proved the path alternative, which it does not.
      'fromJSON(steps.x.outputs.y).*.name',
      // A trailing empty argument — the permissiveness the docstring claims.
      // Spelled with a real root: `f(a,)` would be refused by the root check,
      // which is what made the earlier wording of that claim false.
      'format(github.sha,)',
      '(github.sha,)',
      // The call test tolerates space before the paren, so the bare-function
      // refusal must not fire here. Nothing pinned that tolerance.
      'always ()',
      // THE OVER-REFUSAL DIRECTION, which is the one this file's header calls
      // dangerous and the one that had the least coverage. Each of these dies
      // if a single member is dropped from `TOKEN` or `INFIX` — and dropping
      // one makes ORDINARY Actions read as prose, which reds CI on working
      // code with a message blaming the author.
      'github.run_number >= 2',
      'github.run_number <= 2',
      'github.run_number % 2',
      'github.run_number / 2',
      "format('{0}', 'it''s')",
      // A leading `_` reaches the token regex only as a MEMBER name: no
      // documented context starts with one, so the root check refuses
      // `_private.value` — correctly, and that is its own reject case below.
      'github.event._private',
      'github.event.commits.*.message',
    ])('accepts %s', (body) => {
      expect(isReadableExpression(` ${body} `)).toBe(true);
    });

    /**
     * Every member of both root sets, so a root that stops being recognised is
     * caught BY NAME. Sixteen of the twenty-seven redded nothing when removed,
     * and removal causes OVER-refusal — the direction this file's header calls
     * the dangerous one.
     *
     * The expectations are LITERAL lists, not `[...CONTEXT_HEADS]`: a case
     * derived from the set it guards disappears with the member it was meant to
     * catch, which is a fence built out of its own remedy. The equality case
     * below is what makes the literals non-stale in the other direction — a
     * root ADDED to a set with no case reds there.
     *
     * The two sets are exercised DIFFERENTLY on purpose, which is the whole
     * distinction the blocker was about: a context is a value, a function is
     * only a name when called.
     */
    const EXPECTED_CONTEXTS = [
      'github',
      'env',
      'vars',
      'job',
      'jobs',
      'steps',
      'runner',
      'secrets',
      'strategy',
      'matrix',
      'needs',
      'inputs',
    ];
    const EXPECTED_FUNCTIONS = [
      'contains',
      'startsWith',
      'endsWith',
      'format',
      'join',
      'toJSON',
      'fromJSON',
      'hashFiles',
      'success',
      'always',
      'cancelled',
      'failure',
    ];
    const EXPECTED_LITERALS = ['true', 'false', 'null'];

    it('pins both root sets by name', () => {
      expect([...CONTEXT_HEADS].sort()).toEqual([...EXPECTED_CONTEXTS].sort());
      expect([...FUNCTION_HEADS].sort()).toEqual([...EXPECTED_FUNCTIONS].sort());
      expect([...LITERAL_HEADS].sort()).toEqual([...EXPECTED_LITERALS].sort());
    });

    it.each(EXPECTED_CONTEXTS)('accepts the `%s` context', (root) => {
      expect(isReadableExpression(` ${root}.some_property `)).toBe(true);
      expect(isReadableExpression(` ${root} `)).toBe(true);
    });

    it.each(EXPECTED_FUNCTIONS)('accepts `%s` called and refuses it bare', (fn) => {
      expect(isReadableExpression(` ${fn}(github.sha) `)).toBe(true);
      // The blocker: bare, a function name is `Unrecognized named-value` and
      // invalidates the file. Seven of the twelve are ordinary English words, so
      // one set for both readmitted the prose class this arm exists to close.
      expect(isReadableExpression(` ${fn} `)).toBe(false);
      // The membership test is on the WHOLE token, not its root. Testing the
      // root instead accepts `format.x(github.sha)`, which Actions rejects as
      // `Unrecognized named-value` — over-acceptance, the fence going blind.
      expect(isReadableExpression(` ${fn}.x(github.sha) `)).toBe(false);
    });

    it.each(EXPECTED_LITERALS)('refuses `%s` as a dotted root', (literal) => {
      // The literal test is on the WHOLE token too. Testing the root instead
      // accepts `${{ true.foo }}`. The FUNCTION twin of this was pinned two
      // rounds ago and the literal one was not — one of two, again.
      expect(isReadableExpression(` ${literal}.foo `)).toBe(false);
    });

    it.each(EXPECTED_LITERALS)('accepts the `%s` literal', (literal) => {
      expect(isReadableExpression(` github.ref == ${literal} `)).toBe(true);
    });

    it.each([
      ['empty', ''],
      ['blank', '   '],
      // The nearest neighbours of the shipped defect: the same sentence with a
      // word between the braces instead of nothing. A character-set oracle
      // passed all four.
      ['prose, two words', ' github expressions '],
      ['prose, three words', ' the same rule '],
      ['prose, a quoted mention', ' NOT interpolated here '],
      // ONE word. The alternation rule cannot see this one — it is not a run of
      // adjacent operands — and it is the likeliest reintroduction wording, so
      // it is the root check that has to catch it.
      ['one word', ' expression '],
      ['one word that reads like a context', ' opener '],
      ['a dotted path under an unknown root', ' expression.body '],
      ['an underscore-led root, which no context is', ' _private.value '],
      ['a shell variable', ' ${GH_TOKEN} '],
      ['an unbalanced group', ' format(github.sha '],
      ['a trailing operator', ' github.ref == '],
      // The two `depth === 0` guards, one each. The unbalanced-group case above
      // only reaches the FINAL check.
      ['a close before any open', ' ) ( github.sha '],
      ['a close after an operand', ' github.sha ) ( github.ref '],
      // A body that opens with an operator. This one is the leading-INFIX arm's
      // SOLE killer. The two below are DOUBLY covered — refused at that arm,
      // with the two-operands arm as a backstop — so neither reds under either
      // single deletion, and neither pins an arm on its own. Stated because two
      // successive attempts at attributing them in prose were wrong, the second
      // exactly inverted.
      ['a leading comma', ' , '],
      ['a doubled operator', " github.ref && == 'main' "],
      ['a leading empty argument', ' format(,github.sha) '],
      // The `afterDot` flag, which was set per-branch and leaked through every
      // arm that continues early. Reaching operand position through an INDEX
      // after a member access is what distinguishes it — a simple body resets
      // the flag on its way through an infix and cannot discriminate.
      ['a member access reopened by an index', ' fromJSON(steps.x.outputs.y).a[expression] '],
      ['a group opened after a member access', ' github.event . ( expression ) '],
      // A REAL PREFIX FOLLOWED BY PROSE — the shipped defect's own
      // neighbourhood, and the arm that catches it (the tokeniser finding no
      // token at all) had ZERO coverage: every other reject case starts with
      // the bad character, so none of them reached it mid-body. Degrading that
      // arm to a `break` accepted all three of these.
      ['a real path then an em dash', ' github.sha — the same rule '],
      ['a real path then a comment marker', ' github.sha # not interpolated '],
      ['a real path then a shell variable', ' github.sha $GH_TOKEN '],
    ])('rejects %s', (_label, body) => {
      expect(isReadableExpression(body)).toBe(false);
    });

    /**
     * The THREE REFUSAL MESSAGES, which are the only user-facing strings this
     * fence emits and had zero coverage: forcing the unknown-root branch off
     * redded none of the cases, because every grammar case calls the predicate
     * directly and never reaches a message.
     *
     * They must not be swapped, and each swap has a cost of its own. Telling
     * the author of `${{ expression }}` to add `expression` to the root set
     * would permanently re-open the hole the root check closes; telling the
     * author of `${{ always.foo }}` to add `always` names a root that is
     * already there, so the remedy changes nothing and the fence stays red.
     */
    describe('refusal messages', () => {
      const reasonFor = (body: string): string => {
        const found = findExpressionOffences('x.yml', `on: push\njobs: \${{${body}}}\n`);
        expect(found).toHaveLength(1);
        return found[0]!.reason;
      };

      it.each([' expression ', ' opener ', ' context ', ' the same rule '])(
        'calls %s prose, not a missing root',
        (body) => {
          expect(reasonFor(body)).toContain('prose, not an expression');
        },
      );

      it.each([
        ' newcontext.foo ',
        ' newfn(github.sha) ',
        " github.ref == 'x' && newcontext.foo ",
        // The SAME new root twice. Settling it by substituting one occurrence
        // left the other unknown, so an ordinary condition naming a new
        // context reported as prose — and a condition is where a new context
        // is most likely to appear twice.
        ' newctx.a == newctx.b ',
        ' newa.foo && newb.bar ',
        // `bareWord`'s two remaining conjuncts: not the first token, and not
        // the whole body. Both mutants send a reader to rewrite working syntax.
        // Only the FIRST is a sole killer — dropping the tail-empty conjunct
        // also reds `newfn(github.sha)` above, a job that used to belong to the
        // `!called` conjunct this round deleted as dead. An earlier version of
        // this comment claimed one killer each, which the mutation table does
        // not say.
        ' github.ref == newcontext ',
        " newcontext == 'x' ",
      ])('calls %s a missing root, not prose', (body) => {
        const reason = reasonFor(body);
        expect(reason).toContain('Unrecognized named-value');
        expect(reason).toContain('CONTEXT_HEADS');
      });

      it.each([
        ' format ',
        ' always.foo ',
        // A new ROOT and an uncalled FUNCTION in the same body. The first
        // verdict names the root; the function only surfaces once that root is
        // allowed, so reading the first verdict alone left this on the prose
        // arm — the true-verdict / false-diagnosis shape again.
        ' newctx.a && format ',
        ' newa.x && newb.y && join ',
      ])(
        'calls %s an uncalled function, naming neither prose nor a missing root',
        (body) => {
          const reason = reasonFor(body);
          expect(reason).toContain('an Actions FUNCTION');
          expect(reason).not.toContain('add it to CONTEXT_HEADS');
          expect(reason).not.toContain('prose, not an expression');
        },
      );

      it('names the token it actually refused, not the first one', () => {
        expect(reasonFor(" github.ref == 'x' && newcontext.foo ")).toContain('`newcontext`');
      });

      it('still names a missing root when the body names many of them', () => {
        // The iteration used to be capped at ten rounds, so a body naming
        // eleven distinct unknown roots fell through to the PROSE message.
        const body = Array.from({ length: 14 }, (_, i) => `newctx${i}.a`).join(' && ');
        expect(reasonFor(` ${body} `)).toContain('Unrecognized named-value');
      });

      it('refuses to render a file name that is not one', () => {
        // The NAME is the third field this forgery was found in, and the first
        // two fixes did not reach it: a tracked file may be called this in PURE
        // ASCII, pass the `.ya?ml` filter and the tracked-set case, and render
        // a line opening as a complete false finding about `ci.yml`. Flattening
        // cannot touch it — every character is printable — so the shape is
        // constrained instead.
        //
        // ASCII HYPHENS, not em dashes. The earlier fixture used em dashes,
        // which `WORKFLOW_NAME` rejects for being outside its charset whatever
        // the colons and spaces do — so widening the charset to `[A-Za-z0-9._: -]`
        // left this case green, and the one forgery the regex exists to stop
        // had no case at all. The docstring had already been corrected to the
        // ASCII spelling; the fixture had not.
        const forged = 'ci.yml:412: empty expression body - and no more - hooks.yml';
        const [offence] = findExpressionOffences(forged, 'a: ${{ prose x }}');
        expect(offence!.file).not.toBe(forged);
        expect(offence!.file.startsWith('"')).toBe(true);
      });

      it('clamps a very long file name, without clamping it away', () => {
        // BOTH bounds. Asserting only the cap let the window be tightened to
        // five characters with nothing red — a clamp that throws the name away
        // is as useless as no clamp, one direction louder.
        const [offence] = findExpressionOffences(`${'n'.repeat(400)} x.yml`, 'a: ${{ prose x }}');
        expect(offence!.file.length).toBeLessThanOrEqual(125);
        expect(offence!.file.length).toBeGreaterThanOrEqual(120);
      });

      it.each([
        ['a newline', 'evil\nci.yml:1: FORGED.yml'],
        ['an ESC', `evil${String.fromCharCode(0x1b)}[1A[2K.yml`],
        ['a colon and spaces', 'ci.yml:1: empty expression body - see - hooks.yml'],
      ])('renders %s safely when the two listings disagree', (_label, hostile) => {
        // The difference is what a FAILING capacity check prints, and it prints
        // exactly when a hostile name is present — so this is the arm that
        // matters and the one a healthy tree can never exercise.
        const { extra } = setDifference([hostile], []);
        expect(extra).toHaveLength(1);
        expect(extra[0]).not.toBe(hostile);
        expect(extra[0]!.startsWith('"')).toBe(true);
        expect(extra[0]).not.toContain('\n');
        expect(extra[0]).not.toContain(String.fromCharCode(0x1b));
      });

      it('renders the MISSING side safely too', () => {
        // Its own case: feeding only `extra` left the mirrored `missing` map
        // unpinned, and a fence half-applied is the shape this file keeps
        // finding.
        const { missing } = setDifference([], ['evil\nci.yml:1: FORGED.yml']);
        expect(missing).toHaveLength(1);
        expect(missing[0]).not.toContain('\n');
        expect(missing[0]!.startsWith('"')).toBe(true);
      });

      it('leaves a legitimate name alone in the difference', () => {
        expect(setDifference(['ci.yml'], [])).toEqual({ missing: [], extra: ['ci.yml'] });
      });

      it('names a workflow it cannot read without forging a line', () => {
        // The read's own failure path. Node's ENOENT carries the raw path, so
        // the rethrow is what keeps a hostile name from opening a second line.
        try {
          readWorkflow('evil\nci.yml:1: FORGED.yml');
          expect.unreachable('the read should have failed');
        } catch (error) {
          const { message, cause } = error as Error;
          expect(message).toContain('could not read workflow "evil ci.yml:1: FORGED.yml"');
          expect(message).not.toContain('\n');
          // The errno is kept because a reader needs it; the ERROR is not,
          // because vitest prints a cause chain in its own `Caused by:` block,
          // raw. Attaching it moved the forgery two lines down rather than
          // closing it.
          expect(message).toContain('ENOENT');
          expect(cause).toBeUndefined();
        }
      });

      it('renders a corpus body safely', () => {
        // `bodies` holds verbatim file bytes and the corpus assertion prints
        // them on exactly the run that reports a real defect.
        // The ESC goes; the printable `[1A` it introduced stays, which is the
        // point — what makes the sequence dangerous is the escape, not the
        // letters, and dropping legible text would make a finding unreadable.
        const esc = String.fromCharCode(0x1b);
        expect(safeRender(`prose\n${esc}[1A${esc}[2K here`)).toBe('prose [1A [2K here');
        expect(safeRender('z'.repeat(400))).toHaveLength(121);
        expect(safeRender('z'.repeat(400)).endsWith('…')).toBe(true);
      });

      it('reads a body written with no spaces at all', () => {
        // `${{github.sha}}` — legal Actions, and every corpus body plus every
        // other case has a leading space, so the body offset could be widened
        // to `at + 4` with nothing red. The empty-body twin below is the same
        // spelling of the same gap.
        expect(findExpressionOffences('x.yml', 'a: ${{github.sha}}')).toEqual([]);
        expect(findExpressionOffences('x.yml', 'a: ${{prose here}}')).toHaveLength(1);
      });

      it('reports the SHIPPED spelling, with no spaces at all', () => {
        // `${{}}` — the exact reintroduction spelling, and no case fed it:
        // `reasonFor` always inserts spaces, so `indexOf('}}', at + 3)` could be
        // widened to `at + 4` with nothing red.
        const found = findExpressionOffences('x.yml', 'a: ${{}}');
        expect(found).toHaveLength(1);
        expect(found[0]!.reason).toContain('empty expression body');
      });

      it.each([
        [119, false],
        [120, false],
        [121, true],
      ])('safeRender marks a clip at %i characters: %s', (len, marked) => {
        // `excerpt` got this table; `safeRender` did not, so its threshold was
        // loose in one direction while its slice width was pinned.
        expect(safeRender('z'.repeat(len)).endsWith('…')).toBe(marked);
      });

      it('renders exactly the cap without a remainder line', () => {
        // At exactly MAX_RENDERED_OFFENCES the `>` could be `>=`, printing
        // "… and 0 more". The cases either side used 50 and 2.
        const at = Array.from({ length: 20 }, () => 'a: ${{ }}').join('\n');
        const rendered = renderOffences(findExpressionOffences('x.yml', at));
        expect(rendered).toHaveLength(20);
        expect(rendered.some((line) => line.startsWith('…'))).toBe(false);
      });

      it('bounds how many findings one file prints', () => {
        const many = Array.from({ length: 50 }, () => 'a: ${{ }}').join('\n');
        const rendered = renderOffences(findExpressionOffences('x.yml', many));
        expect(rendered).toHaveLength(21);
        expect(rendered.at(-1)).toBe('… and 30 more');
      });

      it('quotes the closing braces in the excerpt', () => {
        // `close + 2` in both offence arms. Dropping the `+ 2` loses the `}}`
        // from the quoted text and shifts the ellipsis boundary by two, and
        // nothing read either arm's excerpt closely enough to notice.
        const [empty] = findExpressionOffences('x.yml', 'a: ${{ }}');
        expect(empty!.text).toBe('${{ }}');
        const [prose] = findExpressionOffences('x.yml', 'a: ${{ prose here }}');
        expect(prose!.text).toBe('${{ prose here }}');
      });

      it('collapses a RUN of unsafe characters to one space', () => {
        // The `blank` latch, in the direction nothing tested: without it each
        // unsafe character becomes its own space, so a body of newlines renders
        // as a wall of them.
        expect(safeRender('a\n\n\n\nb')).toBe('a b');
        expect(safeRender('a \t \n b')).toBe('a b');
      });

      it('renders every finding when there are few', () => {
        const rendered = renderOffences(findExpressionOffences('x.yml', 'a: ${{ }}\nb: ${{ }}'));
        expect(rendered).toHaveLength(2);
        // The overflow marker specifically — `and` alone also occurs inside a
        // reason string, so matching on it asserted nothing.
        expect(rendered.some((line) => /^… and \d+ more$/.test(line))).toBe(false);
      });

      it('renders a legitimate name unquoted', () => {
        // The ACCEPT arm of `WORKFLOW_NAME`: without this, tightening the regex
        // so no real name passes — or quoting unconditionally — stays green,
        // and over-refusal is the direction this file's header calls dangerous.
        const [offence] = findExpressionOffences('ci.yml', 'a: ${{ prose x }}');
        expect(offence!.file).toBe('ci.yml');
      });

      it('strips ESC from the EXCERPT, which no quoting protects', () => {
        // `flatten`'s FIRST stated reason had no case. The file name is
        // incidentally covered by `JSON.stringify`, which escapes every C0
        // byte; the excerpt is not, so deleting the control-byte test emitted a
        // raw cursor-up plus erase-line into the finding.
        const esc = String.fromCharCode(0x1b);
        const [offence] = findExpressionOffences('x.yml', `a: \${{ prose ${esc}[1A${esc}[2K x }}`);
        expect(offence!.text).not.toContain(esc);
      });

      it.each([
        ['a newline', 'evil\nci.yml:1: FORGED.yml'],
        ['a DEL byte', `evil${String.fromCharCode(0x7f)}.yml`],
        ['a NEL byte', `evil${String.fromCharCode(0x85)}.yml`],
        ['a Unicode line separator', `evil${String.fromCharCode(0x2028)}.yml`],
        ['a bidi override', `evil${String.fromCharCode(0x202e)}.yml`],
        ['a bidi isolate', `evil${String.fromCharCode(0x2066)}.yml`],
        ['a bidi mark', `evil${String.fromCharCode(0x200f)}.yml`],
        ['an Arabic letter mark', `evil${String.fromCharCode(0x61c)}.yml`],
      ])('strips %s from a rendered file name', (_label, name) => {
        const [offence] = findExpressionOffences(name, 'a: ${{ prose x }}');
        // A space is the REPLACEMENT, so it is expected; what must be gone is
        // anything that can move the cursor, break the line, or reorder it.
        // The filter is derived from `flatten`'s own class rather than from the
        // four characters an earlier version happened to feed.
        const dangerous = [...offence!.file].filter((ch) => {
          const code = ch.codePointAt(0)!;
          return (
            code < 0x20 ||
            (code >= 0x7f && code <= 0x9f) ||
            code === 0x61c ||
            (code >= 0x200e && code <= 0x200f) ||
            (code >= 0x2028 && code <= 0x2029) ||
            (code >= 0x202a && code <= 0x202e) ||
            (code >= 0x2066 && code <= 0x2069)
          );
        });
        expect(dangerous).toEqual([]);
      });

      it('marks a truncated excerpt on the dangling-opener arm', () => {
        // Two earlier attempts clipped at exactly the ellipsis threshold, so
        // the marker was unreachable by construction and a clipped excerpt read
        // as complete. Nothing asserted `.text` on this arm at all.
        const [offence] = findExpressionOffences('x.yml', `a: \${{ ${'z'.repeat(400)}`);
        expect(offence!.text.endsWith('…')).toBe(true);
        // The EXACT length, not a cap: asserting only the marker and an upper
        // bound left the window free to shrink — at 60 the excerpt silently
        // dropped half its content while still ending in an ellipsis.
        expect(offence!.text.length).toBe(121);
      });

      it.each([
        [119, false],
        [120, false],
        [121, true],
      ])('shows the marker at %i characters of tail: %s', (tail, marked) => {
        // The boundary itself. `end > from + 120` has to fire on the first
        // character actually dropped and not before.
        const [offence] = findExpressionOffences('x.yml', `\${{ ${'z'.repeat(tail - 4)}`);
        expect(offence!.text.endsWith('…')).toBe(marked);
      });

      it('clamps a very long root in the reason', () => {
        const root = 'n'.repeat(200_000);
        const [offence] = findExpressionOffences('x.yml', `a: \${{ ${root}.foo }}`);
        expect(offence!.reason.length).toBeLessThan(500);
      });

      it('reports ONE dangling opener, not one per opener after it', () => {
        // `indexOf` is monotonic, so once no closer exists none does for any
        // later opener either — the short-circuit the scanner relies on.
        const found = findExpressionOffences('x.yml', 'a: ${{ one\nb: ${{ two\n');
        expect(found).toHaveLength(1);
      });

      it('pairs an opener with the NEXT closer, not with a nested opener', () => {
        // Resuming the scan at `at + 3` instead of after the closer reported
        // the inner opener as a second offence against the same closer.
        const found = findExpressionOffences('x.yml', 'a: ${{ prose ${{ nested }} tail }}');
        expect(found).toHaveLength(1);
      });

      /**
       * The binary search's boundary. Every probe body in this file is
       * INDENTED, so no opener has ever started a line and `lineStarts[mid] <=
       * index` could be weakened to `<` with all cases green — reporting line 1
       * for a defect on line 2, which is the one field a reader acts on.
       */
      it.each([
        [1, '${{ prose here }}\nb: 2\n'],
        [2, 'a: 1\n${{ prose here }}\nb: 2\n'],
        [3, 'a: 1\nb: 2\n${{ prose here }}'],
      ])('reports line %i for an opener at the start of it', (line, source) => {
        const found = findExpressionOffences('x.yml', source);
        expect(found).toHaveLength(1);
        expect(found[0]!.line).toBe(line);
      });

      it.each([
        [1, '${{ dangling'],
        [3, 'a: 1\nb: 2\n${{ dangling'],
      ])('reports line %i for a DANGLING opener', (line, source) => {
        // The dangling arm has its own `lineOf` call, and nothing read it:
        // replacing it with a literal `1` redded nothing, because both existing
        // dangling cases happened to sit on line 1.
        const found = findExpressionOffences('x.yml', source);
        expect(found).toHaveLength(1);
        expect(found[0]!.line).toBe(line);
      });

      it('clamps and flattens the quoted excerpt', () => {
        // Raw, the excerpt was both a forgery surface (a newline in the body
        // renders a second line that reads as a finding against another file)
        // and a size bomb.
        const [offence] = findExpressionOffences(
          'x.yml',
          `jobs: \${{ prose here\nci.yml:1: forged ${'x'.repeat(500)} }}\n`,
        );
        expect(offence!.text).not.toContain('\n');
        expect(offence!.text.length).toBeLessThanOrEqual(121);
      });
    });

    /**
     * The root list is the one part of the grammar that can go stale on
     * GitHub's schedule rather than on this repo's, so it is pinned against
     * what the tree writes. A root that leaves the corpus is harmless; one that
     * ENTERS it without being listed reds the per-file arms with a message
     * naming the remedy, and this case says which root and why.
     */
    it('knows every root the corpus actually leads with', () => {
      const heads = new Set(
        bodies
          .map((b) => /^\s*!?\s*\(?\s*([A-Za-z_][A-Za-z0-9_-]*)/.exec(b)?.[1])
          .filter((h): h is string => h !== undefined),
      );
      expect(heads.size).toBeGreaterThanOrEqual(5);
      // Through `safeRender` AND `boundedList`, like every other list of
      // file-derived text. The charset rules out forgery here, but neither
      // length nor count: a 500 k-character root printed whole, and `heads` is a
      // set over the whole DIRECTORY, so a file of distinct roots is the same
      // size bomb the corpus bodies were bounded for one round earlier. Width
      // alone was the first fix, and it left this list the odd one out — "one of
      // two lists" a third time.
      expect(
        boundedList(
          [...heads]
            .map(safeRender)
            .filter((h) => !CONTEXT_HEADS.has(h) && !FUNCTION_HEADS.has(h) && !LITERAL_HEADS.has(h)),
        ),
      ).toEqual([]);
    });
  });

  /**
   * The scanner is probed against REAL code, not a synthetic string: a fixture
   * written to suit the checker shares the checker's blind spot. The mutation
   * is the historical defect, put back in the exact shape go-to-k/cdkd#3173
   * shipped it — inside the `run:` body of the fragment step, behind a `#`.
   */
  describe('probed by restoring the defect to the file it shipped in', () => {
    const REAL = readWorkflow('cfn-schema-refresh.yml');
    const ANCHOR = '          # Publish left this working tree on the branch it pushed, both on the';

    const mutate = (line: string): string => {
      // `.includes` rather than `toContain`: a failing `toContain` prints the
      // WHOLE subject, which here is a fork-controlled file.
      expect(REAL.includes(ANCHOR)).toBe(true);
      // A FUNCTION replacer, so a probe line carrying `$&` / `` $` `` / `$'` /
      // `$1` is inserted verbatim instead of being expanded by `String.replace`
      // — measured: `` $` `` expands to the whole pre-match text, which would
      // silently probe something other than the line the case names.
      const mutated = REAL.replace(ANCHOR, () => `${line}\n${ANCHOR}`);
      expect(mutated).not.toEqual(REAL);
      return mutated;
    };

    it('reports the shell comment that broke the daily job', () => {
      const mutated = mutate('          # output, and NOT interpolated with `${{ }}` — the same rule the');
      const offences = findExpressionOffences('cfn-schema-refresh.yml', mutated);
      expect(offences).toHaveLength(1);
      expect(offences[0]?.reason).toContain('empty expression body');
      // The line the scanner names is the one a reader has to edit.
      // `.includes` — a failing `toContain` prints the whole subject, and the
      // subject is a line of a fork-controlled file. Reached: a fork's own
      // unclosed opener above the anchor pairs with this probe's `}}`, so the
      // single offence lands on the FORK's line, the assertion fails, and its
      // ESC reaches the log. The neighbour twelve lines up was hardened on
      // exactly this ground and these two were left — one of two readers again.
      expect(mutated.split('\n')[offences[0]!.line - 1]?.includes('NOT interpolated with')).toBe(
        true,
      );
    });

    it('reports the SAME comment with a word inside the braces', () => {
      // Distinct from the case above on purpose: the empty-body branch catches
      // that one whatever the grammar does, so without this case a validator
      // that accepted everything would still look green here.
      const mutated = mutate('          # output, and NOT interpolated with `${{ the same rule }}` — so');
      const offences = findExpressionOffences('cfn-schema-refresh.yml', mutated);
      expect(offences).toHaveLength(1);
      expect(offences[0]?.reason).toContain('prose, not an expression');
    });

    it('does NOT report the same comment once it names a real context', () => {
      // The discriminator for the case above: an over-refusing grammar reds
      // here, and a fence that reds on working code gets deleted.
      const mutated = mutate('          # output — see `${{ steps.publish.outputs.pr_number }}` above');
      expect(findExpressionOffences('cfn-schema-refresh.yml', mutated)).toEqual([]);
    });

    it('leaves the unmutated file clean, so the cases above are not reporting everything', () => {
      expect(findExpressionOffences('cfn-schema-refresh.yml', REAL)).toEqual([]);
    });

    it('reports a stray opener mid-file, whichever way it pairs up', () => {
      // An unterminated opener does not stay unterminated in a real file: the
      // scan pairs it with some LATER step's `}}`, and the prose it swallows on
      // the way is what gets reported. Either reason is a report, so the case
      // pins the LINE — the thing a reader has to act on — not the wording.
      const mutated = mutate('          # a stray ${{ opener');
      const offences = findExpressionOffences('cfn-schema-refresh.yml', mutated);
      expect(offences).toHaveLength(1);
      expect(mutated.split('\n')[offences[0]!.line - 1]?.includes('a stray')).toBe(true);
    });

    it('reports an opener with nothing after it to close against', () => {
      const offences = findExpressionOffences(
        'cfn-schema-refresh.yml',
        `${REAL}\n# ${'${{'} dangling`,
      );
      expect(offences).toHaveLength(1);
      expect(offences[0]?.reason).toContain('never closed');
    });

    it('accepts the legitimate opener the refresh already carries in a run body', () => {
      expect(REAL.includes('${{ github.repository_owner }}')).toBe(true);
      expect(findExpressionOffences('cfn-schema-refresh.yml', REAL)).toEqual([]);
    });
  });

  /**
   * THE WIRING, fenced by shape.
   *
   * The sanitising helpers above all have cases, and every mutation of their
   * bodies reds — but replacing a CALL with the raw expression it wraps redded
   * nothing, measured, and that is exactly the mistake that has happened here
   * twice: a fence applied to one of two readers, and to one of two lists.
   *
   * A case cannot assert "this test calls that helper" from inside the same
   * file. It can assert that the raw primitive occurs ONCE and in the right
   * place, which is the same protection reached from the other side.
   */
  describe('the sanitising helpers are actually wired in', () => {
    /**
     * The file UP TO this block. Counting the whole file would count these
     * assertions' own needles — a fence that reads its own text measures
     * itself, and the first cut of this block did exactly that.
     */
    const SUBJECT = ((): string => {
      const parts = readFileSync(
        join(import.meta.dirname, 'workflow-expression-syntax.test.ts'),
        'utf8',
      ).split(WIRING_FENCE_MARKER);
      // The LAST occurrence, which is this block's own `describe` title. The
      // first is the constant's declaration — splitting there cut the file in
      // half and left the fence judging nothing, which its capacity case caught.
      return parts.slice(0, -1).join(WIRING_FENCE_MARKER);
    })();

    /**
     * CODE only. The needles below are spellings this file also DISCUSSES, so a
     * doc comment naming one counted as a use — measured, the `it.each` needle
     * matched its own explanatory paragraph. Comment lines are dropped whole;
     * nothing here needs to see inside one.
     */
    const CODE = SUBJECT.split('\n')
      .filter((line) => {
        const t = line.trim();
        // `/*` is NOT dropped: a reader added on a line starting with it would
        // be invisible to the counts below, which is a bypass rather than a
        // false count. A block comment's opening line reaching the counts costs
        // nothing — the needles are code shapes, and the file's prose is
        // already indented under `*`.
        return !t.startsWith('*') && !t.startsWith('//');
      })
      .join('\n');

    const countOf = (needle: string): number => CODE.split(needle).length - 1;

    it('found the code to look at', () => {
      // The split must land BEFORE the fence and AFTER everything it judges.
      expect(SUBJECT.length).toBeGreaterThan(20_000);
      expect(SUBJECT).toContain('export const renderOffences');
    });

    it('reads a workflow file in exactly one place', () => {
      // Two readers is how the module-scope walk kept its raw read while the
      // per-file case got a guarded one — and the raw one runs FIRST, at
      // collection, so the guarded one was unreachable.
      //
      // The count is on the bare PRIMITIVE, not on one spelling of it. Pinning
      // `readFileSync(join(WORKFLOW_DIR` caught a re-spelled read only when it
      // REPLACED the guarded one; a reader ADDED as
      // `readFileSync(`${WORKFLOW_DIR}/${n}`)` moved neither count and stayed
      // green. Exactly ONE is legitimate — `readWorkflow`'s own; the fence's
      // two reads of THIS file sit after the marker and are not in `SUBJECT`.
      expect(countOf('readFileSync(')).toBe(1);
      expect(countOf('readWorkflow(')).toBe(4);
    });

    it('renders the corpus bodies through safeRender', () => {
      // `bodies` is verbatim file text, printed by the corpus assertion on the
      // very run that reports a defect. Dropping the map reds nothing on its
      // own — the list is empty on a healthy tree — so it is pinned here.
      // Two lists of file-derived text: the corpus bodies and the corpus heads.
      expect(countOf('.map(safeRender)')).toBe(2);
      // Every list of file-derived text goes through the same cap: the offence
      // renderer, the corpus bodies, and the corpus heads.
      expect(countOf('boundedList(')).toBe(3);
      // The two probe assertions that read a LINE of the mutated file. They
      // must use `.includes`, because a failing `toContain` prints the whole
      // subject — and reverting them redded nothing on a healthy tree, which is
      // the same reason every other renderer needed counting rather than a case.
      //
      // Scoped to that one expression rather than banning `toContain` outright:
      // twenty of its uses here read a reason or a message this file OWNS, and
      // those are the assertions a reader wants a diff from.
      expect(countOf("mutated.split('\\n')[offences[0]!.line - 1]?.includes(")).toBe(2);
      // And the BARE expression, because the line above pins the safe spelling
      // only — the inverse of the `readFileSync(` lesson two counts up. A raw
      // `toContain` APPENDED beside them left every count green while shipping
      // exactly the renderer they exist to stop.
      expect(countOf("mutated.split('\\n')[offences[0]!.line - 1]")).toBe(2);
    });

    it('formats an offence line in exactly one place', () => {
      // The template is what turns file/line/reason/text into output. Spelled
      // twice, one copy can lose the bound or the sanitiser.
      // The WHOLE template. The needle was a strict PREFIX of it, so dropping
      // `— ${o.text}` left the count at 1 and the clamped excerpt silently
      // stopped being printed, with no case reading a rendered line's text.
      expect(countOf('`${o.file}:${o.line}: ${o.reason} — ${o.text}`')).toBe(1);
      expect(countOf('renderOffences(offences)')).toBe(1);
    });

    it('titles each per-file case through safeName', () => {
      // `it.each` over the RAW list is how the title carried a raw name.
      expect(countOf('it.each(workflowFiles)(')).toBe(0);
      expect(countOf('workflowFiles.map((name) => [safeName(name), name])')).toBe(1);
    });
  });
});
