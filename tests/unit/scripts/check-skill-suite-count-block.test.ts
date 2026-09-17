import { describe, it, expect } from 'vite-plus/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The `/check` step-4 verification block, EXECUTED rather than read.
 *
 * WHY THIS FILE EXISTS. That block is the snippet every lane pastes to decide
 * whether `vp test run` attested to anything, and it gained a hard `exit 1` on
 * a derived test-file count. A false FAIL there blocks every lane in the repo,
 * and a false PASS re-opens the incident it was written for
 * (`Test Files 916 passed (916)` beside `Errors 148`, every one
 * `[vitest-pool]: Failed to start forks worker`, over a true 1065).
 *
 * It is a fence rather than prose for the reason
 * `.claude/skills/work-issues/references/retro.md` §10-0 gives about its own
 * promotion recipe: a hand-verified shell recipe in a markdown file is checked
 * by nothing, and that one shipped six defects across three hand-verified
 * rounds before being extracted into
 * `tests/unit/scripts/work-issues-promotion-context.test.ts`. This block
 * shipped a BLOCKER plus three minors in its first review round — an
 * `$`-anchored extraction that returns empty against the ANSI-coloured summary
 * CI produces, so a GREEN suite would have been reported as
 * `COLLECTED none of 1065`. That is the same class `.github/workflows/ci.yml`'s
 * test-ran guard already paid for once, which is what settles that the doc
 * needed an executor and not another proofread. Same precedent as
 * `work-issues-launch-mode.test.ts`.
 *
 * Three properties, in increasing order of what they prove:
 *
 *   1. the block still CONTAINS the two derivation lines, so deleting either
 *      one reds rather than quietly restoring an unchecked count;
 *   2. its `git ls-files` pathspecs describe the same SET as vitest's own
 *      `include` + `typecheck.include`, so adding a glob to `vite.config.ts`
 *      without adding it here cannot silently lower the floor;
 *   3. the extraction line is RUN, against the real summary shapes — plain,
 *      ANSI-coloured, degraded and absent.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const skillPath = join(repoRoot, '.claude', 'skills', 'check', 'SKILL.md');
const viteConfigPath = join(repoRoot, 'vite.config.ts');

/** The step-4 bash fence: the one carrying the project-root assertion. */
function stepFourBlock(): string {
  const md = readFileSync(skillPath, 'utf8');
  const blocks = [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] as string);
  const hits = blocks.filter((b) => b.includes('vp test run >') && b.includes('collected='));
  expect(
    hits.length,
    'expected exactly one step-4 verification block in .claude/skills/check/SKILL.md ' +
      'carrying both `vp test run >` and `collected=`; a second copy is the drift ' +
      'shape retro.md §10-c fences, and zero means the block was deleted or renamed'
  ).toBe(1);
  return hits[0] as string;
}

/** One line of the block, by its leading assignment. */
function blockLine(prefix: string): string {
  const block = stepFourBlock();
  // Continuation lines are joined: the `ondisk=` invocation is wrapped with a
  // trailing backslash, and a pathspec on the second line must not be missed.
  // `[^\S\n]*` rather than `\s*`, which crosses newlines and would merge two
  // LOGICAL lines whenever a continuation is followed by a blank one.
  const joined = block.replace(/\\\n[^\S\n]*/g, ' ');
  const line = joined.split('\n').find((l) => l.trim().startsWith(prefix));
  expect(line, `no line starting with \`${prefix}\` in the step-4 block`).toBeDefined();
  return (line as string).trim();
}

/**
 * The single-quoted tokens of a line, by SPLITTING on the quote rather than by
 * matching `'([^']+)'`. That regex is wrong for an argument LIST: after the
 * first pair closes, the next match starts at the separating space, so
 * `'a' 'b'` yields `a`, ` `, `b` — and the stray ` ` then fails the `:(glob)`
 * assertion for a reason that has nothing to do with the block. Splitting makes
 * the quoted tokens exactly the odd indices.
 */
function quotedTokens(line: string): string[] {
  return line.split("'").filter((_, i) => i % 2 === 1);
}

/**
 * The pathspecs the `ondisk=` line hands `git ls-files`.
 *
 * Bounded to the segment BETWEEN `git ls-files` and the first pipe, because the
 * line ends `| tr -d ' '` — and that space is a quoted token too. Taking every
 * quoted token on the line yields it as a fifth "pathspec", which fails the
 * `:(glob)` assertion for a reason that has nothing to do with the block.
 */
function lsFilesPathspecs(): string[] {
  const line = blockLine('ondisk=');
  const start = line.indexOf('git ls-files');
  expect(start, 'the `ondisk=` line no longer invokes `git ls-files`').toBeGreaterThan(-1);
  const end = line.indexOf('|', start);
  expect(end, 'the `ondisk=` line no longer pipes `git ls-files` anywhere').toBeGreaterThan(-1);
  return quotedTokens(line.slice(start, end));
}

/**
 * Run a snippet with `$log` bound to a fixture file.
 *
 * The path travels as an ARGV element, never interpolated into the script.
 * `JSON.stringify` is JSON quoting, not shell quoting — inside bash double
 * quotes a `$` or a backtick in the path would still expand. `mkdtemp` under a
 * `TMPDIR` containing either is unlikely rather than impossible, and this is
 * the one place a fence gets to be careless about a path it did not choose.
 */
function runSnippet(snippet: string, logContents: string): { out: string; status: number } {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-step4-'));
  try {
    const log = join(dir, 'suite.log');
    writeFileSync(log, logContents);
    // `bash`, not the ambient shell: the block is documented for a bash/zsh
    // paste, and pinning the interpreter keeps this from measuring whichever
    // shell happens to run the suite.
    const res = spawnSync('bash', ['-c', `log="$1"\n${snippet}`, '_', log], {
      encoding: 'utf-8',
      cwd: repoRoot,
    });
    return { out: `${res.stdout ?? ''}${res.stderr ?? ''}`, status: res.status ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the `collected=` line alone and echo its value. */
function runExtraction(logContents: string): string {
  return runSnippet(`${blockLine('collected=')}\nprintf '%s' "$collected"`, logContents).out;
}

/**
 * Run the WHOLE block body from `rc=` onwards, with `rc` supplied.
 *
 * Structural assertions cannot see an `exit 1` turned into an `exit 0` — the
 * false PASS this block's docstring exists to prevent — so the exits are
 * exercised rather than pattern-matched. The `vp test run` line is replaced:
 * this fence is about the VERDICT logic, and running the real suite inside a
 * unit test is not on.
 */
function runBlockVerdict(logContents: string, rc: number): { out: string; status: number } {
  const body = stepFourBlock()
    .replace(/\\\n[^\S\n]*/g, ' ')
    .split('\n')
    // Drop the subshell wrapper, the mktemp/echo preamble and the real run;
    // keep every verdict line from the `runs=` header check onwards.
    .filter((l) => {
      const t = l.trim();
      if (t === '(' || t === ')' || t.startsWith('#')) return false;
      if (t.startsWith('log=') || t.startsWith('echo "log:') || t.startsWith('vp test run')) return false;
      return t.length > 0;
    })
    .join('\n');
  return runSnippet(`rc=${rc}\n${body}`, logContents);
}

const ESC = '\u001b';

/**
 * The bytes CI really emits, copied from the same failing-run shape
 * `tests/unit/scripts/ci-test-ran-guard.test.ts` keeps on record: the line
 * begins with an escape AND ends with one, so the count is neither at the start
 * of the line nor at the end of it.
 */
const COLOURED_SUMMARY =
  `${ESC}[2m Test Files ${ESC}[22m ${ESC}[1m${ESC}[32m1065 passed${ESC}[39m` +
  `${ESC}[22m${ESC}[90m (1065)${ESC}[39m\n`;

/**
 * vitest's own label padding: `padSummaryTitle(str) = dim(str.padStart(11) + ' ')`.
 * Reproducing it rather than hand-spacing is what keeps the display-grep cases
 * honest — the six literal spaces the block matches on come from HERE.
 */
const pad = (label: string): string => `${ESC}[2m${label.padStart(11)} ${ESC}[22m`;

/**
 * A whole coloured summary, degraded exactly as the founding incident was:
 * a self-consistent `N passed (N)` over the files that survived, beside the
 * `Errors` line that explains the shortfall.
 */
const COLOURED_DEGRADED_SUMMARY =
  `${pad('Test Files')} ${ESC}[1m${ESC}[32m916 passed${ESC}[39m${ESC}[22m${ESC}[90m (916)${ESC}[39m\n` +
  `${pad('Tests')} ${ESC}[1m${ESC}[32m24822 passed${ESC}[39m${ESC}[22m${ESC}[90m (24830)${ESC}[39m\n` +
  `${pad('Type Errors')} ${ESC}[1m${ESC}[32mno errors${ESC}[39m\n` +
  `${pad('Errors')} ${ESC}[1m${ESC}[31m24 errors${ESC}[39m\n`;

/** A full plain summary, as a redirected local run writes it. */
const FULL_PLAIN_SUMMARY =
  ` RUN  v4.1.11 ${''}\n` +
  ' Test Files  1065 passed (1065)\n' +
  '      Tests  25043 passed | 1 skipped (25044)\n' +
  'Type Errors  no errors\n' +
  '   Duration  9999ms\n';

describe('/check step 4 — the collected-count block', () => {
  it('still carries both derivation lines', () => {
    const block = stepFourBlock();
    expect(block).toContain('collected=');
    expect(block).toContain('ondisk=');
    // The comparison itself. Without this, dropping the `exit 1` leaves the two
    // assignments in place and the floor enforcing nothing.
    expect(block).toMatch(/\[\s*"\$\{collected:-0\}"\s+-ge\s+"\$ondisk"\s*\]/);
  });

  it('checks the suite rc BEFORE the count', () => {
    const block = stepFourBlock();
    const rcAt = block.indexOf('SUITE FAILED');
    const countAt = block.indexOf('COLLECTED ');
    expect(rcAt, 'the rc check is missing from the block').toBeGreaterThan(-1);
    expect(countAt, 'the count check is missing from the block').toBeGreaterThan(-1);
    // A crashed or filtered run prints no `(N)`, so judging the count first
    // reports "collected none" for a run whose real problem is the rc.
    expect(
      rcAt,
      'the rc check must precede the collected-count check: a run that printed no ' +
        'summary at all would otherwise be diagnosed as a collection shortfall'
    ).toBeLessThan(countAt);
  });

  it('pins every pathspec with :(glob), because git’s bare ** needs a slash', () => {
    const specs = lsFilesPathspecs();
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      // Measured: `git ls-files 'tests/**/setup.ts'` returns nothing while
      // `git ls-files ':(glob)tests/**/setup.ts'` returns the tracked file —
      // vitest WOULD collect a depth-1 `tests/foo.test.ts`, so a bare pathspec
      // lowers the floor by one, silently.
      expect(spec, `pathspec ${spec} is missing its :(glob) prefix`).toMatch(/^:\(glob\)/);
    }
  });

  it('describes the same file set as vitest’s own include globs', () => {
    const specs = lsFilesPathspecs()
      .map((s) => s.replace(/^:\(glob\)/, ''))
      .sort();

    const config = readFileSync(viteConfigPath, 'utf8');
    const includes = [...config.matchAll(/include:\s*\[([^\]]*)\]/g)]
      .flatMap((m) => quotedTokens(m[1] as string))
      .filter((g) => g.includes('.test'))
      .sort();
    // Guard against the vacuous pass: if the config parse silently returns
    // nothing, an empty `includes` would only match an empty `specs`, which the
    // pathspec case above already rejects — but say so here rather than relying
    // on that coupling.
    expect(includes.length, 'no test include globs parsed out of vite.config.ts').toBeGreaterThan(0);

    // Set equality in BOTH directions: a glob added to vite.config.ts and not
    // here lowers the floor; one added here and not there raises it into a
    // false FAIL. Neither direction is safe, so neither is a subset check.
    expect(specs).toEqual(includes);
  });

  it('extracts the count from the plain summary', () => {
    expect(runExtraction(' Test Files  1065 passed (1065)\n')).toBe('1065');
  });

  it('extracts the count from the ANSI-COLOURED summary CI produces', () => {
    // The regression this fence exists for. The first cut anchored the pattern
    // on `)$`, which the trailing `\e[39m` defeats: `collected` came back
    // empty, `${collected:-0}` became 0, and a GREEN 1065-file suite was
    // reported as `COLLECTED none of 1065 tracked test files`.
    expect(runExtraction(COLOURED_SUMMARY)).toBe('1065');
  });

  it('extracts the DEGRADED count, which is the whole point of the floor', () => {
    // Self-consistent `N passed (N)` over the files that survived — the line
    // cannot report its own shortfall, so only the external reference can.
    expect(runExtraction(' Test Files  916 passed (916)\n')).toBe('916');
  });

  it('extracts the total from a FAILING summary, not the failed count', () => {
    expect(runExtraction(' Test Files  3 failed | 1062 passed (1065)\n')).toBe('1065');
  });

  it('yields an empty value when no summary was printed at all', () => {
    // `${collected:-0}` then makes the comparison fail, which is what subsumes
    // the sentence the skill used to carry separately.
    expect(runExtraction('VITE+ - The Unified Toolchain for the Web\n')).toBe('');
  });

  it('yields a SINGLE value when two summaries are present', () => {
    // A multi-line value would make `[` a syntax error rather than a verdict.
    // The block's `runs=1` header assertion rejects this log first, but the
    // extraction must not be the thing that breaks.
    const two = ' Test Files  246 passed (246)\n Test Files  1065 passed (1065)\n';
    expect(runExtraction(two)).toBe('1065');
  });

  it('takes the Test Files total, not the Tests total, from a full summary', () => {
    // Without `grep 'Test Files'` the extraction binds the `Tests` line's
    // `(25044)` instead. Every other fixture here is a `Test Files`-only log,
    // so nothing else in this file can see that mutation.
    expect(runExtraction(FULL_PLAIN_SUMMARY)).toBe('1065');
  });

  it('prints all four summary lines from a COLOURED degraded run', () => {
    // The line round 1 actually fixed, and the one nothing was asserting:
    // reverting the display grep to `^ +Errors ` passed every other case here.
    // vitest pads the label INSIDE the dim escape, so `      Tests ` survives
    // colouring while the tighter `Tests +[0-9]` matches nothing — measured,
    // and the reason neither alternative may be "tightened".
    const { out } = runSnippet(
      `${blockLine('grep -E "Test Files')}`,
      COLOURED_DEGRADED_SUMMARY
    );
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(out).toContain('24 errors');
  });

  it('EXITS 1 on a degraded run and names the worker remedy', () => {
    // End-to-end: a structural assertion cannot see `exit 1` become `exit 0`.
    const { out, status } = runBlockVerdict(
      ` RUN  v4.1.11 ${repoRoot}\n` +
        COLOURED_DEGRADED_SUMMARY +
        '[vitest-pool]: Failed to start forks worker for test files foo.test.ts\n',
      1
    );
    expect(status).toBe(1);
    expect(out).toContain('SUITE FAILED rc=1');
    // The remedy must live on THIS arm: vitest exits non-zero whenever it
    // prints an `Errors` line, so the founding incident never reaches the
    // count check below it.
    expect(out).toContain('--maxWorkers=4');
  });

  it('EXITS 0 on a green run that collected the whole tree', () => {
    const { out, status } = runBlockVerdict(
      ` RUN  v4.1.11 ${repoRoot}\n Test Files  99999 passed (99999)\n`,
      0
    );
    expect(status).toBe(0);
    expect(out).not.toContain('COLLECTED');
    expect(out).not.toContain('SUITE FAILED');
  });

  it('EXITS 1 when a run exits 0 having collected too few files', () => {
    // The count check's remaining job once the rc check precedes it: a stray
    // filter or a narrowed `include`. It must NOT offer the worker remedy here.
    const { out, status } = runBlockVerdict(
      ` RUN  v4.1.11 ${repoRoot}\n Test Files  3 passed (3)\n`,
      0
    );
    expect(status).toBe(1);
    expect(out).toContain('COLLECTED 3 of');
    expect(out).not.toContain('--maxWorkers=4');
  });

  it('counts the tracked tests the block claims to count', () => {
    const fromBlock = execFileSync('bash', ['-c', `${blockLine('ondisk=')}\nprintf '%s' "$ondisk"`], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    // Scoped to the two roots the block's pathspecs cover. An unscoped count
    // is BROADER than the block, so a tracked `scripts/x.test.ts` — which
    // vitest would not collect — would red this while the block stayed right.
    const direct = execFileSync(
      'bash',
      ['-c', `git ls-files | grep -E '^(tests|src)/' | grep -cE '\\.(test|test-d)\\.ts$'`],
      { cwd: repoRoot, encoding: 'utf-8' }
    ).trim();
    // Not a pinned number: an independent derivation of the same set, so the
    // case keeps meaning something as the suite grows.
    expect(fromBlock).toBe(direct);
  });
});
