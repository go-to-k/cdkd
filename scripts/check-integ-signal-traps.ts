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
 * The only correct form seeds `$?` with the signal's exit code immediately
 * before calling the handler, then exits:
 *
 *   trap cleanup EXIT
 *   trap '(exit 130); cleanup; exit 130' INT
 *   trap '(exit 143); cleanup; exit 143' TERM
 *
 * The `(exit N)` seed is load-bearing, not decoration: many fixtures' `cleanup`
 * opens with `rc=$?` and gates the whole teardown on it. Inside a handler `$?`
 * is the interrupted command's status, so without the seed an interrupted run
 * can see rc=0, SKIP the teardown entirely and exit 0 -- the exact bug #1097
 * is about. "Immediately before" is also load-bearing: any command between the
 * seed and the handler call (e.g. a temp-file `rm`) clobbers `$?` again.
 *
 * This module is separate from the test so the classifier can be table-tested
 * against synthetic script shapes rather than only against today's tree.
 */

/** A bash function name, bare or wrapped in single/double quotes. */
const NAME = `[A-Za-z_][A-Za-z0-9_]*`;

export interface TrapClassification {
  /** Arms an EXIT trap that reaches one of the script's own functions. */
  hasCleanupExitTrap: boolean;
  /** Arms `INT`, and EVERY `INT` arm seeds `$?` and exits. */
  hasCorrectIntTrap: boolean;
  /** Arms `TERM`, and EVERY `TERM` arm seeds `$?` and exits. */
  hasCorrectTermTrap: boolean;
  /**
   * Arms `INT` / `TERM` with a handler that can return to the interrupted
   * point -- the bare-function form, or a body that never exits.
   */
  hasResumingSignalTrap: boolean;
  /** Function names this script defines, used to recognize handler traps. */
  definedFunctions: string[];
}

interface TrapStatement {
  /** The handler: a bare function name, or the quoted body's contents. */
  body: string;
  /** True when the handler was given as a bare name rather than a body. */
  bare: boolean;
  signals: string[];
  /** `trap - EXIT INT TERM` -- releases rather than arms. */
  disarm: boolean;
}

/**
 * Collapses multi-line `trap '<body>' SIG` / `trap "<body>" SIG` statements onto
 * one line so a line-oriented scan cannot miss them. `local-start-api-websocket`
 * shipped a multi-line `trap ' ... ' EXIT INT TERM` that a per-line regex read
 * as two unrelated fragments and greenlit.
 */
export function joinMultilineTraps(content: string): string[] {
  const lines = content.split('\n');
  const joined: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const opener = /^\s*trap\s+(['"])/.exec(line);
    // An opening quote that does not close on the same line.
    if (opener && (line.match(new RegExp(opener[1]!, 'g')) ?? []).length === 1) {
      const quote = opener[1]!;
      const parts = [line.trim()];
      while (++i < lines.length) {
        parts.push(lines[i]!.trim());
        if (lines[i]!.includes(quote)) break;
      }
      joined.push(parts.join(' '));
      continue;
    }
    joined.push(line.trim());
  }

  return joined;
}

function parseTraps(content: string): TrapStatement[] {
  return joinMultilineTraps(content)
    .filter((l) => /^trap\s/.test(l))
    .map((line): TrapStatement | null => {
      const disarm = /^trap\s+-\s+/.exec(line);
      if (disarm) {
        return { body: '', bare: true, signals: line.slice(disarm[0].length).split(/\s+/), disarm: true };
      }
      // Quoted body: `trap '...' SIG...` or `trap "..." SIG...`
      const quoted = /^trap\s+(['"])([\s\S]*)\1\s+(.*)$/.exec(line);
      if (quoted) {
        return { body: quoted[2]!, bare: false, signals: quoted[3]!.split(/\s+/), disarm: false };
      }
      // Bare handler: `trap name SIG...`
      const bare = new RegExp(`^trap\\s+(${NAME})\\s+(.*)$`).exec(line);
      if (bare) {
        return { body: bare[1]!, bare: true, signals: bare[2]!.split(/\s+/), disarm: false };
      }
      return null;
    })
    .filter((t): t is TrapStatement => t !== null);
}

export function classifyVerifyScript(content: string): TrapClassification {
  const definedFunctions = [...content.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{/gm)].map(
    (m) => m[1]!,
  );
  const traps = parseTraps(content).filter((t) => !t.disarm);

  const callsOwnFunction = (body: string) =>
    definedFunctions.some((fn) => new RegExp(`\\b${fn}\\b`).test(body));

  const armsFor = (sig: string) => traps.filter((t) => t.signals.includes(sig));

  /**
   * A correct signal handler seeds `$?`, calls one of the script's own
   * functions DIRECTLY after the seed (nothing in between may clobber `$?`),
   * and exits with the signal's code.
   */
  const isCorrectSignalHandler = (t: TrapStatement, code: number) => {
    if (t.bare) return false;
    const seed = new RegExp(`\\(exit ${code}\\);\\s*(${NAME})\\b`).exec(t.body);
    if (!seed || !definedFunctions.includes(seed[1]!)) return false;
    return new RegExp(`exit ${code}\\s*;?\\s*$`).test(t.body.trim());
  };

  // EVERY arm must be correct, not just one: 8 fixtures legitimately re-arm
  // their traps at phase boundaries, so a `some()` check would greenlight a
  // file whose later re-arm dropped back to the un-seeded form.
  const correctFor = (sig: string, code: number) => {
    const arms = armsFor(sig);
    return arms.length > 0 && arms.every((t) => isCorrectSignalHandler(t, code));
  };

  const hasResumingSignalTrap = traps.some((t) => {
    if (!t.signals.some((s) => s === 'INT' || s === 'TERM')) return false;
    // Bare-function form always returns to the interrupted point.
    if (t.bare) return true;
    // A body that never exits does too.
    return !/\bexit\b/.test(t.body);
  });

  return {
    hasCleanupExitTrap: armsFor('EXIT').some((t) => callsOwnFunction(t.body)),
    hasCorrectIntTrap: correctFor('INT', 130),
    hasCorrectTermTrap: correctFor('TERM', 143),
    hasResumingSignalTrap,
    definedFunctions,
  };
}
