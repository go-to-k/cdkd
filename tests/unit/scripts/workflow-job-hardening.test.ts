/**
 * Issue [#3229](https://github.com/go-to-k/cdkd/issues/3229) — every job under
 * `.github/workflows/**` declares a `timeout-minutes`, and every workflow
 * declares a top-level `permissions:` block.
 *
 * WHAT THE TWO KEYS BUY, and why they are fenced together rather than
 * separately: both are DEFAULTS THAT LIVE OUTSIDE THE FILE, and both defaults
 * are the permissive one.
 *
 * * A job with no `timeout-minutes` runs on the Actions default of **360
 *   minutes**. `ci.yml`'s `check-build-test` is reachable from a FORK through
 *   `pull_request`, and its longest measured run is under 13 minutes, so the
 *   gap between what the job needs and what it is allowed is a factor of ~29.
 *   The concrete amplifier that surfaced this is fixed: go-to-k/cdkd#3195's
 *   fence read every file in this directory and had a quadratic step in it, so
 *   a fork-supplied workflow file bought tens of seconds of CPU per 200 KB. It
 *   is no longer quadratic. What is NOT fixed by that is the next accidental
 *   one — and vitest cannot preempt a synchronous loop, measured: a 12 s loop
 *   under a 5 s `testTimeout` ran to completion and the timeout was reported
 *   only afterwards. The job-level bound is the only thing between such a loop
 *   and the 6-hour ceiling.
 * * A workflow with no `permissions:` block takes the repository's
 *   `default_workflow_permissions` SETTING. That setting is `read` today, so
 *   the two workflows that lacked a block (`ci.yml`, `hooks.yml`) were
 *   effectively no wider than the nine that had one — but a setting is changed
 *   from the web UI, by a person, at a moment unrelated to this repo's review,
 *   and it widens every job that inherited it at once. An explicit block cannot
 *   be widened from outside the file.
 *
 * Neither is a live defect. Both are the kind of property that erodes silently:
 * the failure of a MISSING key is that nothing happens, so a new job written
 * without one looks exactly like every job with one until the day it matters.
 * That is what a fence is for, and it is why this file asserts the property of
 * the DIRECTORY rather than of the eleven workflows that exist today — a
 * twelfth workflow is inside the check the moment it is added, with no list to
 * update.
 *
 * THE UPPER BAND IS A DELIBERATE REFUSAL. A timeout at or above 360 is
 * reported as a finding, because it is indistinguishable in effect from the
 * default it was written to replace — a job carrying `timeout-minutes: 360`
 * reads to a future reviewer as bounded while being exactly as unbounded as one
 * carrying nothing. If a job legitimately needs longer than six hours, raise
 * `ACTIONS_DEFAULT_TIMEOUT_MINUTES` here and say in the commit what changed
 * about the work; do not silence the case per-job.
 *
 * EVERY UNREADABLE INPUT IS A FINDING, NEVER A SKIP. A workflow that fails to
 * parse contributes zero jobs, which is byte-for-byte what a workflow with no
 * jobs at all contributes, and what a directory the glob stopped matching
 * contributes. All three would leave this file green while attesting to
 * nothing, so each is reported: `unparseable`, `no-jobs`, and — for the last —
 * the floors below, which are magnitudes rather than exact counts so that
 * adding a workflow does not red an unrelated PR while a directory silently
 * emptying still does.
 *
 * The probes at the bottom are run against a COPY of the real tree rather than
 * against synthetic fixtures, per `.claude/rules/testing.md` ("a checker must
 * also prove it FAILS — against real code"): a synthetic workflow encodes the
 * same mental model the audit does, so the two can share a blind spot. Each
 * probe breaks one real file one way and asserts the finding names the right
 * workflow AND the right job — a bare "some finding appeared" cannot tell a
 * working audit from one that reports the wrong subject.
 */

import { describe, expect, it } from 'vite-plus/test';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

/**
 * The value a job with no `timeout-minutes` gets from GitHub. A declared
 * timeout at or above it is reported — see the header.
 */
const ACTIONS_DEFAULT_TIMEOUT_MINUTES = 360;

/**
 * Magnitudes, not exact counts. Eleven workflows and twenty jobs exist as of
 * 2026-09-16; these sit below that so that ADDING a workflow does not fail an
 * unrelated PR, while a directory that silently stops matching — the failure
 * these exist for — still does.
 */
const MIN_WORKFLOWS = 10;
const MIN_JOBS = 18;

type Finding =
  | { readonly kind: 'unparseable'; readonly workflow: string; readonly detail: string }
  | { readonly kind: 'no-jobs'; readonly workflow: string }
  | { readonly kind: 'no-top-level-permissions'; readonly workflow: string }
  | { readonly kind: 'job-not-a-mapping'; readonly workflow: string; readonly job: string }
  | { readonly kind: 'no-timeout'; readonly workflow: string; readonly job: string }
  | {
      readonly kind: 'timeout-not-a-positive-integer';
      readonly workflow: string;
      readonly job: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'timeout-at-or-above-default';
      readonly workflow: string;
      readonly job: string;
      readonly detail: string;
    };

interface Audit {
  readonly workflows: number;
  readonly jobs: number;
  readonly findings: readonly Finding[];
}

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Walk a workflow directory and report every job that does not declare a usable
 * `timeout-minutes`, and every workflow that does not declare a top-level
 * `permissions:`.
 *
 * Exported so the probes can point it at a scratch COPY of the real tree. It
 * takes a directory rather than reading `WORKFLOW_DIR` itself for exactly that
 * reason — an audit that can only be run against one path cannot be shown to
 * fail.
 */
export const auditWorkflowHardening = (dir: string): Audit => {
  const names = readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  const findings: Finding[] = [];
  let jobs = 0;

  for (const workflow of names) {
    let document: unknown;
    try {
      document = parseYaml(readFileSync(join(dir, workflow), 'utf8'));
    } catch (error) {
      findings.push({
        kind: 'unparseable',
        workflow,
        detail: error instanceof Error ? error.message.split('\n')[0] : String(error),
      });
      continue;
    }

    if (!isMapping(document)) {
      findings.push({ kind: 'unparseable', workflow, detail: 'top level is not a mapping' });
      continue;
    }

    // `undefined` is the absence this fence is about. `permissions: {}` parses
    // to an empty object and IS a declaration — the strictest one — so the test
    // is presence of the key, not truthiness of its value.
    if (!('permissions' in document)) {
      findings.push({ kind: 'no-top-level-permissions', workflow });
    }

    const jobsNode = document['jobs'];
    if (!isMapping(jobsNode) || Object.keys(jobsNode).length === 0) {
      findings.push({ kind: 'no-jobs', workflow });
      continue;
    }

    for (const [job, node] of Object.entries(jobsNode)) {
      jobs += 1;

      if (!isMapping(node)) {
        findings.push({ kind: 'job-not-a-mapping', workflow, job });
        continue;
      }

      if (!('timeout-minutes' in node)) {
        findings.push({ kind: 'no-timeout', workflow, job });
        continue;
      }

      const timeout = node['timeout-minutes'];
      if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1) {
        findings.push({
          kind: 'timeout-not-a-positive-integer',
          workflow,
          job,
          detail: JSON.stringify(timeout),
        });
        continue;
      }

      if (timeout >= ACTIONS_DEFAULT_TIMEOUT_MINUTES) {
        findings.push({
          kind: 'timeout-at-or-above-default',
          workflow,
          job,
          detail: `${timeout} >= ${ACTIONS_DEFAULT_TIMEOUT_MINUTES}`,
        });
      }
    }
  }

  return { workflows: names.length, jobs, findings };
};

/** Render findings for an assertion message — one line each, stable order. */
const render = (findings: readonly Finding[]): string[] =>
  findings.map((f) =>
    'job' in f
      ? `${f.workflow} / ${f.job}: ${f.kind}${'detail' in f ? ` (${f.detail})` : ''}`
      : `${f.workflow}: ${f.kind}${'detail' in f ? ` (${f.detail})` : ''}`,
  );

/**
 * Copy the real workflow directory somewhere writable, hand it to `mutate`, and
 * audit the result. The real tree is never written to — the probes below break
 * REAL files, and doing that in place would leave the repo broken if the
 * assertion threw before a restore.
 */
const auditMutatedCopy = (mutate: (dir: string) => void): Audit => {
  const scratch = mkdtempSync(join(tmpdir(), 'cdkd-workflow-hardening-'));
  try {
    cpSync(WORKFLOW_DIR, scratch, { recursive: true });
    mutate(scratch);
    return auditWorkflowHardening(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/**
 * Delete the one line whose trimmed text equals `needle`, refusing an anchor
 * that is absent or matches more than once.
 *
 * The refusal is the point, not defensiveness: a probe whose anchor silently
 * matched nothing would leave the copy identical to the real tree, the audit
 * would report zero findings, and the case asserting "this mutation is caught"
 * would be asserting the opposite of what it claims while passing. Equality on
 * the trimmed line rather than `includes` so that `timeout-minutes: 5` cannot
 * also select a future `timeout-minutes: 50`.
 */
const deleteUniqueLine = (dir: string, workflow: string, needle: string): void => {
  const path = join(dir, workflow);
  const lines = readFileSync(path, 'utf8').split('\n');
  const hits = lines.filter((line) => line.trim() === needle);
  if (hits.length !== 1) {
    throw new Error(
      `probe anchor ${JSON.stringify(needle)} matched ${hits.length} lines in ${workflow}; ` +
        'a probe whose anchor is absent or ambiguous proves nothing — re-anchor it',
    );
  }
  writeFileSync(path, lines.filter((line) => line.trim() !== needle).join('\n'));
};

const REAL = auditWorkflowHardening(WORKFLOW_DIR);

describe('every workflow job is bounded and every workflow declares its permissions', () => {
  it('the audit saw the directory it claims to attest to', () => {
    expect(REAL.workflows).toBeGreaterThanOrEqual(MIN_WORKFLOWS);
    expect(REAL.jobs).toBeGreaterThanOrEqual(MIN_JOBS);
  });

  it('reports nothing for the real tree', () => {
    expect(render(REAL.findings)).toEqual([]);
  });

  it('every job declares an explicit timeout below the Actions default', () => {
    // The same property as above, asserted from the other side: this one fails
    // with the job names rather than with a finding list, and it re-reads the
    // parsed values rather than the audit's verdict about them.
    const unbounded: string[] = [];
    for (const workflow of readdirSync(WORKFLOW_DIR).filter((n) => /\.ya?ml$/.test(n))) {
      const document = parseYaml(readFileSync(join(WORKFLOW_DIR, workflow), 'utf8')) as Record<
        string,
        unknown
      >;
      for (const [job, node] of Object.entries(document['jobs'] as Record<string, unknown>)) {
        const timeout = (node as Record<string, unknown>)['timeout-minutes'];
        if (typeof timeout !== 'number' || timeout >= ACTIONS_DEFAULT_TIMEOUT_MINUTES) {
          unbounded.push(`${workflow} / ${job}`);
        }
      }
    }
    expect(unbounded).toEqual([]);
  });
});

describe('the audit fails against real code', () => {
  it('a removed timeout in ci.yml is reported, naming the job', () => {
    // Anchored on a timeout value rather than on a job name because the value
    // is what the line contains. Which values are unique is not stated here: it
    // changes whenever a bound is re-measured, and `deleteUniqueLine` refuses a
    // duplicated anchor by name at the moment it stops being unique — a census
    // in a comment would go stale silently instead.
    const audit = auditMutatedCopy((dir) => {
      deleteUniqueLine(dir, 'ci.yml', 'timeout-minutes: 5');
    });
    expect(render(audit.findings)).toEqual(['ci.yml / ci-ok: no-timeout']);
  });

  it('a removed timeout in a second workflow is reported too', () => {
    // A second file, because one probe cannot tell "the audit walks the
    // directory" from "the audit hard-codes ci.yml".
    const audit = auditMutatedCopy((dir) => {
      deleteUniqueLine(dir, 'cfn-schema-refresh.yml', 'timeout-minutes: 20');
    });
    expect(render(audit.findings)).toEqual(['cfn-schema-refresh.yml / refresh: no-timeout']);
  });

  it('a removed top-level permissions block is reported', () => {
    const audit = auditMutatedCopy((dir) => {
      deleteUniqueLine(dir, 'hooks.yml', 'permissions: {}');
    });
    expect(render(audit.findings)).toEqual(['hooks.yml: no-top-level-permissions']);
  });

  it('a workflow that does not parse is a finding, not a silent zero', () => {
    const audit = auditMutatedCopy((dir) => {
      writeFileSync(join(dir, 'ci.yml'), 'name: CI\njobs:\n  a:\n   - [unbalanced\n');
    });
    expect(audit.findings.map((f) => `${f.workflow}: ${f.kind}`)).toEqual(['ci.yml: unparseable']);
    // And the count it would otherwise have contributed is GONE — which is the
    // reason the floors above are asserted separately from the findings.
    expect(audit.jobs).toBeLessThan(REAL.jobs);
  });

  it('a timeout at the Actions default is reported rather than accepted', () => {
    const audit = auditMutatedCopy((dir) => {
      const path = join(dir, 'ci.yml');
      const source = readFileSync(path, 'utf8');
      const replaced = source.replace('    timeout-minutes: 5\n', '    timeout-minutes: 360\n');
      expect(replaced).not.toBe(source);
      writeFileSync(path, replaced);
    });
    expect(render(audit.findings)).toEqual([
      'ci.yml / ci-ok: timeout-at-or-above-default (360 >= 360)',
    ]);
  });

  it('a non-numeric timeout is reported rather than accepted', () => {
    const audit = auditMutatedCopy((dir) => {
      const path = join(dir, 'ci.yml');
      const source = readFileSync(path, 'utf8');
      const replaced = source.replace('    timeout-minutes: 5\n', "    timeout-minutes: '5'\n");
      expect(replaced).not.toBe(source);
      writeFileSync(path, replaced);
    });
    expect(render(audit.findings)).toEqual([
      'ci.yml / ci-ok: timeout-not-a-positive-integer ("5")',
    ]);
  });

  it('the probe helper refuses an anchor that is absent or not unique', () => {
    // The guard cannot fire on the anchors the probes above actually use — all
    // of them are unique, which is what makes them usable — so without this
    // case nothing would notice it going inert. What it catches is the NEXT
    // re-anchoring: an anchor that silently matches nothing leaves the copy
    // identical to the real tree, and the case claiming "this mutation is
    // caught" becomes an assertion about an unmutated copy that passes.
    // Both directions are exercised, because an absent anchor and an ambiguous
    // one fail for different reasons and a `!== 1` test is the only thing
    // covering them jointly.
    expect(() =>
      auditMutatedCopy((dir) => deleteUniqueLine(dir, 'ci.yml', 'timeout-minutes: 30')),
    ).toThrow(/matched 2 lines in ci\.yml/);
    expect(() =>
      auditMutatedCopy((dir) => deleteUniqueLine(dir, 'ci.yml', 'timeout-minutes: 1234')),
    ).toThrow(/matched 0 lines in ci\.yml/);
  });

  it('an empty directory reports zero, so the floors are load-bearing', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cdkd-workflow-hardening-empty-'));
    try {
      const audit = auditWorkflowHardening(scratch);
      expect(audit).toEqual({ workflows: 0, jobs: 0, findings: [] });
      expect(audit.workflows).toBeLessThan(MIN_WORKFLOWS);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
