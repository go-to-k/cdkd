/**
 * The PUBLIC `{{resolve:ssm:...}}` values behind a masked property
 * (go-to-k/cdkd#7050 security review).
 *
 * A key recorded as the mask is read as unchanged when its text and input
 * fingerprints are equal, and both hash a reference's TEXT, never its value.
 * For a secret that is CloudFormation's behavior (a Secrets Manager value
 * change alone is not retrieved; an `ssm-secure` change set compares the
 * literal string). For a plain `ssm` parameter CloudFormation states no such
 * skip, so a masked leaf spelling one (a secret's text beside it masked the
 * whole leaf) must still move when that public value moves.
 *
 * `maskedPropertyReferenceFingerprints` holds, per such key,
 * `refs-sha256:<hex>+sha256:<text>`: a hash of each plain `ssm` token the
 * template value spells with its PROVEN public value (`provenPublicValue`, the
 * lookup's own `String` / `StringList` answer), bound to the text fingerprint.
 * A plain `ssm` token that resolved as a secret (`SecureString`) enters as a
 * marker, never its value; `secretsmanager` / `ssm-secure` tokens are left out
 * (CloudFormation parity). A public value equal to a secret of the same pass,
 * or holding one at or above the needle floor, is refused a hash.
 *
 * Fail closed: a token whose value cannot be told (no proof, a token assembled
 * from parts, a refused hash), or a record with no bound entry (an older
 * record), reads as moved.
 */
import { createHash } from 'node:crypto';
import {
  MIN_NEEDLE_LENGTH,
  printingCorpusOf,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import { isRecordedSecretExpression, provenPublicValue } from '../secret-redaction/mask-only.js';
import { canonicalJson, maskedPropertyFingerprint, splitInputFingerprint } from './core.js';
import { DYNAMIC_REFERENCE_OPEN, isPlainObject } from './input-walk.js';
import { maskedPropertyFingerprintsOf } from './records.js';

export const REFERENCE_FINGERPRINT_PREFIX = 'refs-sha256:';
const REFERENCE_FINGERPRINT_LAYOUT = 1;
const SECRET_SERVICES = ['secretsmanager:', 'ssm-secure:'];
const COMPLETE_TOKEN = /^\{\{resolve:([^}]+)\}\}/;

/** What a pass knows of one plain `ssm` token: its proven public value, a secret, or nothing. */
export type PublicReferenceOf = (token: string) => { value: string } | 'secret' | undefined;

/**
 * The {@link PublicReferenceOf} of the pass that owns `bag`. A public value
 * equal to a needle of `corpora` (or of `bag`), or holding one at or above the
 * needle floor, is `undefined`: its hash would confirm a secret.
 */
export function publicReferencesOf(
  bag: RecordedSecretValues | undefined,
  corpora: ReadonlyArray<RecordedSecretValues | undefined> = []
): PublicReferenceOf {
  return (token) => {
    if (bag === undefined) return undefined;
    const value = provenPublicValue(bag, token);
    if (value !== undefined) {
      for (const corpus of [bag, ...corpora]) {
        if (corpus === undefined) continue;
        for (const needle of printingCorpusOf(corpus).keys()) {
          if (needle.length === 0) continue;
          if (needle === value || (needle.length >= MIN_NEEDLE_LENGTH && value.includes(needle))) {
            return undefined;
          }
        }
      }
      return { value };
    }
    if (isRecordedSecretExpression(token)) return 'secret';
    for (const expression of bag.values()) if (expression === token) return 'secret';
    return undefined;
  };
}

/**
 * The plain `ssm` tokens `value`'s string leaves spell, sorted and unique, or
 * `undefined` when a reference's service cannot be read from the text (an
 * opener whose token an intrinsic assembles, a `${...}` inside it).
 */
function publicReferenceTokens(value: unknown): string[] | undefined {
  const tokens = new Set<string>();
  let unknown = false;
  const visit = (node: unknown): void => {
    if (unknown) return;
    if (typeof node === 'string') {
      let at = node.indexOf(DYNAMIC_REFERENCE_OPEN);
      while (at >= 0) {
        const rest = node.slice(at + DYNAMIC_REFERENCE_OPEN.length);
        if (!SECRET_SERVICES.some((service) => rest.startsWith(service))) {
          const match = COMPLETE_TOKEN.exec(node.slice(at));
          if (match === null || match[0].includes('${')) {
            unknown = true;
            return;
          }
          if (match[1]!.split(':')[0] === 'ssm') tokens.add(match[0]);
        }
        at = node.indexOf(DYNAMIC_REFERENCE_OPEN, at + DYNAMIC_REFERENCE_OPEN.length);
      }
      return;
    }
    if (Array.isArray(node)) node.forEach(visit);
    else if (isPlainObject(node)) Object.values(node).forEach(visit);
  };
  visit(value);
  return unknown ? undefined : [...tokens].sort();
}

/**
 * `refs-sha256:<hex>+sha256:<text>` over the plain `ssm` tokens
 * `templateValue` spells and what `referenceOf` knows of each; `null` when it
 * spells none (nothing to record or compare); `undefined` when any one cannot
 * be told.
 */
export function publicReferenceFingerprint(
  templateValue: unknown,
  referenceOf: PublicReferenceOf
): string | null | undefined {
  const tokens = publicReferenceTokens(templateValue);
  if (tokens === undefined) return undefined;
  if (tokens.length === 0) return null;
  const entries: Array<[string, string | null]> = [];
  for (const token of tokens) {
    const known = referenceOf(token);
    if (known === undefined) return undefined;
    entries.push([token, known === 'secret' ? null : known.value]);
  }
  const digest = createHash('sha256')
    .update(canonicalJson({ layout: REFERENCE_FINGERPRINT_LAYOUT, references: entries }))
    .digest('hex');
  return `${REFERENCE_FINGERPRINT_PREFIX}${digest}+${maskedPropertyFingerprint(templateValue)}`;
}

/** The reference fingerprints of `keys` a save stamps (a key with none, or none told, is left out). */
export function maskedReferenceFingerprintsFor(
  keys: readonly string[],
  templateProps: Record<string, unknown>,
  referenceOf: PublicReferenceOf
): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const key of keys) {
    if (!Object.hasOwn(templateProps, key)) continue;
    const fingerprint = publicReferenceFingerprint(templateProps[key], referenceOf);
    if (typeof fingerprint === 'string') entries.push([key, fingerprint]);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * The record's `maskedPropertyReferenceFingerprints`, each kept only while
 * bound to the text fingerprint the record holds for the same key.
 */
export function maskedPropertyReferenceFingerprintsOf(
  record: unknown
): ReadonlyMap<string, string> {
  const read = new Map<string, string>();
  if (record === null || typeof record !== 'object') return read;
  const field = (record as { maskedPropertyReferenceFingerprints?: unknown })
    .maskedPropertyReferenceFingerprints;
  if (!isPlainObject(field)) return read;
  const text = maskedPropertyFingerprintsOf(record);
  for (const [key, value] of Object.entries(field)) {
    if (typeof value !== 'string' || !value.startsWith(REFERENCE_FINGERPRINT_PREFIX)) continue;
    const half = splitInputFingerprint(value).text;
    if (half !== undefined && text.get(key) === half) read.set(key, value);
  }
  return read;
}

/**
 * Whether a public `ssm` value `templateValue` spells moved since `record`
 * was written for `key`: `false` when it spells none, `true` when today's
 * value cannot be told or the record holds no equal bound entry.
 */
export function publicReferencesMoved(
  record: unknown,
  key: string,
  templateValue: unknown,
  referenceOf: PublicReferenceOf | undefined
): boolean {
  const now = publicReferenceFingerprint(templateValue, referenceOf ?? (() => undefined));
  if (now === null) return false;
  if (now === undefined) return true;
  return maskedPropertyReferenceFingerprintsOf(record).get(key) !== now;
}
