import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-rds', async () => ({
  ...(await vi.importActual('@aws-sdk/client-rds')),
  RDSClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
    config: { region: () => Promise.resolve('us-east-1') },
  })),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';

/**
 * Issue #3627: `import()` of a DB cluster recorded nothing, and the resolver's
 * cluster arm builds only the ARN, so after an import every endpoint
 * `Fn::GetAtt` resolved to the cluster identifier.
 */
describe('RDSProvider import() - AWS::RDS::DBCluster attributes (issue #3627)', () => {
  beforeEach(() => mockSend.mockReset());

  it('records the map create() records, from DescribeDBClusters', async () => {
    mockSend.mockResolvedValueOnce({
      DBClusters: [
        {
          DBClusterIdentifier: 'db',
          Endpoint: 'db.cluster-x.us-east-1.rds.amazonaws.com',
          ReaderEndpoint: 'db.cluster-ro-x.us-east-1.rds.amazonaws.com',
          Port: 5432,
          DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:db',
          DbClusterResourceId: 'cluster-ABC',
        },
      ],
    });
    const result = await new RDSProvider().import({
      logicalId: 'C',
      resourceType: 'AWS::RDS::DBCluster',
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'db',
    });
    expect(result).toStrictEqual({
      physicalId: 'db',
      attributes: {
        'Endpoint.Address': 'db.cluster-x.us-east-1.rds.amazonaws.com',
        'Endpoint.Port': '5432',
        'ReadEndpoint.Address': 'db.cluster-ro-x.us-east-1.rds.amazonaws.com',
        Arn: 'arn:aws:rds:us-east-1:123456789012:cluster:db',
        DBClusterResourceId: 'cluster-ABC',
      },
    });
  });
});
