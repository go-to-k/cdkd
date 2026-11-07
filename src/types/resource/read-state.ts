/**
 * What `ResourceProvider.readCurrentState` returns when AWS reports the
 * resource is NOT THERE — deleted outside cdkd (go-to-k/cdkd#4283).
 *
 * A sentinel rather than `undefined` because `undefined` already means "this
 * provider has no read path for the type", which `cdkd drift` reports as an
 * uncovered type and exits `0` for. A resource deleted out of band is the most
 * important drift there is, so it must not share that spelling: `cdkd drift`
 * maps this one to its `deleted` outcome (exit `1`).
 *
 * Return it only on AWS's own not-found answer (a not-found error NAME, an
 * empty describe list, a terminal `DELETED` / `INACTIVE` status). Never on an
 * access denied, a throttle, message text alone or any other failure: those
 * throw (the caller reports the read as failed), or keep whatever `undefined`
 * a provider already answered for them — never claim the resource is gone.
 *
 * Every caller must handle it before treating the result as a property bag.
 */
export const RESOURCE_NOT_FOUND: unique symbol = Symbol('cdkd.resourceNotFound');

/** The type of {@link RESOURCE_NOT_FOUND}. */
export type ResourceNotFound = typeof RESOURCE_NOT_FOUND;

/** `ResourceProvider.isSameResource`'s answer (go-to-k/cdkd#4606). */
export type ResourceIdentityVerdict = 'same' | 'different' | 'unknown';

/**
 * Cross-resource context passed to `ResourceProvider.readCurrentState`
 * for providers that need to inspect sibling resources in the same
 * stack to decide what counts as drift.
 *
 * Issue #323: `IAMRoleProvider` / `IAMUserGroupProvider`'s
 * `readCurrentState` call `iam:ListRolePolicies` / `ListUserPolicies` /
 * `ListGroupPolicies` to surface inline policies. CDK's pattern for
 * `iam.Policy({ roles: [r] })` (or `users` / `groups`) calls
 * `iam:PutRolePolicy` under the hood, so those policies show up in the
 * `List*Policies` output — but they are managed by the sibling
 * `AWS::IAM::Policy` resource, not the role/user/group itself. Without
 * filtering them out, every Role/User/Group whose CDK code uses
 * `addToPolicy` / `grantRead` / `ContainerImage.fromEcrRepository`
 * fires false drift on every `cdkd drift` run.
 *
 * The context carries the same-stack siblings (excluding the resource
 * being read) so the IAM providers can match `ListRolePolicies` output
 * against `AWS::IAM::Policy.Properties.PolicyName` + the policy's
 * `Roles` / `Users` / `Groups` list.
 *
 * Most providers ignore the context — only IAM cross-attachment cases
 * require it.
 */
export interface ReadCurrentStateContext {
  /**
   * All resources in the same stack EXCEPT the one being read.
   * Keyed by logicalId. `resourceType`, `physicalId`, `properties`, and
   * `attributes` come from cdkd state (`ResourceState`); `properties` may
   * carry intrinsics unresolved for resources written by older binaries —
   * providers that consume this should match by literal values only.
   * `attributes` carries the deploy-time-resolved `Fn::GetAtt` values (e.g.
   * a CloudFront OAI's `S3CanonicalUserId`), so a provider can reconcile a
   * sibling's computed identity without an extra AWS call.
   */
  siblings?: Record<
    string,
    {
      resourceType: string;
      physicalId?: string;
      properties: Record<string, unknown>;
      attributes?: Record<string, unknown>;
    }
  >;
  /**
   * Set only by the deploy's `observedProperties` capture right after cdkd's
   * own CREATE / UPDATE / replacement of this resource (issue #4112): the
   * write succeeded, and the `properties` bag is the template it deployed. A
   * provider whose reads are eventually consistent may then keep a DECLARED
   * member its read still reports ABSENT, rather than freeze a lagging
   * "absent" into the baseline.
   * Absent on every other read (drift, import, a baseline refresh), where the
   * live answer must be believed so a member that really is gone reports.
   */
  afterOwnWrite?: boolean;
  /**
   * The read resource's OWN recorded `attributes` (cdkd state), set by
   * `buildReadCurrentStateContext` on drift / import / `state refresh-observed`
   * reads. A provider may use an id recorded there as ownership evidence
   * before it binds a live object the physicalId alone cannot single out
   * (go-to-k/cdkd#4447: a standalone `AWS::EC2::SecurityGroupIngress`'s `Id`).
   * Absent on the deploy capture and on records that carry none.
   */
  attributes?: Readonly<Record<string, unknown>>;
}
