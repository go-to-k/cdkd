import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeUserPoolCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-cognito-identity-provider', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
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

import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';

describe('CognitoUserPoolProvider.readCurrentState', () => {
  let provider: CognitoUserPoolProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CognitoUserPoolProvider();
  });

  it('returns CFn-shaped UserPool fields from DescribeUserPool (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      UserPool: {
        Id: 'us-east-1_abcd',
        Name: 'my-pool',
        AutoVerifiedAttributes: ['email'],
        UsernameAttributes: ['email'],
        Policies: { PasswordPolicy: { MinimumLength: 8 } },
        MfaConfiguration: 'OFF',
        DeletionProtection: 'ACTIVE',
        // AWS-managed fields, must NOT surface:
        Arn: 'arn:aws:cognito-idp:us-east-1:123:userpool/us-east-1_abcd',
        CreationDate: new Date(),
        EstimatedNumberOfUsers: 0,
      },
    });

    const result = await provider.readCurrentState(
      'us-east-1_abcd',
      'PoolLogical',
      'AWS::Cognito::UserPool'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeUserPoolCommand);
    expect(result).toEqual({
      UserPoolName: 'my-pool',
      AutoVerifiedAttributes: ['email'],
      UsernameAttributes: ['email'],
      Policies: { PasswordPolicy: { MinimumLength: 8 } },
      MfaConfiguration: 'OFF',
      DeletionProtection: 'ACTIVE',
    });
  });

  it('returns undefined when pool is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      'us-east-1_gone',
      'PoolLogical',
      'AWS::Cognito::UserPool'
    );

    expect(result).toBeUndefined();
  });

  it('returns undefined for unsupported resource types', async () => {
    const result = await provider.readCurrentState(
      'client-id',
      'ClientLogical',
      'AWS::Cognito::UserPoolClient'
    );

    expect(result).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
