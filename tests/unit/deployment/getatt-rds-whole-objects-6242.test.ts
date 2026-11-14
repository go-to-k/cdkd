import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { StaleAttributeHealOutcome } from '../../../src/deployment/stale-attribute-heal.js';
import { scrubResourceRecord } from '../../../src/deployment/secret-redaction/redact-state/scrub-record.js';
import {
  recordResolvedPair,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { dbInstanceAttributes } from '../../../src/provisioning/providers/rds/instance-attributes.js';
import { dbClusterAttributes } from '../../../src/provisioning/providers/rds/cluster-attributes.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
  }),
}));

/**
 * go-to-k/cdkd#6242 tail: the whole RDS `Endpoint` / `ListenerEndpoint` /
 * `CertificateDetails` / `ReadEndpoint` objects are served by assembling the
 * FLAT members the providers record, so an object and its dotted members come
 * from one recorded source. Shapes are CloudFormation's (measured, us-east-1,
 * 2026-11-14): members are strings.
 */
const INSTANCE = {
  DBInstanceIdentifier: 'mydb',
  DBInstanceStatus: 'available',
  DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
  Endpoint: { Address: 'mydb.x.us-east-1.rds.amazonaws.com', Port: 5432, HostedZoneId: 'Z2R2ITUGPM61AM' },
  CertificateDetails: {
    CAIdentifier: 'rds-ca-rsa2048-g1',
    ValidTill: new Date('2027-11-14T07:51:43.000Z'),
  },
  InstanceCreateTime: new Date('2026-11-14T07:53:01.825Z'),
  IsStorageConfigUpgradeAvailable: false,
};
const CLUSTER = {
  Endpoint: 'db.cluster-x.us-east-1.rds.amazonaws.com',
  ReaderEndpoint: 'db.cluster-ro-x.us-east-1.rds.amazonaws.com',
  Port: 5432,
  DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:db',
  StorageEncryptionType: 'sse-kms' as const,
};

const resolveAttr = (
  type: string,
  attributes: Record<string, unknown>,
  attribute: string,
  healer?: ResolverContext['attributeHealer']
): Promise<unknown> => {
  const context: ResolverContext = {
    template: { Resources: { X: { Type: type, Properties: {} } } },
    resources: {
      X: { physicalId: 'mydb', resourceType: type, properties: {}, attributes, dependencies: [] },
    },
    ...(healer && { attributeHealer: healer }),
  };
  return new IntrinsicFunctionResolver('us-east-1').resolve(
    { 'Fn::GetAtt': ['X', attribute] },
    context
  );
};

const healerReading = (attributes: Record<string, unknown>) =>
  vi.fn(async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'read', attributes }));

describe('whole RDS objects assembled from the recorded flat members (#6242)', () => {
  beforeEach(() => resetAccountInfoCache());

  it('DBInstance Endpoint / CertificateDetails, with the dotted members agreeing', async () => {
    const attrs = dbInstanceAttributes(INSTANCE, { settled: true });
    const endpoint = await resolveAttr('AWS::RDS::DBInstance', attrs, 'Endpoint');
    expect(endpoint).toStrictEqual({
      Address: 'mydb.x.us-east-1.rds.amazonaws.com',
      HostedZoneId: 'Z2R2ITUGPM61AM',
      Port: '5432',
    });
    for (const member of ['Address', 'HostedZoneId', 'Port'] as const) {
      await expect(resolveAttr('AWS::RDS::DBInstance', attrs, `Endpoint.${member}`)).resolves.toBe(
        (endpoint as Record<string, unknown>)[member]
      );
    }
    await expect(resolveAttr('AWS::RDS::DBInstance', attrs, 'CertificateDetails')).resolves.toStrictEqual({
      CAIdentifier: 'rds-ca-rsa2048-g1',
      ValidTill: '2027-11-14T07:51:43Z',
    });
  });

  it('DBCluster Endpoint / ReadEndpoint, from a record written before this change', async () => {
    // The pre-change map: no StorageEncryptionType, the same flat endpoints.
    const old = {
      'Endpoint.Address': CLUSTER.Endpoint,
      'Endpoint.Port': '5432',
      'ReadEndpoint.Address': CLUSTER.ReaderEndpoint,
      Arn: CLUSTER.DBClusterArn,
    };
    await expect(resolveAttr('AWS::RDS::DBCluster', old, 'Endpoint')).resolves.toStrictEqual({
      Address: CLUSTER.Endpoint,
      Port: '5432',
    });
    await expect(resolveAttr('AWS::RDS::DBCluster', old, 'ReadEndpoint')).resolves.toStrictEqual({
      Address: CLUSTER.ReaderEndpoint,
    });
    // ... and the dotted reads it served on main still answer.
    await expect(resolveAttr('AWS::RDS::DBCluster', old, 'Endpoint.Port')).resolves.toBe('5432');
    // A new record serves StorageEncryptionType too.
    await expect(
      resolveAttr('AWS::RDS::DBCluster', dbClusterAttributes(CLUSTER), 'StorageEncryptionType')
    ).resolves.toBe('sse-kms');
  });

  it('a record holding the whole object itself (the Cloud Control route) is served as recorded', async () => {
    const nested = { Endpoint: { Address: 'cc.example', Port: '5432' } };
    await expect(resolveAttr('AWS::RDS::DBCluster', nested, 'Endpoint')).resolves.toStrictEqual({
      Address: 'cc.example',
      Port: '5432',
    });
  });

  it('a record missing a member heals and assembles from the read instead of a partial object', async () => {
    // Written before `Endpoint.HostedZoneId` was recorded.
    const old = {
      'Endpoint.Address': 'mydb.x.us-east-1.rds.amazonaws.com',
      'Endpoint.Port': '5432',
      Arn: INSTANCE.DBInstanceArn,
    };
    const healer = healerReading(dbInstanceAttributes(INSTANCE, { settled: true }));
    await expect(resolveAttr('AWS::RDS::DBInstance', old, 'Endpoint', healer)).resolves.toStrictEqual({
      Address: 'mydb.x.us-east-1.rds.amazonaws.com',
      HostedZoneId: 'Z2R2ITUGPM61AM',
      Port: '5432',
    });
    expect(healer).toHaveBeenCalledTimes(1);
  });

  it('refuses when the heal reads no object, worded for a listener endpoint the instance lacks', async () => {
    const healer = healerReading(dbInstanceAttributes(INSTANCE, { settled: true }));
    await expect(
      resolveAttr('AWS::RDS::DBInstance', {}, 'ListenerEndpoint', healer)
    ).rejects.toThrow(/This DB instance has no listener endpoint/);
    await expect(
      resolveAttr('AWS::RDS::DBCluster', {}, 'ReadEndpoint', healerReading({}))
    ).rejects.toThrow(/RDS does not report it for the cluster yet/);
  });

  it('does not assemble for DocumentDB / Neptune, whose Endpoint is the address string', async () => {
    await expect(
      resolveAttr('AWS::DocDB::DBCluster', { Endpoint: 'd.docdb', 'Endpoint.Address': 'd.docdb' }, 'Endpoint')
    ).resolves.toBe('d.docdb');
    // Neptune's record holds no `Endpoint` key here: not assembled, so the
    // guarded fallback refuses it, as on main (never a partial object).
    await expect(
      resolveAttr('AWS::Neptune::DBCluster', { 'Endpoint.Address': 'n.neptune', 'Endpoint.Port': '8182' }, 'Endpoint')
    ).rejects.toThrow(/Cannot resolve Fn::GetAtt \[X, Endpoint\] for AWS::Neptune::DBCluster/);
  });

  it('a DocumentDB cluster record lacking Endpoint is not refused with the RDS cluster wording', async () => {
    const error = await resolveAttr('AWS::DocDB::DBCluster', {}, 'ReadEndpoint', healerReading({})).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(String(error)).not.toMatch(/RDS does not report it for the cluster yet/);
  });

  it("a member recorded as '' is not a partial object: the record heals", async () => {
    const attrs = { ...dbInstanceAttributes(INSTANCE, { settled: true }), 'Endpoint.HostedZoneId': '' };
    const healer = healerReading(dbInstanceAttributes(INSTANCE, { settled: true }));
    await expect(resolveAttr('AWS::RDS::DBInstance', attrs, 'Endpoint', healer)).resolves.toStrictEqual({
      Address: 'mydb.x.us-east-1.rds.amazonaws.com',
      HostedZoneId: 'Z2R2ITUGPM61AM',
      Port: '5432',
    });
    expect(healer).toHaveBeenCalledTimes(1);
  });

  it('ListenerEndpoint needs Address and Port; HostedZoneId (unmeasured) joins when recorded', async () => {
    const base = { 'ListenerEndpoint.Address': 'l.x', 'ListenerEndpoint.Port': '1433' };
    await expect(resolveAttr('AWS::RDS::DBInstance', base, 'ListenerEndpoint')).resolves.toStrictEqual({
      Address: 'l.x',
      Port: '1433',
    });
    await expect(
      resolveAttr('AWS::RDS::DBInstance', { ...base, 'ListenerEndpoint.HostedZoneId': 'Z1' }, 'ListenerEndpoint')
    ).resolves.toStrictEqual({ Address: 'l.x', HostedZoneId: 'Z1', Port: '1433' });
  });
});

describe('the DBInstance read-only scalars resolve as recorded, or heal (#6242)', () => {
  beforeEach(() => resetAccountInfoCache());

  it('keeps the JSON type of a list and a boolean', async () => {
    const attrs = dbInstanceAttributes(INSTANCE, { settled: true });
    await expect(
      resolveAttr('AWS::RDS::DBInstance', attrs, 'ReadReplicaDBInstanceIdentifiers')
    ).resolves.toStrictEqual([]);
    await expect(resolveAttr('AWS::RDS::DBInstance', attrs, 'StatusInfos')).resolves.toStrictEqual([]);
    await expect(
      resolveAttr('AWS::RDS::DBInstance', attrs, 'IsStorageConfigUpgradeAvailable')
    ).resolves.toBe(false);
    await expect(resolveAttr('AWS::RDS::DBInstance', attrs, 'InstanceCreateTime')).resolves.toBe(
      '2026-11-14T07:53:01.825Z'
    );
  });

  it('a --no-wait record lacking DBInstanceStatus heals it from the read of the available instance', async () => {
    const noWait = dbInstanceAttributes({ ...INSTANCE, DBInstanceStatus: 'creating' }, { settled: false });
    expect(Object.hasOwn(noWait, 'DBInstanceStatus')).toBe(false);
    const healer = healerReading(dbInstanceAttributes(INSTANCE, { settled: true }));
    await expect(
      resolveAttr('AWS::RDS::DBInstance', noWait, 'DBInstanceStatus', healer)
    ).resolves.toBe('available');
  });

  it('refuses a conditionally-present value AWS never reported (CloudFormation refuses it too)', async () => {
    const attrs = dbInstanceAttributes(INSTANCE, { settled: true });
    await expect(
      resolveAttr('AWS::RDS::DBInstance', attrs, 'SecondaryAvailabilityZone', healerReading(attrs))
    ).rejects.toThrow(/SecondaryAvailabilityZone/);
  });
});

describe('StatusInfos[].Message is value-scanned at persist (#6242)', () => {
  it('a resolved secret inside the AWS free text is redacted', () => {
    const plaintext = 'hunter2-very-secret-value';
    const token = '{{resolve:secretsmanager:db:SecretString:password}}';
    const secrets: RecordedSecretValues = new Map();
    secrets.set(plaintext, token);
    recordResolvedPair(secrets, token, plaintext);
    const attrs = dbInstanceAttributes(
      {
        ...INSTANCE,
        StatusInfos: [{ StatusType: 'read replication', Normal: false, Status: 'error', Message: `bad ${plaintext}` }],
      },
      { settled: true }
    );
    // Through the persist choke point's per-record scrub, as the deploy saves it.
    const persisted = scrubResourceRecord({ physicalId: 'db-1', properties: {}, attributes: attrs }, secrets)
      .attributes;
    expect(JSON.stringify(persisted)).not.toContain(plaintext);
    expect(JSON.stringify(persisted)).toContain('read replication');
  });
});
