import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Invariants of `.github/workflows/ci.yml`'s `ci-ok` job — the SINGLE status
 * check the `main` branch ruleset requires.
 *
 * Everything about this job is load-bearing in one direction: a green `ci-ok`
 * is what lets a merge through, and with auto-merge armed on the release PR and
 * on dependabot PRs there is no human reading the checks at the moment the
 * merge happens. So the failure that matters is not "the gate went red when it
 * should have been green" — that is loud and self-correcting — but "the gate
 * went GREEN having examined nothing", which is indistinguishable from a clean
 * run at every surface a human or a hook looks at.
 *
 * Three such vacuities are reachable and each has a case below.
 *
 *   1. A job is added to the file and not to `ci-ok`'s `needs:`. It is then
 *      outside the gate entirely and can be red under a green `ci-ok`.
 *   2. `if: always()` is dropped. `ci-ok` is then SKIPPED whenever an upstream
 *      job fails — and a skipped required check counts as PASSING, so the gate
 *      reports green exactly when CI is red.
 *   3. `RESULTS` renders empty. `for r in ${RESULTS}` runs zero times and the
 *      step exits 0. Measured before the floor was added: `results=""` gives
 *      `iterations=0 exit=0`. The `EXPECTED_UPSTREAM` count is the floor, and
 *      the count is only a floor while it EQUALS the `needs:` length, which is
 *      why that equality is asserted here rather than trusted to a comment.
 *
 * The shell is read out of the workflow and EXECUTED rather than pattern-
 * matched: a suite that greps for `EXPECTED_UPSTREAM` passes over a step whose
 * comparison was inverted. The YAML is parsed rather than sliced out of the
 * text, so a renamed step fails here as `undefined` instead of silently
 * matching nothing.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CI_YML = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const DOCS_DEPLOY_YML = join(REPO_ROOT, '.github', 'workflows', 'docs-deploy.yml');

const GATE_STEP = 'every upstream job succeeded or was skipped';

interface CiWorkflow {
  on?: Record<
    string,
    { paths?: unknown; 'paths-ignore'?: unknown; branches?: unknown; types?: unknown } | null
  >;
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string[];
      env?: Record<string, string>;
      permissions?: unknown;
      'continue-on-error'?: unknown;
      steps?: { name?: string; run?: string; if?: string; 'continue-on-error'?: unknown }[];
    }
  >;
}

function workflow(): CiWorkflow {
  return parseYaml(readFileSync(CI_YML, 'utf8')) as CiWorkflow;
}

/**
 * The `run:` body of `ci-ok`'s gate step, as the runner would execute it.
 * Selected BY NAME, not by index — inserting a step ahead of it would otherwise
 * silently retarget this extractor at the new step.
 */
function gateShell(): string {
  const step = workflow().jobs['ci-ok']?.steps?.find((s) => s.name === GATE_STEP);
  expect(
    step?.run,
    `ci-ok has no \`${GATE_STEP}\` step with a \`run:\` body in .github/workflows/ci.yml. ` +
      'If the step was renamed, update this extractor; if it was REMOVED, restore it — ' +
      'without it the sole required status check asserts nothing.'
  ).toBeTruthy();
  return step?.run as string;
}

function bareCondition(condition: string): string {
  return condition
    .trim()
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .trim();
}

/**
 * Whether a step `if:` is exempt from the unconditional-step rule.
 *
 * `always()` is exempt outright — the step runs on every path, so it can never
 * be the reason a job reported success having done nothing.
 *
 * `failure()` / `cancelled()` are exempt ONLY when the job carries at least one
 * UNCONDITIONAL step, and that qualifier is the whole point. A diagnostic dump
 * gated on `failure()` beside real work is correct code, and banning it refuses
 * a shape the sibling repos actually carry. But the SAME condition on a job's
 * only work — `- name: unit tests / if: failure() / run: vp test` — skips on
 * every green path while the job reports `success`, which is precisely the
 * vacuity ci-ok cannot see. An earlier cut exempted the two conditions
 * unconditionally and readmitted exactly that mutation.
 */
function isExemptStepCondition(condition: string, jobSteps: { if?: string }[]): boolean {
  const bare = bareCondition(condition);
  if (bare === 'always()') return true;
  if (bare !== 'failure()' && bare !== 'cancelled()') return false;
  return jobSteps.some((s) => s.if === undefined);
}

/**
 * Run the extracted step under bash with the two env vars the runner supplies,
 * returning its exit status.
 */
function gateStatus(results: string, expectedUpstream: string): number {
  try {
    execFileSync('bash', ['-c', gateShell()], {
      env: {
        ...process.env,
        RESULTS: results,
        EXPECTED_UPSTREAM: expectedUpstream,
      },
      stdio: 'pipe',
    });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

describe('ci-ok — the single required status check', () => {
  it('gates every other job in the workflow', () => {
    const jobs = workflow().jobs;
    const names = Object.keys(jobs);

    // Non-vacuity floor. With one job in the file the set equality below is
    // trivially satisfiable, and this suite would attest to nothing.
    expect(
      names.length,
      'ci.yml has fewer jobs than when this fence was written — re-read it before ' +
        'lowering this floor.'
    ).toBeGreaterThanOrEqual(5);

    const gated = new Set(jobs['ci-ok']?.needs ?? []);
    const ungated = names.filter((n) => n !== 'ci-ok' && !gated.has(n));
    expect(
      ungated,
      `these ci.yml jobs are not in ci-ok's \`needs:\`, so they are outside the merge ` +
        `gate and can be red while the required check is green: ${ungated.join(', ')}. ` +
        `Add them to \`needs:\` and bump EXPECTED_UPSTREAM.`
    ).toEqual([]);

    // The other direction: a `needs:` entry naming a job that no longer exists
    // makes the workflow invalid, which fails loudly — but it also silently
    // inflates EXPECTED_UPSTREAM's intended value, so pin it here too.
    const phantom = [...gated].filter((n) => !names.includes(n));
    expect(phantom, `ci-ok \`needs:\` names jobs that do not exist: ${phantom.join(', ')}`).toEqual(
      []
    );
  });

  it('runs even when an upstream job failed', () => {
    // Without `always()` the job is SKIPPED on an upstream failure, and a
    // skipped required check counts as PASSING.
    expect(workflow().jobs['ci-ok']?.if).toBe('always()');
  });

  it('declares the upstream count its shell checks against', () => {
    const job = workflow().jobs['ci-ok'];
    expect(job?.env?.['EXPECTED_UPSTREAM']).toBe(String(job?.needs?.length ?? -1));
  });

  it('lets the shell exit status decide the job', () => {
    // The suites below EXECUTE the extracted shell, so they attest that its
    // TEXT is correct — never that the runner acts on its exit status. Two
    // one-line additions sever that link and make the job report success with
    // nothing decided: `continue-on-error: true` (the failure stops failing the
    // job) and a step-level `if:` that is false (the step is skipped). Both
    // read as innocuous, and both reach the "green having examined nothing"
    // failure this file exists for.
    // `?? false` because an explicit `continue-on-error: false` is semantically
    // identical to its absence, and a fence that reds on it refuses a correct
    // spelling.
    const job = workflow().jobs['ci-ok'];
    const step = job?.steps?.find((s) => s.name === GATE_STEP);
    expect(step?.['continue-on-error'] ?? false).toBe(false);
    expect(step?.if).toBeUndefined();
    expect(job?.['continue-on-error'] ?? false).toBe(false);
  });

  it('keeps every gated job unconditional and failing', () => {
    // Three levers make an upstream job stop contributing a real verdict while
    // `ci-ok` still counts it, and each lands a different `needs.*.result`:
    //
    //   job `if:`                 -> `skipped`, which ci-ok ACCEPTS
    //   job `continue-on-error`   -> a FAILED job reports `success`
    //   step `if:`                -> `success` with the step never executed
    //
    // All three give `seen == EXPECTED_UPSTREAM` and a green gate over a CI
    // that decided nothing, and the first two also read green in the Checks UI,
    // so `ci-green-gate` passes too. Only the two jobs that are SUPPOSED to be
    // conditional may carry an `if:`.
    const jobs = workflow().jobs;
    const ALLOWED_CONDITIONAL = new Set(['ci-ok', 'release-pr-not-stale']);
    const offenders: string[] = [];
    for (const [name, j] of Object.entries(jobs)) {
      if (j.if !== undefined && !ALLOWED_CONDITIONAL.has(name)) {
        offenders.push(`${name} (job if:)`);
      }
      if ((j['continue-on-error'] ?? false) !== false) {
        offenders.push(`${name} (job continue-on-error)`);
      }
      for (const s of j.steps ?? []) {
        const label = s.name ?? s.run?.split('\n')[0] ?? '<step>';
        if (
          s.if !== undefined &&
          !ALLOWED_CONDITIONAL.has(name) &&
          !isExemptStepCondition(s.if, j.steps ?? [])
        ) {
          offenders.push(`${name} > ${label} (step if:)`);
        }
        // NOT gated on ALLOWED_CONDITIONAL: a step-level `continue-on-error`
        // is the same lever as the job-level one, one level down — the step
        // fails, the job reports `success`, ci-ok counts it, and it reads green
        // in the Checks UI so `ci-green-gate` passes too.
        if ((s['continue-on-error'] ?? false) !== false) {
          offenders.push(`${name} > ${label} (step continue-on-error)`);
        }
      }
    }
    expect(
      offenders,
      `these ci.yml jobs can report a verdict ci-ok counts without earning it: ` +
        `${offenders.join(', ')}. ci-ok accepts a SKIPPED upstream and cannot tell a ` +
        `continue-on-error success from a real one, so any of these makes the gate green ` +
        `over a CI that ran nothing. If the condition is intended, teach ci-ok to tell ` +
        `"skipped because not applicable" from "skipped because nothing ran".`
    ).toEqual([]);
  });

  it('pins the least privilege each new job was given', () => {
    // ci.yml has no top-level `permissions:`, so deleting either of these
    // silently restores the repo-default token to a job that runs shell.
    expect(workflow().jobs['ci-ok']?.permissions).toEqual({});
    expect(workflow().jobs['release-pr-not-stale']?.permissions).toEqual({ contents: 'read' });
  });

  it('runs on every PR, so ci-ok can be a required check at all', () => {
    // Same trap the docs-deploy case below covers, for the workflow that OWNS
    // the required check: a `paths:`-filtered workflow does not start when
    // nothing matches, so `ci-ok` never reports and every PR blocks forever at
    // "Expected".
    const pr = workflow().on?.['pull_request'];
    expect(pr, 'ci.yml no longer triggers on `pull_request`').not.toBeUndefined();
    expect(pr?.paths).toBeUndefined();
    expect(pr?.['paths-ignore']).toBeUndefined();
    // `types:` is the same trap with a different key: narrowing it to
    // `[opened]` means a later push creates a head sha with NO check run, and
    // the required check sits at "Expected" on that sha forever. The default
    // set (opened / synchronize / reopened) is what a required check needs.
    expect(pr?.types).toBeUndefined();
    // `branches:` narrows the same way a `paths:` filter does — a PR whose base
    // is not listed never starts the workflow, so the required check sits at
    // "Expected" forever. `main` is the only base this repo takes PRs against,
    // and pinning the value reds on REMOVAL too, which is the safer direction.
    expect(pr?.branches).toEqual(['main']);
  });

  it('takes the results through env, not as inlined expression text', () => {
    // The value space is a closed enum today, so inlining is safe by accident
    // rather than by construction. The repo's pattern is that expression data
    // reaches a shell as a variable.
    expect(gateShell()).not.toContain('${{');
    expect(workflow().jobs['ci-ok']?.env?.['RESULTS']).toContain('join(needs.*.result');
  });

  describe('the extracted step', () => {
    it('passes when every upstream job succeeded', () => {
      expect(gateStatus('success success success success', '4')).toBe(0);
    });

    it('passes when an upstream job was skipped', () => {
      // release-pr-not-stale skips on every non-release PR, and a matrix job
      // skipped because its `needs:` failed is reported by that job's own
      // failure instead.
      expect(gateStatus('success skipped success skipped', '4')).toBe(0);
    });

    it('fails on a failed upstream job', () => {
      expect(gateStatus('success failure success success', '4')).not.toBe(0);
    });

    it('fails on a cancelled upstream job', () => {
      // A cancelled run must not satisfy auto-merge.
      expect(gateStatus('success cancelled success success', '4')).not.toBe(0);
    });

    it('fails when the results render empty', () => {
      // THE case this floor exists for: the loop runs zero times, so without
      // the count check "all good" and "examined nothing" are the same exit 0.
      expect(gateStatus('', '4')).not.toBe(0);
    });

    it('fails when fewer results arrive than the needs list declares', () => {
      expect(gateStatus('success success', '4')).not.toBe(0);
    });
  });
});

describe('the other required checks this workflow cannot reach', () => {
  it('docs-deploy runs on every PR so its `build` can be a required check', () => {
    // `build` is required by name, and a required check can only be required if
    // it REPORTS on every PR: a `paths:`-filtered workflow does not start at all
    // when nothing matches, leaving the check at "Expected" forever and blocking
    // every PR permanently. The filter was removed for that reason, and the
    // obvious tidy-up — "re-sync the pull_request paths with the push list" —
    // is exactly what must not happen. Nothing else in the tree notices it.
    const docs = parseYaml(readFileSync(DOCS_DEPLOY_YML, 'utf8')) as {
      on?: Record<string, unknown>;
      jobs?: Record<string, unknown>;
    };
    expect(docs.jobs?.['build'], 'docs-deploy.yml no longer has a `build` job to require').toBeTruthy();
    expect(
      docs.on,
      'docs-deploy.yml no longer triggers on `pull_request`, so its required `build` check ' +
        'never reports and every PR blocks at "Expected".'
    ).toHaveProperty('pull_request');
    const pr = docs.on?.['pull_request'] as { paths?: unknown } | null | undefined;
    expect(
      pr == null || pr.paths === undefined,
      'docs-deploy.yml regained a `paths:` filter on `pull_request`. The workflow then does ' +
        'not start on a PR that matches nothing, the required `build` check never reports, ' +
        'and every such PR is blocked forever. Remove the filter, or drop `build` from the ' +
        "ruleset's required checks."
    ).toBe(true);
  });

  it('cancels superseded docs builds on PRs but never on main', () => {
    // Load-bearing in BOTH directions, which is why the expression is pinned
    // rather than just its truthiness: `build` is required and runs on every
    // PR, so a never-cancelling group queues each push's full SSG build behind
    // the superseded one and serializes every PR's required check. On `main`
    // the same build feeds a deploy, so cancelling there would drop a publish.
    const docs = parseYaml(readFileSync(DOCS_DEPLOY_YML, 'utf8')) as {
      concurrency?: { 'cancel-in-progress'?: unknown };
    };
    expect(docs.concurrency?.['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' }}"
    );
  });
});
