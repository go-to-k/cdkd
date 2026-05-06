import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetRoleCommand,
  ListAttachedRolePoliciesCommand,
  ListRoleTagsCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';

describe('IAMRoleProvider.readCurrentState', () => {
  let provider: IAMRoleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new IAMRoleProvider();
  });

  it('returns CFn-shaped properties (URL-decoded AssumeRolePolicyDocument + ManagedPolicyArns)', async () => {
    const assumeDoc = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
      ],
    };

    // GetRole — note AssumeRolePolicyDocument is URL-encoded JSON like AWS returns.
    mockSend.mockResolvedValueOnce({
      Role: {
        RoleName: 'my-role',
        Description: 'a role',
        MaxSessionDuration: 3600,
        Path: '/',
        PermissionsBoundary: { PermissionsBoundaryArn: 'arn:aws:iam::aws:policy/AdminBoundary' },
        AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(assumeDoc)),
        // AWS-managed fields the comparator should ignore (still safe to surface
        // since they don't appear in state, but our impl filters them anyway):
        Arn: 'arn:aws:iam::123:role/my-role',
        RoleId: 'AROA...',
        CreateDate: new Date(0),
      },
    });
    // ListAttachedRolePolicies
    mockSend.mockResolvedValueOnce({
      AttachedPolicies: [
        { PolicyArn: 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess', PolicyName: 's3' },
        { PolicyArn: 'arn:aws:iam::aws:policy/AWSLambdaBasicExecutionRole', PolicyName: 'lambda' },
      ],
    });
    // ListRoleTags — no user tags
    mockSend.mockResolvedValueOnce({ Tags: [], IsTruncated: false });

    const result = await provider.readCurrentState('my-role', 'Logical', 'AWS::IAM::Role');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetRoleCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListAttachedRolePoliciesCommand);
    expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(ListRoleTagsCommand);
    expect(result).toEqual({
      RoleName: 'my-role',
      Description: 'a role',
      MaxSessionDuration: 3600,
      Path: '/',
      PermissionsBoundary: 'arn:aws:iam::aws:policy/AdminBoundary',
      AssumeRolePolicyDocument: assumeDoc,
      ManagedPolicyArns: [
        'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess',
        'arn:aws:iam::aws:policy/AWSLambdaBasicExecutionRole',
      ],
    });
  });

  it('returns undefined when role does not exist', async () => {
    mockSend.mockRejectedValueOnce(
      new NoSuchEntityException({ message: 'gone', $metadata: {} })
    );

    const result = await provider.readCurrentState('my-role', 'Logical', 'AWS::IAM::Role');
    expect(result).toBeUndefined();
  });

  it('declares Policies as drift-unknown so the comparator skips inline policy bodies', () => {
    // Inline policy bodies are intentionally omitted from
    // readCurrentState (would need one extra GetRolePolicy per
    // policy). Without this declaration any role with inline Policies
    // in cdkd state would fire guaranteed false-positive drift.
    expect(provider.getDriftUnknownPaths()).toEqual(['Policies']);
  });

  it('omits ManagedPolicyArns when there are none attached', async () => {
    mockSend.mockResolvedValueOnce({
      Role: {
        RoleName: 'role',
        Path: '/',
        AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ V: 1 })),
      },
    });
    mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
    mockSend.mockResolvedValueOnce({ Tags: [], IsTruncated: false });

    const result = await provider.readCurrentState('role', 'Logical', 'AWS::IAM::Role');
    expect(result).not.toHaveProperty('ManagedPolicyArns');
  });

  it('surfaces Tags from ListRoleTags with aws:* filtered out', async () => {
    mockSend.mockResolvedValueOnce({
      Role: {
        RoleName: 'role',
        Path: '/',
        AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ V: 1 })),
      },
    });
    mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
    mockSend.mockResolvedValueOnce({
      Tags: [
        { Key: 'Foo', Value: 'Bar' },
        { Key: 'aws:cdk:path', Value: 'MyStack/MyRole/Resource' },
      ],
      IsTruncated: false,
    });

    const result = await provider.readCurrentState('role', 'Logical', 'AWS::IAM::Role');
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when ListRoleTags returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({
      Role: {
        RoleName: 'role',
        Path: '/',
        AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ V: 1 })),
      },
    });
    mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
    mockSend.mockResolvedValueOnce({
      Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyRole/Resource' }],
      IsTruncated: false,
    });

    const result = await provider.readCurrentState('role', 'Logical', 'AWS::IAM::Role');
    expect(result).not.toHaveProperty('Tags');
  });
});
