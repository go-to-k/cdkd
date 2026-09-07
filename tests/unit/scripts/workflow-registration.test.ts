import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    scripts: [
      'scripts/check-pr-non-english-text.ts',
      'scripts/check-pr-internal-labels.ts',
      'scripts/check-pr-closes-paren.ts',
    ],
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
    jobs: ['english-issue', 'english-pr', 'classification-labels', 'dup-check'],
    scripts: [
      'scripts/check-gh-body-english.ts',
      'scripts/check-issue-classification-labels.ts',
      'scripts/check-issue-dup-check.ts',
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
      'dup-check': "github.event_name == 'issues' && github.event.action == 'opened'",
    },
  },
];

/** Compare EXPRESSIONS, not source text: YAML folding decides where the breaks land. */
const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

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

  it('every content check in pr-content-checks runs even when a sibling fails', () => {
    // One PR round-trip must report every content violation, not one family at
    // a time. That is a STEP-level `if:` on each check after the first, and it
    // is as invisible to a test as a job-level one was.
    const doc = wf('pr-content-checks.yml');
    const jobs = doc['jobs'] as Record<string, { steps?: Array<Record<string, unknown>> }>;
    const steps = jobs['pr-content']?.steps ?? [];

    // The invariant: EVERY step after the head fetch carries `!cancelled()`, so
    // one PR round-trip reports every content violation rather than one family
    // at a time. Exempt are the two PREREQUISITES -- the checkout that supplies
    // the checkers, and the head fetch the two diff checks read.
    //
    // Over ALL steps, not just `run` ones. Filtering to `run` was the previous
    // shape and it could not see `setup-vp`, a `uses:` step: dropping its `if:`
    // passed 19 of 19 while a failed head fetch would skip the node setup and
    // leave four `!cancelled()` checks running on whatever node the runner
    // ships, where `--experimental-strip-types` can die outright (measured,
    // go-to-k/cdkd#2736 round-2 review).
    const name = (st: Record<string, unknown>): string =>
      String(st['name'] ?? st['uses'] ?? '').split('@')[0] ?? '';

    // SET equality plus the orderings that carry meaning, rather than the exact
    // sequence. Swapping the two independent diff checks is harmless and used
    // to red this for no safety gain; what must hold is that the prerequisites
    // come first and that the subject is built before it is read
    // (go-to-k/cdkd#2736 round-3 review).
    const names = steps.map(name);
    expect([...names].sort(), 'pr-content step set').toEqual(
      [
        'actions/checkout',
        'fetch the PR head as data',
        'voidzero-dev/setup-vp',
        'non-English writing-system characters in the PR diff',
        'internal PR labels in user-facing docs',
        'build the PR subject document',
        'auto-close keyword written in parens form',
      ].sort(),
    );
    const at = (n: string): number => names.indexOf(n);
    expect(at('actions/checkout'), 'the checkout supplies the checkers').toBe(0);
    expect(at('fetch the PR head as data')).toBeLessThan(at('voidzero-dev/setup-vp'));
    expect(
      at('voidzero-dev/setup-vp'),
      'node must be set up before any checker runs',
    ).toBeLessThan(at('non-English writing-system characters in the PR diff'));
    expect(
      at('build the PR subject document'),
      'the subject must be built before it is read',
    ).toBeLessThan(at('auto-close keyword written in parens form'));

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

  it('the subject document is written and read at the SAME path', () => {
    // HIGH-value and it was unfenced: `grep -rn RUNNER_TEMP tests/` returned
    // nothing. The producer writes `$RUNNER_TEMP/subject.json` and the consumer
    // reads it; rename either side and the check warns "no subject document",
    // exits 0, and is permanently, silently green -- reached through the one
    // surface no test read (go-to-k/cdkd#2736 round-2 review).
    //
    // The path is DERIVED from the producer, not hard-coded here, so this pins
    // AGREEMENT rather than a spelling. A rename that moves both sides together
    // is fine and should stay fine.
    const doc = wf('pr-content-checks.yml');
    const jobs = doc['jobs'] as Record<string, { steps?: Array<Record<string, unknown>> }>;
    const steps = jobs['pr-content']?.steps ?? [];
    const runOf = (name: string): string => {
      const st = steps.find((x) => String(x['name'] ?? '') === name);
      expect(st, `pr-content must have a step named ${name}`).toBeDefined();
      return String(st?.['run'] ?? '');
    };

    const producer = runOf('build the PR subject document');
    const consumer = runOf('auto-close keyword written in parens form');

    // The path the producer finally MOVES the subject to -- not the temp name
    // it builds into, and not the `rm -f` line, both of which name other files.
    const moved = /\bmv\s+"([^"]+)"\s+"([^"]+)"/.exec(producer);
    expect(moved, 'the producer must move the subject into place atomically').not.toBeNull();
    const written = moved?.[2] ?? '';
    expect(written, 'the subject must land under $RUNNER_TEMP').toContain('$RUNNER_TEMP');

    // Every path the consumer names must be that one -- both its existence
    // guard and the argument it hands the checker.
    const consumerPaths = [...consumer.matchAll(/"(\$RUNNER_TEMP[^"]*)"/g)].map((m) => m[1]);
    expect(consumerPaths.length, 'the consumer must name the subject path').toBeGreaterThan(0);
    for (const path of consumerPaths) {
      expect(path, 'consumer reads a path the producer never writes').toBe(written);
    }

    // The mv SOURCE must be what jq actually wrote. Pinning the destination
    // alone left the producer free to move a file nothing had written
    // (go-to-k/cdkd#2736 round-3 review).
    // Comments stripped, and anchored on the real `jq -e` invocation. A first
    // version matched the word `jq` inside the step's own rationale comment and
    // then found `gh`'s redirect -- the same "satisfied by prose" class this
    // file's other cases were rewritten for, twice.
    const producerCode = producer
      .split('\n')
      .map((l) => l.replace(/#.*$/, ''))
      .join('\n');
    const jqTarget = /\bjq\s+-e\b[\s\S]*?>\s*"([^"]+)"/.exec(producerCode)?.[1];
    expect(jqTarget, 'jq must redirect to a named file').toBeDefined();
    expect(moved?.[1], 'the mv source must be jq output').toBe(jqTarget);

    // The consumer's absent-subject guard. Deleting it sends an unreadable
    // subject to the checker, which exits 2 and reds the job -- undoing the
    // fetch-failure distinction the producer's fail-open arms exist for.
    expect(consumer, 'the consumer must skip when the subject is absent').toMatch(
      /if\s+\[\s+!\s+-f\s+"\$RUNNER_TEMP\/subject\.json"\s+\]/,
    );
    expect(consumer, 'and skip by exiting 0, not by failing').toMatch(/exit 0/);
  });

  it('the subject build fails OPEN on every fetch-side failure', () => {
    // `jq -e` is the entire mechanism that turns "gh exited 0 with EMPTY
    // stdout" into the warn-and-skip arm: without it jq exits 0 on empty input
    // and a 0-byte subject is moved into place, `parseSubject('')` throws, the
    // checker exits 2, and the job reds on a fetch problem -- the round-2
    // defect returning. Nothing pinned it (go-to-k/cdkd#2736 round-3 review).
    const doc = wf('pr-content-checks.yml');
    const jobs = doc['jobs'] as Record<string, { steps?: Array<Record<string, unknown>> }>;
    const producer = String(
      (jobs['pr-content']?.steps ?? []).find(
        (st) => String(st['name'] ?? '') === 'build the PR subject document',
      )?.['run'] ?? '',
    );

    expect(producer, 'jq must use -e so empty input is an error').toMatch(/\bjq\s+-e\b/);
    // Each failure arm warns and exits 0 rather than reddening: the fetch, the
    // jq, and the mv. Three `exit 0`s, one per arm.
    expect((producer.match(/exit 0/g) ?? []).length, 'each arm must fail open').toBe(3);
    expect(
      (producer.match(/::warning title=Auto-close form check skipped::/g) ?? []).length,
      'and each must say why',
    ).toBe(3);
    // A stale subject from an earlier attempt must never be read.
    expect(producer, 'the step must clear any previous subject first').toMatch(
      /^\s*rm -f "\$RUNNER_TEMP\/subject\.json"/m,
    );
  });

  it('the job holds exactly the permissions its checks need', () => {
    // Two reasons this is pinned rather than left to review. `pull-requests:
    // read` is what `gh pr view` needs, and since the fetch now FAILS OPEN,
    // dropping it turns a loud permission error into a silent skip -- the
    // fail-open made this fence necessary. And `contents: read` must be
    // RESTATED at the job, because a job-level block replaces the workflow-level
    // one rather than merging; losing it takes git away from the two diff
    // checks (go-to-k/cdkd#2736 round-2 review).
    const doc = wf('pr-content-checks.yml');
    const jobs = doc['jobs'] as Record<string, { permissions?: Record<string, unknown> }>;
    expect(jobs['pr-content']?.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
    });
    // And nothing above it may grant more: a fork PR's body reaches this job.
    expect(doc['permissions']).toEqual({ contents: 'read' });
  });

  it('the closes-paren check is actually fed a BODY', () => {
    // The check's whole input arrives through one `gh pr view --json` field.
    // Drop `body` from it (or from the jq map) and `parseSubject` is TOTAL, so
    // the body becomes '', the check reports "uses no parens-form close
    // directive", and it is permanently, silently green -- the same vacuous
    // pass its own exit-2 policy exists to prevent, reached through the one
    // surface no test read (go-to-k/cdkd#2736 test review).
    const doc = wf('pr-content-checks.yml');
    const jobs = doc['jobs'] as Record<string, { steps?: Array<Record<string, unknown>> }>;
    const step = (jobs['pr-content']?.steps ?? []).find(
      (st) => String(st['name'] ?? '') === 'build the PR subject document',
    );
    expect(step, 'pr-content must build a subject document').toBeDefined();
    const run = String(step?.['run'] ?? '');
    expect(run, 'the fetch must request the body field').toMatch(/--json\s+[^\s]*\bbody\b/);
    // `body: .body` EXACTLY, anchored at both ends of the value. The looser
    // `/body:\s*\.body/` was satisfied by `body: .body[0:0]`, which truncates
    // every body to the empty string and makes the check permanently clean
    // (go-to-k/cdkd#2736 round-2 review).
    expect(run, 'the jq map must carry the body through UNMODIFIED').toMatch(
      /body:\s*\.body\s*,/,
    );
    expect(run, 'the subject must be built as a pull_request kind').toContain(
      'kind:"pull_request"',
    );
    // The jq must read what gh actually wrote. Redirecting it from elsewhere
    // keeps every assertion above matching while the body is someone else's.
    expect(run, 'jq must consume the fetched PR json').toMatch(/<\s*"\$RUNNER_TEMP\/pr\.json"/);
  });

  it('no workflow echoes a fork-controlled file list into the log', () => {
    // `pr-title-check.yml` used to `cat changed-files.txt`, printing paths that
    // arrive JSON-decoded from the API -- so a name carrying a carriage return,
    // or one literally spelled `::error file=...::...`, forged a workflow
    // command on every run. The listing moved into the checker, which folds it
    // and gives every row a non-whitespace `[` prefix.
    //
    // Re-adding the `cat` restores the vulnerability exactly, and passed the
    // whole suite (measured, go-to-k/cdkd#2736 round-4 review). Nothing else
    // stops a future edit reaching for it.
    for (const file of ['pr-title-check.yml', 'pr-content-checks.yml', 'issue-conventions.yml']) {
      const doc = wf(file);
      const jobs = doc['jobs'] as Record<string, { steps?: Array<Record<string, unknown>> }>;
      const runs = Object.values(jobs)
        .flatMap((j) => j.steps ?? [])
        .map((st) => String(st['run'] ?? ''))
        .join('\n')
        .split('\n')
        .map((l) => l.replace(/#.*$/, ''))
        .join('\n');
      // A bare `cat` of any file. Reports go through `sed 's/^/| /'` instead,
      // which supplies the non-whitespace prefix the runner's TRIM-START makes
      // necessary.
      expect(
        runs,
        `${file} must not cat attacker-controlled text straight into the log`,
      ).not.toMatch(/^\s*cat\s+\S/m);
    }
  });

  it('every report a workflow prints carries a non-whitespace prefix', () => {
    // The runner TRIM-STARTS each line before deciding whether it is a workflow
    // command, so the reports' own two-space fence indent protects nothing: an
    // issue body opening with `::stop-commands::` suppressed every later
    // annotation in a job holding `issues: write`, reachable by ANY GitHub user
    // (go-to-k/cdkd#2736 round-4 security review). The FILES stay pristine --
    // they are posted as comments, where the fence has to render.
    const doc = wf('issue-conventions.yml');
    const jobs = doc['jobs'] as Record<string, { steps?: Array<Record<string, unknown>> }>;
    const runs = Object.values(jobs)
      .flatMap((j) => j.steps ?? [])
      .map((st) => String(st['run'] ?? ''))
      .join('\n');
    const prefixed = (runs.match(/sed 's\/\^\/\| \/'/g) ?? []).length;
    expect(prefixed, 'each report echo must go through the prefix').toBe(4);
  });

  it.each([
    ['gh exits non-zero', 'fail', false],
    ['gh exits 0 with EMPTY stdout', 'empty', false],
    ['gh returns valid JSON', 'ok', true],
  ])(
    'the subject build with %s: warns and exits 0, or produces a subject',
    (_label, mode, expectSubject) => {
      // The arms were pinned by SOURCE TEXT -- counting `exit 0`s -- which
      // proves nothing about behaviour and missed that moving the leading
      // `rm -f` to the END of the step deletes the subject right after `mv`,
      // leaving the check permanently skipped (measured, go-to-k/cdkd#2736
      // round-4 review). So the block is EXECUTED here, with a stubbed `gh`.
      //
      // `jq -e` is the load-bearing half: without it, jq exits 0 on empty
      // input, a 0-byte subject is moved into place, `parseSubject('')` throws
      // and the job reds on what is really a FETCH problem.
      const doc = wf('pr-content-checks.yml');
      const jobs = doc['jobs'] as Record<string, { steps?: Array<Record<string, unknown>> }>;
      const script = String(
        (jobs['pr-content']?.steps ?? []).find(
          (st) => String(st['name'] ?? '') === 'build the PR subject document',
        )?.['run'] ?? '',
      );
      expect(script, 'the producer step must exist').not.toBe('');

      const dir = mkdtempSync(join(tmpdir(), 'subject-arm-'));
      try {
        const bin = join(dir, 'bin');
        mkdirSync(bin);
        const stub =
          mode === 'fail'
            ? '#!/bin/sh\necho "boom" >&2\nexit 1\n'
            : mode === 'empty'
              ? '#!/bin/sh\nexit 0\n'
              : '#!/bin/sh\necho \'{"title":"t","body":"Closes (#1).","labels":[]}\'\n';
        writeFileSync(join(bin, 'gh'), stub);
        chmodSync(join(bin, 'gh'), 0o755);

        const runnerTemp = join(dir, 'temp');
        mkdirSync(runnerTemp);
        const out = execFileSync('bash', ['-c', script], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env['PATH'] ?? ''}`,
            RUNNER_TEMP: runnerTemp,
            NUMBER: '1',
            REPO: 'go-to-k/cdkd',
            GH_TOKEN: 'x',
          },
        });

        const subject = join(runnerTemp, 'subject.json');
        const exists = (): boolean => {
          try {
            readFileSync(subject);
            return true;
          } catch {
            return false;
          }
        };
        expect(exists(), `subject present? (${mode})`).toBe(expectSubject);
        if (!expectSubject) {
          // Failing OPEN means: exit 0 (execFileSync would have thrown
          // otherwise), a warning saying so, and NO subject left behind for the
          // next step to mistake for a broken checker.
          expect(out).toContain('::warning title=Auto-close form check skipped::');
        } else {
          expect(JSON.parse(readFileSync(subject, 'utf8'))).toMatchObject({
            kind: 'pull_request',
            number: 1,
          });
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
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
