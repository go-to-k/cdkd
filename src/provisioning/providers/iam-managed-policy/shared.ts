import type { Policy } from '@aws-sdk/client-iam';
import { definedAttributes } from '../../attribute-map.js';
import { isoTimestampAttribute } from '../../attribute-timestamp.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { readPrincipalLists } from '../../iam-policy-targets.js';

/**
 * go-to-k/cdkd#6232: the `Fn::GetAtt` attributes a managed policy records —
 * `PolicyArn`, plus the `PolicyId` (`ANPA…`) and `DefaultVersionId` (`v1`,
 * `v2`, …) IAM reported for it. Neither can be built from the ARN, so one
 * the response did not carry is left ABSENT (`definedAttributes`): the
 * resolver then re-reads it rather than serving a placeholder.
 *
 * go-to-k/cdkd#6242: also `AttachmentCount` / `PermissionsBoundaryUsageCount`
 * (numbers), `IsAttachable` (boolean) and `CreateDate` / `UpdateDate`, all
 * from the same `Policy` IAM returned. The counts are as of that read, so a
 * caller hands in the policy as IAM reports it AFTER its own attach / detach
 * calls (`AttachmentCount` was 1 with one role attached, measured on real
 * CloudFormation 2026-11-14). The dates are IAM's ISO text
 * (`2026-11-14T07:49:22Z`): CloudFormation answers
 * `Optional[2026-11-14T07:49:22Z]` for both (measured 2026-11-14, a Java
 * `Optional` printed into the value); cdkd serves the date itself, the
 * maintainer's decision, so this is a deliberate divergence.
 */
export function managedPolicyAttributes(
  policyArn: string,
  policy: ManagedPolicyReadBack | undefined
): Record<string, unknown> {
  return definedAttributes({
    PolicyArn: policyArn,
    PolicyId: policyIdentityToken(policy?.PolicyId),
    DefaultVersionId:
      typeof policy?.DefaultVersionId === 'string' && policy.DefaultVersionId !== ''
        ? policy.DefaultVersionId
        : undefined,
    AttachmentCount: countOrUndefined(policy?.AttachmentCount),
    PermissionsBoundaryUsageCount: countOrUndefined(policy?.PermissionsBoundaryUsageCount),
    IsAttachable: typeof policy?.IsAttachable === 'boolean' ? policy.IsAttachable : undefined,
    CreateDate: isoTimestampAttribute(policy?.CreateDate),
    UpdateDate: isoTimestampAttribute(policy?.UpdateDate),
  });
}

/** The `Policy` members `managedPolicyAttributes` reads (IAM's `GetPolicy` / `CreatePolicy` shape). */
export type ManagedPolicyReadBack = Pick<
  Policy,
  | 'PolicyId'
  | 'DefaultVersionId'
  | 'AttachmentCount'
  | 'PermissionsBoundaryUsageCount'
  | 'IsAttachable'
  | 'CreateDate'
  | 'UpdateDate'
>;

/** The attribute keys IAM's `Policy` read-back supplies beyond `PolicyArn`. */
export const MANAGED_POLICY_READ_BACK_KEYS = [
  'PolicyId',
  'DefaultVersionId',
  'AttachmentCount',
  'PermissionsBoundaryUsageCount',
  'IsAttachable',
  'CreateDate',
  'UpdateDate',
] as const;

const countOrUndefined = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** A bag's three principal lists, read by literal key (see `readPrincipalLists`). */
export const principalsOf = (bag: Record<string, unknown>) =>
  readPrincipalLists({ Groups: bag['Groups'], Roles: bag['Roles'], Users: bag['Users'] });
export const PRINCIPAL_NAMES = 'group / role / user names';

/**
 * go-to-k/cdkd#4606 / #4655: a managed policy's identity token is its
 * `PolicyId` (`ANPA…`). IAM assigns it at `CreatePolicy` and never changes
 * it; one deleted and re-created under the same name gets another (IAM User
 * Guide, "IAM identifiers" → "Unique identifiers"; the
 * `iam-profile-policy-fix-forward-orphan` fixture measures the re-create).
 * The attach calls a CREATE makes afterwards do not touch it. `undefined` for
 * a missing or empty one.
 */
export function policyIdentityToken(id: string | undefined): string | undefined {
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * go-to-k/cdkd#6242: the policy as IAM reports it once this operation's
 * attach / detach / version calls are done, for {@link managedPolicyAttributes}.
 * `CreatePolicy`'s (or the pre-update) read-back holds the counts from BEFORE
 * those calls (`AttachmentCount: 0` on a policy this create then attaches to
 * a role), so a caller that changed an attachment or the default version
 * re-reads. Measured on real IAM (2026-11-14): a `GetPolicy` issued right
 * after `AttachRolePolicy` / `DetachRolePolicy` / `CreatePolicyVersion`
 * already reported the new `AttachmentCount` / `UpdateDate`.
 *
 * The operation itself succeeded, so a failed (or mismatched) read does not
 * fail it: `fallback` is used with the `stale` keys — those this operation
 * moved — dropped, and the resolver's heal re-reads them on a later deploy.
 */
export async function policyAfterWiring(
  getPolicy: (policyArn: string) => Promise<Policy | undefined>,
  policyArn: string,
  fallback: ManagedPolicyReadBack | undefined,
  stale: readonly ('AttachmentCount' | 'UpdateDate')[],
  /** A MASKED debug sink; no message names the policy (its ARN embeds the template's name). */
  debug: (message: string) => void
): Promise<ManagedPolicyReadBack | undefined> {
  try {
    const live = await getPolicy(policyArn);
    if (live?.Arn === policyArn) return live;
    debug('GetPolicy answered for another managed policy than the one asked for');
  } catch (error) {
    debug(
      `Could not re-read the managed policy after its attachments: ${describeAwsFailure(error).detail}`
    );
  }
  if (fallback === undefined) return undefined;
  const kept: ManagedPolicyReadBack = { ...fallback };
  for (const key of stale) kept[key] = undefined;
  return kept;
}
