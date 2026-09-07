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
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf-8',
}).trim();

const FIXTURE = 'tests/integration/secrets-dynamic-ref/verify.sh';
const SOURCE = 'src/cli/commands/scrub.ts';

/** The quoted strings of the fixture's `for NAME_FALLBACK in "..." "..."; do` line. */
function fixtureFallbackStrings(script: string): string[] {
  const line = script.split('\n').find((l) => /^for NAME_FALLBACK in /.test(l));
  if (line === undefined) return [];
  return [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
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
 * spelling the scrub source does not use.
 */
function warnCallLiteralRuns(source: string): string[][] {
  const file = ts.createSourceFile('scrub.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: string[][] = [];
  const literalRuns = (node: ts.Node, out: string[]): void => {
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
  const script = readFileSync(join(REPO_ROOT, FIXTURE), 'utf-8');
  const source = readFileSync(join(REPO_ROOT, SOURCE), 'utf-8');
  const strings = fixtureFallbackStrings(script);
  const nameWarns = exportNameWarnRuns(source);

  it('sees both sides it fences — two DISTINCT fixture strings and at least two Export.Name warn calls', () => {
    // The floors: a fixture whose loop line was renamed or split parses to
    // nothing, a duplicated string would watch one arm twice and the other
    // not at all, and a source walk that found no warn would pass the
    // per-string checks below vacuously.
    expect(strings).toHaveLength(2);
    expect(new Set(strings).size).toBe(2);
    for (const s of strings) expect(s.length).toBeGreaterThan(10);
    expect(nameWarns.length).toBeGreaterThanOrEqual(2);
  });

  it('each fixture string sits inside one literal run of its own Export.Name warn call, one call per string', () => {
    const owners = strings.map((s) => nameWarns.findIndex((runs) => runs.some((r) => r.includes(s))));
    for (const [i, s] of strings.entries()) {
      expect(owners[i], `fixture greps "${s}" but no logger.warn about an Export.Name in ${SOURCE} carries it inside one literal run`).toBeGreaterThanOrEqual(0);
    }
    // Two strings, two arms: the same warn must not own both.
    expect(new Set(owners).size).toBe(2);
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
    ].join('\n');
    expect(exportNameWarnRuns(probe)).toEqual([
      ['lead ', 'Export.Name of output ', ' ', 'x', 'y', ' during scrub', ' trail'],
    ]);
    // ...and the unfiltered reader saw the unrelated warn but not the debug or the other receivers.
    expect(warnCallLiteralRuns(probe)).toHaveLength(2);
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
