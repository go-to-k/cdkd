import { describe, it, expect, vi } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Every case below SPAWNS a `.ts` entry point, paying Node startup plus type
// stripping per call. Vitest's default bound is 5 s and is an IN-PROCESS
// bound, so these pass locally and time out on a loaded CI runner -- the shape
// `.claude/rules/testing.md` records from go-to-k/cdkd#2553 (~2 s local, 5000 ms
// in CI), and the one that reads as flakiness rather than an under-declared
// bound. Measured here at up to 2088 ms locally during the go-to-k/cdkd#2717
// test review. The bound's job is to stop a HANG, not to police latency, so it
// is set generously.
vi.setConfig({ testTimeout: 60_000 });

import {
  MAX_REPORT,
  collectScannableLines,
  findOffender,
  parseAddedLineNumbers,
  scanChangedFiles,
  scanFile,
  selfProbe,
  shouldScan,
  stripInlineCode,
} from '../../../scripts/check-pr-internal-labels.js';

/**
 * Port of `.claude/hooks/internal-pr-labels-gate.test.sh` (17 cases) to the CI
 * check that replaced the hook.
 *
 * WHICH OF THE HOOK'S CASES SURVIVED, AND WHICH COULD NOT
 * -------------------------------------------------------
 * Ported (the detection contract): all three label shapes blocking; the
 * CLAUDE.md and `tests/integration/**\/README.md` exclusions; the inline
 * code-span and fenced-code-block allow-lists; `closes #234` and a bare
 * `(#231)` passing; a non-doc source file being out of scope; the multi-file
 * mixed case; and the `(PR 8b)`-beside-`(#231)` case that pins WHICH of the
 * two matters.
 *
 * NOT ported, because they have no CI equivalent -- they fenced the hook's
 * SHELL PARSING, which the port deletes rather than translates:
 *   - "non-git-commit command -> pass", "compound: git add -A && git commit
 *     still blocks", "quoted mention of git commit does not fire". A CI job
 *     has one subject and no command text to classify.
 *
 * Added here because CI moved the subject from the STAGED INDEX to the PR
 * diff, and the move has to be pinned: only ADDED lines are judged; fence
 * state is tracked over the file's FULL head content rather than over the
 * diff; and the whole thing runs end-to-end against a real repository.
 */

describe('shouldScan -- the user-facing doc scope', () => {
  it.each(['README.md', 'docs/cli-reference.md', 'docs/design/2552-changelog.md'])(
    'includes %s',
    (path) => {
      expect(shouldScan(path)).toBe(true);
    },
  );

  it.each([
    // The hook's case 4: developer-facing, internal labels are expected there.
    ['CLAUDE.md', 'CLAUDE.md'],
    ['a nested CLAUDE.md', 'packages/x/CLAUDE.md'],
    // The hook's case 13: integ fixture metadata cites its own implementation PR.
    ['an integ fixture README', 'tests/integration/foo/README.md'],
    ['an integ root README', 'tests/integration/README.md'],
    // Excluded wholesale by the hook's first case arm.
    ['the .claude tree', '.claude/rules/hooks.md'],
    ['a skill doc', '.claude/skills/check/SKILL.md'],
    // The hook's case 11: not a doc.
    ['a source file', 'src/foo.ts'],
    ['a docs non-markdown file', 'docs/_generated/integ-coverage.json'],
    // README.md is included at the ROOT only.
    ['a nested README', 'packages/x/README.md'],
    ['a test README', 'tests/unit/README.md'],
  ])('excludes %s', (_label, path) => {
    expect(shouldScan(path)).toBe(false);
  });
});

describe('findOffender -- the three label shapes', () => {
  it.each([
    // Hook case 1.
    ['### local start-api authorizers (PR 8b)', '(PR 8b)'],
    // Hook case 3.
    ['## Container Lambdas (PR 5 of #224)', '(PR 5 of #224)'],
    // Hook case 2.
    ['### Lambda Layers (PR 6 of #224, issue #232)', '(PR 6 of #224, issue #232)'],
    // Hook case 14 -- the bare, un-parenthesised form.
    ['This feature ships in PR 8b of #224 as planned.', 'PR 8b of #224'],
    // Hook case 15 -- an allowed `(#231)` on the same line changes nothing.
    ['Closing (#231) and adding authorizers (PR 8b).', '(PR 8b)'],
    ['## Something (PR 5)', '(PR 5)'],
    ['## Something (PR 8a of the series)', '(PR 8a of the series)'],
  ])('flags %s', (line, hit) => {
    expect(findOffender(line)).toBe(hit);
  });

  it('is case-insensitive, as the hook\'s /i patterns were', () => {
    expect(findOffender('## Something (pr 8b)')).toBe('(pr 8b)');
    expect(findOffender('ships in pr 8b of #224')).toBe('pr 8b of #224');
  });

  it.each([
    // Hook case 7.
    ['closes #234', 'This change closes #234 and fixes a bug.'],
    // Hook case 8 -- the squash-merge subject shape every commit on main has.
    ['a bare (#231)', 'Squashed from feat(...): subject (#231)'],
    ['a Refs: line', 'Refs: #224 and #232.'],
    ['plain prose', 'cdkd deploys CDK apps directly via the AWS SDK.'],
    ['a parenthetical with no PR token', '## Container Lambdas (issue #224)'],
    ['the word PR without a number', 'Open a PR against main.'],
  ])('passes %s', (_label, line) => {
    expect(findOffender(line)).toBeNull();
  });

  // INHERITED KNOWN LIMIT, preserved deliberately. The hook's perl ran `next`
  // when the paren-anchored match carried a URL, which in a single-line `-ne`
  // loop ended the line -- so the third pattern was never tried. Fixing it
  // here would be a behaviour change smuggled in under a port.
  it('KNOWN LIMIT: a URL inside the parenthetical suppresses the whole line', () => {
    expect(findOffender('See (PR 5 of #224, https://example.com/x) for context.')).toBeNull();
  });
});

describe('stripInlineCode', () => {
  // The hook's case 5.
  it('removes single-backtick spans so a documented literal passes', () => {
    const line = 'Use the literal token `(PR 8b)` in your config.';
    expect(findOffender(stripInlineCode(line))).toBeNull();
  });

  it('removes every span on the line, not just the first', () => {
    expect(stripInlineCode('a `x` b `y` c')).toBe('a  b  c');
  });

  // The control: stripping must not swallow the prose around a span, or the
  // case above would also be satisfied by a detector that gave up on any line
  // containing a backtick.
  it('leaves a label OUTSIDE a span visible', () => {
    const line = 'Run `cdkd deploy` -- see the notes (PR 8b).';
    expect(findOffender(stripInlineCode(line))).toBe('(PR 8b)');
  });
});

describe('parseAddedLineNumbers', () => {
  it('reads new-file line numbers out of a --unified=0 diff', () => {
    const diff = [
      'diff --git a/README.md b/README.md',
      'index 1111111..2222222 100644',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -3,0 +4,2 @@ context text',
      '+added four',
      '+added five',
      '@@ -10,1 +12,1 @@',
      '-removed',
      '+added twelve',
    ].join('\n');
    expect(parseAddedLineNumbers(diff)).toEqual([4, 5, 12]);
  });

  it('reads a whole-new-file diff', () => {
    const diff = [
      'diff --git a/docs/new.md b/docs/new.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/docs/new.md',
      '@@ -0,0 +1,3 @@',
      '+one',
      '+two',
      '+three',
    ].join('\n');
    expect(parseAddedLineNumbers(diff)).toEqual([1, 2, 3]);
  });

  it('reports nothing for a deletion-only diff', () => {
    const diff = ['--- a/README.md', '+++ b/README.md', '@@ -4,2 +3,0 @@', '-gone', '-also gone'].join(
      '\n',
    );
    expect(parseAddedLineNumbers(diff)).toEqual([]);
  });

  // The `+++`/`---` file markers sit before the first `@@`, so `inHunk` must
  // still be false there. A parser that counted `+++ b/README.md` as an added
  // line would shift every number after it.
  it('never counts the +++ / --- file markers', () => {
    const diff = ['--- a/x.md', '+++ b/x.md', '@@ -0,0 +7,1 @@', '+seven'].join('\n');
    expect(parseAddedLineNumbers(diff)).toEqual([7]);
  });
});

describe('collectScannableLines -- fence tracking over the FULL head content', () => {
  // The hook's case 6.
  const doc = [
    '# doc', // 1
    '', // 2
    '```', // 3
    '## Container Lambdas (PR 5 of #224)', // 4
    '```', // 5
    'after the fence (PR 8b)', // 6
    '', // 7
  ].join('\n');

  it('excludes a line inside a fenced block', () => {
    expect(collectScannableLines(doc, [4])).toEqual([]);
  });

  it('excludes the fence markers themselves', () => {
    expect(collectScannableLines(doc, [3, 5])).toEqual([]);
  });

  it('still sees a line after the fence closes', () => {
    expect(collectScannableLines(doc, [6])).toEqual([{ line: 6, text: 'after the fence (PR 8b)' }]);
  });

  it('handles an indented fence, as the hook\'s ^[[:space:]]*``` did', () => {
    const indented = ['- item:', '  ```', '  (PR 8b)', '  ```', 'tail (PR 9c)', ''].join('\n');
    expect(collectScannableLines(indented, [3])).toEqual([]);
    expect(collectScannableLines(indented, [5])).toHaveLength(1);
  });

  it('handles an info-string fence', () => {
    const fenced = ['x', '```ts', '// (PR 8b)', '```', ''].join('\n');
    expect(collectScannableLines(fenced, [3])).toEqual([]);
  });

  // The reason the walk is over the WHOLE file rather than over the diff: a
  // fence opened by a line the PR did not touch still hides what follows.
  it('honours a fence that the diff did not touch', () => {
    expect(collectScannableLines(doc, [4])).toEqual([]);
    expect(collectScannableLines(doc, [1, 4, 6])).toEqual([
      { line: 1, text: '# doc' },
      { line: 6, text: 'after the fence (PR 8b)' },
    ]);
  });

  it('does not invent a phantom final line for a trailing newline', () => {
    expect(collectScannableLines('one\ntwo\n', [3])).toEqual([]);
    expect(collectScannableLines('one\ntwo\n', [2])).toEqual([{ line: 2, text: 'two' }]);
  });
});

describe('scanFile', () => {
  const content = ['# doc', 'old prose (PR 4)', 'new prose (PR 8b)', ''].join('\n');
  const diffAdding = (line: number) =>
    ['--- a/README.md', '+++ b/README.md', `@@ -0,0 +${line},1 @@`, '+x'].join('\n');

  it('flags a label on an ADDED line', () => {
    expect(scanFile('README.md', content, diffAdding(3))).toEqual([
      { file: 'README.md', line: 3, hit: '(PR 8b)', text: 'new prose (PR 8b)' },
    ]);
  });

  // The move from the staged index to the PR diff must not turn the check into
  // a whole-file scan: a label that was already in the file is not this PR's.
  it('ignores a pre-existing label on a line the PR did not add', () => {
    expect(scanFile('README.md', content, diffAdding(1))).toEqual([]);
  });

  it('reports nothing when the diff adds no lines', () => {
    expect(scanFile('README.md', content, '--- a/README.md\n+++ b/README.md\n')).toEqual([]);
  });
});

describe('scanChangedFiles', () => {
  const labelled = 'x\n## Container Lambdas (PR 5 of #224)\n';
  const diff = ['--- a/x', '+++ b/x', '@@ -0,0 +2,1 @@', '+x'].join('\n');

  // The hook's case 12.
  it('reports the labelled file out of a mixed changed-file set', () => {
    const found = scanChangedFiles(
      ['src/foo.ts', 'README.md', 'docs/cli-reference.md', 'CLAUDE.md'],
      (f) => (f === 'docs/cli-reference.md' ? labelled : 'clean prose\nmore clean prose\n'),
      () => diff,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.file).toBe('docs/cli-reference.md');
  });

  // The hook's case 9.
  it('reports nothing when no user-facing doc changed', () => {
    expect(scanChangedFiles(['src/foo.ts', 'package.json'], () => labelled, () => diff)).toEqual([]);
  });

  it('never reads a file outside the scope', () => {
    const read: string[] = [];
    scanChangedFiles(
      ['CLAUDE.md', '.claude/rules/hooks.md', 'README.md'],
      (f) => {
        read.push(f);
        return 'clean\n';
      },
      () => diff,
    );
    expect(read).toEqual(['README.md']);
  });

  it('stops collecting at MAX_REPORT', () => {
    const lines = Array.from({ length: MAX_REPORT + 15 }, (_, i) => `heading ${i} (PR 8b)`);
    const big = `${lines.join('\n')}\n`;
    const bigDiff = [
      '--- a/README.md',
      '+++ b/README.md',
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map(() => '+x'),
    ].join('\n');
    expect(scanChangedFiles(['README.md'], () => big, () => bigDiff)).toHaveLength(MAX_REPORT);
  });
});

describe('selfProbe', () => {
  it('passes against the shipped detector', () => {
    expect(selfProbe()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// END-TO-END against a real repository, driving the SHIPPED script as a
// subprocess. Also proves the file runs under Node's type stripping, which no
// in-process import can show.
// ---------------------------------------------------------------------------

const SCRIPT = join(import.meta.dirname, '../../../scripts/check-pr-internal-labels.ts');

interface Repo {
  dir: string;
  base: string;
  head: string;
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

function makeRepo(files: Record<string, string>): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-prlabel-'));
  git(dir, ['init', '-q', '-b', 'main']);
  const seed = (rel: string, body: string) => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  seed('README.md', '# cdkd\n\ncdkd is a CDK direct deployer.\n');
  seed('docs/cli-reference.md', '# CLI Reference\n\ncdkd deploy ...\n');
  seed('CLAUDE.md', '# CLAUDE.md\n\nInternal developer notes.\n');
  seed('tests/integration/foo/README.md', '# foo integration test\n\nRun `bash verify.sh`.\n');
  seed('src/foo.ts', 'export const foo = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'baseline']);
  const base = git(dir, ['rev-parse', 'HEAD']).trim();

  for (const [rel, body] of Object.entries(files)) seed(rel, body);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'wip']);
  const head = git(dir, ['rev-parse', 'HEAD']).trim();
  return { dir, base, head };
}

function runCheck(repo: Repo, overrides: Record<string, string> = {}) {
  try {
    const stdout = execFileSync('node', ['--experimental-strip-types', SCRIPT], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: { ...process.env, BASE_SHA: repo.base, HEAD_SHA: repo.head, ...overrides },
    });
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('end-to-end against a real repository', () => {
  const repos: Repo[] = [];
  const build = (files: Record<string, string>) => {
    const r = makeRepo(files);
    repos.push(r);
    return r;
  };
  const cleanup = () => {
    for (const r of repos) rmSync(r.dir, { recursive: true, force: true });
    repos.length = 0;
  };

  it('FAILS on a real violation and names the file and line', () => {
    const repo = build({
      'README.md': '# cdkd\n\ncdkd is a CDK direct deployer.\n\n### authorizers (PR 8b)\n',
    });
    const { status, output } = runCheck(repo);
    cleanup();
    expect(status).toBe(1);
    expect(output).toContain('README.md');
    expect(output).toContain('line=5');
    expect(output).toContain('(PR 8b)');
  });

  // The control. Without it the case above is satisfied by a script that fails
  // on everything.
  it('passes on a clean docs change', () => {
    const repo = build({
      'docs/cli-reference.md': '# CLI Reference\n\ncdkd deploy ...\n\nAnd a new paragraph.\n',
    });
    const { status, output } = runCheck(repo);
    cleanup();
    expect(status).toBe(0);
    expect(output).toContain('Scanned 1 user-facing doc(s)');
  });

  it('passes the same label in CLAUDE.md and in an integ fixture README', () => {
    const repo = build({
      'CLAUDE.md': '# CLAUDE.md\n\nInternal developer notes.\n\nShipped in (PR 8b).\n',
      'tests/integration/foo/README.md':
        '# foo integration test\n\nRun `bash verify.sh`.\n\nExercises (PR 8b).\n',
    });
    const { status } = runCheck(repo);
    cleanup();
    expect(status).toBe(0);
  });

  it('passes a label added inside a fenced code block', () => {
    const repo = build({
      'README.md': '# cdkd\n\ncdkd is a CDK direct deployer.\n\n```\n## Lambdas (PR 5 of #224)\n```\n',
    });
    const { status } = runCheck(repo);
    cleanup();
    expect(status).toBe(0);
  });

  it('fails CLOSED when the refs cannot be resolved', () => {
    const repo = build({ 'README.md': '# cdkd\n\nnew line.\n' });
    const { status, output } = runCheck(repo, { BASE_SHA: '' });
    cleanup();
    expect(status).toBe(1);
    expect(output).toContain('::error::');
  });

  it('fails when the resolved diff is empty', () => {
    const repo = build({ 'README.md': '# cdkd\n\nnew line.\n' });
    const { status, output } = runCheck(repo, { BASE_SHA: repo.head });
    cleanup();
    expect(status).toBe(1);
    expect(output).toContain('resolved 0 changed files');
  });
});
