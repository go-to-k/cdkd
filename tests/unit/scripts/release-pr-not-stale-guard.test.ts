import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

/**
 * The `release-pr-not-stale` job in `.github/workflows/ci.yml`, driven against
 * real git repositories rather than inspected as text.
 *
 * What it guards: release-please does NOT rebuild a standing release PR whose
 * computed release is unchanged — it logs `PR #N remained the same` and leaves
 * the branch on the base it was cut from. A `chore:` / `ci:` / `docs:` commit
 * produces no changelog entry, so it lands on main WITHOUT the release branch
 * following, and merging the PR then takes the branch's older copy of any file
 * release-please owns. GitHub reports MERGEABLE throughout — measured on
 * go-to-k/cdkd#2503, which would have undone 285 CHANGELOG header conversions.
 * A human reading the diff was the only thing catching that, and arming
 * auto-merge on the release PR removes the human.
 *
 * Why it needs a suite at all: the job is a CHECKER, and
 * `.claude/rules/testing.md` forbids a checker whose "found nothing" and "went
 * dead" produce the same green. Its whole body is three git invocations, each
 * of which rots silently — drop the `!` from the `merge-base` test, drop the
 * `--` from `rev-list`, misspell `FETCH_HEAD`, and the job passes on every
 * input including the stale one it exists to refuse. Both arms were probed by
 * hand once before the job was committed; nothing re-ran them, which is what
 * this file fixes.
 *
 * The shell is EXTRACTED from the workflow and executed, never re-typed: a
 * copy in this file would keep passing after the workflow's copy was broken.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CI_YML = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

/** Files the job asserts main's tip for. Kept in step with the job below. */
const OWNED_FILES = ['CHANGELOG.md', '.release-please-manifest.json'] as const;

interface CiWorkflow {
  jobs: Record<string, { if?: string; steps?: { name?: string; run?: string }[] }>;
}

function workflow(): CiWorkflow {
  return parseYaml(readFileSync(CI_YML, 'utf8')) as CiWorkflow;
}

/** The `run:` body of the job's ancestry step (step 0 is the checkout). */
function guardShell(): string {
  const step = workflow().jobs['release-pr-not-stale']?.steps?.[1];
  expect(
    step?.run,
    'release-pr-not-stale has no second step with a `run:` body in ' +
      '.github/workflows/ci.yml. If the step was renamed or reordered, update this ' +
      'extractor; if it was REMOVED, restore it — a release PR could then be merged ' +
      'stale with nothing objecting.'
  ).toBeTruthy();
  return step?.run as string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Hermetic: a maintainer's global config (hooks path, signing, a
      // different default branch) must not decide this suite's verdict.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  }).trim();
}

function commit(repo: string, file: string, body: string, subject: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', subject);
  return git(repo, 'rev-parse', 'HEAD');
}

/**
 * Run the extracted guard with `cwd` as the checked-out release branch and
 * `origin` pointing at the fixture's bare remote. Returns exit status + output.
 */
function guardRun(cwd: string): { status: number; output: string } {
  try {
    const output = execFileSync('bash', ['-c', guardShell()], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      stdio: 'pipe',
    });
    return { status: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('release-pr-not-stale', () => {
  let scratch: string;
  let remote: string;
  /** Commit on main that last touched CHANGELOG.md. */
  let changelogTip: string;
  /** The commit immediately before it — what a stale branch was cut from. */
  let beforeChangelog: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cdkd-release-stale-'));
    const origin = join(scratch, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');

    // A main history shaped like this repo's: a release commit touching both
    // owned files, then ordinary work, then a later edit to CHANGELOG.md that
    // a standing release PR would NOT absorb.
    writeFileSync(join(origin, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0\n');
    writeFileSync(join(origin, '.release-please-manifest.json'), '{ ".": "0.1.0" }\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'chore(release): 0.1.0');
    commit(origin, 'src.txt', 'work\n', 'feat: something');
    beforeChangelog = git(origin, 'rev-parse', 'HEAD');
    changelogTip = commit(
      origin,
      'CHANGELOG.md',
      '# Changelog\n\n## 0.1.0 (normalized)\n',
      'chore(docs): normalize changelog headers'
    );

    remote = join(scratch, 'remote.git');
    execFileSync('git', ['clone', '-q', '--bare', origin, remote], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A release branch cut from `base`, with release-please's own commit on top. */
  function releaseBranchAt(base: string, name: string): string {
    const wt = join(scratch, name);
    execFileSync('git', ['clone', '-q', remote, wt], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    git(wt, 'checkout', '-q', '-b', 'release-please--branches--main', base);
    commit(wt, '.release-please-manifest.json', '{ ".": "0.1.1" }\n', 'chore(release): 0.1.1');
    return wt;
  }

  it('passes on a release branch cut from current main', () => {
    const { status, output } = guardRun(releaseBranchAt('origin/main', 'fresh'));
    expect(output).not.toContain('::error::');
    expect(status).toBe(0);
  });

  it('fails on a release branch cut before main moved CHANGELOG.md', () => {
    // The go-to-k/cdkd#2503 shape: `chore(docs):` produced no changelog entry,
    // so release-please left the branch behind, and merging it reverts the
    // normalization.
    const { status, output } = guardRun(releaseBranchAt(beforeChangelog, 'stale'));
    expect(status).not.toBe(0);
    expect(output).toContain('CHANGELOG.md');
    expect(output).toContain(changelogTip);
    expect(output).toContain('re-run release.yml');
  });

  it('fails closed when an owned file has no history on main', () => {
    // "The guard cannot answer" must not read as "the guard found nothing
    // wrong" — a rename of either file would otherwise silence it forever.
    const wt = releaseBranchAt('origin/main', 'renamed');
    // Rewrite the remote's main so .release-please-manifest.json never existed.
    const bare = join(scratch, 'empty-remote.git');
    mkdirSync(bare);
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    const seed = join(scratch, 'seed');
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    commit(seed, 'CHANGELOG.md', '# Changelog\n', 'chore(release): 0.1.0');
    git(seed, 'remote', 'add', 'origin', bare);
    git(seed, 'push', '-q', 'origin', 'main');
    git(wt, 'remote', 'set-url', 'origin', bare);

    const { status, output } = guardRun(wt);
    expect(status).not.toBe(0);
    expect(output).toContain('.release-please-manifest.json');
    expect(output).toContain('cannot evaluate staleness');
  });

  it('checks every file release-please owns', () => {
    // A shrunk list is the cheapest way for this job to go quiet: dropping
    // CHANGELOG.md leaves the manifest check green on the exact #2503 shape.
    const shell = guardShell();
    for (const f of OWNED_FILES) {
      expect(shell).toContain(f);
    }
    // package.json is deliberately EXCLUDED — `chore(deps)` PRs touch it
    // constantly and release-please's own diff there is the `version` line
    // alone, which a three-way merge cannot use to revert a dependency line.
    expect(shell).not.toContain('package.json');
  });

  it('is guarded by the branch prefix release-please actually produces', () => {
    // `release-please--` is the action's built-in prefix. It changes only if
    // the config sets `branch-prefix`, and if it ever does, this job silently
    // skips on every PR and ci-ok stays green — the vacuous pass the
    // once-leak-detect canary exists to forbid for its own detector.
    expect(workflow().jobs['release-pr-not-stale']?.if).toBe(
      "startsWith(github.head_ref, 'release-please--')"
    );
    const config = JSON.parse(
      readFileSync(join(REPO_ROOT, 'release-please-config.json'), 'utf8')
    ) as Record<string, unknown> & { packages?: Record<string, Record<string, unknown>> };
    expect(
      'branch-prefix' in config || 'branch-prefix' in (config.packages?.['.'] ?? {}),
      'release-please-config.json now sets `branch-prefix`, so the release branch no ' +
        'longer starts with `release-please--` and the release-pr-not-stale job skips on ' +
        'every PR. Update its `if:` to the new prefix.'
    ).toBe(false);
  });
});
