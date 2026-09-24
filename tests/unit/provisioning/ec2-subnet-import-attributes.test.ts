import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DescribeSubnetsCommand } from '@aws-sdk/client-ec2';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

/**
 * Issue #3627: `import()` of a subnet returned no attributes, and the
 * resolver's Subnet arm builds only `SubnetId`, so after an import
 * `Fn::GetAtt [Subnet, AvailabilityZone]` resolved to the subnet id.
 */
describe('EC2Provider import() - AWS::EC2::Subnet attributes (issue #3627)', () => {
  beforeEach(() => mockSend.mockReset());

  it('records SubnetId / AvailabilityZone read back from DescribeSubnets', async () => {
    mockSend.mockResolvedValueOnce({
      Subnets: [{ SubnetId: 'subnet-0abc', AvailabilityZone: 'us-east-1a' }],
    });
    const result = await new EC2Provider().import({
      logicalId: 'Subnet',
      resourceType: 'AWS::EC2::Subnet',
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'subnet-0abc',
    });
    expect(result).toStrictEqual({
      physicalId: 'subnet-0abc',
      attributes: { SubnetId: 'subnet-0abc', AvailabilityZone: 'us-east-1a' },
    });
    expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(DescribeSubnetsCommand);
  });
});
