import { readPrincipalLists } from '../../iam-policy-targets.js';

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
