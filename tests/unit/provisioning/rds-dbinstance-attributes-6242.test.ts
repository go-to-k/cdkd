/**
 * go-to-k/cdkd#6242: an RDS DB instance recorded only `Endpoint.Address`,
 * `Endpoint.Port` and `Arn`, so `Fn::GetAtt [Db, DbiResourceId]` — CDK's
 * `instanceResourceId`, which `grantConnect` builds its `rds-db:connect` ARN
 * from — resolved to the instance identifier. Create, update and `import()`
 * now record the same map through `dbInstanceAttributes`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockRdsSend } = vi.hoisted(() => ({ mockRdsSend: vi.fn() }));
vi.mock('@aws-sdk/client-rds', async () => ({
  ...(await vi.importActual('@aws-sdk/client-rds')),
  RDSClient: vi.fn().mockImplementation(() => ({ send: mockRdsSend })),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { dbInstanceAttributes } from '../../../src/provisioning/providers/rds/instance-attributes.js';

const FULL = {
  DBInstanceIdentifier: 'mydb',
  DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
  DbiResourceId: 'db-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  Endpoint: { Address: 'mydb.x.us-east-1.rds.amazonaws.com', Port: 5432, HostedZoneId: 'Z2R2ITUGPM61AM' },
  ListenerEndpoint: { Address: 'listener.x', Port: 1433, HostedZoneId: 'Z2R2ITUGPM61AM' },
  CertificateDetails: {
    CAIdentifier: 'rds-ca-rsa2048-g1',
    ValidTill: new Date('2027-11-14T12:34:56.000Z'),
  },
};

describe('dbInstanceAttributes (#6242)', () => {
  it('records every attribute the instance reports, under its CloudFormation name', () => {
    expect(dbInstanceAttributes(FULL)).toStrictEqual({
      'Endpoint.Address': 'mydb.x.us-east-1.rds.amazonaws.com',
      'Endpoint.Port': '5432',
      'Endpoint.HostedZoneId': 'Z2R2ITUGPM61AM',
      Arn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
      DbiResourceId: 'db-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'ListenerEndpoint.Address': 'listener.x',
      'ListenerEndpoint.Port': '1433',
      'ListenerEndpoint.HostedZoneId': 'Z2R2ITUGPM61AM',
      'CertificateDetails.CAIdentifier': 'rds-ca-rsa2048-g1',
      'CertificateDetails.ValidTill': '2027-11-14T12:34:56Z',
    });
  });

  it('keeps a non-zero fraction in ValidTill, as Java prints an Instant', () => {
    const attrs = dbInstanceAttributes({
      CertificateDetails: { ValidTill: new Date('2027-11-14T12:34:56.250Z') },
    });
    expect(attrs['CertificateDetails.ValidTill']).toBe('2027-11-14T12:34:56.250Z');
  });

  it('leaves an unreported value ABSENT, never an empty string', () => {
    expect(
      dbInstanceAttributes({ DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb' })
    ).toStrictEqual({ Arn: 'arn:aws:rds:us-east-1:123456789012:db:mydb' });
    expect(dbInstanceAttributes(undefined)).toStrictEqual({});
  });
});

describe('RDSProvider import() records the #6242 attributes', () => {
  beforeEach(() => mockRdsSend.mockReset());

  it('returns DbiResourceId and the rest from the describe it already issues', async () => {
    mockRdsSend.mockResolvedValueOnce({ DBInstances: [FULL] });
    const result = await new RDSProvider().import({
      logicalId: 'Db',
      resourceType: 'AWS::RDS::DBInstance',
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'mydb',
    });
    expect(result?.attributes).toStrictEqual(dbInstanceAttributes(FULL));
    expect(result?.attributes?.['DbiResourceId']).toBe('db-ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(mockRdsSend).toHaveBeenCalledTimes(1);
  });
});
