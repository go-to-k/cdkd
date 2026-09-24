import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-efs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-efs')>(
    '@aws-sdk/client-efs'
  );
  return {
    ...actual,
    EFSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';

/**
 * Issue #3627: `import()` of an access point returned no attributes. Its
 * physical id is `fsap-...`, so the resolver's shape guard REFUSED
 * `Fn::GetAtt [AccessPoint, Arn]` after an import.
 */
describe('EFSProvider import() - AWS::EFS::AccessPoint attributes (issue #3627)', () => {
  beforeEach(() => mockSend.mockReset());

  it('records Arn / AccessPointId read back from DescribeAccessPoints', async () => {
    const arn = 'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0abc';
    mockSend.mockResolvedValueOnce({
      AccessPoints: [{ AccessPointId: 'fsap-0abc', AccessPointArn: arn }],
    });
    const result = await new EFSProvider().import({
      logicalId: 'Ap',
      resourceType: 'AWS::EFS::AccessPoint',
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'fsap-0abc',
    });
    expect(result).toStrictEqual({
      physicalId: 'fsap-0abc',
      attributes: { Arn: arn, AccessPointId: 'fsap-0abc' },
    });
  });
});
