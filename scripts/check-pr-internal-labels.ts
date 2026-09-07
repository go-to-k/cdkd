/**
 * CI port of `.claude/hooks/internal-pr-labels-gate.sh` (deleted).
 *
 * WHAT THE HOOK WAS
 * -----------------
 * A PreToolUse gate on `git commit` that refused the commit when a staged
 * user-facing doc ADDED an internal development-phase label -- `(PR 8b)`,
 * `(PR 6 of #224)`, `(PR 6 of #224, issue #232)`. PR #251 had to clean exactly
 * that out of README.md and docs/cli-reference.md, where agent-dispatch prose
 * had been mirrored into headings end-users read:
 *
 *     ## Container Lambdas (PR 5 of #224)
 *     ### Lambda Layers (PR 6 of #224, issue #232)
 *
 * WHAT WAS DELIBERATELY DROPPED
 * -----------------------------
 * Everything that existed only because a PreToolUse hook receives raw SHELL
 * COMMAND TEXT and has to find the artifact inside it:
 *
 *   - `gate_matches` verb recognition against `$GATE_RE_GIT_COMMIT` (heredoc
 *     and quoted-span neutralisation, command-position matching, `VAR=x` /
 *     `env` / `command` / `nohup` prefixes) -- the machinery that made
 *     `git add -A && git commit` fire and `echo "git commit"` not fire;
 *   - `gate_target_dir_strict` -- resolving which working tree the commit
 *     would land in from `cd` segments and `git -C` flags, and the fail-closed
 *     refusal when that could not be read;
 *   - the whole staged-index vocabulary (`git diff --cached`, `git show :<f>`)
 *     that existed only because the artifact did not exist as a commit yet.
 *
 * There is NO behaviour here without a CI equivalent: the hook's subject was
 * "what this commit is about to add to a user-facing doc", and the PR diff is
 * the same question asked once per PR instead of once per commit. What changes
 * is only WHEN it is answered -- at merge time rather than at commit time.
 *
 * WHAT WAS PRESERVED
 * ------------------
 *   - Scope: README.md at the repo ROOT plus any `.md` under `docs/`
 *     (recursive). EXCLUDED: everything under `.claude/`, any `CLAUDE.md`
 *     anywhere, and `tests/integration/**\/README.md` (integ fixture metadata,
 *     which legitimately cites its own implementation PR).
 *   - Only ADDED lines are judged, in NEW-FILE line coordinates.
 *   - Fenced code blocks are allow-listed. The fence state is tracked over the
 *     file's FULL content at the PR head, not over the diff -- a `+` line
 *     inside a fence the diff did not touch is still inside a fence.
 *   - Inline backtick code spans are stripped before matching, so
 *     "use the literal token `(PR 8b)`" passes.
 *   - `closes #234` and a bare parenthetical `(#231)` pass: the target is the
 *     `PR <n>` label shape, not issue references.
 *   - The three patterns, in order, and their case-insensitivity.
 *   - MAX_REPORT = 20 offending lines, then stop.
 *   - One INHERITED KNOWN LIMIT, kept rather than quietly fixed: if the
 *     paren-anchored pattern matches a span containing a URL, the hook's perl
 *     `next` skipped to the next LINE and the third (bare `PR n of #m`)
 *     pattern was never tried. So `(PR 5 of #224, https://x)` passes. See
 *     findOffender().
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The hook's MAX_REPORT. Stop collecting after this many offending lines. */
export const MAX_REPORT = 20;

export interface Offender {
  file: string;
  /** 1-based line number in the file at the PR head. */
  line: number;
  /** The matched label substring. */
  hit: string;
  /** The full offending line, as written. */
  text: string;
}

/**
 * The hook's `should_scan`, arm for arm.
 *
 * Exclusions first (they win), then the two inclusions. `docs/*` in the hook's
 * bash `case` matched across `/`, so `docs/a/b.md` was in scope; that is
 * preserved.
 *
 * MEASURED WHILE PORTING: all THREE exclusion arms are SUBSUMED by the two
 * narrow include arms, in the hook as well as here. `README.md` is matched at
 * the repo ROOT only and the other arm requires a `docs/` prefix, so
 * `.claude/rules/hooks.md`, a root or nested `CLAUDE.md`, and
 * `tests/integration/foo/README.md` all fall through to `return false`
 * regardless. A mutation probe deleting all three left the suite at 56/56
 * green -- no input distinguishes them.
 *
 * They are kept verbatim anyway, for two reasons: they are the hook's stated
 * INTENT (hooks.md documents the exclusions as the contract, and a reader
 * needs to find them where they are claimed to be), and they become
 * load-bearing the moment an include arm widens -- `docs/**` becoming
 * `**\/*.md`, or a nested `README.md` being brought into scope, would put
 * every excluded path back in range. Deleting them now would move that
 * decision into a future edit that has no reason to think about it.
 */
export function shouldScan(file: string): boolean {
  if (file.startsWith('.claude/')) return false;
  if (file === 'CLAUDE.md' || file.endsWith('/CLAUDE.md')) return false;
  if (file.startsWith('tests/integration/') && file.endsWith('/README.md')) return false;

  if (file === 'README.md') return true;
  if (file.startsWith('docs/') && file.endsWith('.md')) return true;
  return false;
}

/** Strip single-backtick code spans. Ported from the hook's `s|`[^`]*`||g`. */
export function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, '');
}

/**
 * The detector. Three patterns tried in order, case-insensitively, returning
 * the matched substring or null.
 *
 *   1. `(PR 6 of #224)` / `(PR 6 of #224, issue #232)`
 *   2. `(PR 8b)` / `(PR 5)` / `(PR 8a of anything)` -- paren-anchored
 *   3. bare `PR 8b of #224` outside parentheses
 *
 * INHERITED KNOWN LIMIT (preserved deliberately, not a port bug): when pattern
 * 2 matches a span carrying a URL, the hook's perl ran `next`, which in a
 * single-line `-ne` loop ended processing for that line -- pattern 3 was NOT
 * tried. So `(PR 5 of #224, https://example.com)` is a PASS. Fixing it here
 * would have been a behaviour change smuggled in under a port.
 */
export function findOffender(line: string): string | null {
  const withOfIssue = /\(PR\s+\d+[a-z]?\s+of\s+#\d+(?:\s*,\s*issue\s*#\d+)?\)/i.exec(line);
  if (withOfIssue) return withOfIssue[0];

  const parenAnchored = /\(PR\s+\d+[a-z]?[^)]*\)/i.exec(line);
  if (parenAnchored) {
    if (/https?:\/\//i.test(parenAnchored[0])) return null;
    return parenAnchored[0];
  }

  const bare = /\bPR\s+\d+[a-z]?\s+of\s+#\d+\b/i.exec(line);
  if (bare) return bare[0];

  return null;
}

/**
 * Parse `git diff --unified=0` output into the set of NEW-FILE line numbers
 * that the diff ADDS. Ported line for line from the hook's perl hunk walker,
 * including the `+++` / `---` guards and the context-line offset bump (which
 * is dead under `--unified=0` but was there, and costs nothing to keep).
 */
export function parseAddedLineNumbers(diff: string): number[] {
  const added: number[] = [];
  let base = 0;
  let offset = 0;
  let inHunk = false;

  for (const raw of diff.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      base = Number(header[1]);
      offset = 0;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('+++')) continue;
    if (raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      added.push(base + offset);
      offset++;
      continue;
    }
    if (raw.startsWith('-')) continue;
    if (raw.startsWith(' ')) {
      offset++;
      continue;
    }
  }
  return added;
}

export interface ScannableLine {
  line: number;
  text: string;
}

/**
 * Walk the file's FULL content at the PR head, tracking fenced-code-block
 * state, and emit the lines whose numbers are in `addedLines`.
 *
 * Two properties from the hook's awk, both load-bearing:
 *   - A ``` line toggles the fence AND is itself skipped.
 *   - The walk is over the WHOLE file, so a `+` line inside a fence that the
 *     diff did not touch is still recognised as fenced.
 */
export function collectScannableLines(
  content: string,
  addedLines: readonly number[],
): ScannableLine[] {
  const wanted = new Set(addedLines);
  const lines = content.split('\n');
  // `printf '%s' "$staged" | awk` fed awk no trailing empty record; a file
  // ending in a newline must not gain a phantom final line here either.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const out: ScannableLine[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    if (/^[ \t]*```/.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (wanted.has(i + 1)) out.push({ line: i + 1, text });
  }
  return out;
}

/** Judge one file: full head content + its `--unified=0` diff. */
export function scanFile(file: string, content: string, diff: string): Offender[] {
  const added = parseAddedLineNumbers(diff);
  if (added.length === 0) return [];
  const out: Offender[] = [];
  for (const { line, text } of collectScannableLines(content, added)) {
    const hit = findOffender(stripInlineCode(text));
    if (hit !== null) out.push({ file, line, hit, text });
  }
  return out;
}

/**
 * Scan a set of changed files. Collection stops at MAX_REPORT, exactly as the
 * hook's `break 2` did.
 */
export function scanChangedFiles(
  files: readonly string[],
  readContent: (file: string) => string | null,
  readDiff: (file: string) => string | null,
): Offender[] {
  const offenders: Offender[] = [];
  for (const file of files) {
    if (!shouldScan(file)) continue;
    const content = readContent(file);
    // An EMPTY file is legitimately nothing to scan; an UNREADABLE one is not.
    // `shouldScan` has already put this path in scope, so a null is a failed
    // read, and skipping it exits 0 having not looked. Same reasoning and same
    // fix as the sibling in `check-pr-non-english-text.ts` -- the go-to-k/cdkd#2717
    // fix-delta review caught that only one of the two had been closed.
    if (content === null) {
      throw new Error(
        `cannot read ${file} at the PR head. It is in scope, so refusing rather than ` +
          `reporting a clean scan that never read it.`,
      );
    }
    if (content === '') continue;
    const diff = readDiff(file);
    if (diff === null || diff === '') continue;
    for (const o of scanFile(file, content, diff)) {
      offenders.push(o);
      if (offenders.length >= MAX_REPORT) return offenders;
    }
  }
  return offenders;
}

/**
 * Self-probe. A checker that has gone dead and a clean tree produce the same
 * green, so prove BOTH directions before reading anything.
 */
export function selfProbe(): string[] {
  const failures: string[] = [];

  const mustFlag: Array<[string, string]> = [
    ['(PR 8b)', '### local start-api authorizers (PR 8b)'],
    ['(PR 5 of #224)', '## Container Lambdas (PR 5 of #224)'],
    ['(PR 6 of #224, issue #232)', '### Lambda Layers (PR 6 of #224, issue #232)'],
    ['bare PR 8b of #224', 'This feature ships in PR 8b of #224 as planned.'],
  ];
  for (const [label, sample] of mustFlag) {
    if (findOffender(stripInlineCode(sample)) === null) {
      failures.push(`detector did not flag ${label}`);
    }
  }

  const mustPass: Array<[string, string]> = [
    ['plain prose', 'cdkd deploys CDK apps without CloudFormation.'],
    ['closes #234', 'This change closes #234 and fixes a bug.'],
    ['bare (#231)', 'Squashed from feat(...): subject (#231)'],
    ['inline code span', 'Use the literal token `(PR 8b)` in your config.'],
  ];
  for (const [label, sample] of mustPass) {
    if (findOffender(stripInlineCode(sample)) !== null) {
      failures.push(`detector wrongly flagged ${label}`);
    }
  }

  if (!shouldScan('README.md')) failures.push('scope dropped README.md');
  if (!shouldScan('docs/cli-reference.md')) failures.push('scope dropped docs/cli-reference.md');
  if (shouldScan('CLAUDE.md')) failures.push('scope wrongly included CLAUDE.md');
  if (shouldScan('tests/integration/foo/README.md')) {
    failures.push('scope wrongly included an integ fixture README');
  }

  const fenced = ['# doc', '```', '## Container Lambdas (PR 5 of #224)', '```', ''].join('\n');
  if (collectScannableLines(fenced, [3]).length !== 0) {
    failures.push('fence tracking did not exclude a line inside a fenced block');
  }
  if (collectScannableLines(fenced, [1]).length !== 1) {
    failures.push('fence tracking wrongly excluded a line outside every fence');
  }

  return failures;
}

// --------------------------------------------------------------------------
// CI plumbing. Everything above is pure and unit-tested; everything below
// talks to git and to the GitHub Actions environment.
// --------------------------------------------------------------------------

/**
 * Read a path at the PR head, with the SUBMODULE exemption.
 *
 * A mode-160000 gitlink is not a blob: `git show <sha>:<path>` answers
 * `fatal: bad object`, and treating that as "unreadable" would refuse an honest
 * PR that adds a submodule. There is no text in a gitlink to scan, so skipping
 * it loses no coverage -- unlike a genuinely unreadable file, which the caller
 * refuses. Kept identical to the sibling in `check-pr-non-english-text.ts`.
 */
function readAtHead(headSha: string, file: string): string | null {
  const mode = gitOrNull(['ls-tree', headSha, '--', file])?.trim().split(/\s+/)[0];
  if (mode === '160000') return '';
  return gitOrNull(['show', `${headSha}:${file}`]);
}

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
  headSha: string;
  mergeBase: string;
  /** Every path the PR touches, before any filtering. */
  allChanged: string[];
  /** Added / modified / renamed paths -- what `gh pr diff --name-only` showed. */
  scannable: string[];
}

/**
 * Resolve what to scan. FAILS CLOSED: a base or head this cannot read is an
 * error, not a pass.
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
    headSha,
    mergeBase,
    allChanged: split(gitOrNull(['diff', '--name-only', mergeBase, headSha])),
    scannable: split(gitOrNull(['diff', '--name-only', '--diff-filter=AMR', mergeBase, headSha])),
  };
}

export function main(env: NodeJS.ProcessEnv = process.env): number {
  const probeFailures = selfProbe();
  if (probeFailures.length > 0) {
    console.error('::error::the internal-PR-label detector failed its own self-probe:');
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
  // UNFILTERED list means the refs are wrong, not that the PR is clean.
  if (scope.allChanged.length === 0) {
    console.error(
      `::error::resolved 0 changed files for ${scope.mergeBase}..${scope.headSha}. A PR always ` +
        'changes at least one file, so the refs are wrong and this check scanned nothing.',
    );
    return 1;
  }

  const inScope = scope.scannable.filter(shouldScan);
  // Both halves of the sibling's fix, which an earlier revision claimed to have
  // applied here and had not (go-to-k/cdkd#2717 review): the reader goes through
  // `readAtHead`, so a SUBMODULE gitlink is exempted by mode rather than
  // throwing, and the refusal is CAUGHT and reported as `::error::` instead of
  // escaping `main()` as a stack trace that discards the offenders already
  // collected.
  let offenders: Offender[];
  try {
    offenders = scanChangedFiles(
      scope.scannable,
      (f) => readAtHead(scope.headSha, f),
      (f) => gitOrNull(['diff', '--unified=0', scope.mergeBase, scope.headSha, '--', f]),
    );
  } catch (err) {
    console.error(`::error::${(err as Error).message}`);
    return 1;
  }

  console.log(
    `Scanned ${inScope.length} user-facing doc(s) of ${scope.scannable.length} changed file(s).`,
  );

  if (offenders.length === 0) return 0;

  for (const o of offenders) {
    console.error(`::error file=${o.file},line=${o.line}::internal PR label ${o.hit}: ${o.text}`);
  }

  console.error('');
  console.error('A user-facing doc adds internal development-phase labels');
  console.error("('(PR 8b)' / '(PR 6 of #224, issue #232)' / etc.). These labels make");
  console.error('sense for CLAUDE.md and commit messages but confuse end-users who do');
  console.error("not track cdkd's internal PR roadmap.");
  console.error('');
  console.error('Found:');
  for (const o of offenders) console.error(`  ${o.file}:${o.line}: ${o.text}`);
  if (offenders.length >= MAX_REPORT) {
    console.error(`  ... reporting stopped at ${MAX_REPORT} lines.`);
  }
  console.error('');
  console.error('Fix:');
  console.error("  - Drop the parenthetical label: '## Container Lambdas (PR 5 of #224)'");
  console.error("    -> '## Container Lambdas'");
  console.error("  - For dev-facing context like 'this feature ships in PR 8b', move it");
  console.error('    to CLAUDE.md (which is out of scope for this check).');
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
