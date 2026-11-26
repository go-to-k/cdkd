/**
 * go-to-k/cdkd#7015: a recorded attribute the record ITSELF contradicts.
 *
 * Before go-to-k/cdkd#7006, an in-place `AWS::RDS::DBInstance` update changing
 * `Port`, `CACertificateIdentifier` or `MultiAZ` (and an
 * `AWS::Neptune::DBCluster` update changing `DBPort`) recorded the attributes
 * from the read taken right after the modify call, which still reports the OLD
 * value. A deploy that does not update the resource re-reads nothing, and the
 * resolver serves a PRESENT recorded attribute without asking the
 * stale-attribute heal (which runs on a miss), so a reader added later
 * resolved the old port.
 *
 * The stale shape is detected from the record alone (no AWS call on an
 * ordinary deploy): the recorded property disagrees with the recorded
 * attribute that reports it. Only such a record is re-read, through the #1852
 * heal, and only for an attribute the disagreement can make stale. CloudFormation
 * re-reads on every update and so serves what AWS reports; the heal serves
 * that same read, never a value derived from the property.
 *
 * THE BOUND: AWS can genuinely report a value other than the property, so a
 * disagreement can outlive the heal. The deploy's persist merge then stamps
 * `ResourceState.attributesReadAfterApply` with {@link staleShapeFingerprint}
 * of the record it saves, and a record whose fingerprint still equals its
 * stamp is never re-read for this again. The stamp covers the predicate's
 * INPUTS, so it lapses by itself when a later write changes any of them,
 * whichever writer made it; a writer that rebuilds the record without the
 * field re-arms the check, at most one read later.
 *
 * Import-free apart from `node:crypto` and types, so the resolver and the
 * deploy engine's healer both read it.
 */
import { createHash } from 'node:crypto';
import type { ResourceState } from '../../types/state.js';

/** One disagreement a record can carry, and the attributes it makes stale. */
interface StaleShapeCheck {
  /** Does the record hold this disagreement? Inputs are pre-validated scalars. */
  readonly holds: (
    properties: Readonly<Record<string, unknown>>,
    attributes: Readonly<Record<string, unknown>>
  ) => boolean;
  /**
   * The `Fn::GetAtt` names a stale record answers wrongly: the flat members
   * and the whole objects assembled from them (`flat-object-attributes.ts`).
   */
  readonly attributes: readonly string[];
  /**
   * A completed read NOT reporting the attribute proves the recorded one
   * stale (Multi-AZ off: AWS names no secondary zone). Elsewhere absence
   * proves nothing (an instance mid-rename reports no endpoint), and the
   * recorded value is kept and served.
   */
  readonly absenceIsStale?: true;
}

interface StaleShapeType {
  /** Every key the checks read, from `properties` and from `attributes`: the fingerprint's inputs. */
  readonly propertyInputs: readonly string[];
  readonly attributeInputs: readonly string[];
  readonly checks: readonly StaleShapeCheck[];
}

/** A port or identifier the template may spell as a number or a string. */
function scalarText(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value !== '') return value;
  return undefined;
}

/** `false` / `'false'`, or absent (CloudFormation's default for `MultiAZ`). */
function isOffOrAbsent(value: unknown): boolean {
  return value === undefined || value === false || value === 'false';
}

/**
 * An Aurora member instance (`DBClusterIdentifier` set): its port, Multi-AZ
 * placement and endpoint are the cluster's, so `Port` / `MultiAZ` on the
 * instance legitimately disagree with what the instance reports.
 */
function isClusterMember(properties: Readonly<Record<string, unknown>>): boolean {
  return scalarText(properties['DBClusterIdentifier']) !== undefined;
}

function differs(property: unknown, attribute: unknown, caseInsensitive = false): boolean {
  const want = scalarText(property);
  const have = scalarText(attribute);
  if (want === undefined || have === undefined) return false;
  return caseInsensitive ? want.toLowerCase() !== have.toLowerCase() : want !== have;
}

const STALE_SHAPE_TYPES: Readonly<Record<string, StaleShapeType>> = {
  'AWS::RDS::DBInstance': {
    propertyInputs: ['Port', 'CACertificateIdentifier', 'MultiAZ', 'DBClusterIdentifier'],
    attributeInputs: [
      'Endpoint.Port',
      'CertificateDetails.CAIdentifier',
      'SecondaryAvailabilityZone',
    ],
    checks: [
      {
        holds: (p, a) => !isClusterMember(p) && differs(p['Port'], a['Endpoint.Port']),
        attributes: ['Endpoint.Port', 'Endpoint', 'ListenerEndpoint.Port', 'ListenerEndpoint'],
      },
      {
        // RDS reports the identifier in lower case; a template spelling it in
        // another case is no disagreement.
        holds: (p, a) =>
          differs(p['CACertificateIdentifier'], a['CertificateDetails.CAIdentifier'], true),
        attributes: [
          'CertificateDetails.CAIdentifier',
          'CertificateDetails.ValidTill',
          'CertificateDetails',
        ],
      },
      {
        // Multi-AZ turned OFF while the record still names a secondary zone.
        // The opposite direction (`MultiAZ: true`, no secondary zone recorded)
        // is a MISS, which the #1852 heal already re-reads.
        holds: (p, a) =>
          !isClusterMember(p) &&
          isOffOrAbsent(p['MultiAZ']) &&
          scalarText(a['SecondaryAvailabilityZone']) !== undefined,
        attributes: ['SecondaryAvailabilityZone'],
        absenceIsStale: true,
      },
    ],
  },
  'AWS::Neptune::DBCluster': {
    propertyInputs: ['DBPort'],
    attributeInputs: ['Port', 'Endpoint.Port'],
    checks: [
      {
        holds: (p, a) =>
          differs(p['DBPort'], a['Port']) || differs(p['DBPort'], a['Endpoint.Port']),
        attributes: ['Port', 'Endpoint.Port'],
      },
    ],
  },
};

/** `SECRET_MASK`, spelled here so this module stays a leaf (no redaction import ring). */
const MASK = '***';

function bagOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The inputs, or `undefined` when one is unusable: a masked or structured value
 * (an unresolved intrinsic in a hand-edited record) cannot be compared.
 */
function inputsOf(
  shape: StaleShapeType,
  properties: Readonly<Record<string, unknown>>,
  attributes: Readonly<Record<string, unknown>>
): unknown[] | undefined {
  const values = [
    ...shape.propertyInputs.map((key) =>
      Object.hasOwn(properties, key) ? properties[key] : undefined
    ),
    ...shape.attributeInputs.map((key) =>
      Object.hasOwn(attributes, key) ? attributes[key] : undefined
    ),
  ];
  const usable = values.every(
    (value) =>
      value === undefined ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && !value.includes(MASK))
  );
  return usable ? values : undefined;
}

/**
 * The attribute names the record's disagreements make stale, IGNORING the
 * stamp; empty when the record holds none (or is of a type with no checks).
 */
export function staleShapeAttributeNames(record: ResourceState): ReadonlySet<string> {
  return namesOf(record, () => true);
}

/** The attribute names of the record's disagreements whose check passes `keep`. */
function namesOf(record: ResourceState, keep: (check: StaleShapeCheck) => boolean): Set<string> {
  const resourceType = record.resourceType as unknown;
  if (typeof resourceType !== 'string' || !Object.hasOwn(STALE_SHAPE_TYPES, resourceType)) {
    return new Set();
  }
  const shape = STALE_SHAPE_TYPES[resourceType]!;
  const properties = bagOf(record.properties);
  const attributes = bagOf(record.attributes);
  if (inputsOf(shape, properties, attributes) === undefined) return new Set();
  const names = new Set<string>();
  for (const check of shape.checks) {
    if (keep(check) && check.holds(properties, attributes)) {
      for (const name of check.attributes) names.add(name);
    }
  }
  return names;
}

/**
 * The values the checks compare (`undefined` for a type with none, or an
 * unusable input), in a fixed order: what {@link staleShapeFingerprint} hashes.
 */
export function staleShapeInputs(record: ResourceState): unknown[] | undefined {
  const resourceType = record.resourceType as unknown;
  if (typeof resourceType !== 'string' || !Object.hasOwn(STALE_SHAPE_TYPES, resourceType)) {
    return undefined;
  }
  return inputsOf(
    STALE_SHAPE_TYPES[resourceType]!,
    bagOf(record.properties),
    bagOf(record.attributes)
  );
}

/**
 * The stamp {@link staleShapeAttributeNames}' inputs hash to, or `undefined`
 * for a type with no checks or an unusable input. A sha256 of non-secret
 * scalars (ports, a CA identifier, an AZ, a Multi-AZ flag, a cluster id); the
 * persist merge refuses to stamp when any of them matches this run's secrets.
 */
export function staleShapeFingerprint(record: ResourceState): string | undefined {
  const inputs = staleShapeInputs(record);
  if (inputs === undefined) return undefined;
  return createHash('sha256')
    .update(JSON.stringify([record.resourceType, inputs.map((v) => (v === undefined ? null : v))]))
    .digest('hex');
}

/** Has a deploy already re-read this record in exactly its current shape? */
export function isStaleShapeStamped(record: ResourceState): boolean {
  const stamp = record.attributesReadAfterApply as unknown;
  return typeof stamp === 'string' && stamp === staleShapeFingerprint(record);
}

/**
 * Must a `Fn::GetAtt` of `attributeName` re-read `record` before serving its
 * recorded value? Only for an attribute the record's own disagreement makes
 * stale, and never for a record already re-read in that shape.
 */
export function needsStaleShapeRead(record: ResourceState, attributeName: string): boolean {
  return staleShapeAttributeNames(record).has(attributeName) && !isStaleShapeStamped(record);
}

/**
 * The flat attribute keys a heal read may REPLACE in `record` (the persist
 * merge is otherwise add-only): the stale members of an unstamped record.
 */
export function staleShapeReplaceableKeys(record: ResourceState): ReadonlySet<string> {
  if (isStaleShapeStamped(record)) return new Set();
  const attributes = bagOf(record.attributes);
  return new Set(
    [...staleShapeAttributeNames(record)].filter((key) => Object.hasOwn(attributes, key))
  );
}

/**
 * May a completed read that does not report `attributeName` be taken as proof
 * the recorded value is stale (resolve as a miss, drop it on save)? Only for a
 * check whose absence means so ({@link StaleShapeCheck.absenceIsStale}).
 */
export function staleShapeAbsenceIsStale(record: ResourceState, attributeName: string): boolean {
  return (
    !isStaleShapeStamped(record) &&
    namesOf(record, (check) => check.absenceIsStale === true).has(attributeName)
  );
}
