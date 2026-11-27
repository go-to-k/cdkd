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

/**
 * A provider's own refusal to answer a drift read (go-to-k/cdkd#6616), as
 * opposed to an AWS call that failed. `cdkd drift` reports the resource as
 * not fully compared, as for any failed read, but does not count it toward
 * the read-failure breaker: AWS answered, so the next read is no likelier to
 * fail. Its message must name no property value.
 */
export class DriftReadRefusedError extends Error {
  override readonly name = 'DriftReadRefusedError';
}

/** `ResourceProvider.isSameResource`'s answer (go-to-k/cdkd#4606). */
export type ResourceIdentityVerdict = 'same' | 'different' | 'unknown';

/**
 * `ResourceProvider.replacedSurvivorIdentity`'s answer (go-to-k/cdkd#6621).
 * `foreign`: something holds the id that cannot be the stack's resource (not
 * this account's, or in another region than the stack's). `owned`: this
 * account's resource in the stack's region; `identity` is the type's
 * generation token WITHOUT the physical id (an S3 bucket's
 * `<region>|<CreationDate ISO>`), `undefined` when it could not be read.
 * `unknown`: the read could not answer.
 */
export type SurvivorIdentityRead =
  | { kind: 'gone' }
  | { kind: 'foreign'; seen: 'other-account' | 'other-region' }
  | { kind: 'owned'; identity: string | undefined }
  | { kind: 'unknown' };

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
   * own CREATE / UPDATE / replacement of this resource (issue #4112), and by
   * the rollback replay's baseline refresh right after its in-place revert
   * (go-to-k/cdkd#6526): the write succeeded, and the `properties` bag is
   * what it wrote. A
   * provider whose reads are eventually consistent may then keep a DECLARED
   * member its read still reports ABSENT, rather than freeze a lagging
   * "absent" into the baseline.
   * Absent on every other read (drift, import, a baseline refresh), where the
   * live answer must be believed so a member that really is gone reports.
   */
  afterOwnWrite?: boolean;
  /**
   * go-to-k/cdkd#6641: the read resource's record is provisioned through
   * Cloud Control (`provisionedBy: 'cc-api'`), so its readback is Cloud
   * Control's, which assigns no security-group rule by `sgr-` id. Set by
   * `buildReadCurrentStateContext`.
   */
  ccApiRead?: boolean;
  /**
   * The read resource's OWN recorded `attributes` (cdkd state), set by
   * `buildReadCurrentStateContext` on drift / import / `state refresh-observed`
   * reads and the rollback replay's baseline refresh. A provider may use an id recorded there as ownership evidence
   * before it binds a live object the physicalId alone cannot single out
   * (go-to-k/cdkd#4447: a standalone `AWS::EC2::SecurityGroupIngress`'s `Id`).
   * Absent on the deploy capture and on records that carry none.
   */
  attributes?: Readonly<Record<string, unknown>>;
  /**
   * go-to-k/cdkd#7061: the read resource's OWN `noEchoLeaves` and
   * `maskedPropertyFingerprints`, as stored, set by `buildReadCurrentStateContext`.
   * A provider deciding whether a recorded property is a secret asks
   * `recordedSecrecyOf` with these beside `properties`. Absent where no record
   * is read (the deploy capture): the value's text alone then decides.
   */
  provenance?: { readonly noEchoLeaves?: unknown; readonly maskedPropertyFingerprints?: unknown };
  /**
   * The read resource's OWN recorded `observedProperties` (the drift
   * baseline), set by `buildReadCurrentStateContext` beside `attributes`. A
   * provider that must pick ONE of several live copies to report may compare
   * them against it, since it is what the drift comparator compares against
   * when present (`AWS::IAM::Policy`, go-to-k/cdkd#6616). Only for that
   * comparison: never returned, logged, or persisted from here.
   */
  driftBaseline?: Readonly<Record<string, unknown>>;
}
