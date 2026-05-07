import { describe, it, expect, vi, beforeEach } from 'vitest';
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
});
