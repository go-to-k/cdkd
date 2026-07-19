/**
 * Classifier for the integ-fixture `verify.sh` signal-trap convention (#1097
 * pattern 1).
 *
 * A bash signal handler RETURNS to the interrupted point rather than exiting,
 * so `trap cleanup EXIT INT TERM` runs `cleanup` and then RESUMES the
 * interrupted phase -- the script can walk into the next phase and `exit 0`,
 * reporting PASS while `cleanup` raced a still-live deploy. A bare
 * `trap cleanup EXIT` with no signal handler skips cleanup entirely on Ctrl-C
 * or a harness timeout, leaking billable AWS resources.
 *
 * The only correct form seeds `$?` with the signal's exit code before calling
 * the handler, then exits:
 *
 *   trap cleanup EXIT
 *   trap '(exit 130); cleanup; exit 130' INT
 *   trap '(exit 143); cleanup; exit 143' TERM
 *
 * The `(exit N)` seed is load-bearing, not decoration: many fixtures' `cleanup`
 * opens with `rc=$?` and gates the whole teardown on it. Inside a handler `$?`
 * is the interrupted command's status, so without the seed an interrupted run
 * can see rc=0, SKIP the teardown entirely and exit 0 -- the exact bug #1097
 * is about.
 *
 * This module is separate from the test so the classifier can be table-tested
 * against synthetic script shapes rather than only against today's tree.
 */

/** A bash function name, optionally wrapped in single or double quotes. */
const FN = `(['"]?)([A-Za-z_][A-Za-z0-9_]*)\\1`;

export interface TrapClassification {
  /** Arms an EXIT trap that reaches a cleanup-ish function. */
  hasCleanupExitTrap: boolean;
  /** Arms `INT` with a handler that seeds `$?` and exits. */
  hasCorrectIntTrap: boolean;
  /** Arms `TERM` with a handler that seeds `$?` and exits. */
  hasCorrectTermTrap: boolean;
  /**
   * Arms `INT` / `TERM` with a handler that can return to the interrupted
   * point -- either the bare-function form or a body with no `exit`.
   */
  hasResumingSignalTrap: boolean;
  /** Function names this script defines, used to recognize handler traps. */
  definedFunctions: string[];
}

/**
 * Collapses multi-line `trap '<body>' SIG` statements onto one line so a
 * line-oriented scan cannot miss them. `local-start-api-websocket` shipped a
 * multi-line `trap ' ... ' EXIT INT TERM` that a per-line regex read as two
 * unrelated fragments.
 */
export function joinMultilineTraps(content: string): string[] {
  const lines = content.split('\n');
  const joined: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // An opening `trap '` whose quote does not close on the same line.
    if (/^\s*trap\s+'/.test(line) && (line.match(/'/g) ?? []).length === 1) {
      const parts = [line.trim()];
      while (++i < lines.length) {
        parts.push(lines[i]!.trim());
        if (lines[i]!.includes("'")) break;
      }
      joined.push(parts.join(' '));
      continue;
    }
    joined.push(line.trim());
  }

  return joined;
}

export function classifyVerifyScript(content: string): TrapClassification {
  const definedFunctions = [...content.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{/gm)].map(
    (m) => m[1]!,
  );
  const trapLines = joinMultilineTraps(content).filter((l) => /^trap\s/.test(l));

  /** Does this trap body invoke one of the script's own functions? */
  const callsOwnFunction = (body: string) =>
    definedFunctions.some((fn) => new RegExp(`\\b${fn}\\b`).test(body));

  const armsHandlerFor = (line: string, sig: 'EXIT' | 'INT' | 'TERM') => {
    if (/^trap\s+-\s/.test(line)) return false; // a disarm, not an arm
    const m = new RegExp(`^trap\\s+(?:${FN}|'(.*)')\\s+(.*)$`).exec(line);
    if (!m) return false;
    const signals = m[4] ?? '';
    if (!new RegExp(`\\b${sig}\\b`).test(signals)) return false;
    const body = m[3] ?? m[2] ?? '';
    return callsOwnFunction(body);
  };

  const correctFor = (sig: 'INT' | 'TERM', code: number) =>
    trapLines.some((l) => {
      const m = new RegExp(`^trap\\s+'(.*)'\\s+(.*)$`).exec(l);
      if (!m || !new RegExp(`\\b${sig}\\b`).test(m[2]!)) return false;
      const body = m[1]!;
      // Seeds `$?` immediately before the handler call, and exits afterwards.
      return (
        new RegExp(`\\(exit ${code}\\);\\s*[A-Za-z_]`).test(body) &&
        new RegExp(`exit ${code}\\s*$`).test(body)
      );
    });

  const hasResumingSignalTrap = trapLines.some((l) => {
    if (/^trap\s+-\s/.test(l)) return false;
    if (!/\b(INT|TERM)\b/.test(l)) return false;
    const quoted = new RegExp(`^trap\\s+'(.*)'\\s+(.*)$`).exec(l);
    if (!quoted) {
      // Bare-function form: `trap cleanup EXIT INT TERM` -- always resumes.
      return new RegExp(`^trap\\s+${FN}\\s+.*\\b(INT|TERM)\\b`).test(l);
    }
    // A quoted body that never exits also returns to the interrupted point.
    return !/\bexit\b/.test(quoted[3] ?? quoted[1]!);
  });

  return {
    hasCleanupExitTrap: trapLines.some((l) => armsHandlerFor(l, 'EXIT')),
    hasCorrectIntTrap: correctFor('INT', 130),
    hasCorrectTermTrap: correctFor('TERM', 143),
    hasResumingSignalTrap,
    definedFunctions,
  };
}
