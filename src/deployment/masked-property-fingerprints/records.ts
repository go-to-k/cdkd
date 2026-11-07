/**
 * The record side: reading, comparing, stamping and backfilling the
 * fingerprint fields of a state record; split out of
 * `masked-property-fingerprints.ts` (#5835).
 */
import {
  carriesSecretMask,
  MIN_NEEDLE_LENGTH,
  printingCorpusOf,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceState } from '../../types/state.js';
import {
  canonicalJson,
  FINGERPRINT_PREFIX,
  INPUT_FINGERPRINT_PREFIX,
  maskedPropertyFingerprint,
  REFUSED_FINGERPRINT,
  splitInputFingerprint,
  templateCarriesNeedle,
} from './core.js';
import { isPlainObject, type MaskedInputSources } from './input-walk.js';
import { maskedInputFingerprint } from './nested-outputs.js';

/**
 * One property's input fingerprint by key, computed at most once per key. A
 * resolution that throws reads as `undefined`, never as a failed deploy: the
 * fingerprint only decides whether a masked property is re-sent.
 */
export type InputFingerprinter = (key: string) => Promise<string | undefined>;

export function inputFingerprinter(
  templateProps: Record<string, unknown>,
  sources: MaskedInputSources
): InputFingerprinter {
  const memo = new Map<string, Promise<string | undefined>>();
  return (key) => {
    let pending = memo.get(key);
    if (pending === undefined) {
      pending = Object.hasOwn(templateProps, key)
        ? maskedInputFingerprint(templateProps[key], sources).catch(() => undefined)
        : Promise.resolve(undefined);
      memo.set(key, pending);
    }
    return pending;
  };
}

/**
 * The top-level keys of a RESOLVED bag that the save may record as the mask:
 * each whose value holds the mask, a needle of `corpora` at or above the
 * needle floor, or a shorter needle as a WHOLE leaf (a superset of what the
 * save masks, which takes a sub-floor needle only whole; a key the save does
 * not mask is never stamped). A nested child with a short parent secret would
 * otherwise fingerprint nearly every key.
 */
export function possiblyMaskedKeys(
  resolvedProps: Record<string, unknown>,
  corpora: ReadonlyArray<RecordedSecretValues | undefined>
): string[] {
  const needles = new Set<string>();
  for (const corpus of corpora) {
    if (corpus === undefined) continue;
    for (const needle of printingCorpusOf(corpus).keys())
      if (needle.length > 0) needles.add(needle);
  }
  const short = [...needles].filter((needle) => needle.length < MIN_NEEDLE_LENGTH);
  const long = [...needles].filter((needle) => needle.length >= MIN_NEEDLE_LENGTH);
  const wholeShortLeaf = (value: unknown): boolean => {
    if (typeof value === 'string') return short.includes(value);
    if (Array.isArray(value)) return value.some(wholeShortLeaf);
    if (isPlainObject(value)) return Object.values(value).some(wholeShortLeaf);
    return false;
  };
  return Object.keys(resolvedProps).filter((key) => {
    const value = resolvedProps[key];
    if (carriesSecretMask(value) || wholeShortLeaf(value)) return true;
    const text = canonicalJson(value);
    return long.some(
      (needle) => text.includes(needle) || text.includes(JSON.stringify(needle).slice(1, -1))
    );
  });
}

/**
 * The input fingerprints of `keys` (what the save stamps on a record this
 * deploy writes); a key whose fingerprint is unknown is left out, and the
 * save stamps its text fingerprint alone.
 */
export async function maskedInputFingerprintsFor(
  keys: readonly string[],
  fingerprinter: InputFingerprinter
): Promise<Record<string, string>> {
  const entries: Array<[string, string]> = [];
  for (const key of keys) {
    const fingerprint = await fingerprinter(key);
    if (fingerprint !== undefined) entries.push([key, fingerprint]);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * The text fingerprint (`sha256:`, go-to-k/cdkd#4451) of every top-level
 * property whose RECORDED (redacted) value carries the mask, over the template
 * value `templateProps` gives it. `undefined` when there is none, so a record
 * with no masked property carries no field. Built through `Object.fromEntries`,
 * since the keys are template-controlled and a `__proto__` property must stay
 * an own key.
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
 * The record's text fingerprints (`maskedPropertyFingerprints`). A missing
 * field, a non-object, a non-string entry, an unknown prefix or a
 * {@link REFUSED_FINGERPRINT} is no fingerprint, which keeps the pre-#4451
 * comparison for it. Exactly what #4451's reader accepts.
 */
export function maskedPropertyFingerprintsOf(record: unknown): ReadonlyMap<string, string> {
  const read = new Map<string, string>();
  if (record === null || typeof record !== 'object') return read;
  const field = (record as { maskedPropertyFingerprints?: unknown }).maskedPropertyFingerprints;
  if (!isPlainObject(field)) return read;
  for (const [key, value] of Object.entries(field)) {
    if (typeof value === 'string' && value.startsWith(FINGERPRINT_PREFIX)) read.set(key, value);
  }
  return read;
}

/**
 * The record's input fingerprints (`maskedPropertyInputFingerprints`,
 * go-to-k/cdkd#4543), each kept only while it is BOUND to the text fingerprint
 * the record holds for the same property: its text half must equal that
 * entry. An older cdkd rewrites the text field and carries this one untouched,
 * so an entry whose text half no longer matches describes a previous
 * generation and reads as absent (re-baselined, never compared).
 */
export function maskedPropertyInputFingerprintsOf(record: unknown): ReadonlyMap<string, string> {
  const read = new Map<string, string>();
  if (record === null || typeof record !== 'object') return read;
  const field = (record as { maskedPropertyInputFingerprints?: unknown })
    .maskedPropertyInputFingerprints;
  if (!isPlainObject(field)) return read;
  const text = maskedPropertyFingerprintsOf(record);
  for (const [key, value] of Object.entries(field)) {
    if (typeof value !== 'string' || !value.startsWith(INPUT_FINGERPRINT_PREFIX)) continue;
    const half = splitInputFingerprint(value).text;
    if (half !== undefined && text.get(key) === half) read.set(key, value);
  }
  return read;
}

/**
 * The input fingerprints a save stamps: one per property the text field holds
 * (an unrefused `sha256:` entry) for which the deploy computed one bound to
 * that same text. `undefined` when there is none.
 */
function boundInputFingerprints(
  textFingerprints: Readonly<Record<string, string>> | undefined,
  inputFingerprints: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined {
  if (textFingerprints === undefined || inputFingerprints === undefined) return undefined;
  const entries: Array<[string, string]> = [];
  for (const [key, text] of Object.entries(textFingerprints)) {
    if (!text.startsWith(FINGERPRINT_PREFIX) || !Object.hasOwn(inputFingerprints, key)) continue;
    const input = inputFingerprints[key]!;
    if (splitInputFingerprint(input).text === text) entries.push([key, input]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * The top-level properties the record holds as the mask whose template value
 * or resolved inputs moved since it was written: the changes a `***` == `***`
 * comparison cannot see. Only a property the record fingerprinted, still
 * holds masked, and the template still declares counts; anything else the
 * ordinary comparison already decides (an added, removed or unmasked value
 * differs from `***`).
 *
 * The text fingerprint is compared first, as #4451 compared it. When the text
 * is unchanged, a bound input fingerprint is compared with what `fingerprinter`
 * computes; with no fingerprinter, or an input unknown on this side, the
 * property reads as unmoved. A property with NO bound input fingerprint (a
 * record #4451 wrote, or one an older cdkd rewrote since) is reported to
 * `onRebaseline` with today's input fingerprint, which the deploy stamps
 * without sending.
 */
export async function movedMaskedProperties(
  record: Pick<ResourceState, 'properties'> & {
    maskedPropertyFingerprints?: unknown;
    maskedPropertyInputFingerprints?: unknown;
  },
  templateProps: Record<string, unknown>,
  fingerprinter?: InputFingerprinter,
  onRebaseline?: (key: string, fingerprint: string) => void
): Promise<string[]> {
  const recorded = maskedPropertyFingerprintsOf(record);
  if (recorded.size === 0) return [];
  const properties = record.properties as unknown;
  if (properties === null || typeof properties !== 'object') return [];
  const inputs = maskedPropertyInputFingerprintsOf(record);
  const moved: string[] = [];
  for (const [key, fingerprint] of recorded) {
    if (!Object.hasOwn(templateProps, key) || !Object.hasOwn(properties, key)) continue;
    if (!carriesSecretMask((properties as Record<string, unknown>)[key])) continue;
    if (maskedPropertyFingerprint(templateProps[key]) !== fingerprint) {
      moved.push(key);
      continue;
    }
    if (fingerprinter === undefined) continue;
    const bound = inputs.get(key);
    if (bound === undefined && onRebaseline === undefined) continue;
    const now = await fingerprinter(key);
    if (now === undefined) continue;
    if (bound !== undefined) {
      if (splitInputFingerprint(now).input !== splitInputFingerprint(bound).input) moved.push(key);
    } else {
      onRebaseline!(key, now);
    }
  }
  return moved;
}

/**
 * `record` with `fingerprints` written into its input field (a new record
 * object; the bag it came from is not touched), each only while it is bound to
 * the text fingerprint the record holds for that property.
 */
export function withRebaselinedFingerprints<T extends object>(
  record: T,
  fingerprints: Readonly<Record<string, string>>
): T {
  const text = maskedPropertyFingerprintsOf(record);
  const field = (record as { maskedPropertyInputFingerprints?: unknown })
    .maskedPropertyInputFingerprints;
  const next: Array<[string, unknown]> = isPlainObject(field) ? Object.entries(field) : [];
  let changed = false;
  for (const [key, value] of Object.entries(fingerprints)) {
    if (text.get(key) !== splitInputFingerprint(value).text) continue;
    const at = next.findIndex(([k]) => k === key);
    if (at >= 0) next[at] = [key, value];
    else next.push([key, value]);
    changed = true;
  }
  return changed
    ? { ...record, maskedPropertyInputFingerprints: Object.fromEntries(next) }
    : record;
}

/**
 * The properties bags a deploy WROTE from the template it is deploying (a
 * CREATE, an in-place UPDATE or a replacement, through `propertiesToRecord`).
 * Only such a record's fingerprints may be rebuilt from that template at the
 * save: a record whose provider call failed still holds the PREVIOUS bag, and
 * stamping today's template onto it would skip the retry.
 */
const writtenFromDeployedTemplate = new WeakSet<object>();

/** Whether `bag` was written from the template this deploy resolved. */
export function isWrittenFromDeployedTemplate(bag: unknown): boolean {
  return bag !== null && typeof bag === 'object' && writtenFromDeployedTemplate.has(bag);
}

/** Marks `bag` as written from the template this deploy resolved. */
export function markWrittenFromDeployedTemplate<T extends object>(bag: T): T {
  writtenFromDeployedTemplate.add(bag);
  return bag;
}

/**
 * The save-time stamp: `scrubbed` (the persisted, redacted record) with its
 * fingerprints rebuilt from `templateProps` when `writtenBag` (the in-memory
 * record's `properties`, before the scrub) was written by this deploy.
 * Otherwise `scrubbed` unchanged, carrying whatever fields it had, except
 * that an entry whose template text holds a needle of `secrets` (the
 * resource's own resolution) or of `noEchoParameterValues` (the stack's
 * `NoEcho` parameters) becomes {@link REFUSED_FINGERPRINT} and loses its input
 * fingerprint. `inputFingerprints` are the input fingerprints the deploy
 * computed when it resolved the resource (go-to-k/cdkd#4543); each is stamped
 * only while bound to the text fingerprint stamped beside it.
 */
export function withMaskedPropertyFingerprints(
  scrubbed: ResourceState,
  writtenBag: unknown,
  templateProps: Record<string, unknown> | undefined,
  secrets?: RecordedSecretValues,
  noEchoParameterValues?: RecordedSecretValues,
  inputFingerprints?: Readonly<Record<string, string>>
): ResourceState {
  if (templateProps === undefined) return scrubbed;
  const corpora = [secrets, noEchoParameterValues].filter(
    (corpus): corpus is RecordedSecretValues => corpus !== undefined
  );
  const written =
    writtenBag !== null &&
    typeof writtenBag === 'object' &&
    writtenFromDeployedTemplate.has(writtenBag);
  const {
    maskedPropertyFingerprints: previous,
    maskedPropertyInputFingerprints: previousInputs,
    ...rest
  } = scrubbed;
  let fingerprints: Record<string, string> | undefined;
  let inputs: Record<string, string> | undefined;
  if (written) {
    fingerprints = maskedPropertyFingerprintsFor(scrubbed.properties, templateProps);
    inputs = boundInputFingerprints(fingerprints, inputFingerprints);
  } else {
    // Carried as it was, except that this save may hold the needles a
    // backfill or an earlier save could not see.
    if (!isPlainObject(previous)) return scrubbed;
    if (corpora.length === 0) return scrubbed;
    fingerprints = { ...(previous as Record<string, string>) };
    inputs = isPlainObject(previousInputs)
      ? { ...(previousInputs as Record<string, string>) }
      : undefined;
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
      // A refused property's input fingerprint hashes the same template text.
      if (inputs !== undefined) {
        const kept = Object.entries(inputs).filter(([key]) => !refused.includes(key));
        inputs = kept.length > 0 ? Object.fromEntries(kept) : undefined;
      }
    }
  }
  if (
    !written &&
    JSON.stringify(fingerprints) === JSON.stringify(previous) &&
    JSON.stringify(inputs) === JSON.stringify(previousInputs)
  ) {
    return scrubbed;
  }
  return {
    ...rest,
    ...(fingerprints !== undefined && { maskedPropertyFingerprints: fingerprints }),
    ...(inputs !== undefined && { maskedPropertyInputFingerprints: inputs }),
  };
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
