import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every integ `verify.sh` may install AT MOST ONE `trap ... EXIT`.
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

/** Every committed integ `verify.sh`, from git rather than a directory walk. */
function verifyScripts(): string[] {
  return execFileSync('git', ['ls-files', 'tests/integration/*/verify.sh'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter(Boolean);
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

describe('an integ verify.sh never drops its teardown handler', () => {
  const scripts = verifyScripts();

  /**
   * PARSER FLOOR. Without it every assertion below passes vacuously the moment
   * the regex stops matching — the "found nothing, therefore nothing is wrong"
   * shape this repo has shipped more than once. Every fixture that tears down
   * AWS installs an EXIT trap, so a total of zero means the parser broke, not
   * that the fixtures changed.
   */
  it('finds the EXIT traps that certainly exist, including the re-installing form', () => {
    expect(scripts.length).toBeGreaterThan(50);
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
          `the first is the AWS teardown, so a replacement that does not call it ` +
          `leaks live resources on every failure path — trading a scratch file for ` +
          `billable orphans, on exactly the runs where cleanup matters most. ` +
          `Either call the original handler from the new one (the idiomatic ` +
          `'trap \'rm -f "\${TMP}"; cleanup\' ${signal}' form, which 16 fixtures ` +
          `already use) or put the extra work INSIDE the existing handler, ` +
          `unset-guarded since it may run before the variable is assigned.`
      ).toEqual([]);
    });
  }
});
