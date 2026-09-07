import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vite-plus/test';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const wf = (name: string): Record<string, unknown> =>
  parse(readFileSync(join(REPO_ROOT, '.github/workflows', name), 'utf8')) as Record<string, unknown>;

/**
 * REGISTRATION, for the checks that used to be PreToolUse hooks.
 *
 * go-to-k/cdkd#2717 moved seven gates out of `.claude/hooks/**` and into CI. The
 * deleted hook suites each carried a case asserting the hook was REGISTERED in
 * `.claude/settings.json` (`gh-body-english-gate.test.sh` and
 * `issue-dup-check-gate.test.sh` both did), because a hook that exists and is
 * not wired up is indistinguishable from one that works. The port dropped that
 * property: before this file, deleting a whole job left every one of the new
 * tests green, since they all import functions directly and never read a
 * workflow.
 *
 * That is the same failure the issue's own rationale names -- "a workflow step
 * that does not run is a missing check on the PR" -- so it has to be fenced
 * rather than asserted. The unit suites test the DECISION; this tests that
 * something still asks for it.
 *
 * Deliberately shallow: job names, triggers and the script each job runs. It is
 * not a schema validator, and it must not grow into one -- the point is that a
 * silent deletion reds, not that YAML is well-formed.
 */
interface Expected {
  readonly file: string;
  readonly events: readonly string[];
  /** Per event, the `types:` list. A missing type is a check that never re-runs. */
  readonly types: Readonly<Record<string, readonly string[]>>;
  readonly jobs: readonly string[];
  readonly scripts: readonly string[];
}

const EXPECTED: readonly Expected[] = [
  {
    file: 'pr-content-checks.yml',
    events: ['pull_request'],
    types: { pull_request: ['opened', 'synchronize', 'reopened', 'edited'] },
    jobs: ['pr-content'],
    scripts: ['scripts/check-pr-non-english-text.ts', 'scripts/check-pr-internal-labels.ts'],
  },
  {
    file: 'pr-title-check.yml',
    events: ['pull_request'],
    types: { pull_request: ['opened', 'edited', 'synchronize', 'reopened'] },
    jobs: ['check', 'prefix-scope'],
    scripts: ['scripts/check-pr-title-prefix-scope.ts'],
  },
  {
    file: 'issue-conventions.yml',
    events: ['issues', 'issue_comment', 'pull_request'],
    types: {
      issues: ['opened', 'edited'],
      issue_comment: ['created', 'edited'],
      pull_request: ['opened', 'edited', 'synchronize', 'reopened'],
    },
    jobs: ['english-issue', 'english-pr', 'classification-labels', 'dup-check'],
    scripts: [
      'scripts/check-gh-body-english.ts',
      'scripts/check-issue-classification-labels.ts',
      'scripts/check-issue-dup-check.ts',
    ],
  },
];

describe('the CI checks that replaced PreToolUse gates are still wired up', () => {
  it.each(EXPECTED.map((e) => [e.file, e] as const))('%s declares its jobs', (_name, expected) => {
    const doc = wf(expected.file);
    expect(Object.keys((doc['jobs'] ?? {}) as object).sort()).toEqual([...expected.jobs].sort());
  });

  it.each(EXPECTED.map((e) => [e.file, e] as const))(
    '%s subscribes to every event that can change what it checks',
    (_name, expected) => {
      const doc = wf(expected.file);
      // `on:` parses as the boolean true in YAML 1.1; the repo's `yaml` dep is
      // 1.2 and keeps the string, but read both so this cannot silently see {}.
      const on = (doc['on'] ?? doc[true as unknown as string]) as Record<string, unknown>;
      expect(Object.keys(on ?? {}).sort()).toEqual([...expected.events].sort());

      // The TYPES too, not just the event name. A first version compared only
      // the top-level keys, and the go-to-k/cdkd#2717 fix-delta review measured
      // that deleting `- synchronize`, and deleting the whole `types:` block,
      // both PASSED -- which is the precise regression these workflows'
      // own comments document: a required check that never re-runs leaves the
      // PR waiting on a status that never arrives.
      for (const [event, types] of Object.entries(expected.types)) {
        const decl = (on?.[event] ?? {}) as { types?: string[] };
        expect(decl.types?.slice().sort(), `${expected.file} ${event} types`).toEqual(
          [...types].sort(),
        );
      }
    },
  );

  it.each(EXPECTED.map((e) => [e.file, e] as const))(
    '%s still invokes each script it exists to run',
    (_name, expected) => {
      // The INVOCATION, parsed out of `jobs.*.steps[].run` -- not a substring of
      // the file. `toContain` on the raw text was satisfied by each script's own
      // path appearing in the workflow's HEADER COMMENT, so deleting every
      // `node scripts/check-*` line left all six assertions green (measured,
      // go-to-k/cdkd#2717 review). That is the same dead-fence class this file's
      // checkout-ref case was already rewritten for -- twice in one file, which
      // is why the rule is now: parse the structure, never grep the document.
      const doc = wf(expected.file);
      const jobs = doc['jobs'] as Record<string, { steps?: Array<Record<string, unknown>> }>;
      const runs = Object.values(jobs)
        .flatMap((j) => j.steps ?? [])
        .map((st) => String(st['run'] ?? ''))
        .join('\n')
        // Shell COMMENTS inside a `run:` block are prose too, and the comment
        // can start MID-LINE. Two rounds of this: the first version of this
        // assertion was satisfied by the workflow's YAML header comment; the
        // fix for that dropped only WHOLE-line `#` comments, and
        // `true; # node scripts/check-issue-dup-check.ts subject.json` kept it
        // green against the real workflow while the check never ran (measured,
        // go-to-k/cdkd#2717 review). Truncate at `#` instead.
        //
        // A `#` inside a quoted string would be truncated too. That direction is
        // safe: it can only make this assertion FAIL on a legitimate command,
        // which is loud, never pass on a missing one.
        .split('\n')
        .map((l) => l.replace(/#.*$/, ''))
        .join('\n');
      for (const script of expected.scripts) {
        // `node [flags] <script>` on ONE run line. The flags vary and that is
        // fine -- `pr-content-checks.yml` passes `--experimental-strip-types`
        // where `pr-title-check.yml` relies on Node 24 stripping by default --
        // but `node` and the path must appear together in an executed command,
        // which is exactly what a raw-text `toContain` could not tell apart
        // from a mention in a comment.
        const invoked = new RegExp(
          String.raw`(^|\n)[^\n]*\bnode\b[^\n]*\s${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\s|$)`,
          'm',
        );
        expect(
          invoked.test(runs),
          `${expected.file} must RUN ${script} in a step, not merely mention it`,
        ).toBe(true);
      }
    },
  );

  it('every checker script a workflow names actually exists', () => {
    // The inverse direction: a rename that updates the workflow but not the file
    // (or the reverse) is a check that dies with ERR_MODULE_NOT_FOUND at run
    // time, which on a required check reds every PR until someone notices.
    for (const expected of EXPECTED) {
      for (const script of expected.scripts) {
        expect(() => readFileSync(join(REPO_ROOT, script), 'utf8')).not.toThrow();
      }
    }
  });

  it('a PR-judging job takes its checker from base on a FORK and from head otherwise', () => {
    // The trust/bootstrap split the go-to-k/cdkd#2717 review forced: pinning the
    // head lets a fork supply the checker that judges it; pinning base
    // unconditionally means the PR ADDING a checker runs a base without it and
    // can never go green. Both halves were live defects.
    //
    // This compares the PARSED `with.ref` expression, not a substring of the
    // file. The first version did the latter, and the fix-delta review measured
    // it surviving BOTH defects it exists to catch: swapping the ternary arms
    // (so a fork supplies its own checker) passed, and deleting `ref:` outright
    // passed too, because the literal it grepped for also appears in the
    // rationale COMMENT beside it. A fence that its own subject's prose can
    // satisfy is not a fence.
    const WANT =
      "${{ github.event.pull_request.head.repo.full_name == github.repository " +
      '&& github.event.pull_request.head.sha ' +
      '|| github.event.pull_request.base.sha }}';
    const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
    for (const [file, job] of [
      ['pr-content-checks.yml', 'pr-content'],
      ['pr-title-check.yml', 'prefix-scope'],
      ['issue-conventions.yml', 'english-pr'],
    ] as const) {
      const doc = wf(file);
      const jobs = doc['jobs'] as Record<string, { steps?: Array<Record<string, unknown>> }>;
      const steps = jobs[job]?.steps ?? [];
      const checkout = steps.find((st) => String(st['uses'] ?? '').includes('actions/checkout'));
      expect(checkout, `${file}:${job} must check out`).toBeDefined();
      const ref = (checkout?.['with'] as Record<string, unknown> | undefined)?.['ref'];
      expect(norm(ref), `${file}:${job} checkout ref`).toBe(norm(WANT));
    }
  });
});
