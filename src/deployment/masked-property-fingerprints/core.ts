/**
 * The text fingerprint (`sha256:`, go-to-k/cdkd#4451) and the encoding shared
 * by every masked-property fingerprint; split out of
 * `masked-property-fingerprints.ts` (#5835).
 */
import { createHash } from 'node:crypto';
import {
  MIN_NEEDLE_LENGTH,
  printingCorpusOf,
  type RecordedSecretValues,
} from '../secret-redaction.js';

/** The version of the text hash's input layout (`sha256:` entries). */
const FINGERPRINT_LAYOUT = 1;
/** The version of the input hash's layout (`inputs-sha256:` entries, go-to-k/cdkd#4543). */
export const INPUT_FINGERPRINT_LAYOUT = 2;

/**
 * Key-order-free JSON. An `undefined` object member is omitted, as
 * `JSON.stringify` omits it, and an `undefined` array element or root reads as
 * `null`, so a value built in code hashes as its serialized form does.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The entry a property gets instead of a hash when its template value
 * contains a value the same resource resolved as a secret. Read as no
 * fingerprint (the pre-#4451 comparison), and an entry the backfill does not
 * replace.
 */
export const REFUSED_FINGERPRINT = 'refused:secret-in-template';

export const FINGERPRINT_PREFIX = 'sha256:';
/** An input fingerprint's prefix (its own field, go-to-k/cdkd#4543). */
export const INPUT_FINGERPRINT_PREFIX = 'inputs-sha256:';
/** Joins an input fingerprint's input half to the text half it is bound to. */
export const TEXT_HALF_SEPARATOR = '+';

/** An input fingerprint's two halves; the text half is `undefined` when malformed. */
export function splitInputFingerprint(entry: string): { input: string; text: string | undefined } {
  const at = entry.indexOf(TEXT_HALF_SEPARATOR);
  if (at < 0) return { input: entry, text: undefined };
  const text = entry.slice(at + 1);
  return {
    input: entry.slice(0, at),
    text: text.startsWith(FINGERPRINT_PREFIX) ? text : undefined,
  };
}

/**
 * Whether `templateValue` contains, as text, a needle of `secrets` at or above
 * the needle floor (the plain and the JSON-escaped spelling, since the hash
 * reads the canonical JSON). The printing corpus, so a `NoEcho` parameter's
 * value counts too.
 */
export function templateCarriesNeedle(
  templateValue: unknown,
  secrets: RecordedSecretValues
): boolean {
  const text = canonicalJson(templateValue);
  for (const needle of printingCorpusOf(secrets).keys()) {
    if (needle.length < MIN_NEEDLE_LENGTH) continue;
    if (text.includes(needle) || text.includes(JSON.stringify(needle).slice(1, -1))) return true;
  }
  return false;
}

/** `sha256:<hex>` over one property's UNRESOLVED template value. */
export function maskedPropertyFingerprint(templateValue: unknown): string {
  const digest = createHash('sha256')
    .update(canonicalJson({ layout: FINGERPRINT_LAYOUT, value: templateValue }))
    .digest('hex');
  return `${FINGERPRINT_PREFIX}${digest}`;
}
