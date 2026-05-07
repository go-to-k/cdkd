import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeSecretCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    secretsManager: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { SecretsManagerSecretProvider } from '../../../src/provisioning/providers/secretsmanager-secret-provider.js';

describe('SecretsManagerSecretProvider.readCurrentState', () => {
  let provider: SecretsManagerSecretProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SecretsManagerSecretProvider();
  });

  it('returns CFn-shaped fields from DescribeSecret (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      ARN: 'arn:aws:secretsmanager:us-east-1:123:secret:my-secret-AbCdEf',
      Name: 'my-secret',
      Description: 'a secret',
      KmsKeyId: 'arn:aws:kms:us-east-1:123:key/abcd',
      ReplicationStatus: [
        { Region: 'us-west-2', KmsKeyId: 'alias/aws/secretsmanager', Status: 'InSync' },
      ],
    });

    const result = await provider.readCurrentState(
      'arn:aws:secretsmanager:us-east-1:123:secret:my-secret-AbCdEf',
      'SecretLogical',
      'AWS::SecretsManager::Secret'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeSecretCommand);
    expect(result).toEqual({
      Name: 'my-secret',
      Description: 'a secret',
      KmsKeyId: 'arn:aws:kms:us-east-1:123:key/abcd',
      ReplicaRegions: [{ Region: 'us-west-2', KmsKeyId: 'alias/aws/secretsmanager' }],
      Tags: [],
    });
  });

  it('returns undefined when secret is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      'arn:aws:secretsmanager:us-east-1:123:secret:gone',
      'SecretLogical',
      'AWS::SecretsManager::Secret'
    );

    expect(result).toBeUndefined();
  });

  it('surfaces Tags from DescribeSecret with aws:* filtered out', async () => {
    mockSend.mockResolvedValueOnce({
      Name: 'my-secret',
      Tags: [
        { Key: 'Foo', Value: 'Bar' },
        { Key: 'aws:cdk:path', Value: 'MyStack/MySecret/Resource' },
      ],
    });

    const result = await provider.readCurrentState(
      'arn:aws:secretsmanager:us-east-1:123:secret:my-secret-AbCdEf',
      'SecretLogical',
      'AWS::SecretsManager::Secret'
    );

    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('declares SecretString and GenerateSecretString as drift-unknown so the comparator skips them', () => {
    // DescribeSecret never returns the secret value (lives behind
    // GetSecretValue, which we deliberately never call). Without this
    // declaration the comparator would fire false-positive drift on
    // every secret that has SecretString in cdkd state.
    expect(provider.getDriftUnknownPaths()).toEqual(['SecretString', 'GenerateSecretString']);
  });

  it('omits Tags when DescribeSecret returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({
      Name: 'my-secret',
      Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MySecret/Resource' }],
    });

    const result = await provider.readCurrentState(
      'arn:aws:secretsmanager:us-east-1:123:secret:my-secret-AbCdEf',
      'SecretLogical',
      'AWS::SecretsManager::Secret'
    );

    expect(result?.Tags).toEqual([]);
  });
});
