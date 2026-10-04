/**
 * Fingerprints of the UNRESOLVED template expression behind a property that
 * state records as the secret mask (go-to-k/cdkd#4451).
 *
 * A property whose resolved value carries a mask-only needle (the CDK EC2
 * `UserData` shape: `Fn::Base64` over a script embedding a `{{resolve:...}}`
 * reference, go-to-k/cdkd#2759) is persisted as `***`. The mask identifies
 * nothing, so the deploy's no-change skip and the diff compared `***` with
 * `***`, and an edit around the reference, or a retarget of it, was never
 * sent. The record keeps, per such property, a hash of the TEMPLATE value it
 * was written from: an edit around the reference (or a retarget of it) moves
 * the hash and the property is updated, while a rotated secret behind an
 * unchanged template does not, as in CloudFormation. An input that changes
 * WITHOUT the template text changing (a parameter value, a replaced
 * resource's `Ref`, a flipped condition) moves no hash and is still compared
 * as `***` (go-to-k/cdkd#4543).
 *
 * WHAT IS HASHED is the template value only, never a resolved one. The
 * template holds a secret as its `{{resolve:...}}` token and a `NoEcho`
 * parameter as its `Ref`, so nothing the deploy resolved enters the hash: it
 * is no confirm oracle, unlike a salted hash beside the mask
 * (`.claude/rules/layout-deployment-secrets.md`). The one way a secret can
 * still reach it is a template LITERAL equal to a value the same resource
 * resolved as a secret; such a property is refused a hash
 * ({@link REFUSED_FINGERPRINT}) whenever the save holds that resource's
 * needles, and keeps the pre-#4451 comparison.
 *
 * COMPATIBILITY. A record with no fingerprint for a masked property (every
 * record an older cdkd wrote) is compared exactly as before. The deploy
 * backfills the field from the template it deploys, the same template the
 * unchanged comparison has just accepted, so the FIRST deploy under this
 * version sends what it sent before, and a later edit is detected.
 */
import { createHash } from 'node:crypto';
import {
  carriesSecretMask,
  MIN_NEEDLE_LENGTH,
  printingCorpusOf,
  type RecordedSecretValues,
} from './secret-redaction.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { ResourceState } from '../types/state.js';

/** The version of the hash's input layout; a change invalidates every record. */
const FINGERPRINT_LAYOUT = 1;

/**
 * Key-order-free JSON. An `undefined` object member is omitted, as
 * `JSON.stringify` omits it, and an `undefined` array element or root reads as
 * `null`, so a value built in code hashes as its serialized form does.
 */
function canonicalJson(value: unknown): string {
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

const FINGERPRINT_PREFIX = 'sha256:';

/**
 * Whether `templateValue` contains, as text, a needle of `secrets` at or above
 * the needle floor (the plain and the JSON-escaped spelling, since the hash
 * reads the canonical JSON). The printing corpus, so a `NoEcho` parameter's
 * value counts too.
 */
function templateCarriesNeedle(templateValue: unknown, secrets: RecordedSecretValues): boolean {
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

/**
 * The fingerprint of every top-level property whose RECORDED (redacted) value
 * carries the mask, over the template value `templateProps` gives it.
 * `undefined` when there is none, so a record with no masked property carries
 * no field. Built through `Object.fromEntries`, since the keys are
 * template-controlled and a `__proto__` property must stay an own key.
 */
export function maskedPropertyFingerprintsFor(
  recordedProperties: Record<string, unknown>,
  templateProps: Record<string, unknown>
): Record<string, string> | undefined {
  const entries: Array<[string, string]> = [];
  for (const key of Object.keys(recordedProperties)) {
    if (!Object.hasOwn(templateProps, key)) continue;
    if (!carriesSecretMask(recordedProperties[key])) continue;
    entries.push([key, maskedPropertyFingerprint(templateProps[key])]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * The record's fingerprints. A missing field, a non-object, a non-string entry
 * or a {@link REFUSED_FINGERPRINT} is no fingerprint, which keeps the pre-#4451
 * comparison for it.
 */
export function maskedPropertyFingerprintsOf(record: unknown): ReadonlyMap<string, string> {
  const read = new Map<string, string>();
  if (record === null || typeof record !== 'object') return read;
  const field = (record as { maskedPropertyFingerprints?: unknown }).maskedPropertyFingerprints;
  if (field === null || typeof field !== 'object' || Array.isArray(field)) return read;
  for (const [key, value] of Object.entries(field as Record<string, unknown>)) {
    if (typeof value === 'string' && value.startsWith(FINGERPRINT_PREFIX)) read.set(key, value);
  }
  return read;
}

/**
 * The top-level properties the record holds as the mask whose template value
 * moved since it was written: the edits a `***` == `***` comparison cannot
 * see. Only a property the record fingerprinted, still holds masked, and the
 * template still declares counts; anything else the ordinary comparison
 * already decides (an added, removed or unmasked value differs from `***`).
 */
export function movedMaskedProperties(
  record: Pick<ResourceState, 'properties'> & { maskedPropertyFingerprints?: unknown },
  templateProps: Record<string, unknown>
): string[] {
  const recorded = maskedPropertyFingerprintsOf(record);
  if (recorded.size === 0) return [];
  const properties = record.properties as unknown;
  if (properties === null || typeof properties !== 'object') return [];
  const moved: string[] = [];
  for (const [key, fingerprint] of recorded) {
    if (!Object.hasOwn(templateProps, key) || !Object.hasOwn(properties, key)) continue;
    if (!carriesSecretMask((properties as Record<string, unknown>)[key])) continue;
    if (maskedPropertyFingerprint(templateProps[key]) !== fingerprint) moved.push(key);
  }
  return moved;
}

/**
 * The properties bags a deploy WROTE from the template it is deploying (a
 * CREATE, an in-place UPDATE or a replacement, through `propertiesToRecord`).
 * Only such a record's fingerprints may be rebuilt from that template at the
 * save: a record whose provider call failed still holds the PREVIOUS bag, and
 * stamping today's template onto it would skip the retry.
 */
const writtenFromDeployedTemplate = new WeakSet<object>();

/** Marks `bag` as written from the template this deploy resolved. */
export function markWrittenFromDeployedTemplate<T extends object>(bag: T): T {
  writtenFromDeployedTemplate.add(bag);
  return bag;
}

/**
 * The save-time stamp: `scrubbed` (the persisted, redacted record) with its
 * fingerprints rebuilt from `templateProps` when `writtenBag` (the in-memory
 * record's `properties`, before the scrub) was written by this deploy.
 * Otherwise `scrubbed` unchanged, carrying whatever field it had, except
 * that an entry whose template text holds a needle of `secrets` (the
 * resource's own resolution) or of `noEchoParameterValues` (the stack's
 * `NoEcho` parameters) becomes {@link REFUSED_FINGERPRINT}.
 */
export function withMaskedPropertyFingerprints(
  scrubbed: ResourceState,
  writtenBag: unknown,
  templateProps: Record<string, unknown> | undefined,
  secrets?: RecordedSecretValues,
  noEchoParameterValues?: RecordedSecretValues
): ResourceState {
  if (templateProps === undefined) return scrubbed;
  const corpora = [secrets, noEchoParameterValues].filter(
    (corpus): corpus is RecordedSecretValues => corpus !== undefined
  );
  const written =
    writtenBag !== null &&
    typeof writtenBag === 'object' &&
    writtenFromDeployedTemplate.has(writtenBag);
  const { maskedPropertyFingerprints: previous, ...rest } = scrubbed;
  let fingerprints: Record<string, string> | undefined;
  if (written) {
    fingerprints = maskedPropertyFingerprintsFor(scrubbed.properties, templateProps);
  } else {
    // Carried as it was, except that this save may hold the needles a
    // backfill or an earlier save could not see.
    if (previous === undefined || previous === null || typeof previous !== 'object') {
      return scrubbed;
    }
    if (corpora.length === 0) return scrubbed;
    fingerprints = { ...(previous as Record<string, string>) };
  }
  if (fingerprints !== undefined && corpora.length > 0) {
    const refused = Object.keys(fingerprints).filter(
      (key) =>
        Object.hasOwn(templateProps, key) &&
        corpora.some((corpus) => templateCarriesNeedle(templateProps[key], corpus))
    );
    if (refused.length > 0) {
      fingerprints = Object.fromEntries(
        Object.entries(fingerprints).map(([key, value]) => [
          key,
          refused.includes(key) ? REFUSED_FINGERPRINT : value,
        ])
      );
    }
  }
  if (!written && JSON.stringify(fingerprints) === JSON.stringify(previous)) return scrubbed;
  return fingerprints === undefined ? rest : { ...rest, maskedPropertyFingerprints: fingerprints };
}

/**
 * The deploy-start backfill: each masked property with NO entry (every
 * property of a record an older cdkd wrote, or one a later writer such as
 * `cdkd scrub` masked after the record was stamped) gets the fingerprint of
 * today's template value. That asserts AWS holds what today's template
 * describes, which is exactly what the unchanged comparison of this same
 * deploy concludes for it, so this deploy sends what it sent before and the
 * next edit is seen. An existing entry, a {@link REFUSED_FINGERPRINT}
 * included, is kept. A property whose template text holds a `NoEcho`
 * parameter's value (`noEchoParameterValues`, known before anything resolves)
 * gets {@link REFUSED_FINGERPRINT}; one holding a value only a resolution
 * yields is checked by the first save that holds that resource's needles.
 *
 * Only a record whose field is absent or a plain object (a malformed one keeps
 * the old comparison and is left alone), whose logical id the template defines
 * with the same type. The RECORD object is replaced, the container updated in
 * place. Returns how many were stamped, so the no-change path knows to save.
 */
export function backfillMaskedPropertyFingerprints(
  resources: Record<string, ResourceState>,
  template: CloudFormationTemplate | undefined,
  noEchoParameterValues?: RecordedSecretValues
): number {
  const declared = template?.Resources;
  if (declared === undefined || declared === null) return 0;
  let stamped = 0;
  for (const [logicalId, record] of Object.entries(resources)) {
    if (record === null || typeof record !== 'object') continue;
    const field = (record as { maskedPropertyFingerprints?: unknown }).maskedPropertyFingerprints;
    if (
      field !== undefined &&
      (field === null || typeof field !== 'object' || Array.isArray(field))
    ) {
      continue;
    }
    const existing = (field ?? {}) as Record<string, unknown>;
    if (!Object.hasOwn(declared, logicalId)) continue;
    const definition = declared[logicalId];
    if (definition === undefined || definition.Type !== record.resourceType) continue;
    const properties = record.properties as unknown;
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
      continue;
    }
    const fingerprints = maskedPropertyFingerprintsFor(
      properties as Record<string, unknown>,
      definition.Properties ?? {}
    );
    if (fingerprints === undefined) continue;
    const templateProps = definition.Properties ?? {};
    const added = Object.entries(fingerprints)
      .filter(([key]) => !Object.hasOwn(existing, key))
      .map(([key, value]): [string, string] =>
        noEchoParameterValues !== undefined &&
        templateCarriesNeedle(templateProps[key], noEchoParameterValues)
          ? [key, REFUSED_FINGERPRINT]
          : [key, value]
      );
    if (added.length === 0) continue;
    resources[logicalId] = {
      ...record,
      maskedPropertyFingerprints: Object.fromEntries([
        ...Object.entries(existing),
        ...added,
      ]) as Record<string, string>,
    };
    stamped++;
  }
  return stamped;
}
