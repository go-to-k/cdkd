import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();
const mockCloudControlConfigRegion = vi.fn();
const mockCloudFormationSend = vi.fn();
const mockLoggerWarn = vi.fn();
// `new RDSClient({})` is constructed directly inside CloudControlProvider's
// enrichResourceAttributes RDS branches, so it is NOT routed through the
// mocked getAwsClients() factory. Mock the @aws-sdk/client-rds module so the
// constructed client's send() is controllable per-test.
const mockRdsSend = vi.fn();

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn(() => ({ send: mockRdsSend })),
  DescribeDBClustersCommand: vi.fn((input: unknown) => ({ __type: 'DescribeDBClusters', input })),
  DescribeDBInstancesCommand: vi.fn((input: unknown) => ({ __type: 'DescribeDBInstances', input })),
}));

// `new ElastiCacheClient({})` is constructed directly inside
// enrichResourceAttributes' ElastiCache::ReplicationGroup branch (same shape as
// the RDS branches), so mock the module to control the constructed client's
// send() per-test.
const mockElastiCacheSend = vi.fn();

vi.mock('@aws-sdk/client-elasticache', () => ({
  ElastiCacheClient: vi.fn(() => ({ send: mockElastiCacheSend })),
  DescribeReplicationGroupsCommand: vi.fn((input: unknown) => ({
    __type: 'DescribeReplicationGroups',
    input,
  })),
}));

// `new RedshiftClient({})` is constructed directly inside
// enrichResourceAttributes' Redshift::Cluster branch (same shape as the RDS /
// ElastiCache branches), so mock the module to control its send() per-test.
// Use vi.hoisted() so the spy exists before vitest's hoisted vi.mock factory
// runs (a plain const interleaved between earlier vi.mock calls was not
// reliably hoisted, leaving the real client in place and the mock a no-op).
const mockRedshiftSend = vi.hoisted(() => vi.fn());
const mockOpenSearchSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-redshift', () => ({
  RedshiftClient: vi.fn(() => ({ send: mockRedshiftSend })),
  DescribeClustersCommand: vi.fn((input: unknown) => ({ __type: 'DescribeClusters', input })),
}));

vi.mock('@aws-sdk/client-opensearch', () => ({
  OpenSearchClient: vi.fn(() => ({ send: mockOpenSearchSend })),
  DescribeDomainCommand: vi.fn((input: unknown) => ({ __type: 'DescribeDomain', input })),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      // config.region is consulted by region-check.ts before treating
      // ResourceNotFoundException as idempotent delete success.
      config: { region: mockCloudControlConfigRegion },
    },
    // DescribeType for write-only property resolution (issue #809).
    cloudFormation: { send: mockCloudFormationSend },
    dynamoDB: { send: vi.fn() },
    apiGateway: { send: vi.fn() },
    cloudFront: { send: vi.fn() },
    lambda: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: vi.fn(),
      info: vi.fn(),
      // Shared spy so tests can assert on warnings (e.g. the DescribeType
      // fallback warning in write-only-properties.ts).
      warn: mockLoggerWarn,
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return {
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { clearWriteOnlyPropertiesCache } from '../../../src/provisioning/write-only-properties.js';

describe('CloudControlProvider delete region verification', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    mockCloudControlSend.mockReset();
    mockCloudControlConfigRegion.mockReset();
    mockCloudControlConfigRegion.mockResolvedValue('us-east-1');
    provider = new CloudControlProvider();
  });

  it('treats ResourceNotFoundException as success when client region matches expectedRegion', async () => {
    mockCloudControlSend.mockRejectedValueOnce(
      Object.assign(new Error('Resource not found'), { name: 'ResourceNotFoundException' })
    );

    await expect(
      provider.delete(
        'MyTopic',
        'arn:aws:sns:us-east-1:123:t',
        'AWS::SNS::Topic',
        {},
        { expectedRegion: 'us-east-1' }
      )
    ).resolves.toBeUndefined();
  });

  it('throws ProvisioningError on ResourceNotFoundException when client region differs from expectedRegion', async () => {
    mockCloudControlSend.mockRejectedValueOnce(
      Object.assign(new Error('Resource not found'), { name: 'ResourceNotFoundException' })
    );

    await expect(
      provider.delete(
        'MyTopic',
        'arn:aws:sns:us-east-1:123:t',
        'AWS::SNS::Topic',
        {},
        { expectedRegion: 'us-west-2' }
      )
    ).rejects.toThrow(/us-east-1.*us-west-2|us-west-2.*us-east-1/);
  });

  it('preserves existing idempotent NotFound behavior when context is omitted', async () => {
    mockCloudControlSend.mockRejectedValueOnce(
      Object.assign(new Error('Resource not found'), { name: 'ResourceNotFoundException' })
    );

    await expect(
      provider.delete('MyTopic', 'arn:aws:sns:us-east-1:123:t', 'AWS::SNS::Topic', {})
    ).resolves.toBeUndefined();
  });

  it('also accepts message-pattern NotFound matches with region check', async () => {
    // CC API surfaces some not-found cases via message rather than name.
    mockCloudControlSend.mockRejectedValueOnce(new Error('Topic does not exist'));

    await expect(
      provider.delete(
        'MyTopic',
        'arn:aws:sns:us-east-1:123:t',
        'AWS::SNS::Topic',
        {},
        { expectedRegion: 'eu-west-1' }
      )
    ).rejects.toThrow(/eu-west-1/);
  });
});

describe('CloudControlProvider import (CC API fallback)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    mockCloudControlSend.mockReset();
    mockCloudControlConfigRegion.mockReset();
    provider = new CloudControlProvider();
  });

  function makeInput(overrides: Partial<{ knownPhysicalId: string }> = {}) {
    return {
      logicalId: 'MyResource',
      resourceType: 'AWS::SES::EmailIdentity',
      cdkPath: 'MyStack/MyResource',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    };
  }

  it('returns null when no knownPhysicalId is supplied (no auto lookup)', async () => {
    // Even without sending a single CC API call, this returns null.
    const result = await provider.import(makeInput());

    expect(result).toBeNull();
    expect(mockCloudControlSend).not.toHaveBeenCalled();
  });

  it('with knownPhysicalId: GetResource succeeds and ResourceModel is parsed into attributes', async () => {
    mockCloudControlSend.mockResolvedValueOnce({
      ResourceDescription: {
        Identifier: 'user@example.com',
        Properties: JSON.stringify({
          EmailIdentity: 'user@example.com',
          DkimAttributes: { SigningEnabled: true },
          Arn: 'arn:aws:ses:us-east-1:123:identity/user@example.com',
        }),
      },
    });

    const result = await provider.import(makeInput({ knownPhysicalId: 'user@example.com' }));

    expect(result).toEqual({
      physicalId: 'user@example.com',
      attributes: {
        EmailIdentity: 'user@example.com',
        DkimAttributes: { SigningEnabled: true },
        Arn: 'arn:aws:ses:us-east-1:123:identity/user@example.com',
      },
    });
    expect(mockCloudControlSend).toHaveBeenCalledTimes(1);
  });

  it('with knownPhysicalId: ResourceNotFoundException -> null', async () => {
    const err = new Error('not found') as Error & { name: string };
    err.name = 'ResourceNotFoundException';
    mockCloudControlSend.mockRejectedValueOnce(err);

    const result = await provider.import(makeInput({ knownPhysicalId: 'missing-id' }));

    expect(result).toBeNull();
  });

  it('with knownPhysicalId: malformed ResourceModel JSON falls back to empty attributes', async () => {
    mockCloudControlSend.mockResolvedValueOnce({
      ResourceDescription: {
        Identifier: 'x',
        Properties: 'not-json{{{',
      },
    });

    const result = await provider.import(makeInput({ knownPhysicalId: 'x' }));

    // physicalId still returned — registering the resource is the
    // priority; missing attributes are reconstructed at deploy time.
    expect(result).toEqual({ physicalId: 'x', attributes: {} });
  });

  it('with knownPhysicalId: non-NotFound error is re-thrown', async () => {
    const err = new Error('AccessDenied') as Error & { name: string };
    err.name = 'AccessDeniedException';
    mockCloudControlSend.mockRejectedValueOnce(err);

    await expect(
      provider.import(makeInput({ knownPhysicalId: 'x' }))
    ).rejects.toThrow(/AccessDenied/);
  });
});

describe('CloudControlProvider readCurrentState (drift detection)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    mockCloudControlSend.mockReset();
    mockCloudControlConfigRegion.mockReset();
    provider = new CloudControlProvider();
  });

  it('returns parsed AWS-current properties on GetResource success', async () => {
    mockCloudControlSend.mockResolvedValueOnce({
      ResourceDescription: {
        Identifier: 'b',
        Properties: JSON.stringify({
          BucketName: 'b',
          VersioningConfiguration: { Status: 'Enabled' },
          // AWS-managed fields cdkd never set are returned too — drift
          // calculator filters them out at compare time.
          CreationDate: '2024-01-01T00:00:00Z',
        }),
      },
    });

    const result = await provider.readCurrentState('b', 'MyBucket', 'AWS::S3::Bucket');

    expect(result).toEqual({
      BucketName: 'b',
      VersioningConfiguration: { Status: 'Enabled' },
      CreationDate: '2024-01-01T00:00:00Z',
    });
    expect(mockCloudControlSend).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the resource does not exist (drift unknown)', async () => {
    const err = new Error('not found') as Error & { name: string };
    err.name = 'ResourceNotFoundException';
    mockCloudControlSend.mockRejectedValueOnce(err);

    const result = await provider.readCurrentState('missing', 'MyBucket', 'AWS::S3::Bucket');

    expect(result).toBeUndefined();
  });

  it('returns undefined when ResourceDescription has no Properties payload', async () => {
    mockCloudControlSend.mockResolvedValueOnce({
      ResourceDescription: { Identifier: 'b' },
    });

    const result = await provider.readCurrentState('b', 'MyBucket', 'AWS::S3::Bucket');

    expect(result).toBeUndefined();
  });

  it('re-throws non-NotFound errors so the caller can surface them', async () => {
    const err = new Error('throttled') as Error & { name: string };
    err.name = 'ThrottlingException';
    mockCloudControlSend.mockRejectedValueOnce(err);

    await expect(
      provider.readCurrentState('b', 'MyBucket', 'AWS::S3::Bucket')
    ).rejects.toThrow(/throttled/);
  });
});

describe('CloudControlProvider update: write-only property re-inclusion (issue #809)', () => {
  let provider: CloudControlProvider;

  const ECS_SERVICE_SCHEMA = JSON.stringify({
    writeOnlyProperties: [
      '/properties/ServiceConnectConfiguration',
      '/properties/VolumeConfigurations',
      '/properties/ForceNewDeployment',
    ],
  });

  const VOLUME_CONFIGURATIONS = [
    { Name: 'data', ManagedEBSVolume: { SizeInGiB: 20, RoleArn: 'arn:aws:iam::123:role/ebs' } },
  ];

  // Wires the cloudControl mock so UpdateResource returns a token and the
  // matching GetResourceRequestStatus reports SUCCESS.
  function wireUpdateSuccess(): void {
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'UpdateResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-update' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({
          ProgressEvent: { OperationStatus: 'SUCCESS', Identifier: 'svc-1' },
        });
      }
      return Promise.resolve({});
    });
  }

  function sentPatch(): Array<{ op: string; path: string; value?: unknown }> {
    const call = mockCloudControlSend.mock.calls.find(
      (c) => c[0]?.constructor?.name === 'UpdateResourceCommand'
    );
    expect(call).toBeDefined();
    return JSON.parse(
      (call![0] as { input: { PatchDocument: string } }).input.PatchDocument
    ) as Array<{ op: string; path: string; value?: unknown }>;
  }

  const updateResourceCallCount = (): number =>
    mockCloudControlSend.mock.calls.filter(
      (c) => c[0]?.constructor?.name === 'UpdateResourceCommand'
    ).length;

  beforeEach(() => {
    vi.clearAllMocks();
    clearWriteOnlyPropertiesCache();
    provider = new CloudControlProvider();
  });

  it('re-includes unchanged write-only properties as add ops in the patch document', async () => {
    wireUpdateSuccess();
    mockCloudFormationSend.mockResolvedValue({ Schema: ECS_SERVICE_SCHEMA });

    await provider.update(
      'MyService',
      'svc-1',
      'AWS::ECS::Service',
      // Desired: only TaskDefinition changed; VolumeConfigurations unchanged.
      { TaskDefinition: 'arn:task:2', VolumeConfigurations: VOLUME_CONFIGURATIONS },
      { TaskDefinition: 'arn:task:1', VolumeConfigurations: VOLUME_CONFIGURATIONS }
    );

    const patch = sentPatch();
    expect(patch).toContainEqual({ op: 'replace', path: '/TaskDefinition', value: 'arn:task:2' });
    // The unchanged write-only property rides along as an add op — without it
    // Cloud Control's read-modify-write update would drop it from the desired
    // state (the read handler cannot return write-only properties).
    expect(patch).toContainEqual({
      op: 'add',
      path: '/VolumeConfigurations',
      value: VOLUME_CONFIGURATIONS,
    });
    expect(patch).toHaveLength(2);

    // DescribeType was consulted for the resource type.
    const describeTypeCall = mockCloudFormationSend.mock.calls[0]![0] as {
      input: { Type: string; TypeName: string };
    };
    expect(describeTypeCall.input).toEqual({ Type: 'RESOURCE', TypeName: 'AWS::ECS::Service' });
  });

  it('does not duplicate a write-only property that already changed in the diff', async () => {
    wireUpdateSuccess();
    mockCloudFormationSend.mockResolvedValue({ Schema: ECS_SERVICE_SCHEMA });

    const newVolumes = [{ Name: 'data', ManagedEBSVolume: { SizeInGiB: 50 } }];
    await provider.update(
      'MyService',
      'svc-1',
      'AWS::ECS::Service',
      { TaskDefinition: 'arn:task:1', VolumeConfigurations: newVolumes },
      { TaskDefinition: 'arn:task:1', VolumeConfigurations: VOLUME_CONFIGURATIONS }
    );

    const patch = sentPatch();
    const volumeOps = patch.filter((p) => p.path === '/VolumeConfigurations');
    expect(volumeOps).toHaveLength(1);
    expect(volumeOps[0]).toEqual({ op: 'add', path: '/VolumeConfigurations', value: newVolumes });
  });

  it('strips only the top-level containing property for nested write-only paths', async () => {
    wireUpdateSuccess();
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({
        writeOnlyProperties: ['/properties/Configuration/Secret'],
      }),
    });

    const configuration = { Secret: 's3cret', Mode: 'standard' };
    await provider.update(
      'MyResource',
      'res-1',
      'AWS::Some::Type',
      { Name: 'new', Configuration: configuration },
      { Name: 'old', Configuration: configuration }
    );

    const patch = sentPatch();
    expect(patch).toContainEqual({ op: 'replace', path: '/Name', value: 'new' });
    // The whole containing top-level property is re-added.
    expect(patch).toContainEqual({ op: 'add', path: '/Configuration', value: configuration });
    expect(patch).toHaveLength(2);
  });

  it('keeps the minimal patch for types without write-only properties', async () => {
    wireUpdateSuccess();
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({ primaryIdentifier: ['/properties/Id'] }),
    });

    await provider.update(
      'MyResource',
      'res-1',
      'AWS::Some::Type',
      { Name: 'new', Description: 'same' },
      { Name: 'old', Description: 'same' }
    );

    expect(sentPatch()).toEqual([{ op: 'replace', path: '/Name', value: 'new' }]);
  });

  it('falls back to the minimal patch with a warning when DescribeType fails', async () => {
    wireUpdateSuccess();
    mockCloudFormationSend.mockRejectedValue(
      Object.assign(new Error('User is not authorized to perform cloudformation:DescribeType'), {
        name: 'AccessDeniedException',
      })
    );

    await provider.update(
      'MyService',
      'svc-1',
      'AWS::ECS::Service',
      { TaskDefinition: 'arn:task:2', VolumeConfigurations: VOLUME_CONFIGURATIONS },
      { TaskDefinition: 'arn:task:1', VolumeConfigurations: VOLUME_CONFIGURATIONS }
    );

    // No regression for callers without the new IAM permission: the update
    // still goes out with the pre-#809 minimal patch.
    expect(sentPatch()).toEqual([
      { op: 'replace', path: '/TaskDefinition', value: 'arn:task:2' },
    ]);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('cloudformation:DescribeType')
    );
  });

  it('caches the DescribeType result per resource type across updates', async () => {
    wireUpdateSuccess();
    mockCloudFormationSend.mockResolvedValue({ Schema: ECS_SERVICE_SCHEMA });

    await provider.update(
      'ServiceA',
      'svc-a',
      'AWS::ECS::Service',
      { TaskDefinition: 'arn:task:2' },
      { TaskDefinition: 'arn:task:1' }
    );
    await provider.update(
      'ServiceB',
      'svc-b',
      'AWS::ECS::Service',
      { TaskDefinition: 'arn:task:9' },
      { TaskDefinition: 'arn:task:8' }
    );

    expect(updateResourceCallCount()).toBe(2);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache DescribeType failures: a later update of the same type retries', async () => {
    wireUpdateSuccess();
    // A transient throttle must not poison the cache for the rest of the
    // deploy — otherwise write-only re-inclusion would be silently disabled
    // for every CC-routed update after the first failure.
    mockCloudFormationSend.mockRejectedValue(new Error('Rate exceeded'));

    await provider.update(
      'ServiceA',
      'svc-a',
      'AWS::ECS::Service',
      { TaskDefinition: 'arn:task:2' },
      { TaskDefinition: 'arn:task:1' }
    );
    await provider.update(
      'ServiceB',
      'svc-b',
      'AWS::ECS::Service',
      { TaskDefinition: 'arn:task:9' },
      { TaskDefinition: 'arn:task:8' }
    );

    // Both updates went out (graceful fallback), and each one re-attempted
    // DescribeType + re-warned because the failed lookup was not cached.
    expect(updateResourceCallCount()).toBe(2);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
  });

  it('retries DescribeType after a transient failure and uses the populated set on success', async () => {
    wireUpdateSuccess();
    // First lookup throttles; the second succeeds with the real schema.
    mockCloudFormationSend
      .mockRejectedValueOnce(new Error('Rate exceeded'))
      .mockResolvedValue({ Schema: ECS_SERVICE_SCHEMA });

    // First update: DescribeType fails -> minimal patch, no write-only re-add.
    await provider.update(
      'ServiceA',
      'svc-a',
      'AWS::ECS::Service',
      { TaskDefinition: 'arn:task:2', VolumeConfigurations: VOLUME_CONFIGURATIONS },
      { TaskDefinition: 'arn:task:1', VolumeConfigurations: VOLUME_CONFIGURATIONS }
    );
    expect(sentPatch()).toEqual([{ op: 'replace', path: '/TaskDefinition', value: 'arn:task:2' }]);

    // Second update of the same type: a REAL second DescribeType call runs
    // (the failure was not cached) and the now-populated write-only set is
    // applied — the unchanged VolumeConfigurations rides along as an add op.
    vi.clearAllMocks();
    wireUpdateSuccess();
    await provider.update(
      'ServiceB',
      'svc-b',
      'AWS::ECS::Service',
      { TaskDefinition: 'arn:task:9', VolumeConfigurations: VOLUME_CONFIGURATIONS },
      { TaskDefinition: 'arn:task:8', VolumeConfigurations: VOLUME_CONFIGURATIONS }
    );

    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
    const patch = sentPatch();
    expect(patch).toContainEqual({ op: 'replace', path: '/TaskDefinition', value: 'arn:task:9' });
    expect(patch).toContainEqual({
      op: 'add',
      path: '/VolumeConfigurations',
      value: VOLUME_CONFIGURATIONS,
    });
    expect(patch).toHaveLength(2);
  });

  it('treats a DescribeType response without a Schema as no write-only properties (no warning)', async () => {
    wireUpdateSuccess();
    // A still-registering / publisher type can return no Schema at all.
    mockCloudFormationSend.mockResolvedValue({});

    await provider.update(
      'MyService',
      'svc-1',
      'AWS::ECS::Service',
      { TaskDefinition: 'arn:task:2', VolumeConfigurations: VOLUME_CONFIGURATIONS },
      { TaskDefinition: 'arn:task:1', VolumeConfigurations: VOLUME_CONFIGURATIONS }
    );

    // No Schema -> no write-only set -> minimal patch (VolumeConfigurations
    // is NOT re-added), and this is a successful lookup, not a failure: no
    // warning, and it is cached as "none".
    expect(sentPatch()).toEqual([{ op: 'replace', path: '/TaskDefinition', value: 'arn:task:2' }]);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it('still skips the update entirely when nothing changed (no DescribeType call)', async () => {
    const properties = {
      TaskDefinition: 'arn:task:1',
      VolumeConfigurations: VOLUME_CONFIGURATIONS,
    };

    const result = await provider.update(
      'MyService',
      'svc-1',
      'AWS::ECS::Service',
      properties,
      properties
    );

    expect(result).toEqual({ physicalId: 'svc-1', wasReplaced: false });
    expect(mockCloudControlSend).not.toHaveBeenCalled();
    expect(mockCloudFormationSend).not.toHaveBeenCalled();
  });

  it('skips the update when the only diff is a write-only property removal', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: ECS_SERVICE_SCHEMA });

    // Desired no longer carries VolumeConfigurations; nothing else changed.
    // Cloud Control cannot remove what its read handler never returns, and a
    // `remove` op against a path absent from the current model would fail.
    const result = await provider.update(
      'MyService',
      'svc-1',
      'AWS::ECS::Service',
      { TaskDefinition: 'arn:task:1' },
      { TaskDefinition: 'arn:task:1', VolumeConfigurations: VOLUME_CONFIGURATIONS }
    );

    expect(result).toEqual({ physicalId: 'svc-1', wasReplaced: false });
    expect(updateResourceCallCount()).toBe(0);
  });
});

describe('CloudControlProvider RDS DBInstance attribute enrichment (CC-API routing)', () => {
  let provider: CloudControlProvider;

  // enrichResourceAttributes is private; exercise it directly. It is the
  // method `create()` calls after a CC-API create, and the only behavior
  // under test here is the DBInstance Endpoint/Port/Arn overlay.
  const enrich = (physicalId: string, attributes: Record<string, unknown>) =>
    (
      provider as unknown as {
        enrichResourceAttributes: (
          resourceType: string,
          physicalId: string,
          attributes: Record<string, unknown>
        ) => Promise<Record<string, unknown>>;
      }
    ).enrichResourceAttributes('AWS::RDS::DBInstance', physicalId, attributes);

  beforeEach(() => {
    mockRdsSend.mockReset();
    provider = new CloudControlProvider();
  });

  it('overlays flat-key Endpoint.Address / Endpoint.Port (string) / Endpoint.HostedZoneId / Arn from the nested DescribeDBInstances Endpoint object', async () => {
    mockRdsSend.mockResolvedValueOnce({
      DBInstances: [
        {
          Endpoint: {
            Address: 'mydb.xxxx.us-east-1.rds.amazonaws.com',
            Port: 5432,
            HostedZoneId: 'Z123',
          },
          DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
        },
      ],
    });

    const enriched = await enrich('mydb', {});

    expect(enriched['Endpoint.Address']).toBe('mydb.xxxx.us-east-1.rds.amazonaws.com');
    // Port must be coerced to the STRING shape the SDK provider writes, so
    // Fn::GetAtt(<DBInstance>, 'Endpoint.Port') consumers (security-group
    // ingress rules) receive a string like the DBCluster path.
    expect(enriched['Endpoint.Port']).toBe('5432');
    expect(enriched['Endpoint.HostedZoneId']).toBe('Z123');
    expect(enriched['Arn']).toBe('arn:aws:rds:us-east-1:123456789012:db:mydb');
  });

  it('is best-effort: a failed DescribeDBInstances does not throw and leaves attributes unchanged', async () => {
    mockRdsSend.mockRejectedValueOnce(
      Object.assign(new Error('access denied'), { name: 'AccessDeniedException' })
    );

    const original = { ExistingAttr: 'keep-me' };
    const enriched = await enrich('mydb', original);

    expect(enriched).toEqual({ ExistingAttr: 'keep-me' });
    expect(enriched['Endpoint.Address']).toBeUndefined();
    expect(enriched['Endpoint.Port']).toBeUndefined();
  });
});

describe('CloudControlProvider ElastiCache ReplicationGroup attribute enrichment (CC-API routing)', () => {
  let provider: CloudControlProvider;

  const enrich = (physicalId: string, attributes: Record<string, unknown>) =>
    (
      provider as unknown as {
        enrichResourceAttributes: (
          resourceType: string,
          physicalId: string,
          attributes: Record<string, unknown>
        ) => Promise<Record<string, unknown>>;
      }
    ).enrichResourceAttributes('AWS::ElastiCache::ReplicationGroup', physicalId, attributes);

  beforeEach(() => {
    mockElastiCacheSend.mockReset();
    provider = new CloudControlProvider();
  });

  it('overlays CFn-cased PrimaryEndPoint/ReaderEndPoint flat-keys (cluster-mode disabled) from DescribeReplicationGroups', async () => {
    // SDK fields are `Endpoint` (lower p); CFn GetAtt names are `EndPoint`.
    mockElastiCacheSend.mockResolvedValueOnce({
      ReplicationGroups: [
        {
          NodeGroups: [
            {
              PrimaryEndpoint: { Address: 'master.myrg.abc.use1.cache.amazonaws.com', Port: 6379 },
              ReaderEndpoint: { Address: 'replica.myrg.abc.use1.cache.amazonaws.com', Port: 6379 },
            },
          ],
        },
      ],
    });

    const enriched = await enrich('myrg', {});

    expect(enriched['PrimaryEndPoint.Address']).toBe('master.myrg.abc.use1.cache.amazonaws.com');
    // Port coerced to string (matches the flat-key shape consumers expect).
    expect(enriched['PrimaryEndPoint.Port']).toBe('6379');
    expect(enriched['ReaderEndPoint.Address']).toBe('replica.myrg.abc.use1.cache.amazonaws.com');
    expect(enriched['ReaderEndPoint.Port']).toBe('6379');
    // List-form ReadEndPoint.Addresses covers the primary AND reader endpoints
    // of every node group (per the CFn return-value docs), not readers only.
    expect(enriched['ReadEndPoint.Addresses']).toBe(
      'master.myrg.abc.use1.cache.amazonaws.com,replica.myrg.abc.use1.cache.amazonaws.com'
    );
    expect(enriched['ReadEndPoint.Ports']).toBe('6379,6379');
    // No ConfigurationEndpoint in cluster-mode-disabled.
    expect(enriched['ConfigurationEndPoint.Address']).toBeUndefined();
  });

  it('overlays ConfigurationEndPoint flat-keys (cluster-mode enabled) from DescribeReplicationGroups', async () => {
    mockElastiCacheSend.mockResolvedValueOnce({
      ReplicationGroups: [
        {
          ConfigurationEndpoint: { Address: 'clustercfg.myrg.abc.use1.cache.amazonaws.com', Port: 6379 },
          NodeGroups: [
            { ReaderEndpoint: { Address: 'shard1-ro.myrg.abc.use1.cache.amazonaws.com', Port: 6379 } },
            { ReaderEndpoint: { Address: 'shard2-ro.myrg.abc.use1.cache.amazonaws.com', Port: 6379 } },
          ],
        },
      ],
    });

    const enriched = await enrich('myrg', {});

    expect(enriched['ConfigurationEndPoint.Address']).toBe(
      'clustercfg.myrg.abc.use1.cache.amazonaws.com'
    );
    expect(enriched['ConfigurationEndPoint.Port']).toBe('6379');
    // ReadEndPoint.Addresses is the comma-joined list across both shards' readers.
    expect(enriched['ReadEndPoint.Addresses']).toBe(
      'shard1-ro.myrg.abc.use1.cache.amazonaws.com,shard2-ro.myrg.abc.use1.cache.amazonaws.com'
    );
    expect(enriched['ReadEndPoint.Ports']).toBe('6379,6379');
  });

  it('is best-effort: a failed DescribeReplicationGroups does not throw and leaves attributes unchanged', async () => {
    mockElastiCacheSend.mockRejectedValueOnce(
      Object.assign(new Error('access denied'), { name: 'AccessDeniedException' })
    );

    const enriched = await enrich('myrg', { ExistingAttr: 'keep-me' });

    expect(enriched).toEqual({ ExistingAttr: 'keep-me' });
    expect(enriched['PrimaryEndPoint.Address']).toBeUndefined();
  });
});

describe('CloudControlProvider Redshift Cluster attribute enrichment (CC-API routing)', () => {
  let provider: CloudControlProvider;

  const enrich = (physicalId: string, attributes: Record<string, unknown>) =>
    (
      provider as unknown as {
        enrichResourceAttributes: (
          resourceType: string,
          physicalId: string,
          attributes: Record<string, unknown>
        ) => Promise<Record<string, unknown>>;
      }
    ).enrichResourceAttributes('AWS::Redshift::Cluster', physicalId, attributes);

  beforeEach(() => {
    mockRedshiftSend.mockReset();
    provider = new CloudControlProvider();
  });

  it('overlays flat-key Endpoint.Address / Endpoint.Port (string) from DescribeClusters', async () => {
    mockRedshiftSend.mockResolvedValueOnce({
      Clusters: [
        {
          Endpoint: {
            Address: 'mycluster.abc123.us-east-1.redshift.amazonaws.com',
            Port: 5439,
          },
        },
      ],
    });

    const enriched = await enrich('mycluster', {});

    expect(enriched['Endpoint.Address']).toBe('mycluster.abc123.us-east-1.redshift.amazonaws.com');
    // Port coerced to string (the flat-key shape Fn::GetAtt consumers expect).
    expect(enriched['Endpoint.Port']).toBe('5439');
  });

  it('is best-effort: a failed DescribeClusters does not throw and leaves attributes unchanged', async () => {
    mockRedshiftSend.mockRejectedValueOnce(
      Object.assign(new Error('access denied'), { name: 'AccessDeniedException' })
    );

    const enriched = await enrich('mycluster', { ExistingAttr: 'keep-me' });

    expect(enriched).toEqual({ ExistingAttr: 'keep-me' });
    expect(enriched['Endpoint.Address']).toBeUndefined();
  });

  it('tolerates a cluster with no Endpoint yet (returns attributes unchanged)', async () => {
    mockRedshiftSend.mockResolvedValueOnce({ Clusters: [{}] });

    const enriched = await enrich('mycluster', {});

    expect(enriched['Endpoint.Address']).toBeUndefined();
    expect(enriched['Endpoint.Port']).toBeUndefined();
  });
});

describe('CloudControlProvider OpenSearch Domain attribute enrichment (CC-API routing)', () => {
  let provider: CloudControlProvider;

  const enrich = (physicalId: string, attributes: Record<string, unknown>) =>
    (
      provider as unknown as {
        enrichResourceAttributes: (
          resourceType: string,
          physicalId: string,
          attributes: Record<string, unknown>
        ) => Promise<Record<string, unknown>>;
      }
    ).enrichResourceAttributes('AWS::OpenSearchService::Domain', physicalId, attributes);

  beforeEach(() => {
    mockOpenSearchSend.mockReset();
    provider = new CloudControlProvider();
  });

  it('overlays DomainEndpoint / Arn / DomainArn / Id from DescribeDomain (public domain)', async () => {
    mockOpenSearchSend.mockResolvedValueOnce({
      DomainStatus: {
        Endpoint: 'search-mydomain-abc123.us-east-1.es.amazonaws.com',
        ARN: 'arn:aws:es:us-east-1:111122223333:domain/mydomain',
        DomainId: '111122223333/mydomain',
      },
    });

    const enriched = await enrich('mydomain', {});

    expect(enriched['DomainEndpoint']).toBe(
      'search-mydomain-abc123.us-east-1.es.amazonaws.com'
    );
    expect(enriched['Arn']).toBe('arn:aws:es:us-east-1:111122223333:domain/mydomain');
    // DomainArn is the documented alias for the same value.
    expect(enriched['DomainArn']).toBe('arn:aws:es:us-east-1:111122223333:domain/mydomain');
    expect(enriched['Id']).toBe('111122223333/mydomain');
    // DescribeDomain must be issued for the physicalId (the domain name).
    expect(mockOpenSearchSend).toHaveBeenCalledWith({
      __type: 'DescribeDomain',
      input: { DomainName: 'mydomain' },
    });
  });

  it('falls back to the Endpoints.vpc entry for a VPC domain (no public Endpoint)', async () => {
    mockOpenSearchSend.mockResolvedValueOnce({
      DomainStatus: {
        Endpoints: { vpc: 'vpc-mydomain-abc123.us-east-1.es.amazonaws.com' },
        ARN: 'arn:aws:es:us-east-1:111122223333:domain/mydomain',
      },
    });

    const enriched = await enrich('mydomain', {});

    expect(enriched['DomainEndpoint']).toBe(
      'vpc-mydomain-abc123.us-east-1.es.amazonaws.com'
    );
    // Arn overlay is endpoint-branch-independent — assert it still lands on
    // the VPC path too.
    expect(enriched['Arn']).toBe('arn:aws:es:us-east-1:111122223333:domain/mydomain');
  });

  it('is best-effort: a failed DescribeDomain does not throw and leaves attributes unchanged', async () => {
    mockOpenSearchSend.mockRejectedValueOnce(
      Object.assign(new Error('access denied'), { name: 'AccessDeniedException' })
    );

    const enriched = await enrich('mydomain', { ExistingAttr: 'keep-me' });

    expect(enriched).toEqual({ ExistingAttr: 'keep-me' });
    expect(enriched['DomainEndpoint']).toBeUndefined();
  });

  it('tolerates a domain with no Endpoint yet (returns attributes unchanged)', async () => {
    mockOpenSearchSend.mockResolvedValueOnce({ DomainStatus: {} });

    const enriched = await enrich('mydomain', {});

    expect(enriched['DomainEndpoint']).toBeUndefined();
    expect(enriched['Arn']).toBeUndefined();
  });
});
