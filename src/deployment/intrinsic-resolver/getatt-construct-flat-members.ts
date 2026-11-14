/**
 * Whole-object `Fn::GetAtt` attributes served by ASSEMBLING the flat dotted
 * keys a provider already records (go-to-k/cdkd#6242).
 *
 * An SDK provider records an object-valued attribute's members as flat keys
 * (`attributes['RedisEndpoint.Address']`), which the resolver's flat lookup
 * serves for `Fn::GetAtt [R, RedisEndpoint.Address]`. CloudFormation also
 * answers the WHOLE object (`Fn::GetAtt [R, RedisEndpoint]` is
 * `{"Address": "...", "Port": "6379"}`, measured us-east-1 2026-11-14). The
 * object is built here from those same flat keys rather than recorded a
 * second time, so a member and its object cannot disagree, and a record
 * written before this change resolves the object too.
 *
 * Scoped to the (type, attribute) pairs listed: the member names and their
 * order are CloudFormation's, and a pair is listed only once its provider
 * records the members with CloudFormation's types (strings here).
 *
 * A LEAF: no imports.
 */
const FLAT_MEMBER_OBJECTS: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> = new Map([
  [
    'AWS::ElastiCache::CacheCluster',
    new Map([
      ['RedisEndpoint', ['Address', 'Port']],
      ['ConfigurationEndpoint', ['Address', 'Port']],
    ]),
  ],
]);

/**
 * The whole object for `attributeName` of `resourceType`, assembled from the
 * recorded `<attributeName>.<member>` keys, or `undefined` when the pair is
 * not listed or the record holds none of its members (the attribute stays
 * refused, as CloudFormation fails a reference to an endpoint the cluster
 * does not have). A member the record lacks is left out of the object.
 */
export function flatMemberObject(
  resourceType: string,
  attributeName: string,
  attributes: Record<string, unknown>
): Record<string, unknown> | undefined {
  const members = FLAT_MEMBER_OBJECTS.get(resourceType)?.get(attributeName);
  if (members === undefined) return undefined;
  const assembled: Record<string, unknown> = {};
  for (const member of members) {
    const key = `${attributeName}.${member}`;
    const value = Object.hasOwn(attributes, key) ? attributes[key] : undefined;
    // allow-template-keyed-bag-read: `member` comes from the fixed FLAT_MEMBER_OBJECTS
    // table above, never from template text, and `assembled` is a fresh object.
    if (value !== undefined && value !== null) assembled[member] = value;
  }
  return Object.keys(assembled).length > 0 ? assembled : undefined;
}
