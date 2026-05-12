import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetRolePolicyCommand,
  GetGroupPolicyCommand,
  GetUserPolicyCommand,
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

import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';

describe('IAMPolicyProvider.readCurrentState', () => {
  let provider: IAMPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new IAMPolicyProvider();
  });

  it('returns URL-decoded PolicyDocument when target is a Role (happy path)', async () => {
    const policyDoc = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
    };
    // IAM returns PolicyDocument as URL-encoded JSON.
    mockSend.mockResolvedValueOnce({
      RoleName: 'my-role',
      PolicyName: 'my-policy',
      PolicyDocument: encodeURIComponent(JSON.stringify(policyDoc)),
    });

    const result = await provider.readCurrentState('my-policy', 'PolicyLogical', 'AWS::IAM::Policy', {
      PolicyName: 'my-policy',
      PolicyDocument: policyDoc,
      Roles: ['my-role'],
    });

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetRolePolicyCommand);
    expect(result).toEqual({
      PolicyName: 'my-policy',
      PolicyDocument: policyDoc,
      Roles: ['my-role'],
    });
  });

  it('returns Group target via GetGroupPolicy when no Roles', async () => {
    const policyDoc = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
    };
    mockSend.mockResolvedValueOnce({
      GroupName: 'my-group',
      PolicyName: 'my-policy',
      PolicyDocument: encodeURIComponent(JSON.stringify(policyDoc)),
    });

    const result = await provider.readCurrentState('my-policy', 'PolicyLogical', 'AWS::IAM::Policy', {
      PolicyName: 'my-policy',
      PolicyDocument: policyDoc,
      Groups: ['my-group'],
    });

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetGroupPolicyCommand);
    expect(result).toEqual({
      PolicyName: 'my-policy',
      PolicyDocument: policyDoc,
      Groups: ['my-group'],
    });
  });

  it('returns User target via GetUserPolicy when no Roles/Groups', async () => {
    const policyDoc = { Version: '2012-10-17', Statement: [] };
    mockSend.mockResolvedValueOnce({
      UserName: 'my-user',
      PolicyName: 'my-policy',
      PolicyDocument: encodeURIComponent(JSON.stringify(policyDoc)),
    });

    const result = await provider.readCurrentState('my-policy', 'PolicyLogical', 'AWS::IAM::Policy', {
      PolicyName: 'my-policy',
      PolicyDocument: policyDoc,
      Users: ['my-user'],
    });

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetUserPolicyCommand);
    expect(result).toEqual({
      PolicyName: 'my-policy',
      PolicyDocument: policyDoc,
      Users: ['my-user'],
    });
  });

  it('returns undefined when policy is gone (NoSuchEntityException)', async () => {
    mockSend.mockRejectedValueOnce(
      new NoSuchEntityException({ message: 'no such', $metadata: {} })
    );

    const result = await provider.readCurrentState('my-policy', 'PolicyLogical', 'AWS::IAM::Policy', {
      PolicyName: 'my-policy',
      PolicyDocument: { Version: '2012-10-17', Statement: [] },
      Roles: ['my-role'],
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when properties is missing', async () => {
    const result = await provider.readCurrentState('my-policy', 'PolicyLogical', 'AWS::IAM::Policy');
    expect(result).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns undefined when no targets in properties', async () => {
    const result = await provider.readCurrentState('my-policy', 'PolicyLogical', 'AWS::IAM::Policy', {
      PolicyName: 'my-policy',
      PolicyDocument: { Version: '2012-10-17', Statement: [] },
    });
    expect(result).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('handles legacy "policyName:roleName" physicalId format', async () => {
    const policyDoc = { Version: '2012-10-17', Statement: [] };
    mockSend.mockResolvedValueOnce({
      RoleName: 'old-role',
      PolicyName: 'old-policy',
      PolicyDocument: encodeURIComponent(JSON.stringify(policyDoc)),
    });

    const result = await provider.readCurrentState(
      'old-policy:old-role',
      'PolicyLogical',
      'AWS::IAM::Policy',
      {
        PolicyDocument: policyDoc,
        Roles: ['old-role'],
      }
    );

    // policyName extracted from physicalId
    expect(result).toMatchObject({ PolicyName: 'old-policy' });
  });
});
