import { EC2Client, DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import type { ContextProvider, ContextProviderAwsConfig } from './index.js';
import { getLogger } from '../../utils/logger.js';

/**
 * Security Group context provider
 *
 * Looks up security group details by ID.
 * CDK provider type: "security-group"
 */
export class SecurityGroupContextProvider implements ContextProvider {
  private logger = getLogger().child('SecurityGroupContextProvider');

  constructor(private awsConfig?: ContextProviderAwsConfig) {}

  async resolve(props: Record<string, unknown>): Promise<unknown> {
    const region = (props['region'] as string) || this.awsConfig?.region;
    const securityGroupId = props['securityGroupId'] as string | undefined;
    const securityGroupName = props['securityGroupName'] as string | undefined;
    const vpcId = props['vpcId'] as string | undefined;

    this.logger.debug(
      `Looking up security group (id: ${securityGroupId}, name: ${securityGroupName}, region: ${region})`
    );

    const client = new EC2Client({
      ...(region && { region }),
    });

    try {
      const filters = [];
      if (securityGroupId) {
        filters.push({ Name: 'group-id', Values: [securityGroupId] });
      }
      if (securityGroupName) {
        filters.push({ Name: 'group-name', Values: [securityGroupName] });
      }
      if (vpcId) {
        filters.push({ Name: 'vpc-id', Values: [vpcId] });
      }

      const response = await client.send(
        new DescribeSecurityGroupsCommand({
          ...(filters.length > 0 && { Filters: filters }),
          ...(securityGroupId && !securityGroupName && { GroupIds: [securityGroupId] }),
        })
      );

      const groups = response.SecurityGroups ?? [];
      if (groups.length === 0) {
        throw new Error(
          `No security group found (id: ${securityGroupId}, name: ${securityGroupName})`
        );
      }

      const sg = groups[0]!;
      this.logger.debug(`Resolved security group: ${sg.GroupId}`);

      return {
        securityGroupId: sg.GroupId,
        allowAllOutbound: (sg.IpPermissionsEgress ?? []).some(
          (perm) =>
            perm.IpProtocol === '-1' && (perm.IpRanges ?? []).some((r) => r.CidrIp === '0.0.0.0/0')
        ),
      };
    } finally {
      client.destroy();
    }
  }
}
