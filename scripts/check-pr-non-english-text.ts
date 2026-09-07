/**
 * CI port of `.claude/hooks/non-english-text-gate.sh` (deleted).
 *
 * WHAT THE HOOK WAS
 * -----------------
 * A PreToolUse gate on `gh pr create` / `gh pr edit` / `gh pr merge` that
 * refused the call when the PR diff carried non-English writing-system
 * characters. The repo is OSS and every committed artifact must be English
 * (the workflow rule); PR #521 shipped verbatim Japanese session quotes into
 * `.markgate.yml` and a hook header, and nothing structural caught it.
 *
 * WHAT WAS DELIBERATELY DROPPED
 * -----------------------------
 * Everything that existed only because a PreToolUse hook receives raw SHELL
 * COMMAND TEXT and has to find the artifact inside it:
 *
 *   - the `gate_matches` verb recognition (heredoc neutralisation, quoted-span
 *     neutralisation, command-position matching, `VAR=x` / `env` / `nohup`
 *     prefixes);
 *   - `gate_target_dir_strict` — resolving which working tree the command
 *     would run in from `cd` segments and `git -C` flags, and the
 *     fail-closed refusal when that could not be read;
 *   - `gate_pr_selector` — digging the PR number out of `gh pr merge --squash
 *     552` / `gh pr merge -t 42 552`;
 *   - the `gh auth status` / `gh pr view --json number` / `gh pr view --json
 *     headRefOid` / `gh api .../contents/<f>?ref=<sha>` chain that fetched the
 *     head content over the network, plus its base64 decode;
 *   - the two-mode design (PR mode vs the local `origin/main..HEAD` fallback
 *     for a branch with no PR yet);
 *   - every fail-OPEN branch (gh missing, gh unauthenticated, target not a git
 *     repo, no merge base). A CI job is handed the base and head SHAs by the
 *     event payload, so "I could not work out what to scan" is a BUG, not a
 *     reason to wave the PR through. This check fails CLOSED on all of them.
 *
 * The one shell-parsing behaviour with no CI equivalent is the local-diff
 * fallback for a branch that has no PR yet — `on: pull_request` only fires
 * once a PR exists, which is the same funnel `gh pr merge` was.
 *
 * WHAT WAS PRESERVED, CHARACTER FOR CHARACTER
 * -------------------------------------------
 *   - The Unicode class. Five ranges, no more and no fewer:
 *       U+3000-U+303F  CJK Symbols and Punctuation
 *       U+3040-U+309F  Hiragana
 *       U+30A0-U+30FF  Katakana
 *       U+4E00-U+9FFF  CJK Unified Ideographs (kanji / Chinese)
 *       U+AC00-U+D7AF  Hangul Syllables
 *     General-purpose Unicode the repo already uses PASSES: em-dashes, curly
 *     quotes, box-drawing characters in the CLAUDE.md ASCII art, arrow glyphs
 *     in docs. Writing systems only.
 *   - The binary / lockfile / asset extension skip list, including its
 *     case-sensitivity and the fact that the four lockfile names are matched
 *     against the WHOLE repo-relative path (the hook's `case "$f" in
 *     pnpm-lock.yaml)` matched a root-level lockfile only).
 *   - The sidecar allow-list and its three load-bearing properties
 *     (.claude/rules/hooks.md). See ALLOWLIST_PATH below.
 *   - MAX_REPORT = 20 offending lines, then stop.
 *
 * THE SEMANTIC NOTE THE PORT HAD TO CHOOSE ON — WHOLE FILE, NOT ADDED LINES
 * ------------------------------------------------------------------------
 * The hook read each changed file's WHOLE CONTENT at the PR head, not just the
 * added lines, and this port KEEPS that. It is not an accident of the hook's
 * implementation: a file that legitimately contains the characters then blocks
 * every PR that touches it, which is precisely why the sidecar allow-list has
 * to exist and why it is kept small. Switching to added-lines-only would make
 * the allow-list look redundant while quietly letting a PR that MOVES an
 * offending block inside a file pass, and letting pre-existing violations sit
 * forever. Whole-file is the stricter and the auditable choice, so it stays,
 * and the allow-list stays with it.
 *
 * ONE DELIBERATE ADDITION, STATED RATHER THAN SLIPPED IN
 * -----------------------------------------------------
 * A STALE allow-list entry — one naming a path that no longer exists in the
 * tree — fails this check. The hook had no such audit. An entry is a permanent
 * hole in the English-only rule for that path; a hole pointing at a deleted
 * file is a hole nobody can see, and the same ratchet already guards
 * `tests/aws-client-defaults-allowlist.json` in ci.yml. Drop the entry when
 * the file goes.
 *
 * WHY THIS FILE CONTAINS NO NON-ENGLISH CHARACTERS
 * ------------------------------------------------
 * Its self-probe builds the probe strings from CODE POINTS
 * (`String.fromCodePoint(0x3042)`), so the source stays ASCII and this script
 * does not need to be on its own allow-list. That is the same property the
 * allow-list file itself has to hold: describe the content, never reproduce
 * it. The first draft of the allow-list quoted the characters it describes and
 * the gate correctly blocked the PR that introduced it.
 */

import { foldAnnotationText } from './annotation-text.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The sidecar allow-list, resolved ABSOLUTE from THIS SCRIPT's own directory.
 *
 * Three load-bearing properties, all carried over from the hook:
 *
 *  1. Entries match EXACTLY. Never a prefix, never a glob. One entry silently
 *     exempting a whole directory is the failure mode that makes an allow-list
 *     worse than no allow-list.
 *  2. The path is resolved from the CHECK's own directory, not from anything
 *     the scanned file implies and not from the process cwd. The list is part
 *     of the check's definition.
 *  3. The list is NOT on itself. Its comments must DESCRIBE an entry's content
 *     and never reproduce it -- otherwise the list becomes a hole anyone can
 *     widen by writing into it.
 *
 * An absent or unreadable list scans EVERYTHING. That is the safe direction
 * and it is deliberate.
 */
export const ALLOWLIST_PATH = join(SCRIPT_DIR, 'non-english-allowlist.txt');

/**
 * The Unicode class, character for character as the hook's perl matcher had
 * it. This is NOT a single source -- `scripts/check-gh-body-english.ts` holds
 * its own independent literal, and an earlier revision of this comment claimed
 * otherwise. The two are held identical by
 * `tests/unit/scripts/non-english-class-sync.test.ts`, which compares source and
 * flags and pins both ends of every range; keep that fence, not this sentence.
 */
export const NON_ENGLISH_RE =
  /[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/u;

/** The hook's MAX_REPORT. Stop collecting after this many offending lines. */
export const MAX_REPORT = 20;

/**
 * Extensions and lockfile names whose bytes can legitimately carry non-ASCII
 * content. Ported verbatim from the hook's `should_scan` case statement,
 * including its case-sensitivity (a `.PNG` was scanned there and is scanned
 * here).
 */
const SKIP_EXTENSIONS: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.webp',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.7z',
  '.xz',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
  '.mov',
  '.lock',
];

/**
 * Whole-path matches, not basenames. The hook's `case "$f" in pnpm-lock.yaml)`
 * compared the repo-relative path, so only a ROOT-level lockfile was skipped.
 */
const SKIP_PATHS: readonly string[] = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'Cargo.lock',
  'go.sum',
];

export interface Offender {
  /** 1-based line number, as the hook's perl `$.` reported it. */
  line: number;
  /** The offending line, trailing CR/LF stripped. */
  text: string;
}

export interface FileOffender extends Offender {
  file: string;
}

/**
 * Parse the sidecar list. Only a WHOLE-LINE comment is stripped: a trailing
 * `s/#.*$//` would truncate a path legitimately containing `#` to a PREFIX,
 * and a prefix is exactly what this list must never match on.
 */
export function parseAllowlist(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => !/^[ \t]*#/.test(l))
    .map((l) => l.replace(/[ \t]+$/, ''))
    .filter((l) => l !== '');
}

/** Exact match, never a glob and never a prefix. */
export function isAllowlisted(file: string, allowed: readonly string[]): boolean {
  return allowed.includes(file);
}

/** The extension / lockfile skip list. */
export function hasSkippedExtension(file: string): boolean {
  if (SKIP_PATHS.includes(file)) return true;
  return SKIP_EXTENSIONS.some((ext) => file.endsWith(ext));
}

/** The hook's `should_scan`: allow-list first, then the skip list. */
export function shouldScan(file: string, allowed: readonly string[]): boolean {
  if (isAllowlisted(file, allowed)) return false;
  if (hasSkippedExtension(file)) return false;
  return true;
}

/**
 * The detector. One pass over the lines of a file's WHOLE content, reporting
 * every line that carries a character in the class.
 */
export function findNonEnglishLines(content: string): Offender[] {
  const out: Offender[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    if (NON_ENGLISH_RE.test(text)) {
      // Folded at CONSTRUCTION, not only where it is printed.
      //
      // Three review rounds of go-to-k/cdkd#2736 each found one echo site
      // folded and another missed -- `hits` while `text` was raw, then the
      // `::error` annotation while the `Found:` block was raw. Each file has
      // MORE THAN ONE emitter, so "fold at the emitter" is a rule that has to
      // be re-obeyed at every site somebody adds later, and it was not obeyed
      // twice in a row. Folding once, here, makes every present and future
      // echo safe by construction. The emitter folds stay as well: the fold is
      // idempotent, and they are what the tests pin.
      //
      // Safe because this field is DISPLAY-ONLY -- nothing compares, re-parses
      // or persists it.
      // The trailing-CR STRIP is kept ahead of the fold, not replaced by it: a
      // CRLF artifact at end of line should vanish, and folding it instead
      // leaves a trailing space in every reported line. The suite pinned that
      // and caught the change.
      out.push({ line: i + 1, text: foldAnnotationText(text.replace(/\r$/, '')) });
    }
  }
  return out;
}

/**
 * Scan a set of changed files. `readFile` returns the file's content at the PR
 * HEAD, or null when it cannot be read (a path the diff lists but the head
 * tree does not carry -- the hook's `git show` returning empty).
 *
 * Collection stops at MAX_REPORT, exactly as the hook's `break 2` did.
 */
export function scanChangedFiles(
  files: readonly string[],
  allowed: readonly string[],
  readFile: (file: string) => string | null,
): FileOffender[] {
  const offenders: FileOffender[] = [];
  for (const file of files) {
    if (!shouldScan(file, allowed)) continue;
    const content = readFile(file);
    // UNREADABLE IS AN ERROR, NOT A SKIP. `shouldScan` has already decided this
    // path is in scope, so a null here means the read FAILED -- and skipping it
    // exits 0 having not looked at the one file we were told to look at. That
    // is the direction that ships the violation: measured during the
    // go-to-k/cdkd#2717 review, a `git show` on a C-quoted non-ASCII path
    // failed, this line swallowed it, and a Japanese file with Japanese content
    // reported clean. The quoting cause is fixed at the git boundary; this
    // closes the CLASS, since any other unreadable-in-scope path (a broken
    // symlink, a submodule gitlink, an object missing from a partial clone)
    // reaches the same line.
    if (content === null) {
      throw new Error(
        `cannot read ${foldAnnotationText(file)} at the PR head. It is in scope, so refusing rather than ` +
          `reporting a clean scan that never read it.`,
      );
    }
    for (const hit of findNonEnglishLines(content)) {
      offenders.push({ file, ...hit });
      if (offenders.length >= MAX_REPORT) return offenders;
    }
  }
  return offenders;
}

/**
 * The deliberate ADDITION documented in the header: report allow-list entries
 * whose path no longer exists. Returns the dead entries.
 */
export function findStaleAllowlistEntries(
  allowed: readonly string[],
  fileExists: (file: string) => boolean,
): string[] {
  return allowed.filter((entry) => !fileExists(entry));
}

/**
 * Self-probe. A checker that has gone dead and a clean tree produce the same
 * green, so prove BOTH directions before reading anything.
 *
 * Every positive probe is built from code points so this source file stays
 * ASCII (see the header). The negative probes are written literally, because
 * "an em-dash must not match" is only pinned by an actual em-dash.
 */
export function selfProbe(): string[] {
  const failures: string[] = [];
  const cp = (...codes: number[]) => String.fromCodePoint(...codes);

  const mustMatch: Array<[string, string]> = [
    ['hiragana U+3042', cp(0x3042)],
    ['katakana U+30B9', cp(0x30b9)],
    ['kanji U+4FDD', cp(0x4fdd)],
    ['hangul U+C548', cp(0xc548)],
    ['CJK punctuation U+300C', cp(0x300c, 0x300d)],
    ['range floor U+3000', cp(0x3000)],
    ['range ceiling U+D7AF', cp(0xd7af)],
  ];
  for (const [label, sample] of mustMatch) {
    if (findNonEnglishLines(`prefix ${sample} suffix`).length !== 1) {
      failures.push(`detector did not flag ${label}`);
    }
  }

  const mustNotMatch: Array<[string, string]> = [
    ['plain ASCII', 'const foo = 1; // a comment'],
    ['em-dash', 'Em-dash here - and here — done'],
    ['curly quotes', '“smart quotes” and ‘curly apostrophes’'],
    ['box drawing', '┌──┐ │ x │ └──┘'],
    ['arrows', 'entry → exit ⇒ done'],
    ['accented latin', 'naïve café résumé'],
    ['emoji', 'ship it \u{1f680}'],
  ];
  for (const [label, sample] of mustNotMatch) {
    if (findNonEnglishLines(sample).length !== 0) {
      failures.push(`detector wrongly flagged ${label}`);
    }
  }

  if (shouldScan('docs/x.png', [])) failures.push('skip list did not skip docs/x.png');
  if (shouldScan('pnpm-lock.yaml', [])) failures.push('skip list did not skip pnpm-lock.yaml');
  if (!shouldScan('src/foo.ts', [])) failures.push('skip list wrongly skipped src/foo.ts');
  if (shouldScan('a/b.ts', ['a/b.ts']) !== false) {
    failures.push('allow-list did not exempt a listed path');
  }
  if (shouldScan('a/b.ts.bak', ['a/b.ts']) !== true) {
    failures.push('allow-list matched a path merely PREFIXED by a listed one');
  }

  return failures;
}

// --------------------------------------------------------------------------
// CI plumbing. Everything above is pure and unit-tested; everything below
// talks to git and to the GitHub Actions environment.
// --------------------------------------------------------------------------

function git(args: string[]): string {
  // `core.quotePath=false` on EVERY call, set here because this wrapper is the
  // one choke point. Without it git C-quotes any path outside ASCII --
  // `docs/x-\346\227\245.md` -- and that name then fails to resolve on the
  // way back in: `git show <sha>:"docs/x-\346..."` errors, the read returns
  // null, and the file is skipped. MEASURED on git 2.49 during the review of
  // go-to-k/cdkd#2717: an ASCII-named file with hiragana content exits 1, while
  // the byte-identical content under a Japanese FILENAME exits 0 and reports
  // `Scanned 2 changed file(s)`. A check that silently skips the file most
  // likely to contain the thing it looks for is worse than no check.
  //
  // The unit suite cannot see this -- it stubs the file reader -- which is why
  // the fix belongs at the git boundary and not in a case.
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function gitOrNull(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

export interface DiffScope {
  baseSha: string;
  headSha: string;
  mergeBase: string;
  /** Every path the PR touches, before any filtering. */
  allChanged: string[];
  /** Added / modified / renamed paths -- what `gh pr diff --name-only` showed. */
  scannable: string[];
}

/**
 * Resolve what to scan. FAILS CLOSED: a base or head this cannot read is an
 * error, not a pass. The hook's fail-open branches existed because a developer
 * machine might not have `gh`; CI is handed both SHAs by the event payload.
 */
export function resolveDiffScope(baseSha: string, headSha: string): DiffScope {
  if (!baseSha || !headSha) {
    throw new Error(
      'BASE_SHA / HEAD_SHA are empty. They come from github.event.pull_request.{base,head}.sha; ' +
        'without them this check would scan nothing and report a vacuous green.',
    );
  }
  const mergeBase = gitOrNull(['merge-base', baseSha, headSha])?.trim();
  if (!mergeBase) {
    throw new Error(
      `git merge-base ${baseSha} ${headSha} failed. The checkout needs fetch-depth: 0 so both ` +
        'sides of the PR are present.',
    );
  }
  const split = (out: string | null) =>
    (out ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');

  return {
    baseSha,
    headSha,
    mergeBase,
    allChanged: split(gitOrNull(['diff', '--name-only', mergeBase, headSha])),
    // AMR, not the hook's local-mode AM: `gh pr diff --name-only` -- the list
    // the hook used in PR mode, which is the mode CI replaces -- lists a
    // renamed path too, and a rename is exactly how an offending file arrives
    // without an added line.
    scannable: split(gitOrNull(['diff', '--name-only', '--diff-filter=AMR', mergeBase, headSha])),
  };
}

function readAtHead(headSha: string, file: string): string | null {
  // A SUBMODULE is a mode-160000 gitlink, not a blob: `git show <sha>:<path>`
  // answers `fatal: bad object`, and treating that as "unreadable" would refuse
  // an honest PR that adds one (reproduced on git 2.49 during the
  // go-to-k/cdkd#2717 fix-delta review). Ask git what the entry IS before
  // concluding the read failed. There is no text in a gitlink to scan, so
  // skipping it loses no coverage -- unlike the unreadable case, which does.
  const mode = gitOrNull(['ls-tree', headSha, '--', file])?.trim().split(/\s+/)[0];
  if (mode === '160000') return '';
  const out = gitOrNull(['show', `${headSha}:${file}`]);
  return out === null ? null : out;
}

/**
 * The `::error` annotation for one offender.
 *
 * Extracted so the FOLD is testable. `o.text` is a line of a fork PR's file
 * content, echoed into a step's stdout, and the Actions runner reads workflow
 * commands out of that stream -- so a raw CR in it starts a new line and
 * `::stop-commands::` becomes injectable. This file stripped only a TRAILING
 * carriage return until go-to-k/cdkd#2736; see `annotation-text.ts` for why the
 * rule is shared rather than repeated here.
 */
export function formatAnnotation(o: FileOffender): string {
  return (
    `::error file=${foldAnnotationText(o.file)},line=${o.line}::non-English writing-system characters: ` +
    foldAnnotationText(o.text)
  );
}

/**
 * The `Found:` summary row for one offender.
 *
 * Extracted for the same reason `formatAnnotation` was: it is a SECOND echo of
 * the same attacker-controlled fields, and three review rounds in a row fixed
 * one echo per file while leaving another raw. A function can be asserted; an
 * inline template inside `main()` cannot.
 *
 * The `- ` marker is load-bearing, not decoration. The Actions runner
 * TRIM-STARTS each line before deciding whether it is a workflow command, so
 * the two-space indent protects nothing -- and `git diff --name-only` never
 * quotes `:`, `,`, `=` or a space, so a fork PR can add a file literally named
 * `::error file=src/index.ts,line=1::...` and forge one with no control
 * character at all, which folding cannot prevent (go-to-k/cdkd#2736 round-4
 * security review).
 */
export function formatFoundRow(o: FileOffender): string {
  return `  - ${foldAnnotationText(o.file)}:${o.line}: ${foldAnnotationText(o.text)}`;
}

export function main(env: NodeJS.ProcessEnv = process.env): number {
  const probeFailures = selfProbe();
  if (probeFailures.length > 0) {
    console.error('::error::the non-English detector failed its own self-probe:');
    for (const f of probeFailures) console.error(`  - ${f}`);
    return 1;
  }

  let scope: DiffScope;
  try {
    scope = resolveDiffScope(env['BASE_SHA'] ?? '', env['HEAD_SHA'] ?? '');
  } catch (err) {
    console.error(`::error::${(err as Error).message}`);
    return 1;
  }

  // The vacuous-green guard. Every PR changes at least one file, so an empty
  // UNFILTERED list means the refs are wrong, not that the PR is clean. The
  // FILTERED list may legitimately be empty (a delete-only PR).
  if (scope.allChanged.length === 0) {
    console.error(
      `::error::resolved 0 changed files for ${scope.mergeBase}..${scope.headSha}. A PR always ` +
        'changes at least one file, so the refs are wrong and this check scanned nothing.',
    );
    return 1;
  }

  let allowed: string[] = [];
  if (existsSync(ALLOWLIST_PATH)) {
    allowed = parseAllowlist(readFileSync(ALLOWLIST_PATH, 'utf8'));
    const stale = findStaleAllowlistEntries(allowed, (f) => existsSync(f));
    if (stale.length > 0) {
      console.error(
        '::error::non-english-allowlist.txt names paths that no longer exist. An allow-list entry ' +
          'is a permanent hole in the English-only rule for that path; drop the entry when the ' +
          'file goes.',
      );
      // Folded for uniformity, not because it is reachable: the allow-list is
      // read from the BASE checkout, which a fork PR cannot write. Uniformity
      // is the point -- a per-site judgement about reachability is what let
      // three echoes ship raw (go-to-k/cdkd#2736 round-5 review).
      for (const entry of stale) console.error(`  - ${foldAnnotationText(entry)}`);
      return 1;
    }
  } else {
    // The safe direction, and deliberate: no list means scan everything.
    console.log(`No allow-list at ${ALLOWLIST_PATH} -- scanning every changed file.`);
  }

  // The refusal below is a REPORTED failure, not a crash. Uncaught, it printed a
  // stack trace with no `::error::` annotation and discarded any offenders
  // already collected -- so the one case where the check refuses gave the reader
  // less than the case where it passes (go-to-k/cdkd#2717 fix-delta review).
  let offenders: FileOffender[];
  try {
    offenders = scanChangedFiles(scope.scannable, allowed, (f) => readAtHead(scope.headSha, f));
  } catch (err) {
    console.error(`::error::${(err as Error).message}`);
    return 1;
  }

  console.log(
    `Scanned ${scope.scannable.length} changed file(s) at ${scope.headSha.slice(0, 12)} ` +
      `(${allowed.length} allow-listed path(s)).`,
  );

  if (offenders.length === 0) return 0;

  for (const o of offenders) {
    console.error(
      formatAnnotation(o),
    );
  }

  console.error('');
  console.error('This PR contains non-English writing-system characters');
  console.error('(hiragana / katakana / kanji / Chinese / hangul / CJK punctuation).');
  console.error('');
  console.error('This is an OSS repo. Every committed artifact must be English-only');
  console.error('per the workflow rule: source code, shell scripts, config files,');
  console.error('docs, comments, commit messages, PR titles/bodies. Conversation in');
  console.error('chat may be in any language -- this rule applies to the repository.');
  console.error('');
  console.error('Found:');
  // The `- ` marker is not decoration. The Actions runner TRIM-STARTS each
  // output line before deciding whether it is a workflow command, so a
  // whitespace-only indent protects NOTHING -- and `git diff --name-only`
  // C-quotes control bytes but never `:`, `,`, `=` or a space, so a fork PR can
  // add a file literally NAMED
  // `::error file=src/index.ts,line=1::CI self-check FAILED` and forge a command
  // with no control character at all. Folding cannot help there; only a
  // NON-WHITESPACE prefix can (go-to-k/cdkd#2736 round-4 security review).
  for (const o of offenders) console.error(formatFoundRow(o));
  if (offenders.length >= MAX_REPORT) {
    console.error(`  ... reporting stopped at ${MAX_REPORT} lines.`);
  }
  console.error('');
  console.error('Fix:');
  console.error('  - Translate the offending text to English.');
  console.error('  - For docstrings / comments: rewrite in English.');
  console.error('  - For a verbatim session quote (the PR #521 trap): rewrite it as a');
  console.error('    project-level contract statement, not as a quote.');
  console.error('  - Only if the characters ARE the subject under test, add the exact');
  console.error(`    path to ${ALLOWLIST_PATH} -- and DESCRIBE the content there,`);
  console.error('    never reproduce it (the list is not on its own list).');
  return 1;
}

/**
 * `import.meta.url === \`file://${process.argv[1]}\`` is WRONG in two ways that
 * both end in the script exiting 0 having done nothing. Node resolves the main
 * module to its REALPATH while `argv[1]` keeps the symlink, and a path needing
 * percent-encoding (a space, a `#`) never string-matches its file URL.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = main();
}
