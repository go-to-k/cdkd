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
 * Three properties of the corpus had to be handled or the check reports nothing
 * but false alarms, and all three were found by running it:
 *
 * - **Templates are read with TypeScript's own parser.** A backtick regex, and
 *   then a hand-rolled character scanner, each desynced on real code; the
 *   scanner's history is in `scanTemplateLiterals`.
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
 * - **A quotation the author TRUNCATED with an ellipsis is REFUSED, not
 *   partially verified.** This was the opposite for six review rounds, and
 *   each remedy was found accepting a fabrication one step further out:
 *   comparing only the overlapping characters; accepting a borrowed opening
 *   that aligned to a whole literal; a whitespace-only second literal; a
 *   one-character one; templates with no opening literal at all; and finally
 *   an unbounded hole between two literals, where `Failed to ${verb} resource
 *   ${id}` vouched for an entire invented sentence. What settled it was a
 *   measurement rather than a seventh guard: ZERO of the site's quoted error
 *   lines are truncated, so 45 lines of partial-matching served no real case
 *   while admitting thousands of vouchers. Refusing costs an author one more
 *   clause; the alternative made `...` the documented way past the fence.
 *
 *   The refusal is UNCONDITIONAL, and that is the seventh round's lesson. An
 *   earlier cut exempted templates whose own text ends in an ellipsis, to keep
 *   a message like `Executing UPDATE changeset...` quotable — and the
 *   exemption immediately re-opened the hole, because `Assuming role
 *   ${roleArn}...` also ends in one and its hole sits against the dots. Zero
 *   quotations on the site need the exemption, so it is gone: every guard that
 *   served no real case has cost a review round. If a page ever must quote an
 *   ellipsis-terminated message, restore it deliberately, with the
 *   wording-before-the-dots test the exemption turned out to need.
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
import ts from 'typescript-v6';
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
 * wording somebody actually wrote. The margin over the threshold is THIN for
 * the tightest voucher on the site, so treat this constant as load-bearing:
 * raising it would strand a real quotation, lowering it admits templates that
 * carry no wording of their own.
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

export type Verdict =
  | 'anchored'
  | 'foreign-allowed'
  | 'unknown-class'
  | 'no-source-anchor'
  | 'truncated-quotation';

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
  /** Whole-message matcher, holes widened to wildcards, anchored at both ends. */
  re: RegExp;
}

/** Escape a literal for embedding in a regex. */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Wildcard standing in for one `${...}` hole. */
const HOLE = '[\\s\\S]*?';

/**
 * An elision marker at the end of a string. Deliberately wider than `...`:
 * two dots, spaced dots and `\u2026` all read as "the author cut here", and a
 * predicate that recognises only the canonical spelling is one character away
 * from being bypassed.
 */
const ELLIPSIS_TAIL = /(?:\.\s*){2,}$|\u2026$/;

/** Literal characters that are not whitespace — the only ones that anchor anything. */

/** Longest template worth compiling. Past this it is a code block, not a message. */
const MAX_TEMPLATE_CHARS = 600;

/**
 * Template literals in one source file, in source order, each paired with the
 * source offsets of its delimiters.
 *
 * TypeScript's own parser, not a hand-rolled scanner. The first cut paired
 * backticks with a regex and produced "templates" made of whole object
 * literals, because this repo's JSDoc is dense with `backticked` prose. The
 * replacement was a character-level state machine, and three review rounds
 * each found a fresh desync in it — a regex literal containing a quote, a
 * brace inside a hole, then a quote inside a hole, then a quote inside a
 * REGEX inside a hole. Every fix was correct and every fix exposed the next
 * case, which is the signal to stop patching a hand-rolled parser and use the
 * real one (`.claude/rules/testing.md`'s oracle rule).
 *
 * `typescript-v6` is an npm alias of typescript@6 — TS7 ships the stable
 * compiler API only under `typescript/unstable/*`, so the codegen scripts in
 * this directory all import the alias.
 */
export function scanTemplateLiterals(
  text: string
): Array<{ raw: string; start: number; end: number }> {
  const sf = ts.createSourceFile('scan.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /*
   * An unparseable file yields a PARTIAL tree, not an error: its templates go
   * missing while every count stays plausible. `FLOORS.templates` carries
   * thousands of slack, so the largest files could all fail to parse and the
   * run would still report green — the fail-vacuous shape the sibling critics
   * hard-fail on for the same reason.
   */
  const diagnostics = (sf as unknown as { parseDiagnostics?: ReadonlyArray<unknown> })
    .parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    throw new Error(
      `refusing to scan: ${diagnostics.length} parse diagnostic(s); a partial tree silently drops templates`
    );
  }
  const out: Array<{ raw: string; start: number; end: number }> = [];

  const visit = (node: ts.Node): void => {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const start = node.getStart(sf);
      const end = node.getEnd();
      // The raw source BETWEEN the backticks, holes included — the same shape
      // the character scanner produced, so the rest of the pipeline is
      // unchanged.
      out.push({ raw: text.slice(start + 1, end - 1), start, end });
      // Do NOT descend: a template nested inside a hole is part of this
      // template's text, and emitting it again would double-count it.
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  out.sort((a, b) => a.start - b.start);
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
    out.push({
      re: new RegExp(`^${source}$`),
    });
  };

  for (const file of sourceFiles) {
    const text = readFileSync(file, 'utf8');
    let tokens;
    try {
      tokens = scanTemplateLiterals(text);
    } catch (e) {
      // Name the file: the scan refuses a partial tree, and a refusal that
      // does not say which input caused it is not actionable.
      throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
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
 * A quotation must match a template end to end. One that the author cut short
 * with an ellipsis is refused instead — see {@link looksTruncated}. Escapes
 * commonly written into a quoted example (`\n` shown literally) are not
 * interpreted: a doc block shows what the terminal shows.
 */
export function matchesSourceTemplate(
  message: string,
  templates: ReadonlyArray<Template>
): boolean {
  const subject = message.trim();
  if (subject.length === 0) return false;
  /*
   * A quotation the author cut short is refused outright — see the header for
   * why the exemption that used to live here is gone. This must sit BEFORE the
   * match, not after it: most templates end in a hole whose wildcard absorbs
   * the trailing dots, so a fabrication matches outright and a refusal checked
   * afterwards never fires.
   */
  if (looksTruncated(subject)) return false;
  return templates.some((t) => t.re.test(subject));
}

/**
 * Does this quotation END in an ellipsis, i.e. did the author elide the rest?
 *
 * Consulted INSIDE {@link matchesSourceTemplate}: a handful of real messages
 * genuinely end in `...`, so a truncated subject is matched against those
 * templates only, rather than being refused outright.
 */
export function looksTruncated(message: string): boolean {
  return ELLIPSIS_TAIL.test(message.trim());
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
    } else if (matchesSourceTemplate(message, templates)) {
      verdict = 'anchored';
    } else {
      /*
       * A quotation the author ended with an ellipsis is REFUSED rather than
       * partially verified. Six review rounds each found the partial-match
       * rule accepting a fabrication one step further out, and the measurement
       * that settled it is that ZERO of the site's quoted error lines are
       * truncated — 45 lines of guarded matching served no real case while
       * admitting thousands of vouchers. Making `...` the way past the fence
       * would have been the per-message opt-out this checker refuses to have.
       */
      verdict = looksTruncated(message) ? 'truncated-quotation' : 'no-source-anchor';
    }
    findings.push({ file: relPath, line: startLine, errorName, message, verdict });
  }
  return { findings, fencedBlocks, fencedLines };
}

/** A verdict that fails the build. */
export const BLOCKING: ReadonlySet<Verdict> = new Set<Verdict>([
  'unknown-class',
  'no-source-anchor',
  'truncated-quotation',
]);

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
    source: 'const unrelated = 1;',
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
    what: 'a doc block truncated with ... is REFUSED, not partially verified',
    line: 'StateError: State has been modified by another process. Expected ...',
    errorNames: ['StateError'],
    source:
      'throw new StateError(`State has been modified by another process. Expected ETag: ${etag}, but state has changed.`)',
    expect: 'truncated-quotation',
  },
  {
    what: 'an ellipsis-ending message is refused too — the refusal is unconditional',
    line: 'StateError: Reticulating splines, please wait...',
    errorNames: ['StateError'],
    source: 'throw new StateError(`Reticulating splines, please wait...`)',
    expect: 'truncated-quotation',
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
  counts: { pages: number; fencedBlocks: number; fencedLines: number; errorNames: number; templates: number };
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
        : f.verdict === 'truncated-quotation'
          ? 'a quotation ending in an ellipsis cannot be verified — quote the message in full'
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
