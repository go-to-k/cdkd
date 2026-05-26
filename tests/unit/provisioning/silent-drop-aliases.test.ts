/**
 * Tests for the B-bucket alias-wiring fixes surfaced by issue #613's audit.
 *
 * Each test below confirms that when a user supplies the CFn-schema-canonical
 * property name (which the provider was silently dropping before the fix),
 * the value now flows through to the AWS SDK call. The provider continues
 * to accept the legacy / nested form as well for backward compatibility.
 *
 * The B-bucket entries fixed (per the audit at
 * https://github.com/go-to-k/cdkd/issues/613#issuecomment-4546004881):
 *
 *  - AWS::EC2::NetworkAclEntry:Icmp        (was reading `IcmpTypeCode`)
 *  - AWS::ECS::Service:PlacementStrategies (was reading `PlacementStrategy`)
 *  - AWS::Glue::Database:DatabaseName       (was reading only `DatabaseInput.Name`)
 *  - AWS::Glue::Table:Name                  (was reading only `TableInput.Name`)
 *  - AWS::Neptune::DBCluster:DBPort         (was reading only `Port`)
 *  - AWS::ElastiCache::SubnetGroup:Description
 *                                           (was reading `CacheSubnetGroupDescription` only)
 *  - AWS::S3Tables::Table:TableName         (was reading `Name`)
 *
 * The two remaining B-bucket entries (`EC2::SecurityGroupIngress:CidrIpv6`
 * and `:SourcePrefixListId`) only needed a `handledProperties` update — the
 * underlying create code already read them — so they are covered by the
 * codegen-driven `property-coverage` test instead of a behavioral test here.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockEc2Send = vi.hoisted(() => vi.fn());
const mockEcsSend = vi.hoisted(() => vi.fn());
const mockGlueSend = vi.hoisted(() => vi.fn());
const mockNeptuneSend = vi.hoisted(() => vi.fn());
const mockElastiCacheSend = vi.hoisted(() => vi.fn());
const mockS3TablesSend = vi.hoisted(() => vi.fn());
const mockStsSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ec2')>();
  return {
    ...actual,
    EC2Client: vi.fn().mockImplementation(() => ({
      send: mockEc2Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-ecs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ecs')>();
  return {
    ...actual,
    ECSClient: vi.fn().mockImplementation(() => ({
      send: mockEcsSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-glue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-glue')>();
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
      send: mockGlueSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-neptune', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-neptune')>();
  return {
    ...actual,
    NeptuneClient: vi.fn().mockImplementation(() => ({
      send: mockNeptuneSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-elasticache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-elasticache')>();
  return {
    ...actual,
    ElastiCacheClient: vi.fn().mockImplementation(() => ({
      send: mockElastiCacheSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-s3tables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3tables')>();
  return {
    ...actual,
    S3TablesClient: vi.fn().mockImplementation(() => ({
      send: mockS3TablesSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockEc2Send, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { GlueProvider } from '../../../src/provisioning/providers/glue-provider.js';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import { ElastiCacheProvider } from '../../../src/provisioning/providers/elasticache-provider.js';
import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';

describe('B-bucket silent-drop alias fixes (issue #613)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
  });

  describe('AWS::EC2::NetworkAclEntry:Icmp', () => {
    it('reads the CFn-schema-canonical `Icmp` key and passes Type/Code to the SDK', async () => {
      mockEc2Send.mockResolvedValueOnce({});
      const provider = new EC2Provider();

      await provider.create('MyRule', 'AWS::EC2::NetworkAclEntry', {
        NetworkAclId: 'acl-1',
        RuleNumber: 100,
        Protocol: 1,
        RuleAction: 'allow',
        Egress: false,
        Icmp: { Type: 3, Code: 0 },
      });

      const call = mockEc2Send.mock.calls[0][0];
      expect(call.constructor.name).toBe('CreateNetworkAclEntryCommand');
      expect(call.input.IcmpTypeCode).toEqual({ Type: 3, Code: 0 });
    });

    it('falls back to legacy `IcmpTypeCode` key (pre-#613-fix state-file backward compat)', async () => {
      // State files written by pre-#613-fix cdkd carry the legacy
      // `IcmpTypeCode` key in state.properties (the provider was
      // reading the AWS-API name from template properties). After
      // upgrade, a re-deploy reads state.properties and must still
      // route the ICMP rule through to AWS.
      mockEc2Send.mockResolvedValueOnce({});
      const provider = new EC2Provider();

      await provider.create('MyRule', 'AWS::EC2::NetworkAclEntry', {
        NetworkAclId: 'acl-1',
        RuleNumber: 100,
        Protocol: 1,
        RuleAction: 'allow',
        Egress: false,
        IcmpTypeCode: { Type: 8, Code: -1 },
      });

      const call = mockEc2Send.mock.calls[0][0];
      expect(call.input.IcmpTypeCode).toEqual({ Type: 8, Code: -1 });
    });
  });

  describe('AWS::ECS::Service:PlacementStrategies', () => {
    it('create: reads the CFn-schema-canonical (plural) key and passes it to placementStrategy', async () => {
      mockEcsSend.mockResolvedValueOnce({
        service: {
          serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
          serviceName: 'my-service',
        },
      });
      const provider = new ECSProvider();

      await provider.create('MyService', 'AWS::ECS::Service', {
        Cluster: 'my-cluster',
        TaskDefinition: 'my-task:1',
        DesiredCount: 1,
        LaunchType: 'EC2',
        PlacementStrategies: [{ type: 'spread', field: 'instanceId' }],
      });

      const call = mockEcsSend.mock.calls.find((c) => c[0].constructor.name === 'CreateServiceCommand')?.[0];
      expect(call).toBeDefined();
      expect(call.input.placementStrategy).toEqual([{ type: 'spread', field: 'instanceId' }]);
    });

    it('update: reads the CFn-schema-canonical (plural) key and passes it to placementStrategy', async () => {
      mockEcsSend.mockResolvedValueOnce({
        service: {
          serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
          serviceName: 'my-service',
        },
      });
      const provider = new ECSProvider();

      await provider.update(
        'MyService',
        'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
        'AWS::ECS::Service',
        {
          Cluster: 'my-cluster',
          TaskDefinition: 'my-task:2',
          DesiredCount: 2,
          LaunchType: 'EC2',
          PlacementStrategies: [{ type: 'binpack', field: 'cpu' }],
        },
        {} // previousProperties — irrelevant for this test
      );

      const call = mockEcsSend.mock.calls.find((c) => c[0].constructor.name === 'UpdateServiceCommand')?.[0];
      expect(call).toBeDefined();
      expect(call.input.placementStrategy).toEqual([{ type: 'binpack', field: 'cpu' }]);
    });
  });

  describe('AWS::Glue::Database:DatabaseName', () => {
    it('falls back to top-level `DatabaseName` when nested `DatabaseInput.Name` is absent', async () => {
      mockGlueSend.mockResolvedValueOnce({});
      const provider = new GlueProvider();

      await provider.create('MyDatabase', 'AWS::Glue::Database', {
        DatabaseName: 'top_level_name',
        DatabaseInput: { Description: 'no Name field here' },
      });

      const call = mockGlueSend.mock.calls[0][0];
      expect(call.constructor.name).toBe('CreateDatabaseCommand');
      expect(call.input.DatabaseInput.Name).toBe('top_level_name');
    });

    it('prefers nested `DatabaseInput.Name` when both are set (backward compat)', async () => {
      mockGlueSend.mockResolvedValueOnce({});
      const provider = new GlueProvider();

      await provider.create('MyDatabase', 'AWS::Glue::Database', {
        DatabaseName: 'top_level',
        DatabaseInput: { Name: 'nested_canonical' },
      });

      const call = mockGlueSend.mock.calls[0][0];
      expect(call.input.DatabaseInput.Name).toBe('nested_canonical');
    });
  });

  describe('AWS::Glue::Table:Name', () => {
    it('falls back to top-level `Name` when nested `TableInput.Name` is absent (plumbs into TableInput SDK input)', async () => {
      mockGlueSend.mockResolvedValueOnce({});
      const provider = new GlueProvider();

      const result = await provider.create('MyTable', 'AWS::Glue::Table', {
        DatabaseName: 'my_db',
        Name: 'top_level_table',
        TableInput: { Description: 'no Name field here' },
      });

      const call = mockGlueSend.mock.calls[0][0];
      expect(call.constructor.name).toBe('CreateTableCommand');
      // The resolved name must reach the SDK call's TableInput.Name —
      // buildTableInput receives a fallbackName so the SDK side is
      // never called with TableInput.Name === undefined.
      expect(call.input.TableInput.Name).toBe('top_level_table');
      // Physical-id round-trip lock: confirms the resolved name is the
      // same value that flowed into both the SDK call and cdkd state.
      expect(result.physicalId).toBe('my_db|top_level_table');
    });

    it('prefers nested `TableInput.Name` when both are set (backward compat)', async () => {
      mockGlueSend.mockResolvedValueOnce({});
      const provider = new GlueProvider();

      const result = await provider.create('MyTable', 'AWS::Glue::Table', {
        DatabaseName: 'my_db',
        Name: 'top_level',
        TableInput: { Name: 'nested_canonical' },
      });

      const call = mockGlueSend.mock.calls[0][0];
      expect(call.input.TableInput.Name).toBe('nested_canonical');
      expect(result.physicalId).toBe('my_db|nested_canonical');
    });
  });

  describe('AWS::Neptune::DBCluster:DBPort', () => {
    // CreateDBCluster path also issues DescribeDBClusters in
    // waitForClusterAvailable + readback. Queue the Create response
    // (must include `DBCluster`) and then DescribeDBClusters responses
    // so the post-create waitForClusterAvailable resolves on first poll.
    const queueAvailableClusterResponses = () => {
      mockNeptuneSend.mockResolvedValueOnce({
        DBCluster: {
          DBClusterIdentifier: 'my-cluster',
          Status: 'creating',
        },
      });
      mockNeptuneSend.mockResolvedValue({
        DBClusters: [
          {
            DBClusterIdentifier: 'my-cluster',
            Status: 'available',
            Endpoint: 'my-cluster.cluster.us-east-1.neptune.amazonaws.com',
            Port: 8182,
          },
        ],
      });
    };

    it('reads the CFn-schema-canonical `DBPort` key and passes it to SDK `Port`', async () => {
      queueAvailableClusterResponses();
      const provider = new NeptuneProvider();

      await provider.create('MyCluster', 'AWS::Neptune::DBCluster', {
        DBClusterIdentifier: 'my-cluster',
        DBSubnetGroupName: 'my-subnet-group',
        DBPort: 9999,
      });

      const createCall = mockNeptuneSend.mock.calls.find(
        (c) => c[0].constructor.name === 'CreateDBClusterCommand'
      )?.[0];
      expect(createCall).toBeDefined();
      expect(createCall.input.Port).toBe(9999);
    });

    it('falls back to legacy `Port` key when `DBPort` is absent (backward compat)', async () => {
      queueAvailableClusterResponses();
      const provider = new NeptuneProvider();

      await provider.create('MyCluster', 'AWS::Neptune::DBCluster', {
        DBClusterIdentifier: 'my-cluster',
        DBSubnetGroupName: 'my-subnet-group',
        Port: 8182,
      });

      const createCall = mockNeptuneSend.mock.calls.find(
        (c) => c[0].constructor.name === 'CreateDBClusterCommand'
      )?.[0];
      expect(createCall).toBeDefined();
      expect(createCall.input.Port).toBe(8182);
    });
  });

  describe('AWS::ElastiCache::SubnetGroup:Description', () => {
    it('reads the CFn-schema-canonical `Description` key and passes it to SDK `CacheSubnetGroupDescription`', async () => {
      mockElastiCacheSend.mockResolvedValueOnce({});
      const provider = new ElastiCacheProvider();

      await provider.create('MySubnetGroup', 'AWS::ElastiCache::SubnetGroup', {
        CacheSubnetGroupName: 'my-sg',
        Description: 'CFn-canonical description',
        SubnetIds: ['subnet-1', 'subnet-2'],
      });

      const call = mockElastiCacheSend.mock.calls[0][0];
      expect(call.constructor.name).toBe('CreateCacheSubnetGroupCommand');
      expect(call.input.CacheSubnetGroupDescription).toBe('CFn-canonical description');
    });

    it('falls back to legacy `CacheSubnetGroupDescription` when `Description` is absent', async () => {
      mockElastiCacheSend.mockResolvedValueOnce({});
      const provider = new ElastiCacheProvider();

      await provider.create('MySubnetGroup', 'AWS::ElastiCache::SubnetGroup', {
        CacheSubnetGroupName: 'my-sg',
        CacheSubnetGroupDescription: 'legacy description',
        SubnetIds: ['subnet-1', 'subnet-2'],
      });

      const call = mockElastiCacheSend.mock.calls[0][0];
      expect(call.input.CacheSubnetGroupDescription).toBe('legacy description');
    });

    it('update: reads CFn-canonical `Description` and passes it to ModifyCacheSubnetGroup', async () => {
      mockElastiCacheSend.mockResolvedValueOnce({});
      const provider = new ElastiCacheProvider();

      await provider.update(
        'MySubnetGroup',
        'my-sg',
        'AWS::ElastiCache::SubnetGroup',
        {
          CacheSubnetGroupName: 'my-sg',
          Description: 'updated CFn-canonical',
          SubnetIds: ['subnet-1', 'subnet-2', 'subnet-3'],
        },
        {} // previousProperties — irrelevant for this test
      );

      const call = mockElastiCacheSend.mock.calls.find(
        (c) => c[0].constructor.name === 'ModifyCacheSubnetGroupCommand'
      )?.[0];
      expect(call).toBeDefined();
      expect(call.input.CacheSubnetGroupDescription).toBe('updated CFn-canonical');
    });
  });

  describe('AWS::S3Tables::Table:TableName', () => {
    it('reads the CFn-schema-canonical `TableName` key and passes it to SDK `name`', async () => {
      mockS3TablesSend.mockResolvedValueOnce({});
      const provider = new S3TablesProvider();

      await provider.create('MyTable', 'AWS::S3Tables::Table', {
        TableBucketARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket',
        Namespace: 'my_ns',
        TableName: 'cfn_canonical_table',
        Format: 'ICEBERG',
      });

      const call = mockS3TablesSend.mock.calls[0][0];
      expect(call.constructor.name).toBe('CreateTableCommand');
      expect(call.input.name).toBe('cfn_canonical_table');
    });
  });
});
