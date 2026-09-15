import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript-v6';

/**
 * `tests/integration/secrets-dynamic-ref/verify.sh` Guard 7b (issue #2531)
 * asserts the ABSENCE of `cdkd scrub`'s two name-fallback warnings in the
 * command's output. An absence grep of the producer's own wording has no
 * sentinel: reword the warn in `src/cli/commands/scrub.ts` and the grep goes
 * silently green, with the run still exiting 0 (.claude/rules/testing.md,
 * "A fixture that greps cdkd's OWN output must fail loudly when the format
 * drifts"). The unit cases in `scrub-export-name-collision.test.ts` pin the
 * same substrings (so does `scrub-cross-region-secret.test.ts`), so a reword
 * breaks THEM first — but a reword that updates source and unit test together
 * and forgets the fixture is exactly the coordinated edit nothing else
 * catches. This file is that fence.
 *
 * What is bound, and to what: each string the fixture greps must sit inside
 * ONE literal run of a `logger.warn(...)` call in the scrub source one of
 * whose runs names an `Export.Name of output` — read off the TypeScript AST
 * as the string and template-literal pieces of the call's arguments, so
 * neither a comment (standalone, trailing, or block — comments are trivia
 * the AST does not carry into a literal) nor a `debug` call (which the
 * fixture's default-verbosity run would never see) can satisfy it. The two
 * strings must be distinct and land in two DIFFERENT warn calls, one per
 * fallback arm, so a fixture line that repeats one string twice cannot pass
 * while Guard 7b has stopped watching the other arm. The fixture side is
 * read from the `for NAME_FALLBACK in ...` line rather than restated here.
 *
 * BOTH DIRECTIONS (issue #2732). The binding above is "every fixture string is
 * owned by a warn" — a cap. Its floor is that every literal-bearing
 * `Export.Name` warn is GREPPED: the count of such warns must EQUAL the count
 * of fixture strings, so a third fallback arm with its own `logger.warn` cannot
 * be added to the name loop while Guard 7b silently keeps watching the two
 * that existed when it was written. And the strings are bound to the guard's
 * POLARITY, not only to its loop line: the body must `grep` the string and
 * `exit 1` on a hit, since a loop whose body was deleted still "uses" the
 * strings while asserting nothing (measured before this revision).
 *
 * A warn whose message is BUILT BY A HELPER (`logger.warn(someHelper(...))`,
 * the spelling `exportAliasCollisionScrubWarning` already uses one loop over)
 * carries no literal run and is not classified as an `Export.Name` warn at
 * all. Extracting either name-fallback message into such a helper therefore
 * drops the warn count to one and trips the equality — loud, and pointing at
 * the count rather than at the extraction. When that refactor happens, the
 * fence has to learn the helper's name; the equality failing is the reminder.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf-8',
}).trim();

const FIXTURE = 'tests/integration/secrets-dynamic-ref/verify.sh';
const SOURCE = 'src/cli/commands/scrub.ts';

/**
 * The quoted strings of the fixture's `for NAME_FALLBACK in "..." "..."; do`
 * line. Leading whitespace is allowed — re-indenting the loop is a legitimate
 * refactor, and a `^`-anchored read failed it with `strings.length=0`, a
 * message that pointed at the wrong thing (issue #2732).
 */
function fixtureFallbackStrings(script: string): string[] {
  const line = script.split('\n').find((l) => /^\s*for NAME_FALLBACK in /.test(l));
  if (line === undefined) return [];
  return [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

/**
 * Whether Guard 7b's loop BODY asserts the polarity the strings are greped
 * for: a `grep` of `${NAME_FALLBACK}` whose HIT — not its miss — reaches an
 * `exit 1` before the loop closes. The loop line alone says the strings are
 * USED; only the body says a hit FAILS the run. Read as the lines between the
 * `for NAME_FALLBACK` line and its `done`, then matched as a whole so a reflow
 * cannot split it.
 *
 * THE POLARITY IS THE POINT, and the first spelling did not read it: it
 * required only that a grep and an `exit 1` share the body, so `! grep …`,
 * `grep … || exit 1` and `if ! grep …; then exit 1; fi` — all three INVERTED,
 * asserting the warnings are PRESENT — passed (a reviewer's probe). The grep
 * must therefore be POSITIVE (no `!` in front of it) and reach the `exit` on
 * its TRUE branch: `if grep …; then … exit 1`, or `grep … && … exit 1`. The
 * flag word is read loosely (`-q`, `-qF`, `-q -F`, a `--` terminator) because
 * a reflow of the flags is legitimate and failing it would point at the wrong
 * thing; the polarity is what is strict.
 */
function fallbackLoopAsserts(script: string): boolean {
  const lines = script.split('\n');
  const start = lines.findIndex((l) => /^\s*for NAME_FALLBACK in /.test(l));
  if (start < 0) return false;
  const end = lines.findIndex((l, i) => i > start && /^\s*done\b/.test(l));
  if (end < 0) return false;
  const body = lines.slice(start + 1, end).join('\n');
  // `[^|&\n]*` after the grep's argument keeps the TRUE branch: it stops the
  // match at a `||` (the miss branch) or a newline that is not part of an
  // `if`/`then`, so an inverted guard cannot reach the `exit 1`.
  const POSITIVE_GREP = String.raw`(?<![!]\s{0,4})\bgrep\b(?:\s+-{1,2}[\w-]+)*\s+"\$\{NAME_FALLBACK\}"`;
  const IF_FORM = new RegExp(String.raw`\bif\s+${POSITIVE_GREP}[^|\n]*;?\s*then[\s\S]*?\bexit 1\b`);
  const AND_FORM = new RegExp(String.raw`${POSITIVE_GREP}[^|\n]*&&[^|\n]*\bexit 1\b`);
  return IF_FORM.test(body) || AND_FORM.test(body);
}

/**
 * The literal RUNS of every `logger.warn(...)` call: each string literal and
 * each template-literal piece (head / middle / tail / no-substitution) found
 * anywhere in the call's arguments, as its own entry, in source order. A
 * template substitution is walked too, so a literal INSIDE one
 * (`${cond ? 'a' : 'b'}`) is collected as a run of its own; a non-literal
 * one (`${name}`) contributes nothing. Runs are deliberately NOT joined: a
 * phrase that only exists across a substitution boundary
 * (`resolved ${name}during`) is not a phrase the emitted line carries, so a
 * fixture string must sit inside ONE run. Conservative on purpose — a phrase
 * split across a `+` of two plain literals is refused too, which is a
 * spelling the scrub source does not use, and so is a literal that is an
 * argument to a nested CALL (`${fmt('x')}`, `truncate('x')`): what the call
 * returns is the emitted text, and the literal handed to it need not be.
 */
function warnCallLiteralRuns(source: string): string[][] {
  const file = ts.createSourceFile('scrub.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: string[][] = [];
  const literalRuns = (node: ts.Node, out: string[]): void => {
    // A literal handed to a CALL is that call's input, not the emitted text:
    // `logger.warn(truncate('could not be resolved during scrub'))` may print
    // something else, so descending into it bound the fixture to a phrase the
    // line need not carry (issue #2732). Refusing is the conservative side —
    // a wrapped message reads as "no warn carries this string", which is loud.
    if (ts.isCallExpression(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text);
      for (const span of node.templateSpans) {
        literalRuns(span.expression, out);
        out.push(span.literal.text);
      }
      return;
    }
    ts.forEachChild(node, (child) => literalRuns(child, out));
  };
  /** `logger` or `<anything>.logger` — the receiver NAMED logger, not one merely ending in it. */
  const isLoggerReceiver = (receiver: ts.Expression): boolean =>
    (ts.isIdentifier(receiver) && receiver.text === 'logger') ||
    (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'logger');
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'warn' &&
      isLoggerReceiver(node.expression.expression)
    ) {
      const out: string[] = [];
      for (const arg of node.arguments) literalRuns(arg, out);
      calls.push(out);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

/** The literal runs of every `logger.warn(...)` call one of whose runs is about an `Export.Name`. */
function exportNameWarnRuns(source: string): string[][] {
  return warnCallLiteralRuns(source).filter((runs) => runs.some((r) => r.includes('Export.Name of output ')));
}

describe('secrets-dynamic-ref Guard 7b greps the scrub name-fallback warnings that exist (issue #2531)', () => {
  // A renamed fixture or source is a NAMED failure at collection, not a raw
  // ENOENT — the subject moving is the first thing this fence should say.
  const readSubject = (rel: string): string => {
    try {
      return readFileSync(join(REPO_ROOT, rel), 'utf-8');
    } catch (error) {
      throw new Error(`${rel} is missing or unreadable — this fence's subject moved: ${String(error)}`);
    }
  };
  const script = readSubject(FIXTURE);
  const source = readSubject(SOURCE);
  const strings = fixtureFallbackStrings(script);
  const nameWarns = exportNameWarnRuns(source);

  it('sees both sides it fences — DISTINCT fixture strings and exactly as many Export.Name warn calls', () => {
    // The floors: a fixture whose loop line was renamed or split parses to
    // nothing, a duplicated string would watch one arm twice and the other
    // not at all, and a source walk that found no warn would pass the
    // per-string checks below vacuously. The floor is 2 (the arms that exist);
    // the exact count is derived from the fixture, so a legitimate third grep
    // does not red this line — the equality below is what it must satisfy.
    expect(strings.length).toBeGreaterThanOrEqual(2);
    expect(new Set(strings).size).toBe(strings.length);
    for (const s of strings) expect(s.length).toBeGreaterThan(10);
    // BOTH DIRECTIONS: every literal-bearing Export.Name warn is grepped. A
    // third fallback arm with its own warn, added to the name loop and not to
    // Guard 7b, fails here — the drift this file exists to catch, running the
    // other way (issue #2732).
    expect(
      nameWarns.length,
      `${SOURCE} carries ${nameWarns.length} logger.warn call(s) about an Export.Name with a literal message, but ${FIXTURE}'s Guard 7b greps ${strings.length} string(s); a warn Guard 7b does not watch is the drift this fence exists for`,
    ).toBe(strings.length);
  });

  it('each fixture string sits inside one literal run of its own Export.Name warn call, one call per string', () => {
    const owners = strings.map((s) => nameWarns.findIndex((runs) => runs.some((r) => r.includes(s))));
    for (const [i, s] of strings.entries()) {
      expect(owners[i], `fixture greps "${s}" but no logger.warn about an Export.Name in ${SOURCE} carries it inside one literal run`).toBeGreaterThanOrEqual(0);
    }
    // One arm per string: the same warn must not own two.
    expect(new Set(owners).size).toBe(strings.length);
  });

  it("Guard 7b's loop body asserts the polarity: a hit on a fallback string fails the run", () => {
    // The strings being USED is not the strings being ASSERTED. Measured:
    // deleting the loop body (`grep -qF ... exit 1`) while leaving the `for`
    // line in place kept every other case here green (issue #2732 item 2).
    expect(fallbackLoopAsserts(script), `${FIXTURE}'s NAME_FALLBACK loop no longer greps the string and exits 1 on a hit`).toBe(true);
    // Its own controls. NOT asserting: the loop line alone; a grep that does
    // not fail; and the three INVERTED guards, which assert the warnings are
    // PRESENT and which the first spelling of this reader accepted.
    expect(fallbackLoopAsserts('for NAME_FALLBACK in "a b c" "d e f"; do\ndone\n')).toBe(false);
    expect(fallbackLoopAsserts('for NAME_FALLBACK in "a b c"; do\n  grep -qF "${NAME_FALLBACK}" <<< "${OUT}" && echo seen\ndone\n')).toBe(false);
    expect(fallbackLoopAsserts('for NAME_FALLBACK in "a b c"; do\n  grep -qF "${NAME_FALLBACK}" <<< "${OUT}" || exit 1\ndone\n')).toBe(false);
    expect(fallbackLoopAsserts('for NAME_FALLBACK in "a b c"; do\n  ! grep -qF "${NAME_FALLBACK}" <<< "${OUT}" && exit 1\ndone\n')).toBe(false);
    expect(fallbackLoopAsserts('for NAME_FALLBACK in "a b c"; do\n  if ! grep -qF "${NAME_FALLBACK}" <<< "${OUT}"; then\n    exit 1\n  fi\ndone\n')).toBe(false);
    // ASSERTING: the real `if` shape (indented), the `&&` shape, and the flag
    // spellings a reflow produces.
    expect(fallbackLoopAsserts('  for NAME_FALLBACK in "a b c"; do\n    if grep -qF "${NAME_FALLBACK}" <<< "${OUT}"; then\n      exit 1\n    fi\n  done\n')).toBe(true);
    expect(fallbackLoopAsserts('for NAME_FALLBACK in "a b c"; do\n  grep -qF "${NAME_FALLBACK}" <<< "${OUT}" && exit 1\ndone\n')).toBe(true);
    expect(fallbackLoopAsserts('for NAME_FALLBACK in "a b c"; do\n  if grep -q -F "${NAME_FALLBACK}" <<< "${OUT}"; then\n    exit 1\n  fi\ndone\n')).toBe(true);
  });

  it('keeps exactly the logger.warn calls about an Export.Name, with every literal piece of their arguments', () => {
    // A self-probe for the reader's own clauses, each with a control that
    // would slip through if the clause were dropped: the `warn` name (a
    // `debug` with the same wording), the `logger` receiver (`other.warn`,
    // and `otherlogger` / `this.otherlogger`, which a suffix match accepts,
    // and a string-literal receiver spelled `'logger'`, which a name-only
    // test accepts),
    // the Export.Name filter (an unrelated warn), ordinary string literals
    // beside a template, and a literal INSIDE a substitution.
    const probe = [
      "logger.debug(`Export.Name of output ${name} could not be resolved during scrub`);",
      "other.warn(`Export.Name of output ${name} did not fully resolve during scrub`);",
      "otherlogger.warn(`Export.Name of output ${name} did not fully resolve during scrub`);",
      "this.otherlogger.warn(`Export.Name of output ${name} did not fully resolve during scrub`);",
      "'logger'.warn(`Export.Name of output ${name} did not fully resolve during scrub`);",
      "logger.warn('unrelated: could not be resolved during scrub');",
      "this.logger.warn(",
      "  'lead ' + `Export.Name of output ${name} ${cond ? 'x' : 'y'} during scrub` + ' trail'",
      ");",
    ];
    expect(exportNameWarnRuns(probe.join('\n'))).toEqual([
      ['lead ', 'Export.Name of output ', ' ', 'x', 'y', ' during scrub', ' trail'],
    ]);
    // ...and the unfiltered reader saw the unrelated warn but not the debug or the other receivers.
    expect(warnCallLiteralRuns(probe.join('\n'))).toHaveLength(2);
    // EACH negative control on its own: the `toEqual` above is satisfied as
    // long as the one positive line is read correctly, so deleting any single
    // control left it green (issue #2732). One assertion per control fences
    // the clause that control exists for.
    const controls = probe.slice(0, 6);
    expect(controls).toHaveLength(6);
    for (const line of controls) {
      expect(exportNameWarnRuns(line), `negative control must classify as no Export.Name warn: ${line}`).toEqual([]);
    }
    // A message built by a call is not read as the emitted text: no run, so
    // not an Export.Name warn (the helper-call spelling the header describes).
    expect(exportNameWarnRuns("logger.warn(truncate('Export.Name of output x could not be resolved during scrub'));")).toEqual([]);
    expect(warnCallLiteralRuns("logger.warn(truncate('Export.Name of output x could not be resolved during scrub'));")).toEqual([[]]);
  });

  it('does not invent a phrase across a substitution the emitted line would interrupt', () => {
    // `resolved ${name}during scrub` never prints "resolved during scrub" for
    // a non-empty name; joining the pieces would say it does.
    const probe = 'logger.warn(`Export.Name of output ${name} could not be resolved ${name}during scrub`);';
    const [runs] = exportNameWarnRuns(probe);
    expect(runs).toEqual(['Export.Name of output ', ' could not be resolved ', 'during scrub']);
    expect(runs!.some((r) => r.includes('could not be resolved during scrub'))).toBe(false);
  });

  it('reads literal text only — a comment is not a warning', () => {
    // The negative control for the fence's own reader: the old wording
    // quoted in a trailing or block comment inside the call must not count.
    const probe = [
      'logger.warn(',
      '  `Export.Name of output ${name} failed to resolve ` + // was: could not be resolved during scrub',
      '  /* did not fully resolve during scrub */ `tail`',
      ');',
    ].join('\n');
    const [runs] = warnCallLiteralRuns(probe);
    expect(runs).toEqual(['Export.Name of output ', ' failed to resolve ', 'tail']);
    for (const r of runs!) {
      expect(r).not.toContain('could not be resolved during scrub');
      expect(r).not.toContain('did not fully resolve during scrub');
    }
  });
});
