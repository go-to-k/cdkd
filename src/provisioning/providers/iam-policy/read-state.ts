import type { IAMPolicyProvider } from '../iam-policy-provider.js';
import {
  GetRolePolicyCommand,
  GetGroupPolicyCommand,
  GetUserPolicyCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { readPolicyTargetLists } from './shared.js';

/**
 * Read the AWS-current IAM inline policy in CFn-property shape.
 *
 * `AWS::IAM::Policy` is an inline policy attached to one or more roles /
 * groups / users via `PutRolePolicy` / `PutGroupPolicy` / `PutUserPolicy`.
 * Each attachment is a separate API call, but the same `PolicyDocument`
 * is replicated across every target.
 *
 * Strategy: pick the FIRST target from `properties.Roles` / `Groups` /
 * `Users` (in that order), call `Get*Policy(target, policyName)`, and
 * surface the URL-decoded + JSON-parsed `PolicyDocument`. Roles / Groups /
 * Users are echoed back from state since AWS doesn't return them. This is
 * defensible because:
 *   - Drift on `PolicyDocument`: caught — the document is the same on
 *     every target, so reading any one of them surfaces the divergence.
 *   - Drift on the target list (a role removed / added out-of-band): NOT
 *     caught. There's no API to enumerate every role / group / user that
 *     has an inline policy of a given name; cdkd would need to walk the
 *     entire account. Out of scope for v1.
 *
 * Returns `RESOURCE_NOT_FOUND` when the resolved target has no inline
 * policy of that name (`NoSuchEntityException`).
 */
export async function readCurrentState(
  this: IAMPolicyProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  if (!properties) return undefined;

  const policyDocument = properties['PolicyDocument'];
  if (!policyDocument) return undefined;

  // physicalId may be in legacy "policyName:roleName" format
  const policyName = physicalId.includes(':') ? physicalId.split(':')[0]! : physicalId;

  // A malformed recorded list is drift UNKNOWN: reading its first "name"
  // would read ANOTHER principal's same-named policy (go-to-k/cdkd#3878).
  const targets = readPolicyTargetLists(properties);
  if ('malformed' in targets) return undefined;
  const { roles, groups, users } = targets;

  let liveDocument: unknown;

  try {
    if (roles && roles.length > 0) {
      const resp = await this.iamClient.send(
        new GetRolePolicyCommand({ RoleName: roles[0]!, PolicyName: policyName })
      );
      liveDocument = this.decodePolicyDocument(resp.PolicyDocument);
    } else if (groups && groups.length > 0) {
      const resp = await this.iamClient.send(
        new GetGroupPolicyCommand({ GroupName: groups[0]!, PolicyName: policyName })
      );
      liveDocument = this.decodePolicyDocument(resp.PolicyDocument);
    } else if (users && users.length > 0) {
      const resp = await this.iamClient.send(
        new GetUserPolicyCommand({ UserName: users[0]!, PolicyName: policyName })
      );
      liveDocument = this.decodePolicyDocument(resp.PolicyDocument);
    } else {
      // No targets in state — cannot resolve; skip.
      return undefined;
    }
  } catch (err) {
    if (err instanceof NoSuchEntityException) return RESOURCE_NOT_FOUND;
    throw err;
  }

  if (liveDocument === undefined) return undefined;

  const result: Record<string, unknown> = {
    PolicyName: policyName,
    PolicyDocument: liveDocument,
  };
  // Echo the recorded targets back so the comparator's intersection of
  // state-side keys against AWS-side keys does not surface false drift on
  // Roles / Groups / Users. AWS has no API to enumerate the full target
  // set for a named inline policy — see method docstring.
  if (roles) result['Roles'] = roles;
  if (groups) result['Groups'] = groups;
  if (users) result['Users'] = users;
  return result;
}

/**
 * IAM Get*Policy returns the policy document as a URL-encoded JSON string
 * (per RFC 3986). Decode and parse it back into the object shape cdkd
 * state holds, so the drift comparator sees apples-to-apples.
 */
export function decodePolicyDocument(this: IAMPolicyProvider, raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    // Defensive: if decoding fails, surface the raw string and let the
    // comparator show the divergence rather than swallowing the error.
    return raw;
  }
}

/**
 * Adopt an existing IAM inline policy into cdkd state.
 *
 * **Explicit override only.** `AWS::IAM::Policy` in CloudFormation is an
 * inline policy attached to roles / groups / users — not a standalone
 * resource. Inline policies are not taggable and have no global identity,
 * so tag-based auto-lookup via `aws:cdk:path` is not feasible. Users
 * adopting inline policies must pass `--resource <logicalId>=<policyName>`
 * (the physical id is the policy name itself).
 *
 * For standalone managed policies (`AWS::IAM::ManagedPolicy`), the
 * Cloud Control API fallback handles import via the same explicit
 * override mode.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
export async function importImpl(
  this: IAMPolicyProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    return { physicalId: input.knownPhysicalId, attributes: {} };
  }
  return null;
}
