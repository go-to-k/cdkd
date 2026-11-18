import {
  UpdateSecurityGroupRuleDescriptionsEgressCommand,
  UpdateSecurityGroupRuleDescriptionsIngressCommand,
  type EC2Client,
  type IpPermission,
} from '@aws-sdk/client-ec2';
import { isNamedError } from './common.js';

/**
 * EC2's answer when no rule on the group matches the permission sent: the
 * rule was revoked out of band.
 */
const SG_RULE_PERMISSION_NOT_FOUND_NAMES: ReadonlySet<string> = new Set([
  'InvalidPermission.NotFound',
]);

/**
 * Change the description of an existing security group rule in place
 * (go-to-k/cdkd#6514), as CloudFormation does: the rule keeps its `sgr-` id and
 * is never absent. AWS finds the rule by the permission's identity and sets
 * the description `permission` carries; a source entry without one CLEARS it.
 *
 * `'not-found'` when no rule on the group matches (revoked out of band): the
 * caller authorizes it, which is what the revoke-and-authorize this replaced
 * did. Any other failure throws, for the caller to wrap and mask.
 */
export async function updateSgRuleDescription(
  client: EC2Client,
  groupId: string,
  direction: 'ingress' | 'egress',
  permission: IpPermission
): Promise<'updated' | 'not-found'> {
  const input = { GroupId: groupId, IpPermissions: [permission] };
  try {
    if (direction === 'egress') {
      await client.send(new UpdateSecurityGroupRuleDescriptionsEgressCommand(input));
    } else {
      await client.send(new UpdateSecurityGroupRuleDescriptionsIngressCommand(input));
    }
    return 'updated';
  } catch (error) {
    if (isNamedError(error, SG_RULE_PERMISSION_NOT_FOUND_NAMES)) return 'not-found';
    throw error;
  }
}
