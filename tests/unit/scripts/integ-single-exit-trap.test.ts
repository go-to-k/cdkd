import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A shell fixture that installs a teardown handler may install AT MOST ONE
 * `trap ... EXIT` — every integ `verify.sh`, and every script and smoke test
 * under `.claude/hooks/**`.
 *
 * WHY THIS IS A TEST AND NOT A SENTENCE. Bash REPLACES a signal's handler on
 * each `trap`; it does not chain them. So a second `trap ... EXIT` anywhere in
 * a script silently disarms the first — and in these fixtures the first one is
 * always the AWS teardown (`trap cleanup EXIT`, where `cleanup` runs
 * `cdkd state destroy` and sweeps leftover resources).
 *
 * Nearly shipped on 2026-08-25 in PR go-to-k/cdkd#2213. A code reviewer raised a
 * correct nit — a `DRIFT_OUT="$(mktemp)"` leaked on five `exit 1` paths — and
 * the obvious fix is `trap 'rm -f "${DRIFT_OUT}"' EXIT` right next to it.
 * `cloudwatch-anomaly-detector/verify.sh` already had `trap cleanup EXIT` at
 * line 103. The new trap would have won, and the fixture would have stopped
 * tearing down AWS on every failure path — trading a scratch file in `/tmp` for
 * a live SQS queue, an anomaly detector and a state record, on exactly the runs
 * where cleanup matters most. It was caught only by counting the traps by hand.
 *
 * The failure is invisible to every other signal we have: the happy path still
 * passes (its explicit teardown runs before the trap would), CI never runs these
 * fixtures, and the orphans appear in an AWS account rather than in any log. So
 * the check has to be static, and it has to be a test rather than a review
 * habit — the review is where the bug came FROM.
 *
 * Scoped to EXIT deliberately. `INT` / `TERM` handlers are installed
 * per-fixture alongside it and replacing one of those is the same hazard, so
 * they are counted too.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf-8',
}).trim();

/** Committed files matching one `git ls-files` pathspec, in git order. */
function tracked(pathspec: string): string[] {
  return execFileSync('git', ['ls-files', pathspec], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter(Boolean);
}

/** Every committed integ `verify.sh`, from git rather than a directory walk. */
function verifyScripts(): string[] {
  return tracked('tests/integration/*/verify.sh');
}

/**
 * Every committed hook script and hook smoke test.
 *
 * WHY THIS CLASS IS HERE. The rule below is about bash, not about AWS, so the
 * population was never `tests/integration/**` on purpose — that is just where
 * the near-miss happened to be found. `.claude/hooks/**` was outside it, and
 * `pr-review-gate.test.sh` carried the exact defect for months
 * (go-to-k/cdkd#2336): `trap cleanup EXIT` at the top, then a second
 * `trap '...' EXIT` 400 lines later that re-implemented most of `cleanup`
 * rather than calling it. It shipped a FALSE RED — a full `run-tests.sh` pass
 * reported 16 failures that the same suite standalone did not — and the fence
 * that would have caught it existed already, one root directory over. Deriving
 * the population from the HAZARD (a bash script that installs a teardown
 * handler) rather than from the directory the first instance lived in is the
 * whole fix.
 */
function hookScripts(): string[] {
  // ONE pathspec, not two. A git pathspec's `*` crosses `/`, so
  // `.claude/hooks/*.sh` already returns everything under `lib/` — a second
  // `.claude/hooks/lib/*.sh` call duplicated 7 entries AND made the floor below
  // unable to notice it going dead (106 -> 99 is still over any floor worth
  // writing). Measured: 99, 7, and 0 files outside the 99.
  //
  // `lib/testdata/` is excluded deliberately: those are FROZEN snapshots of a
  // past `command-match.sh`, kept byte-stable as differential-test input. A live
  // rule must not be able to demand an edit to a file whose whole purpose is not
  // changing.
  return tracked('.claude/hooks/*.sh').filter((f) => !f.startsWith('.claude/hooks/lib/testdata/'));
}

/** The full population the trap rule applies to. */
function trapScripts(): string[] {
  return [...verifyScripts(), ...hookScripts()];
}

/**
 * Collect the ACTIONS of every `trap <action> <signals...>` INSTALLATION for one
 * signal, in source order.
 *
 * Four things the naive rule gets wrong, every one of them found by running it
 * over the real tree and reading the hits — the repo's calibrate-against-the-
 * broken-tree rule, which is the only reason this fence discriminates:
 *
 *  1. `trap - EXIT INT TERM` is a DISARM, not an installation. Six fixtures use
 *     it to drop handlers before a deliberate exit.
 *  2. Signals are not line-final: one `trap` can name several, so anchoring the
 *     signal to end-of-line counted TERM in 65 files and EXIT in 16 purely from
 *     where each name happened to sit.
 *  3. The action is quoted and routinely CONTAINS a signal name
 *     (`trap '(exit 143); cleanup; exit 143' TERM`), so the signal must be read
 *     from the trailing signal LIST only.
 *  4. **A second installation is not automatically a bug.** Sixteen fixtures
 *     legitimately re-install with `trap 'rm -f "${OUT_FILE}"; cleanup' EXIT` —
 *     a handler that adds a scratch-file removal and STILL calls the teardown.
 *     Flagging those would have made this fence noise, and noise gets deleted.
 *
 * So the rule is not "at most one trap". It is: **a later installation must
 * still invoke what the first one invoked.** That is exactly the near-miss this
 * file exists for, and exactly what the idiomatic form satisfies.
 */
function trapActions(body: string, signal: string): string[] {
  const actions: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^trap\s+(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[1]!;
    const quoted = /^(?:'([^']*)'|"([^"]*)")\s*(.*)$/.exec(rest);
    const action = quoted ? (quoted[1] ?? quoted[2] ?? '') : (/^(\S+)/.exec(rest)?.[1] ?? '');
    const signals = quoted ? quoted[3]! : rest.slice(action.length);
    if (!quoted && action === '-') continue; // a disarm, not an installation
    if (signals.trim().split(/\s+/).includes(signal)) actions.push(action);
  }
  return actions;
}

/**
 * The identifiers a trap action invokes, RESOLVED one level through the script's
 * own function definitions.
 *
 * The resolution step is not polish. `local-start-api-websocket/verify.sh`
 * legitimately replaces `trap cleanup EXIT` with
 * `trap cleanup_and_assert_sigterm_fast EXIT`, and that wrapper calls `cleanup`
 * on its first line — a name-only comparison called it a dropped teardown and
 * made this fence's ONLY hit a false positive. A fence whose single finding is
 * wrong is worse than no fence: it gets muted, and then it is not there for the
 * real one.
 *
 * One level only, deliberately. It is what the observed idiom needs, and a
 * transitive walk would need cycle handling to avoid hanging the suite — the
 * same bound the drift guard's cause-chain walk carries, for the same reason.
 */
function invoked(action: string, body: string): Set<string> {
  const BUILTINS = ['rm', 'f', 'exit', 'echo', 'true', 'false', 'set', 'e', 'u', 'then', 'fi'];
  const words = (text: string): string[] =>
    (text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter((w) => !BUILTINS.includes(w));

  const out = new Set<string>();
  for (const name of words(action)) {
    out.add(name);
    // If the script defines `name() { ... }`, add what IT calls.
    const def = new RegExp(String.raw`^${name}\s*\(\)\s*\{([\s\S]*?)^\}`, 'm').exec(body);
    if (def) for (const inner of words(def[1]!)) out.add(inner);
  }
  return out;
}

describe('a shell fixture never drops its teardown handler', () => {
  const scripts = trapScripts();

  /**
   * PARSER FLOOR. Without it every assertion below passes vacuously the moment
   * the regex stops matching — the "found nothing, therefore nothing is wrong"
   * shape this repo has shipped more than once. Every fixture that tears down
   * AWS installs an EXIT trap, so a total of zero means the parser broke, not
   * that the fixtures changed.
   */
  it('finds the EXIT traps that certainly exist, including the re-installing form', () => {
    expect(scripts.length).toBeGreaterThan(50);
    // A FLOOR PER CLASS, and the classes must be DISJOINT. The walk reaches a
    // class only if the pathspec producing it still matches something, and a
    // glob that stops matching fails CLEAN — it drops a whole subsystem while
    // every assertion below stays green. That is precisely how
    // `.claude/hooks/**` sat outside this fence while carrying the defect.
    //
    // A single floor over the hooks total does NOT close that: narrowing the
    // pathspec to `.claude/hooks/*-gate.sh` yields 38, which clears any floor
    // set from the 99 total, while silently dropping all 48 `*.test.sh` —
    // including `pr-review-gate.test.sh`, the file this class was added for. So
    // the two sub-populations that can independently vanish are floored
    // independently, from counts measured on 2026-09-06 (99 = 48 + 38 + 13).
    const hooks = hookScripts();
    expect(verifyScripts().length).toBeGreaterThan(50);
    expect(hooks.filter((f) => f.endsWith('.test.sh')).length).toBeGreaterThan(40);
    expect(hooks.filter((f) => f.endsWith('-gate.sh')).length).toBeGreaterThan(30);
    const counts = scripts.map((p) => trapActions(readFileSync(join(REPO_ROOT, p), 'utf-8'), 'EXIT'));
    expect(counts.filter((a) => a.length > 0).length).toBeGreaterThan(20);
    // ...and the legitimate re-installers are SEEN rather than parsed away. If
    // this hits zero the rule below has nothing left to be lenient about, which
    // is how a tightened fence quietly becomes a vacuous one.
    expect(counts.filter((a) => a.length > 1).length).toBeGreaterThan(5);
  });

  for (const signal of ['EXIT', 'INT', 'TERM']) {
    it(`a re-installed ${signal} handler still invokes the first one's work`, () => {
      const offenders: string[] = [];
      for (const rel of scripts) {
        const actions = trapActions(readFileSync(join(REPO_ROOT, rel), 'utf-8'), signal);
        if (actions.length < 2) continue;
        const body = readFileSync(join(REPO_ROOT, rel), 'utf-8');
        // The FIRST handler's own top-level names, UNRESOLVED. Expanding it too
        // was the bug in the first cut of this fence: it turned `cleanup` into
        // every word in `cleanup`'s body and then demanded the replacement
        // mention all of them, which no wrapper does. What must survive is the
        // CALL, not the callee's contents.
        const first = invoked(actions[0]!, '');
        for (const later of actions.slice(1)) {
          // The later handler's REACH, resolved one level, so a wrapper that
          // calls the original counts as keeping it.
          const kept = invoked(later, body);
          const dropped = [...first].filter((fn) => !kept.has(fn));
          if (dropped.length > 0) {
            offenders.push(`${rel}: 'trap ${later} ${signal}' drops ${dropped.join(', ')}`);
          }
        }
      }

      expect(
        offenders,
        `bash REPLACES a signal handler rather than chaining it, so the LAST ` +
          `trap ... ${signal} wins and every earlier one is dead. In these fixtures ` +
          `the first is the AWS teardown, and in a hook smoke test it is the ` +
          `restore of state shared with the live worktree, so a replacement that ` +
          `does not call it leaks billable orphans or leaves fixture state behind ` +
          `on exactly the runs where cleanup matters most. ` +
          `Either call the original handler from the new one (the idiomatic ` +
          `'trap \'rm -f "\${TMP}"; cleanup\' ${signal}' form, which 16 fixtures ` +
          `already use) or put the extra work INSIDE the existing handler, ` +
          `unset-guarded since it may run before the variable is assigned.`
      ).toEqual([]);
    });
  }
});
