/**
 * The ONE spelling of "has this EC2 instance SETTLED?" (issue
 * [#3096](https://github.com/go-to-k/cdkd/issues/3096) review).
 *
 * Two readers must agree on it or a record and a resolution disagree about
 * the same instance: `EC2Provider`'s `describedInstanceAttributes` decides
 * whether a missing public member is RECORDED as the known `''` (settled) or
 * OMITTED (still `pending`, issue #3077), and the resolver's
 * `AWS::EC2::Instance` live arm decides, for an omitted member, whether to
 * SERVE that same `''` or REFUSE. Each carried the comparison inline; this
 * module is the shared predicate so a change to one side cannot leave the
 * other on the old rule.
 *
 * `pending` is the only state in which EC2 has not finished assigning the
 * launch-time members; every other reported state — `running`, `stopping`,
 * `stopped`, `shutting-down`, `terminated` — is a settled one whose public
 * pair, when absent, is genuinely absent (a private-subnet instance, or a
 * stopped one whose address was released). NO state at all is treated like
 * `pending`: a read-back that returned no instance, or a shape without one,
 * says nothing about having settled.
 *
 * A LEAF: no imports, so both `src/provisioning/**` and `src/deployment/**`
 * can take it without adding an edge between the two layers.
 */
export function isSettledInstanceState(stateName: string | undefined): boolean {
  return stateName !== undefined && stateName !== 'pending';
}
