import type { IAMRoleProvider } from '../iam-role-provider.js';
import {
  GetRoleCommand,
  GetRolePolicyCommand,
  ListRolePoliciesCommand,
  ListAttachedRolePoliciesCommand,
  ListRoleTagsCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { definedAttributes } from '../../attribute-map.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../../import-helpers.js';
import {
  type ResourceImportInput,
  type ResourceImportResult,
  type ResourceNotFound,
  type ResourceIdentityVerdict,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';
import { collectInlinePolicyNamesManagedBySiblings } from '../iam-role-provider.js';
import { isRoleName, roleIdentityToken } from './shared.js';

/**
 * Resolve a single `Fn::GetAtt` attribute for an existing IAM role.
 *
 * CloudFormation's `AWS::IAM::Role` exposes `Arn` and `RoleId`; both are
 * available from the `GetRole` response. See:
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-role.html#aws-resource-iam-role-return-values
 *
 * Used by `cdkd orphan` to live-fetch attribute values that need to be
 * substituted into sibling references.
 */
export async function getAttribute(
  this: IAMRoleProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  try {
    const resp = await this.iamClient.send(new GetRoleCommand({ RoleName: physicalId }));
    switch (attributeName) {
      case 'Arn':
        return resp.Role?.Arn;
      case 'RoleId':
        return resp.Role?.RoleId;
      default:
        return undefined;
    }
  } catch (err) {
    if (err instanceof NoSuchEntityException) return undefined;
    throw err;
  }
}

/**
 * go-to-k/cdkd#4606: whether the role a failed CREATE journaled is the one
 * the record under the same logical id holds (a fix-forward that created a
 * new role there under another name).
 *
 * Both ids must be role NAMES (the physical id this provider records);
 * anything else is `'unknown'`, and so are two names differing only in
 * case: IAM treats those as one role, and this check does not decide on
 * IAM's case rules. Equal names are `'same'` without a read: whatever role
 * holds the name now is the record's, and deleting by that name would
 * delete it. A role name is unique per account (case-insensitively) and a
 * role cannot be renamed. After the region check the record's role must
 * read back (else `'unknown'`); the journaled one is `'same'` when it reads
 * back under the record's `RoleId`, `'different'` under another, and
 * `'different'` when IAM reports it gone: the record's role answers to its
 * own, other, name. Any other read failure throws, which the caller reads
 * as `'unknown'`.
 */
export async function isSameResource(
  this: IAMRoleProvider,
  journaledPhysicalId: string,
  record: { physicalId: string },
  resourceType: string,
  context: { expectedRegion: string }
): Promise<ResourceIdentityVerdict> {
  if (resourceType !== 'AWS::IAM::Role') return 'unknown';
  if (!isRoleName(journaledPhysicalId) || !isRoleName(record.physicalId)) return 'unknown';
  if (journaledPhysicalId === record.physicalId) return 'same';
  if (journaledPhysicalId.toLowerCase() === record.physicalId.toLowerCase()) return 'unknown';
  const clientRegion = await this.iamClient.config.region();
  if (clientRegion !== context.expectedRegion) return 'unknown';
  const recordRoleId = await this.readRoleIdIfExists(record.physicalId);
  if (recordRoleId === undefined) return 'unknown';
  const journaledRoleId = await this.readRoleIdIfExists(journaledPhysicalId);
  if (journaledRoleId === undefined) return 'different';
  // Unreachable as 'same' while the names differ beyond case; kept so the
  // verdict rests on AWS's answer.
  return journaledRoleId === recordRoleId ? 'same' : 'different';
}

/**
 * go-to-k/cdkd#4655 / #4606: the role's `RoleId`
 * ({@link roleIdentityToken}). A role re-created under the name answers
 * with another one, so the settle keeps it rather than deleting it as the
 * failed CREATE's orphan. A failed CREATE's own token comes from its
 * CreateRole response, on the failure's mark (`markCreatedBeforeFailure`);
 * this is the live read.
 *
 * `undefined` for another type, an id that is not a role name, or a client
 * in another region than `expectedRegion` (IAM is global, but the check
 * keeps every identity read on the stack's own client). `RESOURCE_NOT_FOUND`
 * only on `NoSuchEntityException`; any other failure, a response naming
 * another role, and one with no `RoleId` throw.
 */
export async function resourceIdentity(
  this: IAMRoleProvider,
  physicalId: string,
  resourceType: string,
  context: { expectedRegion: string }
): Promise<string | ResourceNotFound | undefined> {
  if (resourceType !== 'AWS::IAM::Role' || !isRoleName(physicalId)) return undefined;
  const clientRegion = await this.iamClient.config.region();
  if (clientRegion !== context.expectedRegion) return undefined;
  const roleId = await this.readRoleIdIfExists(physicalId);
  return roleId === undefined ? RESOURCE_NOT_FOUND : roleId;
}

/**
 * The role's `RoleId`, or `undefined` when `GetRole` answers
 * `NoSuchEntityException`. Any other failure, a response naming another
 * role, and one with no `RoleId` throw: "could not read" never reads as
 * "gone".
 */
export async function readRoleIdIfExists(
  this: IAMRoleProvider,
  roleName: string
): Promise<string | undefined> {
  let response;
  try {
    response = await this.iamClient.send(new GetRoleCommand({ RoleName: roleName }));
  } catch (error) {
    if (error instanceof NoSuchEntityException) return undefined;
    throw error;
  }
  if (response.Role?.RoleName !== roleName) {
    throw new Error('GetRole answered for another role than the one asked for');
  }
  const roleId = roleIdentityToken(response.Role.RoleId);
  if (roleId === undefined) throw new Error('GetRole returned no RoleId');
  return roleId;
}

/**
 * Read the AWS-current IAM role configuration in CFn-property shape.
 *
 * Issues `GetRole` for the top-level role configuration and
 * `ListRolePolicies` + `ListAttachedRolePolicies` for inline / managed
 * policy *names*. AWS URL-decodes `AssumeRolePolicyDocument` for us
 * when it surfaces — we re-parse it as JSON so the comparator can match
 * against state's already-parsed object.
 *
 * Coverage and shape decisions:
 *  - `RoleName`, `Description`, `MaxSessionDuration`, `Path` — straight
 *    from `Role.*`.
 *  - `PermissionsBoundary` — emitted as `'' ` placeholder when AWS has
 *    none, so a console-side ADD on a role that was deployed without a
 *    boundary surfaces as drift. (The drift comparator's top-level walk
 *    is state-keys-only; without the always-emit placeholder a fresh
 *    `PermissionsBoundary` on the AWS side would never enter
 *    `observedProperties` and the comparator would silently ignore it.)
 *  - `AssumeRolePolicyDocument` — `Role.AssumeRolePolicyDocument` is a
 *    URL-encoded JSON string; we URL-decode + JSON-parse so cdkd state's
 *    object form compares cleanly. (Both shapes — string and object — are
 *    accepted by `create()`, but state typically stores the parsed object
 *    after intrinsic resolution.)
 *  - `ManagedPolicyArns` — array of ARN strings from
 *    `ListAttachedRolePolicies`.
 *  - `Policies` — inline policies surfaced as `[{PolicyName, PolicyDocument}]`.
 *    `ListRolePolicies` for names + `GetRolePolicy` per name for the
 *    body (URL-decoded + JSON-parsed). Ordering is reconciled against
 *    state's `Policies` array (when supplied via the `properties`
 *    parameter) so a state-vs-AWS positional compare doesn't fire false
 *    drift purely from `ListRolePolicies` returning lexicographic order;
 *    AWS-only policies (added via console) are appended at the end so
 *    they still surface as drift via length / content mismatch.
 *  - `Tags` is surfaced via `ListRoleTags` (paginated). CDK's `aws:*`
 *    auto-tags are filtered out by `normalizeAwsTagsToCfn` so they don't
 *    fire false-positive drift; always emitted (even when empty) so a
 *    console-side tag ADD on an originally-untagged role surfaces as
 *    drift on the v3 observedProperties baseline.
 *
 * Returns `RESOURCE_NOT_FOUND` when the role is gone (`NoSuchEntityException`).
 */
export async function readCurrentState(
  this: IAMRoleProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  properties?: Record<string, unknown>,
  context?: import('../../../types/resource.js').ReadCurrentStateContext
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let role;
  try {
    const resp = await this.iamClient.send(new GetRoleCommand({ RoleName: physicalId }));
    role = resp.Role;
  } catch (err) {
    if (err instanceof NoSuchEntityException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!role) return undefined;

  const result: Record<string, unknown> = {};

  if (role.RoleName !== undefined) result['RoleName'] = role.RoleName;
  result['Description'] = role.Description ?? '';
  if (role.MaxSessionDuration !== undefined) {
    result['MaxSessionDuration'] = role.MaxSessionDuration;
  }
  if (role.Path !== undefined) result['Path'] = role.Path;
  // Always-emit (PR #145 pattern): surfaces console-side ADDs on roles
  // deployed without a boundary. AWS returns the boundary as a nested
  // `{ PermissionsBoundaryArn, PermissionsBoundaryType }` shape; cdkd
  // state stores the bare ARN string (matches CFn input shape).
  result['PermissionsBoundary'] = role.PermissionsBoundary?.PermissionsBoundaryArn ?? '';
  if (role.AssumeRolePolicyDocument) {
    // GetRole returns AssumeRolePolicyDocument URL-encoded. Decode and
    // parse so the comparator can match cdkd state (which holds the
    // already-resolved object form).
    try {
      result['AssumeRolePolicyDocument'] = JSON.parse(
        decodeURIComponent(role.AssumeRolePolicyDocument)
      ) as unknown;
    } catch {
      // Fall back to the raw string if decoding / parsing fails. The
      // comparator handles primitive vs object mismatches correctly.
      result['AssumeRolePolicyDocument'] = role.AssumeRolePolicyDocument;
    }
  }

  // ManagedPolicyArns — string[] of attached managed policy ARNs.
  try {
    const attached = await this.iamClient.send(
      new ListAttachedRolePoliciesCommand({ RoleName: physicalId })
    );
    const arns = (attached.AttachedPolicies ?? [])
      .map((p) => p.PolicyArn)
      .filter((arn): arn is string => !!arn);
    result['ManagedPolicyArns'] = arns;
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  // Inline Policies — `[{PolicyName, PolicyDocument}]`. Cap at IAM's
  // documented 10-inline-policies-per-role limit to bound the API
  // budget; ListRolePolicies is paginated for forward-compat anyway.
  try {
    const policyNames: string[] = [];
    let policyMarker: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const listResp = await this.iamClient.send(
        new ListRolePoliciesCommand({
          RoleName: physicalId,
          ...(policyMarker ? { Marker: policyMarker } : {}),
        })
      );
      for (const name of listResp.PolicyNames ?? []) policyNames.push(name);
      if (!listResp.IsTruncated) break;
      policyMarker = listResp.Marker;
    }

    // Issue #323: filter out inline policies that are managed by a
    // SEPARATE `AWS::IAM::Policy` resource attached via `Roles: [role]`.
    // CDK's `iam.Policy({ roles: [r] })` (and L2 helpers like
    // `taskRole.addToPolicy(...)` / `bucket.grantRead(role)` /
    // `ContainerImage.fromEcrRepository(repo)`'s execution-role grant)
    // creates a separate `AWS::IAM::Policy` resource — which AWS
    // implements via `iam:PutRolePolicy`, so those inline policies
    // appear in `ListRolePolicies` output. Without this filter every
    // such Role fires false drift (state.Policies = [] vs aws =
    // [{...DefaultPolicy*}]).
    const managedByOtherResource = collectInlinePolicyNamesManagedBySiblings(
      physicalId,
      context,
      'Roles'
    );
    const filteredNames = policyNames.filter((n) => !managedByOtherResource.has(n));

    // Fetch every body in parallel (max 10; well under any IAM rate
    // limit). URL-decode + JSON-parse so the comparator sees the same
    // object shape state holds after intrinsic resolution.
    const bodies = new Map<string, unknown>();
    await Promise.all(
      filteredNames.map(async (name) => {
        const resp = await this.iamClient.send(
          new GetRolePolicyCommand({ RoleName: physicalId, PolicyName: name })
        );
        if (!resp.PolicyDocument) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(decodeURIComponent(resp.PolicyDocument));
        } catch {
          parsed = resp.PolicyDocument;
        }
        bodies.set(name, parsed);
      })
    );

    // Reconcile order against state's `Policies` so a positional array
    // compare doesn't fire purely from `ListRolePolicies` returning
    // lexicographic order. AWS-only entries (console adds) tail-append
    // so length / content mismatch still surfaces them as drift.
    const statePolicies =
      (properties?.['Policies'] as Array<{ PolicyName?: string }> | undefined) ?? [];
    const remaining = new Set(bodies.keys());
    const inline: Array<{ PolicyName: string; PolicyDocument: unknown }> = [];
    for (const sp of statePolicies) {
      const name = sp?.PolicyName;
      if (typeof name !== 'string') continue;
      if (bodies.has(name)) {
        inline.push({ PolicyName: name, PolicyDocument: bodies.get(name) });
        remaining.delete(name);
      }
    }
    for (const name of [...remaining].sort()) {
      inline.push({ PolicyName: name, PolicyDocument: bodies.get(name) });
    }
    result['Policies'] = inline;
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  // Tags via ListRoleTags. Paginated — small page sizes are fine since
  // IAM enforces a 50-tag-per-role limit, but we still iterate Marker for
  // forward-compat.
  try {
    const collected: Array<{ Key?: string | undefined; Value?: string | undefined }> = [];
    let marker: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const tagsResp = await this.iamClient.send(
        new ListRoleTagsCommand({
          RoleName: physicalId,
          ...(marker ? { Marker: marker } : {}),
        })
      );
      if (tagsResp.Tags) {
        for (const t of tagsResp.Tags) {
          collected.push({ Key: t.Key, Value: t.Value });
        }
      }
      if (!tagsResp.IsTruncated) break;
      marker = tagsResp.Marker;
    }
    const tags = normalizeAwsTagsToCfn(collected);
    result['Tags'] = tags;
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  return result;
}

/**
 * Adopt an existing IAM role into cdkd state.
 *
 * Lookup order:
 *  1. `--resource` override or `Properties.RoleName` → use directly,
 *     verify via `GetRole`.
 */
export async function importImpl(
  this: IAMRoleProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'RoleName');
  if (explicit) {
    try {
      const resp = await this.iamClient.send(new GetRoleCommand({ RoleName: explicit }));
      // Issue #3627: the same map `create()` records. The resolver's
      // `RoleId` arm refuses the reference without it (issue #4077), and its `Arn` arm
      // ignores a non-`/` `Path`.
      return {
        physicalId: explicit,
        attributes: definedAttributes({ Arn: resp.Role?.Arn, RoleId: resp.Role?.RoleId }),
      };
    } catch (err) {
      if (err instanceof NoSuchEntityException) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
  // tag never exists on a real resource and the walk could not match (issue
  // #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a role
  // reaching here needs an explicit `--resource` override.
  return null;
}
