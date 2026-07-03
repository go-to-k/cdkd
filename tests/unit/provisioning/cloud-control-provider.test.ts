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
// EventBridge client is reached via the mocked getAwsClients() factory
// (getAwsClients().eventBridge), so its send() is controllable through this
// hoisted spy injected into the factory mock below — used by the
// AWS::Events::Connection / AWS::Events::ApiDestination enrichment branches.
const mockEventBridgeSend = vi.hoisted(() => vi.fn());

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
    eventBridge: { send: mockEventBridgeSend },
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

import {
  CloudControlProvider,
  CloudControlOperationFailedError,
} from '../../../src/provisioning/cloud-control-provider.js';
import { clearWriteOnlyPropertiesCache } from '../../../src/provisioning/write-only-properties.js';
import { isRetryableTransientError } from '../../../src/deployment/retryable-errors.js';

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

describe('CloudControlProvider Events Connection attribute enrichment (CC-API routing)', () => {
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
    ).enrichResourceAttributes('AWS::Events::Connection', physicalId, attributes);

  beforeEach(() => {
    mockEventBridgeSend.mockReset();
    provider = new CloudControlProvider();
  });

  it('overlays Arn / SecretArn / ArnForPolicy from DescribeConnection (the canonical ApiDestination ConnectionArn source)', async () => {
    mockEventBridgeSend.mockResolvedValueOnce({
      ConnectionArn:
        'arn:aws:events:us-east-1:123456789012:connection/my-conn/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      SecretArn:
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:events!connection/my-conn/abc-AbCdEf',
    });

    // The CC physicalId is the connection NAME (primaryIdentifier), not the ARN.
    const enriched = await enrich('my-conn', {});

    expect(enriched['Arn']).toBe(
      'arn:aws:events:us-east-1:123456789012:connection/my-conn/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );
    expect(enriched['SecretArn']).toBe(
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:events!connection/my-conn/abc-AbCdEf'
    );
    // ArnForPolicy is the full ARN with the trailing unique suffix stripped.
    expect(enriched['ArnForPolicy']).toBe(
      'arn:aws:events:us-east-1:123456789012:connection/my-conn'
    );
    // DescribeConnection must be issued for the physicalId (the connection name).
    expect(mockEventBridgeSend).toHaveBeenCalledTimes(1);
    const sentCommand = mockEventBridgeSend.mock.calls[0]![0] as { input: { Name: string } };
    expect(sentCommand.input).toEqual({ Name: 'my-conn' });
  });

  it('does not overwrite an Arn the CC API already returned', async () => {
    mockEventBridgeSend.mockResolvedValueOnce({
      ConnectionArn: 'arn:aws:events:us-east-1:123456789012:connection/my-conn/should-not-win',
    });

    const enriched = await enrich('my-conn', {
      Arn: 'arn:aws:events:us-east-1:123456789012:connection/my-conn/already-set',
      SecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:already-set',
      ArnForPolicy: 'arn:aws:events:us-east-1:123456789012:connection/my-conn',
    });

    // All three present already -> no DescribeConnection call, originals kept.
    expect(mockEventBridgeSend).not.toHaveBeenCalled();
    expect(enriched['Arn']).toBe(
      'arn:aws:events:us-east-1:123456789012:connection/my-conn/already-set'
    );
  });

  it('fills only the missing attrs when CC already returned some (per-field independence)', async () => {
    mockEventBridgeSend.mockResolvedValueOnce({
      ConnectionArn:
        'arn:aws:events:us-east-1:123456789012:connection/my-conn/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      SecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:from-describe',
    });

    // CC already surfaced SecretArn but NOT Arn / ArnForPolicy — the outer guard
    // still fires (Arn is missing), and the per-field `!enriched[x]` guards must
    // keep the existing SecretArn while filling Arn + ArnForPolicy.
    const enriched = await enrich('my-conn', {
      SecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:already-from-cc',
    });

    expect(mockEventBridgeSend).toHaveBeenCalledTimes(1);
    expect(enriched['Arn']).toBe(
      'arn:aws:events:us-east-1:123456789012:connection/my-conn/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );
    expect(enriched['ArnForPolicy']).toBe(
      'arn:aws:events:us-east-1:123456789012:connection/my-conn'
    );
    // The CC-returned SecretArn is preserved (not overwritten by DescribeConnection).
    expect(enriched['SecretArn']).toBe(
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:already-from-cc'
    );
  });

  it('is best-effort: a failed DescribeConnection does not throw and leaves attributes unchanged', async () => {
    mockEventBridgeSend.mockRejectedValueOnce(
      Object.assign(new Error('access denied'), { name: 'AccessDeniedException' })
    );

    const enriched = await enrich('my-conn', { ExistingAttr: 'keep-me' });

    expect(enriched).toEqual({ ExistingAttr: 'keep-me' });
    expect(enriched['Arn']).toBeUndefined();
  });
});

describe('CloudControlProvider Events ApiDestination attribute enrichment (CC-API routing)', () => {
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
    ).enrichResourceAttributes('AWS::Events::ApiDestination', physicalId, attributes);

  beforeEach(() => {
    mockEventBridgeSend.mockReset();
    provider = new CloudControlProvider();
  });

  it('overlays Arn / ArnForPolicy from DescribeApiDestination', async () => {
    mockEventBridgeSend.mockResolvedValueOnce({
      ApiDestinationArn:
        'arn:aws:events:us-east-1:123456789012:api-destination/my-dest/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });

    const enriched = await enrich('my-dest', {});

    expect(enriched['Arn']).toBe(
      'arn:aws:events:us-east-1:123456789012:api-destination/my-dest/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );
    expect(enriched['ArnForPolicy']).toBe(
      'arn:aws:events:us-east-1:123456789012:api-destination/my-dest'
    );
    const sentCommand = mockEventBridgeSend.mock.calls[0]![0] as { input: { Name: string } };
    expect(sentCommand.input).toEqual({ Name: 'my-dest' });
  });

  it('is best-effort: a failed DescribeApiDestination does not throw and leaves attributes unchanged', async () => {
    mockEventBridgeSend.mockRejectedValueOnce(
      Object.assign(new Error('access denied'), { name: 'AccessDeniedException' })
    );

    const enriched = await enrich('my-dest', { ExistingAttr: 'keep-me' });

    expect(enriched).toEqual({ ExistingAttr: 'keep-me' });
    expect(enriched['Arn']).toBeUndefined();
  });
});

describe('CloudControlProvider Backup attribute enrichment (CC-API routing, issue #984)', () => {
  let provider: CloudControlProvider;

  const enrich = (
    resourceType: string,
    physicalId: string,
    attributes: Record<string, unknown>
  ) =>
    (
      provider as unknown as {
        enrichResourceAttributes: (
          resourceType: string,
          physicalId: string,
          attributes: Record<string, unknown>
        ) => Promise<Record<string, unknown>>;
      }
    ).enrichResourceAttributes(resourceType, physicalId, attributes);

  // The Backup branches read back via the CC GetResource path
  // (this.cloudControlClient.send(GetResourceCommand)), so the CC send spy is
  // what returns the read-back model.
  const mockCcModel = (model: Record<string, unknown>) => {
    mockCloudControlSend.mockResolvedValueOnce({
      ResourceDescription: { Properties: JSON.stringify(model) },
    });
  };

  beforeEach(() => {
    mockCloudControlSend.mockReset();
    provider = new CloudControlProvider();
  });

  it('BackupVault: overlays BackupVaultArn from the CC GetResource model', async () => {
    mockCcModel({
      BackupVaultName: 'my-vault',
      BackupVaultArn: 'arn:aws:backup:us-east-1:123456789012:backup-vault:my-vault',
    });

    // physicalId is the vault NAME (the type's Ref-return), NOT the ARN.
    const enriched = await enrich('AWS::Backup::BackupVault', 'my-vault', {});

    expect(enriched['BackupVaultArn']).toBe(
      'arn:aws:backup:us-east-1:123456789012:backup-vault:my-vault'
    );
    // BackupVaultName resolves to the physicalId even when the model omits it.
    expect(enriched['BackupVaultName']).toBe('my-vault');
    // GetResource must be issued for the physicalId (the vault name).
    const sent = mockCloudControlSend.mock.calls[0]![0] as {
      input: { TypeName: string; Identifier: string };
    };
    expect(sent.input.TypeName).toBe('AWS::Backup::BackupVault');
    expect(sent.input.Identifier).toBe('my-vault');
  });

  it('BackupVault: is best-effort — a failed GetResource does not throw and leaves attributes unchanged (except physicalId fallbacks)', async () => {
    mockCloudControlSend.mockRejectedValueOnce(
      Object.assign(new Error('access denied'), { name: 'AccessDeniedException' })
    );

    const enriched = await enrich('AWS::Backup::BackupVault', 'my-vault', {
      ExistingAttr: 'keep-me',
    });

    expect(enriched['ExistingAttr']).toBe('keep-me');
    expect(enriched['BackupVaultArn']).toBeUndefined();
    // The name fallback still lands (it does not depend on the read-back).
    expect(enriched['BackupVaultName']).toBe('my-vault');
  });

  it('BackupPlan: overlays BackupPlanArn / VersionId from the CC GetResource model', async () => {
    mockCcModel({
      BackupPlanId: 'plan-1234',
      BackupPlanArn: 'arn:aws:backup:us-east-1:123456789012:backup-plan:plan-1234',
      VersionId: 'AbCdEf1234567890VersionToken',
    });

    const enriched = await enrich('AWS::Backup::BackupPlan', 'plan-1234', {});

    expect(enriched['BackupPlanArn']).toBe(
      'arn:aws:backup:us-east-1:123456789012:backup-plan:plan-1234'
    );
    expect(enriched['VersionId']).toBe('AbCdEf1234567890VersionToken');
    expect(enriched['BackupPlanId']).toBe('plan-1234');
  });

  it('BackupPlan: is best-effort — a failed GetResource leaves attributes unchanged (except physicalId fallback)', async () => {
    mockCloudControlSend.mockRejectedValueOnce(
      Object.assign(new Error('throttled'), { name: 'ThrottlingException' })
    );

    const enriched = await enrich('AWS::Backup::BackupPlan', 'plan-1234', {});

    expect(enriched['BackupPlanArn']).toBeUndefined();
    expect(enriched['VersionId']).toBeUndefined();
    // BackupPlanId falls back to the physicalId.
    expect(enriched['BackupPlanId']).toBe('plan-1234');
  });

  it('BackupSelection: extracts SelectionId from the compound physicalId and prefers the CC model value', async () => {
    // Return DIFFERENT values from the read-back than the compound-id split
    // would produce, so the assertion proves the CC model value wins (not that
    // the split coincidentally matches).
    mockCcModel({
      SelectionId: 'sel-from-model',
      BackupPlanId: 'plan-from-model',
    });

    // CC primaryIdentifier value is `<SelectionId>|<BackupPlanId>`.
    const enriched = await enrich(
      'AWS::Backup::BackupSelection',
      'sel-abcdef|plan-1234',
      {}
    );

    expect(enriched['SelectionId']).toBe('sel-from-model');
    expect(enriched['BackupPlanId']).toBe('plan-from-model');
  });

  it('BackupSelection: falls back to the compound-id split when the CC read fails', async () => {
    mockCloudControlSend.mockRejectedValueOnce(
      Object.assign(new Error('access denied'), { name: 'AccessDeniedException' })
    );

    const enriched = await enrich(
      'AWS::Backup::BackupSelection',
      'sel-abcdef|plan-1234',
      {}
    );

    // The split fallback still resolves both without the read-back.
    expect(enriched['SelectionId']).toBe('sel-abcdef');
    expect(enriched['BackupPlanId']).toBe('plan-1234');
  });
});

describe('CloudControlProvider create: failed-create remnant cleanup', () => {
  let provider: CloudControlProvider;

  // Wires the cloudControl mock for the async-create-materializes-then-fails
  // shape (the AWS::Synthetics::Canary repro): CreateResource returns a token,
  // its status poll reports FAILED carrying the materialized Identifier, and
  // the remnant DeleteResource (when issued) is routed by its own token.
  function wireFailedCreate(opts: {
    errorCode?: string;
    identifier?: string;
    deleteStatus?: 'SUCCESS' | 'FAILED';
    deleteFailedMessage?: string;
    deleteRejects?: Error;
    statusRejects?: Error;
  }): void {
    mockCloudControlSend.mockImplementation(
      (cmd: { constructor: { name: string }; input?: { RequestToken?: string } }) => {
        const name = cmd.constructor.name;
        if (name === 'CreateResourceCommand') {
          return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-create' } });
        }
        if (name === 'DeleteResourceCommand') {
          if (opts.deleteRejects) return Promise.reject(opts.deleteRejects);
          return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-delete' } });
        }
        if (name === 'GetResourceRequestStatusCommand' && opts.statusRejects) {
          return Promise.reject(opts.statusRejects);
        }
        if (name === 'GetResourceRequestStatusCommand') {
          if (cmd.input?.RequestToken === 'tok-create') {
            return Promise.resolve({
              ProgressEvent: {
                OperationStatus: 'FAILED',
                TypeName: 'AWS::Synthetics::Canary',
                ...(opts.identifier !== undefined && { Identifier: opts.identifier }),
                ErrorCode: opts.errorCode ?? 'GeneralServiceException',
                StatusMessage:
                  'The role defined for the function cannot be assumed by Lambda.',
              },
            });
          }
          return Promise.resolve({
            ProgressEvent:
              opts.deleteStatus === 'FAILED'
                ? {
                    OperationStatus: 'FAILED',
                    ErrorCode: 'GeneralServiceException',
                    StatusMessage: opts.deleteFailedMessage ?? 'internal failure',
                  }
                : { OperationStatus: 'SUCCESS' },
          });
        }
        return Promise.resolve({});
      }
    );
  }

  const deleteCallIdentifiers = (): string[] =>
    mockCloudControlSend.mock.calls
      .filter((c) => c[0]?.constructor?.name === 'DeleteResourceCommand')
      .map((c) => (c[0] as { input: { Identifier: string } }).input.Identifier);

  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudControlConfigRegion.mockResolvedValue('us-east-1');
    provider = new CloudControlProvider();
  });

  it('deletes the materialized remnant when a CREATE fails after returning an Identifier', async () => {
    wireFailedCreate({ identifier: 'cdkd-bh-syn' });

    await expect(
      provider.create('Canary', 'AWS::Synthetics::Canary', { Name: 'cdkd-bh-syn' })
    ).rejects.toThrow(/CREATE failed for Canary: The role defined for the function/);

    // The remnant occupying the name was deleted so the deploy engine's outer
    // withRetry can re-create it once IAM propagates.
    expect(deleteCallIdentifiers()).toEqual(['cdkd-bh-syn']);
  });

  it('rethrows the ORIGINAL create error (retry-classifiable), not the cleanup outcome', async () => {
    wireFailedCreate({ identifier: 'cdkd-bh-syn' });

    const error = await provider
      .create('Canary', 'AWS::Synthetics::Canary', { Name: 'cdkd-bh-syn' })
      .then(
        () => undefined,
        (e: unknown) => e as CloudControlOperationFailedError
      );

    expect(error).toBeInstanceOf(CloudControlOperationFailedError);
    expect(error).toMatchObject({
      name: 'CloudControlOperationFailedError',
      physicalId: 'cdkd-bh-syn',
      ccErrorCode: 'GeneralServiceException',
      ccOperation: 'CREATE',
    });
  });

  it('NEVER deletes when the handler reported AlreadyExists (identifier names a pre-existing resource)', async () => {
    wireFailedCreate({ errorCode: 'AlreadyExists', identifier: 'users-precious-canary' });

    await expect(
      provider.create('Canary', 'AWS::Synthetics::Canary', { Name: 'users-precious-canary' })
    ).rejects.toThrow(/CREATE failed for Canary/);

    expect(deleteCallIdentifiers()).toEqual([]);
  });

  it('does nothing when the FAILED event carries no Identifier', async () => {
    wireFailedCreate({ identifier: undefined });

    await expect(
      provider.create('Canary', 'AWS::Synthetics::Canary', { Name: 'cdkd-bh-syn' })
    ).rejects.toThrow(/CREATE failed for Canary/);

    expect(deleteCallIdentifiers()).toEqual([]);
  });

  it('treats a NotFound on the remnant delete as a no-op (speculative identifier, nothing materialized)', async () => {
    wireFailedCreate({
      identifier: 'speculative-id',
      deleteRejects: Object.assign(new Error('Resource not found'), {
        name: 'ResourceNotFoundException',
      }),
    });

    await expect(
      provider.create('Group', 'AWS::CodeDeploy::DeploymentGroup', { ApplicationName: 'app' })
    ).rejects.toThrow(/CREATE failed for Group/);

    expect(deleteCallIdentifiers()).toEqual(['speculative-id']);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('warns but still rethrows the original error when the remnant delete itself fails', async () => {
    wireFailedCreate({ identifier: 'cdkd-bh-syn', deleteStatus: 'FAILED' });

    await expect(
      provider.create('Canary', 'AWS::Synthetics::Canary', { Name: 'cdkd-bh-syn' })
    ).rejects.toThrow(/CREATE failed for Canary: The role defined for the function/);

    expect(deleteCallIdentifiers()).toEqual(['cdkd-bh-syn']);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete the remnant cdkd-bh-syn')
    );
  });

  it('NEVER deletes when the handler reported ResourceConflict (identifier may belong to another in-flight operation)', async () => {
    wireFailedCreate({ errorCode: 'ResourceConflict', identifier: 'contested-resource' });

    await expect(
      provider.create('Canary', 'AWS::Synthetics::Canary', { Name: 'contested-resource' })
    ).rejects.toThrow(/CREATE failed for Canary/);

    expect(deleteCallIdentifiers()).toEqual([]);
  });

  it('the rethrown stabilization failure stays retry-classifiable by the deploy engine classifier', async () => {
    wireFailedCreate({ identifier: 'cdkd-bh-syn' });

    const error = await provider
      .create('Canary', 'AWS::Synthetics::Canary', { Name: 'cdkd-bh-syn' })
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    // This is the integration point the fix exists for: after the remnant is
    // cleaned, the deploy engine's outer withRetry must still classify the
    // original error as transient so the re-create actually happens.
    expect(isRetryableTransientError(error, error!.message)).toBe(true);
  });

  it('treats an async FAILED-NotFound remnant delete as a no-op (no warning)', async () => {
    wireFailedCreate({
      identifier: 'speculative-id',
      deleteStatus: 'FAILED',
      deleteFailedMessage: "Resource of type 'AWS::Foo::Bar' with identifier 'speculative-id' was not found.",
    });

    await expect(
      provider.create('Thing', 'AWS::Foo::Bar', { Name: 'speculative-id' })
    ).rejects.toThrow(/CREATE failed for Thing/);

    expect(deleteCallIdentifiers()).toEqual(['speculative-id']);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('does not fire cleanup for a non-progress-event error (status polling network failure)', async () => {
    wireFailedCreate({ statusRejects: new Error('socket hang up') });

    await expect(
      provider.create('Canary', 'AWS::Synthetics::Canary', { Name: 'cdkd-bh-syn' })
    ).rejects.toThrow(/socket hang up/);

    expect(deleteCallIdentifiers()).toEqual([]);
  });

  it('does not fire remnant cleanup for a FAILED UPDATE (existing resource must survive)', async () => {
    mockCloudControlSend.mockImplementation(
      (cmd: { constructor: { name: string } }) => {
        const name = cmd.constructor.name;
        if (name === 'UpdateResourceCommand') {
          return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-update' } });
        }
        if (name === 'GetResourceRequestStatusCommand') {
          return Promise.resolve({
            ProgressEvent: {
              OperationStatus: 'FAILED',
              Identifier: 'existing-resource',
              ErrorCode: 'GeneralServiceException',
              StatusMessage: 'update blew up',
            },
          });
        }
        return Promise.resolve({});
      }
    );
    mockCloudFormationSend.mockResolvedValue({ Schema: JSON.stringify({}) });

    await expect(
      provider.update(
        'Thing',
        'existing-resource',
        'AWS::Some::Type',
        { Prop: 'new' },
        { Prop: 'old' }
      )
    ).rejects.toThrow(/UPDATE failed for Thing/);

    expect(deleteCallIdentifiers()).toEqual([]);
  });
});
