/**
 * Issue [#2718](https://github.com/go-to-k/cdkd/issues/2718) — invariants of
 * `.github/workflows/cfn-schema-refresh.yml`, the repo's first scheduled
 * workflow and its first PR-opening one.
 *
 * A workflow is the one artifact here with no local run to catch a mistake: it
 * executes daily, unattended, with `contents: write`, and a defect surfaces
 * as a wrong or missing PR that nobody is watching for. So the properties that are
 * load-bearing rather than cosmetic are pinned, and each case below says which
 * failure it is about.
 *
 * The file is read BOTH ways, because each view is blind where the other sees.
 * TEXT (matching `release-please-v0.test.ts` and `pr-inherit-issue-labels.test.ts`)
 * is right for the literal shell and the literal `uses:` pins, which YAML
 * flattens into an opaque string. STRUCTURE is right for step wiring: a
 * text-only suite passes when a whole step is deleted, and passes when the two
 * `if:` polarities are swapped so the job refreshes only while a PR is already
 * open — both silent, both leaving the job to simply stop opening PRs on a
 * cadence nobody watches. An earlier revision of this file was text-only and
 * had exactly those two holes.
 */
import { describe, it, expect } from 'vite-plus/test';
import { CHECK_GUIDANCE } from '../../../scripts/diagnose-schema-refresh.mjs';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'cfn-schema-refresh.yml');
const VITE_CONFIG_PATH = join(REPO_ROOT, 'vite.config.ts');

const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
/**
 * The same file as STRUCTURE. Both views are kept: the text one asserts the
 * literal shell (which YAML flattens into an opaque string), the parsed one
 * asserts step wiring (which text cannot see at all).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parsed: any = parseYaml(workflow);

  const steps: Array<{
    name?: string;
    if?: string;
    run?: string;
    uses?: string;
    env?: Record<string, string>;
  }> =
    parsed.jobs.refresh.steps;
  const byName = (name: string) => {
    const step = steps.find((s) => s.name === name);
    expect(step, `no step named ${JSON.stringify(name)} — it was renamed or deleted`).toBeDefined();
    return step!;
  };

  /**
   * A step's shell with `#` comment lines removed. Load-bearing for the
   * NEGATIVE assertions below: this workflow's comments deliberately QUOTE
   * the wrong forms in order to explain why they are wrong (`git diff
   * --quiet`, a bare `--force-with-lease`), so a naive `not.toContain` reads
   * the explanation as the defect and fails on correct code.
   */
  const shellOf = (name: string) =>
    byName(name)
      .run!.split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');

/**
 * The task the workflow invokes to do the capture. Named here as a literal
 * rather than derived from the workflow, so a rename must be made in both
 * places deliberately.
 */
const REFRESH_TASK = 'gen:cfn-schemas-from-zip';

/** The branch namespace the job creates AND the one its skip-guard looks for. */
const BRANCH_PREFIX = 'bot/cfn-schema-refresh/';

describe('cfn-schema-refresh workflow (issue #2718)', () => {
  it('is not vacuous — the file exists and has real content', () => {
    expect(workflow.length).toBeGreaterThan(2000);
  });

  it('runs daily on a schedule AND is manually dispatchable', () => {
    // The schedule is the whole mechanism; `workflow_dispatch` is the reactive
    // path for a mid-cycle user report, the recovery path if GitHub suspends
    // the schedule on an inactive repo, and the only way to exercise the job
    // before its first scheduled fire.
    expect(workflow).toMatch(/^\s*schedule:$/m);
    expect(workflow).toMatch(/^\s*workflow_dispatch:$/m);
    // The cron is pinned LITERALLY. A `"[^"]+"` shape assertion accepts
    // `* * * * *`, i.e. a job firing every minute with `contents: write` —
    // and would read as green.
    expect(parsed.on.schedule).toEqual([{ cron: '37 4 * * *' }]);
  });

  /**
   * Parsed as YAML, unlike the assertions above. The text form cannot see
   * STRUCTURE: it happily passes when a whole step is deleted, or when the two
   * `if:` conditions are swapped so the job runs the refresh only while a PR
   * is already open and comments only when none is. Both are silent — the job
   * simply stops opening PRs, on a cadence nobody is watching.
   */
  describe('step wiring', () => {
    it('refreshes and probes drift UNCONDITIONALLY, gating only the publish', () => {
      // Load-bearing since the job stopped skipping: an open PR must not stop
      // the refresh, or every new AWS addition waits for that PR to merge —
      // and the PR that stays open longest is the RED one, exactly the window
      // where waiting costs most.
      for (const name of ['Refresh fixtures from the public schema bundle', 'Detect drift']) {
        expect(byName(name).if).toBeUndefined();
      }
      for (const name of [
        'Regenerate the derived artifacts',
        'Diagnose what needs a decision',
        'Publish the refresh',
      ]) {
        expect(byName(name).if).toBe("steps.drift.outputs.drifted == 'true'");
      }
    });

    it('switches onto the open PR branch only when one is open', () => {
      expect(byName("Switch to the open refresh PR's branch").if).toBe(
        "steps.open_pr.outputs.number != ''"
      );
    });

    it('pushes onto an open PR ADDITIVELY — never forcing over a human commit', () => {
      const publish = shellOf('Publish the refresh');
      expect(publish).toContain('${existing_branch}');
      expect(publish).toMatch(/recomputes the same drift/);
      // Sliced STRUCTURALLY, not matched on one line. The earlier assertion was
      // `/force[^\n]*\$\{existing_branch\}/`, and the real push is
      // line-continued — so the mutation it existed to catch (adding `--force`
      // to the existing-branch push) put the two tokens on different lines and
      // the test stayed green.
      const armStart = publish.indexOf('if [ -n "${existing_branch');
      // Indentation-agnostic: the YAML block scalar strips the common indent,
      // so the `else` arrives at two spaces, not ten.
      const armEnd = publish.slice(armStart).search(/\n\s*else\s*\n/) + armStart;
      expect(armStart, 'existing-branch arm not found').toBeGreaterThanOrEqual(0);
      expect(armEnd, 'existing-branch arm has no else').toBeGreaterThan(armStart);
      expect(publish.slice(armStart, armEnd)).not.toContain('force');
    });

    it('posts the diagnosis, on a new PR and on an updated one alike', () => {
      const publish = shellOf('Publish the refresh');
      // The diagnosis runs in its OWN step, before the token-holding one — it
      // spawns npm, which inherits the environment.
      const diagnose = shellOf('Diagnose what needs a decision');
      expect(diagnose).toContain('diagnose-schema-refresh.mjs');
      expect(publish).not.toContain('diagnose-schema-refresh.mjs');
      const order = steps.map((st) => st.name);
      expect(order.indexOf('Diagnose what needs a decision')).toBeLessThan(
        order.indexOf('Publish the refresh')
      );
      // Anchored to the COMMENT's own body file. `--body-file` alone was
      // satisfied by the create path, so swapping the comment to `--body "x"`
      // stayed green.
      expect(publish).toMatch(/gh pr comment[\s\S]{0,120}--body-file \/tmp\/diagnosis\.md/);
      expect(publish).toContain('--body-file /tmp/pr-body.md');
    });

    it('folds new writable properties into the backfill umbrella without failing the job', () => {
      const publish = shellOf('Publish the refresh');
      expect(publish).toContain('gh issue comment');
      // The PR is the load-bearing output; losing it because an issue comment
      // failed would be the wrong trade, and the list is in the PR body too.
      expect(publish).toMatch(/gh issue comment[\s\S]*?\|\|/);
    });

    it('keeps the drift probe between the refresh and the regeneration', () => {
      const order = steps.map((s) => s.name).filter(Boolean) as string[];
      expect(order.indexOf('Refresh fixtures from the public schema bundle')).toBeLessThan(
        order.indexOf('Detect drift')
      );
      expect(order.indexOf('Detect drift')).toBeLessThan(
        order.indexOf('Regenerate the derived artifacts')
      );
      expect(order.indexOf('Regenerate the derived artifacts')).toBeLessThan(
        order.indexOf('Publish the refresh')
      );
    });

    it('checks out WITHOUT persisting the write-scoped token', () => {
      const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@')) as
        | { with?: Record<string, unknown> }
        | undefined;
      expect(checkout, 'no checkout step found').toBeDefined();
      expect(checkout!.with?.['persist-credentials']).toBe(false);
    });

    it('filters the open-PR guard to branches in THIS repo, not forks', () => {
      // Without the owner filter any GitHub user can permanently disable this
      // job by opening a never-closed fork PR whose head branch matches the
      // bot prefix.
      const guard = byName('Look for an open refresh PR');
      expect(guard.run).toContain('headRepositoryOwner');
      expect(guard.run).toContain('github.repository_owner');
    });

    it('detects drift with a form that SEES untracked files, and fails closed', () => {
      const drift = shellOf('Detect drift');
      // `git diff --quiet` is blind to untracked files, so a newly-registered
      // type's brand-new fixture would be captured and then discarded.
      expect(drift).toContain('git status --porcelain');
      expect(drift).not.toContain('git diff --quiet');
      // Assigned on its own line: `set -e` does not fire inside an `if`
      // condition, so the inline `$( )` form swallows a git failure as
      // "no drift" — fail-open, which is what the sibling guard refuses.
      expect(drift).toMatch(/changes=\$\(git status --porcelain/);
      expect(drift).toContain('set -euo pipefail');
    });

    it('regenerates under set -e so a failed generator cannot open a half-done PR', () => {
      expect(byName('Regenerate the derived artifacts').run).toContain('set -euo pipefail');
    });

    it('pushes with an EXPLICIT token, since credentials are not persisted', () => {
      const push = shellOf('Publish the refresh');
      expect(push).toContain('x-access-token:${GH_TOKEN}');
      // A bare `git push origin` would fail: the checkout persists no auth.
      expect(push).not.toMatch(/git push\s+origin\s/);
    });

    it('re-dispatch uses the EXPLICIT force-with-lease form, not the bare one', () => {
      // A bare `--force-with-lease` compares against a remote-TRACKING ref,
      // and there is none here (checkout fetches one ref at depth 1; the push
      // target is an anonymous URL). Git then expects the branch NOT to exist
      // — while `force` is set only when ls-remote proved it does — so the
      // push is rejected `(stale info)` in exactly the case it exists for.
      const push = shellOf('Publish the refresh');
      expect(push).toContain('--force-with-lease=refs/heads/');
      expect(push).not.toMatch(/--force-with-lease(?!=)/);
    });

    it('searches a window wide enough that unrelated PRs cannot hide the bot PR', () => {
      // Read through `shellOf`, NOT the raw `run`. The earlier version of this
      // case asserted `run` contained `--author` and was VACUOUS: the workflow
      // COMMENT mentions the flag, so deleting the actual flag left it green —
      // exactly the class `shellOf` exists for, and the one assertion that
      // skipped it.
      const guard = shellOf('Look for an open refresh PR');
      expect(guard).toContain('--limit 1000');
      // `--author` is deliberately absent: it routes gh through the
      // eventually-consistent GraphQL search connection, so a just-created PR
      // can be missing and the guard fails OPEN.
      expect(guard).not.toContain('--author');
    });


    it('stamps the branch per DAY, matching the daily cadence', () => {
      // The branch name IS the cycle's identity. At a daily cadence a
      // month-granular stamp would make every run after the first in a month
      // collide with an existing branch, sending each one down the
      // force-with-lease recovery path for no reason.
      // Anchored on the CYCLE assignment and the branch it builds, not on any
      // `date -u +%Y-%m-%d` in the step — the commit messages carry one too, so
      // a regression of `cycle=` back to `%Y-%m` left the old assertion green.
      const publish = shellOf('Publish the refresh');
      expect(publish).toContain('cycle=$(date -u +%Y-%m-%d)');
      expect(publish).toContain('branch="bot/cfn-schema-refresh/${cycle}"');
    });

    it('keeps the write-scoped token out of the checker and the diagnosis', () => {
      // The diagnosis spawns `npm`, which inherits the environment; running it
      // in the step that holds `contents: write` widens exactly the surface
      // `persist-credentials: false` was added to close.
      const diagnose = steps.find((st) => st.name === 'Diagnose what needs a decision')!;
      expect(diagnose.env, 'the diagnosis step must hold no token').toBeUndefined();
    });

    it('sets pipefail on the tee\u2019d refresh, or the exit code is lost', () => {
      // `run:` with no `shell:` is `bash -e {0}` — NOT pipefail. Without this
      // the `tee` added for the skip list reports ITS status, and the refresh's
      // exit 2 on a capture failure becomes "no drift" and a green run.
      const refresh = shellOf('Refresh fixtures from the public schema bundle');
      // Position, not presence: the token appearing anywhere in the step is
      // satisfied by a `set -o pipefail` written AFTER the pipeline, which
      // protects nothing. Measured — moving it below the `tee` left this green.
      const pipefailAt = refresh.indexOf('set -o pipefail');
      const teeAt = refresh.indexOf('tee /tmp/refresh.log');
      expect(teeAt, 'the tee\u2019d refresh is gone \u2014 this case guards nothing').toBeGreaterThan(-1);
      expect(pipefailAt, 'no pipefail in the refresh step').toBeGreaterThan(-1);
      expect(pipefailAt, 'pipefail is set AFTER the pipeline it must guard').toBeLessThan(teeAt);
    });

    it('gives every step that runs a pipeline a pipefail before it', () => {
      // The generalisation of the defect above, so the next pipeline added to
      // any step cannot reintroduce it silently.
      // Through `shellOf`, not raw `run`: the Refresh step's own comment says
      // "`set -o pipefail` is REQUIRED here", which put the token at index 10
      // and left this case green with the real `set -o pipefail` DELETED. That
      // is the exact vacuity `shellOf` exists to remove.
      for (const step of steps) {
        if (!step.name || !step.run) continue;
        const shell = shellOf(step.name);
        const pipeAt = shell.search(/\S \| \S|\|\s*\n/);
        if (pipeAt === -1) continue;
        const at = shell.indexOf('pipefail');
        expect(at, `${step.name}: runs a pipeline with no pipefail`).toBeGreaterThan(-1);
        expect(at, `${step.name}: pipefail is set after its first pipeline`).toBeLessThan(pipeAt);
      }
    });

    it('fails the step when a push failure is NOT a lost race', () => {
      // A permission or branch-protection failure must not share the lost-race
      // green exit, or the daily job lands nothing forever while reporting
      // success.
      const publish = shellOf('Publish the refresh');
      // The RELATION, not the tokens. Inverting the comparison — so a real
      // permission failure exits 0 and a real lost race exits 1, precisely the
      // defect — left the token-presence form green, as did blanking the
      // baseline entirely.
      expect(publish).toMatch(/if \[ -n "\$\{now\}" \] && \[ "\$\{now\}" != "\$\{base_sha\}" \]; then/);
      const raceAt = publish.search(/::warning::Could not push/);
      const errAt = publish.search(/::error::Push to/);
      expect(raceAt).toBeGreaterThan(-1);
      expect(errAt).toBeGreaterThan(raceAt);
      // The lost-race arm exits 0 INSIDE the moved-tip branch; the hard failure
      // is the fall-through.
      expect(publish.slice(raceAt, errAt)).toMatch(/exit 0/);
      expect(publish.slice(errAt)).toMatch(/exit 1/);
    });

    it('takes the push baseline from the LOCAL base, not a remote read', () => {
      // Reading the remote just before pushing samples it AFTER a concurrent
      // human push, so the post-failure comparison finds the tip "unmoved" and
      // calls a real lost race "not a lost race", exiting 1. The base the
      // commit was built on is what a non-fast-forward is relative to.
      const publish = shellOf('Publish the refresh');
      expect(publish).toContain('base_sha=$(git rev-parse HEAD)');
      const baseAt = publish.indexOf('base_sha=$(git rev-parse HEAD)');
      const commitAt = publish.indexOf('git commit -m "chore(schemas): additional');
      expect(commitAt).toBeGreaterThan(-1);
      expect(baseAt, 'the baseline is captured after the commit it describes').toBeLessThan(
        commitAt
      );
      expect(publish, 'the baseline is still read off the remote').not.toMatch(
        /base_sha=\$\(git ls-remote/
      );
    });

    it('guards the umbrella comment\u2019s PR link on the number having resolved', () => {
      // The comment itself is deliberately unguarded — the list is worth posting
      // even when the number lookup failed. What must be guarded is the LINK,
      // which would otherwise read `pull/` and point at the repo's PR index.
      const publish = shellOf('Publish the refresh');
      const guardAt = publish.search(/if \[ -n "\$\{pr_number:?-?\}" \]/);
      const linkAt = publish.indexOf('/pull/${pr_number}');
      expect(guardAt, 'the PR link is emitted with no PR-number guard').toBeGreaterThan(-1);
      expect(linkAt).toBeGreaterThan(-1);
      expect(guardAt).toBeLessThan(linkAt);
      // And the comment still fires outside that guard.
      expect(publish.indexOf('${BACKFILL_UMBRELLA}')).toBeGreaterThan(linkAt);
    });

    it('passes the checker’s EXIT CODE, not only its output', () => {
      // Text alone was not enough: an empty log, a `task not found` and an OOM
      // kill all carry no announcement to grep for, and each rendered
      // "additions only" over a checker that never ran.
      const diagnose = shellOf('Diagnose what needs a decision');
      expect(diagnose).toContain('nested_key_rc=$?');
      // The VARIABLE, not just the flag: `--nested-key-rc 0` hard-coded would
      // satisfy a bare flag-presence check while restoring the behaviour the
      // flag exists to remove, and the script's absent-flag arm defaults to 0
      // for the by-hand invocation.
      expect(diagnose).toMatch(/--nested-key-rc "\$\{nested_key_rc\}"/);
      // Captured immediately after the invocation: any command in between
      // overwrites `$?` and the status becomes that command's.
      const lines = diagnose.split('\n').map((l) => l.trim());
      const runAt = lines.findIndex((l) => l.startsWith('vp run audit:nested-key-coverage:check'));
      expect(runAt).toBeGreaterThan(-1);
      expect(lines[runAt + 1], '$? is captured after some other command ran').toBe(
        'nested_key_rc=$?'
      );
    });

    it('collects EVERY fixture-driven check, and the guidance table knows them all', () => {
      // The list lives in the workflow and the guidance in the script, with
      // nothing joining them — which is how `sdk-attr-coverage` and
      // `enrichment-coverage` went unreported for eight rounds while
      // `property-coverage` was being fixed. A fourth check added to one side
      // and not the other fails here.
      const regen = shellOf('Regenerate the derived artifacts');
      const collected = [...regen.matchAll(/^\s*run_check (\S+)/gm)].map((m) => m[1]!);
      expect(collected.length, 'no run_check invocations found').toBeGreaterThanOrEqual(3);
      expect(new Set(collected)).toEqual(new Set(Object.keys(CHECK_GUIDANCE)));
      // And each one really is fixture-driven — the property that makes a
      // schema refresh able to redden it.
      for (const check of collected) {
        const task = check.replace(/^audit:/, '').replace(/:check$/, '');
        const script = ['gen-' + task + '.ts', task + '.ts'].find((f) =>
          existsSync(join(REPO_ROOT, 'scripts', f))
        );
        if (!script) continue; // property-coverage is a vitest run, not a script.
        expect(
          readFileSync(join(REPO_ROOT, 'scripts', script), 'utf8'),
          `${check} does not read the fixtures — why is it in this list?`
        ).toContain('cfn-schemas');
      }
    });

    it('covers every suite asserting silentDrop is empty, and every filter matches something', () => {
      // BOUND, stated because an over-claimed fence is what this PR keeps
      // producing: the derivation keys on ONE assertion spelling
      // (`silentDrop.keys() ... toEqual([])`). The two named non-family filters
      // are hand-listed and unfenced, and `gen-sdk-attr-coverage.test.ts`'s
      // `findGaps(report)).toEqual([])` is zero-headroom in a different shape —
      // substantively covered, since `audit:sdk-attr-coverage:check` runs the
      // same predicate and is its own `run_check`, but invisible here.
      // Five suites assert `silentDrop` is empty against the REAL coverage, so
      // one writable property AWS adds to any of their types reds CI — while
      // `property-coverage` under `CDKD_GENERATE_BACKFILL` absorbs the same
      // addition and stays green. Naming one of them covered three files of the
      // five. The family is DERIVED here so a sixth cannot be added silently.
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
        );
      // `tests/**` AND `src/**` — vitest's include covers both, and walking
      // `tests/unit` alone would miss a family member added anywhere else.
      const testFiles = [
        ...walk(join(REPO_ROOT, 'tests')),
        ...walk(join(REPO_ROOT, 'src')),
      ].filter((f) => f.endsWith('.test.ts'));
      const zeroHeadroom = testFiles.filter(
        (f) =>
          // This file CONTAINS the pattern, as the literal doing the matching —
          // widening the walk to all of `tests/**` made the fence derive itself.
          f !== fileURLToPath(import.meta.url) &&
          /silentDrop\.keys\(\)[\s\S]{0,80}?toEqual\(\[\]\)/.test(readFileSync(f, 'utf8'))
      );
      expect(
        zeroHeadroom.length,
        'no zero-headroom suite found — the derivation broke, not the coverage'
      ).toBeGreaterThanOrEqual(5);

      const regen = shellOf('Regenerate the derived artifacts');
      // Line continuations joined first: the invocation is written across two
      // lines, so a naive per-line match finds only the `run_check` half.
      const flat = regen
        .replace(/\\\n\s*/g, ' ')
        .split('\n')
        .map((l) => l.trim())
        .join('\n');
      const line = flat.match(/run_check fixture-consumer-tests\s+vp test run ([^\n]*)/);
      expect(line, 'the fixture-consumer run_check is gone').not.toBeNull();
      const filters = line![1]!.trim().split(/\s+/).filter(Boolean);

      for (const file of zeroHeadroom) {
        const rel = file.slice(REPO_ROOT.length + 1);
        expect(
          filters.some((needle) => rel.includes(needle)),
          `${rel} asserts zero headroom and no filter selects it`
        ).toBe(true);
      }

      for (const needle of filters) {
        // A leading dash is parsed as a FLAG, not a filter: `-props` killed the
        // whole step with `Unknown option \`-p\``, and the substring check below
        // passed it happily — the filter matched the filenames it was never
        // going to be given to vitest as.
        expect(
          needle.startsWith('-'),
          `filter ${JSON.stringify(needle)} starts with a dash — vitest reads it as a flag`
        ).toBe(false);
      }

      // The GUIDANCE BODY must hand out these same filters. Nothing fenced a
      // row's contents — only the key SET — so round 10 widened the workflow
      // and left the rendered command naming three files of eleven: a red from
      // one of the four uncovered family members printed a paste-able command
      // that comes back GREEN. The report's own silence, inside the fix for it.
      const guidance = CHECK_GUIDANCE['fixture-consumer-tests']!;
      const inGuidance = guidance
        .join('\n')
        .split('\n')
        .map((l) => l.replace(/\\$/, '').trim())
        .filter((l) => l !== '' && !l.startsWith('```') && !l.startsWith('vp test run'));
      for (const needle of filters) {
        expect(
          inGuidance,
          `the rendered command omits ${JSON.stringify(needle)} — it will come back green`
        ).toContain(needle);
      }
      // And no EXTRA filter in the guidance either: one the workflow does not
      // run is a command whose red the job never collected.
      const guidanceFilters = inGuidance.filter((l) => !l.includes(' '));
      expect(new Set(guidanceFilters)).toEqual(new Set(filters));

      // And a filter matching NOTHING is a silent narrowing: vitest ignores a
      // non-matching positional when others match, so renaming a file removes
      // its coverage with no red anywhere.
      for (const needle of filters) {
        expect(
          testFiles.some((f) => f.slice(REPO_ROOT.length + 1).includes(needle)),
          `filter ${JSON.stringify(needle)} matches no test file`
        ).toBe(true);
      }
    });

    it('carries the failed-check list ACROSS steps', () => {
      // `|| echo` stops `set -e` aborting and nothing else, so the red never
      // reached the diagnosis — a failing coverage check rendered as "nothing
      // needs a decision". Two separate mistakes are pinned here: `$?` after a
      // `||` compound is the ECHO's status, and a shell variable does not
      // survive into the next `run:` at all.
      const regen = shellOf('Regenerate the derived artifacts');
      // A shell variable does not survive into the next `run:` at all, and an
      // absent `--failed-checks` reads as "nothing failed" — so losing it here
      // restores the exact silence this mechanism removes.
      expect(regen, 'the list dies with this step\u2019s shell').toMatch(
        /echo "FAILED_CHECKS=\$\{failed_checks\}" >> "\$\{GITHUB_ENV\}"/
      );
      const diagnose = shellOf('Diagnose what needs a decision');
      expect(diagnose).toMatch(/--failed-checks "\$\{FAILED_CHECKS\}"/);
    });

    it('pins the cross-file literals the shell greps for', () => {
      // Producer and consumer live in different files with nothing joining
      // them: either reword silently empties the skip list or kills the
      // umbrella fold, with no failure anywhere.
      const diagnose = shellOf('Diagnose what needs a decision');
      expect(readFileSync(join(REPO_ROOT, 'scripts/refresh-cfn-schemas.mjs'), 'utf8')).toContain(
        'No entry in the public bundle'
      );
      expect(diagnose).toContain('No entry in the public bundle');
      const heading = '### Writable properties AWS added';
      expect(
        readFileSync(join(REPO_ROOT, 'scripts/diagnose-schema-refresh.mjs'), 'utf8')
      ).toContain(heading);
      expect(shellOf('Publish the refresh')).toContain(heading);
    });

    it('names the backfill umbrella issue explicitly', () => {
      // A typo here posts the backfill list to an unrelated issue, silently.
      const publish = steps.find((st) => st.name === 'Publish the refresh')!;
      expect(publish.env?.['BACKFILL_UMBRELLA']).toBe('609');
    });

    it('re-checks the PR is still OPEN before pushing onto its branch', () => {
      // A squash merge with --delete-branch between the guard and the push
      // would make the plain push RE-CREATE the deleted branch — an orphan ref
      // with no PR, the class this repo has a dedicated hook for.
      const publish = shellOf('Publish the refresh');
      expect(publish).toContain('--json state');
      expect(publish).toMatch(/!= "OPEN"/);
      // The `exit 0` is the check. Without it the comparison runs and the push
      // proceeds anyway — inert, and the plain push then RE-CREATES the branch
      // a merge just deleted.
      const stateIdx = publish.indexOf('--json state');
      const pushIdx = publish.indexOf('git push');
      expect(stateIdx).toBeGreaterThanOrEqual(0);
      expect(stateIdx, 'the OPEN re-check must precede the push').toBeLessThan(pushIdx);
      expect(publish.slice(stateIdx, pushIdx)).toContain('exit 0');
    });

    it('passes the refresh skip list to the diagnosis', () => {
      // The flag existed and nothing passed it, so the "Not refreshed" section
      // could never render in production.
      expect(shellOf('Refresh fixtures from the public schema bundle')).toContain('/tmp/refresh.log');
      expect(shellOf('Diagnose what needs a decision')).toContain('--skipped-log');
    });

    it('fails the open-PR guard closed rather than open on a gh error', () => {
      // Without `set -e`, a gh transport failure leaves the output empty, which
      // reads as "no open PR" and opens a competing one.
      expect(byName('Look for an open refresh PR').run).toContain('set -euo pipefail');
    });
  });

  it('invokes the capture through the Vite+ task, and that task exists', () => {
    // A hand-rolled `node scripts/...` line here would drift from the task
    // definition silently; going through `vp run` means one source of truth.
    expect(workflow).toContain(`vp run ${REFRESH_TASK}`);
    expect(
      readFileSync(VITE_CONFIG_PATH, 'utf8'),
      `${REFRESH_TASK} is invoked by the workflow but not registered in vite.config.ts`
    ).toContain(`'${REFRESH_TASK}'`);
  });

  /**
   * The highest-value invariant in this file. The prefix appears TWICE — the
   * guard that looks for an already-open refresh PR, and the branch the job
   * creates. If they drift apart the guard silently stops matching, every cycle
   * opens another PR, and each one races the human classifying the last.
   */
  it('creates its branch in the SAME namespace its open-PR guard searches', () => {
    const occurrences = workflow.split(BRANCH_PREFIX).length - 1;
    expect(
      occurrences,
      `expected the ${BRANCH_PREFIX} prefix in both the open-PR guard and the ` +
        'branch construction; a drift between them lets every cycle open a new PR'
    ).toBeGreaterThanOrEqual(2);
    expect(workflow).toContain(`startswith("${BRANCH_PREFIX}")`);
    expect(workflow).toContain(`branch="${BRANCH_PREFIX}`);
  });

  it('UPDATES an open refresh PR rather than skipping the cycle', () => {
    // This replaced a case asserting the opposite. Skipping was the original
    // design, on the reasoning that a bot push would destroy a human's
    // classification commits — but everything the job rewrites is derived and
    // recomputed, and `bogusTolerated` is explicitly preserved across
    // regeneration, so an additive push reflects that work rather than undoing
    // it. Skipping cost most exactly where it hurt: a RED PR stays open
    // longest, holding back every new AWS addition behind it.
    expect(workflow).toContain("steps.open_pr.outputs.number != ''");
    expect(workflow).toContain('existing_branch');
    expect(workflow).not.toContain('Note the skipped cycle');
  });

  /**
   * `chore(` produces no changelog section under release-please's conventional
   * commit rules, so the bot's commits never open or advance the standing
   * release PR. Same reasoning as `.github/dependabot.yml`'s prefix choice.
   */
  it('commits and titles with a chore( prefix so it cannot advance the release PR', () => {
    expect(workflow).toMatch(/git commit -m "chore\(/);
    expect(workflow).toMatch(/--title "chore\(/);
    expect(workflow).not.toMatch(/git commit -m "(feat|fix|perf)\(/);
  });

  it('RUNS the regenerate step with every check red, and still reaches the end', () => {
    // Executed, not pattern-matched. Two rewrites of this case pinned a
    // SPELLING — first `||`, then `||`-or-`if` — and each time a rewrite that
    // preserved the invariant reddened it. The invariant is behavioural: under
    // `set -euo pipefail` a failing check must not abort the step, and every
    // failure must reach `$GITHUB_ENV`. So the real shell runs, with the four
    // commands it invokes stubbed.
    const shell = shellOf('Regenerate the derived artifacts');
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-regen-'));
    try {
      const envFile = join(dir, 'github-env');
      // Fails the CHECKS only. A stub that failed everything would abort on
      // `gen:all-matrices` instead — which is correct behaviour and would have
      // made this case pass for the wrong reason. The pattern covers the audit
      // tasks AND every `vp test run` filter: naming one filter left the newest
      // check passing and the set assertion caught it.
      const vp = [
        '#!/bin/sh',
        'case "$*" in',
        '  *audit:*:check|*"test run"*) exit 1 ;;',
        '  *) exit 0 ;;',
        'esac',
      ].join('\n');
      writeFileSync(join(dir, 'vp'), `${vp}\n`, { mode: 0o755 });
      // `env VAR=x vp ...` — drop the assignments and re-exec.
      writeFileSync(
        join(dir, 'env'),
        '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in *=*) shift ;; *) break ;; esac; done\nexec "$@"\n',
        { mode: 0o755 }
      );
      writeFileSync(
        join(dir, 'run.sh'),
        `export PATH="${dir}:$PATH"\nexport GITHUB_ENV="${envFile}"\n${shell}\necho REACHED_END\n`
      );
      const out = execFileSync('bash', [join(dir, 'run.sh')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(out, 'a failing check aborted the step').toContain('REACHED_END');
      const written = readFileSync(envFile, 'utf8');
      // Every check that failed is collected, comma-separated, none lost.
      const line = written.split('\n').find((l) => l.startsWith('FAILED_CHECKS='))!;
      expect(line, 'the failed list never reached GITHUB_ENV').toBeDefined();
      const collected = line.slice('FAILED_CHECKS='.length).split(',').filter(Boolean);
      expect(new Set(collected)).toEqual(new Set(Object.keys(CHECK_GUIDANCE)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('RUNS the regenerate step with every check green, and collects nothing', () => {
    // The success arm, which was unpinned: hard-coding a failure there would
    // make every green cycle render "a decision is needed".
    const shell = shellOf('Regenerate the derived artifacts');
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-regen-ok-'));
    try {
      const envFile = join(dir, 'github-env');
      writeFileSync(join(dir, 'vp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(
        join(dir, 'env'),
        '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in *=*) shift ;; *) break ;; esac; done\nexec "$@"\n',
        { mode: 0o755 }
      );
      writeFileSync(
        join(dir, 'run.sh'),
        `export PATH="${dir}:$PATH"\nexport GITHUB_ENV="${envFile}"\n${shell}\n`
      );
      execFileSync('bash', [join(dir, 'run.sh')], { encoding: 'utf8' });
      const written = readFileSync(envFile, 'utf8');
      expect(written).toContain('FAILED_CHECKS=');
      expect(written.split('\n').find((l) => l.startsWith('FAILED_CHECKS='))).toBe(
        'FAILED_CHECKS='
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('denies permissions at the top level and grants them per job', () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(workflow).toMatch(/^\s+contents: write$/m);
    expect(workflow).toMatch(/^\s+pull-requests: write$/m);
  });

  it('pins every action to a full commit SHA', () => {
    // The repo pins as `uses: owner/action@<sha> # v6`, so the ref is followed
    // by a version comment rather than the end of the line — a `(\S+)$` pattern
    // matches nothing here, which the floor below caught while writing this.
    const uses = [...workflow.matchAll(/^\s*(?:- )?uses:\s+(\S+)/gm)].map((m) => m[1]!);
    expect(uses.length, 'no `uses:` lines found — the parser stopped seeing the file').toBeGreaterThanOrEqual(2);
    for (const ref of uses) {
      expect(ref, `${ref} is not pinned to a 40-character commit SHA`).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('never asks for AWS credentials — the public bundle is the whole point', () => {
    // The prerequisite this design removed. A credentials step reappearing here
    // means someone reverted to the DescribeType path without revisiting the
    // decision recorded on the issue.
    expect(workflow).not.toContain('aws-actions/configure-aws-credentials');
    expect(workflow).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(workflow).not.toContain('role-to-assume');
  });
});
