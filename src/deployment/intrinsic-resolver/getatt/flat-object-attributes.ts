/**
 * go-to-k/cdkd#6242: object-valued `Fn::GetAtt` attributes a provider records
 * as FLAT dotted members (`Endpoint.Address`, `Endpoint.Port`), per type: the
 * whole object is served by assembling those members, so the object and a
 * member read on its own come from the same recorded data and cannot
 * disagree. Generic over types: an entry names the members CloudFormation
 * serves the object with.
 *
 * `required` members must ALL be recorded: a record missing one (written
 * before the provider recorded `Endpoint.HostedZoneId`) does not answer a
 * partial object, it misses, so the resolver re-reads the record (the
 * stale-attribute heal) and assembles from that read instead. `optional`
 * members join the object when recorded.
 */
interface FlatObjectShape {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
}

const FLAT_OBJECT_MEMBERS: Readonly<Record<string, Readonly<Record<string, FlatObjectShape>>>> = {
  // Measured against CloudFormation (us-east-1, 2026-11-14): `Endpoint`
  // `{Address, HostedZoneId, Port}`, `CertificateDetails` `{CAIdentifier,
  // ValidTill}`. `ListenerEndpoint` is NOT measured (the measured instance had
  // none): RDS's `Endpoint` shape, with `HostedZoneId` optional until it is.
  'AWS::RDS::DBInstance': {
    Endpoint: { required: ['Address', 'HostedZoneId', 'Port'] },
    ListenerEndpoint: { required: ['Address', 'Port'], optional: ['HostedZoneId'] },
    CertificateDetails: { required: ['CAIdentifier', 'ValidTill'] },
  },
  // Measured: `Endpoint` `{Address, Port}`, `ReadEndpoint` `{Address}`.
  'AWS::RDS::DBCluster': {
    Endpoint: { required: ['Address', 'Port'] },
    ReadEndpoint: { required: ['Address'] },
  },
  // Measured: `RedisEndpoint` (Redis) and `ConfigurationEndpoint` (Memcached)
  // `{Address, Port}`, Port a string. The endpoint the engine does not have is
  // refused before this assembly (`refuseEndpointTheEngineLacks`).
  'AWS::ElastiCache::CacheCluster': {
    RedisEndpoint: { required: ['Address', 'Port'] },
    ConfigurationEndpoint: { required: ['Address', 'Port'] },
  },
};

/** The shape `resourceType` assembles `attributeName` with, or `undefined`. */
function shapeOf(resourceType: string, attributeName: string): FlatObjectShape | undefined {
  if (!Object.hasOwn(FLAT_OBJECT_MEMBERS, resourceType)) return undefined;
  const byType = FLAT_OBJECT_MEMBERS[resourceType]!;
  return Object.hasOwn(byType, attributeName) ? byType[attributeName] : undefined;
}

/** A recorded member, or `undefined` when absent or unusable (`null`, `''`). */
function memberValue(attributes: Readonly<Record<string, unknown>>, key: string): unknown {
  const value = Object.hasOwn(attributes, key) ? attributes[key] : undefined;
  return value === null || value === '' ? undefined : value;
}

/**
 * The whole object assembled from `attributes`' flat members, or `undefined`
 * when the type does not assemble this attribute or a member is missing
 * (absent, `null` or `''`, as the heal's read treats an unusable value).
 */
export function assembleFlatObjectAttribute(
  resourceType: string,
  attributeName: string,
  attributes: Readonly<Record<string, unknown>> | undefined
): Record<string, unknown> | undefined {
  const shape = attributes === undefined ? undefined : shapeOf(resourceType, attributeName);
  if (attributes === undefined || shape === undefined) return undefined;
  const entries: Array<[string, unknown]> = [];
  for (const member of shape.required) {
    const value = memberValue(attributes, `${attributeName}.${member}`);
    if (value === undefined) return undefined;
    entries.push([member, value]);
  }
  for (const member of shape.optional ?? []) {
    const value = memberValue(attributes, `${attributeName}.${member}`);
    if (value !== undefined) entries.push([member, value]);
  }
  // Member names are this module's own literals, never template text.
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}
