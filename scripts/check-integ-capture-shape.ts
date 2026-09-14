/**
 * Fence for issue #3126: a `verify.sh` that runs under `pipefail` must not
 * read a command's output with the shape
 *
 *     VAR=$(cmd ... 2>/dev/null | tail -1)
 *
 * WHAT GOES WRONG
 *
 * Under `set -euo pipefail` a non-zero exit of `cmd` fails the pipeline
 * (pipefail), which fails the command substitution, which fails the
 * assignment, and `set -e` kills the script AT THE ASSIGNMENT -- before the
 * assertion that would have printed `FAIL: ... got: ${VAR}`, and with the
 * command's stderr already discarded by `2>/dev/null`. The log ends at the
 * previous `echo "==> [2/4] ..."` banner with no error text at all. That is
 * how a transient during issue #3106's verification read as an unexplained
 * abort and cost the lane a re-run. Measured on the tree before the sweep
 * (2026-09-14, this scanner): eight `local-*` fixtures carried the shape at
 * 35 sites, plus three retry loops that lost every attempt's stderr the
 * same way (`if out=$(... 2>/dev/null | tail -1)` -- `set -e` is suspended
 * in a condition, so the loop ran, but the text was gone), plus three
 * sites outside `local-*` in other clothing.
 *
 * The shape is NOT a swallow: the script still fails, so nothing false-passes
 * (issue #1120's capture-form lint classifies "a silenced capture with no
 * fallback" as legal for exactly that reason). What it loses is the
 * DIAGNOSTIC, which is the whole point of a fixture assertion.
 *
 * THE CORRECT FORM
 *
 * `capture` (the block below, carried byte-for-byte by every fixture that
 * uses it) runs the command with its exit status taken EXPLICITLY. On a
 * non-zero exit it prints the status, the last stdout line and the tail of
 * the captured stderr, and emits NOTHING on stdout, so the assertion runs,
 * FAILS, and prints its own diagnostic -- and a response that happened to
 * look right never passes a failed invoke, the one property the old shape
 * had (review of go-to-k/cdkd#3133 measured a first draft that emitted the
 * line regardless: a `return 1` after a good-looking response went green).
 * Env-prefixed calls (`AWS_REGION=x capture ${CDKD} ...`) work
 * because bash exports the prefix for the duration of a function call. A
 * retry loop routes stderr to a file (`2>"${err}"`) and prints its tail on
 * the failure paths instead of running a fourth attempt to see it.
 *
 * WHAT IT DOES NOT CLAIM
 *
 *  - A file that does not set `pipefail` is out of scope: there the pipeline
 *    takes `tail`'s status, the assignment never fails, and the defect is a
 *    different one (a silently wrong value). No such `verify.sh` exists today;
 *    the test pins that count so one cannot appear unnoticed.
 *  - `$(cmd 2>&1 | tail -1)` is legal: stderr reaches the capture.
 *  - `$(cmd 2>"${file}" | tail -1)` is legal: stderr is kept somewhere.
 *  - Comment lines and heredoc bodies are data, not code; the block above
 *    quotes the banned shape on purpose.
 */

import { readFileSync } from 'node:fs';

/**
 * The helper every fixture carries. Exported so the test can (a) assert each
 * fixture's copy is byte-identical -- a drifted copy is how a helper stops
 * doing what its comment says -- and (b) run it under bash against a failing
 * stub to prove the CONVENTION, not just the scanner.
 */
export const CANONICAL_CAPTURE_BLOCK = `# --- capture ---------------------------------------------------------------
# Under \`set -euo pipefail\` the shape
#     VAR=$(\${CDKD} local invoke ... 2>/dev/null | tail -1)
# aborts the WHOLE script at the ASSIGNMENT when the CLI exits non-zero:
# pipefail fails the pipeline, the substitution fails, \`set -e\` kills the
# script BEFORE the assertion, and the CLI's stderr is already gone -- a log
# that ends at \`[2/4] Invoking ...\` with no error text (issue #3106's lane
# paid a re-run to learn a transient had hit; issue #3126 swept the shape).
# \`capture\` runs the command with its exit status captured EXPLICITLY. On a
# non-zero exit it prints the status, the last stdout line and the tail of
# the captured stderr, and emits NOTHING on stdout -- the assertion still
# runs and FAILS with its own text, and a response that happened to look
# right never passes a failed invoke (the old shape's one merit, kept). On
# success it emits the last stdout line. The stderr file is per call and
# removed here, so the EXIT trap chain carries no entry for it. Every
# fixture that uses this block carries it byte-for-byte (copy
# CANONICAL_CAPTURE_BLOCK from scripts/check-integ-capture-shape.ts); the
# fence is tests/unit/scripts/integ-verify-capture-shape.test.ts.
capture() {
  local out err rc=0
  err="$(mktemp)"
  out="$("$@" 2>"\${err}")" || rc=$?
  if [ "\${rc}" -ne 0 ]; then
    echo "[verify] command exited \${rc}: $*" >&2
    echo "[verify] last stdout line: $(printf '%s\\n' "\${out}" | tail -1)" >&2
    echo "[verify] captured stderr (last 20 lines):" >&2
    tail -20 "\${err}" >&2
    rm -f "\${err}"
    return 0
  fi
  rm -f "\${err}"
  printf '%s\\n' "\${out}" | tail -1
}
`;

export interface FlaggedCapture {
  /** 1-based number of the statement's FIRST physical line. */
  line: number;
  /** The `$( ... )` body, nested substitutions masked. */
  body: string;
}

export interface CaptureShapeClassification {
  /** `set -euo pipefail` / `set -o pipefail` somewhere in the script. */
  setsPipefail: boolean;
  /**
   * Command substitutions whose body discards stderr to /dev/null and then
   * pipes to a line picker (`tail` / `head`). Reported regardless of
   * `setsPipefail`; the tree-wide test decides what is a violation.
   */
  abortShapedCaptures: FlaggedCapture[];
  /** `capture() {` is defined. */
  definesCapture: boolean;
  /** Contains {@link CANONICAL_CAPTURE_BLOCK} verbatim. */
  hasCanonicalCaptureBlock: boolean;
  /** Calls `capture ` in command position somewhere (outside its definition). */
  callsCapture: boolean;
}

/** Depth of `$(` left open at the end of `text` (never negative). */
function openSubstitutions(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (depth === 0) {
      if (text[i] === '$' && text[i + 1] === '(') {
        depth = 1;
        i++;
      }
      continue;
    }
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
  }
  return depth;
}

/**
 * Joins one logical statement out of its physical lines -- a backslash
 * continuation, a line ending in `|` / `&&` / `||`, or a `$(` still open
 * at the line's end (a wrapped `R=$(cmd 2>/dev/null |` newline `tail -1)`
 * was invisible to the first cut, review of go-to-k/cdkd#3133) -- and blanks
 * comment lines and heredoc bodies, keeping the line count so a report's
 * line number is the first physical line of the statement. A `<<` that is
 * part of a here-string (`<<<`) is not a heredoc, and a heredoc whose
 * terminator never comes is not skipped either: both used to blank the rest
 * of the file, which made the fence silently inert from that line on.
 * Trailing comments stay: the banned shape cannot sit inside one without
 * also being code on that line, and a quote-aware stripper is more
 * machinery than the question needs.
 */
export function codeLines(content: string): Array<{ line: number; text: string }> {
  const raw = content.split('\n');
  const out: Array<{ line: number; text: string }> = [];
  const continues = (text: string) =>
    /(\\|\||&&)\s*$/.test(text) || openSubstitutions(text) > 0;
  for (let i = 0; i < raw.length; i++) {
    const start = i;
    let text = raw[i]!;
    if (/^\s*#/.test(text)) {
      out.push({ line: start + 1, text: '' });
      continue;
    }
    while (continues(text) && i + 1 < raw.length) {
      i++;
      const next = raw[i]!;
      if (/^\s*#/.test(next)) continue;
      text = /\\$/.test(text) ? text.replace(/\\$/, ' ') + next.trim() : `${text} ${next.trim()}`;
    }
    out.push({ line: start + 1, text });
    const here = /(?<!<)<<-?(?!<)\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(text);
    if (here) {
      const end = new RegExp(`^\\s*${here[1]}\\s*$`);
      const stop = raw.findIndex((l, k) => k > i && end.test(l));
      if (stop !== -1) {
        while (++i < stop) out.push({ line: i + 1, text: '' });
      }
    }
  }
  return out;
}

/**
 * Every `$( ... )` body on the line, parentheses balanced, nested
 * substitutions masked so an inner capture's redirections are never read as
 * the outer one's (each nested body is returned as its own entry). Newlines
 * inside a joined statement are ordinary whitespace here.
 */
export function substitutionBodies(text: string): string[] {
  const bodies: string[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== '$' || text[i + 1] !== '(') continue;
    let depth = 1;
    let j = i + 2;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') depth--;
    }
    if (depth !== 0) continue;
    const body = text.slice(i + 2, j - 1);
    let masked = '';
    let d = 0;
    for (let k = 0; k < body.length; k++) {
      if (d === 0 && body[k] === '$' && body[k + 1] === '(') {
        d = 1;
        k++;
        masked += '__NESTED__';
        continue;
      }
      if (d > 0) {
        if (body[k] === '(') d++;
        else if (body[k] === ')') d--;
        continue;
      }
      masked += body[k];
    }
    bodies.push(masked);
  }
  return bodies;
}

/**
 * stderr to /dev/null, then (through any number of stages) a pipe into a line
 * picker, with NO `||` fallback after it. A fallback (`... | head -1 || true`)
 * hands the caller an explicit empty value to check -- issue #1120's class,
 * judged there -- so the assignment cannot abort and the diagnostic is the
 * caller's own check.
 */
const ABORT_SHAPE = /(?:2>\s*\/dev\/null|&>\s*\/dev\/null|2>&1\s*>\s*\/dev\/null)[\s\S]*?\|\s*(?:tail|head)\b(?![\s\S]*\|\|)/;

export function classifyCaptureShape(content: string): CaptureShapeClassification {
  const lines = codeLines(content);
  const abortShapedCaptures: FlaggedCapture[] = [];
  let callsCapture = false;
  for (const { line, text } of lines) {
    for (const body of substitutionBodies(text)) {
      if (ABORT_SHAPE.test(body)) abortShapedCaptures.push({ line, body });
    }
    // Command position only: start of line, after `$(`, or after a
    // separator, with optional env-assignment prefixes -- `echo "... capture
    // ..."` is prose (two fixtures say the word in a banner).
    if (/(?:^|\$\(|[;|&]\s*)\s*(?:[A-Z0-9_]+=\S+\s+)*capture\s+\S/.test(text)) callsCapture = true;
  }
  return {
    // `set -euo pipefail`, `set -o pipefail`, `set -e -o pipefail`,
    // `set -o errexit -o pipefail`: any `set` line whose `-o` names pipefail.
    setsPipefail: lines.some(({ text }) => /^\s*set\s+(?:-[a-zA-Z]*o|.*\s-o)\s+pipefail\b/.test(text)),
    abortShapedCaptures,
    definesCapture: /^capture\(\)\s*\{/m.test(content),
    hasCanonicalCaptureBlock: content.includes(CANONICAL_CAPTURE_BLOCK),
    callsCapture,
  };
}

export function classifyVerifyFile(path: string): CaptureShapeClassification {
  return classifyCaptureShape(readFileSync(path, 'utf8'));
}
