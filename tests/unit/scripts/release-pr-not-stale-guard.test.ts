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
 * Why it needs a suite: the job is a CHECKER, and `.claude/rules/testing.md`
 * forbids one whose "found nothing" and "went dead" produce the same green.
 *
 * Three properties are fenced, and the first two were review findings on this
 * PR rather than hypotheticals:
 *
 *   1. The CHECKOUT, not just the shell. Deleting `ref: head.sha` from step 0
 *      makes the runner use the default `refs/pull/N/merge`, which has the base
 *      already merged in — so every `merge-base --is-ancestor` answers yes and
 *      the job passes on a stale branch. An earlier revision of this file read
 *      `steps[1]` only and stayed green through exactly that mutation.
 *   2. EACH ARM of the loop separately. An earlier fixture only ever moved
 *      `CHANGELOG.md` on main, so `.release-please-manifest.json` never
 *      discriminated and gating the ancestry test on the filename survived
 *      undetected. The remotes below are built so that each file, in turn, is
 *      the only one that can fail.
 *   3. The shell itself, EXTRACTED and EXECUTED, never re-typed — a copy here
 *      would keep passing after the workflow's copy was broken — and selected
 *      BY STEP NAME, so inserting a step ahead of it cannot silently retarget
 *      the extractor.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CI_YML = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const RELEASE_YML = join(REPO_ROOT, '.github', 'workflows', 'release.yml');

const JOB = 'release-pr-not-stale';
const STEP = 'release-please-owned files on main must be ancestors of this branch';
const CHANGELOG = 'CHANGELOG.md';
const MANIFEST = '.release-please-manifest.json';

interface CiWorkflow {
  jobs: Record<
    string,
    {
      if?: string;
      'continue-on-error'?: unknown;
      steps?: {
        name?: string;
        uses?: string;
        run?: string;
        if?: string;
        'continue-on-error'?: unknown;
        with?: Record<string, unknown>;
      }[];
    }
  >;
}

function workflow(): CiWorkflow {
  return parseYaml(readFileSync(CI_YML, 'utf8')) as CiWorkflow;
}

function jobSteps(): NonNullable<CiWorkflow['jobs'][string]['steps']> {
  const steps = workflow().jobs[JOB]?.steps;
  expect(steps, `job \`${JOB}\` is gone from .github/workflows/ci.yml`).toBeTruthy();
  return steps as NonNullable<CiWorkflow['jobs'][string]['steps']>;
}

/** The ancestry step's `run:` body, selected by NAME rather than by index. */
function guardShell(): string {
  const step = jobSteps().find((s) => s.name === STEP);
  expect(
    step?.run,
    `the step \`${STEP}\` is gone from job \`${JOB}\` in .github/workflows/ci.yml. If it ` +
      `was renamed, update this extractor; if it was REMOVED, restore it — a release PR ` +
      `could then be merged stale with nothing objecting.`
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
 * `origin` pointing at the fixture's bare remote.
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
  // `| undefined` on purpose: the `if (scratch)` guard in afterAll exists
  // because `mkdtempSync` can fail, and the non-nullable type said otherwise.
  // Everything that USES it goes through `scratchDir()`, which turns a
  // not-yet-created scratch into a named failure rather than a `join(undefined)`
  // TypeError several frames away from the cause.
  let scratch: string | undefined;

  function scratchDir(): string {
    expect(scratch, 'the scratch directory was never created (mkdtempSync failed)').toBeTruthy();
    return scratch as string;
  }
  let cloneSeq = 0;

  interface Fixture {
    /** Bare remote the guard's `git fetch origin main` will read. */
    remote: string;
    /** Commit that last touched the file this fixture is about. */
    tip: string;
    /** The commit before it — what a branch left behind would be cut from. */
    base: string;
  }

  /**
   * A main history ending in a commit that touches ONLY `lastFile`. A release
   * branch cut at `base` is then stale by `lastFile` and by nothing else, which
   * is what makes each arm of the production loop separately observable.
   *
   * `seedManifest: false` builds a history where the manifest NEVER existed, so
   * `git rev-list -1 ... -- <manifest>` comes back empty and the fail-closed
   * branch of the loop is reached with the CHANGELOG arm passing.
   */
  function makeRemote(name: string, lastFile: string, seedManifest = true): Fixture {
    const origin = join(scratchDir(), `${name}-origin`);
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, CHANGELOG), '# Changelog\n\n## 0.1.0\n');
    if (seedManifest) writeFileSync(join(origin, MANIFEST), '{ ".": "0.1.0" }\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'chore(release): 0.1.0');
    const base = commit(origin, 'src.txt', 'work\n', 'feat: something');
    const tip =
      lastFile === CHANGELOG
        ? commit(origin, CHANGELOG, '# Changelog\n\n## 0.1.0 (normalized)\n', 'chore(docs): normalize')
        : commit(origin, MANIFEST, '{ ".": "0.1.0-edited" }\n', 'chore: hand-edit the manifest');

    const remote = join(scratchDir(), `${name}-remote.git`);
    execFileSync('git', ['clone', '-q', '--bare', origin, remote], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    return { remote, tip, base };
  }

  /** A release branch cut from `at`, with release-please's own commit on top. */
  function releaseBranchAt(fixture: Fixture, at: string): string {
    const wt = join(scratchDir(), `wt-${cloneSeq++}`);
    execFileSync('git', ['clone', '-q', fixture.remote, wt], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    git(wt, 'checkout', '-q', '-b', 'release-please--branches--main', at);
    commit(wt, 'RELEASE_NOTE.txt', 'release-please commit\n', 'chore(release): 0.1.1');
    return wt;
  }

  let changelogFixture: Fixture;
  let manifestFixture: Fixture;
  let noManifestFixture: Fixture;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cdkd-release-stale-'));
    changelogFixture = makeRemote('changelog', CHANGELOG);
    manifestFixture = makeRemote('manifest', MANIFEST);
    // Main never had the manifest at all — the "cannot answer" path, with the
    // CHANGELOG arm deliberately able to pass so it cannot mask the verdict.
    noManifestFixture = makeRemote('nomanifest', CHANGELOG, false);
  });

  afterAll(() => {
    // `mkdtempSync` failing leaves `scratch` undefined, and an unguarded
    // `rmSync` then throws a TypeError that buries the real cause.
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  describe('the checkout the guard depends on', () => {
    it('takes the PR HEAD, not the default merge ref', () => {
      // `refs/pull/N/merge` has the base already merged in, so every ancestry
      // question answers "yes" no matter how stale the branch is. Losing this
      // `ref:` is the one mutation that makes the whole job vacuous while its
      // shell is still perfectly correct.
      const checkout = jobSteps().find((s) => (s.uses ?? '').startsWith('actions/checkout@'));
      expect(checkout, `job \`${JOB}\` no longer checks anything out`).toBeTruthy();
      expect(checkout?.with?.['ref']).toBe('${{ github.event.pull_request.head.sha }}');
    });

    it('fetches the full history the ancestry test needs', () => {
      const checkout = jobSteps().find((s) => (s.uses ?? '').startsWith('actions/checkout@'));
      // `String(... ?? '')`, NOT `Number(...)`. Comparing numerically was an
      // attempt to tolerate the equally-valid `fetch-depth: "0"`, and it
      // RETIRED the bound instead: a bare `fetch-depth:` parses to null and
      // `fetch-depth: ""` to the empty string, both of which `Number()` maps to
      // 0 — while actions/checkout reads `Number(getInput(...) || '1')` and
      // clones at depth ONE. That is precisely the shallow-clone mutation this
      // case exists to catch, and the numeric form greened on it.
      expect(String(checkout?.with?.['fetch-depth'] ?? '')).toBe('0');
    });

    it('lets the shell exit status decide the job', () => {
      // This suite EXECUTES the extracted shell, so it attests that the TEXT is
      // correct — never that the runner acts on its exit status.
      // `continue-on-error: true` or a false step-level `if:` severs that link
      // and the job reports success having decided nothing.
      // `?? false` because an explicit `continue-on-error: false` is
      // semantically identical to its absence, and a fence that reds on it is
      // refusing a correct spelling.
      const step = jobSteps().find((s) => s.name === STEP);
      expect(step?.['continue-on-error'] ?? false).toBe(false);
      expect(step?.if).toBeUndefined();
      expect(workflow().jobs[JOB]?.['continue-on-error'] ?? false).toBe(false);
    });
  });

  describe('each owned file separately', () => {
    it('passes on a release branch cut from current main', () => {
      const { status, output } = guardRun(releaseBranchAt(changelogFixture, 'origin/main'));
      expect(status).toBe(0);
      expect(output).not.toContain('::error::');
    });

    it('fails when main moved CHANGELOG.md after the branch was cut', () => {
      // The go-to-k/cdkd#2503 shape: `chore(docs):` produced no changelog entry,
      // so release-please left the branch behind and merging it reverts the
      // normalization.
      const { status, output } = guardRun(
        releaseBranchAt(changelogFixture, changelogFixture.base)
      );
      expect(status).not.toBe(0);
      expect(output).toContain(CHANGELOG);
      expect(output).toContain(changelogFixture.tip);
      expect(output).toContain('re-run release.yml');
      // Only this arm may fire here — otherwise the case cannot tell a
      // per-file check from one that refuses everything.
      expect(output).not.toContain(`${MANIFEST} was last changed`);
    });

    it('fails when main moved the manifest after the branch was cut', () => {
      // Without this case the manifest arm never discriminates, and gating the
      // ancestry test on `[ "${f}" = "CHANGELOG.md" ]` survives the suite.
      const { status, output } = guardRun(releaseBranchAt(manifestFixture, manifestFixture.base));
      expect(status).not.toBe(0);
      expect(output).toContain(MANIFEST);
      expect(output).toContain(manifestFixture.tip);
      expect(output).not.toContain(`${CHANGELOG} was last changed`);
    });

    it('fails closed when an owned file has no history on main', () => {
      // "The guard cannot answer" must not read as "the guard found nothing
      // wrong". The CHANGELOG arm passes in this fixture, so the non-zero exit
      // can only come from the empty-tip branch.
      const { status, output } = guardRun(releaseBranchAt(noManifestFixture, 'origin/main'));
      expect(status).not.toBe(0);
      expect(output).toContain('cannot evaluate staleness');
      expect(output).toContain(MANIFEST);
      expect(output).not.toContain(`${CHANGELOG} has no commit history`);
    });
  });

  describe('the job stays wired to the thing it guards', () => {
    it('checks exactly the files release-please owns', () => {
      // Read the loop's actual subject list rather than asserting a substring
      // is absent — `not.toContain('package.json')` passes over an empty
      // string and over a shell that checks nothing at all.
      const m = /^for f in (.+); do$/m.exec(guardShell());
      expect(m, "the guard's `for f in ...; do` loop is gone").not.toBeNull();
      expect((m as RegExpExecArray)[1]!.trim().split(/\s+/).sort()).toEqual(
        [CHANGELOG, MANIFEST].sort()
      );
    });

    it('is guarded by the branch prefix release-please actually produces', () => {
      expect(workflow().jobs[JOB]?.if).toBe("startsWith(github.head_ref, 'release-please--')");
      // What can actually move that prefix is a release-please MAJOR, not any
      // config key — `branch-prefix` does not exist in release-please's config
      // schema, so an earlier revision of this case asserted the absence of a
      // key that can never appear. The action is SHA-pinned, so the pin's major
      // is the real change vector: bumping it must force a re-check of the
      // `if:` above, and dependabot's weekly patch bumps must not.
      const pin = /googleapis\/release-please-action@[0-9a-f]{40} # v(\d+)/.exec(
        readFileSync(RELEASE_YML, 'utf8')
      );
      expect(pin, 'release.yml no longer SHA-pins googleapis/release-please-action').not.toBeNull();
      expect(
        (pin as RegExpExecArray)[1],
        'release-please was bumped to a new MAJOR. Its release branch prefix is a property ' +
          `of that major — re-verify that a release PR's head still starts with ` +
          "'release-please--' before updating this expectation."
      ).toBe('5');
    });
  });
});
