import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
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
  const joined = block.replace(/\\\n\s*/g, ' ');
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

/** Run one extracted line with `$log` bound to a fixture, and echo its value. */
function runExtraction(logContents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-step4-'));
  try {
    const log = join(dir, 'suite.log');
    writeFileSync(log, logContents);
    // `bash`, not the ambient shell: the block is documented for a bash/zsh
    // paste, and pinning the interpreter keeps this from measuring whichever
    // shell happens to run the suite.
    const script = `log=${JSON.stringify(log)}\n${blockLine('collected=')}\nprintf '%s' "$collected"\n`;
    return execFileSync('bash', ['-c', script], { encoding: 'utf-8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

  it('counts the tracked tests the block claims to count', () => {
    const fromBlock = execFileSync('bash', ['-c', `${blockLine('ondisk=')}\nprintf '%s' "$ondisk"`], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    const direct = execFileSync(
      'bash',
      ['-c', `git ls-files | grep -cE '\\.(test|test-d)\\.ts$'`],
      { cwd: repoRoot, encoding: 'utf-8' }
    ).trim();
    // Not a pinned number: an independent derivation of the same set, so the
    // case keeps meaning something as the suite grows.
    expect(fromBlock).toBe(direct);
  });
});
