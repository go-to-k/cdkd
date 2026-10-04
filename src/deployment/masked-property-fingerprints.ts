/**
 * Fingerprints of the UNRESOLVED template expression behind a property that
 * state records as the secret mask (go-to-k/cdkd#4451).
 *
 * A property whose resolved value carries a mask-only needle (the CDK EC2
 * `UserData` shape: `Fn::Base64` over a script embedding a `{{resolve:...}}`
 * reference, go-to-k/cdkd#2759) is persisted as `***`. The mask identifies
 * nothing, so the deploy's no-change skip and the diff compared `***` with
 * `***`, and an edit around the reference, or a retarget of it, was never
 * sent. CloudFormation decides by comparing the unresolved template, so the
 * record keeps, per such property, a hash of the TEMPLATE value it was written
 * from: an edit around the reference moves the hash and the property is
 * updated, while a rotated secret behind an unchanged template does not.
 *
 * WHAT IS HASHED is the template value only, never a resolved one. The
 * template holds a secret as its `{{resolve:...}}` token and a `NoEcho`
 * parameter as its `Ref`, so no plaintext, and nothing derived from one,
 * enters the hash: it is no confirm oracle, unlike a salted hash beside the
 * mask (`.claude/rules/layout-deployment-secrets.md`).
 *
 * COMPATIBILITY. A record with no fingerprint for a masked property (every
 * record an older cdkd wrote) is compared exactly as before. The deploy
 * backfills the field from the template it deploys, the same template the
 * unchanged comparison has just accepted, so the FIRST deploy under this
 * version sends what it sent before, and a later edit is detected.
 */
import { createHash } from 'node:crypto';
import { carriesSecretMask } from './secret-redaction.js';
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

/** `sha256:<hex>` over one property's UNRESOLVED template value. */
export function maskedPropertyFingerprint(templateValue: unknown): string {
  const digest = createHash('sha256')
    .update(canonicalJson({ layout: FINGERPRINT_LAYOUT, value: templateValue }))
    .digest('hex');
  return `sha256:${digest}`;
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
 * The record's fingerprints. A missing field, a non-object, or a non-string
 * entry is no fingerprint, which keeps the pre-#4451 comparison for it.
 */
export function maskedPropertyFingerprintsOf(record: unknown): ReadonlyMap<string, string> {
  const read = new Map<string, string>();
  if (record === null || typeof record !== 'object') return read;
  const field = (record as { maskedPropertyFingerprints?: unknown }).maskedPropertyFingerprints;
  if (field === null || typeof field !== 'object' || Array.isArray(field)) return read;
  for (const [key, value] of Object.entries(field as Record<string, unknown>)) {
    if (typeof value === 'string') read.set(key, value);
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
 * Otherwise `scrubbed` unchanged, carrying whatever field it had.
 */
export function withMaskedPropertyFingerprints(
  scrubbed: ResourceState,
  writtenBag: unknown,
  templateProps: Record<string, unknown> | undefined
): ResourceState {
  if (templateProps === undefined) return scrubbed;
  if (writtenBag === null || typeof writtenBag !== 'object') return scrubbed;
  if (!writtenFromDeployedTemplate.has(writtenBag)) return scrubbed;
  const fingerprints = maskedPropertyFingerprintsFor(scrubbed.properties, templateProps);
  const { maskedPropertyFingerprints: _previous, ...rest } = scrubbed;
  return fingerprints === undefined ? rest : { ...rest, maskedPropertyFingerprints: fingerprints };
}

/**
 * The deploy-start backfill for a record no cdkd version with this field
 * wrote: each masked property gets the fingerprint of today's template value.
 * That asserts AWS holds what today's template describes, which is exactly
 * what the unchanged comparison of this same deploy concludes for it, so this
 * deploy sends what it sent before and the next edit is seen.
 *
 * Only a record with NO field (a malformed one keeps the old comparison and is
 * left alone), whose logical id the template defines with the same type. The
 * RECORD object is replaced, the container updated in place. Returns how many
 * were stamped, so the no-change path knows to save.
 */
export function backfillMaskedPropertyFingerprints(
  resources: Record<string, ResourceState>,
  template: CloudFormationTemplate | undefined
): number {
  const declared = template?.Resources;
  if (declared === undefined || declared === null) return 0;
  let stamped = 0;
  for (const [logicalId, record] of Object.entries(resources)) {
    if (record === null || typeof record !== 'object') continue;
    if ((record as { maskedPropertyFingerprints?: unknown }).maskedPropertyFingerprints !== undefined) {
      continue;
    }
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
    resources[logicalId] = { ...record, maskedPropertyFingerprints: fingerprints };
    stamped++;
  }
  return stamped;
}
