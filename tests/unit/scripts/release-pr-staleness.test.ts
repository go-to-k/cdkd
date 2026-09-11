import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

/**
 * `.github/workflows/release-pr-staleness.yml` — the check that disarms
 * auto-merge on a standing release PR that `main` has moved past.
 *
 * Why it exists rather than the `release-pr-not-stale` job in ci.yml doing the
 * whole job: a `pull_request` workflow does NOT re-run when the BASE branch
 * moves, so that job keeps whatever verdict it reached at the release PR's last
 * head push — and the hazard is precisely the case where release-please never
 * pushes again (a `chore:` commit produces no changelog entry, so the computed
 * release is unchanged and the PR is left on its original base).
 *
 * Why this suite EXECUTES the workflow's shell against real git repositories
 * and a stubbed `gh`: the whole check is six git/gh invocations, each of which
 * rots silently. Drop the `!` from `merge-base`, compare against the wrong ref,
 * invert the `armed` test — and it stops disarming anything while still exiting
 * 0 on every run, which is indistinguishable from "nothing was stale". A suite
 * that pattern-matched the YAML would certify that state.
 *
 * The four cases below are the whole decision table:
 *
 *   current + armed        -> leave alone
 *   stale   + armed        -> disable auto-merge, comment once
 *   stale   + NOT armed    -> no disable, no comment (nothing to disarm; the
 *                             auto_merge_enabled trigger catches it later)
 *   owned file has no history on main -> FAIL CLOSED, never a silent pass
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW = join(repoRoot, '.github', 'workflows', 'release-pr-staleness.yml');

const CHANGELOG = 'CHANGELOG.md';
const MANIFEST = '.release-please-manifest.json';
const RELEASE_BRANCH = 'release-please--branches--main';

const DISARM_STEP = 'disarm auto-merge on a release PR main has moved past';

interface StalenessWorkflow {
  on?: Record<string, { types?: unknown; branches?: unknown } | null>;
  jobs?: Record<
    string,
    {
      permissions?: unknown;
      steps?: { name?: string; uses?: string; run?: string; with?: Record<string, unknown> }[];
    }
  >;
}

function workflow(): StalenessWorkflow {
  return parseYaml(readFileSync(WORKFLOW, 'utf8')) as StalenessWorkflow;
}

/**
 * The `run:` body of the workflow's disarm step, taken from the file rather
 * than re-typed — a copy here would keep passing after the workflow's copy was
 * broken. Selected BY STEP NAME, so inserting a step ahead of it cannot
 * silently retarget the extractor.
 *
 * (The sibling repos read this as TEXT because they ship no YAML library, the
 * reason `release-please-v0.test.ts` records there. cdkd has `yaml`, and its
 * two other workflow fences already parse, so this one does too.)
 */
function disarmShell(): string {
  const step = workflow().jobs?.['disarm']?.steps?.find((s) => s.name === DISARM_STEP);
  expect(
    step?.run,
    `the \`${DISARM_STEP}\` step is gone from .github/workflows/release-pr-staleness.yml. ` +
      'If it was renamed, update this extractor; if it was REMOVED, restore it — a stale ' +
      'release PR could then auto-merge with nothing objecting.'
  ).toBeTruthy();
  return step?.run as string;
}

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function commit(repo: string, file: string, body: string, subject: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', subject);
  return git(repo, 'rev-parse', 'HEAD');
}

interface Run {
  status: number;
  output: string;
  /**
   * Every `gh` invocation's argv, space-joined. NOT one line per call — the
   * multi-line `--body` puts a call's own newlines in here too, so these are
   * safe to search with `.some(c => c.includes(...))` and unsafe to COUNT.
   */
  ghCalls: string[];
}

describe('release-pr-staleness', () => {
  let scratch: string;
  let seq = 0;

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cdkd-staleness-'));
  });

  /**
   * A repo whose `main` ends in a commit touching only `lastFile` and whose
   * release branch was cut BEFORE it (`stale: true`) or at the tip
   * (`stale: false`). Returns the working clone the shell runs in.
   *
   * `seedManifest: false` builds a history where the manifest never existed, so
   * the empty-tip branch is reached with the CHANGELOG arm able to pass.
   */
  function fixture(opts: {
    stale: boolean;
    armed: boolean;
    lastFile?: string;
    seedManifest?: boolean;
    noReleasePr?: boolean;
    /**
     * Open PRs the stub reports, BEFORE the workflow's jq filter. Supplying
     * this is what lets a case exercise the filter itself — a fork decoy whose
     * head branch carries the release prefix, or two same-repo matches.
     */
    openPrs?: { number: number; headRefName: string; isCrossRepository: boolean }[];
    /**
     * Raw stdout for the `autoMergeRequest` read, overriding `armed`. Lets a
     * case drive the answer the shell must FAIL CLOSED on — an empty string is
     * what a `gh` that exits 0 without the field would produce.
     */
    armedAnswer?: string;
  }): { cwd: string; ghLog: string; tip: string; binDir: string } {
    const id = `f${seq++}`;
    const origin = join(scratch, `${id}-origin`);
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, CHANGELOG), '# Changelog\n\n## 0.1.0\n');
    if (opts.seedManifest !== false) {
      writeFileSync(join(origin, MANIFEST), '{ ".": "0.1.0" }\n');
    }
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'chore(release): 0.1.0');
    const base = commit(origin, 'src.txt', 'work\n', 'feat: something');

    // The release branch, cut from `base` when stale and from the tip when not.
    // Its own commit touches a file release-please does NOT own, so the branch
    // is never an ancestor of main in either case — only the owned-file tips
    // decide, which is the property under test.
    const lastFile = opts.lastFile ?? CHANGELOG;
    const tip =
      lastFile === CHANGELOG
        ? commit(origin, CHANGELOG, '# Changelog\n\n## 0.1.0 (normalized)\n', 'chore(docs): normalize')
        : commit(origin, MANIFEST, '{ ".": "0.1.0-edited" }\n', 'chore: hand-edit the manifest');

    git(origin, 'checkout', '-q', '-b', RELEASE_BRANCH, opts.stale ? base : tip);
    commit(origin, 'RELEASE_NOTE.txt', 'release-please\n', 'chore(release): 0.1.1');
    git(origin, 'checkout', '-q', 'main');

    const bare = join(scratch, `${id}-remote.git`);
    execFileSync('git', ['clone', '-q', '--bare', origin, bare], {
      env: { ...process.env, ...GIT_ENV },
    });
    const cwd = join(scratch, `${id}-work`);
    execFileSync('git', ['clone', '-q', bare, cwd], { env: { ...process.env, ...GIT_ENV } });

    // `gh` stub: canned reads, recorded writes. Writing the log from the stub
    // (rather than inferring from stdout) is what lets a case assert that
    // `pr merge --disable-auto` was NOT called.
    const binDir = join(scratch, `${id}-bin`);
    mkdirSync(binDir);
    const ghLog = join(scratch, `${id}-gh.log`);
    // `pr list` runs the WORKFLOW'S OWN `--jq` expression through real `jq`
    // against a canned PR list, rather than returning a canned answer. The
    // filter is the thing under test — restricting to same-repo PRs is what
    // stops a fork decoy named `release-please--…` becoming the `[0]` this
    // picks — and a stub that answered `42` regardless would certify a filter
    // that had been deleted. (An earlier cut returned the raw JSON array,
    // ignoring `--jq` altogether; that is the same class one step further out.)
    const openPrs =
      opts.openPrs ??
      (opts.noReleasePr
        ? [{ number: 9, headRefName: 'feat/unrelated', isCrossRepository: false }]
        : [{ number: 42, headRefName: RELEASE_BRANCH, isCrossRepository: false }]);
    const ghStub = `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(ghLog)}
# Pull the --jq expression out of argv the way real gh consumes it.
filter=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--jq" ]; then filter="$a"; fi
  prev="$a"
done
case "$*" in
  *"pr list"*)        printf '%s' ${JSON.stringify(JSON.stringify(openPrs))} | jq -r "$filter" ;;
  *autoMergeRequest*) printf '%s' ${JSON.stringify(opts.armedAnswer ?? (opts.armed ? 'yes' : 'no'))} ;;
  *headRefName*)      printf '%s' ${JSON.stringify(RELEASE_BRANCH)} ;;
  *)                  : ;;
esac
`;
    const ghPath = join(binDir, 'gh');
    writeFileSync(ghPath, ghStub);
    chmodSync(ghPath, 0o755);

    return { cwd, ghLog, tip, binDir };
  }

  function run(fx: ReturnType<typeof fixture>): Run {
    const stubDir = fx.binDir;
    let status = 0;
    let output = '';
    try {
      output = execFileSync('bash', ['-c', disarmShell()], {
        cwd: fx.cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...GIT_ENV,
          PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
          GH_TOKEN: 'x',
          REPO: 'go-to-k/cdkd',
        },
        stdio: 'pipe',
      });
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      status = e.status ?? 1;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    let ghCalls: string[] = [];
    try {
      ghCalls = readFileSync(fx.ghLog, 'utf8').split('\n').filter(Boolean);
    } catch {
      ghCalls = [];
    }
    return { status, output, ghCalls };
  }

  const disarmed = (r: Run) => r.ghCalls.some((c) => c.includes('--disable-auto'));
  const commented = (r: Run) => r.ghCalls.some((c) => c.includes('pr comment'));

  /**
   * PR numbers the shell actually addressed — the argv token right after a
   * `pr view` / `pr merge` / `pr comment` verb.
   *
   * NOT a substring search over `ghCalls`. The comment's `--body` embeds commit
   * SHAs, so `c.includes('99')` is satisfied by any run whose fixture happened
   * to produce a SHA containing those digits — which passes in isolation and
   * fails under the full suite, since the SHAs differ with the commit
   * timestamps. Measured exactly that way.
   */
  const targetedPrs = (r: Run): string[] =>
    r.ghCalls.flatMap((c) => {
      const m = /^pr (?:view|merge|comment) (\d+)\b/.exec(c);
      return m ? [m[1] as string] : [];
    });

  it('leaves a current release PR alone', () => {
    const r = run(fixture({ stale: false, armed: true }));
    expect(r.status).toBe(0);
    expect(r.output).toContain('is current with main');
    expect(disarmed(r)).toBe(false);
    expect(commented(r)).toBe(false);
  });

  it('disarms and comments when main moved CHANGELOG.md past an armed PR', () => {
    const fx = fixture({ stale: true, armed: true });
    const r = run(fx);
    expect(r.status).toBe(0);
    expect(disarmed(r)).toBe(true);
    expect(commented(r)).toBe(true);
    expect(r.output).toContain(CHANGELOG);
    expect(r.output).toContain(fx.tip);
  });

  it('disarms when main moved the MANIFEST past an armed PR', () => {
    // Without this, gating the ancestry test on `[ "${f}" = "CHANGELOG.md" ]`
    // survives the suite and the manifest arm never discriminates.
    const fx = fixture({ stale: true, armed: true, lastFile: MANIFEST });
    const r = run(fx);
    expect(disarmed(r)).toBe(true);
    expect(r.output).toContain(MANIFEST);
    expect(r.output).not.toContain(`${CHANGELOG} (main:`);
  });

  it('does not comment on a stale PR that is not armed', () => {
    // There is nothing to disarm, and a comment on every push to main would
    // bury the signal. The auto_merge_enabled trigger catches it later.
    const r = run(fixture({ stale: true, armed: false }));
    expect(r.status).toBe(0);
    expect(disarmed(r)).toBe(false);
    expect(commented(r)).toBe(false);
    expect(r.output).toContain('not armed');
  });

  it('does nothing when no release PR is open', () => {
    const r = run(fixture({ stale: true, armed: true, noReleasePr: true }));
    expect(r.status).toBe(0);
    expect(r.output).toContain('No standing release PR');
    expect(disarmed(r)).toBe(false);
  });

  it('ignores a FORK PR whose head branch carries the release prefix', () => {
    // `gh pr list` includes fork PRs and orders newest-first, and a fork's head
    // branch NAME is attacker-chosen. Without the same-repo filter, a decoy
    // named `release-please--branches--main` becomes the `[0]` the shell picks:
    // `armed` is then read off the DECOY (not armed), the run exits 0 saying
    // "not armed", and the real armed, stale release PR is never checked and
    // merges. Pushing a branch to THIS repo needs write access, which is what
    // the filter buys.
    const fx = fixture({
      stale: true,
      armed: true,
      openPrs: [
        // Newest first, as gh returns them.
        { number: 99, headRefName: RELEASE_BRANCH, isCrossRepository: true },
        { number: 42, headRefName: RELEASE_BRANCH, isCrossRepository: false },
      ],
    });
    const r = run(fx);
    expect(r.status).toBe(0);
    // The real PR is the one acted on — not the decoy.
    expect(disarmed(r)).toBe(true);
    expect(targetedPrs(r)).toContain('42');
    expect(targetedPrs(r)).not.toContain('99');
  });

  it('refuses rather than guessing when two same-repo release PRs are open', () => {
    // Picking one would leave the other unchecked and still exit 0 — the
    // silent-pass shape this whole workflow exists to remove.
    const r = run(
      fixture({
        stale: true,
        armed: true,
        openPrs: [
          { number: 43, headRefName: `${RELEASE_BRANCH}--components--x`, isCrossRepository: false },
          { number: 42, headRefName: RELEASE_BRANCH, isCrossRepository: false },
        ],
      })
    );
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('found 2 open same-repo release PRs');
    expect(disarmed(r)).toBe(false);
  });

  it('fails closed when the auto-merge state cannot be read', () => {
    // A `gh` that exits 0 with empty stdout — a schema change dropping
    // `autoMergeRequest`, or a build without the field — used to fall through
    // to the no-op branch and exit 0, which is indistinguishable from a
    // genuinely unarmed PR. That retires the whole check silently.
    const r = run(fixture({ stale: true, armed: true, armedAnswer: '' }));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('could not read auto-merge state');
    expect(disarmed(r)).toBe(false);
  });

  it('fails closed when an owned file has no history on main', () => {
    // "Cannot answer" must not read as "found nothing wrong": a rename would
    // otherwise silence this check forever, and it is the last line of defence.
    const r = run(fixture({ stale: false, armed: true, seedManifest: false }));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('cannot evaluate staleness');
    expect(r.output).toContain(MANIFEST);
    expect(disarmed(r)).toBe(false);
  });

  describe('the workflow wiring', () => {
    const yml = () => readFileSync(WORKFLOW, 'utf8');

    it('fires both when main moves and when auto-merge is armed', () => {
      // Neither trigger alone is enough. `push` misses a PR armed AFTER main
      // moved — the common case, since a release PR can sit for days — and
      // `auto_merge_enabled` misses main moving under an already-armed PR.
      expect(yml()).toContain('types: [auto_merge_enabled]');
      expect(yml()).toMatch(/push:\s*\n\s*branches: \[main\]/);
    });

    it('can actually disarm', () => {
      // `gh pr merge --disable-auto` needs pull-requests: write, and a
      // `pull_request` token is read-only for forks — which is why the trigger
      // is `pull_request_target`.
      expect(yml()).toContain('pull_request_target:');
      expect(yml()).toContain('pull-requests: write');
    });

    it('checks out full history and no head code', () => {
      // `rev-list -1 <ref> -- <path>` needs the commits that touched each file;
      // and this workflow must never execute head-controlled content.
      expect(yml()).toContain('fetch-depth: 0');
      expect(yml()).toContain('persist-credentials: false');
      // The realistic regression on a `pull_request_target` workflow is not the
      // one exact expression — it is ANY head reference reaching the checkout
      // or a shell, `github.head_ref` and `…head.ref` included. The PR number
      // and head ref are read back through `gh` precisely so none of them
      // appears here.
      expect(yml()).not.toMatch(/github\.(event\.pull_request\.head|head_ref)/);
    });

    it('checks exactly the files release-please owns', () => {
      const m = /^for f in (.+); do$/m.exec(disarmShell());
      expect(m, "the check's `for f in ...; do` loop is gone").not.toBeNull();
      expect((m as RegExpExecArray)[1]!.trim().split(/\s+/).sort()).toEqual(
        [CHANGELOG, MANIFEST].sort()
      );
    });
  });
});
