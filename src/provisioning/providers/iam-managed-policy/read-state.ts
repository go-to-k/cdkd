import type { IAMManagedPolicyProvider } from '../iam-managed-policy-provider.js';
import {
  GetPolicyCommand,
  GetPolicyVersionCommand,
  ListEntitiesForPolicyCommand,
  ListPolicyTagsCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../../import-helpers.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { managedPolicyAttributes } from './shared.js';

/**
 * Matches an AWS-managed IAM policy ARN in ANY AWS partition (issue #1815).
 *
 * AWS-managed policies are the ones whose ACCOUNT segment is the literal
 * `aws` — `arn:<partition>:iam::aws:policy/<path><name>` — as opposed to a
 * customer-managed policy, which carries a 12-digit account id. They exist
 * under every partition (`arn:aws-us-gov:iam::aws:policy/AdministratorAccess`
 * is a real, attachable ARN in GovCloud), so pinning the PARTITION segment to
 * the commercial `aws` recognised only a third of them.
 *
 * The partition is read OFF THE ARN rather than derived from a region through
 * `derivePartitionAndUrlSuffix` (`src/utils/aws-partition.ts`): that helper
 * answers "given a region, which partition am I in", which is the right
 * question when BUILDING an ARN (the seven sites PR #1834 fixed) and the wrong
 * one when CLASSIFYING an ARN the caller already holds. The loose
 * `aws[a-z0-9-]*` partition segment matches `IAM_ROLE_ARN_RE` in
 * `src/utils/role-arn.ts`; a closed partition list is precisely what goes
 * stale when AWS adds a partition, and here staleness fails DANGEROUS (see the
 * refusal's own comment — an unrecognised AWS-managed policy gets adopted, and
 * destroy then detaches it from every principal in the account).
 */
const AWS_MANAGED_POLICY_ARN_RE = /^arn:aws[a-z0-9-]*:iam::aws:/;

/**
 * Read the AWS-current managed policy configuration in CFn-property shape.
 *
 * Coverage:
 *  - `ManagedPolicyName`, `Description`, `Path` — straight from `GetPolicy`.
 *  - `PolicyDocument` — fetched via `GetPolicyVersion` on the default
 *    version, URL-decoded + JSON-parsed.
 *  - `Groups` / `Roles` / `Users` — string arrays from
 *    `ListEntitiesForPolicy`.
 *  - `Tags` — via `ListPolicyTags`, with the `aws:cdk:path` etc. filtered
 *    out by `normalizeAwsTagsToCfn`.
 *
 * Returns `RESOURCE_NOT_FOUND` when the policy is gone (`NoSuchEntityException`).
 */
export async function readCurrentState(
  this: IAMManagedPolicyProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  _properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let policy;
  try {
    const resp = await this.iamClient.send(new GetPolicyCommand({ PolicyArn: physicalId }));
    policy = resp.Policy;
  } catch (err) {
    if (err instanceof NoSuchEntityException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!policy) return undefined;

  const result: Record<string, unknown> = {};
  if (policy.PolicyName !== undefined) result['ManagedPolicyName'] = policy.PolicyName;
  result['Description'] = policy.Description ?? '';
  if (policy.Path !== undefined) result['Path'] = policy.Path;

  if (policy.DefaultVersionId) {
    try {
      const versionResp = await this.iamClient.send(
        new GetPolicyVersionCommand({
          PolicyArn: physicalId,
          VersionId: policy.DefaultVersionId,
        })
      );
      const doc = versionResp.PolicyVersion?.Document;
      if (typeof doc === 'string') {
        try {
          result['PolicyDocument'] = JSON.parse(decodeURIComponent(doc));
        } catch {
          result['PolicyDocument'] = doc;
        }
      }
    } catch (err) {
      if (!(err instanceof NoSuchEntityException)) throw err;
    }
  }

  try {
    const groups: string[] = [];
    const roles: string[] = [];
    const users: string[] = [];
    let marker: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const resp = await this.iamClient.send(
        new ListEntitiesForPolicyCommand({
          PolicyArn: physicalId,
          ...(marker ? { Marker: marker } : {}),
        })
      );
      for (const g of resp.PolicyGroups ?? []) if (g.GroupName) groups.push(g.GroupName);
      for (const r of resp.PolicyRoles ?? []) if (r.RoleName) roles.push(r.RoleName);
      for (const u of resp.PolicyUsers ?? []) if (u.UserName) users.push(u.UserName);
      if (!resp.IsTruncated) break;
      marker = resp.Marker;
    }
    result['Groups'] = groups;
    result['Roles'] = roles;
    result['Users'] = users;
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  try {
    const collected: Array<{ Key?: string | undefined; Value?: string | undefined }> = [];
    let marker: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const tagsResp = await this.iamClient.send(
        new ListPolicyTagsCommand({
          PolicyArn: physicalId,
          ...(marker ? { Marker: marker } : {}),
        })
      );
      for (const t of tagsResp.Tags ?? []) {
        collected.push({ Key: t.Key, Value: t.Value });
      }
      if (!tagsResp.IsTruncated) break;
      marker = tagsResp.Marker;
    }
    result['Tags'] = normalizeAwsTagsToCfn(collected);
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  return result;
}

/**
 * Adopt an existing IAM managed policy into cdkd state.
 *
 * Lookup order:
 *  1. `--resource` override or `Properties.ManagedPolicyName` → walk
 *     `ListPolicies(Scope: 'Local')` to find the matching ARN.
 *
 * Scope is forced to `'Local'` (customer-managed policies) — adopting an
 * AWS-managed policy would let cdkd delete it on next destroy, which would
 * be a major footgun.
 */
export async function importImpl(
  this: IAMManagedPolicyProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'ManagedPolicyName');
  if (explicit) {
    // If the override is already an ARN, trust it (verify exists). But
    // refuse AWS-managed policies (`arn:<partition>:iam::aws:policy/...`)
    // outright — adopting one would let cdkd's destroy path attempt
    // `DeletePolicy` (always rejected by IAM) but only AFTER
    // `detachAllPrincipals` has forcibly detached the policy from every
    // user / role / group in the account. That's a major foot-gun (think
    // `AdministratorAccess`); the tag-based fallback path is already guarded
    // by `Scope: 'Local'`, and the explicit-ARN path needs the same guard.
    // The partition segment is matched across ALL partitions (issue #1815):
    // this predicate's miss direction is the dangerous one, so a GovCloud /
    // China `AdministratorAccess` ARN must trip it too.
    if (explicit.startsWith('arn:')) {
      if (AWS_MANAGED_POLICY_ARN_RE.test(explicit)) {
        throw new Error(
          `Refusing to import AWS-managed policy ${explicit}: cdkd only adopts customer-managed policies. ` +
            `If you need to attach an AWS-managed policy to a role / user / group, reference it via ManagedPolicyArns on the principal instead.`
        );
      }
      try {
        const resp = await this.iamClient.send(new GetPolicyCommand({ PolicyArn: explicit }));
        return { physicalId: explicit, attributes: managedPolicyAttributes(explicit, resp.Policy) };
      } catch (err) {
        if (err instanceof NoSuchEntityException) return null;
        throw err;
      }
    }
    // Otherwise treat as a policy name + walk customer-managed policies.
    const byName = await this.findPolicyByName(explicit);
    if (byName) {
      return { physicalId: byName.Arn, attributes: managedPolicyAttributes(byName.Arn, byName) };
    }
    return null;
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
  // tag never exists on a real resource and the walk could not match (issue
  // #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a managed
  // policy reaching here needs an explicit `--resource` override.
  return null;
}
