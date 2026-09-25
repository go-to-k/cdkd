import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
 * Deliberately shallow: job names, triggers, `if:` conditions and the script
 * each job runs. It is not a schema validator, and it must not grow into one --
 * the point is that a silent deletion reds, not that YAML is well-formed.
 *
 * `if:` was added by go-to-k/cdkd#2736. It was the last piece of these workflows
 * that decided REAL BEHAVIOUR while no test could read it: four expressions,
 * two of them load-bearing, and deleting either was silent. The worst is the
 * Bot-sender filter, whose failure mode is a comment loop the check then
 * reports on -- see `english-issue` below and `isBotSender` in
 * `scripts/check-gh-body-english.ts`.
 */
interface Expected {
  readonly file: string;
  readonly events: readonly string[];
  /** Per event, the `types:` list. A missing type is a check that never re-runs. */
  readonly types: Readonly<Record<string, readonly string[]>>;
  readonly jobs: readonly string[];
  readonly scripts: readonly string[];
  /**
   * Per JOB KEY, the `if:` expression -- or `null` for "this job must carry no
   * `if:` at all". Every job needs an entry: a new job with no decision
   * recorded here reds, rather than defaulting to unconditional silently.
   */
  readonly jobIfs: Readonly<Record<string, string | null>>;
}

const EXPECTED: readonly Expected[] = [
  {
    file: 'pr-content-checks.yml',
    events: ['pull_request'],
    types: { pull_request: ['opened', 'synchronize', 'reopened', 'edited'] },
    jobs: ['pr-content'],
    scripts: ['scripts/check-pr-non-english-text.ts'],
    // Unconditional: every PR event this workflow subscribes to is one it
    // should run for. An `if:` here would be a filter with nothing to filter.
    jobIfs: { 'pr-content': null },
  },
  {
    file: 'pr-title-check.yml',
    events: ['pull_request'],
    types: { pull_request: ['opened', 'edited', 'synchronize', 'reopened'] },
    jobs: ['check', 'prefix-scope'],
    scripts: ['scripts/check-pr-title-prefix-scope.ts'],
    jobIfs: { check: null, 'prefix-scope': null },
  },
  {
    file: 'issue-conventions.yml',
    events: ['issues', 'issue_comment', 'pull_request'],
    types: {
      issues: ['opened', 'edited'],
      issue_comment: ['created', 'edited'],
      pull_request: ['opened', 'edited', 'synchronize', 'reopened'],
    },
    jobs: ['english-issue', 'english-pr', 'classification-labels'],
    scripts: [
      'scripts/check-gh-body-english.ts',
      'scripts/check-issue-classification-labels.ts',
    ],
    // This workflow subscribes to THREE event families and each job serves one
    // of them, so here the `if:` is what stops a job running on an event it
    // cannot read: `english-pr` on an `issues` payload would find no PR number.
    jobIfs: {
      'english-issue':
        "(github.event_name == 'issues' || github.event_name == 'issue_comment') && " +
        "github.event.sender.type != 'Bot'",
      'english-pr': "github.event_name == 'pull_request'",
      'classification-labels': "github.event_name == 'issues'",
    },
  },
];

/** Compare EXPRESSIONS, not source text: YAML folding decides where the breaks land. */
const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

describe('the CI checks on GitHub artifacts are still wired up', () => {
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
        // `true; # node scripts/check-gh-body-english.ts subject.json` kept it
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

  it.each(EXPECTED.map((e) => [e.file, e] as const))(
    '%s pins the condition on every job',
    (_name, expected) => {
      const doc = wf(expected.file);
      const jobs = doc['jobs'] as Record<string, { if?: unknown }>;

      // The table must COVER the workflow, both ways. Without this a job added
      // with an unreviewed `if:` simply is not looked at, which is the same
      // silence this case exists to end.
      expect(Object.keys(expected.jobIfs).sort(), `${expected.file} jobIfs coverage`).toEqual(
        Object.keys(jobs).sort(),
      );

      for (const [key, want] of Object.entries(expected.jobIfs)) {
        const got = jobs[key]?.['if'];
        if (want === null) {
          expect(got, `${expected.file}:${key} must run unconditionally`).toBeUndefined();
        } else {
          expect(norm(got), `${expected.file}:${key} if:`).toBe(norm(want));
        }
      }
    },
  );

  it('the Bot-sender filter exists in BOTH halves, and only where it belongs', () => {
    // The load-bearing one. `english-issue` and its siblings post comments, and
    // a comment is an `issue_comment: created` event -- unfiltered, this check
    // scans its own output, and fails on it the moment a report QUOTES an
    // offending body back at the author.
    //
    // Asserting the `if:` alone would have been the same trap in a new place:
    // an expression no test can drive. So the rule also lives in the script as
    // `isBotSender`, the script is the authority, and this case pins that the
    // two halves AGREE -- the `if:` filters, and the env var that lets the
    // script decide is actually wired.
    const doc = wf('issue-conventions.yml');
    const jobs = doc['jobs'] as Record<
      string,
      { if?: unknown; steps?: Array<Record<string, unknown>> }
    >;

    expect(norm(jobs['english-issue']?.['if'])).toContain("github.event.sender.type != 'Bot'");

    const envOf = (job: string, stepName: string): Record<string, unknown> => {
      const step = (jobs[job]?.steps ?? []).find((st) => String(st['name'] ?? '') === stepName);
      expect(step, `${job} must have a step named ${stepName}`).toBeDefined();
      return (step?.['env'] ?? {}) as Record<string, unknown>;
    };

    expect(
      norm(envOf('english-issue', 'Check for non-English text')['SENDER_TYPE']),
      'english-issue must hand the sender type to the script',
    ).toBe('${{ github.event.sender.type }}');

    // The NEGATIVE half, and it is a decision rather than an omission: a PR job
    // posts no comment, so there is no loop to break, and skipping a bot-opened
    // PR would drop real coverage. If someone copies the env block across, this
    // reds.
    //
    // Checked at all THREE scopes an env var can be declared at. A step-scoped
    // assertion alone was green while the variable sat on `english-pr`'s job
    // or on the workflow -- either of which reaches the same process and stops
    // bot-opened PR bodies being scanned (go-to-k/cdkd#2736 test review).
    const prJob = jobs['english-pr'] as { env?: Record<string, unknown> } | undefined;
    const wfEnv = (doc['env'] ?? {}) as Record<string, unknown>;
    expect(
      envOf('english-pr', 'Check the PR title and body for non-English text')['SENDER_TYPE'],
      'english-pr must NOT skip bot senders -- it posts no comment, so there is no loop',
    ).toBeUndefined();
    expect(prJob?.env?.['SENDER_TYPE'], 'nor at english-pr JOB scope').toBeUndefined();
    expect(wfEnv['SENDER_TYPE'], 'nor at WORKFLOW scope').toBeUndefined();
  });

  it('the content check in pr-content-checks runs even when a prerequisite fails', () => {
    // The check must still report when an earlier step failed. That is a
    // STEP-level `if:`, and it is as invisible to a test as a job-level one
    // was.
    const doc = wf('pr-content-checks.yml');
    const jobs = doc['jobs'] as Record<string, { steps?: Array<Record<string, unknown>> }>;
    const steps = jobs['pr-content']?.steps ?? [];

    // The invariant: EVERY step after the head fetch carries `!cancelled()`.
    // Exempt are the two PREREQUISITES -- the checkout that supplies the
    // checker, and the head fetch the diff check reads.
    //
    // Over ALL steps, not just `run` ones. Filtering to `run` was the previous
    // shape and it could not see `setup-vp`, a `uses:` step: dropping its `if:`
    // passed while a failed head fetch would skip the node setup and leave the
    // `!cancelled()` check running on whatever node the runner ships, where
    // `--experimental-strip-types` can die outright (measured,
    // go-to-k/cdkd#2736 round-2 review).
    const name = (st: Record<string, unknown>): string =>
      String(st['name'] ?? st['uses'] ?? '').split('@')[0] ?? '';

    // SET equality plus the orderings that carry meaning, rather than the exact
    // sequence (go-to-k/cdkd#2736 round-3 review).
    const names = steps.map(name);
    expect([...names].sort(), 'pr-content step set').toEqual(
      [
        'actions/checkout',
        'fetch the PR head as data',
        'voidzero-dev/setup-vp',
        'non-English writing-system characters in the PR diff',
      ].sort(),
    );
    const at = (n: string): number => names.indexOf(n);
    expect(at('actions/checkout'), 'the checkout supplies the checker').toBe(0);
    expect(at('fetch the PR head as data')).toBeLessThan(at('voidzero-dev/setup-vp'));
    expect(
      at('voidzero-dev/setup-vp'),
      'node must be set up before any checker runs',
    ).toBeLessThan(at('non-English writing-system characters in the PR diff'));

    const PREREQUISITES = new Set(['actions/checkout', 'fetch the PR head as data']);
    for (const st of steps.filter((x) => PREREQUISITES.has(name(x)))) {
      expect(st['if'], `${name(st)} is a prerequisite and must carry no if:`).toBeUndefined();
    }
    for (const st of steps.filter((x) => !PREREQUISITES.has(name(x)))) {
      expect(
        norm(st['if']),
        `pr-content step "${name(st)}" must run even after a sibling fails`,
      ).toBe('${{ !cancelled() }}');
    }
  });

  it('the job holds exactly the permissions its checks need', () => {
    // `contents: read` must be RESTATED at the job, because a job-level block
    // replaces the workflow-level one rather than merging; losing it takes git
    // away from the diff check (go-to-k/cdkd#2736 round-2 review). Nothing
    // wider: the job reads no PR body any more, so `pull-requests: read` would
    // be privilege with no capability behind it.
    const doc = wf('pr-content-checks.yml');
    const jobs = doc['jobs'] as Record<string, { permissions?: Record<string, unknown> }>;
    expect(jobs['pr-content']?.permissions).toEqual({ contents: 'read' });
    // And nothing above it may grant more: a fork PR's body reaches this job.
    expect(doc['permissions']).toEqual({ contents: 'read' });
  });

  it('every reader of a report file is one of the two allowed readers', () => {
    // Replaces a `cat`-forbidding regex, which was FALSE COMFORT. It matched
    // only a line literally starting `cat <arg>`; measured as ALLOWED were
    // `true && cat f`, `printf '%s\\n' "$(cat f)"`, `while read … < f`,
    // `awk 1 f`, `tail -n +1 f`, `nl f`, `sed -n p f`, `tee < f` and
    // `xargs cat` -- and the workflow list was three hand-written names, so
    // `pr-inherit-issue-labels.yml`'s live `cat "$err"` was never scanned
    // (go-to-k/cdkd#2736 round-5 review).
    //
    // Enumerating bad spellings loses that race by construction. So this pins
    // the PROPERTY instead: each report file has exactly two legitimate
    // readers -- the prefixing `sed` that puts it in the LOG, and
    // `gh api -F body=@` which posts it as a COMMENT, where the fence must
    // render unprefixed. Any third reader is the finding, whatever it is
    // spelled with.
    const REPORTS = ['report.md', 'conflict.md', 'comment.md'];
    const dir = join(import.meta.dirname, '../../../.github/workflows');
    const offenders: string[] = [];

    for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
      const doc = wf(file);
      const jobs = (doc['jobs'] ?? {}) as Record<
        string,
        { steps?: Array<Record<string, unknown>> }
      >;
      const runs = Object.values(jobs)
        .flatMap((j) => j.steps ?? [])
        .map((st) => String(st['run'] ?? ''))
        .join('\n')
        .split('\n')
        .map((l) => l.replace(/#.*$/, ''))
        .filter((l) => l.trim() !== '');

      for (const line of runs) {
        for (const report of REPORTS) {
          if (!line.includes(report)) continue;
          const writes = new RegExp(String.raw`>\s*${report}\b`).test(line);
          const prefixed = line.includes(`sed 's/^/| /' ${report}`);
          const posted = new RegExp(String.raw`-F body=@${report}\b`).test(line);
          if (!writes && !prefixed && !posted) {
            offenders.push(`${file}: ${line.trim()}`);
          }
        }
      }
    }
    expect(offenders, 'a report file is read by something other than the log prefix or the comment post').toEqual([]);
  });

  it('every report a workflow prints carries a non-whitespace prefix', () => {
    // Kept, but no longer a magic count. `toBe(4)` bound the NUMBER of `sed`
    // occurrences, so a fifth unprefixed echo passed; the case above binds the
    // property, and this one only asserts the prefix form is the one used.
    const doc = wf('issue-conventions.yml');
    const jobs = doc['jobs'] as Record<string, { steps?: Array<Record<string, unknown>> }>;
    const runs = Object.values(jobs)
      .flatMap((j) => j.steps ?? [])
      .map((st) => String(st['run'] ?? ''))
      .join('\n');
    expect(runs, 'the log prefix must be the `| ` form').toContain("sed 's/^/| /'");
  });

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
