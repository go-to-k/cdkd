/**
 * The FORM rule for the destroy path's caught-value reads (issue
 * [#3348](https://github.com/go-to-k/cdkd/issues/3348)).
 *
 * `String(value)` throws for a null-prototype object or a hostile `toString`,
 * and every read on this path sits inside a catch that is already the last
 * handler. The sweep replaced each one with the helper matching its ORIGINAL
 * form, because the two are not interchangeable:
 *
 *  - `x instanceof Error ? x.message : String(x)` -> `describeAwsFailure(x).detail`,
 *    which IS that expression, so text feeding a substring classifier is
 *    unchanged;
 *  - a bare `String(x)` -> `safeStringify(x)`, which is `String(x)` plus a
 *    guard, so the error's NAME survives.
 *
 * Swapping those two is the defect go-to-k/cdkd#3330 shipped once and caught in
 * review: `.detail` at a BARE site silently drops the name. Here that would
 * shorten the operator's `✗ Failed to delete <id>:` line, which is not
 * persisted and so has no behavioural test to red -- a source-shape fence is
 * what makes the inversion visible at all.
 *
 * Deliberately NOT asserted through the runner: its suites mock `getLogger()`
 * to return a fresh object per call, so the line cannot be observed without
 * restructuring scaffolding this rule does not own. The per-shape guarantees
 * themselves are pinned behaviourally in
 * `tests/unit/utils/aws-failure-text.test.ts`.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RUNNER = join(process.cwd(), 'src/cli/commands/destroy-runner.ts');
const FINAL_SNAPSHOT = join(process.cwd(), 'src/provisioning/final-snapshot.ts');

/**
 * Comments are stripped before any scan. `final-snapshot.ts`'s guard now
 * DOCUMENTS this rule in prose, and a fence that reads its own documentation as
 * a violation reds against correct code -- the failure mode this file has
 * already hit twice from the other direction.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('destroy-runner keeps each caught-value read on the helper matching its form', () => {
  const source = codeOf(RUNNER);

  it('reads the operator-facing delete-failure line with safeStringify, not .detail', () => {
    // TWO lines carry this prefix, and only one is a caught-value read: the
    // sibling logs `wrapped.message`, a `ProvisioningError` cdkd built itself.
    // The first spelling of this fence took `.find(...)`, matched THAT one, and
    // failed against correct code -- the "a lint must see its input" trap, in
    // the direction that at least fails loudly.
    const candidates = source
      .split('\n')
      .filter((l) => l.includes('✗ Failed to delete ${logicalId}:'));
    // Excluding the sibling EXPLICITLY rather than relying on it never
    // adopting a helper: it logs `wrapped.message`, a `ProvisioningError` cdkd
    // built, and if it ever routes through `describeAwsFailure` this selector
    // would pick it and red against correct code.
    const caughtValueLine = candidates
      .filter((l) => !l.includes('wrapped.'))
      .find((l) => /(?:safeStringify|describeAwsFailure)\(/.test(l));

    // Floors, so a reword that empties either search fails here rather than
    // asserting nothing -- the shape review caught in go-to-k/cdkd#3330, where
    // a sibling fence's first spelling matched zero lines.
    expect(candidates.length, 'the delete-failure log lines were not found — reworded?').toBe(2);
    expect(caughtValueLine, 'no caught-value read among them — reworded?').toBeDefined();
    expect(
      caughtValueLine,
      'a bare String() site must read safeStringify: `.detail` is `err.message` and drops the name'
    ).toContain('safeStringify(');
  });

  it('leaves no bare String() read of a caught value behind', () => {
    // Derived from the file's OWN `catch (x)` bindings rather than from a list
    // of names. The first spelling enumerated `error|err|e|*Err*`, and review
    // proved it vacuous by renaming the binding to `caught` and restoring the
    // exact pre-fix defect -- the fence stayed green. A name list cannot fence
    // a population that chooses its own names.
    const bindings = [...source.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)].map(
      (m) => m[1]!
    );

    // Floor: a parse that finds no bindings must fail here rather than assert
    // over an empty set.
    expect(bindings.length, 'no catch bindings found — did the parse break?').toBeGreaterThan(10);

    const offenders = source
      .split('\n')
      .map((text, i) => ({ line: i + 1, text }))
      .filter(({ text }) =>
        bindings.some((b) => {
          // ESCAPE the binding: `catch ($err)` is legal, and interpolating it
          // raw makes `$` a regex anchor, so the pattern silently never
          // matches -- the same vacuity class this rewrite exists to close,
          // reached through the escaping instead of through the name list.
          const safe = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // BOTH coercions. A bare `${err}` in a template literal throws
          // identically to `String(err)` -- measured -- and is the more natural
          // spelling for a log line, so a fence watching only the call is one
          // reword away from vacuous.
          // Every coercion that throws the same way. `String(x)` is the one
          // this sweep replaced; `${x}` and string CONCATENATION reach the same
          // `ToPrimitive` and are the more natural spellings for a log line, so
          // a fence watching only the call is one reword from vacuous.
          return [
            `\\bString\\(\\s*${safe}\\s*\\)`,
            `\\$\\{\\s*${safe}\\s*\\}`,
            `['\`"][^'\`"]*['\`"]\\s*\\+\\s*${safe}\\b`,
            `\\b${safe}\\s*\\+\\s*['\`"]`,
          ].some((re) => new RegExp(re).test(text));
        })
      );

    expect(
      offenders.map((o) => `${o.line}: ${o.text.trim()}`),
      'a caught value read with a bare String() throws out of the last handler on the destroy path'
    ).toEqual([]);
  });
});

describe('final-snapshot keeps its shared stringifier guarded', () => {
  // `createPreDeleteFinalSnapshot` is called from `destroy-runner.ts` INSIDE the
  // per-resource try, so `errMsg` is on the destroy path -- it was the THIRD
  // out-throw there, found only after two passes had called the path complete.
  //
  // It needs its own fence because neither existing mechanism reaches it: the
  // sibling above reads `destroy-runner.ts` only, and go-to-k/cdkd#3330's
  // `occurrenceCanDegrade` is CATCH-scoped while `errMsg` takes a function
  // PARAMETER -- the same blindness that hid `extractDeploymentEventError`.
  it('reads its caught value through the guard, not a bare ternary', () => {
    const code = codeOf(FINAL_SNAPSHOT);
    const body = /function errMsg\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(code)?.[1];

    // Floor: a rename or reshape must fail here, not assert over nothing.
    expect(body, 'errMsg was not found — renamed or reshaped?').toBeDefined();
    expect(body, 'a bare String() here throws before anything records the failure').not.toMatch(
      /\bString\(/
    );
    expect(body).toContain('describeAwsFailure(');
  });
});
