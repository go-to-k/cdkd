/**
 * Issue [#3005](https://github.com/go-to-k/cdkd/issues/3005) — a schema-refresh
 * pull request carrying outstanding decisions must not be mergeable.
 *
 * WHAT THIS PINS, AND WHY IT IS NOT THE GATE THE ISSUE ASKED FOR.
 *
 * #3005 proposed a new CI job that fails while `countDecisions`'s number is
 * non-zero, on the grounds that nothing structural stopped a web-UI merge or an
 * auto-merge — only a REQUIRED status check binds there, and at filing time
 * (2026-09-11T10:01Z) the repository had none that a red fixture check reached.
 * go-to-k/cdkd#2999 landed the `ci-ok` aggregate less than two hours later and
 * made it the required check, which closes the hole by a different mechanism:
 * every term `countDecisions` can raise ALSO reds `check-build-test`, and
 * `ci-ok` waits on that job. So a decision-carrying refresh PR is unmergeable
 * in BOTH of the states it is ever in — held at `action_required`, where a
 * required check that has not reported blocks the merge button, and approved
 * and run, where it reports red — and the decision-count job would be a second
 * required check answering the same question, the duplication #3005 itself
 * argued against.
 *
 * That closure is EMERGENT, not designed, and this file is what keeps it true.
 * Nothing else relates the two workflows: `cfn-schema-refresh.yml` grades a
 * refresh with its own check list, `ci.yml` grades the branch with its own, and
 * a check added to the first and forgotten in the second re-opens the hole
 * SILENTLY — the refresh would count a decision that reddens nothing, which is
 * exactly the class #3005 says is worse than the nested-key one (it merges
 * cleanly and drops a real finding on the floor).
 *
 * The three populations below are DERIVED rather than listed, so each of the
 * three ways the invariant can break fails here first:
 *
 *   1. a new decision TERM in `countDecisions` with no CI check behind it —
 *      the term names come out of the shipped function itself;
 *   2. a new `run_check` in the refresh that `ci.yml` does not run — the check
 *      names come out of the refresh workflow's own shell;
 *   3. a check dropped from `check-build-test`, or `check-build-test` dropped
 *      from `ci-ok`'s `needs:` — both read out of `ci.yml`.
 *
 * It does NOT claim the two gradings are numerically equal. `ci.yml` is allowed
 * to be red where the refresh counts zero (it runs far more checks); the
 * direction that matters — and the only one asserted — is that nothing the
 * refresh counts can leave CI green.
 *
 * ONE TERM IS HONESTLY NOT COVERED, and `UNCOVERED_TERMS` says so rather than
 * being folded into a tidy table. Writing a rationale for a term nothing
 * reddens would have been the same defect #3005 reports, one level up: a fence
 * asserting a coverage that does not exist. The residual is stated there and in
 * the issue, and a NEW term must be classified into one bucket or the other —
 * neither is a default.
 *
 * The sibling `cfn-schema-refresh-workflow.test.ts` owns the refresh workflow's
 * internal invariants (including `run_check` vs `CHECK_GUIDANCE`), and
 * `ci-ok-gate.test.ts` owns `ci-ok`'s own shape. Neither can see the relation
 * between the two files, which is this file's whole subject.
 */
import { describe, it, expect } from 'vite-plus/test';
import { countDecisions } from '../../../scripts/diagnose-schema-refresh.mjs';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REFRESH_PATH = join(REPO_ROOT, '.github', 'workflows', 'cfn-schema-refresh.yml');
const CI_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

const refreshText = readFileSync(REFRESH_PATH, 'utf8');
const ciText = readFileSync(CI_PATH, 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const refresh: any = parseYaml(refreshText);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ci: any = parseYaml(ciText);

/** The `ci.yml` job every fixture-driven check runs in. */
const CI_CHECK_JOB = 'check-build-test';
/** The aggregate job that IS the required status check on `main`. */
const CI_GATE_JOB = 'ci-ok';
/** The refresh step whose `run_check` calls grade a refresh. */
const REGENERATE_STEP = 'Regenerate the derived artifacts';
/** The refresh step that runs the nested-key critic and renders the count. */
const DIAGNOSE_STEP = 'Diagnose what needs a decision';

type Step = { name?: string; run?: string; uses?: string };

const stepsOf = (workflow: unknown, job: string): Step[] => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const steps = (workflow as any).jobs?.[job]?.steps;
  expect(Array.isArray(steps), `no job named ${JSON.stringify(job)} — renamed or deleted`).toBe(
    true
  );
  return steps as Step[];
};

/**
 * A refresh step's shell with `#` comment lines removed.
 *
 * Load-bearing rather than tidiness: this workflow's comments quote the very
 * task names its shell runs (the `run_check` block explains each check it
 * collects), so a comment-inclusive scan invents `run_check` names and the
 * derived population stops being the executed one. The sibling
 * `cfn-schema-refresh-workflow.test.ts` strips for the mirror-image reason —
 * there the comments quote WRONG forms that negative assertions would read as
 * defects.
 */
const refreshShell = (name: string): string => {
  const step = stepsOf(refresh, 'refresh').find((s) => s.name === name);
  expect(step, `no refresh step named ${JSON.stringify(name)} — renamed or deleted`).toBeDefined();
  return step!
    .run!.split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
};

/**
 * Every check the refresh GRADES a cycle with: the `run_check` names from
 * `Regenerate`, plus the critic `Diagnose` runs for itself.
 *
 * Both halves are needed and neither is the other's superset. `run_check`
 * populates `failedChecks`; the nested-key critic is invoked separately (its
 * non-zero exit is the expected hand-off, so it cannot ride the collector) and
 * populates `divergences`, `nestedKeyUnparsed` and `pendingSdkBump`.
 */
const gradedChecks = (): string[] => {
  const fromRunCheck = [...refreshShell(REGENERATE_STEP).matchAll(/^\s*run_check (\S+)/gm)].map(
    (m) => m[1]!
  );
  const fromDiagnose = [...refreshShell(DIAGNOSE_STEP).matchAll(/\bvp run (\S+)/g)].map((m) => m[1]!);
  return [...new Set([...fromRunCheck, ...fromDiagnose])];
};

/**
 * The command `ci.yml` covers each graded check with, and which decision terms
 * ride on it.
 *
 * Keyed by the refresh's OWN check name and asserted set-equal to the derived
 * population, so a `run_check` added to the refresh fails here until somebody
 * decides how CI reaches it. That forced decision is the entire mechanism —
 * the invariant cannot be preserved by a reviewer remembering it.
 *
 * `covers` names terms of `countDecisions`, not prose: the term list is derived
 * from the shipped function below, and every term must appear here at least
 * once.
 */
const CI_COVERAGE: Record<string, { command: string; covers: string[]; why: string }> = {
  'property-coverage': {
    command: 'vp run test',
    covers: ['removed', 'failedChecks'],
    why:
      'An unsettled removal leaves a provider declaring a property the schema no longer has, and ' +
      'tests/unit/provisioning/property-coverage.test.ts fails that classification unless it is in ' +
      "_todo-backfill.json's bogusTolerated — which the refresh's writer mode PRESERVES and never " +
      'adds to. It reaches CI through the whole unit suite rather than a task of its own.',
  },
  'audit:sdk-attr-coverage:check': {
    command: 'vp run audit:sdk-attr-coverage:check',
    covers: ['failedChecks'],
    why: 'Same task, run as its own step.',
  },
  'audit:enrichment-coverage:check': {
    command: 'vp run audit:enrichment-coverage:check',
    covers: ['failedChecks'],
    why: 'Same task, run as its own step.',
  },
  'fixture-consumer-tests': {
    command: 'vp run test',
    covers: ['failedChecks'],
    why:
      'The refresh names seven fixture-reading suites explicitly because it has no whole-suite ' +
      'run; CI has one, so every member is reached without naming any of them. The sibling suite ' +
      'fences the refresh-side list against the silentDrop family.',
  },
  'audit:nested-key-coverage:check': {
    command: 'vp run audit:nested-key-coverage:check',
    covers: ['divergences', 'nestedKeyUnparsed', 'pendingSdkBump'],
    why:
      'The critic exits 1 on any divergence outside NESTED_KEY_ALLOW_LIST. pendingSdkBump rides ' +
      'it too: partitionPendingSdkBump moves such a finding out of `divergences` inside the ' +
      'DIAGNOSIS only, so the critic itself is still red for it. nestedKeyUnparsed has two ' +
      'disjuncts and both need the critic to be red: the zero-divergence one requires a non-zero ' +
      'rc (or the critic wording a failure), and the parser-shortfall one compares a strict ' +
      'against a loose parse of the SAME log, so it can only fire over finding-shaped lines the ' +
      'critic PRINTED — which it does on its failing path, its --check clean path emitting one ' +
      'summary line and no finding.',
  },
};

/**
 * Terms nothing in `ci.yml` reddens, each with the reason it is accepted.
 *
 * Asserted to be EXACTLY this set, so a new uncovered term is a decision
 * somebody made rather than a gap that accumulated — and asserted disjoint from
 * everything `CI_COVERAGE` claims, so a term cannot be both excused here and
 * counted as protected there.
 */
const UNCOVERED_TERMS: Record<string, string> = {
  unreadable: [
    'Not a schema decision — it is the DIAGNOSIS failing to read its own input. `committedVersion`',
    'sets it when `git show HEAD:<fixture>` fails for a reason that is NOT "path not in HEAD", so',
    'the fixture in the working tree (the copy CI parses) is fine and every fixture-driven check',
    'stays green. Accepted rather than mechanised because the arms that reach it break the refresh',
    'run as a whole rather than describing anything about a schema: git absent, a broken',
    'repository, or the 32 MB `maxBuffer` — which the corpus is three orders of magnitude short of',
    '(largest fixture 68,594 B over 135 files, measured 2026-09-12). It is also loud where it',
    'happens: the diagnosis renders the unreadable fixtures by name in the PR body it is counted',
    'in. Recorded on go-to-k/cdkd#3005 as the residual of closing it.',
  ].join(' '),
};

/**
 * The decision terms, read off the SHIPPED function rather than listed.
 *
 * `countDecisions` destructures its input, so the parameter names ARE the
 * terms. A seventh term added there lands in this set with no entry in
 * `CI_COVERAGE`'s `covers` and fails — which is the point: a decision class
 * nothing reddens is the exact defect #3005 reports.
 */
const decisionTerms = (): string[] => {
  const source = countDecisions.toString();
  const destructuring = source.match(/\(\s*\{([\s\S]*?)\}\s*\)/);
  expect(
    destructuring,
    'countDecisions no longer destructures its input — the term list cannot be derived from it, ' +
      'so this fence would silently stop watching for a new decision class'
  ).not.toBeNull();
  return [...destructuring![1]!.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*(?:=|,|$)/gm)].map(
    (m) => m[1]!
  );
};

/**
 * The commands a `ci.yml` job runs, one per line, comments stripped.
 *
 * Lines rather than whole `run:` blocks: most checks are a single-line step,
 * but `vp run test` sits inside a multi-line block with a pipefail guard around
 * it, and a whole-block `includes` would also match a task named only in that
 * block's error message.
 */
const ciCommandLines = (job: string): string[] =>
  stepsOf(ci, job)
    .flatMap((s) => (s.run ?? '').split('\n'))
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

describe('a refresh PR carrying decisions cannot pass ci-ok (issue #3005)', () => {
  it('is not vacuous — both workflows exist and parse', () => {
    expect(refreshText.length).toBeGreaterThan(5000);
    expect(ciText.length).toBeGreaterThan(5000);
    expect(Object.keys(ci.jobs ?? {})).toContain(CI_CHECK_JOB);
    expect(Object.keys(ci.jobs ?? {})).toContain(CI_GATE_JOB);
    expect(Object.keys(refresh.jobs ?? {})).toContain('refresh');
  });

  it('derives a real graded-check population from the refresh workflow', () => {
    const graded = gradedChecks();
    // Four `run_check` names plus the separately-invoked nested-key critic. A
    // literal, not a relation to CI_COVERAGE's size — a floor computed from the
    // thing it guards is satisfied by the collapse it exists to catch.
    expect(graded.length, `graded checks derived: ${JSON.stringify(graded)}`).toBeGreaterThanOrEqual(
      5
    );
    expect(graded).toContain('audit:nested-key-coverage:check');
  });

  it('derives a real decision-term population from the shipped countDecisions', () => {
    const terms = decisionTerms();
    expect(terms.length, `terms derived: ${JSON.stringify(terms)}`).toBeGreaterThanOrEqual(6);
    // Named anchors, so a destructuring that parses into plausible-but-wrong
    // identifiers (the shape a regex change produces) fails rather than
    // yielding a set that happens to clear the floor.
    for (const anchor of ['removed', 'divergences', 'failedChecks']) {
      expect(terms, `countDecisions no longer counts ${anchor}`).toContain(anchor);
    }
  });

  it('maps EVERY check the refresh grades to a command ci.yml runs', () => {
    // Set equality in both directions. A `run_check` added to the refresh has
    // no entry here and fails; an entry left behind after its check is retired
    // fails too, so the table cannot rot into a claim about checks that no
    // longer exist.
    expect(new Set(Object.keys(CI_COVERAGE))).toEqual(new Set(gradedChecks()));
  });

  it('runs every mapped command inside check-build-test', () => {
    const lines = ciCommandLines(CI_CHECK_JOB);
    for (const [check, { command }] of Object.entries(CI_COVERAGE)) {
      const found = lines.some((l) => l === command || l.startsWith(`${command} `));
      expect(
        found,
        `${CI_CHECK_JOB} no longer runs ${JSON.stringify(command)}, so the refresh's ` +
          `${JSON.stringify(check)} grading has nothing behind it in CI — a decision of that class ` +
          'would leave ci-ok green and the merge button live'
      ).toBe(true);
    }
  });

  it('runs the unit suite UNFILTERED, which is what reaches the unnamed suites', () => {
    // Two entries lean on `vp run test` covering suites CI never names. That is
    // only true while the invocation carries no filter: `vp run test <name>`
    // would still match a bare `startsWith` and cover nothing.
    const invocations = ciCommandLines(CI_CHECK_JOB)
      .filter((l) => /^vp run test\b/.test(l))
      // Everything up to the first pipe is the command. Redirections are not
      // arguments to it, and are dropped token-wise rather than by a regex over
      // the whole line: a pattern with a trailing `\S*` also eats the token
      // AFTER a redirection, which is a filter name whenever one follows — the
      // fence would then read a filtered run as unfiltered, the one direction
      // it must never be wrong in.
      .map((line) => {
        const tokens = line.split('|')[0]!.trim().split(/\s+/);
        const kept: string[] = [];
        for (let i = 0; i < tokens.length; i++) {
          const token = tokens[i]!;
          if (!/[<>]/.test(token)) {
            kept.push(token);
            continue;
          }
          // A bare operator (`>`, `2>`) takes its target from the NEXT token;
          // an attached one (`2>&1`, `>out.log`) carries it already.
          if (/[<>]&?$/.test(token)) i++;
        }
        return kept.join(' ');
      });
    expect(
      invocations,
      'check-build-test has no `vp run test` invocation, so the suites CI never names by ' +
        'filename are not run at all'
    ).not.toHaveLength(0);
    expect(
      invocations,
      `every \`vp run test\` in ${CI_CHECK_JOB} must be the whole suite; a filtered one covers ` +
        'only what it names'
    ).toEqual(invocations.map(() => 'vp run test'));
  });

  it('classifies EVERY decision term as CI-covered or knowingly uncovered', () => {
    const covered = new Set(Object.values(CI_COVERAGE).flatMap((e) => e.covers));
    for (const term of decisionTerms()) {
      expect(
        covered.has(term) || term in UNCOVERED_TERMS,
        `countDecisions counts ${JSON.stringify(term)} and nothing here accounts for it. Either ` +
          'name the CI check that reddens for it in CI_COVERAGE, or add it to UNCOVERED_TERMS ' +
          'with the reason — leaving it unclassified means a refresh PR carrying that decision ' +
          'class merges on a green ci-ok, which is issue #3005.'
      ).toBe(true);
    }
  });

  it('keeps the uncovered set exactly what was decided, with a real reason each', () => {
    // Pinned by NAME, not by size: a second uncovered term slipping in under a
    // count is the accumulation this bucket exists to prevent.
    expect(Object.keys(UNCOVERED_TERMS)).toEqual(['unreadable']);
    for (const [term, reason] of Object.entries(UNCOVERED_TERMS)) {
      expect(reason.length, `${term}'s exemption reason is a placeholder`).toBeGreaterThan(200);
    }
  });

  it('never excuses a term it also claims to cover', () => {
    // The two buckets answer the same question, so an overlap means one of them
    // is wrong and the reader cannot tell which.
    const covered = new Set(Object.values(CI_COVERAGE).flatMap((e) => e.covers));
    for (const term of Object.keys(UNCOVERED_TERMS)) {
      expect(
        covered.has(term),
        `${JSON.stringify(term)} is both excused in UNCOVERED_TERMS and claimed as covered in ` +
          'CI_COVERAGE'
      ).toBe(false);
    }
  });

  it('does not claim coverage for a term countDecisions stopped counting', () => {
    // The stale direction. A `covers` entry naming a retired term reads as
    // protection and is inert; it also silently weakens the previous case,
    // whose population is the live term list.
    const terms = new Set(decisionTerms());
    for (const [check, { covers }] of Object.entries(CI_COVERAGE)) {
      for (const term of covers) {
        expect(
          terms.has(term),
          `CI_COVERAGE[${JSON.stringify(check)}] claims to cover ${JSON.stringify(term)}, which ` +
            'countDecisions no longer counts'
        ).toBe(true);
      }
    }
    for (const term of Object.keys(UNCOVERED_TERMS)) {
      expect(
        terms.has(term),
        `UNCOVERED_TERMS excuses ${JSON.stringify(term)}, which countDecisions no longer counts — ` +
          'a standing exemption for a term that does not exist reads as a residual and is inert'
      ).toBe(true);
    }
  });

  it('keeps check-build-test in ci-ok’s needs, which is the link to the merge button', () => {
    // The last link in the chain, and the cheapest to break: a red
    // check-build-test only blocks a merge because ci-ok waits on it and ci-ok
    // is the required status check on `main`. `ci-ok-gate.test.ts` asserts the
    // needs list covers every job; this asserts the one membership THIS
    // invariant rests on, so the relation is stated where it is relied upon.
    const needs: string[] = ci.jobs[CI_GATE_JOB].needs;
    expect(Array.isArray(needs), `${CI_GATE_JOB} declares no needs list`).toBe(true);
    expect(needs).toContain(CI_CHECK_JOB);
  });
});
