/**
 * go-to-k/cdkd#6242: an RDS DB instance recorded only `Endpoint.Address`,
 * `Endpoint.Port` and `Arn`, so `Fn::GetAtt [Db, DbiResourceId]` — CDK's
 * `instanceResourceId`, which `grantConnect` builds its `rds-db:connect` ARN
 * from — resolved to the instance identifier. Create, update and `import()`
 * now record the same map through `dbInstanceAttributes`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockRdsSend } = vi.hoisted(() => ({ mockRdsSend: vi.fn() }));
vi.mock('@aws-sdk/client-rds', async () => ({
  ...(await vi.importActual('@aws-sdk/client-rds')),
  RDSClient: vi.fn(() => ({ send: mockRdsSend })),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { dbInstanceAttributes } from '../../../src/provisioning/providers/rds/instance-attributes.js';

const SETTLED = { settled: true } as const;

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
    expect(dbInstanceAttributes(FULL, SETTLED)).toStrictEqual({
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
      ReadReplicaDBInstanceIdentifiers: [],
      ReadReplicaDBClusterIdentifiers: [],
      StatusInfos: [],
    });
  });

  it('keeps a non-zero fraction in ValidTill, as Java prints an Instant', () => {
    const attrs = dbInstanceAttributes(
      { CertificateDetails: { ValidTill: new Date('2027-11-14T12:34:56.250Z') } },
      SETTLED
    );
    expect(attrs['CertificateDetails.ValidTill']).toBe('2027-11-14T12:34:56.250Z');
  });

  it('leaves an unreported value ABSENT, never an empty string', () => {
    expect(
      dbInstanceAttributes(
        { DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb' },
        SETTLED
      )
    ).toStrictEqual({
      Arn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
      ReadReplicaDBInstanceIdentifiers: [],
      ReadReplicaDBClusterIdentifiers: [],
      StatusInfos: [],
    });
    // No instance described: not even the lists.
    expect(dbInstanceAttributes(undefined, SETTLED)).toStrictEqual({});
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
    expect(result?.attributes).toStrictEqual(dbInstanceAttributes(FULL, SETTLED));
    expect(result?.attributes?.['DbiResourceId']).toBe('db-ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(mockRdsSend).toHaveBeenCalledTimes(1);
  });
});

/**
 * go-to-k/cdkd#6242 tail: the read-only scalars and lists CloudFormation
 * serves (measured on a real stack, us-east-1, 2026-11-14), recorded from the
 * same describe and gated where the value is a moment's status.
 */
const AVAILABLE = {
  ...FULL,
  DBInstanceStatus: 'available',
  InstanceCreateTime: new Date('2026-11-14T07:53:01.825Z'),
  LatestRestorableTime: new Date('2026-11-14T09:54:22.000Z'),
  IsStorageConfigUpgradeAvailable: false,
  ReadReplicaDBInstanceIdentifiers: ['replica-1'],
  ReadReplicaDBClusterIdentifiers: [],
  StatusInfos: [
    {
      StatusType: 'read replication',
      Normal: true,
      Status: 'replicating',
      Message: 'ok',
      Extra: 'not a documented member',
    },
  ],
  SecondaryAvailabilityZone: 'us-east-1b',
  AutomaticRestartTime: new Date('2026-11-21T07:53:01.000Z'),
  ResumeFullAutomationModeTime: new Date('2026-11-14T10:00:00.500Z'),
  PercentProgress: '42',
  StorageOperationStatus: 'optimizing',
  StorageOperationPercentProgress: 17,
};

describe('dbInstanceAttributes — the read-only scalars and lists (#6242 tail)', () => {
  it('records each under its CloudFormation name, type and timestamp text', () => {
    const attrs = dbInstanceAttributes(AVAILABLE, SETTLED);
    expect(attrs).toMatchObject({
      DBInstanceStatus: 'available',
      InstanceCreateTime: '2026-11-14T07:53:01.825Z',
      LatestRestorableTime: '2026-11-14T09:54:22Z',
      IsStorageConfigUpgradeAvailable: false,
      ReadReplicaDBInstanceIdentifiers: ['replica-1'],
      ReadReplicaDBClusterIdentifiers: [],
      SecondaryAvailabilityZone: 'us-east-1b',
      AutomaticRestartTime: '2026-11-21T07:53:01Z',
      ResumeFullAutomationModeTime: '2026-11-14T10:00:00.500Z',
      PercentProgress: '42',
      StorageOperationStatus: 'optimizing',
      StorageOperationPercentProgress: 17,
    });
    // Only the four documented members of a status entry.
    expect(attrs['StatusInfos']).toStrictEqual([
      { StatusType: 'read replication', Normal: true, Status: 'replicating', Message: 'ok' },
    ]);
  });

  it('copies the lists, so the record never aliases the SDK response', () => {
    const attrs = dbInstanceAttributes(AVAILABLE, SETTLED);
    expect(attrs['ReadReplicaDBInstanceIdentifiers']).not.toBe(
      AVAILABLE.ReadReplicaDBInstanceIdentifiers
    );
  });

  it('leaves a conditionally-present value ABSENT when AWS reports none', () => {
    const attrs = dbInstanceAttributes({ ...FULL, DBInstanceStatus: 'available' }, SETTLED);
    for (const key of [
      'SecondaryAvailabilityZone',
      'AutomaticRestartTime',
      'ResumeFullAutomationModeTime',
      'PercentProgress',
      'StorageOperationStatus',
      'StorageOperationPercentProgress',
      'LatestRestorableTime',
      'InstanceCreateTime',
      'IsStorageConfigUpgradeAvailable',
    ]) {
      expect(Object.hasOwn(attrs, key), key).toBe(false);
    }
  });

  it.each([
    ['an operation that did not wait (--no-wait)', { ...AVAILABLE }, { settled: false }],
    ['a read of an instance still modifying', { ...AVAILABLE, DBInstanceStatus: 'modifying' }, SETTLED],
    ['a read of an instance still creating', { ...AVAILABLE, DBInstanceStatus: 'creating' }, SETTLED],
  ])('does not record the transient values from %s', (_label, instance, read) => {
    const attrs = dbInstanceAttributes(instance, read);
    for (const key of [
      'DBInstanceStatus',
      'PercentProgress',
      'StorageOperationStatus',
      'StorageOperationPercentProgress',
    ]) {
      expect(Object.hasOwn(attrs, key), key).toBe(false);
    }
    // The settled facts are still recorded.
    expect(attrs['InstanceCreateTime']).toBe('2026-11-14T07:53:01.825Z');
    expect(attrs['ReadReplicaDBInstanceIdentifiers']).toStrictEqual(['replica-1']);
  });
});

describe('RDSProvider DBInstance writers record the #6242 tail attributes', () => {
  let originalNoWait: string | undefined;
  beforeEach(() => {
    mockRdsSend.mockReset();
    originalNoWait = process.env['CDKD_NO_WAIT'];
    delete process.env['CDKD_NO_WAIT'];
  });
  afterEach(() => {
    if (originalNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = originalNoWait;
  });

  it('create (waited) records the status and the rest', async () => {
    mockRdsSend.mockResolvedValueOnce({ DBInstance: { DBInstanceIdentifier: 'mydb' } });
    mockRdsSend.mockResolvedValue({ DBInstances: [AVAILABLE] });
    const result = await new RDSProvider().create('Db', 'AWS::RDS::DBInstance', {
      DBInstanceIdentifier: 'mydb',
      DBInstanceClass: 'db.t3.micro',
      Engine: 'postgres',
    });
    expect(result.attributes).toStrictEqual(dbInstanceAttributes(AVAILABLE, SETTLED));
    expect(result.attributes?.['DBInstanceStatus']).toBe('available');
  });

  it('create under --no-wait does not record the status even when RDS reads available', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    mockRdsSend.mockResolvedValueOnce({ DBInstance: { DBInstanceIdentifier: 'mydb' } });
    mockRdsSend.mockResolvedValue({ DBInstances: [AVAILABLE] });
    const result = await new RDSProvider().create('Db', 'AWS::RDS::DBInstance', {
      DBInstanceIdentifier: 'mydb',
      DBInstanceClass: 'db.t3.micro',
      Engine: 'postgres',
    });
    expect(Object.hasOwn(result.attributes ?? {}, 'DBInstanceStatus')).toBe(false);
    expect(result.attributes?.['InstanceCreateTime']).toBe('2026-11-14T07:53:01.825Z');
  });

  it.each([
    ['waited', undefined, true],
    ['--no-wait', 'true', false],
  ])('update (%s) returns the full map, the status only when it waited', async (_l, noWait, has) => {
    if (noWait !== undefined) process.env['CDKD_NO_WAIT'] = noWait;
    mockRdsSend.mockResolvedValue({ DBInstances: [AVAILABLE] });
    const result = await new RDSProvider().update(
      'Db',
      'mydb',
      'AWS::RDS::DBInstance',
      { DBInstanceClass: 'db.t3.small', Engine: 'postgres' },
      { DBInstanceClass: 'db.t3.micro', Engine: 'postgres' }
    );
    expect(result.attributes).toStrictEqual(
      dbInstanceAttributes(AVAILABLE, { settled: has })
    );
    expect(Object.hasOwn(result.attributes ?? {}, 'DBInstanceStatus')).toBe(has);
  });

  it('import() records the status of an available instance (a read, not an operation)', async () => {
    mockRdsSend.mockResolvedValueOnce({ DBInstances: [AVAILABLE] });
    const result = await new RDSProvider().import({
      logicalId: 'Db',
      resourceType: 'AWS::RDS::DBInstance',
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'mydb',
    });
    expect(result?.attributes?.['DBInstanceStatus']).toBe('available');
    expect(result?.attributes?.['StatusInfos']).toHaveLength(1);
  });
});
