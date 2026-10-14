/**
 * PERSISTED reference provenance (state schema v12, go-to-k/cdkd#4847 /
 * go-to-k/cdkd#4852): validation of `ResourceState.referenceProvenance` /
 * `StackState.outputReferenceProvenance` on read, and the persist writer's
 * computation of both from a pass's entries
 * (`secret-redaction/reference-provenance.ts`).
 *
 * EVERY reader goes through {@link referenceProvenanceOf} /
 * {@link recordedProvenanceOf} / {@link outputReferenceProvenanceOf}: a
 * malformed field reads as absent, and absent keeps the v11 path. Reads use
 * `Object.hasOwn` throughout, since the keys are template-derived tokens.
 */
import type { ReferenceProvenance, ResourceState, StackState } from '../types/state.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import { isClientSafeRegion } from './intrinsic-resolver/account-drain.js';
import {
  MAX_REFERENCE_VERSIONS,
  hasPassProvenance,
  passProvenanceFor,
} from './secret-redaction/reference-provenance.js';
import type { RecordedSecretValues } from './secret-redaction/pairs.js';
import { dynamicReferenceTokens } from './secret-redaction/redact-path.js';
import { isSingleDynamicReferenceToken } from './secret-redaction/rules.js';

/** SSM parameter `Version`: a positive integer. */
const SSM_VERSION = /^[0-9]{1,10}$/;
/** Secrets Manager `VersionId`: a UUID, or a caller-chosen `ClientRequestToken`. */
const SECRETS_MANAGER_VERSION = /^[A-Za-z0-9_+=.@/-]{32,64}$/;

/** Every whole `{{resolve:...}}` token in `value`'s string leaves, into `into`. */
export function referenceTokensIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (!v.includes('{{resolve:')) return;
      for (const token of dynamicReferenceTokens(v)) into.add(token);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const item of Object.values(v as Record<string, unknown>)) walk(item);
    }
  };
  walk(value);
  return into;
}

/** The tokens a resource record holds in `properties`, `attributes` and `observedProperties`. */
export function recordReferenceTokens(record: {
  properties?: unknown;
  attributes?: unknown;
  observedProperties?: unknown;
}): Set<string> {
  const tokens = referenceTokensIn(record.properties);
  referenceTokensIn(record.attributes, tokens);
  referenceTokensIn(record.observedProperties, tokens);
  return tokens;
}

/** The version shape `token`'s service uses, or `undefined` for a service cdkd does not version. */
function versionShapeOf(token: string): RegExp | undefined {
  if (token.startsWith('{{resolve:secretsmanager:')) return SECRETS_MANAGER_VERSION;
  if (token.startsWith('{{resolve:ssm:') || token.startsWith('{{resolve:ssm-secure:')) {
    return SSM_VERSION;
  }
  return undefined;
}

/** Is `version` a version id of `token`'s service? */
export function isValidReferenceVersion(token: string, version: unknown): version is string {
  const shape = versionShapeOf(token);
  return shape !== undefined && typeof version === 'string' && shape.test(version);
}

/** A canonical, client-safe region, or `undefined`. A shape check only (design decision 12). */
export function validReferenceRegion(region: unknown): string | undefined {
  if (typeof region !== 'string') return undefined;
  return canonicalizeRegion(region) === region && isClientSafeRegion(region) ? region : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One entry, validated, or `undefined` when it is malformed:
 *
 * - not an object, or `readVersions` not a subset of `versions` (an absent
 *   `versions` counts as empty): the whole entry reads as absent;
 * - a `region` that is not canonical and client-safe: `region` is absent;
 * - `versions` that are not 1..8 version ids of the token's service, or a
 *   `readVersions` that is not an array of strings: the VERSION arm
 *   (`versions` and `readVersions`) is absent and `region` is kept.
 *
 * Returns a fresh, sorted, deduplicated copy; never the input.
 */
export function validateReferenceProvenance(
  token: string,
  raw: unknown
): ReferenceProvenance | undefined {
  if (!isSingleDynamicReferenceToken(token) || !isPlainObject(raw)) return undefined;
  const versionsRaw = Object.hasOwn(raw, 'versions') ? raw['versions'] : undefined;
  const readRaw = Object.hasOwn(raw, 'readVersions') ? raw['readVersions'] : undefined;
  if (readRaw !== undefined) {
    if (!Array.isArray(readRaw)) return undefined;
    const all = Array.isArray(versionsRaw) ? versionsRaw : [];
    if (!readRaw.every((v) => all.includes(v))) return undefined;
  }
  const out: ReferenceProvenance = {};
  const region = validReferenceRegion(Object.hasOwn(raw, 'region') ? raw['region'] : undefined);
  if (region !== undefined) out.region = region;
  if (
    Array.isArray(versionsRaw) &&
    versionsRaw.length > 0 &&
    versionsRaw.length <= MAX_REFERENCE_VERSIONS &&
    versionsRaw.every((v) => isValidReferenceVersion(token, v)) &&
    (readRaw === undefined || readRaw.every((v) => typeof v === 'string'))
  ) {
    out.versions = [...new Set(versionsRaw as string[])].sort();
    if (readRaw !== undefined && readRaw.length > 0) {
      out.readVersions = [...new Set(readRaw as string[])].sort();
    }
  }
  return out;
}

/**
 * The validated `referenceProvenance` of `record`, or `undefined` when the
 * record has none or it is not an object (absent: the v11 path). Malformed
 * entries are dropped; a valid `{}` stays `{}`.
 */
export function referenceProvenanceOf(
  record: unknown
): Record<string, ReferenceProvenance> | undefined {
  if (!isPlainObject(record) || !Object.hasOwn(record, 'referenceProvenance')) return undefined;
  return validatedBag(record['referenceProvenance']);
}

function validatedBag(field: unknown): Record<string, ReferenceProvenance> | undefined {
  if (!isPlainObject(field)) return undefined;
  const out: Record<string, ReferenceProvenance> = Object.create(null) as Record<
    string,
    ReferenceProvenance
  >;
  for (const [token, raw] of Object.entries(field)) {
    const entry = validateReferenceProvenance(token, raw);
    if (entry !== undefined) out[token] = entry;
  }
  return { ...out };
}

/** The validated entry `record` holds for `token`, or `undefined` (not known). */
export function recordedProvenanceOf(
  record: unknown,
  token: string
): ReferenceProvenance | undefined {
  if (!isPlainObject(record) || !Object.hasOwn(record, 'referenceProvenance')) return undefined;
  const field = record['referenceProvenance'];
  if (!isPlainObject(field) || !Object.hasOwn(field, token)) return undefined;
  return validateReferenceProvenance(token, field[token]);
}

/**
 * The region `record`'s provenance gives each token, validated (go-to-k/cdkd#4847):
 * what the rollback replay, `cdkd drift` and `cdkd scrub` resolve a recorded
 * token in. `undefined` when no token has one, so a record without the field
 * costs nothing.
 */
export function recordedReferenceRegions(record: unknown): ReadonlyMap<string, string> | undefined {
  const field = referenceProvenanceOf(record);
  return field === undefined ? undefined : regionsOf(field);
}

/** {@link recordedReferenceRegions} for output `outputKey` of `state`. */
export function recordedOutputReferenceRegions(
  state: unknown,
  outputKey: string
): ReadonlyMap<string, string> | undefined {
  const field = outputReferenceProvenanceOf(state, outputKey);
  return field === undefined ? undefined : regionsOf(field);
}

function regionsOf(
  field: Record<string, ReferenceProvenance>
): ReadonlyMap<string, string> | undefined {
  let out: Map<string, string> | undefined;
  for (const [token, entry] of Object.entries(field)) {
    if (entry.region === undefined) continue;
    (out ??= new Map()).set(token, entry.region);
  }
  return out;
}

/**
 * `record` with its `referenceProvenance` keys cut to the tokens it still
 * holds (go-to-k/cdkd#4847): `cdkd scrub` rewrites a record onto today's
 * template, which can drop a token. Never adds a key: a token the record
 * gained has no entry, as scrub resolves nothing it could attribute.
 */
export function keepHeldTokenProvenance<T extends ResourceState>(record: T): T {
  if (!hasReferenceProvenanceField(record)) return record;
  const field = record.referenceProvenance as unknown;
  if (!isPlainObject(field)) return record;
  const held = recordReferenceTokens(record);
  const keys = Object.keys(field);
  if (keys.every((token) => held.has(token))) return record;
  const kept: Record<string, ReferenceProvenance> = {};
  for (const token of keys) {
    if (held.has(token)) kept[token] = field[token] as ReferenceProvenance;
  }
  return { ...record, referenceProvenance: kept };
}

/** Does `record` carry the field at all (`{}` included)? What the migration capture skips on. */
export function hasReferenceProvenanceField(record: unknown): boolean {
  return (
    isPlainObject(record) &&
    Object.hasOwn(record, 'referenceProvenance') &&
    record['referenceProvenance'] !== undefined
  );
}

/** The validated provenance of output `outputKey`'s tokens, or `undefined` (not known). */
export function outputReferenceProvenanceOf(
  state: unknown,
  outputKey: string
): Record<string, ReferenceProvenance> | undefined {
  if (!isPlainObject(state) || !Object.hasOwn(state, 'outputReferenceProvenance')) {
    return undefined;
  }
  const field = state['outputReferenceProvenance'];
  if (!isPlainObject(field) || !Object.hasOwn(field, outputKey)) return undefined;
  return validatedBag(field[outputKey]);
}

/**
 * A pass entry as the writer persists it: the same validation a reader
 * applies, so the writer never stores what a reader would refuse.
 */
function persistable(token: string, entry: ReferenceProvenance | undefined): ReferenceProvenance {
  return (entry === undefined ? undefined : validateReferenceProvenance(token, entry)) ?? {};
}

/**
 * How the writer treats a record that was UPDATED IN PLACE: the same resource,
 * so a create-only path kept what AWS held before.
 */
export interface InPlaceWrite {
  /** The type's create-only paths, or `'all'` when they are not known. */
  createOnly: ReadonlyArray<readonly string[]> | 'all';
  /** The record's `attributes` are the previous record's, carried unread. */
  attributesCarried: boolean;
}

/** The tokens under any of `paths` in `properties` (`*` and array levels descend every element). */
function tokensUnderPaths(
  properties: unknown,
  paths: ReadonlyArray<readonly string[]>
): Set<string> {
  const out = new Set<string>();
  const descend = (value: unknown, path: readonly string[], at: number): void => {
    if (at === path.length) {
      referenceTokensIn(value, out);
      return;
    }
    if (Array.isArray(value)) {
      // Conservative: an array level takes every element, whatever the segment.
      const next = path[at] === '*' ? at + 1 : at;
      for (const item of value) descend(item, path, next);
      return;
    }
    if (isPlainObject(value) && Object.hasOwn(value, path[at]!)) {
      descend(value[path[at]!], path, at + 1);
    }
  };
  for (const path of paths) descend(properties, path, 0);
  return out;
}

/**
 * The `referenceProvenance` a record this pass WROTE persists, or `undefined`
 * to persist none (it holds no token).
 *
 * A token takes this pass's entry, or `{}` when the pass recorded nothing for
 * it. On an in-place update, a token with ANY occurrence under a create-only
 * path (any token when those paths are unknown), or in attributes carried
 * from the previous record, takes the UNION rule, because AWS kept the old
 * value there while a mutable leaf may have moved:
 *
 * - `versions` = previous ∪ pass, at most {@link MAX_REFERENCE_VERSIONS}
 *   (beyond it, or when either side is not known, the version arm is
 *   dropped);
 * - `readVersions` = pass, so `⊆` still holds and nothing is promoted forever;
 * - `region` kept unless the two sides name DIFFERENT ones;
 * - a token this pass did not resolve keeps its previous entry.
 *
 * O(1) when the pass recorded no provenance, the previous record had none and
 * `walkWithoutPassProvenance` is off.
 */
export function provenanceForWrittenRecord(args: {
  /** The record as it will persist (scrubbed). */
  record: { properties?: unknown; attributes?: unknown; observedProperties?: unknown };
  secrets: RecordedSecretValues | undefined;
  previous: ResourceState | undefined;
  inPlace: InPlaceWrite | undefined;
  /**
   * Walk the record for tokens even when this pass recorded no provenance, so
   * a token it holds unattributed is keyed `{}` (known) rather than left
   * absent for the migration capture to retry. Off for a stack loaded off the
   * token-free fast path, which keeps the writer O(1) there.
   */
  walkWithoutPassProvenance?: boolean;
}): Record<string, ReferenceProvenance> | undefined {
  const { record, secrets, previous, inPlace } = args;
  const previousField = inPlace === undefined ? undefined : referenceProvenanceOf(previous);
  if (
    !hasPassProvenance(secrets) &&
    previousField === undefined &&
    args.walkWithoutPassProvenance !== true
  ) {
    return undefined;
  }
  const tokens = recordReferenceTokens(record);
  if (tokens.size === 0) return undefined;
  let kept: Set<string> | undefined;
  if (inPlace !== undefined) {
    kept =
      inPlace.createOnly === 'all'
        ? tokens
        : tokensUnderPaths(record.properties, inPlace.createOnly);
    if (inPlace.attributesCarried) referenceTokensIn(record.attributes, kept);
  }
  const out: Record<string, ReferenceProvenance> = {};
  for (const token of [...tokens].sort()) {
    const pass = passProvenanceFor(secrets, token);
    if (kept === undefined || !kept.has(token)) {
      out[token] = persistable(token, pass);
      continue;
    }
    const before =
      previousField !== undefined && Object.hasOwn(previousField, token)
        ? previousField[token]
        : undefined;
    if (pass === undefined) {
      out[token] = before === undefined ? {} : { ...before };
      continue;
    }
    out[token] = persistable(token, unionWithPrevious(pass, before));
  }
  return out;
}

function unionWithPrevious(
  pass: ReferenceProvenance,
  before: ReferenceProvenance | undefined
): ReferenceProvenance {
  const out: ReferenceProvenance = {};
  // Region: two DIFFERENT regions are a conflict. An unknown previous region
  // is not one: the token's spelling and the stack decide its region, and
  // neither changed without changing the property.
  if (
    pass.region !== undefined &&
    (before?.region === undefined || before.region === pass.region)
  ) {
    out.region = pass.region;
  }
  // Versions: the union with an UNKNOWN previous set is unknown.
  // Beyond the cap the caller's validation drops the version arm.
  if (pass.versions !== undefined && before?.versions !== undefined) {
    out.versions = [...new Set([...before.versions, ...pass.versions])].sort();
    if (pass.readVersions !== undefined) out.readVersions = [...pass.readVersions];
  }
  return out;
}

/**
 * The `outputReferenceProvenance` a save persists for `outputs` (the bag as
 * it will persist, redacted):
 *
 * - a bag THIS deploy resolved: per key, each token's entry from that key's
 *   own sink (`{}` for a token the sink lacks); a key holding no token, or
 *   whose sink recorded nothing, is omitted;
 * - the previous record's bag, carried whole: its field verbatim;
 * - anything else (a merge of this pass's values with carried ones): none.
 *
 * `undefined` persists no field (also when no key holds a token).
 */
export function outputProvenanceForPersist(args: {
  outputs: Record<string, unknown>;
  resolvedThisRun: boolean;
  carriedFrom: Pick<StackState, 'outputs' | 'outputReferenceProvenance'> | undefined;
  sinkOf: (outputKey: string) => RecordedSecretValues | undefined;
}): Record<string, Record<string, ReferenceProvenance>> | undefined {
  const { outputs, resolvedThisRun, carriedFrom, sinkOf } = args;
  if (!resolvedThisRun) {
    return carriedFrom !== undefined && isPlainObject(carriedFrom.outputReferenceProvenance)
      ? carriedFrom.outputReferenceProvenance
      : undefined;
  }
  let out: Record<string, Record<string, ReferenceProvenance>> | undefined;
  for (const [outputKey, value] of Object.entries(outputs)) {
    // A key whose resolution recorded nothing is not walked: O(keys) for a
    // token-free stack. A token such a key holds stays "not known".
    const sink = sinkOf(outputKey);
    if (!hasPassProvenance(sink)) continue;
    const tokens = referenceTokensIn(value);
    if (tokens.size === 0) continue;
    const entries: Record<string, ReferenceProvenance> = {};
    for (const token of [...tokens].sort()) {
      entries[token] = persistable(token, passProvenanceFor(sink, token));
    }
    // Null-prototype: an `Export.Name` alias key is template text.
    out ??= Object.create(null) as Record<string, Record<string, ReferenceProvenance>>;
    out[outputKey] = entries;
  }
  return out === undefined ? undefined : { ...out };
}

/** "Leave the record's own `referenceProvenance` as it is" (a record this deploy did not write). */
export const KEEP_REFERENCE_PROVENANCE: unique symbol = Symbol('keep reference provenance');

/**
 * `record` with `field` as its `referenceProvenance`: unchanged for
 * {@link KEEP_REFERENCE_PROVENANCE}, the field removed for `undefined`.
 */
export function withReferenceProvenance(
  record: ResourceState,
  field: Record<string, ReferenceProvenance> | undefined | typeof KEEP_REFERENCE_PROVENANCE
): ResourceState {
  if (field === KEEP_REFERENCE_PROVENANCE) return record;
  if (field === undefined && !Object.hasOwn(record, 'referenceProvenance')) return record;
  const { referenceProvenance: _previous, ...rest } = record;
  return field === undefined ? rest : { ...rest, referenceProvenance: field };
}
