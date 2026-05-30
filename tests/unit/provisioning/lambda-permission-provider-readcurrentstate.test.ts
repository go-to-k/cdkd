import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetPolicyCommand, ResourceNotFoundException } from '@aws-sdk/client-lambda';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { LambdaPermissionProvider } from '../../../src/provisioning/providers/lambda-permission-provider.js';

describe('LambdaPermissionProvider.readCurrentState', () => {
  let provider: LambdaPermissionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaPermissionProvider();
  });

  it('finds the matching Sid statement and flattens to CFn shape (happy path)', async () => {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'OtherStatement',
          Action: 'lambda:InvokeFunction',
          Principal: { Service: 'sns.amazonaws.com' },
        },
        {
          Sid: 'MyPermission',
          Action: 'lambda:InvokeFunction',
          Principal: { Service: 'apigateway.amazonaws.com' },
          Condition: {
            ArnLike: { 'AWS:SourceArn': 'arn:aws:execute-api:us-east-1:123:abcd/*' },
            StringEquals: { 'AWS:SourceAccount': '123456789012' },
          },
        },
      ],
    };
    mockSend.mockResolvedValueOnce({ Policy: JSON.stringify(policy) });

    const result = await provider.readCurrentState(
      'MyPermission',
      'PermissionLogical',
      'AWS::Lambda::Permission',
      { FunctionName: 'my-function' }
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetPolicyCommand);
    expect(result).toEqual({
      FunctionName: 'my-function',
      Action: 'lambda:InvokeFunction',
      Principal: 'apigateway.amazonaws.com',
      SourceArn: 'arn:aws:execute-api:us-east-1:123:abcd/*',
      SourceAccount: '123456789012',
    });
  });

  it('flattens AWS principal (account id form)', async () => {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AccountPerm',
          Action: 'lambda:InvokeFunction',
          Principal: { AWS: 'arn:aws:iam::123456789012:root' },
        },
      ],
    };
    mockSend.mockResolvedValueOnce({ Policy: JSON.stringify(policy) });

    const result = await provider.readCurrentState(
      'AccountPerm',
      'PermissionLogical',
      'AWS::Lambda::Permission',
      { FunctionName: 'my-function' }
    );

    expect(result).toMatchObject({
      Principal: 'arn:aws:iam::123456789012:root',
    });
  });

  it('extracts PrincipalOrgID from StringEquals condition', async () => {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'OrgPerm',
          Action: 'lambda:InvokeFunction',
          Principal: '*',
          Condition: { StringEquals: { 'aws:PrincipalOrgID': 'o-abc123' } },
        },
      ],
    };
    mockSend.mockResolvedValueOnce({ Policy: JSON.stringify(policy) });

    const result = await provider.readCurrentState(
      'OrgPerm',
      'PermissionLogical',
      'AWS::Lambda::Permission',
      { FunctionName: 'my-function' }
    );

    expect(result).toMatchObject({
      Principal: '*',
      PrincipalOrgID: 'o-abc123',
    });
  });

  it('returns undefined when function policy not found', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      'MyPermission',
      'PermissionLogical',
      'AWS::Lambda::Permission',
      { FunctionName: 'my-function' }
    );

    expect(result).toBeUndefined();
  });

  it('returns undefined when matching Sid is missing from policy', async () => {
    const policy = {
      Version: '2012-10-17',
      Statement: [{ Sid: 'OtherSid', Action: 'lambda:InvokeFunction', Principal: { AWS: '*' } }],
    };
    mockSend.mockResolvedValueOnce({ Policy: JSON.stringify(policy) });

    const result = await provider.readCurrentState(
      'MissingSid',
      'PermissionLogical',
      'AWS::Lambda::Permission',
      { FunctionName: 'my-function' }
    );

    expect(result).toBeUndefined();
  });

  it('returns undefined when FunctionName is missing from properties', async () => {
    const result = await provider.readCurrentState(
      'MyPermission',
      'PermissionLogical',
      'AWS::Lambda::Permission',
      {}
    );

    expect(result).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('surfaces InvokedViaFunctionUrl: true when AWS injects the Bool lambda:InvokedViaFunctionUrl condition (issue #609)', async () => {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'FnUrlPerm',
          Action: 'lambda:InvokeFunction',
          Principal: '*',
          Condition: {
            Bool: { 'lambda:InvokedViaFunctionUrl': 'true' },
          },
        },
      ],
    };
    mockSend.mockResolvedValueOnce({ Policy: JSON.stringify(policy) });

    const result = await provider.readCurrentState(
      'FnUrlPerm',
      'PermissionLogical',
      'AWS::Lambda::Permission',
      { FunctionName: 'my-function' }
    );

    expect(result).toMatchObject({
      Principal: '*',
      InvokedViaFunctionUrl: true,
    });
  });

  it('omits InvokedViaFunctionUrl when the Bool lambda:InvokedViaFunctionUrl condition is absent', async () => {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'PlainPerm',
          Action: 'lambda:InvokeFunction',
          Principal: { Service: 'sns.amazonaws.com' },
        },
      ],
    };
    mockSend.mockResolvedValueOnce({ Policy: JSON.stringify(policy) });

    const result = await provider.readCurrentState(
      'PlainPerm',
      'PermissionLogical',
      'AWS::Lambda::Permission',
      { FunctionName: 'my-function' }
    );

    expect(result).not.toHaveProperty('InvokedViaFunctionUrl');
  });

  it('omits InvokedViaFunctionUrl when the Bool value is "false" (defensive non-`true` branch)', async () => {
    // AWS empirically only injects the `Bool.lambda:InvokedViaFunctionUrl`
    // Condition when the CFn property is `true`; setting `false` is a
    // no-op on the wire (no Condition emitted). This test guards against
    // a future AWS-side behavior change that DID surface a `"false"`
    // value — the readback omits the key in that case, so a `false`
    // round-trip stays a no-op (and matches CFn's default-omit
    // convention).
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'FalseVal',
          Action: 'lambda:InvokeFunction',
          Principal: '*',
          Condition: {
            Bool: { 'lambda:InvokedViaFunctionUrl': 'false' },
          },
        },
      ],
    };
    mockSend.mockResolvedValueOnce({ Policy: JSON.stringify(policy) });

    const result = await provider.readCurrentState(
      'FalseVal',
      'PermissionLogical',
      'AWS::Lambda::Permission',
      { FunctionName: 'my-function' }
    );

    expect(result).not.toHaveProperty('InvokedViaFunctionUrl');
  });

  it('parses legacy "functionArn|statementId" physicalId format', async () => {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        { Sid: 'LegacyPerm', Action: 'lambda:InvokeFunction', Principal: { Service: 's3.amazonaws.com' } },
      ],
    };
    mockSend.mockResolvedValueOnce({ Policy: JSON.stringify(policy) });

    const result = await provider.readCurrentState(
      'arn:aws:lambda:us-east-1:123:function:my-func|LegacyPerm',
      'PermissionLogical',
      'AWS::Lambda::Permission',
      { FunctionName: 'my-function' }
    );

    expect(result).toMatchObject({
      Principal: 's3.amazonaws.com',
    });
  });
});
