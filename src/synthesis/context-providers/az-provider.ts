import { EC2Client, DescribeAvailabilityZonesCommand } from '@aws-sdk/client-ec2';
import type { ContextProvider, ContextProviderAwsConfig } from './index.js';
import { getLogger } from '../../utils/logger.js';

/**
 * Availability Zones context provider
 *
 * Returns available AZ names for a region.
 * CDK provider type: "availability-zones"
 */
export class AZContextProvider implements ContextProvider {
  private logger = getLogger().child('AZContextProvider');

  constructor(private awsConfig?: ContextProviderAwsConfig) {}

  async resolve(props: Record<string, unknown>): Promise<string[]> {
    const region = (props['region'] as string) || this.awsConfig?.region;

    this.logger.debug(`Fetching availability zones for region: ${region}`);

    const client = new EC2Client({
      ...(region && { region }),
    });

    try {
      const response = await client.send(new DescribeAvailabilityZonesCommand({}));

      const azs = (response.AvailabilityZones ?? [])
        .filter((az) => az.State === 'available')
        .map((az) => az.ZoneName!)
        .filter(Boolean)
        .sort();

      this.logger.debug(`Found ${azs.length} availability zones: ${azs.join(', ')}`);
      return azs;
    } finally {
      client.destroy();
    }
  }
}
