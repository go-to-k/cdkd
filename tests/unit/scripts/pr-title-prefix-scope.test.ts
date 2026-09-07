import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vite-plus/test';

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
  checkPrTitlePrefixScope,
  checkSquashSubsumption,
  formatFailure,
  formatSubsumptionFailure,
  hasSrcFile,
  MAX_LISTED_FILES,
  parseConventionalPrefix,
  parseFileList,
  RELEASE_TRIGGERING_PREFIXES,
  suggestPrefix,
} from '../../../scripts/check-pr-title-prefix-scope.js';

/**
 * Port of the two deleted hook suites:
 *   .claude/hooks/pr-title-prefix-scope-gate.test.sh  (22 cases)
 *   .claude/hooks/commit-prefix-scope-gate.test.sh    (34 cases)
 *
 * Every case there that asserted a VERDICT is here. Every case that asserted
 * the SHELL PARSER — `--title "x"` vs `--title='x'`, `-f|-F|--field|--raw-field
 * title=`, `-m` / `--message=` / `-F <file>` / the `-F -` heredoc, `--amend`,
 * a quoted mention of the verb, a chained `git push && gh api`, the
 * `pulls/[0-9]+` endpoint match — is deliberately absent: a CI job is handed the
 * title and the file list as data, so that parser has no analogue to test. See
 * scripts/check-pr-title-prefix-scope.ts's header for the full drop list.
 *
 * The suite is arranged so that "the checker went dead" cannot look like a pass:
 * every ALLOW family is paired with a BLOCK case over the same file mix, and the
 * two incident replays (PR #346 / PR #562) assert the failing verdict AND the
 * text of the message a maintainer would act on.
 */

/** The `.claude/**`-only diff from the PR #562 incident. */
const CLAUDE_ONLY = ['.claude/hooks/foo.sh', '.claude/rules/hooks.md'];

describe('parseConventionalPrefix — the `type(scope)?!?: ` grammar', () => {
  it.each([
    ['plain type', 'feat: add a flag', 'feat'],
    ['with scope', 'feat(cli): add a flag', 'feat'],
    ['breaking marker', 'feat!: rename API', 'feat'],
    ['scope + breaking', 'feat(cli)!: rename --flag', 'feat'],
    ['fix with scope', 'fix(hooks): make markgate gate hooks cwd-aware (#559)', 'fix'],
    ['multi-word scope', 'chore(review-pr): update bias bucket', 'chore'],
    ['revert', 'revert: feat(review-pr): add bucket entry', 'revert'],
  ])('reads the type from a %s title', (_label, title, want) => {
    expect(parseConventionalPrefix(title)).toBe(want);
  });

  // Each of these is a PASS in the hooks too: release-please ignores a subject
  // it cannot parse, so blocking on one would invent a rule the release flow
  // does not have. They are here as false-positive fences.
  it.each([
    ['no colon at all', 'Bump dependencies and clean up'],
    ['plain prose', 'just a plain message'],
    ['no space after the colon', 'fix:no space here'],
    ['uppercase type', 'Fix: handle null case'],
    ['type with a digit', 'feat2: add a flag'],
    ['type with a dash', 'hot-fix: patch it'],
    ['prefix not at the start', 'WIP feat: add a flag'],
    ['unterminated scope', 'feat(cli: add a flag'],
    ['empty title', ''],
  ])('returns null for %s', (_label, title) => {
    expect(parseConventionalPrefix(title)).toBeNull();
  });

  it('reads only the FIRST line, so a pasted body cannot supply the prefix', () => {
    expect(parseConventionalPrefix('chore: tooling\n\nfeat: not the subject')).toBe('chore');
  });
});

describe('checkPrTitlePrefixScope — BLOCKS a release-triggering title with no src/**', () => {
  // The incident this whole check exists for. `.claude/**`-only diff, `fix:`
  // title, shipped v0.145.1 with a CHANGELOG line users read as a CLI bug fix.
  it('replays PR #562: fix(hooks) over a .claude/** diff', () => {
    const v = checkPrTitlePrefixScope(
      'fix(hooks): make markgate gate hooks cwd-aware (#559)',
      CLAUDE_ONLY,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('no-src');
    expect(v.prefix).toBe('fix');
    expect(v.suggestedPrefix).toBe('chore');
  });

  // The commit-side incident, as a title. `.claude/skills/**` is dev tooling.
  it('replays PR #346: feat(review-pr) over a .claude/skills/** diff', () => {
    const v = checkPrTitlePrefixScope(
      'feat(review-pr): add **/*.md to pure-docs down-bias bucket',
      ['.claude/skills/review-pr/SKILL.md'],
    );
    expect(v.ok).toBe(false);
    expect(v.suggestedPrefix).toBe('chore');
  });

  it.each([
    ['feat over docs only', 'feat: document new pattern', ['docs/cli-reference.md'], 'docs'],
    ['fix over docs only', 'fix: docs typo', ['docs/troubleshooting.md'], 'docs'],
    ['feat over tests only', 'feat: cover the case', ['tests/unit/foo.test.ts'], 'test'],
    ['fix over .claude only', 'fix(hook): pattern bug', ['.claude/hooks/foo.sh'], 'chore'],
    [
      'feat over package.json only',
      'feat: add dep',
      ['package.json'],
      'chore(deps)',
    ],
    [
      'feat over package.json + lockfile',
      'feat: add dep',
      ['package.json', 'pnpm-lock.yaml'],
      'chore(deps)',
    ],
    [
      'feat(scope) over a mixed non-src diff',
      'feat(review-pr): bump tier',
      ['.claude/skills/review-pr/SKILL.md', 'docs/cli-reference.md'],
      'chore',
    ],
    [
      'breaking feat! over .claude only',
      'feat!: rename skill',
      ['.claude/skills/review-pr/SKILL.md'],
      'chore',
    ],
    [
      'breaking fix! over .claude only',
      'fix!: remove deprecated hook',
      ['.claude/hooks/foo.sh'],
      'chore',
    ],
    [
      'feat over build / CI files only',
      'feat: speed up the build',
      ['.github/workflows/ci.yml', 'vite.config.ts'],
      'chore',
    ],
    [
      'fix over the changelog only',
      'fix: correct a changelog entry',
      ['docs/changelog-cdkd.md'],
      'docs',
    ],
  ])('blocks %s', (_label, title, files, wantSuggestion) => {
    const v = checkPrTitlePrefixScope(title, files);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('no-src');
    expect(v.suggestedPrefix).toBe(wantSuggestion);
  });
});

describe('checkPrTitlePrefixScope — ALLOWS feat:/fix: backed by src/**', () => {
  it.each([
    ['feat with src only', 'feat: add new flag', ['src/cli/options.ts']],
    ['feat(scope) with src only', 'feat(cli): add new flag', ['src/cli/options.ts']],
    ['fix with src only', 'fix: handle null case', ['src/utils/foo.ts']],
    [
      'feat with src + tests + docs (src dominant)',
      'feat: add new flag',
      ['src/cli/options.ts', 'tests/unit/foo.test.ts', 'docs/cli-reference.md'],
    ],
    ['breaking feat! with src', 'feat!: rename API', ['src/index.ts']],
    ['breaking feat(scope)! with src', 'feat(cli)!: rename --flag', ['src/cli/options.ts']],
    [
      'fix over a mixed src + .claude diff',
      'fix(deploy): fix bug in deploy',
      ['src/cli/commands/deploy.ts', '.claude/hooks/foo.sh'],
    ],
    [
      'feat with a new provider',
      'feat(provider): add SES provider',
      ['src/provisioning/providers/ses.ts'],
    ],
    [
      'src file buried at the end of a long non-src diff',
      'fix(state): correct the v9 migration',
      ['docs/a.md', 'docs/b.md', '.claude/hooks/c.sh', 'tests/unit/d.test.ts', 'src/types/state.ts'],
    ],
  ])('allows %s', (_label, title, files) => {
    const v = checkPrTitlePrefixScope(title, files);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('src-present');
    expect(v.suggestedPrefix).toBeUndefined();
  });
});

describe('checkPrTitlePrefixScope — ALLOWS every non-release-triggering type', () => {
  // The whole point of the mapping: these types produce no version bump and no
  // CHANGELOG entry, so the file mix is irrelevant to them.
  it.each([
    ['chore over .claude only', 'chore(hooks): refactor markgate hooks', CLAUDE_ONLY],
    ['docs over docs only', 'docs: update README', ['docs/foo.md', 'README.md']],
    ['test over tests only', 'test: add coverage', ['tests/unit/foo.test.ts']],
    ['refactor over .claude only', 'refactor(hooks): cleanup', ['.claude/hooks/foo.sh']],
    ['perf over .claude only', 'perf: streamline', ['.claude/hooks/foo.sh']],
    ['style over docs only', 'style: format', ['docs/state-management.md']],
    ['ci over a workflow only', 'ci: update workflow', ['.github/workflows/ci.yml']],
    ['build over package.json only', 'build: bump tsdown', ['package.json']],
  ])('allows %s', (_label, title, files) => {
    const v = checkPrTitlePrefixScope(title, files);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('non-release-prefix');
  });

  // `revert:` gets its OWN reason, not the generic one: conventional-commits
  // treats it as a type that carries the reverted commit's prefix in its body,
  // and both hooks special-cased it ahead of the type switch.
  it.each([
    ['revert of a feat with no src/**', 'revert: feat(review-pr): add bucket entry'],
    ['revert of a fix with no src/**', 'revert: fix(hooks): pattern bug'],
  ])('passes %s through', (_label, title) => {
    const v = checkPrTitlePrefixScope(title, ['.claude/skills/review-pr/SKILL.md']);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('revert');
  });

  it('keeps the release-triggering set to exactly feat and fix', () => {
    // A hand-written assertion, not a restatement of the constant: growing this
    // set silently is how a type that DOES cut a release stops being checked.
    expect([...RELEASE_TRIGGERING_PREFIXES]).toEqual(['feat', 'fix']);
  });
});

describe('checkPrTitlePrefixScope — pass-throughs', () => {
  it('passes a non-conventional title over a non-src diff', () => {
    const v = checkPrTitlePrefixScope('Bump dependencies and clean up', CLAUDE_ONLY);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('not-conventional');
  });

  // The hooks' "no subject available" arms: `gh pr create` with no `--title`
  // (editor), and bare `git commit` (COMMIT_EDITMSG). A real PR always has a
  // title by the time CI runs, so this is defensive rather than reachable.
  it('passes an empty title', () => {
    const v = checkPrTitlePrefixScope('', CLAUDE_ONLY);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('no-title');
  });

  it('passes a whitespace-only title', () => {
    expect(checkPrTitlePrefixScope('   ', CLAUDE_ONLY).reason).toBe('no-title');
  });

  // The hook's "no diff against main" arm: nothing to ship, and `gh pr create`
  // has its own clearer error.
  it('passes a feat: title with an empty diff', () => {
    const v = checkPrTitlePrefixScope('feat: add a flag', []);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('no-diff');
  });

  it('treats a diff of blank lines as empty', () => {
    expect(checkPrTitlePrefixScope('feat: add a flag', ['', '  ']).reason).toBe('no-diff');
  });
});

describe('hasSrcFile — the `src/` prefix is a PATH ANCHOR, not a substring', () => {
  // Both hooks used `case "$f" in src/*)`, which is start-anchored and requires
  // the slash. A substring test here would silently excuse every PR touching a
  // file with "src" anywhere in its path — the fail-open direction.
  it.each([
    ['src/cli/options.ts', true],
    ['src/a.ts', true],
    ['srcfoo/x.ts', false],
    ['src.ts', false],
    ['docs/src/x.md', false],
    ['tests/integration/src/app.ts', false],
    ['.claude/skills/src/SKILL.md', false],
    ['websrc/x.ts', false],
    ['SRC/x.ts', false],
  ])('%s -> %s', (file, want) => {
    expect(hasSrcFile([file])).toBe(want);
  });

  it('BLOCKS a fix: whose only "src"-looking path is nested', () => {
    // The paired negative for the anchoring above: if the anchor were dropped
    // this case would flip to a pass and nothing else in the suite would notice.
    const v = checkPrTitlePrefixScope('fix: tweak the sample app', [
      'tests/integration/src/app.ts',
    ]);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('no-src');
  });
});

describe('suggestPrefix — the hooks heuristic, precedence preserved', () => {
  it.each([
    ['docs/** only', ['docs/a.md', 'docs/b.md'], 'docs'],
    ['README.md only', ['README.md'], 'docs'],
    ['CLAUDE.md only', ['CLAUDE.md'], 'docs'],
    ['a nested README.md', ['tests/integration/foo/README.md'], 'docs'],
    ['tests/** only', ['tests/unit/a.test.ts'], 'test'],
    ['.claude/** only', ['.claude/hooks/a.sh', '.claude/rules/b.md'], 'chore'],
    ['package.json only', ['package.json'], 'chore(deps)'],
    ['package.json + pnpm-lock.yaml', ['package.json', 'pnpm-lock.yaml'], 'chore(deps)'],
    ['pnpm-lock.yaml only', ['pnpm-lock.yaml'], 'chore(deps)'],
    ['docs + tests mixed', ['docs/a.md', 'tests/unit/a.test.ts'], 'chore'],
    ['docs + .claude mixed', ['docs/a.md', '.claude/hooks/a.sh'], 'chore'],
    ['build / CI files', ['.github/workflows/ci.yml', '.gitignore'], 'chore'],
    ['package.json + a docs file', ['package.json', 'docs/a.md'], 'chore'],
  ])('suggests %s -> %s', (_label, files, want) => {
    expect(suggestPrefix(files)).toBe(want);
  });

  // The `has_*` half of the bash `all_* && has_*` pair. With an empty list every
  // `all_*` flag is vacuously true, and the bash fell through to `chore` rather
  // than claiming a docs-only change. Reachable only via suggestPrefix directly
  // (checkPrTitlePrefixScope returns `no-diff` first), so it is asserted here.
  it('falls through to chore on an empty list rather than claiming docs', () => {
    expect(suggestPrefix([])).toBe('chore');
  });
});

describe('formatFailure — the message a maintainer acts on', () => {
  const v = checkPrTitlePrefixScope('fix(hooks): cwd-aware', CLAUDE_ONLY);
  const msg = formatFailure(v);

  it('names the offending prefix and the suggested replacement', () => {
    expect(msg).toContain("prefix 'fix:'");
    expect(msg).toContain('Suggested title prefix: chore:');
  });

  it('lists the changed files that failed the check', () => {
    for (const f of CLAUDE_ONLY) expect(msg).toContain(`  - ${f}`);
  });

  it('carries the full type -> path mapping', () => {
    expect(msg).toContain('src/**                                 -> feat: or fix:');
    expect(msg).toContain('package.json + pnpm-lock.yaml only     -> chore(deps):');
  });

  it('points at the `edited` re-run, which is how a retitle clears the check', () => {
    expect(msg).toContain("re-runs on the 'edited' event");
  });

  it(`truncates the file list past ${MAX_LISTED_FILES} entries`, () => {
    const many = Array.from({ length: 25 }, (_, i) => `docs/f${i}.md`);
    const big = formatFailure(checkPrTitlePrefixScope('feat: many docs', many));
    expect(big).toContain('  - docs/f19.md');
    expect(big).not.toContain('  - docs/f20.md');
    expect(big).toContain(`...truncated (>${MAX_LISTED_FILES} files)`);
  });
});

describe('the CI-only gain: a verdict that was correct at open and stops being correct', () => {
  // The PreToolUse hook fired ONCE, at `gh pr create`. This job re-runs on
  // `synchronize`, so the sequence below is now caught. There is no hook case to
  // port here — it is coverage the hook could not have.
  const title = 'fix(deploy): correct the retry backoff';

  it('passes at open, when the diff still carries a src/** file', () => {
    expect(checkPrTitlePrefixScope(title, ['src/deployment/retry.ts', 'docs/a.md']).ok).toBe(
      true,
    );
  });

  it('FAILS after a later push reverts the last src/** file', () => {
    const v = checkPrTitlePrefixScope(title, ['docs/a.md']);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('no-src');
  });

  // The mirror case, owned by the `edited` trigger: the diff never moved, the
  // title was retyped in the web UI — which never goes through `gh`, so the hook
  // could not observe it even in principle.
  it('FAILS after the title alone is retyped to fix: on an unchanged diff', () => {
    expect(checkPrTitlePrefixScope('chore(hooks): x', CLAUDE_ONLY).ok).toBe(true);
    expect(checkPrTitlePrefixScope('fix(hooks): x', CLAUDE_ONLY).ok).toBe(false);
  });
});

describe('checkSquashSubsumption — the premise that let the commit-side gate be deleted', () => {
  // Measured 2026-09-07 with
  //   gh api repos/go-to-k/cdkd --jq '{squash_merge_commit_title, ...}'
  const MEASURED = {
    squash_merge_commit_title: 'PR_TITLE',
    squash_merge_commit_message: 'BLANK',
    allow_merge_commit: false,
    allow_rebase_merge: false,
    allow_squash_merge: true,
  };

  it('holds under the settings measured on this repo', () => {
    const r = checkSquashSubsumption(MEASURED);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  // Each of these is a real GitHub setting a maintainer can flip in the UI, and
  // each one puts a branch commit subject back in front of release-please where
  // nothing checks it. Without these three cases the subsumption argument would
  // be prose, which is exactly what went stale in the incidents above.
  it('breaks when the squash subject can come from a COMMIT', () => {
    const r = checkSquashSubsumption({
      ...MEASURED,
      squash_merge_commit_title: 'COMMIT_OR_PR_TITLE',
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toContain('COMMIT_OR_PR_TITLE');
  });

  it('breaks when the squash BODY carries the branch commit messages', () => {
    const r = checkSquashSubsumption({
      ...MEASURED,
      squash_merge_commit_message: 'COMMIT_MESSAGES',
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toContain('COMMIT_MESSAGES');
  });

  it.each([
    ['merge commits', { allow_merge_commit: true }],
    ['rebase merges', { allow_rebase_merge: true }],
  ])('breaks when %s are re-enabled', (_label, patch) => {
    const r = checkSquashSubsumption({ ...MEASURED, ...patch });
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toContain('non-squash merge');
  });

  it('reports every violated precondition, not just the first', () => {
    const r = checkSquashSubsumption({
      squash_merge_commit_title: 'COMMIT_OR_PR_TITLE',
      squash_merge_commit_message: 'COMMIT_MESSAGES',
      allow_merge_commit: true,
      allow_rebase_merge: true,
    });
    expect(r.violations).toHaveLength(3);
  });

  it('tells the reader what to do about it', () => {
    const msg = formatSubsumptionFailure(
      checkSquashSubsumption({ ...MEASURED, allow_merge_commit: true }).violations,
    );
    expect(msg).toContain('re-introduce a per-commit prefix/scope check');
    expect(msg).toContain('scripts/check-pr-title-prefix-scope.ts');
  });
});

describe('parseFileList', () => {
  it('drops blank lines and trailing CR', () => {
    expect(parseFileList('src/a.ts\r\n\ndocs/b.md\n')).toEqual(['src/a.ts', 'docs/b.md']);
  });

  it('returns an empty list for empty input', () => {
    expect(parseFileList('')).toEqual([]);
    expect(parseFileList('\n\n')).toEqual([]);
  });
});

describe('the CLI names its file source, so a bare invocation cannot HANG', () => {
  // go-to-k/cdkd#2717. `--files-from` absent used to mean "read stdin", so
  // `node scripts/check-pr-title-prefix-scope.ts --title x` blocked forever on
  // whatever stdin it inherited — measured, killed by a 2-minute timeout. In CI
  // that burns the job timeout and the step is KILLED, reporting no verdict at
  // all, which is strictly worse than a failure.
  //
  // The first fix guarded on `process.stdin.isTTY` and was WRONG in the way
  // that matters: CI has no TTY either, so it would never have fired where the
  // hang costs something, while looking like the hole was closed. These cases
  // drive the real BINARY rather than an exported function, because the defect
  // lives in argument handling and a unit call cannot reach it.
  const SCRIPT = fileURLToPath(new URL('../../../scripts/check-pr-title-prefix-scope.ts', import.meta.url));
  const run = (args: string[], input = '') =>
    spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8', timeout: 20_000 });

  it('exits 2 with usage when no file source is named, rather than reading stdin', () => {
    const r = run(['--title', 'fix: x']);
    expect(r.signal).toBeNull(); // not killed by the timeout — this is the regression
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--files-from -');
  });

  it('still accepts stdin, spelled explicitly', () => {
    const r = run(['--title', 'fix: x', '--files-from', '-'], 'src/a.ts\n');
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
  });

  it('and stdin carrying no src/** file still FAILS — the check is not bypassed by the spelling', () => {
    const r = run(['--title', 'fix: x', '--files-from', '-'], 'docs/a.md\n');
    expect(r.signal).toBeNull();
    expect(r.status).toBe(1);
  });
});

describe('--check-settings, the CLI mode the squash-subsumption audit runs', () => {
  // `checkSquashSubsumption` is well covered as a function, but the MODE the
  // workflow invokes (`pr-title-check.yml`, the second step) was never spawned:
  // file read, JSON parse and exit code had no case. That step is the entire
  // justification for deleting `commit-prefix-scope-gate` -- it is what keeps
  // the premise "the PR title IS the squash subject" from silently ceasing to
  // hold when someone flips a repository setting. An untested audit is the
  // thing the audit exists to prevent (go-to-k/cdkd#2717 test review).
  const SCRIPT = fileURLToPath(new URL('../../../scripts/check-pr-title-prefix-scope.ts', import.meta.url));
  // The live settings, measured 2026-09-07 on go-to-k/cdkd. Restated here rather
  // than shared with the function-level block above: these cases assert what the
  // BINARY does with a file, and coupling them to that block's fixture would let
  // one edit silently change what both are testing.
  const MEASURED = {
    squash_merge_commit_title: 'PR_TITLE',
    squash_merge_commit_message: 'BLANK',
    allow_merge_commit: false,
    allow_rebase_merge: false,
    allow_squash_merge: true,
  };
  const settingsFile = (settings: Record<string, unknown>): string => {
    const f = join(mkdtempSync(join(tmpdir(), 'ptps-')), 'repo-settings.json');
    writeFileSync(f, JSON.stringify(settings));
    return f;
  };
  const run = (args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000 });

  it('exits 0 when every precondition holds', () => {
    const r = run(['--check-settings', settingsFile(MEASURED)]);
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
  });

  it.each([
    ['squash_merge_commit_title', 'COMMIT_OR_PR_TITLE'],
    ['squash_merge_commit_message', 'COMMIT_MESSAGES'],
    ['allow_merge_commit', true],
    ['allow_rebase_merge', true],
  ])('exits 1 and names %s when it changes', (key, value) => {
    const r = run(['--check-settings', settingsFile({ ...MEASURED, [key]: value })]);
    expect(r.signal).toBeNull();
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain(key);
  });

  it('refuses a settings file it cannot read, rather than reporting the premise holds', () => {
    // The fail-OPEN direction: an unreadable file must not read as "no
    // violations found". The workflow warns on a gh TRANSPORT failure, which is
    // a different case -- there is no file at all then.
    const r = run(['--check-settings', join(tmpdir(), 'ptps-does-not-exist.json')]);
    expect(r.signal).toBeNull();
    // Exactly 2, the "could not evaluate" code -- NOT merely non-zero. A bare
    // `.not.toBe(0)` passed while the real behaviour was an uncaught ENOENT at
    // exit 1, which in CI is indistinguishable from a genuine settings
    // violation (go-to-k/cdkd#2717 fix-delta review).
    expect(r.status).toBe(2);
  });
});

describe('settings the token cannot SEE are reported as unverified, never as a verdict', () => {
  // MEASURED 2026-09-07, and the first version of this block encoded the
  // opposite: `gh api repos/aws/aws-cdk` (no admin) returns null for ALL FIVE
  // fields, not just the two admin-gated title/message ones. The premise these
  // cases used to assert -- "the merge-method booleans ARE readable by any
  // token, so those still decide" -- is false, and it made the CI audit
  // vacuous while printing "merge methods are squash-only": an unearned pass,
  // worse than the wrong-red it replaced. Readability is all-or-nothing now.
  const CI_TOKEN_VIEW = {
    squash_merge_commit_title: null,
    squash_merge_commit_message: null,
    allow_merge_commit: null,
    allow_rebase_merge: null,
    allow_squash_merge: null,
  } as unknown as Parameters<typeof checkSquashSubsumption>[0];

  const ADMIN_VIEW = {
    squash_merge_commit_title: 'PR_TITLE',
    squash_merge_commit_message: 'BLANK',
    allow_merge_commit: false,
    allow_rebase_merge: false,
    allow_squash_merge: true,
  } as unknown as Parameters<typeof checkSquashSubsumption>[0];

  it("reports unreadable, not a violation, on CI's actual view", () => {
    const r = checkSquashSubsumption(CI_TOKEN_VIEW);
    expect(r.unreadable).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('treats a PARTIALLY readable response as unreadable too', () => {
    // The dangerous middle: if some fields arrive and others do not, the ones
    // that arrived must not be used to pronounce on the premise -- a partial
    // answer is not a smaller answer, it is an unknown one.
    for (const missing of [
      'squash_merge_commit_title',
      'squash_merge_commit_message',
      'allow_merge_commit',
      'allow_rebase_merge',
    ] as const) {
      const partial = { ...ADMIN_VIEW, [missing]: null } as typeof ADMIN_VIEW;
      expect(checkSquashSubsumption(partial).unreadable, `${missing} absent`).toBe(true);
    }
  });

  it('STILL fails a real violation once the settings ARE readable', () => {
    // The audit must not become permanently toothless: with an admin token the
    // full premise is enforced, which is what `/verify-pr` runs.
    const r = checkSquashSubsumption({ ...ADMIN_VIEW, allow_merge_commit: true });
    expect(r.unreadable).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.violations.join(' ')).toContain('allow_merge_commit');
  });

  it('does not claim it verified anything when it could not see the settings', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'ptps-ci-')), 'repo-settings.json');
    writeFileSync(f, JSON.stringify(CI_TOKEN_VIEW));
    const r = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../../scripts/check-pr-title-prefix-scope.ts', import.meta.url)),
        '--check-settings',
        f,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('NOT VERIFIED');
    // The exact wording that used to be printed on this input, and was a lie.
    expect(r.stdout).not.toContain('merge methods are squash-only');
    expect(r.stdout).not.toContain('premise holds');
  });
});
