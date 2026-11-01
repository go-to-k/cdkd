/**
 * go-to-k/cdkd#5112: the resource types whose SDK provider decides from
 * `UpdateContext.changedProperties` WHETHER to send a field (a replace-style
 * update body), so a key the set wrongly names changes what AWS keeps.
 *
 * For these types alone, a deploy whose resource carries a fresh `NoEcho`
 * parameter value at an updatable key reads the resource back even when
 * another property moved, so a value AWS already holds is left out of the set,
 * as CloudFormation compares templates. Every other type makes no such read:
 * a `NoEcho` key it cannot confirm stays in the set (re-sent), which is the
 * safe direction and costs nothing (performance over parity, recorded at the
 * read in `deploy-engine/update.ts`).
 *
 * A provider that starts reading `changedProperties` joins this set when its
 * readback returns the keys it reads. Without it the provider still gets a
 * correct set, only a wider one: the DocDB DB cluster reads it for
 * `MasterUserPassword` alone, the RDS DB cluster for it plus its
 * go-to-k/cdkd#2762 parameter group, window, tag-copy and storage type keys,
 * and the RDS DB instance for it plus `EngineVersion` and its #2762 storage,
 * backup, Performance Insights and other backfill keys. AWS never
 * returns the password, so a readback could not confirm it and they stay out
 * (#5153); a `NoEcho`-fed #2762 key is re-sent, the safe direction, except
 * a `NoEcho`-fed `AllocatedStorage` on an instance autoscaling has grown past
 * it, which RDS refuses as a shrink on every deploy that re-sends it. A LEAF: the
 * deploy engine imports it, never a provider module.
 */
export const CHANGED_PROPERTIES_CONSUMER_TYPES: ReadonlySet<string> = new Set([
  'AWS::ServiceDiscovery::Service',
]);
