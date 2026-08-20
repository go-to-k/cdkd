import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Every writer of `imports` / `outputReads` in `deploy-engine.ts` must route
 * through `crossStackReadsForPartialSave`, unless it is the ONE success-path
 * save (issue [#2057](https://github.com/go-to-k/cdkd/issues/2057), fix-delta
 * review).
 *
 * WHY A SOURCE SCAN RATHER THAN A BEHAVIOURAL TEST. The rule is "only the
 * success path replaces; every other save unions", and the failure mode is not
 * a wrong value at one site — it is a site NOBODY LOOKED AT. That already
 * happened once: the helper's own doc claimed the union was "applied at ALL
 * FIVE non-success saves" while `persistStateAfterOutputFailure` wrote
 * `imports: [...this.recordedImports]` wholesale, having copied the success
 * path's shape onto a path that writes a rollback journal segment and
 * rethrows. A per-site behavioural test can only cover sites someone
 * enumerated, which is precisely the step that failed; and a prose count is
 * worse than none, because it is the sentence a reader uses to conclude the
 * rule is fully applied.
 *
 * So the enumeration is DERIVED here instead of asserted there. A new save
 * site — or an old one edited back to a wholesale write — fails this test
 * rather than escaping silently.
 *
 * The key names are the whole scan surface: a save site cannot persist these
 * records without spelling one of them as an object key.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE = 'src/deployment/deploy-engine.ts';

/**
 * Comments carry example spellings (this rule's own doc does), so drop them.
 *
 * LINE comments are blanked BEFORE block comments are stripped, and the order
 * is load-bearing rather than incidental. A `//` comment naming a glob — and
 * this repo's comments name them constantly — contains the two characters that
 * OPEN a block comment: `src/provisioning/**` is `…/` followed by `**`. With
 * the block pass first, that glob swallowed everything up to the next `*\/`,
 * which for one instance in `deploy-engine.ts` was 235 lines including BOTH
 * success-path writes and two of the helper calls. The scan then reported ZERO
 * writers and a lower helper count — i.e. it failed CLOSED into "nothing to
 * see", which is exactly the silence this whole test exists to prevent.
 *
 * Blanking whole-line comments first removes the glob before it can be read as
 * a delimiter. A TRAILING `// …/**` after code is still a live hazard, and is
 * deliberately not handled: stripping to end-of-line needs string awareness
 * (`'https://…'` in real code) and regex-literal awareness (this file's own
 * `/\/\*[\s\S]*?\*\//`), and getting that wrong fails OPEN in a way the fence
 * below would not catch. The fence is what makes the residual visible.
 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => (line.trim().startsWith('//') ? '' : line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The success-path save, and ONLY it, replaces the records wholesale: every
 * resource op AND output resolution succeeded, so this run's records are the
 * complete truth and a stale snapshot entry should be dropped. Matched on the
 * exact spelling so an edit to it re-opens this test rather than sliding under
 * the allow-list.
 */
const SUCCESS_PATH_WRITES: readonly string[] = [
  '...(this.recordedImports.length > 0 && { imports: [...this.recordedImports] }),',
  'outputReads: [...this.recordedOutputReads],',
];

/**
 * The helper's own returns use SHORTHAND (`{ imports }`), which carries no
 * `key:` and so is invisible to this scan by construction — the scan is looking
 * for a site that writes a VALUE into these fields, and the helper is the one
 * place entitled to produce that value.
 */

interface Writer {
  line: number;
  text: string;
}

/**
 * An object KEY named exactly `imports` / `outputReads` with a VALUE. The
 * leading class keeps `recordedImports:` / `recordedOutputReads:` (the resolver
 * context's own fields) out, and their capital letters would anyway.
 */
const WRITES_A_VALUE = /(^|[\s{(])(imports|outputReads)\s*:/;

function scanWriters(source: string): Writer[] {
  const writers: Writer[] = [];
  stripComments(source)
    .split('\n')
    .forEach((raw, i) => {
      if (WRITES_A_VALUE.test(raw)) writers.push({ line: i + 1, text: raw.trim() });
    });
  return writers;
}

function collectWriters(): Writer[] {
  return scanWriters(readFileSync(`${REPO_ROOT}${SOURCE}`, 'utf8'));
}

describe('every cross-stack-read writer in deploy-engine.ts is accounted for (#2057)', () => {
  it('finds ONLY the success-path writes — every other save spreads the helper', () => {
    const writers = collectWriters();
    expect(
      writers.map((w) => `${SOURCE}:${w.line}  ${w.text}`),
      'these write imports/outputReads directly. Every save EXCEPT the success ' +
        'path must spread `crossStackReadsForPartialSave(currentState, ' +
        'this.recordedImports, this.recordedOutputReads)` instead — see that ' +
        "helper's doc for why a wholesale write erases a producer region the " +
        'previous record carried'
    ).toEqual(
      SUCCESS_PATH_WRITES.map(
        (text) => `${SOURCE}:${writers.find((w) => w.text === text)?.line ?? 'MISSING'}  ${text}`
      )
    );
  });

  it('the scan actually SEES a wholesale write (positive control)', () => {
    // Without this the test above passes just as happily against a regex that
    // matches nothing, which is the same "nobody looked" failure it exists to
    // catch. Both real spellings the file has used are fed in.
    const flagged = scanWriters(
      [
        'const partialState: StackState = {',
        '  resources: newResources,',
        '  ...(currentState.imports && currentState.imports.length > 0 && {',
        '    imports: currentState.imports,',
        '  }),',
        '  ...(this.recordedOutputReads.length > 0 && {',
        '    outputReads: [...this.recordedOutputReads],',
        '  }),',
        '  // imports: this-is-a-comment-and-must-not-count,',
        '  recordedImports: this.recordedImports,',
        '};',
      ].join('\n')
    ).map((w) => w.text);
    expect(flagged).toEqual([
      'imports: currentState.imports,',
      'outputReads: [...this.recordedOutputReads],',
    ]);
  });

  it('a GLOB in a line comment does not eat the rest of the file', () => {
    // The residual this scan nearly died of. `src/provisioning/**` inside a
    // `//` comment contains `/` + `*`, which OPENS a block comment — so with
    // the block pass running first it swallowed everything up to the next
    // `*` + `/`. In `deploy-engine.ts` that was 235 lines carrying BOTH
    // success-path writes and two helper calls, and the scan reported zero
    // writers: a FAIL-CLOSED silence, indistinguishable from a clean file to
    // every assertion except this one.
    //
    // Fed as a fixture rather than trusted to the real source, so the property
    // survives whoever next edits that comment out.
    const flagged = scanWriters(
      [
        '// every `withRetry` under `src/provisioning/**` threads the watch',
        'const partialState: StackState = {',
        '  imports: currentState.imports,',
        '};',
        // The CLOSING delimiter is what completes the swallow, and a fixture
        // without one proves nothing: the block regex needs a `*` + `/` to
        // match at all, so a glob with nothing after it is inert and the
        // fixture passes under BOTH strip orders. Every real file has a later
        // doc comment; this stands in for it.
        '/** a later doc comment, as every real file has */',
      ].join('\n')
    ).map((w) => w.text);
    expect(
      flagged,
      'a glob in a line comment swallowed the code after it — strip line ' +
        'comments BEFORE block comments'
    ).toEqual(['imports: currentState.imports,']);
  });

  it('finds the success-path write exactly once, so the allow-list cannot cover a second one', () => {
    const writers = collectWriters();
    for (const allowed of SUCCESS_PATH_WRITES) {
      expect(
        writers.filter((w) => w.text === allowed).length,
        `${allowed} appears more than once — a second wholesale writer would be waved through by the allow-list`
      ).toBe(1);
    }
  });

  it('counts the union call sites, so a deleted spread reds this test', () => {
    const source = stripComments(readFileSync(`${REPO_ROOT}${SOURCE}`, 'utf8'));
    const calls = source.match(/crossStackReadsForPartialSave\(/g) ?? [];
    // 1 declaration + 6 non-success saves + 1 rollback-executor context.
    expect(
      calls.length,
      'the helper call count changed — if a save site was added or removed, update this number AND the count in the helper doc'
    ).toBe(8);
  });
});
