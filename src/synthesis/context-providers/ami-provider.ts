import { EC2Client, DescribeImagesCommand } from '@aws-sdk/client-ec2';
import type { ContextProvider, ContextProviderAwsConfig } from './index.js';
import { getLogger } from '../../utils/logger.js';

/**
 * AMI context provider
 *
 * Searches for the most recent AMI matching filters.
 * CDK provider type: "ami"
 */
export class AmiContextProvider implements ContextProvider {
  private logger = getLogger().child('AmiContextProvider');

  constructor(private awsConfig?: ContextProviderAwsConfig) {}

  async resolve(props: Record<string, unknown>): Promise<string> {
    const region = (props['region'] as string) || this.awsConfig?.region;
    const owners = props['owners'] as string[] | undefined;
    const filters = props['filters'] as Record<string, string[]> | undefined;

    this.logger.debug(`Looking up AMI (region: ${region})`);

    const client = new EC2Client({
      ...(region && { region }),
    });

    try {
      const ec2Filters = filters
        ? Object.entries(filters).map(([name, values]) => ({ Name: name, Values: values }))
        : undefined;

      const response = await client.send(
        new DescribeImagesCommand({
          ...(owners && { Owners: owners }),
          ...(ec2Filters && { Filters: ec2Filters }),
        })
      );

      const images = (response.Images ?? [])
        .filter((img) => img.ImageId && img.CreationDate)
        .sort((a, b) => (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''));

      if (images.length === 0) {
        throw new Error('No AMI found matching the specified filters');
      }

      const imageId = images[0]!.ImageId!;
      this.logger.debug(`Resolved AMI: ${imageId}`);
      return imageId;
    } finally {
      client.destroy();
    }
  }
}
