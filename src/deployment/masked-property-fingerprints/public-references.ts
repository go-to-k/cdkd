import { dynamicReferenceOpeners } from '../secret-redaction/recorded-secrecy.js';
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
 * `refs-sha256:<hex>+<binding>`: a hash of each plain `ssm` token the key
 * spells with its PROVEN public value (`provenPublicValue`, the lookup's own
 * `String` / `StringList` answer), bound to the key's input fingerprint (or,
 * when the record holds none, its text fingerprint). An older cdkd rewrites
 * both and carries this field untouched, so a change in either drops it.
 * A plain `ssm` token that resolved as a secret (`SecureString`) enters as a
 * marker, never its value; `secretsmanager` / `ssm-secure` tokens are left out
 * (CloudFormation parity). A public value equal to a secret of the same pass,
 * or holding one at or above the needle floor, is refused a hash.
 *
 * WHICH TOKENS. The template's complete tokens, and, where an intrinsic
 * assembles a token's NAME (`{"Fn::Sub":"{{resolve:ssm:/p/${Host}}}"}`, or the
 * `Fn::Join` CDK's `valueForStringParameter` emits for a token name), the
 * tokens its input walk's form (each non-secret input resolved, the reference
 * text kept) spells once its `Fn::Join` / `Fn::Sub` / `Fn::Select` are
 * evaluated: the very token the resolver looked up.
 *
 * WHAT CANNOT BE TOLD. A token whose value this pass did not prove (a
 * producer-region guest's read files no proof, a refused hash), or a name that
 * stays assembled (an input kept as written), enters as an `unknown` marker.
 * The first deploy that meets it reads it as moved (fail closed) and stamps
 * it, so the key then settles on the comparison it had before #7050: its text
 * and input fingerprints, which cover a `Ref` / `Fn::Sub` input. A record with
 * no bound entry (an older record) reads as moved once, the same way.
 */
import { createHash } from 'node:crypto';
import {
  MIN_NEEDLE_LENGTH,
  printingCorpusOf,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import { isRecordedSecretExpression, provenPublicValue } from '../secret-redaction/mask-only.js';
import { dynamicReferenceSpans } from '../secret-redaction/redact-path.js';
import { canonicalJson, maskedPropertyFingerprint, REFERENCE_FINGERPRINT_PREFIX } from './core.js';
import { intrinsicKey, isPlainObject } from './input-walk.js';
import {
  boundReferenceFingerprints,
  maskedPropertyFingerprintsOf,
  maskedPropertyInputFingerprintsOf,
  splitReferenceFingerprint,
} from './records.js';

const REFERENCE_FINGERPRINT_LAYOUT = 2;
const SECRET_SERVICES = ['secretsmanager:', 'ssm-secure:'];

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

/** The plain `ssm` tokens a value spells, and whether an opener's token stays assembled. */
interface SpelledTokens {
  tokens: Set<string>;
  assembled: boolean;
}

/** Adds `text`'s complete plain `ssm` tokens; an opener with no complete token is assembled. */
function scanText(text: string, into: SpelledTokens): void {
  const ends = new Map(dynamicReferenceSpans(text).map(({ start, end }) => [start, end]));
  for (const { at, rest } of dynamicReferenceOpeners(text)) {
    if (!SECRET_SERVICES.some((service) => rest.startsWith(service))) {
      const end = ends.get(at);
      const token = end === undefined ? undefined : text.slice(at, end);
      if (token === undefined || token.includes('${')) into.assembled = true;
      else if (rest.startsWith('ssm:')) into.tokens.add(token);
    }
  }
}

/**
 * The string an input walk's form (`inputForm`) of a pure string function
 * evaluates to, or `undefined` when an operand is no string (an input kept as
 * written, an intrinsic this does not evaluate). The form's `Fn::Sub` is
 * `[text, variables, placeholders]`, each placeholder's input in place.
 */
function evaluatedString(node: unknown): string | undefined {
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (!isPlainObject(node)) return undefined;
  const key = intrinsicKey(node);
  const operand = node[key ?? ''];
  if (!Array.isArray(operand)) return undefined;
  if (key === 'Fn::Join') {
    const [delimiter, list] = operand;
    if (typeof delimiter !== 'string' || !Array.isArray(list)) return undefined;
    const parts = list.map(evaluatedString);
    return parts.every((part) => part !== undefined) ? parts.join(delimiter) : undefined;
  }
  if (key === 'Fn::Select') {
    const [index, list] = operand;
    const at = typeof index === 'number' ? index : Number(evaluatedString(index));
    if (!Array.isArray(list) || !Number.isInteger(at) || at < 0 || at >= list.length) {
      return undefined;
    }
    return evaluatedString(list[at]);
  }
  if (key === 'Fn::Sub' && operand.length === 3) {
    const [text, variables, placeholders] = operand;
    if (typeof text !== 'string' || !isPlainObject(variables) || !isPlainObject(placeholders)) {
      return undefined;
    }
    let failed = false;
    const out = text.replace(/\$\{([^}]*)\}/g, (whole, body: string) => {
      if (body.length === 0) return whole;
      if (body.startsWith('!')) return `\${${body.slice(1)}}`;
      const input = Object.hasOwn(variables, body)
        ? variables[body]
        : Object.hasOwn(placeholders, body)
          ? placeholders[body]
          : undefined;
      const value = evaluatedString(input);
      if (value === undefined) failed = true;
      return value ?? whole;
    });
    return failed ? undefined : out;
  }
  return undefined;
}

/** {@link SpelledTokens} of `value`, evaluating each pure string function `inputForm` kept. */
function spelledTokens(value: unknown, evaluate: boolean): SpelledTokens {
  const into: SpelledTokens = { tokens: new Set(), assembled: false };
  const visit = (node: unknown): void => {
    if (typeof node === 'string') return scanText(node, into);
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isPlainObject(node)) return;
    if (evaluate && intrinsicKey(node) !== undefined) {
      const text = evaluatedString(node);
      if (text !== undefined) return scanText(text, into);
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  return into;
}

/**
 * The `refs-sha256:<hex>` half over the plain `ssm` tokens the key spells and
 * what `referenceOf` knows of each; `null` when it spells none. `form` is the
 * key's input-walk form, read only when the template assembles a token.
 */
async function publicReferenceDigest(
  templateValue: unknown,
  referenceOf: PublicReferenceOf,
  form: (() => Promise<unknown>) | undefined
): Promise<string | null> {
  let spelled = spelledTokens(templateValue, false);
  if (spelled.assembled && form !== undefined) {
    let walked: unknown;
    try {
      walked = await form();
    } catch {
      walked = undefined;
    }
    if (walked !== undefined) spelled = spelledTokens(walked, true);
  }
  if (spelled.tokens.size === 0 && !spelled.assembled) return null;
  const entries: Array<[string, string | { secret: true } | { unknown: true }]> = [];
  for (const token of [...spelled.tokens].sort()) {
    const known = referenceOf(token);
    entries.push([
      token,
      known === undefined ? { unknown: true } : known === 'secret' ? { secret: true } : known.value,
    ]);
  }
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        layout: REFERENCE_FINGERPRINT_LAYOUT,
        references: entries,
        assembled: spelled.assembled,
      })
    )
    .digest('hex');
  return `${REFERENCE_FINGERPRINT_PREFIX}${digest}`;
}

/** What a key's reference fingerprint reads besides its template value: its input walk. */
export interface ReferenceInputs {
  (key: string): Promise<string | undefined>;
  form?(key: string): Promise<unknown>;
}

/**
 * The reference fingerprint of `key`: {@link publicReferenceDigest} bound to
 * the key's input fingerprint (its text fingerprint when there is none);
 * `null` when it spells no plain `ssm` token.
 */
export async function publicReferenceFingerprint(
  key: string,
  templateValue: unknown,
  referenceOf: PublicReferenceOf,
  inputs?: ReferenceInputs
): Promise<string | null> {
  const digest = await publicReferenceDigest(
    templateValue,
    referenceOf,
    inputs?.form && (() => inputs.form!(key))
  );
  if (digest === null) return null;
  let input: string | undefined;
  try {
    input = await inputs?.(key);
  } catch {
    input = undefined;
  }
  return `${digest}+${input ?? maskedPropertyFingerprint(templateValue)}`;
}

/** The reference fingerprints of `keys` a save stamps (a key spelling no `ssm` token is left out). */
export async function maskedReferenceFingerprintsFor(
  keys: readonly string[],
  templateProps: Record<string, unknown>,
  referenceOf: PublicReferenceOf,
  inputs?: ReferenceInputs
): Promise<Record<string, string>> {
  const entries: Array<[string, string]> = [];
  for (const key of keys) {
    if (!Object.hasOwn(templateProps, key)) continue;
    const fingerprint = await publicReferenceFingerprint(
      key,
      templateProps[key],
      referenceOf,
      inputs
    );
    if (fingerprint !== null) entries.push([key, fingerprint]);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * The record's `maskedPropertyReferenceFingerprints`, each kept only while
 * bound to the input fingerprint the record holds for the same key (its text
 * fingerprint when it holds none).
 */
export function maskedPropertyReferenceFingerprintsOf(
  record: unknown
): ReadonlyMap<string, string> {
  if (record === null || typeof record !== 'object') return new Map();
  const field = (record as { maskedPropertyReferenceFingerprints?: unknown })
    .maskedPropertyReferenceFingerprints;
  if (!isPlainObject(field)) return new Map();
  const bound = boundReferenceFingerprints(
    maskedPropertyFingerprintsOf(record),
    maskedPropertyInputFingerprintsOf(record),
    field as Record<string, string>
  );
  return new Map(Object.entries(bound ?? {}));
}

/**
 * Whether a public `ssm` value the key spells moved since `record` was
 * written for `key`: `false` when it spells none, `true` when the record holds
 * no bound entry or its digest differs from today's (an `unknown` marker
 * included: see the module doc). Its text and inputs are compared elsewhere.
 */
export async function publicReferencesMoved(
  record: unknown,
  key: string,
  templateValue: unknown,
  referenceOf: PublicReferenceOf | undefined,
  inputs?: ReferenceInputs
): Promise<boolean> {
  const now = await publicReferenceDigest(
    templateValue,
    referenceOf ?? (() => undefined),
    inputs?.form && (() => inputs.form!(key))
  );
  if (now === null) return false;
  const recorded = maskedPropertyReferenceFingerprintsOf(record).get(key);
  return recorded === undefined || splitReferenceFingerprint(recorded)?.digest !== now;
}
