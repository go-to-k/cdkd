import { describe, it, expect, vi } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
  ALLOWLIST_PATH,
  MAX_REPORT,
  findNonEnglishLines,
  findStaleAllowlistEntries,
  hasSkippedExtension,
  isAllowlisted,
  parseAllowlist,
  scanChangedFiles,
  selfProbe,
  shouldScan,
} from '../../../scripts/check-pr-non-english-text.js';

/**
 * Port of `.claude/hooks/non-english-text-gate.test.sh` (30 cases) to the CI
 * check that replaced the hook.
 *
 * WHICH OF THE HOOK'S CASES SURVIVED, AND WHICH COULD NOT
 * -------------------------------------------------------
 * Ported (the detection contract): the five Unicode families each blocking;
 * the em-dash / curly-quote / box-drawing / arrow PASS; the PNG and
 * pnpm-lock.yaml skips; all five allow-list cases including the two CONTROLS
 * that stop the list becoming a blanket exemption (a non-listed SIBLING in the
 * same directory must still block, and a path merely PREFIXED by a listed one
 * must still block); the allow-list file not being on its own list.
 *
 * NOT ported, because they have no CI equivalent -- they fenced the hook's
 * SHELL PARSING, which the port deletes rather than translates:
 *   - "git commit -> pass-through", "gh pr merge/edit -> block",
 *     "cd <path> && gh pr create routing", "compound: git push && gh pr create
 *     still blocks", "quoted mention of gh pr create does not fire" -- verb
 *     recognition and target-directory resolution. A CI job has one subject.
 *   - "non-git directory -> pass", "gh missing -> fail-open pass" -- the
 *     hook's fail-OPEN branches. This check fails CLOSED instead, and that
 *     inversion is pinned by its own case below.
 *   - The six PR-MODE cases (`pr diff` / `headRefOid` / `api ... contents` /
 *     `pr view --json number` / `--squash 552` / `-t 42 552`) -- the gh call
 *     chain that fetched head content over the network. CI is handed the head
 *     sha by the event payload; the end-to-end cases below use real git
 *     instead, which is why they can fence the whole path rather than a stub.
 *
 * WHY THIS FILE NEEDS NO ALLOW-LIST ENTRY: every offending fixture is built
 * from CODE POINTS (`cp(0x3042)`), so this source stays ASCII. The negative
 * fixtures (em-dash, curly quotes, box drawing, arrows) ARE written literally
 * -- "an em-dash must not match" is only pinned by an actual em-dash, and none
 * of them is in the blocked class.
 */

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

/** The five families the hook's own suite used, by code point. */
const HIRAGANA = cp(0x3053, 0x3093, 0x306b, 0x3061, 0x306f); // case 2
const KATAKANA = cp(0x30b9, 0x30b1, 0x30b8, 0x30e5); // case 3
const KANJI = cp(0x4fdd, 0x8a3c); // case 4
const HANGUL = cp(0xc548, 0xb155); // case 5
const CJK_PUNCT = `${cp(0x300c)}label${cp(0x300d)}`; // case 6

describe('findNonEnglishLines -- the Unicode class, character for character', () => {
  it.each([
    ['hiragana (U+3040-U+309F)', HIRAGANA],
    ['katakana (U+30A0-U+30FF)', KATAKANA],
    ['CJK ideographs (U+4E00-U+9FFF)', KANJI],
    ['hangul (U+AC00-U+D7AF)', HANGUL],
    ['CJK punctuation (U+3000-U+303F)', CJK_PUNCT],
  ])('flags %s', (_label, sample) => {
    expect(findNonEnglishLines(`// ${sample}\n`)).toHaveLength(1);
  });

  // Every boundary of every range, both sides. A one-codepoint slip in any of
  // the ten edges is invisible to a family-level case.
  it.each([
    ['U+2FFF, just below CJK punctuation', 0x2fff, false],
    ['U+3000, CJK punctuation floor', 0x3000, true],
    ['U+303F, CJK punctuation ceiling', 0x303f, true],
    ['U+3040, hiragana floor', 0x3040, true],
    ['U+309F, hiragana ceiling', 0x309f, true],
    ['U+30A0, katakana floor', 0x30a0, true],
    ['U+30FF, katakana ceiling', 0x30ff, true],
    ['U+3100, above katakana', 0x3100, false],
    ['U+4DFF, just below CJK ideographs', 0x4dff, false],
    ['U+4E00, CJK ideograph floor', 0x4e00, true],
    ['U+9FFF, CJK ideograph ceiling', 0x9fff, true],
    ['U+A000, just above CJK ideographs', 0xa000, false],
    ['U+ABFF, just below hangul', 0xabff, false],
    ['U+AC00, hangul floor', 0xac00, true],
    ['U+D7AF, hangul ceiling', 0xd7af, true],
    ['U+D7B0, just above hangul', 0xd7b0, false],
  ])('boundary: %s', (_label, code, flagged) => {
    expect(findNonEnglishLines(cp(code as number)).length > 0).toBe(flagged);
  });

  // The hook's case 7. These are the characters the repo already uses, and
  // widening the class to catch them would block CLAUDE.md's own ASCII art.
  it('passes em-dashes, curly quotes, box drawing and arrows', () => {
    const doc = [
      'Em-dash here - and here — followed by “smart quotes” and ‘curly’.',
      '┌───┐',
      '│ 1. Layer (src/cli/) │ → entry ⇒ done',
      '└───┘',
      'naïve café résumé',
    ].join('\n');
    expect(findNonEnglishLines(doc)).toEqual([]);
  });

  it('reports 1-based line numbers and strips a trailing CR', () => {
    const content = `line one\r\n// ${HIRAGANA}\r\nline three\r\n`;
    expect(findNonEnglishLines(content)).toEqual([{ line: 2, text: `// ${HIRAGANA}` }]);
  });
});

describe('the extension / lockfile skip list', () => {
  // The hook's cases 8 and 9: bytes that can legitimately carry non-ASCII.
  it.each([
    'docs/image.png',
    'assets/cdk-vs-cdkd.gif',
    'docs-site/logo.svg',
    'assets/x.jpeg',
    'a/b.webp',
    'a/b.pdf',
    'fonts/x.woff2',
    'fonts/x.otf',
    'a/b.tar.gz',
    'a/b.7z',
    'media/x.mp4',
    'media/x.mov',
    'some/dir/deps.lock',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'Cargo.lock',
    'go.sum',
  ])('skips %s', (path) => {
    expect(hasSkippedExtension(path)).toBe(true);
  });

  it.each(['src/foo.ts', 'README.md', 'docs/cli-reference.md', '.markgate.yml', 'Makefile'])(
    'scans %s',
    (path) => {
      expect(hasSkippedExtension(path)).toBe(false);
    },
  );

  // Ported behaviour, not an accident: the hook's `case "$f" in pnpm-lock.yaml)`
  // compared the WHOLE repo-relative path, so a nested lockfile was scanned.
  it('matches the four lockfile names on the whole path, not the basename', () => {
    expect(hasSkippedExtension('sub/pnpm-lock.yaml')).toBe(false);
    expect(hasSkippedExtension('vendor/go.sum')).toBe(false);
  });

  // Also ported rather than accidental: bash `case` is case-sensitive, so an
  // uppercase extension was scanned by the hook and is scanned here.
  it('is case-sensitive, as the hook was', () => {
    expect(hasSkippedExtension('docs/IMAGE.PNG')).toBe(false);
  });
});

describe('the sidecar allow-list', () => {
  it('ignores whole-line comments, blank lines and trailing whitespace', () => {
    const list = ['# a comment', '   # indented comment', '', '  ', 'a/b.ts   ', 'c/d.ts'].join(
      '\n',
    );
    expect(parseAllowlist(list)).toEqual(['a/b.ts', 'c/d.ts']);
  });

  // A trailing `s/#.*$//` would truncate this path to a PREFIX, and a prefix
  // is exactly what this list must never match on.
  it('does not truncate a path containing a #', () => {
    expect(parseAllowlist('tests/fixtures/issue#42/x.ts\n')).toEqual([
      'tests/fixtures/issue#42/x.ts',
    ]);
  });

  // The hook's allow1 / allow4: both listed entries are exempt, and the second
  // one is NOT under `.claude/`, so the list cannot be satisfied by some
  // accidental path-prefix rule.
  it('exempts a listed path exactly', () => {
    const allowed = [
      '.claude/hooks/gh-body-english-gate.test.sh',
      'tests/unit/utils/docker-cmd.test.ts',
    ];
    expect(isAllowlisted('.claude/hooks/gh-body-english-gate.test.sh', allowed)).toBe(true);
    expect(isAllowlisted('tests/unit/utils/docker-cmd.test.ts', allowed)).toBe(true);
  });

  // The hook's allow2 -- the CONTROL that makes the case above mean something.
  // Without it, "allow-listed path passes" is also satisfied by a check that
  // stopped scanning the whole directory.
  it('still blocks a non-listed SIBLING in the same directory', () => {
    const allowed = ['.claude/hooks/gh-body-english-gate.test.sh'];
    expect(shouldScan('.claude/hooks/some-other-gate.test.sh', allowed)).toBe(true);
  });

  // The hook's allow3. One entry silently exempting a directory is the failure
  // mode that makes an allow-list worse than no allow-list.
  it('matches EXACTLY -- never a prefix, never a glob', () => {
    const allowed = ['.claude/hooks/gh-body-english-gate.test.sh'];
    expect(shouldScan('.claude/hooks/gh-body-english-gate.test.sh.bak', allowed)).toBe(true);
    expect(shouldScan('.claude/hooks/', allowed)).toBe(true);
    expect(shouldScan('x/.claude/hooks/gh-body-english-gate.test.sh', allowed)).toBe(true);
  });

  // The hook's allow5, and the defect that blocked the PR introducing the list:
  // its first draft QUOTED the characters it describes.
  it('does not exempt itself', () => {
    const allowed = parseAllowlist(readFileSync(ALLOWLIST_PATH, 'utf8'));
    expect(allowed).not.toContain('scripts/non-english-allowlist.txt');
    expect(shouldScan('scripts/non-english-allowlist.txt', allowed)).toBe(true);
  });

  // The deliberate ADDITION over the hook, stated in the script header: an
  // entry is a permanent hole, and a hole pointing at a deleted file is a hole
  // nobody can see.
  it('reports an entry whose path no longer exists', () => {
    const exists = (f: string) => f === 'a/lives.ts';
    expect(findStaleAllowlistEntries(['a/lives.ts', 'b/gone.ts'], exists)).toEqual(['b/gone.ts']);
    expect(findStaleAllowlistEntries(['a/lives.ts'], exists)).toEqual([]);
  });
});

describe('the shipped allow-list and the check\'s own sources', () => {
  const REPO_ROOT = join(import.meta.dirname, '../../..');

  it('every shipped entry still exists', () => {
    const allowed = parseAllowlist(readFileSync(ALLOWLIST_PATH, 'utf8'));
    expect(allowed.length).toBeGreaterThan(0);
    const stale = findStaleAllowlistEntries(allowed, (f) => existsSync(join(REPO_ROOT, f)));
    expect(stale).toEqual([]);
  });

  // The property that keeps this family of files off its own list: describe
  // the content, never reproduce it. If a future edit pastes the characters in,
  // the check would block every PR touching that file -- so fail HERE instead.
  it.each([
    'scripts/check-pr-non-english-text.ts',
    'scripts/non-english-allowlist.txt',
    'scripts/check-pr-internal-labels.ts',
    'tests/unit/scripts/pr-non-english-text.test.ts',
    'tests/unit/scripts/pr-internal-labels.test.ts',
    // The body-side half of the family, added by go-to-k/cdkd#2717 and missed
    // by the first version of this list. All four are clean today, so the gap
    // was latent -- but the two TEST files are exactly where someone pastes a
    // fixture character, and the cost of that is every later PR touching them
    // being unopenable until an allow-list entry is added.
    'scripts/check-gh-body-english.ts',
    'scripts/gh-subject.ts',
    'tests/unit/scripts/gh-body-english.test.ts',
    'tests/unit/scripts/non-english-class-sync.test.ts',
  ])('%s carries no character in the blocked class', (rel) => {
    const path = join(REPO_ROOT, rel);
    expect(existsSync(path)).toBe(true);
    expect(findNonEnglishLines(readFileSync(path, 'utf8'))).toEqual([]);
  });
});

describe('scanChangedFiles', () => {
  // The semantic note the port had to choose on: WHOLE CONTENT at the PR head,
  // not just the added lines. This is the case that pins the choice -- a
  // violation on an untouched line of a touched file is still reported.
  it('reads WHOLE file content, not only added lines', () => {
    const content = ['line one', `// ${KANJI}`, 'line three'].join('\n');
    const found = scanChangedFiles(['src/foo.ts'], [], () => content);
    expect(found).toEqual([{ file: 'src/foo.ts', line: 2, text: `// ${KANJI}` }]);
  });

  // REVERSED by the go-to-k/cdkd#2717 review. This case used to assert that an
  // unreadable file is SKIPPED, and that assertion is what made the fail-open
  // look intentional: a `git show` on a C-quoted non-ASCII path failed, the
  // scanner swallowed it, and a Japanese file with Japanese content reported
  // clean at exit 0 (measured on git 2.49, both polarities).
  //
  // The old case argued nothing -- a bare `() => null` with no scenario saying
  // why an IN-SCOPE path would be unservable. `shouldScan` has already accepted
  // the path by the time the read happens, so a null is a failed read, not an
  // absent file; deletions never reach here because the file list is built with
  // `--diff-filter=AMR`.
  it('REFUSES a file it was told to scan and could not read, rather than skipping it', () => {
    expect(() => scanChangedFiles(['gone.ts'], [], () => null)).toThrow(/cannot read gone\.ts/);
  });

  it('still skips an out-of-scope or allow-listed file without reading it at all', () => {
    // The refusal above must not turn "not scanned" into "must be readable" —
    // the skip decision happens FIRST, so an image or an allow-listed path is
    // never read and so can never trip it.
    expect(scanChangedFiles(['docs/x.png'], [], () => null)).toEqual([]);
    expect(scanChangedFiles(['a/b.ts'], ['a/b.ts'], () => null)).toEqual([]);
  });

  it('stops collecting at MAX_REPORT', () => {
    const content = Array.from({ length: MAX_REPORT + 15 }, () => `// ${HIRAGANA}`).join('\n');
    expect(scanChangedFiles(['src/foo.ts'], [], () => content)).toHaveLength(MAX_REPORT);
  });

  it('never reads a skipped or allow-listed file', () => {
    const read: string[] = [];
    scanChangedFiles(['docs/x.png', 'a/b.ts', 'src/foo.ts'], ['a/b.ts'], (f) => {
      read.push(f);
      return 'ascii only';
    });
    expect(read).toEqual(['src/foo.ts']);
  });
});

describe('selfProbe', () => {
  // A checker that has gone dead and a clean tree produce the same green.
  it('passes against the shipped detector', () => {
    expect(selfProbe()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// END-TO-END. The hook's suite could only reach its gh chain through a stub;
// CI reads real git, so these cases drive the SHIPPED script as a subprocess
// against real fixture repositories. They also prove the file runs under
// Node's type stripping, which no in-process import can show.
// ---------------------------------------------------------------------------

const SCRIPT = join(import.meta.dirname, '../../../scripts/check-pr-non-english-text.ts');

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

/**
 * A fixture repo with a base commit and a head commit carrying `files`.
 *
 * It seeds every path the SHIPPED allow-list names, because the check's
 * stale-entry audit resolves entries against the working directory -- the CI
 * job's repo root. A fixture missing them would fail for that reason instead
 * of the one under test, which would make every case below unreadable.
 */
function makeRepo(files: Record<string, string>): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-noneng-'));
  git(dir, ['init', '-q', '-b', 'main']);
  const seed = (rel: string, body: string) => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  seed('README.md', '# project\nBaseline.\n');
  seed('src/foo.ts', 'export const foo = 1;\n');
  for (const entry of parseAllowlist(readFileSync(ALLOWLIST_PATH, 'utf8'))) {
    seed(entry, '// placeholder, ascii\n');
  }
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
    const repo = build({ 'src/foo.ts': `export const foo = 1;\n// ${HIRAGANA}\n` });
    const { status, output } = runCheck(repo);
    cleanup();
    expect(status).toBe(1);
    expect(output).toContain('src/foo.ts');
    expect(output).toContain('line=2');
    expect(output).toContain('non-English writing-system characters');
  });

  // The control. Without it the case above is satisfied by a script that fails
  // on everything.
  it('passes on an ASCII-only change', () => {
    const repo = build({ 'src/foo.ts': 'export const foo = 1;\nexport const bar = 2;\n' });
    const { status, output } = runCheck(repo);
    cleanup();
    expect(status).toBe(0);
    expect(output).toContain('Scanned 1 changed file(s)');
  });

  it('passes an allow-listed path and blocks its non-listed sibling', () => {
    const listed = parseAllowlist(readFileSync(ALLOWLIST_PATH, 'utf8'))[0]!;
    const sibling = join(dirname(listed), 'not-listed.ts');

    const allowed = build({ [listed]: `const p = '${HIRAGANA}';\n` });
    const allowedRun = runCheck(allowed);

    const blocked = build({ [sibling]: `const p = '${HIRAGANA}';\n` });
    const blockedRun = runCheck(blocked);
    cleanup();

    expect(allowedRun.status).toBe(0);
    expect(blockedRun.status).toBe(1);
    expect(blockedRun.output).toContain(sibling);
  });

  it('skips a binary asset carrying the characters', () => {
    const repo = build({ 'docs/image.svg': `<svg><title>${KATAKANA}</title></svg>\n` });
    const { status } = runCheck(repo);
    cleanup();
    expect(status).toBe(0);
  });

  // The inversion of the hook's fail-OPEN branches, pinned rather than assumed.
  // "I could not work out what to scan" must be RED in CI.
  it.each([
    ['an empty BASE_SHA', { BASE_SHA: '' }],
    ['an unknown HEAD_SHA', { HEAD_SHA: '0000000000000000000000000000000000000000' }],
  ])('fails CLOSED on %s', (_label, overrides) => {
    const repo = build({ 'src/foo.ts': 'export const foo = 1;\nexport const bar = 2;\n' });
    const { status, output } = runCheck(repo, overrides);
    cleanup();
    expect(status).toBe(1);
    expect(output).toContain('::error::');
  });

  // The vacuous-green guard: a PR always changes at least one file, so an
  // empty changed-file list means the refs are wrong, not that the PR is clean.
  it('fails when the resolved diff is empty', () => {
    const repo = build({ 'src/foo.ts': 'export const foo = 1;\nexport const bar = 2;\n' });
    const { status, output } = runCheck(repo, { BASE_SHA: repo.head });
    cleanup();
    expect(status).toBe(1);
    expect(output).toContain('resolved 0 changed files');
  });
});
