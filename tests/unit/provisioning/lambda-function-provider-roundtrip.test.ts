import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetFunctionCommand,
  UpdateFunctionConfigurationCommand,
  UpdateFunctionCodeCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-lambda';

// Mock AWS clients before importing the provider
const mockLambdaSend = vi.fn();
const mockEc2Send = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: {
      send: mockLambdaSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    ec2: { send: mockEc2Send },
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

// SDK waiter polls GetFunction; short-circuit it.
vi.mock('@aws-sdk/client-lambda', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-lambda')>(
    '@aws-sdk/client-lambda'
  );
  return {
    ...actual,
    waitUntilFunctionUpdatedV2: vi.fn().mockResolvedValue({ state: 'SUCCESS' }),
  };
});

import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';

const FUNCTION_NAME = 'fn-roundtrip';

describe('LambdaFunctionProvider read-update round-trip', () => {
  let provider: LambdaFunctionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaFunctionProvider();
  });

  it('Class 2 — non-VPC observed snapshot round-trips without AWS-rejection-shape input', async () => {
    // Mechanical guard for Class 2 placeholder regression on
    // structurally-incomplete-when-empty fields (VpcConfig). See
    // docs/provider-development.md § 3b "Read-update round-trip test".
    //
    // readCurrentState always-emits VpcConfig with empty arrays for
    // non-VPC functions (the placeholder is required so the comparator's
    // top-level walk detects a console-side VPC attach). Round-tripping
    // that placeholder via update() must NOT produce a VpcConfig payload
    // that AWS rejects (e.g. SubnetIds: undefined, partial-shape input).
    //
    // The diff in update() compares state vs previous via JSON.stringify;
    // when state == previous (no drift), no UpdateFunctionConfigurationCommand
    // should fire at all.
    mockLambdaSend.mockImplementation((cmd) => {
      if (cmd instanceof GetFunctionCommand) {
        return Promise.resolve({
          Configuration: { FunctionArn: `arn:aws:lambda:us-east-1:0:function:${FUNCTION_NAME}`, FunctionName: FUNCTION_NAME },
        });
      }
      return Promise.resolve({});
    });

    // Snapshot matches what readCurrentState produces for a non-VPC
    // function: every always-emit placeholder is present.
    const observed = {
      FunctionName: FUNCTION_NAME,
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Role: 'arn:aws:iam::0:role/exec',
      Timeout: 3,
      MemorySize: 128,
      PackageType: 'Zip',
      Description: '',
      Environment: { Variables: {} },
      Layers: [] as string[],
      Architectures: ['x86_64'],
      TracingConfig: { Mode: 'PassThrough' },
      VpcConfig: {
        SubnetIds: [] as string[],
        SecurityGroupIds: [] as string[],
        Ipv6AllowedForDualStack: false,
      },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    await provider.update('L', FUNCTION_NAME, 'AWS::Lambda::Function', observed, observed);

    // No drift → no UpdateFunctionConfigurationCommand fires (the
    // JSON.stringify diff in update() detects "no config change" and
    // skips the call entirely).
    const updateConfigCalls = mockLambdaSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateFunctionConfigurationCommand
    );
    expect(updateConfigCalls).toHaveLength(0);

    // No drift → no UpdateFunctionCodeCommand either (Code subtree is
    // declared via getDriftUnknownPaths, but the diff guard also short-
    // circuits on equal Code values; here Code is absent on both sides).
    const updateCodeCalls = mockLambdaSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateFunctionCodeCommand
    );
    expect(updateCodeCalls).toHaveLength(0);

    // No drift → no tag mutations.
    const tagCalls = mockLambdaSend.mock.calls.filter(
      (c) => c[0] instanceof TagResourceCommand || c[0] instanceof UntagResourceCommand
    );
    expect(tagCalls).toHaveLength(0);
  });

  it('Class 2 — VPC observed snapshot round-trips without AWS-rejection-shape input', async () => {
    // Complement of the non-VPC test: when the function IS attached to
    // a VPC, the snapshot has populated SubnetIds / SecurityGroupIds.
    // Round-tripping must still produce zero AWS-side mutations when
    // state == observed.
    mockLambdaSend.mockImplementation((cmd) => {
      if (cmd instanceof GetFunctionCommand) {
        return Promise.resolve({
          Configuration: { FunctionArn: `arn:aws:lambda:us-east-1:0:function:${FUNCTION_NAME}`, FunctionName: FUNCTION_NAME },
        });
      }
      return Promise.resolve({});
    });

    const observed = {
      FunctionName: FUNCTION_NAME,
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Role: 'arn:aws:iam::0:role/exec',
      Timeout: 30,
      MemorySize: 256,
      PackageType: 'Zip',
      Description: 'a function',
      Environment: { Variables: { FOO: 'bar' } },
      Layers: ['arn:aws:lambda:us-east-1:0:layer:l1:1'],
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
      EphemeralStorage: { Size: 1024 },
      VpcConfig: {
        SubnetIds: ['subnet-a'],
        SecurityGroupIds: ['sg-1'],
        Ipv6AllowedForDualStack: false,
      },
      Tags: [{ Key: 'Foo', Value: 'Bar' }],
    };

    await provider.update('L', FUNCTION_NAME, 'AWS::Lambda::Function', observed, observed);

    const updateConfigCalls = mockLambdaSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateFunctionConfigurationCommand
    );
    expect(updateConfigCalls).toHaveLength(0);

    const updateCodeCalls = mockLambdaSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateFunctionCodeCommand
    );
    expect(updateCodeCalls).toHaveLength(0);

    const tagCalls = mockLambdaSend.mock.calls.filter(
      (c) => c[0] instanceof TagResourceCommand || c[0] instanceof UntagResourceCommand
    );
    expect(tagCalls).toHaveLength(0);
  });

  it('round-trip on no-drift snapshot is a logical no-op (zero AWS-mutating calls)', async () => {
    // Stronger assertion for diff-based providers: state == AWS implies
    // update() must make no AWS-side mutations. The structural guard
    // for the next time someone changes update()'s diff logic.
    mockLambdaSend.mockImplementation((cmd) => {
      if (cmd instanceof GetFunctionCommand) {
        return Promise.resolve({
          Configuration: { FunctionArn: `arn:aws:lambda:us-east-1:0:function:${FUNCTION_NAME}`, FunctionName: FUNCTION_NAME },
        });
      }
      return Promise.resolve({});
    });

    const observed = {
      FunctionName: FUNCTION_NAME,
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Role: 'arn:aws:iam::0:role/exec',
      Timeout: 3,
      MemorySize: 128,
      PackageType: 'Zip',
      Description: '',
      Environment: { Variables: {} },
      Layers: [] as string[],
      Architectures: ['x86_64'],
      TracingConfig: { Mode: 'PassThrough' },
      VpcConfig: {
        SubnetIds: [] as string[],
        SecurityGroupIds: [] as string[],
        Ipv6AllowedForDualStack: false,
      },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    await provider.update('L', FUNCTION_NAME, 'AWS::Lambda::Function', observed, observed);

    // Strongest possible guarantee: every mutating Lambda command class
    // is checked here. Only the read-only GetFunctionCommand may fire
    // (we need its FunctionArn for the tag-diff path).
    const mutatingCalls = mockLambdaSend.mock.calls.filter(
      (c) =>
        c[0] instanceof UpdateFunctionConfigurationCommand ||
        c[0] instanceof UpdateFunctionCodeCommand ||
        c[0] instanceof TagResourceCommand ||
        c[0] instanceof UntagResourceCommand
    );
    expect(mutatingCalls).toHaveLength(0);
  });
});
