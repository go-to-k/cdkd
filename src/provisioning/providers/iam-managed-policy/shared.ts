import { definedAttributes } from '../../attribute-map.js';
import { readPrincipalLists } from '../../iam-policy-targets.js';

/**
 * go-to-k/cdkd#6232: the `Fn::GetAtt` attributes a managed policy records —
 * `PolicyArn`, plus the `PolicyId` (`ANPA…`) and `DefaultVersionId` (`v1`,
 * `v2`, …) IAM reported for it. Neither can be built from the ARN, so one
 * the response did not carry is left ABSENT (`definedAttributes`): the
 * resolver then re-reads it rather than serving a placeholder.
 */
export function managedPolicyAttributes(
  policyArn: string,
  policy: { PolicyId?: string | undefined; DefaultVersionId?: string | undefined } | undefined
): Record<string, unknown> {
  return definedAttributes({
    PolicyArn: policyArn,
    PolicyId: policyIdentityToken(policy?.PolicyId),
    DefaultVersionId:
      typeof policy?.DefaultVersionId === 'string' && policy.DefaultVersionId !== ''
        ? policy.DefaultVersionId
        : undefined,
  });
}

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
