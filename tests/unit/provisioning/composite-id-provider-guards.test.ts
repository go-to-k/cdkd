import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Deploy-time refusal of a composite physicalId whose segment carries cdkd's
 * `|` separator (issue #1672) — one adopting provider per touched file.
 *
 * Every `throws` case below RECORDED an ambiguous id before the fix and the
 * deploy SUCCEEDED, so each is a regression fence, not a shape assertion. The
 * `expect(send).not.toHaveBeenCalled()` assertions are load-bearing too: the
 * refusal has to run BEFORE the AWS call, or a throw would leave a created
 * resource behind with no state record.
 */

const mockGlueSend = vi.hoisted(() => vi.fn());
const mockS3TablesSend = vi.hoisted(() => vi.fn());
const mockAppSyncSend = vi.hoisted(() => vi.fn());
const mockEc2Send = vi.hoisted(() => vi.fn());
const mockApiGatewaySend = vi.hoisted(() => vi.fn());
const mockLambdaSend = vi.hoisted(() => vi.fn());
const mockRoute53Send = vi.hoisted(() => vi.fn());
const mockStsSend = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());

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

vi.mock('@aws-sdk/client-appsync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-appsync')>();
  return {
    ...actual,
    AppSyncClient: vi.fn().mockImplementation(() => ({
      send: mockAppSyncSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-route-53', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-route-53')>();
  return {
    ...actual,
    Route53Client: vi.fn().mockImplementation(() => ({
      send: mockRoute53Send,
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

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockEc2Send, config: { region: () => Promise.resolve('us-east-1') } },
    apiGateway: {
      send: mockApiGatewaySend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    lambda: { send: mockLambdaSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLoggerWarn,
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

import { GlueProvider } from '../../../src/provisioning/providers/glue-provider.js';
import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import { LambdaEventInvokeConfigProvider } from '../../../src/provisioning/providers/lambda-event-invoke-config-provider.js';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { compositeIdSeparatorRefusal } from '../../../src/provisioning/composite-id.js';

/** The context the rollback executor's reverse-replacement create passes. */
const REPLAY = { replayingState: true } as const;

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` does NOT drain a `mockResolvedValueOnce` queue, so every
  // shared send mock is reset outright (issue #1618). Each test that needs a
  // response primes its own, and consumes it.
  mockGlueSend.mockReset();
  mockS3TablesSend.mockReset();
  mockAppSyncSend.mockReset();
  mockEc2Send.mockReset();
  mockApiGatewaySend.mockReset();
  mockLambdaSend.mockReset();
  mockRoute53Send.mockReset();
  mockStsSend.mockReset();
  mockStsSend.mockResolvedValue({ Account: '123456789012' });
});

describe('AWS::Glue::Table composite id guard', () => {
  it('refuses a table name containing the separator, before CreateTable runs', async () => {
    const provider = new GlueProvider();
    await expect(
      provider.create('MyTable', 'AWS::Glue::Table', {
        DatabaseName: 'mydb',
        TableInput: { Name: 'a|b' },
      })
    ).rejects.toThrow(/tableName 'a\|b'/);
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  it('refuses a database name containing the separator', async () => {
    const provider = new GlueProvider();
    await expect(
      provider.create('MyTable', 'AWS::Glue::Table', {
        DatabaseName: 'my|db',
        TableInput: { Name: 'orders' },
      })
    ).rejects.toThrow(ProvisioningError);
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  it('still records a clean composite id', async () => {
    mockGlueSend.mockResolvedValueOnce({});
    const provider = new GlueProvider();
    const result = await provider.create('MyTable', 'AWS::Glue::Table', {
      DatabaseName: 'mydb',
      TableInput: { Name: 'orders' },
    });
    expect(result.physicalId).toBe('mydb|orders');
  });

  it('downgrades to a warning on a state replay', async () => {
    // The reverse-replacement rollback arm: the properties are a cdkd STATE
    // record, so refusing would leave the old table unrestorable with only a
    // hand-edit of state.json as a remedy.
    mockGlueSend.mockResolvedValueOnce({});
    const provider = new GlueProvider();
    const result = await provider.create(
      'MyTable',
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { Name: 'a|b' } },
      REPLAY
    );
    expect(result.physicalId).toBe('mydb|a|b');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("tableName 'a|b'"));
  });
});

describe('AWS::S3Tables::* composite id guard', () => {
  it('downgrades a namespace refusal to a warning on a state replay', async () => {
    // `S3TablesProvider.create` gained its `CreateContext` parameter for this:
    // the refusal is structurally unreachable, but a MISSING parameter is its
    // own failure mode (no type error, no warning, a refusal that still fires
    // on a replay), so the wiring is pinned rather than reasoned about.
    mockS3TablesSend.mockResolvedValueOnce({});
    const provider = new S3TablesProvider();
    const result = await provider.create(
      'Ns',
      'AWS::S3Tables::Namespace',
      {
        TableBucketARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b',
        Namespace: 'a|b',
      },
      REPLAY
    );
    expect(result.physicalId).toBe('arn:aws:s3tables:us-east-1:123456789012:bucket/b|a|b');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("namespace 'a|b'"));
  });

  it('downgrades a table refusal to a warning on a state replay', async () => {
    mockS3TablesSend.mockResolvedValueOnce({
      tableARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/t1',
    });
    const provider = new S3TablesProvider();
    const result = await provider.create(
      'Tbl',
      'AWS::S3Tables::Table',
      {
        TableBucketARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b',
        Namespace: 'analytics',
        TableName: 'a|b',
        OpenTableFormat: 'ICEBERG',
      },
      REPLAY
    );
    expect(result.physicalId).toBe(
      'arn:aws:s3tables:us-east-1:123456789012:bucket/b|analytics|a|b'
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("name 'a|b'"));
  });

  it('skips an importNamespace whose composite carries the separator', async () => {
    // Unreachable through `parseNamespaceCompositeId`'s exact-two-part split,
    // so the guard is driven directly to prove it is wired at all — deleting it
    // would otherwise be undetectable.
    const provider = new S3TablesProvider();
    const refusal = compositeIdSeparatorRefusal('AWS::S3Tables::Namespace', 'Ns', [
      { name: 'tableBucketARN', value: 'arn:aws:s3tables:us-east-1:1:bucket/b' },
      { name: 'namespace', value: 'a|b' },
    ]);
    expect(refusal).toContain("namespace 'a|b'");

    // And the reachable half: a well-formed composite still adopts, so the
    // guard cannot be "passing" by refusing everything.
    mockS3TablesSend.mockResolvedValueOnce({});
    const result = await provider.import({
      logicalId: 'Ns',
      resourceType: 'AWS::S3Tables::Namespace',
      knownPhysicalId: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b|analytics',
      properties: {},
      stackName: 'TestStack',
      region: 'us-east-1',
    });
    expect(result?.physicalId).toBe(
      'arn:aws:s3tables:us-east-1:123456789012:bucket/b|analytics'
    );
  });

  it('refuses a namespace containing the separator, before CreateNamespace runs', async () => {
    const provider = new S3TablesProvider();
    await expect(
      provider.create('Ns', 'AWS::S3Tables::Namespace', {
        TableBucketARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b',
        Namespace: 'a|b',
      })
    ).rejects.toThrow(/namespace 'a\|b'/);
    expect(mockS3TablesSend).not.toHaveBeenCalled();
  });

  it('refuses a table name containing the separator, before CreateTable runs', async () => {
    const provider = new S3TablesProvider();
    await expect(
      provider.create('Tbl', 'AWS::S3Tables::Table', {
        TableBucketARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b',
        Namespace: 'analytics',
        TableName: 'a|b',
        OpenTableFormat: 'ICEBERG',
      })
    ).rejects.toThrow(/name 'a\|b'/);
    expect(mockS3TablesSend).not.toHaveBeenCalled();
  });

  it('skips an import whose GetTable-derived identity carries the separator', async () => {
    // The import path warns and returns null (`skipped-not-found`) rather than
    // throwing: that is this method's answer to every other unusable id, and a
    // throw would abort the whole `cdkd import` over one row.
    mockS3TablesSend.mockResolvedValueOnce({
      tableARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/t1',
      namespace: ['a|b'],
      name: 'orders',
    });
    const provider = new S3TablesProvider();
    const result = await provider.import({
      logicalId: 'Tbl',
      resourceType: 'AWS::S3Tables::Table',
      knownPhysicalId: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/t1',
      properties: {},
      stackName: 'TestStack',
      region: 'us-east-1',
    });
    expect(result).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("namespace 'a|b'"));
  });
});

describe('AWS::AppSync::* composite id guard', () => {
  it('refuses a DataSource name containing the separator, before CreateDataSource runs', async () => {
    const provider = new AppSyncProvider();
    await expect(
      provider.create('Ds', 'AWS::AppSync::DataSource', {
        ApiId: 'api1',
        Name: 'a|b',
        Type: 'NONE',
      })
    ).rejects.toThrow(/name 'a\|b'/);
    expect(mockAppSyncSend).not.toHaveBeenCalled();
  });

  it('refuses a Resolver FieldName containing the separator', async () => {
    const provider = new AppSyncProvider();
    await expect(
      provider.create('Rs', 'AWS::AppSync::Resolver', {
        ApiId: 'api1',
        TypeName: 'Query',
        FieldName: 'a|b',
      })
    ).rejects.toThrow(/fieldName 'a\|b'/);
    expect(mockAppSyncSend).not.toHaveBeenCalled();
  });

  it('downgrades a DataSource refusal to a warning on a state replay', async () => {
    mockAppSyncSend.mockResolvedValueOnce({});
    const provider = new AppSyncProvider();
    const result = await provider.create(
      'Ds',
      'AWS::AppSync::DataSource',
      { ApiId: 'api1', Name: 'a|b', Type: 'NONE' },
      REPLAY
    );
    expect(result.physicalId).toBe('api1|a|b');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("name 'a|b'"));
  });

  it('downgrades a Resolver refusal to a warning on a state replay', async () => {
    mockAppSyncSend.mockResolvedValueOnce({});
    const provider = new AppSyncProvider();
    const result = await provider.create(
      'Rs',
      'AWS::AppSync::Resolver',
      { ApiId: 'api1', TypeName: 'Query', FieldName: 'a|b' },
      REPLAY
    );
    expect(result.physicalId).toBe('api1|Query|a|b');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("fieldName 'a|b'"));
  });

  it('guards createApiKey, whose apiKeyId only exists after CreateApiKey', async () => {
    // The post-call site. Both segments are AWS-generated, so the refusal is
    // driven by an AWS response carrying a separator rather than by a template.
    mockAppSyncSend.mockResolvedValueOnce({ apiKey: { id: 'da2|xyz' } });
    const provider = new AppSyncProvider();
    await expect(
      provider.create('Key', 'AWS::AppSync::ApiKey', { ApiId: 'api1' })
    ).rejects.toThrow(/apiKeyId 'da2\|xyz'/);
  });

  it('reports the createApiKey refusal AS a refusal, not as a creation failure', async () => {
    // The pack sits OUTSIDE the try whose catch re-wraps as
    // `Failed to create ApiKey …`. Inside it, the message below would name an
    // AWS failure for a key AWS had in fact created.
    mockAppSyncSend.mockResolvedValueOnce({ apiKey: { id: 'da2|xyz' } });
    const provider = new AppSyncProvider();
    await expect(
      provider.create('Key', 'AWS::AppSync::ApiKey', { ApiId: 'api1' })
    ).rejects.toThrow(/^(?!.*Failed to create ApiKey)/s);
  });

  it('still records a clean ApiKey composite id', async () => {
    mockAppSyncSend.mockResolvedValueOnce({ apiKey: { id: 'da2-abc' } });
    const provider = new AppSyncProvider();
    const result = await provider.create('Key', 'AWS::AppSync::ApiKey', { ApiId: 'api1' });
    expect(result.physicalId).toBe('api1|da2-abc');
    expect(result.attributes?.['ApiKey']).toBe('da2-abc');
  });
});

describe('AWS::EC2::SecurityGroupIngress composite id guard', () => {
  it('refuses an IpProtocol containing the separator, before authorizing', async () => {
    const provider = new EC2Provider();
    await expect(
      provider.create('Ingress', 'AWS::EC2::SecurityGroupIngress', {
        GroupId: 'sg-1',
        IpProtocol: 'a|b',
        FromPort: 80,
        ToPort: 80,
        CidrIp: '0.0.0.0/0',
      })
    ).rejects.toThrow(/ipProtocol 'a\|b'/);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('WARNS instead of throwing on the update path, where the rule is already revoked', async () => {
    // `updateSecurityGroupIngress` revokes then re-creates, and passes the
    // callback UNCONDITIONALLY — a throw here would strand the rule deleted
    // from AWS with no template-side remedy.
    mockEc2Send.mockResolvedValue({});
    const provider = new EC2Provider();
    const result = await provider.update(
      'Ingress',
      'sg-1|tcp|80|80',
      'AWS::EC2::SecurityGroupIngress',
      { GroupId: 'sg-1', IpProtocol: 'a|b', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
      { GroupId: 'sg-1', IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' }
    );
    expect(result.physicalId).toBe('sg-1|a|b|80|80');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("ipProtocol 'a|b'"));
  });

  it('refuses an EC2 Route destination containing the separator, before CreateRoute runs', async () => {
    const provider = new EC2Provider();
    await expect(
      provider.create('Rt', 'AWS::EC2::Route', {
        RouteTableId: 'rtb-1',
        DestinationCidrBlock: '10.0.0.0/16|x',
        GatewayId: 'igw-1',
      })
    ).rejects.toThrow(/destination '10\.0\.0\.0\/16\|x'/);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('downgrades the Route refusal on a state replay (create-dispatch ternary)', async () => {
    // Pins the `context?.replayingState === true ? cb : undefined` ternary in
    // `create()`'s dispatch: mutate it to a bare `undefined` and a rollback
    // replay THROWS with no template-side remedy, while every other test stays
    // green.
    mockEc2Send.mockResolvedValue({});
    const provider = new EC2Provider();
    const result = await provider.create(
      'Rt',
      'AWS::EC2::Route',
      { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.0.0.0/16|x', GatewayId: 'igw-1' },
      REPLAY
    );
    expect(result.physicalId).toBe('rtb-1|10.0.0.0/16|x');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("destination '10.0.0.0/16|x'")
    );
  });

  it('downgrades the SecurityGroupIngress refusal on a state replay (create-dispatch ternary)', async () => {
    mockEc2Send.mockResolvedValue({});
    const provider = new EC2Provider();
    const result = await provider.create(
      'Ingress',
      'AWS::EC2::SecurityGroupIngress',
      { GroupId: 'sg-1', IpProtocol: 'a|b', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
      REPLAY
    );
    expect(result.physicalId).toBe('sg-1|a|b|80|80');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("ipProtocol 'a|b'"));
  });

  it('WARNS on updateRoute, where the route is already deleted', async () => {
    // `updateRoute` deletes then re-creates and passes the callback
    // UNCONDITIONALLY — it has no context to tell a template update from a
    // replay, and a throw here would strand a deleted route.
    mockEc2Send.mockResolvedValue({});
    const provider = new EC2Provider();
    const result = await provider.update(
      'Rt',
      'rtb-1|10.0.0.0/16',
      'AWS::EC2::Route',
      { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.0.0.0/16|x', GatewayId: 'igw-2' },
      { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'igw-1' }
    );
    expect(result.physicalId).toBe('rtb-1|10.0.0.0/16|x');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("destination '10.0.0.0/16|x'")
    );
  });

  it('refuses a VPCGatewayAttachment segment containing the separator, before attaching', async () => {
    const provider = new EC2Provider();
    await expect(
      provider.create('Attach', 'AWS::EC2::VPCGatewayAttachment', {
        VpcId: 'vpc-1',
        InternetGatewayId: 'igw|1',
      })
    ).rejects.toThrow(/internetGatewayId 'igw\|1'/);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('refuses a NetworkAclEntry segment containing the separator, before CreateNetworkAclEntry runs', async () => {
    const provider = new EC2Provider();
    await expect(
      provider.create('Entry', 'AWS::EC2::NetworkAclEntry', {
        NetworkAclId: 'acl|1',
        RuleNumber: 100,
        Protocol: 6,
        RuleAction: 'allow',
        Egress: false,
      })
    ).rejects.toThrow(/networkAclId 'acl\|1'/);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('stringifies the NetworkAclEntry number and boolean segments', async () => {
    // The only guarded site with non-string segments — pins that they survive
    // the pack unchanged rather than being coerced or refused.
    mockEc2Send.mockResolvedValueOnce({});
    const provider = new EC2Provider();
    const result = await provider.create('Entry', 'AWS::EC2::NetworkAclEntry', {
      NetworkAclId: 'acl-1',
      RuleNumber: 100,
      Protocol: 6,
      RuleAction: 'allow',
      Egress: false,
    });
    expect(result.physicalId).toBe('acl-1|100|false');
  });
});

describe('AWS::EC2::EIP composite id guard', () => {
  it('refuses an allocation whose AWS-returned segments carry the separator', async () => {
    mockEc2Send.mockResolvedValueOnce({ AllocationId: 'eipalloc|1', PublicIp: '1.2.3.4' });
    const provider = new EC2Provider();
    await expect(
      provider.create('Eip', 'AWS::EC2::EIP', { Domain: 'vpc' })
    ).rejects.toThrow(/allocationId 'eipalloc\|1'/);
  });

  it('reports the createEip refusal AS a refusal, not as an allocation failure', async () => {
    // The pack sits OUTSIDE the try whose catch re-wraps as
    // `Failed to create EIP …` — inside it, an address AWS had already handed
    // out would be reported as an allocation failure.
    mockEc2Send.mockResolvedValueOnce({ AllocationId: 'eipalloc|1', PublicIp: '1.2.3.4' });
    const provider = new EC2Provider();
    await expect(provider.create('Eip', 'AWS::EC2::EIP', { Domain: 'vpc' })).rejects.toThrow(
      /^(?!.*Failed to create EIP)/s
    );
  });

  it('still records a clean EIP composite id', async () => {
    mockEc2Send.mockResolvedValueOnce({ AllocationId: 'eipalloc-1', PublicIp: '1.2.3.4' });
    const provider = new EC2Provider();
    const result = await provider.create('Eip', 'AWS::EC2::EIP', { Domain: 'vpc' });
    expect(result.physicalId).toBe('1.2.3.4|eipalloc-1');
  });

  it('SKIPS an import whose DescribeAddresses segments carry the separator', async () => {
    // Warn-and-skip, matching the S3 Tables import arms — adopting a knowingly
    // ambiguous id is the destructive direction.
    mockEc2Send.mockResolvedValueOnce({
      Addresses: [{ AllocationId: 'eipalloc|1', PublicIp: '1.2.3.4' }],
    });
    const provider = new EC2Provider();
    const result = await provider.import({
      logicalId: 'Eip',
      resourceType: 'AWS::EC2::EIP',
      knownPhysicalId: '1.2.3.4',
      properties: {},
      stackName: 'TestStack',
      region: 'us-east-1',
    });
    expect(result).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("allocationId 'eipalloc|1'")
    );
  });

  it('still adopts a clean EIP on import', async () => {
    mockEc2Send.mockResolvedValueOnce({
      Addresses: [{ AllocationId: 'eipalloc-1', PublicIp: '1.2.3.4' }],
    });
    const provider = new EC2Provider();
    const result = await provider.import({
      logicalId: 'Eip',
      resourceType: 'AWS::EC2::EIP',
      knownPhysicalId: '1.2.3.4',
      properties: {},
      stackName: 'TestStack',
      region: 'us-east-1',
    });
    expect(result?.physicalId).toBe('1.2.3.4|eipalloc-1');
  });
});

describe('AWS::ApiGateway::Method composite id guard', () => {
  it('refuses an HttpMethod containing the separator, before PutMethod runs', async () => {
    const provider = new ApiGatewayProvider();
    await expect(
      provider.create('Method', 'AWS::ApiGateway::Method', {
        RestApiId: 'api1',
        ResourceId: 'res1',
        HttpMethod: 'GE|T',
      })
    ).rejects.toThrow(/httpMethod 'GE\|T'/);
    expect(mockApiGatewaySend).not.toHaveBeenCalled();
  });

  it('downgrades to a warning on a state replay', async () => {
    mockApiGatewaySend.mockResolvedValue({});
    const provider = new ApiGatewayProvider();
    const result = await provider.create(
      'Method',
      'AWS::ApiGateway::Method',
      { RestApiId: 'api1', ResourceId: 'res1', HttpMethod: 'GE|T' },
      REPLAY
    );
    expect(result.physicalId).toBe('api1|res1|GE|T');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("httpMethod 'GE|T'"));
  });
});

describe('AWS::Lambda::EventInvokeConfig composite id guard', () => {
  it('refuses a FunctionName containing the separator, before the Put runs', async () => {
    const provider = new LambdaEventInvokeConfigProvider();
    await expect(
      provider.create('Cfg', 'AWS::Lambda::EventInvokeConfig', {
        FunctionName: 'fn|x',
        Qualifier: 'live',
      })
    ).rejects.toThrow(/functionName 'fn\|x'/);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('refuses a Qualifier containing the separator', async () => {
    const provider = new LambdaEventInvokeConfigProvider();
    await expect(
      provider.create('Cfg', 'AWS::Lambda::EventInvokeConfig', {
        FunctionName: 'fn',
        Qualifier: 'li|ve',
      })
    ).rejects.toThrow(/qualifier 'li\|ve'/);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('still records a clean composite id', async () => {
    mockLambdaSend.mockResolvedValueOnce({});
    const provider = new LambdaEventInvokeConfigProvider();
    const result = await provider.create('Cfg', 'AWS::Lambda::EventInvokeConfig', {
      FunctionName: 'fn',
      Qualifier: 'live',
    });
    expect(result.physicalId).toBe('fn|live');
  });

  it('downgrades to a warning on a state replay', async () => {
    mockLambdaSend.mockResolvedValueOnce({});
    const provider = new LambdaEventInvokeConfigProvider();
    const result = await provider.create(
      'Cfg',
      'AWS::Lambda::EventInvokeConfig',
      { FunctionName: 'fn|x', Qualifier: 'live' },
      REPLAY
    );
    expect(result.physicalId).toBe('fn|x|live');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("functionName 'fn|x'"));
  });
});

describe('AWS::Route53::RecordSet composite id guard', () => {
  const RECORD_TYPE = 'AWS::Route53::RecordSet';

  it('refuses a record Name containing the separator, before ChangeResourceRecordSets runs', async () => {
    const provider = new Route53Provider();
    await expect(
      provider.create('MyRecord', RECORD_TYPE, {
        HostedZoneId: 'Z1D633PJN98FT9',
        Name: 'a|b.example.com.',
        Type: 'A',
        TTL: '300',
        ResourceRecords: ['1.2.3.4'],
      })
    ).rejects.toThrow(/recordName 'a\|b\.example\.com\.'/);
    expect(mockRoute53Send).not.toHaveBeenCalled();
  });

  it('names the id shape the record set actually uses', async () => {
    // The message renders the shape from the segment names, so a wrong name
    // here would tell the user to inspect a composite this type never packs.
    const provider = new Route53Provider();
    await expect(
      provider.create('MyRecord', RECORD_TYPE, {
        HostedZoneId: 'Z1D633PJN98FT9',
        Name: 'a|b.example.com.',
        Type: 'A',
      })
    ).rejects.toThrow(/<hostedZoneId>\|<recordName>\|<recordType>/);
  });

  it('still records a clean composite id', async () => {
    mockRoute53Send.mockResolvedValueOnce({});
    const provider = new Route53Provider();
    const result = await provider.create('MyRecord', RECORD_TYPE, {
      HostedZoneId: 'Z1D633PJN98FT9',
      Name: 'www.example.com.',
      Type: 'A',
      TTL: '300',
      ResourceRecords: ['1.2.3.4'],
    });
    expect(result.physicalId).toBe('Z1D633PJN98FT9|www.example.com.|A');
  });

  it('downgrades to a warning on a state replay', async () => {
    // The reverse-replacement rollback arm: a record an older binary recorded
    // under the ambiguous id must still be restorable, and no template edit
    // can repair a value that comes from a cdkd state record.
    mockRoute53Send.mockResolvedValueOnce({});
    const provider = new Route53Provider();
    const result = await provider.create(
      'MyRecord',
      RECORD_TYPE,
      {
        HostedZoneId: 'Z1D633PJN98FT9',
        Name: 'a|b.example.com.',
        Type: 'A',
        TTL: '300',
        ResourceRecords: ['1.2.3.4'],
      },
      REPLAY
    );
    expect(result.physicalId).toBe('Z1D633PJN98FT9|a|b.example.com.|A');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("recordName 'a|b.example.com.'")
    );
  });

  it('warns and packs on update instead of refusing', async () => {
    // The `updateRoute` precedent: `update()` takes no `CreateContext`, so it
    // cannot tell a template-borne update from the STATE-borne desired bag
    // that the rollback executor's revert arm and `cdkd drift --revert` hand
    // it — and refusing there would make a record an older binary wrote under
    // the ambiguous id un-revertable. The UPSERT still goes out, so the id is
    // ANNOUNCED rather than silent. Mutating this callback away to a bare
    // `undefined` makes this case throw.
    mockRoute53Send.mockResolvedValueOnce({});
    const provider = new Route53Provider();
    const result = await provider.update(
      'MyRecord',
      'Z1D633PJN98FT9|a|b.example.com.|A',
      RECORD_TYPE,
      {
        HostedZoneId: 'Z1D633PJN98FT9',
        Name: 'a|b.example.com.',
        Type: 'A',
        TTL: '300',
        ResourceRecords: ['1.2.3.4'],
      },
      { HostedZoneId: 'Z1D633PJN98FT9', Name: 'a|b.example.com.', Type: 'A' }
    );
    expect(result.physicalId).toBe('Z1D633PJN98FT9|a|b.example.com.|A');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("recordName 'a|b.example.com.'")
    );
    expect(mockRoute53Send).toHaveBeenCalledTimes(1);
  });

  it('update still records a clean composite id', async () => {
    mockRoute53Send.mockResolvedValueOnce({});
    const provider = new Route53Provider();
    const result = await provider.update(
      'MyRecord',
      'Z1D633PJN98FT9|www.example.com.|A',
      RECORD_TYPE,
      {
        HostedZoneId: 'Z1D633PJN98FT9',
        Name: 'www.example.com.',
        Type: 'A',
        TTL: '600',
        ResourceRecords: ['1.2.3.4'],
      },
      { HostedZoneId: 'Z1D633PJN98FT9', Name: 'www.example.com.', Type: 'A', TTL: '300' }
    );
    expect(result.physicalId).toBe('Z1D633PJN98FT9|www.example.com.|A');
  });

  it('refuses a template-path create even when a replay context says NOT replaying', async () => {
    // `context?.replayingState === true` must be an EXACT test: mutating it to
    // `context != null` makes an explicitly non-replaying context downgrade,
    // and every other case here passes either no context or a replaying one,
    // so nothing else in the suite would notice.
    const provider = new Route53Provider();
    await expect(
      provider.create(
        'MyRecord',
        RECORD_TYPE,
        { HostedZoneId: 'Z1D633PJN98FT9', Name: 'a|b.example.com.', Type: 'A' },
        { replayingState: false }
      )
    ).rejects.toThrow(ProvisioningError);
    expect(mockRoute53Send).not.toHaveBeenCalled();
  });

  it('a record NAME that merely LOOKS like a composite is not decoded as one', async () => {
    // The blocker a reviewer found. `parseRecordSetCompositeId` asks only for
    // three non-empty segments, so a two-pipe record name — exactly the CFn
    // physicalId `--migrate-from-cloudformation` pre-populates — parsed as a
    // "valid" composite meaning zone 'a', name 'b', type 'c.example.com.'.
    //
    // The IMPORT return value cannot fence this: both the bug and the fix
    // adopt the same STRING, and they differ only in what the id is taken to
    // MEAN. DELETE is where that costs something, so this drives the delete
    // and asserts the zone actually targeted.
    mockRoute53Send.mockResolvedValue({});
    const provider = new Route53Provider();
    await provider.delete('MyRecord', 'a|b|c.example.com.', RECORD_TYPE, {
      HostedZoneId: 'Z1D633PJN98FT9',
      Name: 'a|b|c.example.com.',
      Type: 'A',
      TTL: '300',
      ResourceRecords: ['1.2.3.4'],
    });

    const change = mockRoute53Send.mock.calls[0]?.[0] as {
      input: { HostedZoneId?: string };
    };
    // Before the fix this was 'a' — a zone that does not exist, so the delete
    // took the NoSuchHostedZone arm and reported success with the record live.
    expect(change.input.HostedZoneId).toBe('Z1D633PJN98FT9');
  });

  it('a look-alike whose TYPE segment coincidentally matches is not decoded either', async () => {
    // The residual the Type cross-check alone leaves: `a|b|A` on a record whose
    // Type really is 'A' agrees on the type and still decodes to zone 'a'.
    // Only the NAME check rejects it.
    mockRoute53Send.mockResolvedValue({});
    const provider = new Route53Provider();
    await provider.delete('MyRecord', 'a|b|A', RECORD_TYPE, {
      HostedZoneId: 'Z1D633PJN98FT9',
      Name: 'a|b|A',
      Type: 'A',
      TTL: '300',
      ResourceRecords: ['1.2.3.4'],
    });

    const change = mockRoute53Send.mock.calls[0]?.[0] as {
      input: { HostedZoneId?: string };
    };
    expect(change.input.HostedZoneId).toBe('Z1D633PJN98FT9');
  });

  it('a GENUINE composite is still decoded, with no zone lookup', async () => {
    // The control the cross-check must not break. The name compare is case- and
    // trailing-dot-insensitive, so a template spelling the name without CDK's
    // trailing dot still takes the composite path.
    mockRoute53Send.mockResolvedValue({});
    const provider = new Route53Provider();
    await provider.delete('MyRecord', 'Z1D633PJN98FT9|www.example.com.|A', RECORD_TYPE, {
      HostedZoneId: 'ZSHOULDNOTBEUSED',
      Name: 'WWW.example.com',
      Type: 'A',
      TTL: '300',
      ResourceRecords: ['1.2.3.4'],
    });

    const change = mockRoute53Send.mock.calls[0]?.[0] as {
      input: { HostedZoneId?: string };
    };
    // Sourced from the composite, NOT from the properties — which is what
    // proves the composite path was taken rather than the fallback.
    expect(change.input.HostedZoneId).toBe('Z1D633PJN98FT9');
  });

  it('import warns and adopts a look-alike verbatim instead of freezing the mis-decode', async () => {
    const provider = new Route53Provider();
    const result = await provider.import({
      logicalId: 'MyRecord',
      resourceType: RECORD_TYPE,
      stackName: 'TestStack',
      region: 'us-east-1',
      knownPhysicalId: 'a|b|c.example.com.',
      properties: {
        HostedZoneId: 'Z1D633PJN98FT9',
        Name: 'a|b|c.example.com.',
        Type: 'A',
      },
    });

    expect(result).toEqual({ physicalId: 'a|b|c.example.com.', attributes: {} });
    // The DISCRIMINATOR against the pre-fix path, which adopted the same string
    // silently: the id is now recognized as ambiguous and said so.
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('would pack an ambiguous id')
    );
    expect(mockRoute53Send).not.toHaveBeenCalled();
  });

  it('import adopts the override verbatim rather than freezing an ambiguous composite', async () => {
    // An `import()` neither throws nor adopts an id it knows to be ambiguous:
    // the verbatim form decodes to nothing, so delete / drift fall back to the
    // template properties, where the packed composite would have written a
    // mis-arity id into state that nothing can parse.
    const provider = new Route53Provider();
    const result = await provider.import({
      logicalId: 'MyRecord',
      resourceType: RECORD_TYPE,
      stackName: 'TestStack',
      region: 'us-east-1',
      knownPhysicalId: 'a|b.example.com.',
      properties: {
        HostedZoneId: 'Z1D633PJN98FT9',
        Name: 'a|b.example.com.',
        Type: 'A',
      },
    });
    expect(result).toEqual({ physicalId: 'a|b.example.com.', attributes: {} });
    // ONE warning, carrying the reason — not the raw refusal sentence, whose
    // "rename the resource" remedy does not apply to an import that succeeds.
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('would pack an ambiguous id')
    );
    // The refusal short-circuits BEFORE the `ListResourceRecordSets`
    // verification read, so no AWS call is made on this path.
    expect(mockRoute53Send).not.toHaveBeenCalled();
  });
});
