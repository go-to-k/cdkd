import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeRepositoriesCommand,
  GetLifecyclePolicyCommand,
  LifecyclePolicyNotFoundException,
  ListTagsForResourceCommand,
  RepositoryNotFoundException,
} from '@aws-sdk/client-ecr';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-ecr', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    ECRClient: vi.fn().mockImplementation(() => ({
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

import { ECRProvider } from '../../../src/provisioning/providers/ecr-provider.js';

describe('ECRProvider.readCurrentState', () => {
  let provider: ECRProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ECRProvider();
  });

  it('returns CFn-shaped repository config + lifecycle policy (happy path)', async () => {
    mockSend
      .mockResolvedValueOnce({
        repositories: [
          {
            repositoryName: 'my-repo',
            repositoryArn: 'arn:aws:ecr:us-east-1:123:repository/my-repo',
            repositoryUri: '123.dkr.ecr.us-east-1.amazonaws.com/my-repo',
            imageTagMutability: 'IMMUTABLE',
            imageScanningConfiguration: { scanOnPush: true },
            encryptionConfiguration: {
              encryptionType: 'KMS',
              kmsKey: 'arn:aws:kms:us-east-1:123:key/abcd',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        lifecyclePolicyText: '{"rules":[]}',
      })
      .mockResolvedValueOnce({ tags: [] });

    const result = await provider.readCurrentState('my-repo', 'RepoLogical', 'AWS::ECR::Repository');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeRepositoriesCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(GetLifecyclePolicyCommand);
    expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(result).toEqual({
      RepositoryName: 'my-repo',
      ImageTagMutability: 'IMMUTABLE',
      ImageScanningConfiguration: { ScanOnPush: true },
      EncryptionConfiguration: {
        EncryptionType: 'KMS',
        KmsKey: 'arn:aws:kms:us-east-1:123:key/abcd',
      },
      LifecyclePolicy: { LifecyclePolicyText: '{"rules":[]}' },
      Tags: [],
    });
  });

  it('omits LifecyclePolicy when not configured (LifecyclePolicyNotFoundException)', async () => {
    mockSend
      .mockResolvedValueOnce({
        repositories: [
          {
            repositoryName: 'my-repo',
            imageTagMutability: 'MUTABLE',
            // No repositoryArn -> Tag fetch is skipped silently.
          },
        ],
      })
      .mockRejectedValueOnce(
        new LifecyclePolicyNotFoundException({ message: 'not found', $metadata: {} })
      );

    const result = await provider.readCurrentState('my-repo', 'RepoLogical', 'AWS::ECR::Repository');

    expect(result).toEqual({
      RepositoryName: 'my-repo',
      ImageTagMutability: 'MUTABLE',
    });
  });

  it('returns undefined when repository is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new RepositoryNotFoundException({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState('gone', 'RepoLogical', 'AWS::ECR::Repository');

    expect(result).toBeUndefined();
  });

  it('surfaces Tags from ListTagsForResource with aws:* filtered out', async () => {
    mockSend
      .mockResolvedValueOnce({
        repositories: [
          {
            repositoryName: 'my-repo',
            repositoryArn: 'arn:aws:ecr:us-east-1:123:repository/my-repo',
          },
        ],
      })
      .mockRejectedValueOnce(
        new LifecyclePolicyNotFoundException({ message: 'not found', $metadata: {} })
      )
      .mockResolvedValueOnce({
        tags: [
          { Key: 'Foo', Value: 'Bar' },
          { Key: 'aws:cdk:path', Value: 'MyStack/MyRepo/Resource' },
        ],
      });

    const result = await provider.readCurrentState('my-repo', 'RepoLogical', 'AWS::ECR::Repository');
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when ListTagsForResource returns no user tags', async () => {
    mockSend
      .mockResolvedValueOnce({
        repositories: [
          {
            repositoryName: 'my-repo',
            repositoryArn: 'arn:aws:ecr:us-east-1:123:repository/my-repo',
          },
        ],
      })
      .mockRejectedValueOnce(
        new LifecyclePolicyNotFoundException({ message: 'not found', $metadata: {} })
      )
      .mockResolvedValueOnce({
        tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyRepo/Resource' }],
      });

    const result = await provider.readCurrentState('my-repo', 'RepoLogical', 'AWS::ECR::Repository');
    expect(result?.Tags).toEqual([]);
  });
});
