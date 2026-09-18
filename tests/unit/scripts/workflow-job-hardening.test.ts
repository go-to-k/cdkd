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
 *   `pull_request`, and is observed at at least 823 s, so the gap between
 *   what
 *   the job needs and what it was allowed is a factor of about 26. "Longest
 *   measured run" is the framing this file now avoids — see the lower-bound
 *   note below.
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
 *   the two workflows that lacked a block (`ci.yml`, `hooks.yml`) were no
 *   wider than a workflow-level `read` — though wider than the four that pair
 *   `{}` with a narrow per-job grant, since the default grants EVERY scope at
 *   read. But a setting is changed
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
 * WHAT THE MUTATION EVIDENCE IS, AND WHAT IT IS NOT.
 *
 * Every arm NAMED in the probe tables of this PR's commits is killed by a case
 * here, and each was re-measured after the fix. That is the whole claim. It is
 * deliberately NOT "every arm is killed", because this file has said that four
 * times and been wrong four times: a reviewer probed 85 mutants and found arms
 * my 23 missed, then 109 against my 26, then ~135, then 166 — each round the
 * same shape, a table covering exactly the arms its author thought of.
 *
 * So the census is a LOWER BOUND, and re-deriving it is the only way to know
 * more. The residual is real and is stated rather than argued away: arms exist
 * that no case here kills, mostly guards that the real workflow tree cannot
 * reach (a job with two bounds, a name the filesystem cannot hold) and
 * redundant pairs where either alone suffices. Two classes are worth knowing:
 *
 *   - THREE ARMS ARE KILLED BY `vp run typecheck:test`, and for two of them
 *     nothing here kills them as well. Dropping `safeText` from a finding's
 *     `detail` is TS2322 and runtime-invisible; the `typeof timeout !==
 *     'number'` guard, redundant at runtime because `Number.isInteger` does not
 *     coerce, is TS18046 when removed, and so is the twins' own copy of it.
 *     `workflow` and `job` are different — a runtime case DOES red for each, so
 *     an earlier version of this paragraph over-claimed by lumping all the
 *     fields together. None of the three is visible to a run of this file:
 *     vitest's `typecheck.include` is `*.test-d.ts` alone, so the "Type Errors"
 *     line printed here is vacuous.
 *   - `findingsForAddedFile`'s filter is EQUIVALENT while the real tree is
 *     clean, since every synthetic case adds one bad file to a directory that
 *     reports nothing. It earns its place only in the failing case it exists
 *     for, and a diagnostic property cannot be fenced by a green suite. (Its
 *     filter USED to miss a name whose quoting escaped a character, which is
 *     why the quote case below goes around it; the filter compares against
 *     `safeName(name)` now and would match. The case is left as it is — it
 *     asserts on the whole finding list, which is strictly stronger.)
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
// Extracted to a shared module so the sibling fence uses the SAME sanitisers
// rather than a second copy — see that file's header (issue go-to-k/cdkd#3283).
import {
  MAX_FIELD_LENGTH,
  MAX_RENDERED_FINDINGS,
  boundedList,
  flatten,
  quoteClamped,
  safeDetail,
  safeJobId,
  safeName,
  safeText,
  type Safe,
} from '../../../scripts/workflow-log-safety.ts';

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
  readonly workflow: Safe;
  readonly job: Safe | undefined;
  readonly detail: Safe | undefined;
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
const safeJson = (value: unknown): Safe => {
  // `safeText` on the way out, not merely on the way in. `JSON.stringify`
  // escapes only `"`, `\` and U+0000-U+001F — NOT U+0085 (NEL), NOT U+202E
  // (RLO), NOT U+2028 — and it does not clamp. Round 3 measured a 469-character
  // line carrying a raw NEL and a raw RLO through exactly this function, while
  // the assertion one line above it pinned the absence of U+202E in a sibling
  // field. Returning `Safe` is what makes that unrepresentable.
  //
  // AND THE ORDER IS LOAD-BEARING. `safeText(JSON.stringify(v))` stringifies
  // first and clamps second, so a string of 120-odd characters loses its
  // CLOSING QUOTE — the field never terminates and everything after it on the
  // line reads as part of it. Measured rendering
  //   zz-evil.yml / a: "......ci.yml / check-build-test: no-timeout......…
  // through the twin below, which is the one detail site that does not
  // re-sanitise. `quoteClamped` shrinks the inner text until the QUOTED form
  // fits, so the result is always well-formed and always within the cap.
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return safeText(typeof value);
    // Short enough to pass through whole: `360`, `"write-all"`, `2.5` are
    // already well-formed and re-quoting them would only add noise. Only the
    // CLAMP is dangerous, so only the clamping path re-quotes.
    return flatten(json).length <= MAX_FIELD_LENGTH ? safeText(json) : quoteClamped(json);
  } catch {
    return safeText(typeof value);
  }
};




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
      // `safeJobId`, NOT `safeText`, and the difference is the whole reason
      // that helper exists: flattening and clamping do not touch a job id of
      // pure ASCII, and this renderer is `<workflow> / <job>: <kind>`, so a
      // fork declaring a job named `x: no-timeout - and ci.yml / check-build-test`
      // renders a complete fabricated finding against a real critical job, in a
      // run that is genuinely red so the line is genuinely printed. Quoting is
      // what separates them.
      //
      // It arrived here a round late: `safeJobId` was written for the sibling
      // fence and applied only there, which is precisely the "a fix lands in
      // one place and not the other" failure the shared module's own header
      // gives as the reason it exists.
      job: job === undefined ? undefined : safeJobId(job),
      // `safeDetail`, which QUOTES. A detail is free-form prose with no legal
      // shape to test against, it is the LAST field on the rendered line, and
      // for `unparseable` it is a YAML parser's message echoing the fork's own
      // bytes — so a `)` in it closes the parenthesis early and the tail reads
      // as a finding about another job. The tenth venue for this class.
      detail: detail === undefined ? undefined : safeDetail(detail),
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
 * Render findings for an assertion message — one line each, capped.
 *
 * Interpolation here is unguarded BY CONTRACT: `report` sanitised every field.
 * The cap is the second half of that contract — a fork workflow with a thousand
 * jobs would otherwise render a thousand lines.
 */
/**
 * Render order, most actionable first.
 *
 * THIS RENDERER HAD NO ORDER AT ALL, and the cap it shares with the sibling
 * fence made that exploitable: a fork breaks a real workflow so it does not
 * parse, adds twenty-five files of its own with two findings each, and the
 * genuine `unparseable` line appears neither in the twenty kept lines nor among
 * the five names the summary can carry. Measured against this file.
 *
 * A fork can manufacture any number of findings of the kinds it controls, so
 * the defence is that the kinds it cannot manufacture for SOMEONE ELSE'S
 * workflow sort first: a file that will not parse, or whose top level is not a
 * mapping, is the one a reader can act on with no further information.
 */
/**
 * THE PREMISE BELOW WAS WRONG IN ITS FIRST FORM. It said a fork cannot
 * manufacture these kinds for someone else's workflow — but a fork owns
 * `.github/workflows/` in its own PR, so twenty-five files it deliberately
 * breaks are twenty-five findings of the FIRST-ranked kind, and the genuine one
 * is buried by the ranking added to prevent burial (measured). The ranking is
 * still right for ORDER; the protection is that `boundedList` splits the cap
 * between the kinds PRESENT before it splits between workflows, which a fork
 * cannot undo by adding files of one kind.
 */
// `satisfies`, so a kind ADDED to the union without a rank is a compile error;
// `readonly FindingKind[]` catches only a REMOVED one, and a new kind would get
// `indexOf === -1` and sort ahead of everything.
const KIND_RANK = [
  'unparseable',
  'top-level-not-a-mapping',
  'no-jobs',
  'permissions-not-a-mapping',
  'no-top-level-permissions',
  'job-not-a-mapping',
  'timeout-not-a-positive-integer',
  'timeout-at-or-above-default',
  'no-timeout',
] as const satisfies readonly FindingKind[];

const render = (findings: readonly Finding[]): Safe[] => {
  const ordered = [...findings].sort(
    (a, b) => KIND_RANK.indexOf(a.kind) - KIND_RANK.indexOf(b.kind),
  );
  return boundedList(
    ordered.map(
      (f) =>
        // Every interpolated part is `Safe` by `Finding`'s own type, and `kind`
        // is a literal union. The cast is a boundary; `boundedList`'s summary
        // line carries the other one on this path, which an earlier version of
        // this sentence claimed did not exist. What the parameter and return
        // types buy is that no FOURTH renderer can be written without one.
        (`${f.workflow}${f.job === undefined ? '' : ` / ${f.job}`}: ${f.kind}` +
          `${f.detail === undefined ? '' : ` (${f.detail})`}`) as Safe,
    ),
    // The KINDS, so the cap is split between them first. A fork owns
    // `.github/workflows/` in its own PR, so it can produce any number of
    // findings of the top-ranked kind — see `boundedList`.
    ordered.map((f) => f.kind),
  );
};

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
const findingsForAddedFile = (name: string, body: string): Safe[] => {
  const audit = auditMutatedCopy((dir) => writeFileSync(join(dir, name), body));
  // The WHOLE name, not a prefix. An earlier cut cut at the first dot, so
  // `ci.yml_ but actually.yml` filtered on `ci` and also matched every real
  // `ci.yml` finding — a filter that selects more than its subject.
  // EQUALITY against `safeName(name)`, not `includes(safeText(name))`. The
  // audit sanitises with `safeName`, so equality is exact — and the substring
  // form was coupled to the CLAMP ARITHMETIC: it assumed the quoted form
  // contains the unquoted one, which stopped being true when quoting began
  // shrinking the inner text so the closing quote survives. A filter that
  // silently selects NOTHING turns a forgery case into a green one.
  return render(audit.findings.filter((f) => f.workflow === safeName(name)));
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
const deleteJobTimeout = (dir: string, workflow: string, job: string): void => {
  // Anchored on the JOB, not on the bound's value. Anchoring on
  // `timeout-minutes: 5` worked until the bounds were re-measured and `ci-ok`
  // moved 5 -> 10, at which point seven cases failed at once. `deleteUniqueLine`
  // refusing was correct and loud, but a probe that has to be re-anchored every
  // time a value changes is a probe that will eventually be re-anchored wrongly.
  const path = join(dir, workflow);
  const lines = readFileSync(path, 'utf8').split('\n');
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start < 0) {
    throw new Error(`probe anchor: no job \`${safeText(job)}\` in ${safeName(workflow)}`);
  }
  const end = lines.findIndex((line, i) => i > start && /^  [A-Za-z0-9_-]+:\s*$/.test(line));
  const within = lines.slice(start, end < 0 ? lines.length : end);
  const hits = within.filter((line) => /^    timeout-minutes:/.test(line));
  if (hits.length !== 1) {
    throw new Error(
      `probe anchor: ${safeName(workflow)} / ${safeText(job)} has ${hits.length} ` +
        'timeout-minutes lines; ' +
        'a probe whose anchor is absent or ambiguous proves nothing — re-anchor it',
    );
  }
  const target = hits[0];
  writeFileSync(
    path,
    lines.filter((line, i) => !(i >= start && (end < 0 || i < end) && line === target)).join('\n'),
  );
};

/** Replace one named job's bound, refusing if the job or its key is not found. */
const setJobTimeout = (dir: string, workflow: string, job: string, value: string): void => {
  const path = join(dir, workflow);
  const lines = readFileSync(path, 'utf8').split('\n');
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start < 0) {
    throw new Error(`probe anchor: no job \`${safeText(job)}\` in ${safeName(workflow)}`);
  }
  const end = lines.findIndex((line, i) => i > start && /^  [A-Za-z0-9_-]+:\s*$/.test(line));
  let replaced = 0;
  const out = lines.map((line, i) => {
    if (i < start || (end >= 0 && i >= end)) return line;
    if (!/^    timeout-minutes:/.test(line)) return line;
    replaced += 1;
    return `    timeout-minutes: ${value}`;
  });
  if (replaced !== 1) {
    throw new Error(
      `probe anchor: ${safeName(workflow)} / ${safeText(job)} had ${replaced} timeout-minutes lines`,
    );
  }
  writeFileSync(path, out.join('\n'));
};

const deleteUniqueLine = (dir: string, workflow: string, needle: string): void => {
  const path = join(dir, workflow);
  const lines = readFileSync(path, 'utf8').split('\n');
  const hits = lines.filter((line) => line.trim() === needle);
  if (hits.length !== 1) {
    // `safeText` on BOTH interpolated parts. The needle can be a raw line of a
    // fork's workflow — the duplicate-anchor case derives it from the file —
    // and `JSON.stringify` escapes only quote, backslash and C0, so NEL and RLO
    // pass through it unchanged and unclamped. Chai truncates `message` but
    // sets `actual` to the whole string, which vitest prints verbatim. Fourth
    // instance of this class in this file, and the third to appear inside the
    // code that fixed the previous one.
    throw new Error(
      // `quoteClamped`, not `JSON.stringify(safeText(...))`: the order is safe
      // here (well-formed), but clamping BEFORE quoting lets the escaping push
      // the field past the cap — measured at 225 characters against 120 on a
      // fork-controlled `ci.yml` line. This was the last site still carrying
      // the pre-`quoteClamped` spelling.
      //
      // NOT PINNED: reverting it kills no case. This message belongs to the
      // PROBE HARNESS rather than to a rendered finding, so no case asserts its
      // length, and inventing one would pin the harness rather than the fence.
      `probe anchor ${quoteClamped(needle)} matched ${hits.length} lines in ` +
        `${safeName(workflow)}; a probe whose anchor is absent or ambiguous proves nothing ` +
        '— re-anchor it',
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
const twinLabel = (workflow: Safe, job?: Safe, detail?: Safe): Safe =>
  `${workflow}${job === undefined ? '' : ` / ${job}`}${
    detail === undefined ? '' : `: ${detail}`
  }` as Safe;

const independentlyUnboundedJobs = (dir: string): Safe[] => {
  const out: Safe[] = [];
  for (const workflow of workflowNamesIn(readdirSync(dir))) {
    let document: unknown;
    try {
      document = parseYaml(readFileSync(join(dir, workflow), 'utf8'));
    } catch {
      // The message is NOT rendered: it is the fork's own source. That it
      // failed to parse is the whole fact this twin needs.
      out.push(twinLabel(safeName(workflow), undefined, safeText('did not parse')));
      continue;
    }
    // The empty-mapping half matters here as much as in the audit: `isMapping`
    // accepts `{}`, so without it a workflow declaring `jobs: {}` runs an empty
    // loop and the twin reports NOTHING while the audit reports `no-jobs`. A
    // twin that is silent where the audit speaks is not a cross-check.
    if (!isMapping(document) || !isMapping(document['jobs']) || Object.keys(document['jobs']).length === 0) {
      out.push(twinLabel(safeName(workflow), undefined, safeText('no jobs mapping')));
      continue;
    }
    for (const [job, node] of Object.entries(document['jobs'])) {
      const timeout = isMapping(node) ? node['timeout-minutes'] : undefined;
      const ok =
        typeof timeout === 'number' &&
        Number.isInteger(timeout) &&
        timeout >= 1 &&
        timeout < ACTIONS_DEFAULT_TIMEOUT_MINUTES;
      if (!ok) out.push(twinLabel(safeName(workflow), safeJobId(job), safeJson(timeout)));
    }
  }
  return boundedList(out);
};

const independentlyUndeclaredPermissions = (dir: string): Safe[] => {
  const out: Safe[] = [];
  for (const workflow of workflowNamesIn(readdirSync(dir))) {
    let document: unknown;
    try {
      document = parseYaml(readFileSync(join(dir, workflow), 'utf8'));
    } catch {
      out.push(twinLabel(safeName(workflow), undefined, safeText('did not parse')));
      continue;
    }
    if (!isMapping(document) || !isMapping(document['permissions'])) {
      out.push(twinLabel(safeName(workflow)));
    }
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
        deleteJobTimeout(dir, 'ci.yml', 'ci-ok');
        deleteUniqueLine(dir, 'hooks.yml', 'permissions: {}');
      },
      (dir) => [independentlyUnboundedJobs(dir), independentlyUndeclaredPermissions(dir)],
    )).toEqual([['ci.yml / ci-ok: undefined'], ['hooks.yml']]);
  });
});

describe('the audit fails against real code', () => {
  it('a removed timeout in ci.yml is reported, naming the job', () => {
    // Anchored on the JOB, through `deleteJobTimeout`. This comment described
    // value-anchoring for two rounds after the line beneath it stopped doing
    // that — and a near-identical twin of it, twenty lines down, was corrected
    // while this copy was missed. Duplicated prose goes stale one copy at a
    // time, which is the same failure as a count in two places.
    const audit = auditMutatedCopy((dir) => {
      deleteJobTimeout(dir, 'ci.yml', 'ci-ok');
    });
    expect(render(audit.findings)).toEqual(['ci.yml / ci-ok: no-timeout']);
  });

  it('a removed timeout in a MIDDLE job is reported, naming only that job', () => {
    // `once-leak-detect` is the third of five jobs and shares its value with
    // `check-build-test` ABOVE it. That combination is what discriminates the
    // helper's LOWER bound: with `i >= start` dropped, the delete also takes the
    // earlier job's identical line. The round-4 probe picked `check-build-test`
    // — the FIRST job — which by construction cannot see a missing lower bound,
    // the same blind spot as the round-3 probes all targeting last jobs.
    const audit = auditMutatedCopy((dir) => {
      deleteJobTimeout(dir, 'ci.yml', 'once-leak-detect');
    });
    expect(render(audit.findings)).toEqual(['ci.yml / once-leak-detect: no-timeout']);
  });

  it('a removed timeout in a NON-LAST job is reported, naming only that job', () => {
    // Every other probe target happens to be the last job in its file with a
    // file-unique value, so both helpers' job-scoping was unfenced: `end = -1`
    // (scope to end of file) and collapsing the delete filter to `line !==
    // target` (delete every identical line anywhere) both stayed green.
    // `check-build-test` is the FIRST of five jobs in `ci.yml` and shares its
    // value with `once-leak-detect`, so it discriminates both mutations.
    const audit = auditMutatedCopy((dir) => {
      deleteJobTimeout(dir, 'ci.yml', 'check-build-test');
    });
    expect(render(audit.findings)).toEqual(['ci.yml / check-build-test: no-timeout']);
  });

  it('a removed timeout in a second workflow is reported too', () => {
    // A second file, because one probe cannot tell "the audit walks the
    // directory" from "the audit hard-codes ci.yml".
    const audit = auditMutatedCopy((dir) => {
      deleteJobTimeout(dir, 'cfn-schema-refresh.yml', 'refresh');
    });
    expect(render(audit.findings)).toEqual(['cfn-schema-refresh.yml / refresh: no-timeout']);
  });

  it('a removed top-level permissions block is reported', () => {
    const audit = auditMutatedCopy((dir) => {
      deleteUniqueLine(dir, 'hooks.yml', 'permissions: {}');
    });
    expect(render(audit.findings)).toEqual(['hooks.yml: no-top-level-permissions']);
  });

  it("a parse error's own message is flattened and clamped", () => {
    // `detail` is the one fork-controlled field of a finding that had NO runtime
    // case: `detail: detail as Safe | undefined` typechecked AND passed every
    // other case. `.split('\n')[0]` does not save it — measured with the real
    // `yaml` package, an unresolved alias produces a FIRST LINE of 362
    // characters carrying a raw RLO. Only `safeText` does.
    //
    // The sibling case below asserts `not.toContain('unbalanced')`, which the
    // split alone satisfies, so it was satisfiable by construction and fenced
    // nothing here.
    const hostile = `x${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x85)}${'p'.repeat(400)}`;
    const audit = auditMutatedCopy((dir) =>
      writeFileSync(join(dir, 'zz-alias.yml'), `name: X\npermissions: {}\njobs: *${hostile}\n`),
    );
    const finding = audit.findings.find((f) => f.workflow === 'zz-alias.yml');
    expect(finding?.kind).toBe('unparseable');
    const detail = finding?.detail ?? '';
    expect(detail).not.toContain(String.fromCodePoint(0x202e));
    expect(detail).not.toContain(String.fromCodePoint(0x85));
    // WITHIN THE CAP, whatever the escaping. `quoteClamped` shrinks the inner
    // text until the QUOTED form fits, so this is the constant's own bound and
    // not the bound plus whatever `JSON.stringify` added. Two earlier revisions
    // were wrong in both directions: `+ 1` was right only while the field was
    // merely flattened, and `+ 3` conceded the overshoot instead of fixing it.
    expect(detail.length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
    expect(() => JSON.parse(detail) as unknown).not.toThrow();
    // AND it is quoted. NOTE WHAT THIS CASE DOES *NOT* PIN: its fixture
    // carries U+202E and U+0085, so it is quoted because control bytes fail
    // ANY class — the `:` and `/` exclusions that are `DETAIL`'s whole purpose
    // contribute nothing here, and widening the class to admit them left this
    // green. The case below is the one that pins them.
    expect(detail.startsWith('"')).toBe(true);
  });

  it.each([
    ['exactly at the cap passes through unquoted', MAX_FIELD_LENGTH - 2, false],
    ['one character over is re-quoted', MAX_FIELD_LENGTH - 1, true],
  ])('safeJson: a value %s', (_what, len, reQuoted) => {
    // THE BRANCH BOUNDARY, and the decision to measure the FLATTENED length.
    // `<=` -> `<` and `flatten(json).length` -> `json.length` were both green:
    // the first re-quotes a value that already fits, the second measures a
    // length `safeText` would not have produced. Pure ASCII, so flattening is
    // a no-op and only the arithmetic decides.
    const out = safeJson('y'.repeat(len));
    expect(out.startsWith('"\\"')).toBe(reQuoted);
  });

  it('safeJson measures the FLATTENED length, not the raw one', () => {
    // The two lengths differ exactly when flattening COLLAPSES something, and
    // the characters that reach `flatten` are the ones `JSON.stringify` does
    // NOT escape — U+202E among them, while a NUL comes back as the six
    // printable characters `\u0000` and collapses nothing. A run of 300 RLOs is
    // over the cap raw and three characters flattened, so it must take the
    // SHORT branch: that is what `safeText` would produce, and measuring the
    // raw length re-quotes a value that did not need it.
    const value = `y${String.fromCodePoint(0x202e).repeat(300)}y`;
    const out = safeJson(value);
    expect(flatten(JSON.stringify(value)).length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
    expect(JSON.stringify(value).length).toBeGreaterThan(MAX_FIELD_LENGTH);
    expect(out.startsWith('"\\"')).toBe(false);
  });

  it('an oversized timeout VALUE stays well-formed through the twin', () => {
    // THE BLOCKER'S OWN ARM, and nothing pinned it. `safeJson` used to
    // stringify first and clamp second, so a `timeout-minutes` string longer
    // than the cap lost its CLOSING QUOTE — the field never terminated and the
    // rest of the line read as part of it. The twin is the site that matters:
    // it renders the detail LAST and does not re-sanitise.
    //
    // Pure ASCII on purpose: nothing here for `flatten` to remove, so only the
    // quoting arithmetic decides.
    const value = `${'.'.repeat(64)}ci.yml / check-build-test: no-timeout${'.'.repeat(64)}`;
    const lines = withMutatedCopy(
      (dir) =>
        writeFileSync(
          join(dir, 'zz-long.yml'),
          `name: X\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: ${JSON.stringify(value)}\n`,
        ),
      (dir) => independentlyUnboundedJobs(dir),
    );
    const line = lines.find((l) => l.startsWith('zz-long.yml')) ?? '';
    const detail = line.slice(line.indexOf(': ') + 2);
    expect(detail.length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
    // WELL-FORMED, which is the property a dropped closing quote destroys.
    expect(() => JSON.parse(detail) as unknown).not.toThrow();
  });

  it.each([
    ['a colon', 'x: and ci.yml y no-timeout'],
    ['a slash', 'x ci.yml / check-build-test y'],
    ['an opening parenthesis', 'x (and ci.yml y'],
    // `)` IS THE CHARACTER THE THREAT USES — it closes the rendered
    // `(<detail>)` early so the tail reads as a finding of its own, and it is
    // what the module's docstring names. The row above covers only `(`, so
    // admitting `)` alone stayed green: the same disjunction shape this table
    // was written to retire, one member down.
    ['a closing parenthesis', 'x ) and ci.yml y'],
  ])('a detail whose only excluded character is %s is quoted', (_what, detail) => {
    // ONE FIXTURE PER EXCLUDED CHARACTER. The case below carries `:`, `(` and
    // `)` at once, so admitting any ONE of them into `DETAIL` left it green —
    // it pinned the disjunction, not the members. These three differ from a
    // legal detail in exactly one character each.
    expect(safeDetail(detail).startsWith('"')).toBe(true);
    // And the control: the same text with that character removed is NOT quoted,
    // so each row discriminates its own character rather than something else.
    expect(safeDetail(detail.replace(/[:/()]/g, '')).startsWith('"')).toBe(false);
  });

  it('a PURE-ASCII parse error is quoted too, which is what the shape test is for', () => {
    // THE EXCLUSION `DETAIL` EXISTS FOR, pinned by nothing until now: widening
    // the class to admit `:`, `/` and parentheses — the three characters its
    // own comment says are excluded because the line to imitate is
    // `<file> / <job>: <kind> (<detail>)` — left all 212 cases green.
    //
    // An unresolved alias gives a message with no control byte anywhere, so
    // flattening is a no-op and only the shape test decides. The first fixture
    // tried here was quoted because of a `]`, not a `:`, which is the same
    // wrong-reason trap one level up — a case must be chosen for the character
    // it actually pins.
    const audit = auditMutatedCopy((dir) =>
      writeFileSync(join(dir, 'zz-alias2.yml'), 'name: X\npermissions: {}\njobs: *nope\n'),
    );
    const finding = audit.findings.find((f) => f.workflow === 'zz-alias2.yml');
    expect(finding?.kind).toBe('unparseable');
    const detail = finding?.detail ?? '';
    expect(detail).not.toContain(String.fromCodePoint(0x0a));
    expect(detail).not.toContain(String.fromCodePoint(0x202e));
    expect(detail.startsWith('"')).toBe(true);
  });

  it('a workflow that does not parse is a finding, not a silent zero', () => {
    const audit = auditMutatedCopy((dir) => {
      writeFileSync(join(dir, 'ci.yml'), 'name: CI\njobs:\n  a:\n   - [unbalanced\n');
    });
    // Through `boundedList`, not a bare `.map`. This was a FOURTH renderer of a
    // finding — outside `render`, type-safe only by coincidence, and the only
    // UNCAPPED one: measured at 302 lines / 7261 characters against 300 fork
    // workflows while every other list assertion here stopped at 21. Closing
    // `boundedList`'s return type to `Safe[]` is what makes a fifth impossible
    // to write without a cast.
    expect(boundedList(audit.findings.map((f) => `${safeName(f.workflow)}: ${f.kind}` as Safe))).toEqual(
      ['ci.yml: unparseable'],
    );
    // The FIRST LINE only: a YAML parse error's message continues into a code
    // frame quoting the offending source, which is the fork's bytes. Asserting
    // merely that a detail exists let the whole message through (measured).
    const detail = audit.findings[0]?.detail ?? '';
    expect(detail).toBeTruthy();
    expect(detail).not.toContain('unbalanced');
    // And the count it would otherwise have contributed is GONE — which is the
    // reason the floors above are asserted separately from the findings.
    expect(audit.jobs).toBeLessThan(REAL.jobs);
  });

  it('a timeout at the Actions default is reported rather than accepted', () => {
    const audit = auditMutatedCopy((dir) => {
      setJobTimeout(dir, 'ci.yml', 'ci-ok', '360');
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
    // Three cases, not one: `Number.isInteger` and `>= 1` each survive deletion
    // on their own, so a single case leaves the other unfenced. The `typeof`
    // half is NOT among them — it is runtime-redundant and type-only, as the
    // header says; the `'5'` row is here because a quoted number is the shape a
    // reader expects refused, not because it fences a unique runtime arm.
    const audit = auditMutatedCopy((dir) => {
      setJobTimeout(dir, 'ci.yml', 'ci-ok', written);
    });
    expect(render(audit.findings)).toEqual([
      `ci.yml / ci-ok: timeout-not-a-positive-integer (${rendered})`,
    ]);
  });

  it('the structural probe helpers refuse an anchor they cannot resolve', () => {
    // Both were added to end the value-anchor staleness that broke seven cases
    // at once when the bounds were re-measured — and both shipped with their
    // refusal unfenced, which is the same omission one layer over. `ci.yml` has
    // no `nope` job, and `docs-deploy.yml`'s `deploy` is a real job, so the
    // second pair proves the helpers find what does exist.
    expect(() => auditMutatedCopy((dir) => deleteJobTimeout(dir, 'ci.yml', 'nope'))).toThrow(
      /no job `nope` in ci\.yml/,
    );
    expect(() =>
      auditMutatedCopy((dir) => setJobTimeout(dir, 'ci.yml', 'nope', '5')),
    ).toThrow(/no job `nope` in ci\.yml/);
    expect(() =>
      auditMutatedCopy((dir) => deleteJobTimeout(dir, 'docs-deploy.yml', 'deploy')),
    ).not.toThrow();
    expect(() =>
      auditMutatedCopy((dir) => setJobTimeout(dir, 'docs-deploy.yml', 'deploy', '7')),
    ).not.toThrow();
  });

  it('the helpers act on the NAMED job when it is not the last one', () => {
    // `setJobTimeout`'s job scoping had no probe at all — every case used it on
    // `ci-ok`, the last job in `ci.yml`, so `end = -1` was indistinguishable
    // from the real boundary search. Setting the FIRST job's bound must leave
    // every later job's alone.
    const audit = auditMutatedCopy((dir) => setJobTimeout(dir, 'ci.yml', 'check-build-test', '360'));
    expect(render(audit.findings)).toEqual([
      'ci.yml / check-build-test: timeout-at-or-above-default (360 >= 360)',
    ]);
  });

  it('the helpers read the KEY, not the word in a comment', () => {
    // The `^    ` anchor on the key regex: unanchored, a comment mentioning
    // `timeout-minutes:` inside a job body counts as a second hit and the helper
    // refuses a job that is perfectly well formed. Nothing in the real tree
    // writes that, so only a constructed file reaches it.
    const body =
      'name: X\npermissions: {}\njobs:\n  a:\n' +
      '    # a note about timeout-minutes: why this one is what it is\n' +
      '    timeout-minutes: 5\n  b:\n    timeout-minutes: 5\n';
    expect(() =>
      auditMutatedCopy((dir) => {
        writeFileSync(join(dir, 'zz-cmt.yml'), body);
        deleteJobTimeout(dir, 'zz-cmt.yml', 'a');
      }),
    ).not.toThrow();
    // BOTH helpers: the anchor lives in each, and this case previously called
    // only the first, leaving `setJobTimeout`'s copy unfenced.
    expect(() =>
      auditMutatedCopy((dir) => {
        writeFileSync(join(dir, 'zz-cmt.yml'), body);
        setJobTimeout(dir, 'zz-cmt.yml', 'a', '7');
      }),
    ).not.toThrow();
  });

  it.each([
    ['two bounds in one job', '    timeout-minutes: 5\n    timeout-minutes: 6\n', /has 2 timeout-minutes lines|had 2 timeout/],
    ['no bound at all', '    runs-on: x\n', /has 0 timeout-minutes lines|had 0 timeout/],
  ])('the structural helpers refuse a job with %s', (_what, lines, pattern) => {
    // Neither shape occurs in the real tree — every job has exactly one bound,
    // which is what the fence asserts — so these guards are reachable only
    // through a constructed file. They are fenced anyway for the same reason
    // the sibling refusal is: the guard exists for the NEXT edit, and a guard
    // nothing exercises is one that can go inert unnoticed. Both helpers read
    // LINES rather than parsed YAML, so a duplicate key is fine here.
    const body = `name: X\npermissions: {}\njobs:\n  odd:\n${lines}`;
    expect(() =>
      auditMutatedCopy((dir) => {
        writeFileSync(join(dir, 'zz-odd.yml'), body);
        deleteJobTimeout(dir, 'zz-odd.yml', 'odd');
      }),
    ).toThrow(pattern);
    expect(() =>
      auditMutatedCopy((dir) => {
        writeFileSync(join(dir, 'zz-odd.yml'), body);
        setJobTimeout(dir, 'zz-odd.yml', 'odd', '9');
      }),
    ).toThrow(pattern);
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
    // The needle is a RAW line of `ci.yml` — fork-controlled under
    // `pull_request`, measured at 329 characters carrying a bidi override. It
    // is the only unsanitised string this file binds anywhere near an
    // assertion, and while `toBeDefined()` cannot print it today, that is one
    // edit away from being the fifth instance of the forgery this file has
    // already had four of. Assert on the COUNT, and keep the raw line out.
    const duplicated = [...counts].find(([, n]) => n > 1);
    // `.length`, not the ARRAY: `toHaveLength` on the pairs hands the matcher
    // the raw lines, and a failure prints them — which is the venue the comment
    // above says it is avoiding. Safe today only because chai truncates.
    expect([...counts].filter(([, n]) => n > 1).length).toBe(1);
    expect(() =>
      auditMutatedCopy((dir) => deleteUniqueLine(dir, 'ci.yml', duplicated?.[0] ?? '')),
    ).toThrow(/matched [2-9][0-9]* lines in ci\.yml/);
    expect(() =>
      auditMutatedCopy((dir) => deleteUniqueLine(dir, 'ci.yml', 'timeout-minutes: 1234')),
    ).toThrow(/matched 0 lines in ci\.yml/);
    // EQUALITY, not `includes`. The needle is a strict PREFIX of real lines
    // (`timeout-minutes: 1` against `timeout-minutes: 15`), so a substring test
    // would match and delete a bound the probe never named, while equality
    // correctly finds nothing. An earlier version of this case used a needle
    // that matched under neither spelling, which made it vacuous the moment the
    // bounds were re-measured — measured surviving.
    const prefixOfARealBound = 'timeout-minutes: 1';
    const ciLines = readFileSync(join(WORKFLOW_DIR, 'ci.yml'), 'utf8').split('\n');
    expect(ciLines.some((l) => l.trim().startsWith(prefixOfARealBound))).toBe(true);
    expect(ciLines.some((l) => l.trim() === prefixOfARealBound)).toBe(false);
    expect(() =>
      auditMutatedCopy((dir) => deleteUniqueLine(dir, 'ci.yml', prefixOfARealBound)),
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
  it('a hostile job key is flattened AND quoted before it is rendered', () => {
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
    // QUOTED, which flattening alone was not. An earlier revision of this case
    // asserted `/^zz-evil\.yml \/ a ci\.yml/` — i.e. it accepted the flattened
    // text sitting bare in the line, which reads as a finding against a real
    // job even with every control byte gone. That is the threat `safeJobId`
    // was written for, and this fence was still using `safeText` when the
    // sibling had already moved.
    expect(lines[0]).toMatch(/^zz-evil\.yml \/ "a ci\.yml/);
  });

  it('a file name containing a quote cannot break out of the quoting', () => {
    // `JSON.stringify` is doing TWO jobs in `safeName`: wrapping, and ESCAPING.
    // Only the wrapping was fenced — replacing it with a template literal
    // `"${safeText(name)}"` stayed green, and a fork name carrying a `"` then
    // escapes the quotes and reads as a finding about another workflow:
    // measured, `"zz" / ci.yml / check-build-test: no-timeout #.yml"`.
    // No `/` in the name — that would make it a path rather than a file name,
    // and the probe would die creating it rather than measuring anything.
    const name = 'zz" ci.yml: check-build-test no-timeout #.yml';
    // NOT through `findingsForAddedFile`, though it would now work: the filter
    // compared with `includes(safeText(name))` when this case was written, and
    // escaping turns the interior `"` into `\"`, so the needle did not occur.
    // Asserting on the whole finding list is stronger anyway — the real tree
    // reports nothing, so the list IS this file's findings — so the case stays
    // as it is rather than being routed through a helper it does not need.
    const audit = auditMutatedCopy((dir) =>
      writeFileSync(join(dir, name), 'name: X\npermissions: {}\njobs:\n  a:\n    runs-on: x\n'),
    );
    const lines = render(audit.findings);
    expect(lines).toHaveLength(1);
    // The name field must be a WELL-FORMED JSON string: that is exactly what
    // escaping buys, and a bare `"${...}"` wrapper does not. Parsing it back is
    // the assertion — with the escaping gone, the interior quote terminates the
    // string early and this throws.
    const field = String(lines[0]).replace(/ \/ a: no-timeout$/, '');
    expect(field.startsWith('"')).toBe(true);
    expect(JSON.parse(field)).toBe(name);
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
    expect(lines.at(-1)).toMatch(new RegExp(`^… and ${40 - MAX_RENDERED_FINDINGS} more \\(not all shown for: [^,)]+\\)$`));

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

  it.each([
    ['C0, low end', 0x00],
    ['C0, high end', 0x20],
    ['ESC, mid-range', 0x1b],
    ['DEL, low end of the C1 row', 0x7f],
    ['CSI, mid-range of the C1 row', 0x9b],
    ['C1, high end', 0x9f],
    ['LRM, low end of the mark row', 0x200e],
    ['RLM, high end of the mark row', 0x200f],
    ['LRE, low end of the override row', 0x202a],
    ['RLO, high end of the override row', 0x202e],
    ['LRI, low end of the isolate row', 0x2066],
    ['PDI, high end of the isolate row', 0x2069],
  ])('%s is collapsed', (_what, code) => {
    // BOTH ENDS of every range, plus an interior point. Round 3 measured that
    // each range could be collapsed to a single codepoint and stay green —
    // `0x7f..0x9f` to `=== 0x85`, `0x202a..0x202e` to `=== 0x202e` — because
    // one case per ROW fences the row's existence and not its EXTENT. What that
    // permitted is not theoretical: ESC (0x1b) and CSI (0x9b) drive a terminal,
    // and LRE/RLE/PDF reorder a line as surely as RLO does.
    expect(safeText(`a${String.fromCodePoint(code)}b`)).toBe('a b');
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
  it('a field of exactly 120 characters is not clipped', () => {
    // The `>` in `safeText` — with `>=` a field at exactly the cap loses its
    // last character to a marker that says nothing was lost. The same boundary
    // `boundedList` has a 20/21 pair for, which this helper lacked.
    expect(safeText('x'.repeat(MAX_FIELD_LENGTH))).toHaveLength(MAX_FIELD_LENGTH);
    expect(safeText('x'.repeat(MAX_FIELD_LENGTH))).not.toContain('…');
    // Length alone cannot discriminate here: clamped (120 + the marker) and
    // unclamped (121 raw) are both 121. Assert the MARKER.
    expect(safeText('x'.repeat(MAX_FIELD_LENGTH + 1))).toHaveLength(MAX_FIELD_LENGTH + 1);
    expect(safeText('x'.repeat(MAX_FIELD_LENGTH + 1))).toContain('…');
  });

  it('a field is clamped to 120 characters plus the clip marker', () => {
    expect(safeText('x'.repeat(500))).toHaveLength(121);
    // A long name still MATCHES `WORKFLOW_NAME`, so it takes the passing
    // branch — which is exactly the branch that returned its input raw until
    // round 2, letting a 304-character name through while the constant beside
    // it was documented as "the longest string a rendered finding may carry".
    expect(safeName(`${'x'.repeat(500)}.yml`)).toHaveLength(121);
    // The quoting branch clamps the INNER text so the whole quoted field fits,
    // rather than clamping first and adding quotes on top: an earlier revision
    // asserted 123 here, which is this constant's own bound exceeded by the
    // escaping, and the same arithmetic dropped a CLOSING QUOTE when the input
    // contained characters `JSON.stringify` escapes.
    expect(safeName(`${'x'.repeat(500)} not a workflow`)).toHaveLength(120);
    // Well-formed whatever the input: 200 backslashes escape to 400 characters
    // and must still come back as parseable JSON inside the bound.
    const escaped = safeName(`${'\\'.repeat(200)} not a workflow`);
    expect(escaped.length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
    expect(() => JSON.parse(escaped) as unknown).not.toThrow();
  });

  it('at most 21 lines are rendered, whatever the finding count', () => {
    const many = Array.from({ length: 40 }, (_, i) => `  job${i}:\n    runs-on: x\n`).join('');
    const audit = auditMutatedCopy((dir) =>
      writeFileSync(join(dir, 'zz-many.yml'), `name: X\npermissions: {}\njobs:\n${many}`),
    );
    expect(audit.findings).toHaveLength(40);
    expect(render(audit.findings)).toHaveLength(21);
    expect(render(audit.findings).at(-1)).toMatch(/^… and 20 more \(not all shown for: [^,)]+\)$/);
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
    // Quoted here too — the twins render the same job id through the same
    // helper, and a fix that reached only the audit would leave this line bare.
    expect(forged[0]?.startsWith('zz-twin.yml / "a ')).toBe(true);
  });

  // THE CAP CASES BELOW assert the tail EXACTLY. An earlier revision of this
  // note said the `(not all shown for: …)` tail was "unreachable here" — false
  // even as it was written: those cases exceed the cap in ONE workflow, so that
  // workflow is partially dropped and therefore named, which is why their
  // assertions require the tail. What is true is narrower: no group is
  // STARVED, so the starved count is the only part that varies.
  it('a fork flooding the TOP kind cannot bury a finding of another kind', () => {
    // The sibling's case, here too: a fork owns this directory in its own PR,
    // so twenty-five files it breaks are twenty-five `unparseable` findings —
    // the kind this file ranks FIRST. Splitting the cap between the KINDS
    // present is what keeps another kind's line visible, and it only works
    // because `render` passes the kinds to `boundedList`.
    const audit = auditMutatedCopy((dir) => {
      for (let i = 0; i < 25; i += 1) writeFileSync(join(dir, `zz-fork${i}.yml`), 'jobs: [\n');
      writeFileSync(join(dir, 'zz-real.yml'), 'name: X\npermissions: {}\njobs:\n  a:\n    runs-on: x\n');
    });
    const lines = render(audit.findings);
    expect(lines.some((l) => l.startsWith('zz-real.yml') && l.includes('no-timeout'))).toBe(true);
  });

  it('a workflow that will not PARSE survives a flood from twenty-five others', () => {
    // THE TWELFTH VENUE, and the one the round-9 sort was supposed to have
    // closed. It lifted `too-tight` in the sibling and nothing here, so a fork
    // that breaks a real workflow and adds files of its own buried the genuine
    // `unparseable` line in the kept lines AND in the five names. Measured:
    // `ci.yml` appeared nowhere. A fork can manufacture any number of its own
    // findings, so the kinds it cannot manufacture for someone else's workflow
    // are what must sort first.
    const audit = auditMutatedCopy((dir) => {
      writeFileSync(join(dir, 'ci.yml'), 'jobs: [\n');
      for (let i = 0; i < 25; i += 1) {
        writeFileSync(join(dir, `aaa${String(i).padStart(2, '0')}.yml`), 'jobs:\n  a:\n    runs-on: x\n');
      }
    });
    const lines = render(audit.findings);
    expect(lines[0]?.startsWith('ci.yml')).toBe(true);
    expect(lines[0]).toContain('unparseable');
  });

  it('every rank in the table is load-bearing, not just the first', () => {
    // FIVE OF NINE RANKS WERE FREE: the only flood fixture wrote
    // `jobs:\n  a:\n    runs-on: x`, which yields exactly two kinds, so lifting
    // any of the other five to rank 0 stayed green. One file per kind fixes it.
    const audit = auditMutatedCopy((dir) => {
      writeFileSync(join(dir, 'zz-a-broken.yml'), 'jobs: [\n');
      writeFileSync(join(dir, 'zz-b-seq.yml'), '- a\n');
      writeFileSync(join(dir, 'zz-c-nojobs.yml'), 'name: X\npermissions: {}\n');
      writeFileSync(join(dir, 'zz-d-permstr.yml'), 'permissions: write-all\njobs:\n  a:\n    timeout-minutes: 5\n');
      writeFileSync(join(dir, 'zz-e-noperm.yml'), 'jobs:\n  a:\n    timeout-minutes: 5\n');
      writeFileSync(join(dir, 'zz-f-jobstr.yml'), 'permissions: {}\njobs:\n  a: hello\n');
      writeFileSync(join(dir, 'zz-g-badnum.yml'), 'permissions: {}\njobs:\n  a:\n    timeout-minutes: 2.5\n');
      writeFileSync(join(dir, 'zz-h-default.yml'), 'permissions: {}\njobs:\n  a:\n    timeout-minutes: 360\n');
      writeFileSync(join(dir, 'zz-i-none.yml'), 'permissions: {}\njobs:\n  a:\n    runs-on: x\n');
    });
    const order = render(audit.findings)
      .filter((l) => l.startsWith('zz-'))
      .map((l) => l.slice(l.lastIndexOf(': ') + 2).replace(/ \(.*$/, ''));
    // Each kind's first appearance, in table order.
    const firstSeen: string[] = [];
    for (const kind of order) if (!firstSeen.includes(kind)) firstSeen.push(kind);
    expect(firstSeen).toEqual([...KIND_RANK].filter((k) => order.includes(k)));
  });

  it('an unparseable file outranks a top-level that is not a mapping', () => {
    // The order WITHIN the lifted set, claimed by `KIND_RANK`'s comment and
    // pinned by nothing until now — swapping the first two entries stayed green
    // because no case carried both kinds. A file that will not parse at all is
    // the more actionable of the two.
    const audit = auditMutatedCopy((dir) => {
      writeFileSync(join(dir, 'zz-notmap.yml'), '- a\n- b\n');
      writeFileSync(join(dir, 'zz-broken.yml'), 'jobs: [\n');
    });
    const lines = render(audit.findings).filter((l) => l.startsWith('zz-'));
    expect(lines[0]).toContain('unparseable');
    expect(lines[1]).toContain('top-level-not-a-mapping');
  });

  it('exactly 20 findings are rendered whole, 21 are capped', () => {
    // The `>` in `boundedList` — with `>=` the twentieth list loses a line to a
    // "… and 0 more" that says nothing. No case sat at the boundary before.
    const jobs = (n: number) =>
      Array.from({ length: n }, (_, i) => `  job${i}:\n    runs-on: x\n`).join('');
    const at20 = auditMutatedCopy((dir) =>
      writeFileSync(join(dir, 'zz-20.yml'), `name: X\npermissions: {}\njobs:\n${jobs(20)}`),
    );
    expect(render(at20.findings)).toHaveLength(20);
    expect(render(at20.findings).at(-1)).not.toContain('more');

    const at21 = auditMutatedCopy((dir) =>
      writeFileSync(join(dir, 'zz-21.yml'), `name: X\npermissions: {}\njobs:\n${jobs(21)}`),
    );
    expect(render(at21.findings)).toHaveLength(21);
    expect(render(at21.findings).at(-1)).toMatch(/^… and 1 more \(not all shown for: [^,)]+\)$/);
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

describe('every sanitiser is exercised at runtime, not only by the type', () => {
  // The brand stops a CALL SITE forgetting a sanitiser — probed: passing a raw
  // job key to `twinLabel` is TS2345. It cannot stop a sanitiser casting an
  // unsanitised value to `Safe` internally, since that is the one place the
  // cast has to live. Measured: making `safeJson` return
  // `JSON.stringify(v) as Safe` yields zero type errors and a green suite. So
  // each sanitiser needs its own runtime case, and these are they.

  it('safeJson flattens and clamps, not just stringifies', () => {
    // `JSON.stringify` escapes only `"`, `\` and U+0000-U+001F. Round 3
    // measured a 469-character line carrying raw NEL and RLO through here.
    const hostile = `${String.fromCodePoint(0x85)}x${String.fromCodePoint(0x202e)}${'p'.repeat(400)}`;
    const out = safeJson(hostile);
    expect(out).not.toContain(String.fromCodePoint(0x85));
    expect(out).not.toContain(String.fromCodePoint(0x202e));
    expect(out.length).toBeLessThanOrEqual(MAX_FIELD_LENGTH + 1);
  });

  it('safeJson keeps reporting when stringify refuses', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(safeJson(cyclic)).toBe('object');
    expect(safeJson(undefined)).toBe('undefined');
  });
});

describe('the twins are exercised against hostile trees, not only clean ones', () => {
  // Round 3 measured that the `try` around the twins' `parseYaml` — the exact
  // thing round 2 blocked on — had NO case: deleting it, or replacing its catch
  // body with a raw leak, stayed green, because `withMutatedCopy` was only ever
  // called with still-valid YAML. Twelve further twin arms survived for the
  // same reason. A guard added in a fix round is the least-tested code there is.

  const twinLines = (name: string, body: string): { jobs: string[]; perms: string[] } =>
    withMutatedCopy(
      (dir) => writeFileSync(join(dir, name), body),
      // The WHOLE name. This filter cut at the first dot for three rounds —
      // the exact prefix bug `findingsForAddedFile` names and fixed, duplicated
      // here and left behind, which is the "one copy at a time" staleness this
      // file complains about elsewhere. Inert while every fixture is `zz-`
      // prefixed, and a defect the moment one is not.
      (dir) => ({
        jobs: independentlyUnboundedJobs(dir).filter((l) => l.includes(name)),
        perms: independentlyUndeclaredPermissions(dir).filter((l) => l.includes(name)),
      }),
    );

  it('an unparseable workflow reaches both twins without leaking its source', () => {
    const marker = '::error::forged-by-a-fork';
    const { jobs, perms } = twinLines('zz-bad.yml', `name: X\njobs:\n  a:\n   - [${marker}\n`);
    expect(jobs).toEqual(['zz-bad.yml: did not parse']);
    expect(perms).toEqual(['zz-bad.yml: did not parse']);
    // The parser's message quotes the offending source; neither twin may carry it.
    expect(jobs.join('')).not.toContain(marker);
    expect(perms.join('')).not.toContain(marker);
  });

  it('a hostile timeout VALUE is sanitised by the jobs twin', () => {
    const hostile = `${String.fromCodePoint(0x85)}  ci.yml / check-build-test: 5${String.fromCodePoint(0x202e)}${'p'.repeat(400)}`;
    const { jobs } = twinLines(
      'zz-val.yml',
      `name: X\npermissions: {}\njobs:\n  a:\n    timeout-minutes: ${JSON.stringify(hostile)}\n`,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).not.toContain(String.fromCodePoint(0x85));
    expect(jobs[0]).not.toContain(String.fromCodePoint(0x202e));
    expect(jobs[0]?.length).toBeLessThan(MAX_FIELD_LENGTH + 40);
  });

  it('both twins walk the same file set as the audit', () => {
    // The twins call `workflowNamesIn` too; replacing it with a bare
    // `readdirSync` survived every other case, because no scratch copy had ever
    // contained a non-YAML file while a twin ran. A twin that walks a wider set
    // than the audit is a twin that reports findings the audit cannot, which is
    // the opposite of the cross-check it exists to be.
    const lines = withMutatedCopy(
      (dir) => {
        writeFileSync(join(dir, 'zz-notes.txt'), 'name: X\njobs:\n  a:\n    runs-on: x\n');
        writeFileSync(join(dir, 'zz-readme.md'), 'permissions: nope\n');
      },
      (dir) => [...independentlyUnboundedJobs(dir), ...independentlyUndeclaredPermissions(dir)],
    );
    expect(lines).toEqual([]);
  });

  it.each([
    ['an empty file', ''],
    ['a scalar', 'just a string\n'],
    ['a null job node', 'name: X\npermissions: {}\njobs:\n  a:\n'],
  ])('the twins survive %s rather than throwing', (_what, body) => {
    // `!isMapping(document)` and `isMapping(node)` both survived deletion in the
    // twins: written without them these THROW on exactly these shapes, and the
    // audit's own cases never exercise the twins. A twin that throws is a twin
    // that takes the suite down instead of reporting.
    const { jobs, perms } = twinLines('zz-shape.yml', body);
    expect(jobs.length + perms.length).toBeGreaterThan(0);
  });

  it('a workflow with no jobs mapping is reported by the jobs twin', () => {
    // The twin's own `no jobs mapping` arm, which survived deletion until this
    // case existed — every other twin case supplies a jobs mapping.
    const { jobs } = twinLines('zz-nojobs.yml', 'name: X\npermissions: {}\n');
    expect(jobs).toEqual(['zz-nojobs.yml: no jobs mapping']);
  });

  it.each([
    ['an empty mapping', 'name: X\npermissions: {}\njobs: {}\n'],
    ['a scalar', 'name: X\npermissions: {}\njobs: hello\n'],
  ])('the jobs twin agrees with the audit when jobs is %s', (_what, body) => {
    // `isMapping({})` passes, so without the empty-mapping half the twin runs an
    // empty loop and says nothing while the audit reports `no-jobs`.
    const { jobs } = twinLines('zz-emptyjobs.yml', body);
    expect(jobs).toEqual(['zz-emptyjobs.yml: no jobs mapping']);
    expect(findingsForAddedFile('zz-emptyjobs.yml', body)).toEqual(['zz-emptyjobs.yml: no-jobs']);
  });

  it('a hostile file NAME is quoted by both twins', () => {
    const name = `zz${String.fromCodePoint(0x202e)}bad.yml`;
    const lines = withMutatedCopy(
      (dir) => writeFileSync(join(dir, name), 'name: X\njobs:\n  a:\n    runs-on: x\n'),
      (dir) => [...independentlyUnboundedJobs(dir), ...independentlyUndeclaredPermissions(dir)],
    ).filter((l) => l.startsWith('"'));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).not.toContain(String.fromCodePoint(0x202e));
  });

  it.each([
    ['write-all', 'a scalar grant'],
    ['', 'an empty value'],
  ])('the permissions twin rejects %s (%s)', (value, _why) => {
    const { perms } = twinLines(
      'zz-ptwin.yml',
      `name: X\npermissions: ${value}\njobs:\n  a:\n    timeout-minutes: 5\n`,
    );
    expect(perms).toEqual(['zz-ptwin.yml']);
  });

  it.each([
    ['360', 'at the Actions default'],
    ['0', 'below one'],
    ['2.5', 'not a whole minute'],
    ["'5'", 'a string'],
  ])('the jobs twin rejects a timeout of %s (%s)', (written, _why) => {
    // Only the `undefined` arm of the four-way conjunction was reachable before,
    // so `Number.isInteger`, `>= 1` and `< 360` each survived deletion.
    const { jobs } = twinLines(
      'zz-jtwin.yml',
      `name: X\npermissions: {}\njobs:\n  a:\n    timeout-minutes: ${written}\n`,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.startsWith('zz-jtwin.yml / a: ')).toBe(true);
  });

  it('the permissions twin is capped as well as the jobs twin', () => {
    const lines = withMutatedCopy(
      (dir) => {
        for (let i = 0; i < 40; i += 1) {
          writeFileSync(join(dir, `zz-p${i}.yml`), 'name: X\njobs:\n  a:\n    timeout-minutes: 5\n');
        }
      },
      (dir) => independentlyUndeclaredPermissions(dir),
    );
    expect(lines).toHaveLength(21);
    // FORTY FILES, so this is the one case in this file with more groups than
    // the cap — 20 workflows get a line and 20 are crowded out entirely, which
    // is exactly what the summary names. The other three cap cases put all
    // their findings in ONE workflow and assert the bare form.
    expect(lines.at(-1)).toMatch(/^… and 20 more \(not all shown for: .*and 15 more; \d+ workflows? shows? no line at all\)$/);
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

  it('the floors are close enough to the real counts to catch a partial walk', () => {
    // An empty directory pins only "greater than zero", so `MIN_WORKFLOWS = 1`
    // and `MIN_JOBS = 1` both stayed green (measured) — floors that would not
    // notice a directory walk returning one file. These bracket them against
    // the real magnitudes instead, loosely enough that adding a workflow does
    // not fail an unrelated PR.
    // Proportional, not a fixed margin. `REAL.jobs - 4` reds as soon as one
    // three-job workflow is added, which is exactly the "fails an unrelated PR"
    // outcome the comment above promises it avoids. Half the real count still
    // catches a walk that collapses to a handful of entries.
    expect(MIN_WORKFLOWS * 2).toBeGreaterThanOrEqual(REAL.workflows);
    expect(MIN_JOBS * 2).toBeGreaterThanOrEqual(REAL.jobs);
  });
});
