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
import { readFileSync } from 'node:fs';
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
    const steps: Array<{ name?: string; if?: string; run?: string; uses?: string }> =
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

    it('refreshes and probes drift UNCONDITIONALLY, gating only the publish', () => {
      // Load-bearing since the job stopped skipping: an open PR must not stop
      // the refresh, or every new AWS addition waits for that PR to merge —
      // and the PR that stays open longest is the RED one, exactly the window
      // where waiting costs most.
      for (const name of ['Refresh fixtures from the public schema bundle', 'Detect drift']) {
        expect(byName(name).if).toBeUndefined();
      }
      for (const name of ['Regenerate the derived artifacts', 'Publish the refresh']) {
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
      expect(publish).toMatch(/Skipping this cycle/);
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
      expect(publish).toContain('diagnose-schema-refresh.mjs');
      // Generated BEFORE the commit: the comparison against the COMMITTED
      // fixtures is the whole source of "AWS removed this in THIS refresh".
      expect(publish.indexOf('diagnose-schema-refresh.mjs')).toBeLessThan(
        publish.indexOf('git commit')
      );
      expect(publish).toContain('gh pr comment');
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

    it('re-checks the PR is still OPEN before pushing onto its branch', () => {
      // A squash merge with --delete-branch between the guard and the push
      // would make the plain push RE-CREATE the deleted branch — an orphan ref
      // with no PR, the class this repo has a dedicated hook for.
      const publish = shellOf('Publish the refresh');
      expect(publish).toContain('--json state');
      expect(publish).toMatch(/!= "OPEN"/);
    });

    it('passes the refresh skip list to the diagnosis', () => {
      // The flag existed and nothing passed it, so the "Not refreshed" section
      // could never render in production.
      expect(shellOf('Refresh fixtures from the public schema bundle')).toContain('/tmp/refresh.log');
      expect(shellOf('Publish the refresh')).toContain('--skipped-log');
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

  it('tolerates a red backfill regeneration instead of aborting before the PR exists', () => {
    // A removed property leaves a bogus declaration no generator can retire, so
    // that step is EXPECTED to fail on some cycles. Letting it stop the run
    // would suppress the very PR through which the human finds out.
    expect(workflow).toMatch(/CDKD_GENERATE_BACKFILL=true vp test run property-coverage \|\|/);
  });

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
