import { SECRET_MASK } from './pairs.js';
import { carriesSecretMask } from './mask-only.js';

/**
 * The ONE place a reader asks whether a recorded or desired value carries a
 * redaction marker (go-to-k/cdkd#7061).
 *
 * The state redaction writes two markers into a record in place of a secret:
 * the mask (`***`) and the unresolved dynamic reference (`{{resolve:...}}`).
 * Readers of a recorded value used to test for them by hand (`=== '***'`,
 * `.includes('{{resolve:')`, a JSON substring), each spelling its own variant,
 * and each new reader picked one. The class this closes is a reader whose
 * hand test answered "not secret" where the record could not tell
 * (#4810, #6303, #7037, #7050, #7059, #7068, #7090, #7097). Every reader in a
 * migrated module group asks here instead, and
 * `tests/unit/deployment/recorded-secrecy-readers-7061.test.ts` fails on a
 * hand test in those groups.
 *
 * Each predicate keeps the exact meaning of the hand tests it replaced: this
 * module changes no verdict, it only names them. A reader that needs the
 * RECORD's provenance as well (`noEchoLeaves`, masked fingerprints, `NoEcho`
 * MACs, a legacy row) reads it beside these; the record-provenance answer
 * joins this module as later groups migrate.
 */

/** The mask leaf itself: the whole value is `***`. */
export function isMaskLeaf(value: unknown): value is typeof SECRET_MASK {
  return value === SECRET_MASK;
}

/** The mask as a whole leaf at any depth (a value holding `['a', '***']` included). */
export function holdsMaskLeaf(value: unknown): boolean {
  return carriesSecretMask(value);
}

/**
 * The mask ANYWHERE in the value's JSON spelling, an embedded one included
 * (`'arn:***'`). Broader than {@link holdsMaskLeaf}; it errs toward "masked".
 * `undefined` holds none.
 */
export function mentionsMask(value: unknown): boolean {
  return (JSON.stringify(value) ?? '').includes(SECRET_MASK);
}

/** The dynamic-reference opener (`{{resolve:`) in a string, any service. */
export function mentionsDynamicReference(text: string): boolean {
  return text.includes('{{resolve:');
}

/**
 * The dynamic-reference opener anywhere in a value's JSON spelling, any
 * service. `undefined` holds none.
 */
export function valueMentionsDynamicReference(value: unknown): boolean {
  return mentionsDynamicReference(JSON.stringify(value) ?? '');
}

/**
 * A recorded or desired NAME that can be compared or addressed as one: a
 * non-empty string that is neither the mask nor a value holding a dynamic reference (what
 * the redaction writes in place of a secret-derived name, or a reference not
 * yet resolved). A name-keyed decision (a name change, a name holder) is taken
 * on nothing else.
 */
export function isUsableRecordedName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    !isMaskLeaf(value) &&
    !mentionsDynamicReference(value)
  );
}
