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
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
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
    id?: string;
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
 * The body of the guard arm introduced by `needle`, up to its closing `fi`.
 *
 * Ported from the sibling `backfill-umbrella-sync-workflow.test.ts` — and the
 * duplication is deliberate for the reason that file's header gives: a shared
 * helper would let a deletion there silently empty this file too.
 *
 * It exists here because slicing to the END OF THE STEP is not an assertion
 * about the arm. The marking step carries three later `exit 1`s, so
 * `expect(mark.slice(at)).toMatch(/exit 1/)` stayed green with the guard's own
 * `exit 1` flipped to `exit 0` — measured. Every guard-arm assertion below goes
 * through this, so the same vacuity cannot be reintroduced one case over.
 */
const guardArm = (shell: string, needle: string) => {
  const at = shell.indexOf(needle);
  expect(at, `the guard announcing ${JSON.stringify(needle)} is gone`).toBeGreaterThan(-1);
  const rest = shell.slice(at);
  const end = rest.search(/\n\s*fi\b/);
  expect(end, `the guard announcing ${JSON.stringify(needle)} is never closed`).toBeGreaterThan(-1);
  return rest.slice(0, end);
};

/**
 * The same, for a `case` arm — which closes with `;;`, not `fi`. `guardArm`
 * over one of those runs on to whatever block closes NEXT and reads ITS exit as
 * this arm's, which is the identical defect one syntax over.
 */
const caseArm = (shell: string, needle: string) => {
  const at = shell.indexOf(needle);
  expect(at, `the case arm announcing ${JSON.stringify(needle)} is gone`).toBeGreaterThan(-1);
  const rest = shell.slice(at);
  const end = rest.search(/\n\s*;;/);
  expect(end, `the case arm announcing ${JSON.stringify(needle)} is never closed`).toBeGreaterThan(
    -1
  );
  return rest.slice(0, end);
};

/**
 * The task the workflow invokes to do the capture. Named here as a literal
 * rather than derived from the workflow, so a rename must be made in both
 * places deliberately.
 */
const REFRESH_TASK = 'gen:cfn-schemas-from-zip';

/** The step this file's decision-marking cases are about. */
const MARK_STEP = 'Mark whether the PR needs a decision';

/** The step that writes the tolerances no human needs to decide. */
const SETTLE_STEP = 'Settle the removals that carry no judgement';

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
      // Only the PUBLISH is drift-only. The two steps feeding the PR's
      // decision marking also run while a refresh PR is open, so the marking
      // can be CLEARED on a day AWS did not move — see the case for that
      // below; here the point is that neither runs unconditionally.
      expect(byName('Publish the refresh').if).toBe(
        "steps.drift.outputs.drifted == 'true' || steps.settle.outputs.settled == 'true'"
      );
      for (const name of ['Regenerate the derived artifacts', 'Diagnose what needs a decision']) {
        expect(byName(name).if).toContain("steps.drift.outputs.drifted == 'true'");
        expect(byName(name).if, `${name} runs unconditionally`).not.toBeUndefined();
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

    it('no longer writes the umbrella from here, and gives up the scope that took', () => {
      // The splice moved to `backfill-umbrella-sync.yml`, driven by pushes to
      // `main`. Writing it from HERE meant writing it from the job's own
      // post-refresh workspace, before the PR was reviewed — so closing the PR
      // left the issue asserting properties `main` does not have (measured
      // 2026-09-07: 288 rows against `main`'s 285). Fenced from this side too,
      // because a re-added splice here would be invisible to the new
      // workflow's own suite while quietly restoring the divergence.
      expect(workflow, 'the umbrella splice is back in the refresh job').not.toContain(
        'MARKER_BEGIN'
      );
      expect(workflow).not.toContain('gh issue edit');
      expect(workflow).not.toContain('--umbrella-checklist');
      // And the permission that existed only for that write is gone with it.
      // This is the repo's one unattended job holding `contents: write`, so a
      // scope it no longer uses is worth pinning at zero rather than trusting
      // to review.
      expect(
        parsed.jobs.refresh.permissions,
        'issues: write is back on the job that no longer touches an issue'
      ).not.toHaveProperty('issues');
    });

    it('settles the judgement-free removals BEFORE the checks grade them', () => {
      // Order is the whole feature. The write exists so `property-coverage` is
      // green when it runs on a property nothing was going to decide
      // differently; run after the checks, it would settle the case and still
      // hand the human a red PR about it.
      const names = steps.map((s) => s.name).filter((n): n is string => n !== undefined);
      const settleAt = names.indexOf(SETTLE_STEP);
      expect(settleAt, 'the settle step is gone').toBeGreaterThan(-1);
      expect(settleAt, 'the removals are settled after the checks have graded them').toBeLessThan(
        names.indexOf('Regenerate the derived artifacts')
      );
      // And after the drift probe, since it classifies what the refresh changed.
      expect(names.indexOf('Detect drift')).toBeLessThan(settleAt);
      // Same guard as the steps it feeds: with a refresh PR open, a human may
      // have committed classifications and a later cycle still has to write the
      // ones that need none.
      expect(byName(SETTLE_STEP).if).toBe(
        "steps.drift.outputs.drifted == 'true' || steps.open_pr.outputs.number != ''"
      );
    });

    it('holds NO token while it rewrites a committed judgement file', () => {
      // This is the one step that writes a file encoding judgement, and it is
      // also the one that spawns `node` over the whole SDK typing tree. The
      // repo's split is that a step doing either does not carry the write-scoped
      // token — the same reasoning `persist-credentials: false` gives.
      expect(byName(SETTLE_STEP).env, 'the settle step carries a token').toBeUndefined();
      expect(shellOf(SETTLE_STEP)).toContain('--write-auto-tolerated');
    });

    it('refuses an absent settle record rather than reading it as "settled nothing"', () => {
      // The report takes the record and subtracts what it names from the
      // decision count. An ABSENT file is the permissive arm there — every
      // settled property would be reported as still needing a decision — which
      // is harmless in direction but indistinguishable from this step never
      // having run.
      const settle = shellOf(SETTLE_STEP);
      expect(settle).toContain('[ -s /tmp/auto-tolerated.json ]');
      expect(
        settle.indexOf('--write-auto-tolerated'),
        'the emptiness test runs before the write it inspects'
      ).toBeLessThan(settle.indexOf('[ -s /tmp/auto-tolerated.json ]'));
      // And the report is actually handed the record; without this the section
      // and the subtraction are dead code.
      expect(shellOf('Diagnose what needs a decision')).toContain(
        '--auto-tolerated /tmp/auto-tolerated.json'
      );
    });

    it('COMMITS a settlement even on a day AWS did not move', () => {
      // The arm that needs it most, and the one a drift-only Publish guard
      // threw away: an open PR carrying an outstanding removal, on a quiet day.
      // Settle would write the tolerance, Publish would skip, the write would be
      // discarded — and the marking would correctly refuse to clear over a tree
      // the branch does not carry. A stalemate that resolves only when AWS
      // happens to drift again.
      expect(byName('Publish the refresh').if).toBe(
        "steps.drift.outputs.drifted == 'true' || steps.settle.outputs.settled == 'true'"
      );
      // The output exists and is read from the TREE, not from the record's
      // `written` array: what has to be committed is a file that CHANGED, and a
      // cycle re-settling a property already tolerated writes nothing.
      expect(byName(SETTLE_STEP).id).toBe('settle');
      const settle = shellOf(SETTLE_STEP);
      expect(settle).toContain(
        'git status --porcelain -- tests/fixtures/cfn-schemas/_todo-backfill.json'
      );
      expect(settle).toContain('echo "settled=true" >> "$GITHUB_OUTPUT"');
      expect(settle).toContain('echo "settled=false" >> "$GITHUB_OUTPUT"');
    });

    it('refuses to open a NEW PR for a settlement with no refresh behind it', () => {
      // The widened guard admits a settle-only cycle, and a branch is a
      // REFRESH's output — a PR whose only content is a tolerance the job
      // decided on its own has no schema change to explain it. Unreachable by
      // construction (Settle needs drift or an open PR, so settle-only implies
      // the additive path), which is exactly when a guard stops being written
      // and the next change makes it reachable.
      const publish = shellOf('Publish the refresh');
      const arm = guardArm(publish, 'if [ "${DRIFTED}" != "true" ]; then');
      expect(arm, 'the branch-creating path no longer refuses a driftless cycle').toContain(
        'exit 1'
      );
      expect(arm).toContain('::error::');
      // And the variable it reads is declared, or `set -u` kills the step.
      expect(byName('Publish the refresh').env).toHaveProperty(
        'DRIFTED',
        '${{ steps.drift.outputs.drifted }}'
      );
    });

    it('commits the tolerance file the settle step wrote', () => {
      // `_todo-backfill.json` lives under `tests/fixtures/cfn-schemas/`, so the
      // publish step's existing `git add` covers it — but only while that path
      // is there. Narrow the add and the job settles a property, reports it as
      // settled, and pushes a branch that does not carry the entry.
      expect(shellOf('Publish the refresh')).toContain('tests/fixtures/cfn-schemas/');
    });

    it('derives the decision count from the SAME run that rendered the body', () => {
      // A second invocation would re-read `--failed-checks` and
      // `--nested-key-log` from its own argv, so a copy that drifted by one
      // flag would mark the PR "no decisions needed" over the very report it
      // sits beside — the shape `--failed-checks` already produced here once.
      // One invocation cannot disagree with itself.
      const diagnose = shellOf('Diagnose what needs a decision');
      expect(diagnose).toContain('--decision-count-out /tmp/decision-count.txt');
      const invocations = diagnose.match(/node scripts\/diagnose-schema-refresh\.mjs/g) ?? [];
      expect(
        invocations.length,
        'the diagnosis is invoked more than once, so the count and the report can disagree'
      ).toBe(1);
    });

    it('recomputes the marking while a PR is open, even on a day with no drift', () => {
      // The clearing path. Gated on drift alone, the marking could only be
      // recomputed on a day AWS happened to move: a human commits the
      // classifications, the next cycle stops at "No fixture drift — nothing
      // to do", and the label, title count and assignee keep asserting work
      // that is already settled. A signal that cannot be cleared teaches its
      // reader to ignore it.
      for (const name of ['Regenerate the derived artifacts', 'Diagnose what needs a decision']) {
        expect(byName(name).if, `${name} cannot run on the open-PR arm`).toBe(
          "steps.drift.outputs.drifted == 'true' || steps.open_pr.outputs.number != ''"
        );
      }
      // Publish takes drift OR a settlement worth committing — and NOT the bare
      // open-PR arm, which would push the regeneration on every quiet day.
      expect(byName('Publish the refresh').if).toBe(
        "steps.drift.outputs.drifted == 'true' || steps.settle.outputs.settled == 'true'"
      );
      expect(
        byName('Publish the refresh').if,
        'Publish now commits on the bare open-PR arm, every quiet day'
      ).not.toContain('steps.open_pr.outputs.number');
    });

    it('marks the PR this cycle published, or the one already open', () => {
      // Both can be set — an additive push republishes onto the open PR — and
      // they are then the same number. What must not happen is a cycle that
      // lost the push race also losing the marking on a PR that still exists.
      expect(byName('Mark whether the PR needs a decision').if).toBe(
        "steps.publish.outputs.pr_number != '' || steps.open_pr.outputs.number != ''"
      );
      expect(shellOf('Publish the refresh')).toContain('pr_number=${pr_number:-}');
      const mark = shellOf('Mark whether the PR needs a decision');
      expect(mark).toContain('pr="${PUBLISHED_PR:-${OPEN_PR}}"');
    });

    it('refuses to re-mark from a count it did not read', () => {
      // "Absent" must never read as zero: that is the direction that silently
      // clears a real decision, and it is reachable by any earlier step dying
      // before the count is written. Same reasoning as the `--failed-checks`
      // guards in the diagnosis — every absent-input arm here is the
      // permissive one unless it is written not to be.
      const mark = shellOf(MARK_STEP);
      expect(mark).toMatch(/if \[ ! -s \/tmp\/decision-count\.txt \]; then/);
      // Sliced to the guard's OWN `fi`, not to the end of the step. The earlier
      // form was `expect(mark.slice(emptyAt)).toMatch(/exit 1/)`, which the
      // step's three LATER `exit 1`s satisfied — flipping this guard to
      // `exit 0` left it green, i.e. the case pinned nothing.
      const arm = guardArm(mark, '/tmp/decision-count.txt is missing or empty');
      expect(arm, 'the unread-count guard no longer fails the step').toContain('exit 1');
      expect(
        arm,
        'the unread-count guard now falls through into the marking below'
      ).not.toContain('exit 0');
      // And a value that is not a number is the same fail-closed case. A `case`
      // arm closes with `;;`, so it gets the sibling slicer — `guardArm` here
      // would run on to the no-drift block's `fi` and read ITS `exit 0`.
      expect(mark).toContain("''|*[!0-9]*)");
      const nonNumeric = caseArm(mark, "is not a number");
      expect(nonNumeric, 'a non-numeric count no longer fails the step').toContain('exit 1');
      expect(nonNumeric, 'a non-numeric count is marked from anyway').not.toContain('exit 0');
    });

    it('writes a title suffix it can also strip, so the step is idempotent', () => {
      // The base title is DERIVED from the PR's current one rather than
      // threaded from the step that created it — which is what makes the
      // additive path correct, where the title was written by an earlier cycle
      // this run has no output from. Producer and stripper are the same
      // pattern, so they cannot drift apart.
      const mark = shellOf(MARK_STEP);
      // BOTH operands come out of the workflow. The earlier form matched a
      // hand-typed JS regex against hand-typed titles — neither the stripper
      // nor the strings under test came from the step, so no edit to the step
      // could fail it. It is unfalsifiable, not strict.
      const sed = mark.match(/base=\$\(printf '%s' "\$\{current\}" \| sed -E 's\/(.*)\/\/'\)/);
      expect(sed, 'the base title is no longer derived by stripping the suffix').not.toBeNull();
      // The pattern is a POSIX ERE using only constructs JS spells the same
      // way; anything else here should fail loudly rather than be approximated.
      const pattern = sed![1]!;
      expect(pattern, 'the strip pattern grew a construct this case cannot evaluate').not.toMatch(
        /\\[0-9]|\[:[a-z]+:\]|\(\?/
      );
      const strip = new RegExp(pattern);

      // The titles the step ITSELF writes, read off its assignments, so a
      // reworded suffix moves both sides at once and only a real DRIFT between
      // producer and stripper fails.
      const suffixes = [...mark.matchAll(/^\s*title="\$\{base\}([^"]*)"$/gm)].map((m) => m[1]!);
      expect(
        suffixes.length,
        'the step no longer builds its title from ${base} — the producer half is gone'
      ).toBe(3);
      // One of them is the zero case, which appends nothing.
      expect(suffixes, 'the zero-decision title is no longer the bare base').toContain('');

      const base = 'chore(schemas): refresh CFn schema fixtures (2026-09-07)';
      for (const suffix of suffixes) {
        // `${decisions}` is the shell's own variable; every count the step can
        // render has to survive the round trip, so the plural arm is exercised
        // at a width the singular pattern cannot absorb.
        for (const count of ['2', '12']) {
          const title = base + suffix.split('${decisions}').join(count);
          if (suffix === '') {
            expect(title, 'the zero-decision title is not the base').toBe(base);
          } else {
            expect(title, `${JSON.stringify(title)} carries no suffix to strip`).not.toBe(base);
            expect(title, `the stripper does not match ${JSON.stringify(title)}`).toMatch(strip);
          }
          expect(
            title.replace(strip, ''),
            `stripping ${JSON.stringify(title)} does not return the base byte-identically`
          ).toBe(base);
        }
      }
      // And the stripper is ANCHORED: a base merely containing the words must
      // survive untouched, or every re-mark eats part of the real title.
      const decoy = `${base} — 3 decisions needed for the release`;
      expect(decoy.replace(strip, ''), 'the stripper is not anchored to the end').toBe(decoy);
    });

    it('clears the label at zero and never assigns on that path', () => {
      const mark = shellOf(MARK_STEP);
      // The LAST of the two `decisions == 0` gates: the first chooses the
      // title, this one chooses the marking. Anchoring on the first would
      // slice the title block and assert nothing about either label call —
      // and both gates are spelled identically, so `indexOf` picks the wrong
      // one silently.
      const gate = 'if [ "${decisions}" = "0" ]; then';
      const zeroAt = mark.lastIndexOf(gate);
      expect(zeroAt, 'the zero-decision marking arm is gone').toBeGreaterThan(-1);
      expect(
        mark.indexOf(gate),
        'the title gate and the marking gate collapsed into one'
      ).toBeLessThan(zeroAt);
      // Through `guardArm`, which ends the arm at a LINE-LEADING `fi`. The
      // earlier `mark.indexOf('fi', zeroAt)` ended it inside the word "suffix"
      // in this arm's own notice, cutting the slice before the `exit 0` it then
      // asserted — the case failed on correct code.
      const zeroArm = guardArm(mark.slice(zeroAt), gate);
      expect(zeroArm).toContain('--remove-label "${DECISION_LABEL}"');
      expect(zeroArm, 'the settled PR is still being assigned').not.toContain('--add-assignee');
      expect(zeroArm, 'the settled PR is still being labelled').not.toContain('--add-label');
      expect(zeroArm, 'the zero arm falls through into the marking below').toContain('exit 0');
    });

    it('labels AND assigns when a decision remains — the assignee is the notification', () => {
      // Of the three marks only the assignee produces one, and the maintainer
      // does not routinely read the PR list: a label and a title suffix are
      // legible only to someone already looking. They earn their place by
      // making the state readable afterwards, including "this was settled".
      const mark = shellOf(MARK_STEP);
      expect(mark).toContain('--add-label "${DECISION_LABEL}"');
      expect(mark).toContain('--add-assignee "${GITHUB_REPOSITORY_OWNER}"');
      // Read from the event, not hard-coded, so a fork or a transfer cannot
      // silently assign a stranger.
      expect(mark, 'the assignee is hard-coded').not.toMatch(/--add-assignee "go-to-k"/);
      // ORDER, by index — presence is satisfied by either arrangement. The
      // order is now a PREFERENCE, not the safety property: the notification
      // goes out before anything else can fail. What makes the two marks
      // independent is `marks_failed` above, and the first attempt at this was
      // reordering ALONE, which only moved the victim — a bare `--add-assignee`
      // under `set -e` killed the label instead.
      const assignAt = mark.indexOf('--add-assignee "${GITHUB_REPOSITORY_OWNER}"');
      const addLabelAt = mark.indexOf('--add-label "${DECISION_LABEL}"');
      expect(
        assignAt,
        'the label is added before the assignee — a missing label kills the only notification'
      ).toBeLessThan(addLabelAt);
      // And the assignment is NOT inside the label guard, where a label failure
      // would take it down with it.
      expect(
        guardArm(mark, 'if ! gh pr edit "${pr}" --add-label "${DECISION_LABEL}"; then'),
        'the assignment moved inside the label-failure arm'
      ).not.toContain('--add-assignee');
    });

    it('does not create the decision label, and says so when it is missing', () => {
      // A workflow that creates the label on demand would also recreate one a
      // maintainer deliberately deleted. Failing loudly is the honest half of
      // that trade, and the message has to name the fix.
      const mark = shellOf(MARK_STEP);
      // As a COMMAND, not as a substring: the refusal message below names
      // `gh label create needs-decision` so a reader can paste it, and a plain
      // `not.toContain('gh label create')` is satisfied by that message —
      // reading the remedy as the defect. Only a line that STARTS with it is
      // the job actually creating the label.
      const createsLabel = mark
        .split('\n')
        .some((l) => /^\s*gh label create\b/.test(l));
      expect(createsLabel, 'the job creates the label it should be asking for').toBe(false);
      expect(mark).toMatch(/if ! gh pr edit "\$\{pr\}" --add-label "\$\{DECISION_LABEL\}"; then/);
      expect(mark).toContain('gh label create needs-decision');
      // The guard's OWN arm, for the same reason the unread-count case gives:
      // sliced to the end of the step, the trailing `exit 1`s of the arms
      // ABOVE this one would satisfy it with this one flipped to `exit 0`.
      const failArm = guardArm(
        mark,
        'if ! gh pr edit "${pr}" --add-label "${DECISION_LABEL}"; then'
      );
      expect(failArm, 'the missing-label case does not announce itself').toContain(
        "Could not add the '${DECISION_LABEL}' label"
      );
      // Records the failure rather than exiting inside the arm: the assignee
      // is attempted too, and neither mark may take the other down. The exit
      // is the collected one below.
      expect(failArm, 'a missing label no longer records a failure').toContain('marks_failed=1');
      expect(failArm, 'the label arm exits inside itself, taking the assignee down').not.toContain(
        'exit 1'
      );
      // The ASSIGNEE arm, symmetrically. Ordering alone only moved the victim:
      // a bare `--add-assignee` under `set -e` (a 422 for an org owner after a
      // transfer) killed the label instead, and with no `::error::` naming a
      // fix. Neither mark may take the other down, so neither arm exits.
      const assignArm = guardArm(
        mark,
        'if ! gh pr edit "${pr}" --add-assignee "${GITHUB_REPOSITORY_OWNER}"; then'
      );
      expect(assignArm, 'a failed assignment does not announce itself').toContain('::error::');
      expect(assignArm, 'a failed assignment no longer records a failure').toContain(
        'marks_failed=1'
      );
      expect(assignArm, 'the assignee arm exits inside itself, taking the label down').not.toContain(
        'exit 1'
      );
      expect(failArm, 'a missing label now reports success').not.toContain('exit 0');
      // Through `guardArm`, not a presence check on the whole step. The
      // previous spelling was `expect(mark, …).toContain(<the if line>)`, which
      // says the GUARD exists and nothing about what it does — flip its
      // `exit 1` to `exit 0` and a run where BOTH marks failed reports green.
      // That is the same vacuity this file's helper exists to prevent, one
      // assertion over from where it was last found.
      expect(
        guardArm(mark, 'if [ "${marks_failed}" != "0" ]; then'),
        'both marks failed and the step reported success'
      ).toContain('exit 1');
    });

    it('declares every variable its shell reads — a dropped one is a daily set -u death', () => {
      // The whole `env:` block, as an EXACT object. Every entry is load-bearing
      // and none of them fails visibly: the step runs `set -euo pipefail`, so a
      // dropped `OPEN_PR` / `DECISION_LABEL` / marker kills it on the first
      // unset expansion, every day, on a PR nobody is watching — and a dropped
      // `GH_TOKEN` makes every `gh` call fail instead. A presence-only form
      // also accepts a rewiring (`steps.publish.outputs.pr_number` swapped for
      // another step's output), which is silent in both directions.
      //
      // `DRIFTED` is deliberately NOT here. It was, and the clamp stopped
      // reading it when the predicate moved to `PUBLISHED_PR`. This literal is
      // the only thing that notices a dead entry, and only while it disagrees:
      // the derived case below proves READ ⇒ DECLARED, never the converse, so
      // an entry added to both places again would go unwatched. That is exactly
      // how `DRIFTED` survived its own retirement for a round.
      const step = byName(MARK_STEP);
      expect(step.env).toEqual({
        GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
        PUBLISHED_PR: '${{ steps.publish.outputs.pr_number }}',
        OPEN_PR: '${{ steps.open_pr.outputs.number }}',
        DECISION_LABEL: 'needs-decision',
        VERDICT_BEGIN: '<!-- BEGIN generated: decision verdict -->',
        VERDICT_END: '<!-- END generated: decision verdict -->',
      });

      // And the other direction, derived: every environment-shaped name the
      // shell dereferences must be declared here or provided by the runner.
      // The object above pins what is DECLARED; this pins that nothing is READ
      // without being declared, which is the half a future edit adds.
      const mark = shellOf(MARK_STEP);
      const referenced = new Set(
        [...mark.matchAll(/\$\{([A-Z][A-Z0-9_]*)[:}]/g)].map((m) => m[1]!)
      );
      expect(
        referenced.size,
        'no environment reads found in the marking step — the scan broke'
      ).toBeGreaterThanOrEqual(6);
      const RUNNER_PROVIDED = new Set(['GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_OWNER']);
      // Names the step ASSIGNS itself (`B=$(mktemp); NB=$(mktemp)`) are not
      // env; the separator class covers the `;`-joined second assignment, which
      // a `^`-anchored pattern misses.
      const assigned = new Set(
        [...mark.matchAll(/(?:^|[\s;])([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1]!)
      );
      for (const name of referenced) {
        expect(
          Object.keys(step.env ?? {}).includes(name) ||
            RUNNER_PROVIDED.has(name) ||
            assigned.has(name),
          `\${${name}} is read but neither declared in env:, assigned by the step, nor provided by the runner`
        ).toBe(true);
      }
      // The markers are read from `env:`, never spelled again in the shell —
      // two copies of a delimiter drift and the block stops being found.
      expect(mark, 'the verdict marker text is hardcoded in the shell').not.toContain(
        '<!-- BEGIN generated'
      );
      expect(mark).toContain('"${VERDICT_BEGIN}"');
      expect(mark).toContain('"${VERDICT_END}"');
    });

    it('re-checks the PR is still OPEN before marking it', () => {
      // `PUBLISHED_PR` is empty on Publish's closed-PR bail-out — that arm
      // `exit 0`s BEFORE writing the output — so without this the fallback to
      // `OPEN_PR` marks the very PR Publish just refused to touch: a merged PR
      // acquires a label, a "N decisions needed" title and an assignee, all
      // still editable after a merge, and no later cycle can clear them because
      // the open-PR guard will never find it again.
      const mark = shellOf(MARK_STEP);
      expect(mark).toMatch(/state=\$\(gh pr view "\$\{pr\}" --json state --jq \.state\)/);
      const arm = guardArm(mark, 'if [ "${state}" != "OPEN" ]; then');
      expect(arm, 'the non-OPEN case marks the PR anyway').toContain('exit 0');
      expect(arm, 'the non-OPEN arm writes to the PR').not.toContain('gh pr edit');
      expect(arm, 'the non-OPEN arm writes to the PR').not.toContain('gh api');
      // Before EVERY write, not merely present somewhere.
      const stateAt = mark.indexOf('state=$(gh pr view');
      for (const write of ['gh api -X PATCH', 'gh pr edit']) {
        const at = mark.indexOf(write);
        expect(at, `${write} is gone — this case guards nothing`).toBeGreaterThan(-1);
        expect(at, `${write} runs before the OPEN re-check`).toBeGreaterThan(stateAt);
      }
    });

    it('leaves an outstanding count alone on a day with no drift', () => {
      // `removed` is diffed against the branch's COMMITTED fixtures, so with no
      // drift it is empty by construction: a PR published as "2 decisions
      // needed" would be retitled "1 decision needed" the next morning with
      // nothing settled. The count is only comparable downward on this arm.
      const mark = shellOf(MARK_STEP);
      const arm = guardArm(
        mark,
        'if [ -z "${PUBLISHED_PR}" ] && [ "${decisions}" != "0" ]; then'
      );
      expect(arm, 'the no-drift arm re-marks from an incomparable count').toContain('exit 0');
      expect(arm, 'the no-drift arm still writes to the PR').not.toContain('gh pr edit');
      expect(arm, 'the no-drift arm still writes to the PR').not.toContain('gh api');
      // It has to run BEFORE the title is computed, or the retitle happens on
      // the way to the refusal.
      expect(mark.indexOf('current=$(gh pr view')).toBeGreaterThan(
        mark.indexOf('if [ -z "${PUBLISHED_PR}" ] && [ "${decisions}" != "0" ]; then')
      );
    });

    it('refuses to CLEAR on a no-drift day whose regeneration changed files', () => {
      // This arm grades a tree it then throws away — `Regenerate` rewrites the
      // derived artifacts and Publish does not run on this arm — so a human who
      // fixed a provider WITHOUT regenerating would see the marking cleared
      // while the PR's own CI, which builds the COMMITTED tree, stays red.
      const mark = shellOf(MARK_STEP);
      // The same three paths `Publish the refresh` commits, or the probe grades
      // a different tree than the one the PR carries.
      expect(mark).toContain(
        'regen=$(git status --porcelain -- src/provisioning/ docs/ tests/fixtures/cfn-schemas/)'
      );
      const publish = shellOf('Publish the refresh');
      for (const path of ['src/provisioning/', 'docs/', 'tests/fixtures/cfn-schemas/']) {
        expect(publish, `${path} is no longer committed — the clean-tree probe is now wrong`).toContain(
          path
        );
      }
      // Only on the arm where nothing was PUBLISHED: on a cycle that committed
      // the refresh the tree is dirty by definition and this would refuse
      // every real one. Keyed on `PUBLISHED_PR` rather than `DRIFTED`, because
      // a lost push race leaves `DRIFTED=true` with nothing committed — the
      // case the clamp exists for, and the one a `DRIFTED` predicate let past.
      const noPublish = guardArm(mark, 'if [ -z "${PUBLISHED_PR}" ]; then');
      // The needle above already contains `regen=`, so asserting THAT here
      // could not fail. What is falsifiable is the probe being INSIDE the arm
      // and running `git status` over the regenerated paths.
      expect(noPublish, 'the clean-tree probe escaped its no-publish guard').toContain(
        'git status --porcelain -- src/provisioning/ docs/ tests/fixtures/cfn-schemas/'
      );
      const dirty = guardArm(mark, 'if [ -n "${regen}" ]; then');
      expect(dirty, 'a dirty tree still gets its marking cleared').toContain('exit 0');
      expect(dirty, 'the dirty-tree refusal is silent').toContain('::warning::');
      expect(dirty, 'the dirty-tree arm writes to the PR').not.toContain('gh pr edit');
    });

    it('PATCHes the title only when it actually changed, through the API endpoint', () => {
      // Unconditional, every quiet cycle stamps a fresh "changed the title"
      // event on the PR while changing nothing — the same edit-noise defect the
      // sibling workflow's `cmp -s` guard exists for.
      const mark = shellOf(MARK_STEP);
      const arm = guardArm(mark, 'if [ "${title}" != "${current}" ]; then');
      expect(arm, 'the title PATCH escaped its changed-title guard').toContain(
        'gh api -X PATCH "repos/${GITHUB_REPOSITORY}/pulls/${pr}" -f title="${title}"'
      );
      // Exactly one title write, and it is the one inside that arm.
      expect(
        [...mark.matchAll(/-f title=/g)].length,
        'more than one title write — only the guarded one is fenced'
      ).toBe(1);
      // The PR NUMBER is the one this step resolved, not a re-read: `${pr}` is
      // what the OPEN re-check above was performed against.
      expect(mark).toContain('/pulls/${pr}"');
      expect(mark, 'the title is threaded through gh pr edit again').not.toMatch(
        /gh pr edit[^\n]*--title/
      );
    });

    it('derives the base title from the PR, not from a value threaded into the step', () => {
      // Deriving is what makes the step IDEMPOTENT and correct on the additive
      // path, where the title was written by an earlier cycle this run has no
      // output from — and it cannot drift from the suffix it writes, because
      // the same pattern produces and strips it.
      const mark = shellOf(MARK_STEP);
      const currentAt = mark.indexOf('current=$(gh pr view "${pr}" --json title --jq .title)');
      expect(currentAt, 'the current title is no longer read off the PR').toBeGreaterThan(-1);
      const baseAt = mark.indexOf('base=$(printf \'%s\' "${current}" | sed -E');
      expect(baseAt, 'the base is no longer derived from the current title').toBeGreaterThan(-1);
      expect(baseAt, 'the base is derived before the title it derives from is read').toBeGreaterThan(
        currentAt
      );
      // Nothing else may supply it: a threaded base is exactly the value the
      // additive path does not have.
      expect(Object.keys(byName(MARK_STEP).env ?? {}), 'a title is threaded in through env').not.toContain(
        'BASE_TITLE'
      );
      expect(mark, 'the base is rebuilt from a literal instead of the PR').not.toMatch(
        /base="chore/
      );
    });

    it('maintains ONE verdict block at the top of the body, and refuses to guess', () => {
      // The body is written once, on the day the PR opened, while later cycles
      // add comments — so without this the body's own summary ages while the
      // title stays current.
      const mark = shellOf(MARK_STEP);
      const guard =
        'if [ "${vb_count}" = "1" ] && [ "${ve_count}" = "1" ] && [ "${ve}" -gt "${vb}" ]; then';
      expect(mark, 'the unambiguous-block guard is gone').toContain(guard);
      const block = guardArm(mark, guard);
      const elifAt = block.indexOf('elif [ "${vb_count}" = "0" ] && [ "${ve_count}" = "0" ]');
      expect(elifAt, 'the insert arm is gone — a body with no block is never given one').toBeGreaterThan(-1);
      const elseAt = block.search(/\n\s*else\s*\n/);
      expect(elseAt, 'the ambiguous arm is gone').toBeGreaterThan(elifAt);

      // Arm 1 — REPLACE, by line number. `sed -n '1,/re/p'` starts its addr2
      // search at line TWO, so a marker on line 1 (exactly where this block
      // sits) never closes the range and the head half emits the whole body.
      const replaceArm = block.slice(0, elifAt);
      expect(replaceArm).toContain('head -n "${vb}" "${B}" > "${NB}"');
      expect(replaceArm).toContain('printf \'%s\\n\' "${verdict}" >> "${NB}"');
      expect(replaceArm).toContain('tail -n "+${ve}" "${B}" >> "${NB}"');
      expect(replaceArm, 'the block is addressed by regex again, not by line').not.toContain(
        'sed -n'
      );

      // Arm 2 — INSERT, at the TOP, keeping the existing body below it.
      const insertArm = block.slice(elifAt, elseAt);
      expect(insertArm).toContain('"${VERDICT_BEGIN}" "${verdict}" "${VERDICT_END}"');
      expect(insertArm, 'the existing body is dropped when the block is inserted').toContain(
        'cat "${B}"'
      );
      expect(
        insertArm.indexOf('printf'),
        'the block is appended after the body instead of inserted at the top'
      ).toBeLessThan(insertArm.indexOf('cat "${B}"'));

      // Arm 3 — REFUSE. Anything else is an ambiguous body, and rewriting one
      // means guessing which half is generated.
      const warnArm = block.slice(elseAt);
      expect(warnArm, 'the ambiguous body is rewritten anyway').toContain('::warning::');
      expect(warnArm).toContain('cp "${B}" "${NB}"');
      expect(warnArm, 'the ambiguous arm writes the body').not.toContain('gh api');

      // The write itself: guarded on a real change, and the body goes through
      // the API as a FILE — an inline value would be re-interpreted by the CLI.
      const writeArm = guardArm(mark, 'if ! cmp -s "${B}" "${NB}"; then');
      expect(writeArm).toContain(
        'gh api -X PATCH "repos/${GITHUB_REPOSITORY}/pulls/${pr}" --field "body=@${NB}"'
      );
      expect(
        [...mark.matchAll(/--field "body=@/g)].length,
        'more than one body write — only the guarded one is fenced'
      ).toBe(1);

      // And a body it could not READ is never written: the redirect truncates
      // `${B}` before gh runs, so an unchained recipe would splice onto an
      // empty body and replace the whole thing with the verdict alone.
      expect(mark).toMatch(
        /if gh pr view "\$\{pr\}" --json body --jq \.body \| tr -d '\\r' > "\$\{B\}" && \[ -s "\$\{B\}" \]; then/
      );
      expect(mark).toContain('Could not read PR ${pr}\'s body; refusing to write one');
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
      // The additive commit, whose subject is now chosen rather than literal —
      // a settlement-only cycle commits no drift and must not say it did.
      const commitAt = publish.indexOf('git commit -m "${subject}"');
      expect(commitAt, 'the additive commit is gone or spelled differently').toBeGreaterThan(-1);
      expect(baseAt, 'the baseline is captured after the commit it describes').toBeLessThan(
        commitAt
      );
      expect(publish, 'the baseline is still read off the remote').not.toMatch(
        /base_sha=\$\(git ls-remote/
      );
    });

    it('does not call a settlement-only cycle a schema drift', () => {
      // The message has to match the diff. Publish now runs on drift OR a
      // settlement, and the additive path is where a settlement-only cycle
      // lands — committing a tolerance the job decided, with no schema change
      // behind it. Calling that "additional CFn schema drift" would make the
      // branch history describe something that did not happen.
      const publish = shellOf('Publish the refresh');
      const arm = guardArm(publish, 'if [ "${DRIFTED}" = "true" ]; then');
      expect(arm, 'the drifted subject is gone').toContain('additional CFn schema drift');
      expect(arm, 'both cycles claim a drift again').toContain(
        'settle removals the evidence already answers'
      );
      // And the chosen subject is what is actually committed.
      expect(publish).toContain('git commit -m "${subject}"');
      expect(
        publish.indexOf('subject="chore(schemas): additional'),
        'the subject is chosen after the commit that uses it'
      ).toBeLessThan(publish.indexOf('git commit -m "${subject}"'));
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
      // EVERY step, not the one `run_check` lives in today. Scoped to
      // `Regenerate`, a check added in a NEW step failed here with a message
      // blaming the guidance table — which is wrong about the cause and pushes
      // the author to DELETE the guidance entry to go green. The sibling
      // schema-refresh-decision-ci-coverage.test.ts scans the same way, so the
      // two agree on the population (go-to-k/cdkd#3005).
      const shells = steps
        .map((s) =>
          (s.run ?? '')
            .split('\n')
            .filter((l) => !/^\s*#/.test(l))
            .join('\n')
        )
        .join('\n');
      const collected = [...shells.matchAll(/^\s*run_check (\S+)/gm)].map((m) => m[1]!);
      expect(collected.length, 'no run_check invocations found').toBeGreaterThanOrEqual(3);
      // An invocation that does not OPEN its line is invisible to the pattern
      // above, and a NEW one going missing leaves this set equal to the
      // guidance keys — the fence green over exactly the drift it watches.
      expect(
        collected.length,
        `${(shells.match(/\brun_check\s+\S/g) ?? []).length} run_check invocation(s) in the ` +
          `refresh shell, but only ${collected.length} parsed — put each on its own line`
      ).toBe((shells.match(/\brun_check\s+\S/g) ?? []).length);
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

      // The guidance's PASTE-ABLE COMMAND must be these same filters. Two
      // rounds of this fence were too weak: comparing the key SET let round 10
      // widen the workflow while the rendered command still named three files
      // of eleven, and comparing a token SET over the whole row let a dropped
      // `\\` pass — after which the pasted command runs ONE filter and comes
      // back GREEN over a real red. So the block is parsed as a command.
      const guidance = CHECK_GUIDANCE['fixture-consumer-tests']!;
      const open = guidance.indexOf('```bash');
      const close = guidance.indexOf('```', open + 1);
      expect(open, 'the guidance no longer carries a command block').toBeGreaterThan(-1);
      expect(close, 'the command block is unterminated').toBeGreaterThan(open);
      // Exactly one: the fence reads the FIRST block, and a second one renders
      // into the PR body just as visibly while being fenced by nothing.
      expect(
        guidance.filter((l) => l.trim().startsWith('```')).length,
        'more than one command block — only the first is fenced'
      ).toBe(2);
      // LEADING whitespace only. Trimming both ends stripped a trailing space
      // AFTER the backslash before testing it — and `\ ` + newline is not a
      // continuation in bash, so the pasted command stops there. Measured: one
      // trailing space dropped five of the seven filters while the fence stayed
      // green, which is the failure this fence exists for. A trailing space in
      // a JS string literal is invisible in review and `vp fmt` does not see
      // inside one.
      const command = guidance.slice(open + 1, close).map((l) => l.replace(/^\s+/, ''));
      expect(command[0], 'the block does not start with the invocation').toBe('vp test run \\');

      // Every line but the last continues, or the shell ends the command there.
      const argLines = command.slice(1);
      argLines.forEach((line, i) => {
        const isLast = i === argLines.length - 1;
        expect(
          line.endsWith('\\'),
          `line ${i + 2} of the command ${isLast ? 'must NOT' : 'must'} continue: ${JSON.stringify(line)}`
        ).toBe(!isLast);
      });

      const guidanceFilters = argLines.map((l) => l.replace(/\s*\\$/, '').trim());
      expect(
        guidanceFilters,
        'the pasted command and the workflow run different filters'
      ).toEqual(filters);

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

    it('names every collected check in the operator runbook', () => {
      // The last unfenced pair. `run_check` names are fenced against
      // `CHECK_GUIDANCE`'s keys, so a fifth check is FORCED into the guidance —
      // and was free to be left out of the page a maintainer actually opens
      // when the PR arrives. The table is prose; nothing else reads it.
      const runbook = readFileSync(join(REPO_ROOT, 'docs/schema-refresh-runbook.md'), 'utf8');
      for (const check of Object.keys(CHECK_GUIDANCE)) {
        // The TABLE ROW, not the file. `property-coverage` also appears in two
        // `vp test run` code blocks, so a whole-file `toContain` stayed green
        // with its row deleted — and its row is the one most likely to be
        // edited. The other three were bound only by coincidence.
        expect(runbook, `the runbook table does not name ${check}`).toContain(`| \`${check}\` |`);
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
      // The flag that carries the decision count out of the diagnosis and into
      // the marking step. Same shape as the skip list above: the producer is a
      // script and the consumer is this shell, with nothing joining them, so a
      // rename on either side leaves the marking reading an absent file — and
      // the marking step's own refusal is what turns that into a red rather
      // than a PR silently marked clean.
      expect(
        readFileSync(join(REPO_ROOT, 'scripts/diagnose-schema-refresh.mjs'), 'utf8')
      ).toContain('--decision-count-out');
      expect(diagnose).toContain('--decision-count-out');
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
      // The SPACE form: `--skipped-log=...` is read too now, but the workflow
      // writes the space form and a bare `toContain` accepted either — the
      // sibling pins for `--nested-key-rc` and `--failed-checks` already
      // require the space form and its variable.
      expect(shellOf('Diagnose what needs a decision')).toMatch(/--skipped-log \S/);
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

  it('RUNS the marking step: mark, re-mark and clear return the base title byte-for-byte', () => {
    // Executed, like the two regenerate cases above, and for the same reason:
    // the round trip is a BEHAVIOUR of four arms plus a title the step DERIVES
    // from the PR. Pattern-matching each half separately cannot see that the
    // third cycle hands back exactly the string the first one was given — which
    // is the whole claim "the same pattern produces and strips the suffix"
    // makes, and the one a drift between them breaks.
    const step = byName(MARK_STEP);
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-mark-'));
    try {
      const bin = join(dir, 'bin');
      const repo = join(dir, 'repo');
      mkdirSync(bin);
      mkdirSync(join(repo, 'docs'), { recursive: true });

      // The step names ABSOLUTE `/tmp` paths, which are shared: two suites
      // running at once would grade each other's counts, and a failure would
      // read as flakiness. The PREFIX is redirected into the sandbox rather
      // than the filename, so a rename of the count file still flows through
      // to `countPath` below instead of silently testing a stale path.
      const shell = shellOf(MARK_STEP).split('/tmp/').join(`${dir}/`);
      const countPath = shell.match(/\[ ! -s (\S+) \]/)?.[1];
      expect(countPath, 'the step no longer probes a decision-count file').toBeDefined();
      writeFileSync(join(dir, 'mark.sh'), `${shell}\n`);

      // A `gh` that RECORDS what it was asked and answers the three reads off
      // files, so a PATCH is observable as the next read's answer.
      const gh = [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$GH_LOG"',
        'case "$1 $2" in',
        '  "pr view")',
        '    case "$*" in',
        '      *"--json state"*) cat "$GH_STATE"; exit 0 ;;',
        '      *"--json title"*) cat "$GH_TITLE"; exit 0 ;;',
        '      *"--json body"*) cat "$GH_BODY"; exit 0 ;;',
        '    esac',
        '    exit 1 ;;',
        '  "api -X")',
        '    for a in "$@"; do',
        '      case "$a" in',
        '        title=*) printf "%s" "${a#title=}" > "$GH_TITLE" ;;',
        '        body=@*) cat "${a#body=@}" > "$GH_BODY" ;;',
        '      esac',
        '    done',
        '    exit 0 ;;',
        'esac',
        'exit 0',
      ].join('\n');
      writeFileSync(join(bin, 'gh'), `${gh}\n`, { mode: 0o755 });

      // A real repository as cwd, so the no-drift arm's `git status` probe has
      // something to answer about and the clean/dirty halves are controllable.
      const git = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: repo,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
          },
        });
      writeFileSync(join(repo, 'docs', 'kept.md'), 'kept\n');
      git('init', '-q', '-b', 'main');
      git('add', '-A');
      git(
        '-c',
        'user.email=bot@example.com',
        '-c',
        'user.name=bot',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'seed'
      );

      // The step's own `env:` block, with only the `${{ }}`-valued entries
      // supplied by the harness — the literals (label, markers) come from the
      // workflow, so a reworded marker is exercised rather than mirrored.
      /** The two values of the `published` axis, named so the arms read. */
      const PUBLISHED = '4242';
      const NOTHING_PUBLISHED = '';

      const HARNESS: Record<string, string> = {
        GH_TOKEN: 'stub-token',
        OPEN_PR: '',
      };
      // `published` is the ONLY axis the step sees for this: the clamp keys on
      // `PUBLISHED_PR`, so "AWS did not move" and "Publish lost the push race"
      // are the same input here — which is the point of keying on it, since the
      // retired drift-flag predicate told them apart and let the race through.
      const envFor = (published: string) => {
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(step.env ?? {})) {
          if (!value.includes('${{')) {
            out[key] = value;
            continue;
          }
          // Only `PUBLISHED_PR` varies; the rest come from `HARNESS`.
          const supplied = key === 'PUBLISHED_PR' ? published : HARNESS[key];
          expect(
            supplied,
            `env ${key} is expression-valued and this harness has no value for it`
          ).toBeDefined();
          out[key] = supplied!;
        }
        return out;
      };

      const ghLog = join(dir, 'gh.log');
      const stateFile = join(dir, 'state');
      const titleFile = join(dir, 'title');
      const bodyFile = join(dir, 'body');
      const BASE = 'chore(schemas): refresh CFn schema fixtures (2026-09-07)';
      const PREAMBLE = 'The preamble a human wrote.';
      writeFileSync(stateFile, 'OPEN\n');
      writeFileSync(titleFile, BASE);
      writeFileSync(bodyFile, `${PREAMBLE}\n\n## What needs a decision\n\n- something\n`);

      const run = (decisions: string, published: string) => {
        writeFileSync(countPath!, `${decisions}\n`);
        writeFileSync(ghLog, '');
        const res = spawnSync('bash', [join(dir, 'mark.sh')], {
          cwd: repo,
          encoding: 'utf8',
          env: {
            PATH: `${bin}:${process.env['PATH'] ?? ''}`,
            HOME: dir,
            TMPDIR: dir,
            GH_LOG: ghLog,
            GH_STATE: stateFile,
            GH_TITLE: titleFile,
            GH_BODY: bodyFile,
            GITHUB_REPOSITORY: 'go-to-k/cdkd',
            GITHUB_REPOSITORY_OWNER: 'go-to-k',
            ...envFor(published),
          },
        });
        expect(
          res.status,
          `the step exited ${res.status}: ${res.stdout}${res.stderr}`
        ).toBe(0);
        return {
          title: readFileSync(titleFile, 'utf8'),
          body: readFileSync(bodyFile, 'utf8'),
          gh: readFileSync(ghLog, 'utf8').split('\n').filter(Boolean),
        };
      };
      const begin = step.env!['VERDICT_BEGIN']!;
      const end = step.env!['VERDICT_END']!;
      const count = (body: string, line: string) =>
        body.split('\n').filter((l) => l === line).length;

      // 1. A drift cycle carrying two decisions.
      const two = run('2', PUBLISHED);
      expect(two.title).toBe(`${BASE} — 2 decisions needed`);
      expect(two.body.split('\n')[0], 'the verdict block is not at the top').toBe(begin);
      expect(two.body).toContain('2 decisions need your call');
      expect(two.body, 'the human half of the body was overwritten').toContain(PREAMBLE);
      // ORDER, observed rather than read: only the assignment notifies, so it
      // goes first. Independence is the `marks_failed` collection, asserted
      // statically above; this arm pins that the preference is actually
      // honoured at runtime rather than only in the source order.
      const assignAt = two.gh.findIndex((l) => l.includes('--add-assignee'));
      const labelAt = two.gh.findIndex((l) => l.includes('--add-label'));
      expect(assignAt, 'no assignment was issued at 2 decisions').toBeGreaterThan(-1);
      expect(labelAt, 'no label was added at 2 decisions').toBeGreaterThan(-1);
      expect(assignAt, 'the label call ran before the assignment').toBeLessThan(labelAt);

      // 2. The additive path: re-marked from the title the FIRST run wrote,
      // with nothing threading the base in.
      const one = run('1', PUBLISHED);
      expect(one.title).toBe(`${BASE} — 1 decision needed`);
      expect(one.body).toContain('1 decision needs your call');
      expect(one.body, 'the stale verdict survived the re-mark').not.toContain(
        '2 decisions need your call'
      );
      expect(count(one.body, begin), 'the verdict block accumulated').toBe(1);
      expect(count(one.body, end), 'the verdict block accumulated').toBe(1);
      expect(one.body, 'the human half was lost on the second write').toContain(PREAMBLE);

      // 3. Settled. The title returns to its exact original bytes, the label
      // goes, and the assignee STAYS — it is still theirs to merge.
      const zero = run('0', PUBLISHED);
      expect(zero.title, 'the round trip did not restore the base title').toBe(BASE);
      expect(zero.body).toContain('No decisions outstanding');
      expect(count(zero.body, begin)).toBe(1);
      expect(
        zero.gh.some((l) => l.includes('--remove-label')),
        'the label was not cleared at zero'
      ).toBe(true);
      expect(
        zero.gh.some((l) => l.includes('--add-assignee')),
        'a settled PR was assigned again'
      ).toBe(false);
      expect(
        zero.gh.some((l) => l.includes('--add-label')),
        'a settled PR was labelled again'
      ).toBe(false);

      // 4. The no-drift arm over a tree the regeneration changed: the PR's own
      // CI builds the COMMITTED tree, so clearing here would advertise green
      // over a red PR. Nothing is written at all.
      writeFileSync(join(repo, 'docs', 'regenerated.md'), 'changed\n');
      const dirty = run('0', NOTHING_PUBLISHED);
      expect(
        dirty.gh.filter((l) => l.startsWith('pr edit') || l.startsWith('api ')),
        'the un-regenerated tree was marked anyway'
      ).toEqual([]);
      // And the same call over a CLEAN tree does proceed — without this the
      // assertion above is satisfied by any refusal, including a broken one.
      rmSync(join(repo, 'docs', 'regenerated.md'));
      const clean = run('0', NOTHING_PUBLISHED);
      expect(
        clean.gh.some((l) => l.includes('--remove-label')),
        'the clean no-publish arm never reaches the marking'
      ).toBe(true);

      // 5. A CRLF body — what GitHub stores after any edit made in the WEB UI,
      // which is the recovery path the workflow's own warnings tell a human to
      // take. The markers are located with `grep -Fx`, which wants a byte-exact
      // whole line, so without the `tr -d '\r'` both counts come back 0, the
      // step lands on the INSERT arm and prepends a SECOND verdict block — one
      // more per cycle, the body growth the line-number splice exists to stop.
      //
      // Asserted through the STEP rather than by matching the pipeline's
      // spelling: the chain that matters is strip → locate → replace, and a
      // regex on `tr -d` says only that one link is present.
      const crlf = `${begin}\r\n> **9 decisions need your call.** stale\r\n${end}\r\n\r\n## Summary\r\n\r\nHuman prose.\r\n`;
      writeFileSync(bodyFile, crlf);
      writeFileSync(titleFile, `${BASE}\n`);
      const crlfRun = run('2', PUBLISHED);
      // TRIMMED, because the untrimmed count is vacuous for the mutation it
      // names: with the strip removed the duplicate block's old marker keeps
      // its `\r`, so it is not equal to `begin` and the count is 1 either way
      // (measured). And the written body must carry no CR at all — that is
      // what says the strip happened rather than that one comparison happened
      // to line up.
      expect(
        crlfRun.body.split('\n').filter((l) => l.trim() === begin).length,
        'a CRLF body grew a second verdict block'
      ).toBe(1);
      expect(crlfRun.body, 'the CR survived into the written body').not.toContain('\r');
      expect(crlfRun.body, 'the stale verdict survived a CRLF body').not.toContain('stale');
      expect(crlfRun.body, 'the human half of a CRLF body was lost').toContain('Human prose.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('denies permissions at the top level and grants them per job', () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(workflow).toMatch(/^\s+contents: write$/m);
    expect(workflow).toMatch(/^\s+pull-requests: write$/m);
    // `issues: write` used to be asserted PRESENT here, for the umbrella fold.
    // That fold now lives in `backfill-umbrella-sync.yml`, so the scope is
    // asserted ABSENT instead — and the two directions are held together by
    // the same anti-vacuity floor as before, one polarity over: the permission
    // may be gone only while no step actually calls the issue API.
    //
    // Derived from the SHELL BODIES, not the raw file. Over the raw file the
    // floor was itself vacuous: the workflow header cites an
    // `.../issues/2718` URL and a rationale comment names `gh issue`, so it
    // could never fire. An anti-vacuity guard that is vacuous is the defect
    // class this file is about, in the guard against it.
    const named = steps.filter((st) => st.name && st.run);
    const bodies = named.map((st) => shellOf(st.name!));
    // The FLOOR, which the polarity flip destroyed: with the assertion below
    // reading `.toBe(false)`, an empty `shellBodies` — a broken `steps`, a
    // `shellOf` that stopped stripping, a renamed job — passes it. So the
    // subject is proved to EXIST before its absence-of-`gh issue` is believed.
    // (In the `issues: write`-present era the floor was free: `.toBe(true)`
    // cannot be satisfied by nothing.)
    expect(named.length, 'no named shell steps found — the parse broke, not the workflow').toBeGreaterThanOrEqual(6);
    for (const st of named) {
      expect(
        shellOf(st.name!).trim().length,
        `${st.name}: its shell reads as empty — shellOf is stripping everything`
      ).toBeGreaterThan(0);
    }
    const shellBodies = bodies.join('\n');
    expect(
      shellBodies.length,
      'the collected shell bodies are too small to be this job'
    ).toBeGreaterThan(2000);
    // Positive anchors: the bodies really are THIS job's shell, so a scan that
    // silently reads some other file cannot clear the negative below.
    expect(shellBodies, 'the open-PR guard is not among the scanned bodies').toContain('gh pr list');
    expect(shellBodies, 'the publish step is not among the scanned bodies').toContain(
      'gh pr create'
    );
    const usesIssueApi = /gh issue |\/issues\//.test(shellBodies);
    expect(
      usesIssueApi,
      'a step calls the issue API again — it needs issues: write back, or it belongs in backfill-umbrella-sync.yml'
    ).toBe(false);
    expect(workflow, 'issues: write is back without a caller').not.toMatch(/^\s+issues: write$/m);
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

  it('writes the diagnosis into the BODY only at creation, and as a COMMENT thereafter', () => {
    // `divergenceProcedure`'s unresolved block tells the reader this section is
    // never updated in place and to read the newest COMMENT for a current
    // answer. That is a claim about THIS file, made from another one, and it
    // was wrong twice in a row: first "re-run the job" (the fresh reading is
    // computed and discarded on an idle cycle), then "the body is rewritten
    // only on a cycle that publishes" (no cycle rewrites it at all). Six
    // consecutive review rounds found a defect of exactly this shape — a
    // sentence asserting a mechanism that lives somewhere else — so the claim
    // gets a fence rather than a third careful rewrite.
    //
    // Change the workflow's surfacing and this reds, naming the prose to fix.
    // (i) The day-one reading goes into the BODY, composed from the diagnosis.
    // Dropping the `cat` would leave the body without it while every call shape
    // below stayed identical.
    const body = workflow.match(/gh pr create[\s\S]{0,400}?--body-file (\S+)/);
    expect(body, 'the PR is no longer created with a --body-file').not.toBeNull();
    expect(body![1]).toBe('/tmp/pr-body.md');
    expect(workflow, 'the created body no longer carries the diagnosis').toContain(
      'cat /tmp/diagnosis.md'
    );

    // (ii) A later publishing cycle posts a COMMENT — exactly one poster,
    // UNCONDITIONALLY, on the push-SUCCESS half. All three matter: a second
    // poster, an `&&` in front of the one, or moving it into the failure arm
    // each makes "each later publishing cycle posts its own as a new comment"
    // false while every call shape stays identical (all three measured green
    // against the earlier form of this case).
    expect([...workflow.matchAll(/gh pr comment/g)].length, 'not exactly one poster').toBe(1);
    const publish = shellOf('Publish the refresh');
    const pushAt = publish.indexOf('if git push');
    expect(pushAt, 'the push guard is gone').toBeGreaterThan(-1);
    const thenAt = publish.indexOf('then', pushAt);
    expect(thenAt, 'the push guard opens no arm').toBeGreaterThan(-1);
    // Bounded by the arm's own `else`, NOT by `guardArm`: that helper ends at
    // the first line-leading `fi`, which here is the INNER lost-race one inside
    // the failure arm — so its slice spanned BOTH halves and a poster moved to
    // the failure arm still satisfied `toContain` (measured).
    const elseOffset = publish.slice(thenAt).search(/\n\s*else\b/);
    expect(elseOffset, 'the push guard has no else arm to bound the success half').toBeGreaterThan(
      -1
    );
    const successArm = publish.slice(thenAt, thenAt + elseOffset);
    expect(successArm, 'the diagnosis comment left the push-SUCCESS arm').toContain('gh pr comment');
    expect(
      successArm.slice(0, successArm.indexOf('gh pr comment')),
      'the diagnosis comment picked up a condition of its own'
    ).not.toMatch(/&&|\|\||\bif\b/);
    const comment = workflow.match(/gh pr comment[\s\S]{0,200}?--body-file (\S+)/);
    expect(comment, 'the later-cycle diagnosis is no longer posted as a comment').not.toBeNull();
    expect(comment![1]).toBe('/tmp/diagnosis.md');

    // (iii) Nothing rewrites a rendering in place. The only later body write is
    // the marking step's `${NB}`, and what matters is what `${NB}` is built
    // FROM: the body just fetched into `${B}` plus the verdict block. Asserting
    // that the marker NAMES appear somewhere constrains nothing — they are
    // `env:` entries — so splicing the current diagnosis into `${verdict}`, or
    // regenerating the whole body from the preamble plus the diagnosis, both
    // stayed green (measured).
    const mark = shellOf('Mark whether the PR needs a decision');
    expect(mark, 'the marking step now reads the diagnosis — it would rewrite it in place').not.toContain(
      '/tmp/diagnosis.md'
    );
    expect(mark, 'the splice no longer takes the head of the FETCHED body').toContain(
      'head -n "${vb}" "${B}"'
    );
    expect(mark, 'the splice no longer takes the tail of the FETCHED body').toContain(
      'tail -n "+${ve}" "${B}"'
    );
    expect(mark, 'the marking step no longer fetches the body it edits').toContain(
      'gh pr view "${pr}" --json body'
    );

    // ALLOW-LIST, not a deny-list, and the polarity is the whole point.
    //
    // Four consecutive review rounds defeated the deny-list forms of this
    // check, each fix moving the hole one spelling over: `--field "body=@…"`
    // only; then `--field`/`-f` while `gh api` spells the same two flags FOUR
    // ways and `-F` is the short form of the one already in use; then a payload
    // matcher, which `gh pr comment --edit-last` walks past (same call shape, no
    // payload — it changes the VERB) and `gh api --input file.json` walks past
    // (the payload is JSON `body:`, never argv `body=`). The set of ways to
    // rewrite a rendering in place is not enumerable, so stop enumerating it.
    //
    // Every `gh` invocation in the two steps is pinned instead. A new call, a
    // new flag on an existing one, or a changed target all red — including
    // every falsification above, without naming any of them. The cost is that
    // an unrelated edit to these steps reds too: that is intended, because the
    // prose in `divergenceProcedure` describes exactly this surfacing and has
    // to be re-read when it changes.
    // QUOTE-AWARE, not line-prefix-filtered. The first cut dropped every line
    // starting with `echo`, because two error messages quote a `gh label
    // create` suggestion — and that hid any call sharing a line with one:
    // `echo "refreshing body" && gh pr edit "${PR_NUMBER}" --body-file
    // /tmp/diagnosis.md` rewrote the body every cycle and stayed GREEN
    // (measured). Scanning quotes instead means a `gh` inside a string is never
    // a call and a `gh` outside one always is, whatever precedes it.
    const ghCalls = (shell: string) => {
      const src = shell.replace(/\\\n\s*/g, ' ');
      const calls: string[] = [];
      let quote: string | null = null;
      let start = -1;
      const flush = (end: number) => {
        if (start === -1) return;
        calls.push(src.slice(start, end).replace(/\s+/g, ' ').trim());
        start = -1;
      };
      for (let i = 0; i < src.length; i++) {
        const c = src[i]!;
        if (quote) {
          if (c === '\\' && quote === '"') i++;
          else if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'") {
          quote = c;
          continue;
        }
        if (start === -1 && src.startsWith('gh ', i) && (i === 0 || /[\s;&|(]/.test(src[i - 1]!))) {
          start = i;
          i += 2;
          continue;
        }
        if (start !== -1 && (c === '\n' || c === '|' || c === ';' || c === '&')) flush(i);
      }
      flush(src.length);
      return calls.sort();
    };

    expect(ghCalls(publish), 'the publish step gained, lost or altered a gh call').toEqual([
      'gh pr comment "${PR_NUMBER}" --body-file /tmp/diagnosis.md',
      'gh pr create --title "chore(schemas): refresh CFn schema fixtures (${cycle})" --body-file /tmp/pr-body.md --head "${branch}" --base main',
      'gh pr list --head "${branch}" --state open --json number --jq \'.[0].number // empty\')',
      'gh pr view "${PR_NUMBER}" --json state --jq .state)',
    ]);
    expect(ghCalls(mark), 'the marking step gained, lost or altered a gh call').toEqual([
      'gh api -X PATCH "repos/${GITHUB_REPOSITORY}/pulls/${pr}" --field "body=@${NB}" > /dev/null',
      'gh api -X PATCH "repos/${GITHUB_REPOSITORY}/pulls/${pr}" -f title="${title}" > /dev/null',
      'gh pr edit "${pr}" --add-assignee "${GITHUB_REPOSITORY_OWNER}"',
      'gh pr edit "${pr}" --add-label "${DECISION_LABEL}"',
      'gh pr edit "${pr}" --remove-label "${DECISION_LABEL}"',
      'gh pr view "${pr}" --json body --jq .body',
      'gh pr view "${pr}" --json state --jq .state)',
      'gh pr view "${pr}" --json title --jq .title)',
    ]);
  });
});
