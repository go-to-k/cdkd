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
 * The file is read as TEXT rather than parsed as YAML on purpose, matching
 * `tests/unit/scripts/release-please-v0.test.ts` and
 * `pr-inherit-issue-labels.test.ts`: the assertions are about the literal shell
 * and the literal `uses:` pins, and a YAML round-trip would let a semantically
 * equivalent but differently spelled step pass.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'cfn-schema-refresh.yml');
const VITE_CONFIG_PATH = join(REPO_ROOT, 'vite.config.ts');

const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

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
    expect(workflow).toMatch(/^\s*- cron: "[^"]+"$/m);
    expect(workflow).toMatch(/^\s*workflow_dispatch:$/m);
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
