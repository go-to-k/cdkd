/**
 * Issue [#3229](https://github.com/go-to-k/cdkd/issues/3229) — every job under
 * `.github/workflows/**` declares a usable `timeout-minutes`, and every
 * workflow declares a top-level `permissions:` MAPPING.
 *
 * WHAT THE TWO KEYS BUY, and why they are fenced together rather than
 * separately: both are DEFAULTS THAT LIVE OUTSIDE THE FILE, and both defaults
 * are the permissive one.
 *
 * * A job with no `timeout-minutes` runs on the Actions default of **360
 *   minutes**. `ci.yml`'s `check-build-test` is reachable from a FORK through
 *   `pull_request`, and its longest measured run is around 12 minutes, so the
 *   gap between what the job needs and what it is allowed was a factor of ~29.
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
 *   and it widens every job that inherited it at once.
 *
 * Neither is a live defect. Both are the kind of property that erodes silently:
 * the failure of a MISSING key is that nothing happens, so a new job written
 * without one looks exactly like every job with one until the day it matters.
 * That is what a fence is for, and it is why this file asserts the property of
 * the DIRECTORY rather than of the eleven workflows that exist today — a
 * twelfth workflow is inside the check the moment it is added, with no list to
 * update.
 *
 * TWO REFUSALS ARE SYMMETRIC, AND THE SECOND ONE WAS MISSING FOR A ROUND.
 * A timeout at or above 360 is a finding, because it is indistinguishable in
 * effect from the default it was written to replace — a job carrying
 * `timeout-minutes: 360` reads to a future reviewer as bounded while being
 * exactly as unbounded as one carrying nothing. The first cut of this file
 * refused that and then accepted `permissions: write-all`, which is the widest
 * value there is, while its own header claimed a block "cannot be widened from
 * outside the file". So a `permissions:` value that is not a MAPPING —
 * `write-all`, `read-all`, or an empty scalar — is a finding too. `{}` is a
 * mapping and is the strictest declaration there is; it passes.
 *
 * WHAT THIS DOES NOT CLAIM, stated because the header above already over-read
 * itself once: the fence checks that each grant is DECLARED IN THE FILE and
 * shaped like a grant. It does not judge whether the grant is minimal —
 * `permissions: { contents: write }` passes. Narrowness is review's job; what
 * the fence removes is the case where there is nothing in the file to review.
 *
 * EVERY UNREADABLE INPUT IS A FINDING, NEVER A SKIP. A workflow that fails to
 * parse contributes zero jobs, which is byte-for-byte what a workflow with no
 * jobs at all contributes, and what a directory the glob stopped matching
 * contributes. All three would leave this file green while attesting to
 * nothing, so each is reported — `unparseable`, `top-level-not-a-mapping`,
 * `no-jobs` — and for the last, by the floors below, which are magnitudes
 * rather than exact counts so that adding a workflow does not red an unrelated
 * PR while a directory silently emptying still does.
 *
 * EVERY FIELD OF A FINDING IS SANITISED WHERE IT IS BUILT, not where it is
 * printed. A workflow file name and a job key are FORK-CONTROLLED: a fork can
 * add `.github/workflows/evil.yml` whose job key carries a newline, and the
 * missing `timeout-minutes` then guarantees this file fails and renders it —
 * forging a line that reads as a finding against a different workflow, or a
 * `::error::` the runner interprets. The sibling fence in this directory
 * (`workflow-expression-syntax.test.ts`, go-to-k/cdkd#3195) found ELEVEN
 * renderers of that one forgery and closed them one at a time over five review
 * rounds. The lesson taken from it here is the shape, not the helpers: findings
 * are built in ONE place, `report`, so sanitising there leaves no renderer that
 * can be forgotten. Round 2 proved how easily that is lost -- the independent
 * twins added in round 1 re-read the directory and built their own strings, and
 * an unguarded `parseYaml` in them printed a fork's YAML verbatim through
 * vitest's own error output, at column 0 where the runner interprets `::error::`.
 * That is the SAME lesson one layer over, inside the fix for it. The twins now
 * take a directory and emit only sanitised, capped labels, and each has a case
 * that reds when it is gutted. The harm is bounded either way — a misleading
 * line in the log of an already-failing run, no secret and no write — but the
 * cost of closing it at one site is two function calls.
 *
 * TWO ARMS SURVIVE MUTATION, named rather than papered over, and neither is a
 * gap a case could close.
 *
 * The `typeof timeout !== 'number'` half of the numeric guard is redundant at
 * RUNTIME — `Number.isInteger` does not coerce, so it already rejects a string —
 * and is load-bearing only for the COMPILER, which needs it to narrow `unknown`
 * before the comparison below. Deleting it is caught by `vp run typecheck:test`
 * (TS18046, twice) and by nothing here, because vitest's `typecheck.include`
 * covers `*.test-d.ts` alone and so this file's own "Type Errors" line is
 * vacuous. A different gate kills it; no case in this file can.
 *
 * `findingsForAddedFile`'s filter is EQUIVALENT while the real tree is clean:
 * every synthetic case adds one bad file to a copy of a directory that reports
 * nothing, so filtering to that file and not filtering produce the same list.
 * It earns its place only in the failing case it is written for — when the real
 * tree regresses, it keeps a synthetic case pointing at its own subject instead
 * of at an innocent workflow. That is a diagnostic property, and a diagnostic
 * property cannot be fenced by a green suite.
 *
 * What this ISN'T is the list of arms nothing kills. Round 2 shipped seven
 * mutations that all reddened and a reviewer then measured FIFTEEN OF EIGHTEEN
 * arms surviving, because seven probes covered exactly the arms their author
 * thought of. The current table is 40 arms with 38 killed, and the two above are
 * the residue. Re-derive it rather than trusting this paragraph: the arms are
 * the branches of `auditWorkflowHardening`, `flatten`, `safeName`, `safeJson`,
 * `render`, `boundedList` and both twins.
 *
 * The probes at the bottom come in two kinds, and the split is deliberate per
 * `.claude/rules/testing.md` ("a checker must also prove it FAILS — against
 * real code"). Each verdict the real tree can exhibit is probed by breaking a
 * REAL workflow on a scratch copy, because a synthetic fixture encodes the same
 * mental model the audit does and the two can share a blind spot. Shapes the
 * real tree CANNOT exhibit — a sequence at the top level, a scalar job, a null
 * `permissions:` — are probed synthetically, which is the cheap complement once
 * the real-code probes exist rather than a substitute for them.
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
 * Magnitudes, not exact counts. Eleven workflows and twenty-one jobs exist as
 * of 2026-09-16 (UTC, as the Actions API reports it — an earlier revision
 * stamped these JST, a day ahead of the query that produces them); these sit
 * below that so that ADDING a workflow does not fail
 * an unrelated PR, while a directory that silently stops matching — the failure
 * they exist for — still does. Both are pinned by the empty-directory case
 * below; without that, either could be set to zero and nothing would notice.
 */
const MIN_WORKFLOWS = 10;
const MIN_JOBS = 18;

/** How many findings are rendered before the rest are summarised. */
const MAX_RENDERED_FINDINGS = 20;

/** Longest fork-controlled string a rendered finding may carry. */
const MAX_FIELD_LENGTH = 120;

type FindingKind =
  | 'unparseable'
  | 'top-level-not-a-mapping'
  | 'no-jobs'
  | 'no-top-level-permissions'
  | 'permissions-not-a-mapping'
  | 'job-not-a-mapping'
  | 'no-timeout'
  | 'timeout-not-a-positive-integer'
  | 'timeout-at-or-above-default';

/**
 * Every field here is ALREADY SANITISED — `report` is the only constructor and
 * it is what sanitises. `job` and `detail` are declared as possibly-`undefined`
 * rather than optional so that reading them needs a value test and never an
 * `in` test: an `in` test on an optional property is a different question from
 * "is there something to print", and an earlier revision of the renderer asked
 * the wrong one.
 */
interface Finding {
  readonly kind: FindingKind;
  readonly workflow: string;
  readonly job: string | undefined;
  readonly detail: string | undefined;
}

interface Audit {
  readonly workflows: number;
  readonly jobs: number;
  readonly findings: readonly Finding[];
}

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `JSON.stringify` for a value that came out of a fork's YAML.
 *
 * YAML anchors can build a CIRCULAR structure (`jobs: {a: &x {timeout-minutes:
 * *x}}`), and `JSON.stringify` then THROWS — out of the audit entirely, past
 * `report`, so the value reaches vitest's error output unsanitised and the
 * header's "every unreadable input is a finding" is false for exactly the input
 * a hostile fork would choose. Falling back to the type name keeps the finding.
 */
const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? typeof value;
  } catch {
    return typeof value;
  }
};

/**
 * Collapse everything that could move a cursor, break a line, or reorder the
 * text around it into single spaces.
 *
 * Written so that NO escape sequence ENCODES A CONTROL CHARACTER: an earlier
 * version of this helper in the sibling fence was authored twice with a literal
 * control byte in its own source, which `grep` then classified as a binary file
 * and skipped at exit 0 — the `check-source-control-bytes.ts` class. Numeric
 * comparisons cannot make that mistake. The `/\s/` test is an escape sequence
 * and is deliberately kept: it is the ONLY row that catches NBSP, U+2028 and
 * U+FEFF, which no numeric range below covers. An earlier draft of this
 * paragraph claimed the file had no escape sequence at all, which was false of
 * the line directly beneath it.
 */
const flatten = (text: string): string => {
  let out = '';
  let blank = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const unsafe =
      // C0 and space.
      code <= 0x20 ||
      // DEL and the C1 range — U+0085 is NEL, a line break to a Unicode-aware
      // reader, and it is neither `<= 0x20` nor matched by `\s`.
      (code >= 0x7f && code <= 0x9f) ||
      // Every bidi control, not only the overrides: the marks and the isolates
      // reorder a rendered line just as well.
      code === 0x61c ||
      (code >= 0x200e && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      /\s/.test(ch);
    if (unsafe) {
      if (!blank) out += ' ';
      blank = true;
    } else {
      out += ch;
      blank = false;
    }
  }
  return out;
};

/** Flatten and clamp any fork-controlled string, marking the clip. */
export const safeText = (text: string): string => {
  const flat = flatten(text);
  return flat.length > MAX_FIELD_LENGTH ? `${flat.slice(0, MAX_FIELD_LENGTH)}…` : flat;
};

/**
 * A workflow file name as it may appear in a finding — CONSTRAINED, not merely
 * flattened.
 *
 * The distinction is the whole point and it is not obvious: a file can be named
 * in pure ASCII so that it reads as a complete finding about a DIFFERENT file.
 * `ci.yml / check-build-test: no-timeout - and also.yml` passes the `.ya?ml`
 * filter and is a `flatten` no-op. A real workflow name is a short, dull thing;
 * anything else is quoted, so it can only ever be read as one field.
 */
const WORKFLOW_NAME = /^[A-Za-z0-9._-]+\.ya?ml$/;
export const safeName = (name: string): string =>
  WORKFLOW_NAME.test(name) ? safeText(name) : JSON.stringify(safeText(name));

/**
 * Walk a workflow directory and report every job that does not declare a usable
 * `timeout-minutes`, and every workflow that does not declare a `permissions:`
 * mapping.
 *
 * Exported so the probes can point it at a scratch COPY of the real tree. It
 * takes a directory rather than reading `WORKFLOW_DIR` itself for exactly that
 * reason — an audit that can only be run against one path cannot be shown to
 * fail.
 */
export const workflowNamesIn = (entries: readonly string[]): string[] =>
  entries.filter((name) => /\.ya?ml$/.test(name)).sort();

export const auditWorkflowHardening = (dir: string): Audit => {
  const names = workflowNamesIn(readdirSync(dir));
  const findings: Finding[] = [];
  let jobs = 0;

  // The ONLY constructor, and therefore the only place sanitising has to
  // happen. See the header: the sibling fence closed this hazard at eleven
  // separate renderers because its findings were built in eleven places.
  const report = (kind: FindingKind, workflow: string, job?: string, detail?: string): void => {
    findings.push({
      kind,
      workflow: safeName(workflow),
      job: job === undefined ? undefined : safeText(job),
      detail: detail === undefined ? undefined : safeText(detail),
    });
  };

  for (const workflow of names) {
    let document: unknown;
    try {
      document = parseYaml(readFileSync(join(dir, workflow), 'utf8'));
    } catch (error) {
      // The message, not the error object: a YAML parse error can quote the
      // offending source, and `cause` chains are printed raw by vitest in their
      // own block — which moves a forgery down two lines rather than closing it.
      report(
        'unparseable',
        workflow,
        undefined,
        error instanceof Error ? error.message.split('\n')[0] : String(error),
      );
      continue;
    }

    if (!isMapping(document)) {
      report('top-level-not-a-mapping', workflow, undefined, typeof document);
      continue;
    }

    // `in`, not truthiness: `permissions: {}` is the STRICTEST declaration and
    // must pass, while `permissions:` with no value is a key that declares
    // nothing. The two are told apart by the mapping test below, so this arm
    // answers only "did the author write the key at all".
    if (!('permissions' in document)) {
      report('no-top-level-permissions', workflow);
    } else if (!isMapping(document['permissions'])) {
      report('permissions-not-a-mapping', workflow, undefined, safeJson(document['permissions']));
    }

    const jobsNode = document['jobs'];
    if (!isMapping(jobsNode) || Object.keys(jobsNode).length === 0) {
      report('no-jobs', workflow);
      continue;
    }

    for (const [job, node] of Object.entries(jobsNode)) {
      jobs += 1;

      if (!isMapping(node)) {
        report('job-not-a-mapping', workflow, job, typeof node);
        continue;
      }

      if (!('timeout-minutes' in node)) {
        report('no-timeout', workflow, job);
        continue;
      }

      const timeout = node['timeout-minutes'];
      if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1) {
        report('timeout-not-a-positive-integer', workflow, job, safeJson(timeout));
        continue;
      }

      if (timeout >= ACTIONS_DEFAULT_TIMEOUT_MINUTES) {
        report(
          'timeout-at-or-above-default',
          workflow,
          job,
          `${timeout} >= ${ACTIONS_DEFAULT_TIMEOUT_MINUTES}`,
        );
      }
    }
  }

  return { workflows: names.length, jobs, findings };
};

/**
 * Cap any list of fork-derived lines. Shared by `render` and by both twins —
 * round 2 capped the findings and left the twins unbounded, which is the same
 * omission one layer over (measured: 3000 entries, nothing truncated).
 */
const boundedList = (lines: readonly string[]): string[] =>
  lines.length > MAX_RENDERED_FINDINGS
    ? [...lines.slice(0, MAX_RENDERED_FINDINGS), `… and ${lines.length - MAX_RENDERED_FINDINGS} more`]
    : [...lines];

/**
 * Render findings for an assertion message — one line each, capped.
 *
 * Interpolation here is unguarded BY CONTRACT: `report` sanitised every field.
 * The cap is the second half of that contract — a fork workflow with a thousand
 * jobs would otherwise render a thousand lines.
 */
const render = (findings: readonly Finding[]): string[] =>
  boundedList(
    findings.map(
      (f) =>
        `${f.workflow}${f.job === undefined ? '' : ` / ${f.job}`}: ${f.kind}` +
        `${f.detail === undefined ? '' : ` (${f.detail})`}`,
    ),
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
 * Add one file to the scratch copy and return only the findings it produced.
 *
 * Scoped rather than whole-tree because a synthetic case is asking about ONE
 * shape; asserting the whole list would make every such case fail whenever any
 * real workflow regresses, pointing at an innocent file. The real-code probes
 * below keep their whole-tree assertions, where that coupling is the point.
 */
const findingsForAddedFile = (name: string, body: string): string[] => {
  const audit = auditMutatedCopy((dir) => writeFileSync(join(dir, name), body));
  // The WHOLE name, not a prefix. An earlier cut cut at the first dot, so
  // `ci.yml_ but actually.yml` filtered on `ci` and also matched every real
  // `ci.yml` finding — a filter that selects more than its subject.
  return render(audit.findings.filter((f) => f.workflow.includes(name) || f.workflow.includes(safeText(name))));
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

/**
 * Run `read` against a scratch copy of the real directory that `mutate` has
 * broken, and return whatever `read` produced.
 *
 * `auditMutatedCopy` is the same shape specialised to the audit; this one
 * exists so the TWINS can be pointed at a broken tree too. A twin that is never
 * run against a tree it should reject is a twin that can be gutted silently —
 * measured in round 2, where both were inline and `return []` stayed green.
 */
const withMutatedCopy = <T,>(mutate: (dir: string) => void, read: (dir: string) => T): T => {
  const scratch = mkdtempSync(join(tmpdir(), 'cdkd-workflow-hardening-twin-'));
  try {
    cpSync(WORKFLOW_DIR, scratch, { recursive: true });
    mutate(scratch);
    return read(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/**
 * The independent twins.
 *
 * They re-read and re-parse rather than consulting `auditWorkflowHardening`, so
 * a bug that makes the audit report nothing does not silence them. What they do
 * NOT re-implement is the sanitising: every label they emit goes through
 * `safeName` / `safeText` and the list is capped, because in round 2 these two
 * were inline, interpolated the fork-controlled job key and file name raw, and
 * parsed OUTSIDE a `try` — so an unparseable workflow from a fork threw a
 * `YAMLParseError` whose message quotes that fork's source verbatim, printed by
 * vitest at column 0 where the Actions runner interprets a workflow command.
 * Independence is worth having; independence of the sanitiser is not.
 */
const independentlyUnboundedJobs = (dir: string): string[] => {
  const out: string[] = [];
  for (const workflow of workflowNamesIn(readdirSync(dir))) {
    let document: unknown;
    try {
      document = parseYaml(readFileSync(join(dir, workflow), 'utf8'));
    } catch {
      // The message is NOT rendered: it is the fork's own source. That it
      // failed to parse is the whole fact this twin needs.
      out.push(`${safeName(workflow)}: did not parse`);
      continue;
    }
    if (!isMapping(document) || !isMapping(document['jobs'])) {
      out.push(`${safeName(workflow)}: no jobs mapping`);
      continue;
    }
    for (const [job, node] of Object.entries(document['jobs'])) {
      const timeout = isMapping(node) ? node['timeout-minutes'] : undefined;
      const ok =
        typeof timeout === 'number' &&
        Number.isInteger(timeout) &&
        timeout >= 1 &&
        timeout < ACTIONS_DEFAULT_TIMEOUT_MINUTES;
      if (!ok) out.push(`${safeName(workflow)} / ${safeText(job)}: ${safeJson(timeout)}`);
    }
  }
  return boundedList(out);
};

const independentlyUndeclaredPermissions = (dir: string): string[] => {
  const out: string[] = [];
  for (const workflow of workflowNamesIn(readdirSync(dir))) {
    let document: unknown;
    try {
      document = parseYaml(readFileSync(join(dir, workflow), 'utf8'));
    } catch {
      out.push(`${safeName(workflow)}: did not parse`);
      continue;
    }
    if (!isMapping(document) || !isMapping(document['permissions'])) out.push(safeName(workflow));
  }
  return boundedList(out);
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

  it('every job carries an integer timeout strictly below the Actions default', () => {
    expect(independentlyUnboundedJobs(WORKFLOW_DIR)).toEqual([]);
  });

  it('every workflow declares a permissions MAPPING, not merely the key', () => {
    expect(independentlyUndeclaredPermissions(WORKFLOW_DIR)).toEqual([]);
  });

  it('the twins report on a broken tree, so a green twin means something', () => {
    // Without this, gutting either twin to `return []` is invisible — measured
    // green in round 2, when both were inline in the cases above and nothing
    // exercised them against a tree that should fail.
    expect(withMutatedCopy(
      (dir) => {
        deleteUniqueLine(dir, 'ci.yml', 'timeout-minutes: 5');
        deleteUniqueLine(dir, 'hooks.yml', 'permissions: {}');
      },
      (dir) => [independentlyUnboundedJobs(dir), independentlyUndeclaredPermissions(dir)],
    )).toEqual([['ci.yml / ci-ok: undefined'], ['hooks.yml']]);
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
    expect(audit.findings[0]?.detail).toBeTruthy();
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

  it.each([
    ["'5'", 'a quoted number is a string to YAML', '"5"'],
    ['2.5', 'a fraction is not a whole minute', '2.5'],
    ['0', 'zero is not a bound, it is a refusal to start', '0'],
  ])('a timeout of %s is reported rather than accepted (%s)', (written, _why, rendered) => {
    // Three cases, not one: each half of the numeric guard — the `typeof`, the
    // `Number.isInteger` and the `>= 1` — survives deletion on its own, so one
    // case leaves two halves unfenced.
    const audit = auditMutatedCopy((dir) => {
      const path = join(dir, 'ci.yml');
      const source = readFileSync(path, 'utf8');
      const replaced = source.replace(
        '    timeout-minutes: 5\n',
        `    timeout-minutes: ${written}\n`,
      );
      expect(replaced).not.toBe(source);
      writeFileSync(path, replaced);
    });
    expect(render(audit.findings)).toEqual([
      `ci.yml / ci-ok: timeout-not-a-positive-integer (${rendered})`,
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
    // covering them jointly. The duplicated needle is derived rather than
    // asserted: whichever value repeats, the helper must refuse it.
    const source = readFileSync(join(WORKFLOW_DIR, 'ci.yml'), 'utf8');
    const counts = new Map<string, number>();
    for (const line of source.split('\n')) {
      const t = line.trim();
      if (t.startsWith('timeout-minutes:')) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const duplicated = [...counts].find(([, n]) => n > 1);
    expect(duplicated).toBeDefined();
    expect(() =>
      auditMutatedCopy((dir) => deleteUniqueLine(dir, 'ci.yml', duplicated?.[0] ?? '')),
    ).toThrow(/matched [2-9][0-9]* lines in ci\.yml/);
    expect(() =>
      auditMutatedCopy((dir) => deleteUniqueLine(dir, 'ci.yml', 'timeout-minutes: 1234')),
    ).toThrow(/matched 0 lines in ci\.yml/);
  });
});

describe('shapes the real tree cannot exhibit', () => {
  // Synthetic, and only for verdicts no real workflow can produce — the
  // complement to the real-code probes above, never a substitute. Each adds one
  // file to a copy of the real directory, so the rest of the tree is still the
  // real one and the assertion is scoped to the added file.

  it.each([
    ['write-all', 'permissions-not-a-mapping ("write-all")'],
    ['read-all', 'permissions-not-a-mapping ("read-all")'],
  ])('a permissions value of %s is refused, not accepted as declared', (value, expected) => {
    // The asymmetry this closes: `timeout-minutes: 360` was refused from the
    // first cut while the widest possible permissions value passed.
    expect(
      findingsForAddedFile('zz-perm.yml', `name: X\npermissions: ${value}\njobs:\n  a:\n    timeout-minutes: 5\n`),
    ).toEqual([`zz-perm.yml: ${expected}`]);
  });

  it('a permissions key with no value is refused', () => {
    // Distinguishes `'permissions' in document` from a truthiness test: a null
    // value satisfies `in` and fails truthiness, so without this case the two
    // spellings are interchangeable and the comment claiming they differ is
    // unfenced.
    expect(
      findingsForAddedFile('zz-null.yml', 'name: X\npermissions:\njobs:\n  a:\n    timeout-minutes: 5\n'),
    ).toEqual(['zz-null.yml: permissions-not-a-mapping (null)']);
  });

  it('an empty permissions mapping passes — it is the strictest declaration', () => {
    expect(
      findingsForAddedFile('zz-empty.yml', 'name: X\npermissions: {}\njobs:\n  a:\n    timeout-minutes: 5\n'),
    ).toEqual([]);
  });

  it.each([
    ['a sequence', '- one\n- two\n', 'top-level-not-a-mapping (object)'],
    ['an empty file', '', 'top-level-not-a-mapping (object)'],
    ['a scalar', 'just a string\n', 'top-level-not-a-mapping (string)'],
  ])('a workflow whose top level is %s is reported', (_what, body, expected) => {
    // Pins both halves of `isMapping` beyond the `typeof` test: an array and
    // `null` are each `typeof 'object'`, so deleting either guard is otherwise
    // silent.
    expect(findingsForAddedFile('zz-top.yml', body)).toEqual([`zz-top.yml: ${expected}`]);
  });

  it.each([
    ['absent', 'name: X\npermissions: {}\n'],
    ['an empty mapping', 'name: X\npermissions: {}\njobs: {}\n'],
    ['null', 'name: X\npermissions: {}\njobs:\n'],
  ])('a workflow whose jobs mapping is %s is reported', (_what, body) => {
    // The `Object.keys(...).length === 0` half is separate from the `isMapping`
    // half; `jobs: {}` is the only shape that reaches it.
    expect(findingsForAddedFile('zz-jobs.yml', body)).toEqual(['zz-jobs.yml: no-jobs']);
  });

  it('a job that is not a mapping is reported, naming the job', () => {
    expect(
      findingsForAddedFile('zz-job.yml', 'name: X\npermissions: {}\njobs:\n  a: hello\n'),
    ).toEqual(['zz-job.yml / a: job-not-a-mapping (string)']);
  });

  it('a .yaml file is in scope and a non-YAML file is not', () => {
    // Pins the `ya?ml` alternative and the filter itself. The `.txt` companion
    // is what makes the filter load-bearing rather than merely present.
    expect(
      findingsForAddedFile('zz-ext.yaml', 'name: X\npermissions: {}\njobs:\n  a:\n    runs-on: x\n'),
    ).toEqual(['zz-ext.yaml / a: no-timeout']);

    const audit = auditMutatedCopy((dir) =>
      writeFileSync(join(dir, 'zz-notes.txt'), 'name: X\njobs:\n  a:\n    runs-on: x\n'),
    );
    expect(render(audit.findings)).toEqual([]);
    expect(audit.workflows).toBe(REAL.workflows);
  });

  it('findings come back in file order', () => {
    // Pins the `.sort()`. Two added files whose alphabetical order is the
    // reverse of the order `writeFileSync` created them in.
    const audit = auditMutatedCopy((dir) => {
      writeFileSync(join(dir, 'zz-second.yml'), 'name: X\npermissions: {}\njobs:\n  a:\n    runs-on: x\n');
      writeFileSync(join(dir, 'zz-first.yml'), 'name: X\npermissions: {}\njobs:\n  a:\n    runs-on: x\n');
    });
    expect(render(audit.findings)).toEqual([
      'zz-first.yml / a: no-timeout',
      'zz-second.yml / a: no-timeout',
    ]);
  });
});

describe('a finding cannot forge a line in the log', () => {
  it('a hostile job key is flattened before it is rendered', () => {
    // A fork can add a workflow whose job key carries a newline; the missing
    // timeout then guarantees the fence fails and renders it. Un-sanitised,
    // this emits a second line reading as a finding against ci.yml plus a
    // workflow command the runner interprets.
    const hostile = 'a\n  ci.yml / check-build-test: FORGED-OK\n  ::error::forged';
    const lines = findingsForAddedFile(
      'zz-evil.yml',
      `name: X\npermissions: {}\njobs:\n  ${JSON.stringify(hostile)}:\n    runs-on: x\n`,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]).toContain('FORGED-OK');
    expect(lines[0]).toMatch(/^zz-evil\.yml \/ a ci\.yml/);
  });

  it('a hostile file NAME is quoted rather than emitted raw', () => {
    // `flatten` alone cannot stop this: the name below is pure ASCII with no
    // control byte, and reads as a complete finding about another file.
    const lines = findingsForAddedFile(
      'ci.yml_ but actually.yml',
      'name: X\npermissions: {}\njobs:\n  a:\n    runs-on: x\n',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith('"')).toBe(true);
  });

  it('an oversized field is clamped and the rendered list is capped', () => {
    const many = Array.from({ length: 40 }, (_, i) => `  job${i}:\n    runs-on: x\n`).join('');
    const audit = auditMutatedCopy((dir) =>
      writeFileSync(join(dir, 'zz-many.yml'), `name: X\npermissions: {}\njobs:\n${many}`),
    );
    const lines = render(audit.findings);
    expect(audit.findings).toHaveLength(40);
    expect(lines).toHaveLength(MAX_RENDERED_FINDINGS + 1);
    expect(lines.at(-1)).toBe(`… and ${40 - MAX_RENDERED_FINDINGS} more`);

    const long = 'x'.repeat(500);
    const clamped = findingsForAddedFile(
      'zz-long.yml',
      `name: X\npermissions: ${long}\njobs:\n  a:\n    timeout-minutes: 5\n`,
    );
    expect(clamped[0]?.length).toBeLessThan(MAX_FIELD_LENGTH + 60);
  });
});

describe('flatten covers every row it claims', () => {
  // Round 2 measured that FIVE of the seven rows were unfenced: the only
  // hostile fixture contained 0x0a and 0x20, so deleting the C1 range or any
  // bidi row stayed green while the comment beside them claimed "every bidi
  // control, not only the overrides". Codepoints are built with
  // `String.fromCodePoint` rather than written as escapes, so no literal
  // control character enters this file's own bytes.
  it.each([
    ['NEL, the C1 line break', 0x85],
    ['the arabic letter mark', 0x61c],
    ['the left-to-right mark', 0x200e],
    ['the right-to-left override', 0x202e],
    ['the left-to-right isolate', 0x2066],
    ['a C0 control that is not whitespace', 0x01],
    ['a line separator above 0x20', 0x2028],
  ])('%s is collapsed', (_what, code) => {
    const hostile = `a${String.fromCodePoint(code)}b`;
    expect(safeText(hostile)).toBe('a b');
  });

  it('a run of unsafe characters collapses to a single space', () => {
    const hostile = `a${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x0a)}  b`;
    expect(safeText(hostile)).toBe('a b');
  });
});

describe('the caps are literals, not whatever the constants say', () => {
  // Round 2 measured that widening MAX_FIELD_LENGTH to 499 and
  // MAX_RENDERED_FINDINGS to 39 both stayed green, because the assertions were
  // written in terms of the constants. A bound that moves with the thing it
  // bounds is not a bound.
  it('a field is clamped to 120 characters plus the clip marker', () => {
    expect(safeText('x'.repeat(500))).toHaveLength(121);
    // A long name still MATCHES `WORKFLOW_NAME`, so it takes the passing
    // branch — which is exactly the branch that returned its input raw until
    // round 2, letting a 304-character name through while the constant beside
    // it was documented as "the longest string a rendered finding may carry".
    expect(safeName(`${'x'.repeat(500)}.yml`)).toHaveLength(121);
    // The quoting branch adds the two quotes on top of the same clamp.
    expect(safeName(`${'x'.repeat(500)} not a workflow`)).toHaveLength(123);
  });

  it('at most 21 lines are rendered, whatever the finding count', () => {
    const many = Array.from({ length: 40 }, (_, i) => `  job${i}:\n    runs-on: x\n`).join('');
    const audit = auditMutatedCopy((dir) =>
      writeFileSync(join(dir, 'zz-many.yml'), `name: X\npermissions: {}\njobs:\n${many}`),
    );
    expect(audit.findings).toHaveLength(40);
    expect(render(audit.findings)).toHaveLength(21);
    expect(render(audit.findings).at(-1)).toBe('… and 20 more');
  });

  it('the twins sanitise what they emit, not just the audit', () => {
    // The twins re-read and re-parse independently, so they need their OWN
    // sanitising case: a mutation replacing their `safeName`/`safeText`/
    // `safeJson` calls with raw interpolation survived every other case here
    // (measured). That is the round-2 defect exactly — the twins were the
    // renderer nobody was watching.
    const hostile = `a${String.fromCodePoint(0x0a)}  ci.yml / check-build-test: FORGED`;
    const lines = withMutatedCopy(
      (dir) =>
        writeFileSync(
          join(dir, 'zz-twin.yml'),
          `name: X\npermissions: {}\njobs:\n  ${JSON.stringify(hostile)}:\n    runs-on: x\n`,
        ),
      (dir) => independentlyUnboundedJobs(dir),
    );
    const forged = lines.filter((l) => l.includes('FORGED'));
    expect(forged).toHaveLength(1);
    expect(forged[0]).not.toContain(String.fromCodePoint(0x0a));
    expect(forged[0]?.startsWith('zz-twin.yml / a ')).toBe(true);
  });

  it('the twins are capped too', () => {
    const many = Array.from({ length: 40 }, (_, i) => `  job${i}:\n    runs-on: x\n`).join('');
    const lines = withMutatedCopy(
      (dir) => writeFileSync(join(dir, 'zz-many.yml'), `name: X\npermissions: {}\njobs:\n${many}`),
      (dir) => independentlyUnboundedJobs(dir),
    );
    expect(lines).toHaveLength(21);
  });
});

describe('the file list is filtered and ordered deterministically', () => {
  // Through the pure helper rather than the filesystem: `readdirSync` already
  // returns sorted order on APFS, so no directory this test could build would
  // tell a deleted `.sort()` from a kept one on a developer machine. CI runs on
  // ext4, which returns hash order, so the sort is load-bearing there.
  it('sorts regardless of input order', () => {
    expect(workflowNamesIn(['b.yml', 'a.yml', 'c.yaml'])).toEqual(['a.yml', 'b.yml', 'c.yaml']);
  });

  it('keeps both YAML spellings and drops everything else', () => {
    expect(workflowNamesIn(['a.yml', 'b.yaml', 'c.txt', 'd.yml.bak', 'e.json'])).toEqual([
      'a.yml',
      'b.yaml',
    ]);
  });
});

describe('a hostile workflow cannot escape the audit', () => {
  it('a circular YAML anchor is a finding, not a thrown TypeError', () => {
    // `JSON.stringify` throws on a circular structure, and a YAML anchor can
    // build one. Before `safeJson` that threw OUT of the audit, past `report`,
    // so V8's message — which embeds fork-controlled property names — reached
    // vitest unsanitised and the header's "every unreadable input is a finding"
    // was false for exactly the input a hostile fork would pick.
    expect(
      findingsForAddedFile(
        'zz-cycle.yml',
        'name: X\npermissions: {}\njobs:\n  a: &x\n    timeout-minutes: *x\n',
      ),
    ).toEqual(['zz-cycle.yml / a: timeout-not-a-positive-integer (object)']);
  });

  it.each([
    ['a scalar', 'name: X\npermissions: {}\njobs: hello\n'],
    ['a sequence', 'name: X\npermissions: {}\njobs:\n  - a\n'],
  ])('a jobs node that is %s is reported', (_what, body) => {
    // The `!isMapping(jobsNode)` half, which the empty-mapping case cannot
    // reach — round 2 measured it surviving deletion.
    expect(findingsForAddedFile('zz-jobsnode.yml', body)).toEqual(['zz-jobsnode.yml: no-jobs']);
  });

  it('a file name carrying a bidi override is quoted and clamped', () => {
    // `safeName`'s quoting branch: `JSON.stringify` does NOT escape bidi
    // controls and does not clamp, so the `safeText` inside it is what makes
    // this safe — round 2 measured that dropping it stayed green.
    const name = `zz${String.fromCodePoint(0x202e)}${'n'.repeat(200)}.yml`;
    const lines = findingsForAddedFile(name, 'name: X\npermissions: {}\njobs:\n  a:\n    runs-on: x\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith('"')).toBe(true);
    expect(lines[0]).not.toContain(String.fromCodePoint(0x202e));
    expect(lines[0]?.length).toBeLessThan(140);
  });
});

describe('the floors are load-bearing', () => {
  it('an empty directory reports zero, below both floors', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cdkd-workflow-hardening-empty-'));
    try {
      const audit = auditWorkflowHardening(scratch);
      expect(audit).toEqual({ workflows: 0, jobs: 0, findings: [] });
      // Both, not just one: `MIN_WORKFLOWS` was pinned here from the start and
      // `MIN_JOBS` was not, so setting the latter to zero stayed green
      // everywhere — measured.
      expect(audit.workflows).toBeLessThan(MIN_WORKFLOWS);
      expect(audit.jobs).toBeLessThan(MIN_JOBS);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
