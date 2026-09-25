import { describe, it, expectTypeOf } from 'vite-plus/test';
import { malformedOrphanRecordsWarning } from '../../../src/state/malformed-resources-bag.js';

/**
 * Issue [#3500](https://github.com/go-to-k/cdkd/issues/3500): the REQUIREDNESS of
 * `malformedOrphanRecordsWarning`'s `alsoRejectsTornMaps`, which no runtime test
 * can hold.
 *
 * The flag serves two callers taking two different predicates, and it selects
 * BOTH halves of the text: which causes the diagnosis names, and what continuing
 * without the row costs (`cdkd scrub --dry-run` excludes the row from its secret
 * scan, `cdkd diff` does not preview it for adoption). Both callers pass it
 * explicitly today, so restoring the `= false` default it was born with changes
 * no behaviour and reds no runtime case — every existing call stays valid. The
 * cost lands on the NEXT caller, which would then inherit `cdkd diff`'s wording
 * silently, and tell an operator to look for a report its own command never
 * produces.
 *
 * `tests/unit/state/malformed-resources-bag.test.ts` pins what each VALUE
 * renders, in both directions. This file pins that there is no third option.
 */
describe('malformedOrphanRecordsWarning requires its predicate flag (issue #3500)', () => {
  it('refuses a call that omits the flag', () => {
    // @ts-expect-error — three arguments. THE fence: this is what a new caller
    // written without deciding which predicate it took looks like, and with a
    // defaulted parameter it compiles and silently takes `cdkd diff`'s text.
    malformedOrphanRecordsWarning('MyStack', 'us-east-1', ['A']);
    // ...and the four-argument form is the only way in, either value.
    expectTypeOf(malformedOrphanRecordsWarning).parameters.toEqualTypeOf<
      [string, string, readonly string[], boolean]
    >();
  });
});
