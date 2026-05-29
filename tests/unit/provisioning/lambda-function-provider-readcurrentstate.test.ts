import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetFunctionCommand, ResourceNotFoundException } from '@aws-sdk/client-lambda';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    ec2: { send: vi.fn() },
  }),
}));

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

import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';

describe('LambdaFunctionProvider.readCurrentState', () => {
  let provider: LambdaFunctionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaFunctionProvider();
  });

  it('returns CFn-shaped properties from GetFunction (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      Configuration: {
        FunctionName: 'fn',
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: 'arn:aws:iam::123456789012:role/exec',
        Timeout: 30,
        MemorySize: 256,
        Description: 'a function',
        Environment: { Variables: { FOO: 'bar' } },
        Layers: [
          { Arn: 'arn:aws:lambda:us-east-1:123:layer:l1:1', CodeSize: 12 },
          { Arn: 'arn:aws:lambda:us-east-1:123:layer:l2:1', CodeSize: 34 },
        ],
        Architectures: ['arm64'],
        PackageType: 'Zip',
        TracingConfig: { Mode: 'Active' },
        EphemeralStorage: { Size: 512 },
        VpcConfig: {
          SubnetIds: ['subnet-a'],
          SecurityGroupIds: ['sg-1'],
          Ipv6AllowedForDualStack: false,
        },
        // AWS-managed fields the comparator should ignore (we never surface
        // them to keep the wire payload tight):
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
        LastModified: '2026-01-01T00:00:00.000+0000',
        RevisionId: 'rev-1',
        CodeSha256: 'abc',
      },
    });

    const result = await provider.readCurrentState('fn', 'Logical', 'AWS::Lambda::Function');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetFunctionCommand);
    expect(result).toEqual({
      FunctionName: 'fn',
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Role: 'arn:aws:iam::123456789012:role/exec',
      Timeout: 30,
      MemorySize: 256,
      Description: 'a function',
      Environment: { Variables: { FOO: 'bar' } },
      Layers: [
        'arn:aws:lambda:us-east-1:123:layer:l1:1',
        'arn:aws:lambda:us-east-1:123:layer:l2:1',
      ],
      Architectures: ['arm64'],
      PackageType: 'Zip',
      TracingConfig: { Mode: 'Active' },
      EphemeralStorage: { Size: 512 },
      VpcConfig: {
        SubnetIds: ['subnet-a'],
        SecurityGroupIds: ['sg-1'],
        Ipv6AllowedForDualStack: false,
      },
      Tags: [],
    });
  });

  it('returns undefined when function is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState('fn', 'Logical', 'AWS::Lambda::Function');

    expect(result).toBeUndefined();
  });

  it('emits VpcConfig placeholder with empty arrays when GetFunction returns no VPC (non-VPC function)', async () => {
    mockSend.mockResolvedValueOnce({
      Configuration: {
        FunctionName: 'fn',
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: 'arn:aws:iam::123456789012:role/exec',
        // No VpcConfig at all → placeholder { SubnetIds: [], SecurityGroupIds: [] }.
      },
    });

    const result = await provider.readCurrentState('fn', 'Logical', 'AWS::Lambda::Function');

    expect(result?.VpcConfig).toEqual({
      SubnetIds: [],
      SecurityGroupIds: [],
      Ipv6AllowedForDualStack: false,
    });
  });

  it('surfaces Tags from GetFunction with aws:* prefixed entries filtered out', async () => {
    mockSend.mockResolvedValueOnce({
      Configuration: {
        FunctionName: 'fn',
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: 'arn:aws:iam::123456789012:role/exec',
      },
      Tags: {
        Foo: 'Bar',
        'aws:cdk:path': 'MyStack/MyFunction/Resource',
        'aws:cdk:metadata': 'something',
      },
    });

    const result = await provider.readCurrentState('fn', 'Logical', 'AWS::Lambda::Function');

    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when GetFunction returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({
      Configuration: {
        FunctionName: 'fn',
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: 'arn:aws:iam::123456789012:role/exec',
      },
      Tags: { 'aws:cdk:path': 'MyStack/MyFunction/Resource' },
    });

    const result = await provider.readCurrentState('fn', 'Logical', 'AWS::Lambda::Function');

    expect(result?.Tags).toEqual([]);
  });

  // Structural regression test for the always-emit-placeholder convention
  // (docs/provider-development.md § 3b). Ensures every user-controllable
  // top-level CFn key is present in the result even when AWS returns
  // the resource with all optional fields undefined / empty. A future
  // refactor that drops a placeholder for any of these keys must update
  // this test consciously — silent regression is structurally prevented.
  it('emits placeholders for every user-controllable top-level key on AWS minimum response', async () => {
    mockSend.mockResolvedValueOnce({
      Configuration: {
        FunctionName: 'fn',
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: 'arn:aws:iam::123456789012:role/exec',
        Timeout: 3,
        MemorySize: 128,
        PackageType: 'Zip',
        // Description / Environment / Layers / Architectures / TracingConfig
        // / EphemeralStorage / VpcConfig deliberately omitted.
      },
      Tags: undefined,
    });

    const result = await provider.readCurrentState('fn', 'Logical', 'AWS::Lambda::Function');

    expect(Object.keys(result ?? {}).sort()).toEqual(
      [
        'Architectures',
        'Description',
        'Environment',
        'FunctionName',
        'Handler',
        'Layers',
        'MemorySize',
        'PackageType',
        'Role',
        'Runtime',
        'Tags',
        'Timeout',
        'TracingConfig',
        'VpcConfig',
      ].sort()
    );
    expect(result?.Description).toBe('');
    expect(result?.Environment).toEqual({ Variables: {} });
    expect(result?.Layers).toEqual([]);
    expect(result?.Architectures).toEqual([]);
    expect(result?.TracingConfig).toEqual({ Mode: 'PassThrough' });
    expect(result?.VpcConfig).toEqual({
      SubnetIds: [],
      SecurityGroupIds: [],
      Ipv6AllowedForDualStack: false,
    });
    expect(result?.Tags).toEqual([]);
  });

  // Issue #445: Code.ImageUri is recoverable from GetFunction for
  // container-package Lambdas. The pre-PR `getDriftUnknownPaths` declared
  // the whole `Code` subtree as drift-unknown, which also hid console-side
  // image swaps on container Lambdas. Surface `Code.ImageUri` when AWS
  // reports it; the ZIP-side sub-paths stay declared via
  // `getDriftUnknownPaths` (`Code.S3Bucket` / `Code.S3Key` /
  // `Code.S3ObjectVersion` / `Code.ZipFile` / `Code.SourceKMSKeyArn`).
  it('surfaces Code.ImageUri for container Lambdas (PackageType=Image)', async () => {
    mockSend.mockResolvedValueOnce({
      Configuration: {
        FunctionName: 'fn',
        Role: 'arn:aws:iam::123456789012:role/exec',
        Timeout: 3,
        MemorySize: 128,
        PackageType: 'Image',
      },
      Code: {
        RepositoryType: 'ECR',
        ImageUri:
          '123456789012.dkr.ecr.us-east-1.amazonaws.com/cdkd-asset:abc123',
        ResolvedImageUri:
          '123456789012.dkr.ecr.us-east-1.amazonaws.com/cdkd-asset@sha256:deadbeef',
      },
    });

    const result = await provider.readCurrentState('fn', 'Logical', 'AWS::Lambda::Function');

    expect(result?.PackageType).toBe('Image');
    expect(result?.Code).toEqual({
      ImageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/cdkd-asset:abc123',
    });
    // ResolvedImageUri is AWS-managed (post-resolution digest) and is NOT
    // a user-controllable input — intentionally not surfaced.
    expect(result?.Code).not.toHaveProperty('ResolvedImageUri');
  });

  it('omits the Code key entirely for ZIP-package Lambdas', async () => {
    mockSend.mockResolvedValueOnce({
      Configuration: {
        FunctionName: 'fn',
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: 'arn:aws:iam::123456789012:role/exec',
        PackageType: 'Zip',
      },
      // AWS returns a pre-signed URL on `Code.Location` for ZIP Lambdas —
      // that's not user-controllable and we must NOT surface it (would
      // fire false drift on every clean run).
      Code: {
        RepositoryType: 'S3',
        Location:
          'https://prod-04-2014-tasks.s3.us-east-1.amazonaws.com/snapshots/...',
      },
    });

    const result = await provider.readCurrentState('fn', 'Logical', 'AWS::Lambda::Function');

    // ZIP Lambdas: AWS only returns the presigned URL, not ImageUri →
    // omit the Code subtree entirely so the drift comparator's
    // state-keys-only walk handles the absence cleanly.
    expect(result).not.toHaveProperty('Code');
  });

  it('declares the ZIP-side Code sub-paths in getDriftUnknownPaths', () => {
    expect(provider.getDriftUnknownPaths()).toEqual([
      'Code.S3Bucket',
      'Code.S3Key',
      'Code.S3ObjectVersion',
      'Code.ZipFile',
      'Code.SourceKMSKeyArn',
    ]);
  });

  // Issue #609: the native config fields backfilled into create()/update()
  // are also read back so a console-side change surfaces as drift instead of
  // firing a false positive (state has the field, AWS readback omits it).
  it('surfaces DeadLetterConfig / KmsKeyArn / FileSystemConfigs / SnapStart / LoggingConfig when AWS returns them', async () => {
    mockSend.mockResolvedValueOnce({
      Configuration: {
        FunctionName: 'fn',
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: 'arn:aws:iam::123456789012:role/exec',
        DeadLetterConfig: { TargetArn: 'arn:aws:sqs:us-east-1:123:dlq' },
        KMSKeyArn: 'arn:aws:kms:us-east-1:123:key/abc',
        FileSystemConfigs: [
          {
            Arn: 'arn:aws:elasticfilesystem:us-east-1:123:access-point/fsap-1',
            LocalMountPath: '/mnt/data',
          },
        ],
        SnapStart: { ApplyOn: 'PublishedVersions', OptimizationStatus: 'On' },
        LoggingConfig: {
          LogFormat: 'JSON',
          ApplicationLogLevel: 'INFO',
          SystemLogLevel: 'INFO',
          LogGroup: '/aws/lambda/fn',
        },
      },
    });

    const result = await provider.readCurrentState('fn', 'Logical', 'AWS::Lambda::Function');

    expect(result?.DeadLetterConfig).toEqual({ TargetArn: 'arn:aws:sqs:us-east-1:123:dlq' });
    // GetFunction returns KMSKeyArn; cdkd surfaces it under the CFn name KmsKeyArn.
    expect(result?.KmsKeyArn).toBe('arn:aws:kms:us-east-1:123:key/abc');
    expect(result?.FileSystemConfigs).toEqual([
      {
        Arn: 'arn:aws:elasticfilesystem:us-east-1:123:access-point/fsap-1',
        LocalMountPath: '/mnt/data',
      },
    ]);
    // OptimizationStatus is AWS-managed and must NOT be surfaced (CFn SnapStart
    // is { ApplyOn } only).
    expect(result?.SnapStart).toEqual({ ApplyOn: 'PublishedVersions' });
    // All four LoggingConfig sub-fields are user-controllable, so all surface.
    expect(result?.LoggingConfig).toEqual({
      LogFormat: 'JSON',
      ApplicationLogLevel: 'INFO',
      SystemLogLevel: 'INFO',
      LogGroup: '/aws/lambda/fn',
    });
  });

  it('surfaces only LogFormat + LogGroup for a Text-format LoggingConfig (no JSON-only levels)', async () => {
    // Text format has no ApplicationLogLevel / SystemLogLevel; AWS omits them,
    // so the emit-when-present sub-field guards keep them out of the readback.
    mockSend.mockResolvedValueOnce({
      Configuration: {
        FunctionName: 'fn',
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: 'arn:aws:iam::123456789012:role/exec',
        LoggingConfig: { LogFormat: 'Text', LogGroup: '/aws/lambda/fn' },
      },
    });

    const result = await provider.readCurrentState('fn', 'Logical', 'AWS::Lambda::Function');

    expect(result?.LoggingConfig).toEqual({ LogFormat: 'Text', LogGroup: '/aws/lambda/fn' });
  });

  it('surfaces ImageConfig nested under ImageConfigResponse for container Lambdas', async () => {
    mockSend.mockResolvedValueOnce({
      Configuration: {
        FunctionName: 'fn',
        Role: 'arn:aws:iam::123456789012:role/exec',
        PackageType: 'Image',
        ImageConfigResponse: {
          ImageConfig: {
            Command: ['app.handler'],
            EntryPoint: ['/lambda-entrypoint.sh'],
            WorkingDirectory: '/var/task',
          },
        },
      },
    });

    const result = await provider.readCurrentState('fn', 'Logical', 'AWS::Lambda::Function');

    expect(result?.ImageConfig).toEqual({
      EntryPoint: ['/lambda-entrypoint.sh'],
      Command: ['app.handler'],
      WorkingDirectory: '/var/task',
    });
  });

  it('omits the native config fields when AWS does not return them (no false-positive drift)', async () => {
    mockSend.mockResolvedValueOnce({
      Configuration: {
        FunctionName: 'fn',
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: 'arn:aws:iam::123456789012:role/exec',
        // None of the native config fields present.
      },
    });

    const result = await provider.readCurrentState('fn', 'Logical', 'AWS::Lambda::Function');

    expect(result).not.toHaveProperty('DeadLetterConfig');
    expect(result).not.toHaveProperty('KmsKeyArn');
    expect(result).not.toHaveProperty('FileSystemConfigs');
    expect(result).not.toHaveProperty('ImageConfig');
    expect(result).not.toHaveProperty('SnapStart');
    expect(result).not.toHaveProperty('LoggingConfig');
  });
});
