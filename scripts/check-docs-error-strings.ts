/**
 * Fence the ERROR MESSAGES quoted on the public documentation site against the
 * strings cdkd actually emits.
 *
 * WHY THIS EXISTS. A troubleshooting page is reached by pasting a failing error
 * into a search box. A page that quotes a message cdkd never emits is therefore
 * not merely inaccurate — it is unreachable by exactly the reader it was
 * written for, and it reads as authoritative to everyone else. The page-wide
 * audit in issue [#2757](https://github.com/go-to-k/cdkd/issues/2757) found
 * NINE such quotations on one page, the single largest defect class it
 * reported, and nothing in the repo could see any of them: every fence over
 * `docs/**` checks link targets, table shape or index coverage, and none reads
 * the CONTENT of a fenced block.
 *
 * WHAT MAKES IT CHECKABLE. `formatError` renders every failure as
 * `${error.name}: ${error.message}` (plus at most one `Caused by:` line), and
 * each `CdkdError` subclass assigns `this.name` a string literal. So a quoted
 * line of the shape `SomeError: some text` carries a claim with two halves,
 * both mechanically decidable:
 *
 *   1. `SomeError` names a real error cdkd can raise, and
 *   2. `some text` is derived from a real message template in `src/`.
 *
 * The checker decides exactly those two and nothing else.
 *
 * HOW THE SECOND HALF IS DECIDED. A published example substitutes concrete
 * values (`'MyStack'`, `us-east-1`, `4`) where the source interpolates
 * (`${stackName}`, `${region}`, `${maxRetries + 1}`), so the two strings never
 * compare equal and reconstructing the template would mean evaluating it.
 * Instead every template literal in `src/` is compiled to a matcher with its
 * `${...}` holes widened to wildcards, and the quoted message must match one of
 * them. `Failed to ${verb} resource ${id}` therefore accepts `Failed to create
 * resource MyBucket` and rejects `Failed to publish asset: Access Denied` —
 * a discrimination no word-run or substring test makes, because the
 * interpolation sits in the MIDDLE of the phrase.
 *
 * Two properties of the corpus had to be handled or the check reports nothing
 * but false alarms, and both were found by running it:
 *
 * - **Concatenated literals are rejoined.** cdkd builds its longest messages as
 *   `` `part one ` + `part ${two}` ``, and neither half alone matches what the
 *   user sees.
 * - **Wrapped doc blocks are rejoined.** A published block breaks a long
 *   sentence over several lines; the reader sees one message, so the scanner
 *   absorbs the continuation lines before matching.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM, because an over-claimed fence is worse
 * than none:
 *
 * - **It does not prove a quotation is correct.** A match proves the message is
 *   an instance of SOME real template, not of the right one, and says nothing
 *   about the values substituted into the holes: the lock message quoted with
 *   the wrong attempt count still matches, because the count sits in a hole.
 *   What this removes is wholesale invention.
 * - **A line with no class prefix is out of scope.** Most fenced blocks on the
 *   site are CLI output, AWS messages, YAML or shell — none of which this can
 *   adjudicate, and guessing at them is how a docs lint becomes a thesaurus.
 * - **A `Caused by:` continuation line is out of scope** for the same reason:
 *   its text is AWS's, not cdkd's.
 * - **The class name and the message are decided INDEPENDENTLY**, so a real
 *   class paired with a real-but-wrong message passes. Review found exactly
 *   that on the throttling section — `ProvisioningError: CREATE failed for
 *   MyTopic: ...`, where both halves exist but the engine wraps that message
 *   under a `Caused by:` line, making the published one-line form unreachable.
 *   Deciding the pairing would mean knowing which errors wrap which, which is
 *   a call-graph question this cannot answer from string literals.
 * - **A truncated quotation is judged on a PREFIX of the template**, so the
 *   text after the author's ellipsis is unexamined by construction. It must
 *   either stop inside the opening literal, or reach a SECOND literal —
 *   keeping text from both sides of a hole. Two review rounds landed here:
 *   the first revision compared only the overlapping characters, and the
 *   second still accepted anything whose borrowed opening aligned to a whole
 *   literal. A quote cut inside the first hole is now refused, which is a
 *   loud, author-fixable outcome rather than a silent blessing.
 *
 * COLLAPSE DEFENCES. The population is small (a couple of dozen lines
 * site-wide), so counting only findings would let a broken scanner report a
 * confident zero. Two independent instruments guard that, per
 * `.claude/rules/testing.md`: {@link FLOORS} asserts the scanner still SEES its
 * input at every stage that can silently empty — pages walked, fenced blocks
 * entered, lines read inside them, error names and templates derived — and
 * {@link SELF_PROBE_CASES} runs fixed inputs with known verdicts, including
 * failing ones, BEFORE the real tree is read, so a predicate stuck at "pass" is
 * caught with every count left untouched.
 *
 * It also fails against REAL code in both directions, which is the property the
 * synthetic cases cannot establish (measured 2026-09-08): restoring the page's
 * original `State was modified by another process` reports it; rewording that
 * sentence in `src/state/s3-state-backend.ts` while leaving the page alone
 * reports it too. The second direction is the one that matters over time — it
 * is how a correct page rots.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

/** Repo root, resolved from this file's location. */
const ROOT = join(import.meta.dirname, '..');

/**
 * Literal (non-interpolated) characters a source template must carry before it
 * is allowed to vouch for a quoted message.
 *
 * A template is matched with its `${...}` holes turned into wildcards, so a
 * nearly-all-holes template such as `` `${operation}: ${message}` `` would
 * match almost any line with a colon in it and silently bless every invention
 * on the site. Requiring real literal text means the match is carried by
 * wording somebody actually wrote. Measured against the tree: the templates
 * these pages quote carry 14 to 40 literal characters, and the shortest
 * genuine one is `` `${operation} failed for ${logicalId}: ${err.message}` ``
 * at 14.
 */
export const MIN_TEMPLATE_LITERAL_CHARS = 12;

/**
 * Directories under `docs/` that are written by generators and guarded by
 * their own staleness checks. Editing one by hand is already a defect, so
 * reporting a finding there would point at the wrong file.
 */
const GENERATED_DIRS = new Set(['_generated']);

/**
 * Error names that appear on the site, are NOT cdkd's, and are correct as
 * published. Each needs a reason of real length — a bare entry is how an
 * allow-list becomes a place to put anything that failed.
 *
 * This is the ONLY escape hatch. There is deliberately no per-message
 * exemption: the anchor test's whole job is to be failable, and a per-message
 * opt-out would be reachable by whoever writes the next invention.
 */
export const FOREIGN_ERROR_NAMES: ReadonlyMap<string, string> = new Map([
  [
    'CredentialsProviderError',
    'Raised by the AWS SDK credential chain before cdkd code runs; quoted on the proxy page as the first thing a user behind a TLS-terminating proxy actually sees.',
  ],
]);

/** Minimum magnitudes proving the scanner still reaches its input. */
export const FLOORS = {
  /** Markdown pages walked under `docs/`. */
  pages: 40,
  /** Fenced code blocks entered across those pages. */
  fencedBlocks: 300,
  /** Lines read INSIDE fenced blocks. */
  fencedLines: 2500,
  /** Error names derived from `this.name = '...'` assignments in `src/`. */
  errorNames: 20,
  /** Message templates extracted from `src/` for the anchor test to match against. */
  templates: 5_000,
} as const;

export type Verdict = 'anchored' | 'foreign-allowed' | 'unknown-class' | 'no-source-anchor';

export interface Finding {
  file: string;
  line: number;
  errorName: string;
  message: string;
  verdict: Verdict;
}

/**
 * Error names cdkd can print, derived from the `this.name = '<Name>'`
 * assignment every `CdkdError` subclass makes in its constructor.
 *
 * Derived rather than listed because the subclasses are NOT all in
 * `src/utils/error-handler.ts` — providers and commands declare their own
 * (`HostedZoneNameNotFoundError`, `DriftDetectedError`, ...), and a
 * hand-maintained list would omit exactly the ones a page is most likely to
 * quote wrongly. Keyed on the assigned NAME, not the class name: `name` is what
 * `formatError` prints, and nothing forces the two to agree.
 */
export function deriveErrorNames(sourceFiles: ReadonlyArray<string>): Set<string> {
  /*
   * `Error` is seeded rather than derived: it is `Error.prototype.name`, so it
   * is what `formatError` prints for anything that is not a `CdkdError` — and
   * cdkd raises plain `Error`s on real paths (the unknown-intrinsic refusal is
   * one). Omitting it would either report every such quotation as an unknown
   * class, or — if the pattern simply skipped a bare `Error:` — exempt the
   * whole shape from the anchor test, which is the half that catches
   * inventions.
   */
  const names = new Set<string>(['Error']);
  for (const file of sourceFiles) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/this\.name\s*=\s*['"]([A-Za-z][A-Za-z0-9]*)['"]/g)) {
      names.add(m[1]!);
    }
  }
  return names;
}

/** Every `.ts` file under `src/`, recursively. */
export function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) collectSourceFiles(p, out);
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Every hand-written `.md` page under `docs/`, recursively. */
export function collectDocPages(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (!GENERATED_DIRS.has(entry)) collectDocPages(p, out);
    } else if (entry.endsWith('.md')) out.push(p);
  }
  return out;
}

/**
 * Every message template in `src/`, as a matcher.
 *
 * Two normalisations happen before extraction, and both are load-bearing:
 *
 * - **Whitespace is collapsed**, because a template that wraps across lines is
 *   one string to the reader and two lines to a line-by-line scan.
 * - **Adjacent concatenated literals are joined.** cdkd builds its longest
 *   messages as `` `part one ` + `part ${two}` ``, and neither half alone
 *   matches the message a user sees. Deleting the `` ` + ` `` between them
 *   reunites the halves into the single template the code effectively has.
 */
export interface Template {
  /** Whole-message matcher, holes widened to wildcards. */
  re: RegExp;
  /** Literal text before the first hole — the anchor a truncated quote is judged on. */
  lead: string;
  /** The literal segments between holes, in order. Used to judge a truncation. */
  parts: string[];
  /** Memoised start-anchored prefix matchers, keyed by segment count. */
  prefixCache: Map<number, RegExp>;
}

/** Escape a literal for embedding in a regex. */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Wildcard standing in for one `${...}` hole. */
const HOLE = '[\\s\\S]*?';

/**
 * Start-anchored matcher for the first `k` literal segments of a template,
 * memoised per template — arm (b) of the truncation test asks for these
 * repeatedly, and recompiling them per call is the whole cost of that path.
 */
function prefixMatcher(t: Template, k: number): RegExp {
  const cached = t.prefixCache.get(k);
  if (cached) return cached;
  /*
   * The FINAL segment of the head is matched with its trailing whitespace
   * trimmed. An author truncating at a word boundary writes
   * `... stack 'S' after ...`, while the template's literal is `' after ` —
   * with the space, the quote reaches the literal but never completes it, and
   * a correct truncation is refused for a reason nobody can act on. Only the
   * trailing space is relaxed; every earlier segment must match in full.
   */
  const head = t.parts.slice(0, k).map(esc);
  head[k - 1] = esc(t.parts[k - 1]!.replace(/\s+$/, ''));
  const re = new RegExp(`^${head.join(HOLE)}`);
  t.prefixCache.set(k, re);
  return re;
}

/** Longest template worth compiling. Past this it is a code block, not a message. */
const MAX_TEMPLATE_CHARS = 600;

/**
 * Template literals in one source file, in source order, each paired with the
 * source offset just past its closing backtick.
 *
 * A real scanner rather than a backtick regex, because this repo's JSDoc is
 * dense with `backticked` prose: pairing backticks across a file — let alone
 * across a concatenated corpus — pairs a comment's opening tick with an
 * unrelated one thousands of characters later and yields a "template" made of
 * whole object literals. Tracking string, comment and template state is the
 * only way to know which backticks are delimiters.
 */
export function scanTemplateLiterals(
  text: string
): Array<{ raw: string; start: number; end: number }> {
  const out: Array<{ raw: string; start: number; end: number }> = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];

    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    /*
     * REGEX LITERALS. Without this arm a `/` whose regex body contains a quote
     * desynchronises everything after it: the scanner treats the quote as a
     * string start and swallows to the next stray one. Measured on the real
     * tree, two such regexes (in `cloud-control-provider.ts` and
     * `docker-cmd.ts`) dropped 11 genuine templates AND manufactured four
     * bogus matchers out of JSDoc prose — the precise failure this scanner
     * exists to avoid, one level down.
     *
     * `/` is a regex only in EXPRESSION position, which the preceding
     * non-space token decides: after a value (identifier, literal, `)`, `]`)
     * it is division. This is the standard heuristic and it is why the
     * previous-token scan below is not optional.
     */
    if (c === '/') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(text[j]!)) j--;
      const prev = j >= 0 ? text[j]! : '';
      const afterValue = /[A-Za-z0-9_$)\]]/.test(prev);
      const kw =
        /(?:^|[^A-Za-z0-9_$])(return|typeof|case|in|of|delete|void|instanceof|do|else|await|yield|new|throw)$/;
      const isRegex = !afterValue || kw.test(text.slice(Math.max(0, j - 12), j + 1));
      if (isRegex) {
        i++;
        let inClass = false;
        while (i < text.length) {
          const ch = text[i]!;
          if (ch === '\\') { i += 2; continue; }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) break;
          else if (ch === '\n') break; // unterminated: not a regex after all
          i++;
        }
        i++;
        continue;
      }
    }
    if (c === '`') {
      i++;
      const start = i;
      let depth = 0;
      while (i < text.length) {
        const ch = text[i]!;
        if (ch === '\\') { i += 2; continue; }
        if (ch === '$' && text[i + 1] === '{') { depth++; i += 2; continue; }
        /*
         * Inside a hole, skip quoted spans whole. Counting braces without this
         * makes `${ f("{") }` unbalance the depth and swallow past the closing
         * backtick — a desync the pre-brace-counting version did not have, so
         * the two arms have to land together.
         */
        if (depth > 0 && (ch === "'" || ch === '"')) {
          i++;
          while (i < text.length && text[i] !== ch) i += text[i] === '\\' ? 2 : 1;
          i++;
          continue;
        }
        // A brace nested INSIDE a hole (an object literal argument) must not
        // be read as the hole's end, or the template stops early and the
        // following comment's backticks open bogus ones.
        if (ch === '{' && depth > 0) { depth++; i++; continue; }
        if (ch === '}' && depth > 0) { depth--; i++; continue; }
        if (ch === '`' && depth === 0) break;
        i++;
      }
      out.push({ raw: text.slice(start, i), start: start - 1, end: i + 1 });
      i++;
      continue;
    }
    i++;
  }
  return out;
}

export function extractTemplates(sourceFiles: ReadonlyArray<string>): Template[] {
  const out: Template[] = [];
  const seen = new Set<string>();

  const add = (raw: string): void => {
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    if (collapsed.length === 0 || collapsed.length > MAX_TEMPLATE_CHARS) return;

    // Split on `${...}` holes. A nested-brace hole splits imperfectly, which
    // only ever makes the matcher STRICTER — never more permissive.
    const parts = collapsed.split(/\$\{[^{}]*\}/g);
    if (parts.join('').length < MIN_TEMPLATE_LITERAL_CHARS) return;

    const source = parts.map(esc).join(HOLE);
    if (seen.has(source)) return;
    seen.add(source);
    const trimmedParts = parts.slice();
    trimmedParts[0] = (trimmedParts[0] ?? '').trimStart();
    out.push({
      re: new RegExp(`^${source}$`),
      lead: trimmedParts[0]!,
      parts: trimmedParts,
      prefixCache: new Map(),
    });
  };

  for (const file of sourceFiles) {
    const text = readFileSync(file, 'utf8');
    const tokens = scanTemplateLiterals(text);
    /*
     * Join runs of literals concatenated with `+`. cdkd builds its longest
     * messages that way, and neither half alone matches what a user sees.
     */
    let run = '';
    for (let k = 0; k < tokens.length; k++) {
      const tok = tokens[k]!;
      const nextTok = tokens[k + 1];
      // Each literal is also registered alone: a concatenation may splice a
      // message with an unrelated neighbour, and the message is still real.
      add(tok.raw);
      run += tok.raw;
      if (nextTok && /^\s*\+\s*$/.test(text.slice(tok.end, nextTok.start))) continue;
      if (run !== tok.raw) add(run);
      run = '';
    }
  }
  return out;
}

/**
 * Is `message` an instance of some real template?
 *
 * A published example that ends in `...` is a deliberate truncation, so it is
 * matched as a PREFIX; anything else must match end to end. Escapes commonly
 * written into a quoted example (`\n` shown literally) are not interpreted —
 * a doc block shows what the terminal shows.
 */
export function matchesSourceTemplate(
  message: string,
  templates: ReadonlyArray<Template>
): boolean {
  const trimmed = message.trim();
  const truncated = /\s?\.\.\.$/.test(trimmed);
  const subject = truncated ? trimmed.replace(/\s?\.\.\.$/, '').trimEnd() : trimmed;
  if (subject.length === 0) return false;

  for (const t of templates) {
    if (t.re.test(subject)) return true;
    /*
     * A truncated quotation must be a genuine PREFIX of what the template
     * renders. Two arms, and the SECOND one's residual is stated rather than
     * claimed away, because two review rounds landed on it:
     *
     * - Round 1 found the original: it compared only the first
     *   `min(subject, lead)` characters and stopped, leaving the rest of the
     *   message unexamined, so `Failed to acquire the moon and every star ...`
     *   passed on an 18-character overlap.
     * - Round 2 found that the rewrite still accepted `Added node: TOTAL
     *   FABRICATION ...` whenever the borrowed text happened to align to a
     *   whole opening literal, while an inline comment here claimed both arms
     *   consumed the whole subject. They do not: arm (b) is anchored at the
     *   start only, and everything past the last matched literal sits in a
     *   HOLE, which this checker does not judge by design.
     *
     * So arm (b) now requires the truncation to reach a SECOND literal —
     * proving the author kept text from both sides of a hole, not just an
     * opening they could have copied. A quote cut inside the first hole is
     * refused; the remedy is to quote one clause further, which is a loud,
     * author-fixable outcome rather than a silent blessing.
     */
    if (truncated) {
      // (a) The author cut inside the opening literal.
      if (t.lead.startsWith(subject) && subject.length >= MIN_TEMPLATE_LITERAL_CHARS) return true;

      // (b) The author cut later, having crossed at least one hole.
      for (let k = t.parts.length; k >= 2; k--) {
        const head = t.parts.slice(0, k);
        if (head.join('').length < MIN_TEMPLATE_LITERAL_CHARS) break;
        if (prefixMatcher(t, k).test(subject)) return true;
      }
    }
  }
  return false;
}

/** Result of scanning one page: findings plus the coverage counters. */
export interface PageScan {
  findings: Finding[];
  fencedBlocks: number;
  fencedLines: number;
}

/**
 * Scan one page's fenced blocks for `Name: message` lines.
 *
 * The fence toggle keys on ``` at the start of a line (after optional
 * indentation), matching how the site's renderer delimits blocks.
 */
export function scanPage(
  relPath: string,
  text: string,
  errorNames: ReadonlySet<string>,
  templates: ReadonlyArray<Template>
): PageScan {
  const findings: Finding[] = [];
  let fencedBlocks = 0;
  let fencedLines = 0;
  let inFence = false;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      if (!inFence) fencedBlocks++;
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    fencedLines++;

    const m = /^\s*((?:[A-Za-z][A-Za-z0-9]*)?Error):\s+(\S.*)$/.exec(line);
    if (!m) continue;
    const [, errorName, firstLine] = m as unknown as [string, string, string];

    /*
     * A published block WRAPS a long message across several lines; the reader
     * sees one sentence. Absorb the continuation lines so the message is
     * matched whole — without this, every wrapped quotation is reported purely
     * for being long, which is the fastest way to get a fence switched off.
     * A blank line, a fence, a `Caused by:` line, or another class-prefixed
     * line all end the message.
     */
    // Captured BEFORE the absorption loop moves `i`, or a wrapped message is
    // reported at the line it ENDS on rather than the one it starts on.
    const startLine = i + 1;
    const parts = [firstLine];
    for (let j = i + 1; j < lines.length; j++) {
      const cont = lines[j]!;
      if (
        cont.trim() === '' ||
        /^\s*```/.test(cont) ||
        /^\s*Caused by:/.test(cont) ||
        /^\s*((?:[A-Za-z][A-Za-z0-9]*)?Error):\s+\S/.test(cont)
      ) {
        break;
      }
      parts.push(cont.trim());
      fencedLines++;
      i = j;
    }
    const message = parts.join(' ');

    let verdict: Verdict;
    if (!errorNames.has(errorName)) {
      verdict = FOREIGN_ERROR_NAMES.has(errorName) ? 'foreign-allowed' : 'unknown-class';
    } else {
      verdict = matchesSourceTemplate(message, templates) ? 'anchored' : 'no-source-anchor';
    }
    findings.push({ file: relPath, line: startLine, errorName, message, verdict });
  }
  return { findings, fencedBlocks, fencedLines };
}

/** A verdict that fails the build. */
export const BLOCKING: ReadonlySet<Verdict> = new Set<Verdict>(['unknown-class', 'no-source-anchor']);

/**
 * Fixed inputs with known verdicts, run BEFORE the real tree is read.
 *
 * The floors below can only catch a scanner that stops SEEING; they cannot
 * catch one that sees everything and approves it. These can: each accept case
 * dies if its arm is deleted, and each reject case dies if the predicate
 * degrades to "always pass". Both directions are represented for both
 * verdicts, which is what stops one arm carrying the whole probe.
 */
export const SELF_PROBE_CASES: ReadonlyArray<{
  what: string;
  line: string;
  errorNames: string[];
  /** Stands in for a source file — the probe runs the real extractor over it. */
  source: string;
  expect: Verdict | 'no-finding';
}> = [
  {
    what: 'a message that instantiates a real template',
    line: 'StateError: State has been modified by another process. Expected ETag: "abc", but state has changed.',
    errorNames: ['StateError'],
    source:
      'throw new StateError(`State has been modified by another process. Expected ETag: ${etag}, but state has changed.`)',
    expect: 'anchored',
  },
  {
    what: 'a hole in the MIDDLE of the phrase still matches (the shape a word-run test got wrong)',
    line: 'ProvisioningError: Failed to create resource MyBucket',
    errorNames: ['ProvisioningError'],
    source: 'throw new ProvisioningError(`Failed to ${verb} resource ${logicalId}`)',
    expect: 'anchored',
  },
  {
    what: 'a different message is NOT matched by that same wildcard template',
    line: 'ProvisioningError: Failed to publish asset: Access Denied',
    errorNames: ['ProvisioningError'],
    source: 'throw new ProvisioningError(`Failed to ${verb} resource ${logicalId}`)',
    expect: 'no-source-anchor',
  },
  {
    what: 'a message no template produces',
    line: 'ProvisioningError: Resource already exists: my-bucket-name',
    errorNames: ['ProvisioningError'],
    source: 'throw new ProvisioningError(`Failed to ${verb} resource ${logicalId}`)',
    expect: 'no-source-anchor',
  },
  {
    what: 'a class name cdkd never assigns',
    line: 'AssetPublisherError: Failed to publish asset: Access Denied',
    errorNames: ['AssetError'],
    source: 'throw new AssetError(`Asset publishing failed: ${detail}`)',
    expect: 'unknown-class',
  },
  {
    what: 'a foreign name with a recorded reason',
    line: 'CredentialsProviderError: Error: self-signed certificate in certificate chain',
    errorNames: ['StateError'],
    source: 'nothing relevant here',
    expect: 'foreign-allowed',
  },
  {
    what: 'a template split across a concatenation is rejoined',
    line: "LockError: Failed to acquire lock for stack 'MyStack' (us-east-1) after 4 attempts.",
    errorNames: ['LockError'],
    source:
      "new LockError(\n  `Failed to acquire lock for stack ` +\n    `'${s}' (${r}) after ${n + 1} attempts.`\n)",
    expect: 'anchored',
  },
  {
    what: 'a nearly-all-holes template is too weak to vouch for anything',
    line: 'ProvisioningError: absolutely anything at all: here',
    errorNames: ['ProvisioningError'],
    source: 'throw new ProvisioningError(`${a}: ${b}`)',
    expect: 'no-source-anchor',
  },
  {
    what: 'a doc block truncated with ... matches as a prefix',
    line: 'StateError: State has been modified by another process. Expected ...',
    errorNames: ['StateError'],
    source:
      'throw new StateError(`State has been modified by another process. Expected ETag: ${etag}, but state has changed.`)',
    expect: 'anchored',
  },
  {
    what: 'a line outside any fenced block is not a finding',
    line: 'StateError: whatever',
    errorNames: ['StateError'],
    source: '',
    expect: 'no-finding',
  },
];

/** Run the self-probe. Returns the failures, empty when healthy. */
export function runSelfProbe(): string[] {
  const failures: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-doc-error-probe-'));
  const tmp = join(dir, 'probe.ts');
  try {
  for (const c of SELF_PROBE_CASES) {
    // The 'no-finding' case is the one that must NOT be wrapped in a fence.
    const text = c.expect === 'no-finding' ? c.line : ['```text', c.line, '```'].join('\n');
    writeFileSync(tmp, c.source, 'utf8');
    const templates = extractTemplates([tmp]);
    const { findings } = scanPage('probe.md', text, new Set(c.errorNames), templates);
    const got = findings.length === 0 ? 'no-finding' : findings[0]!.verdict;
    if (got !== c.expect) {
      failures.push(`self-probe: ${c.what} — expected ${c.expect}, got ${got}`);
    }
  }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (process.env['CDKD_SELF_PROBE_FORCE_FAIL'] === '1') {
    failures.push('self-probe: forced failure via CDKD_SELF_PROBE_FORCE_FAIL');
  }
  return failures;
}

export interface Report {
  findings: Finding[];
  counts: { pages: number; fencedBlocks: number; fencedLines: number; errorNames: number; templates: number; quotedLines: number };
  floorViolations: string[];
  staleForeignNames: string[];
}

/** Scan the real tree. */
export function analyze(root: string = ROOT): Report {
  const sourceFiles = collectSourceFiles(join(root, 'src'));
  const errorNames = deriveErrorNames(sourceFiles);
  const templates = extractTemplates(sourceFiles);
  const pages = collectDocPages(join(root, 'docs'));

  const findings: Finding[] = [];
  let fencedBlocks = 0;
  let fencedLines = 0;
  for (const page of pages) {
    const scan = scanPage(
      relative(root, page).split(sep).join('/'),
      readFileSync(page, 'utf8'),
      errorNames,
      templates
    );
    findings.push(...scan.findings);
    fencedBlocks += scan.fencedBlocks;
    fencedLines += scan.fencedLines;
  }

  const counts = {
    pages: pages.length,
    fencedBlocks,
    fencedLines,
    errorNames: errorNames.size,
    templates: templates.length,
    quotedLines: findings.length,
  };

  const floorViolations: string[] = [];
  for (const [key, floor] of Object.entries(FLOORS)) {
    const actual = counts[key as keyof typeof counts];
    if (actual < floor) {
      floorViolations.push(`floor: ${key} = ${actual}, expected >= ${floor}`);
    }
  }

  /*
   * An allow-list entry survives only while it is still doing something. A name
   * cdkd has since adopted as its OWN error, or one no page quotes any more, is
   * a claim nobody re-checked — the shape that lets an exemption outlive the
   * reason it was granted.
   */
  const quoted = new Set(findings.map((f) => f.errorName));
  const staleForeignNames: string[] = [];
  for (const name of FOREIGN_ERROR_NAMES.keys()) {
    if (errorNames.has(name)) {
      staleForeignNames.push(`${name}: now a real cdkd error name — drop the FOREIGN_ERROR_NAMES entry`);
    } else if (!quoted.has(name)) {
      staleForeignNames.push(`${name}: no page quotes it any more — drop the FOREIGN_ERROR_NAMES entry`);
    }
  }

  return { findings, counts, floorViolations, staleForeignNames };
}

function main(): void {
  const probeFailures = runSelfProbe();
  if (probeFailures.length > 0) {
    for (const f of probeFailures) console.error(f);
    console.error('\nThe checker failed its own fixed cases, so its verdict on the tree means nothing.');
    process.exit(1);
  }

  const report = analyze();
  const blocking = report.findings.filter((f) => BLOCKING.has(f.verdict));

  for (const f of blocking) {
    const why =
      f.verdict === 'unknown-class'
        ? `cdkd assigns no error the name '${f.errorName}'`
        : 'no message template in src/ produces this line';
    console.error(`${f.file}:${f.line}  [${f.verdict}] ${f.errorName}: ${f.message}\n    ${why}`);
  }
  for (const v of [...report.floorViolations, ...report.staleForeignNames]) console.error(v);

  const c = report.counts;
  const summary =
    `${c.pages} pages, ${c.fencedBlocks} fenced blocks, ${c.fencedLines} fenced lines, ` +
    `${c.errorNames} error names and ${c.templates} templates derived, ` +
    `${report.findings.length} quoted error lines`;

  if (blocking.length > 0 || report.floorViolations.length > 0 || report.staleForeignNames.length > 0) {
    console.error(`\ncheck FAILED — ${summary}`);
    process.exit(1);
  }
  console.log(`check OK — ${summary}`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) main();
