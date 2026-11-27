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
 * These predicates read a value's TEXT, which is right for the markers the
 * redaction itself writes; they cannot see a secret the record kept in
 * plaintext. A reader deciding on a RECORDED position asks
 * {@link recordedSecrecyOf}, which adds the record's provenance fields; the
 * fence fails on a text predicate called on a record bag outside its pinned
 * table of readers whose verdict the provenance answer would change.
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

/** The opener of a reference to one service (`{{resolve:<service>:`) in a string. */
export function mentionsDynamicReferenceTo(text: string, service: string): boolean {
  return text.includes(`${DYNAMIC_REFERENCE_OPENER}${service}:`);
}

/** Whether `text` STARTS with the opener of a reference to `service` (`{{resolve:<service>:`). */
export function opensDynamicReferenceTo(text: string, service: string): boolean {
  return text.startsWith(`${DYNAMIC_REFERENCE_OPENER}${service}:`);
}

/**
 * How many dynamic-reference openers `text` holds, non-overlapping; with
 * `service`, only the openers of a reference to that service.
 */
export function countDynamicReferenceOpenings(text: string, service?: string): number {
  const openers = dynamicReferenceOpeners(text);
  return service === undefined
    ? openers.length
    : openers.filter(({ rest }) => rest.startsWith(`${service}:`)).length;
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

/**
 * What a RECORD says about one position of its own bags (go-to-k/cdkd#7061):
 *
 * - `masked`: the value there carries a redaction marker (the mask anywhere
 *   in it, an embedded piece included, or a dynamic reference), or a
 *   provenance field names
 *   the position: a `noEchoLeaves` coordinate under the key, a
 *   `maskedPropertyFingerprints` key (both `properties`), a
 *   `noEchoAttributeNames` entry (`attributes`), or an `observedMaskedLeaves`
 *   coordinate under the key (`observedProperties`, go-to-k/cdkd#7158).
 * - `unknown`: there is no record, or its bag is not an object.
 * - `clear`: everything else.
 *
 * Every reader treats `unknown` exactly as `masked`: when in doubt, mask.
 * Provenance only ever ADDS `masked`, so a reader moving here from a text
 * test of the same position masks the same or more. Malformed provenance
 * fields read as absent, as their own readers read them.
 */
export type RecordedSecrecy = 'masked' | 'clear' | 'unknown';

/** The fields of a record {@link recordedSecrecyOf} reads, structurally. */
export interface RecordedSecrecySource {
  readonly properties?: unknown;
  readonly attributes?: unknown;
  readonly observedProperties?: unknown;
  readonly noEchoLeaves?: unknown;
  readonly observedMaskedLeaves?: unknown;
  readonly noEchoAttributeNames?: unknown;
  readonly maskedPropertyFingerprints?: unknown;
}

/** A record's own secrecy provenance fields, as stored, carried to a reader without the record. */
export type RecordedProvenanceFields = Pick<
  RecordedSecrecySource,
  'noEchoLeaves' | 'maskedPropertyFingerprints'
>;

export function recordedSecrecyOf(
  record: RecordedSecrecySource | undefined,
  at: {
    readonly field: 'properties' | 'attributes' | 'observedProperties';
    readonly key: string;
  }
): RecordedSecrecy {
  if (record === undefined || record === null || typeof record !== 'object') return 'unknown';
  const bag = record[at.field];
  if (bag === null || typeof bag !== 'object' || Array.isArray(bag)) return 'unknown';
  const value = Object.hasOwn(bag, at.key) ? (bag as Record<string, unknown>)[at.key] : undefined;
  if (mentionsMask(value) || valueMentionsDynamicReference(value)) return 'masked';
  if (at.field === 'observedProperties') {
    // `noEchoLeaves` coordinates hold the mask in the readback too.
    const named = [record.observedMaskedLeaves, record.noEchoLeaves];
    return named.some(
      (field) => Array.isArray(field) && field.some((c) => Array.isArray(c) && c[0] === at.key)
    )
      ? 'masked'
      : 'clear';
  }
  if (at.field === 'attributes') {
    const names = record.noEchoAttributeNames;
    return Array.isArray(names) && names.includes(at.key) ? 'masked' : 'clear';
  }
  const leaves = record.noEchoLeaves;
  if (Array.isArray(leaves) && leaves.some((c) => Array.isArray(c) && c[0] === at.key)) {
    return 'masked';
  }
  const fingerprints = record.maskedPropertyFingerprints;
  if (
    fingerprints !== null &&
    typeof fingerprints === 'object' &&
    !Array.isArray(fingerprints) &&
    Object.hasOwn(fingerprints, at.key)
  ) {
    return 'masked';
  }
  return 'clear';
}
