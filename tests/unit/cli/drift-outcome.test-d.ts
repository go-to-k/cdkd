import { describe, it, expectTypeOf } from 'vite-plus/test';
import { matchOutcome, type DriftOutcome } from '../../../src/cli/commands/drift.js';

/**
 * Issue [#2135](https://github.com/go-to-k/cdkd/issues/2135): the EXHAUSTIVENESS
 * fence, and the one guarantee in that change a runtime test cannot hold.
 *
 * The headline claim is not that today's consumers are correct -- the runtime
 * suite covers that -- but that the NEXT consumer cannot report a resource cdkd
 * never compared as a clean one, because omitting the case does not compile.
 * That claim rests on two things no behaviour depends on, so both are invisible
 * to every runtime probe:
 *
 *   1. `matchOutcome`'s handler record is a TOTAL mapped type over
 *      `DriftOutcome['kind']`. Relaxing it to a `Partial` would un-fence all
 *      eight call sites in `drift.ts` while changing nothing a test can execute.
 *   2. The `clean` variant carries NO completeness marker. Adding one back --
 *      the pre-#2135 `referencesUnresolved` rider -- would let a consumer spell
 *      an uncompared resource as `clean` again, which is exactly the shape the
 *      issue exists to remove.
 *
 * The `kind` union is pinned as well, so a sixth variant lands here first: this
 * file is where the note lives that says every `matchOutcome` call site in
 * `drift.ts` must then name it.
 */
describe('DriftOutcome exhaustiveness (issue #2135)', () => {
  it('pins the variants, so a new one is a deliberate edit rather than a default', () => {
    expectTypeOf<DriftOutcome['kind']>().toEqualTypeOf<
      'drifted' | 'clean' | 'notCompared' | 'unsupported' | 'skipped'
    >();
  });

  it('refuses a handler record that omits a variant', () => {
    // @ts-expect-error — `notCompared` is missing. THE fence: this is what a
    // consumer written without thinking about an uncompared resource looks
    // like, and under the pre-#2135 `clean` + boolean shape it compiled and
    // reported that resource as clean.
    const partial: Parameters<typeof matchOutcome<string>>[1] = {
      drifted: () => 'drifted',
      clean: () => 'clean',
      unsupported: () => 'unsupported',
      skipped: () => 'skipped',
    };
    void partial;
  });

  it('accepts a handler record that names every variant', () => {
    const total: Parameters<typeof matchOutcome<string>>[1] = {
      drifted: () => 'drifted',
      clean: () => 'clean',
      notCompared: () => 'notCompared',
      unsupported: () => 'unsupported',
      skipped: () => 'skipped',
    };
    void total;
  });

  it('hands each handler its OWN variant, not the bare union', () => {
    // The half that makes the fence useful rather than merely noisy: the
    // `notCompared` handler can read `notComparedCause` without narrowing, and
    // the `clean` one cannot read it at all (asserted below).
    matchOutcome<void>({ kind: 'clean', logicalId: 'X', resourceType: 'AWS::SQS::Queue' }, {
      drifted: (d) => expectTypeOf(d.changes).toExtend<unknown[]>(),
      clean: (c) => expectTypeOf(c.logicalId).toEqualTypeOf<string>(),
      notCompared: (n) =>
        expectTypeOf(n.notComparedCause).toEqualTypeOf<'refused' | 'unresolvedToken'>(),
      unsupported: () => {},
      skipped: () => {},
    });
  });

  it('rejects a `clean` outcome carrying a completeness marker', () => {
    // The pre-#2135 rider. A `clean` that can say "actually I was not compared"
    // is the ambiguity this refactor removed; re-adding it must be a compile
    // error, not a review catch. (The directive sits on the PROPERTY because
    // that is where an excess-property error is reported.)
    const flaggedClean: DriftOutcome = {
      kind: 'clean',
      logicalId: 'Fn',
      resourceType: 'AWS::Lambda::Function',
      // @ts-expect-error — `clean` carries no completeness marker.
      notComparedCause: 'refused',
    };
    void flaggedClean;
  });

  it('requires a cause on `notCompared` — the reason IS the exit code', () => {
    // @ts-expect-error — without it the exit decision cannot tell a refusal
    // (exit 2) from a surviving `{{resolve:ssm-secure:...}}` token (exit 0),
    // and the narrowing #2108 fought for collapses.
    const causeless: DriftOutcome = {
      kind: 'notCompared',
      logicalId: 'Fn',
      resourceType: 'AWS::Lambda::Function',
    };
    void causeless;
  });

  it('requires `drifted` to STATE its completeness, even when complete', () => {
    // @ts-expect-error — required rather than optional: a drifted resource
    // whose secret-bearing properties were skipped reports real changes that
    // are not the whole comparison, so the construction site must say which.
    const silentDrift: DriftOutcome = {
      kind: 'drifted',
      logicalId: 'Fn',
      resourceType: 'AWS::Lambda::Function',
      changes: [],
      awsProperties: {},
      secrets: new Map(),
      maskedPaths: new Set(),
    };
    void silentDrift;
  });
});
