import type { IAMClient } from '@aws-sdk/client-iam';
import { compareMembershipWrites, type PolicyOwner } from './iam-policy/principal-identity.js';

/** go-to-k/cdkd#6722: the owner of the role memberships an instance profile writes. */
const PROFILE_OWNER: PolicyOwner = {
  label: 'IAM instance profile',
  resourceType: 'AWS::IAM::InstanceProfile',
  membership: true,
};

/**
 * go-to-k/cdkd#6722: `AddRoleToInstanceProfile` / `RemoveRoleFromInstanceProfile`
 * name each role, so every in-stack role a create or update of the profile
 * adds or removes is compared first ({@link compareMembershipWrites}): an
 * added role held by another id refuses with nothing written; a removed one
 * is warned about, and the answer says to send it no removal. That skip is
 * the update rule every membership follows (go-to-k/cdkd#6655): the template
 * names cdkd's role, so a removal is sent only to the role it names.
 *
 * A DELETE compares none: the roles it removes are the ones the live profile
 * holds (read from IAM, not names from state), right before deleting that
 * profile, which IAM refuses while it holds a role. Whichever role holds the
 * name, deleting the profile ends that link, so a compare could change no
 * write; refusing would only leave the profile undeletable and add a read per
 * role to every destroy. With an `InstanceProfileId` recorded, the profile
 * itself is proven cdkd's first.
 */
export async function compareProfileRoleWrites(params: {
  client: IAMClient;
  logicalId: string;
  physicalId: string;
  added: readonly string[];
  removed: readonly string[];
  warn: (message: string) => void;
}): Promise<(roleName: string) => boolean> {
  const skip = await compareMembershipWrites({
    client: params.client,
    owner: PROFILE_OWNER,
    logicalId: params.logicalId,
    physicalId: params.physicalId,
    adds: params.added.map((role) => [['role', role] as const]),
    removes: params.removed.map((role) => [['role', role] as const]),
    operation: 'update',
    warn: params.warn,
  });
  return (roleName) => skip([['role', roleName]]);
}
