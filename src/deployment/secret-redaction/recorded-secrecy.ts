import { SECRET_MASK } from './pairs.js';
import { carriesSecretMask } from './mask-only.js';

/**
 * The ONE place a reader asks whether a recorded or desired value carries a
 * redaction marker (go-to-k/cdkd#7061).
 *
 * The state redaction writes two markers into a record in place of a secret:
 * the mask (`***`) and the unresolved dynamic reference (`{{resolve:...}}`).
 * Readers of a recorded value used to test for them by hand (`=== '***'`,
 * `.includes('{{resolve:')`, a JSON substring, a local copy of either
 * constant), each spelling its own variant, and each new reader picked one.
 * The class this closes is a reader whose hand test answered "not secret"
 * where the record could not tell (#4810, #6303, #7037, #7050, #7059, #7068,
 * #7090, #7097). Every reader in a migrated module group asks here instead, and
 * `tests/unit/scripts/recorded-secrecy-readers-7061.test.ts` fails on a hand
 * test, or a direct `carriesSecretMask` call, in those groups.
 *
 * Each predicate keeps the exact meaning of the hand tests it replaced: this
 * module changes no verdict, it only names them.
 *
 * NOT YET HERE: the record-provenance answer. These predicates read a value's
 * text, which is right for the markers the redaction itself writes; they
 * cannot see a secret the record kept in plaintext (a sub-floor piece, a
 * legacy row, a cross-stack copy). Readers that need that today consult the
 * record's provenance fields (`noEchoLeaves`, masked fingerprints, `NoEcho`
 * MACs) beside these. The plan of #7061 adds one record-aware entry point here
 * that answers masked / clear / unknown, moves the readers that decide on a
 * record onto it group by group, and then narrows the fence so these text-only
 * predicates are reachable only from it.
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
 * The mask ANYWHERE in the value, an embedded one included (`'arn:***'`): in a
 * string's own text, else in the value's JSON spelling. Broader than
 * {@link holdsMaskLeaf}; it errs toward "masked". `undefined` holds none.
 */
export function mentionsMask(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(SECRET_MASK);
  return (JSON.stringify(value) ?? '').includes(SECRET_MASK);
}

/** The display form of a secret physical-id segment (`****` + its last four characters) in a value's JSON. */
export function mentionsMaskedIdSegment(value: unknown): boolean {
  return (JSON.stringify(value) ?? '').includes('****');
}

const DYNAMIC_REFERENCE_OPENER = '{{resolve:';

/** The dynamic-reference opener (`{{resolve:`) in a string, any service. */
export function mentionsDynamicReference(text: string): boolean {
  return text.includes(DYNAMIC_REFERENCE_OPENER);
}

/**
 * The dynamic-reference opener anywhere in a value's JSON spelling, any
 * service. `undefined` holds none.
 */
export function valueMentionsDynamicReference(value: unknown): boolean {
  return mentionsDynamicReference(JSON.stringify(value) ?? '');
}

/**
 * Each dynamic-reference opener in `text`, in order: where it starts and the
 * text after it (`secretsmanager:...}}`), for a reader that walks the tokens.
 */
export function dynamicReferenceOpeners(text: string): Array<{ at: number; rest: string }> {
  const out: Array<{ at: number; rest: string }> = [];
  let at = text.indexOf(DYNAMIC_REFERENCE_OPENER);
  while (at >= 0) {
    out.push({ at, rest: text.slice(at + DYNAMIC_REFERENCE_OPENER.length) });
    at = text.indexOf(DYNAMIC_REFERENCE_OPENER, at + DYNAMIC_REFERENCE_OPENER.length);
  }
  return out;
}

/**
 * A recorded or desired NAME, when it can be compared or addressed as one: a
 * non-empty string that is neither the mask nor a value holding a dynamic
 * reference (what the redaction writes in place of a secret-derived name, or a
 * reference not yet resolved). `undefined` otherwise: a name-keyed decision (a
 * name change, a name holder) is taken on nothing else.
 */
export function usableRecordedName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || isMaskLeaf(value)) return undefined;
  return mentionsDynamicReference(value) ? undefined : value;
}

/**
 * The body of a WHOLE `{{resolve:<service>:...}}` token (between the
 * `<service>:` and the closing `}}`), or `undefined` when `token` is not one.
 */
export function dynamicReferenceBody(token: string, service: string): string | undefined {
  const prefix = `${DYNAMIC_REFERENCE_OPENER}${service}:`;
  if (!token.startsWith(prefix) || !token.endsWith('}}')) return undefined;
  return token.slice(prefix.length, -2);
}

/**
 * A text that is a run of three or more `*` and nothing else: the mask, or a
 * placeholder a provider or an older cdkd wrote in its shape.
 */
export function isMaskRun(text: string): boolean {
  return /^\*{3,}$/.test(text);
}
