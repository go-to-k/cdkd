/**
 * Issue [#2718](https://github.com/go-to-k/cdkd/issues/2718) — invariants of
 * `.github/workflows/cfn-schema-refresh.yml`, the repo's first scheduled
 * workflow and its first PR-opening one.
 *
 * A workflow is the one artifact here with no local run to catch a mistake: it
 * executes monthly, unattended, with `contents: write`, and a defect surfaces
 * as a wrong or missing PR a month later. So the properties that are
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

  it('runs monthly on a schedule AND is manually dispatchable', () => {
    // The schedule is the whole mechanism; `workflow_dispatch` is the reactive
    // path for a mid-cycle user report, the recovery path if GitHub suspends
    // the schedule on an inactive repo, and the only way to exercise the job
    // before its first scheduled fire.
    expect(workflow).toMatch(/^\s*schedule:$/m);
    expect(workflow).toMatch(/^\s*workflow_dispatch:$/m);
    // The cron is pinned LITERALLY. A `"[^"]+"` shape assertion accepts
    // `* * * * *`, i.e. a job firing every minute with `contents: write` —
    // the opposite of the monthly cadence the design argued for, and green.
    expect(parsed.on.schedule).toEqual([{ cron: '37 4 2 * *' }]);
  });

  /**
   * Parsed as YAML, unlike the assertions above. The text form cannot see
   * STRUCTURE: it happily passes when a whole step is deleted, or when the two
   * `if:` conditions are swapped so the job runs the refresh only while a PR
   * is already open and comments only when none is. Both are silent — the job
   * simply stops opening PRs, on a monthly cadence nobody is watching.
   */
  describe('step wiring', () => {
    const steps: Array<{ name?: string; if?: string; run?: string; uses?: string }> =
      parsed.jobs.refresh.steps;
    const byName = (name: string) => {
      const step = steps.find((s) => s.name === name);
      expect(step, `no step named ${JSON.stringify(name)} — it was renamed or deleted`).toBeDefined();
      return step!;
    };

    it('gates the refresh, the drift probe and the PR on NO open refresh PR', () => {
      for (const name of ['Refresh fixtures from the public schema bundle', 'Detect drift']) {
        expect(byName(name).if).toBe("steps.open_pr.outputs.number == ''");
      }
      for (const name of ['Regenerate the derived artifacts', 'Open the refresh PR']) {
        expect(byName(name).if).toBe("steps.drift.outputs.drifted == 'true'");
      }
    });

    it('gates the skip comment on the OPPOSITE condition', () => {
      // The polarity pair. Swapping these two is the mutation the text
      // assertions could not see.
      expect(byName('Note the skipped cycle on the open PR').if).toBe(
        "steps.open_pr.outputs.number != ''"
      );
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
        order.indexOf('Open the refresh PR')
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

  it('skips the cycle when a refresh PR is already open, rather than pushing to it', () => {
    // A human is expected to commit classifications onto the open branch; a bot
    // push would race or destroy that work.
    expect(workflow).toContain("steps.open_pr.outputs.number == ''");
    expect(workflow).toContain("steps.open_pr.outputs.number != ''");
  });

  /**
   * `chore(` produces no changelog section under release-please's conventional
   * commit rules, so a monthly bot commit never opens or advances the standing
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
