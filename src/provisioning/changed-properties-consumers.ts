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
 * correct set, only a wider one: the DocDB / RDS DB cluster and RDS DB
 * instance read it for `MasterUserPassword` alone, which AWS never returns, so
 * a readback could not confirm it and they stay out (#5153). A LEAF: the
 * deploy engine imports it, never a provider module.
 */
export const CHANGED_PROPERTIES_CONSUMER_TYPES: ReadonlySet<string> = new Set([
  'AWS::ServiceDiscovery::Service',
]);
