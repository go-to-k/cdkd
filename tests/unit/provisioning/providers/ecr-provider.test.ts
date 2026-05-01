import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-ecr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ecr')>();
  return {
    ...actual,
    ECRClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
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

import { ECRProvider } from '../../../../src/provisioning/providers/ecr-provider.js';
import {
  DescribeRepositoriesCommand,
  ListTagsForResourceCommand,
  RepositoryNotFoundException,
} from '@aws-sdk/client-ecr';

describe('ECRProvider import', () => {
  let provider: ECRProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ECRProvider();
  });

  function makeInput(
    overrides: Partial<{
      knownPhysicalId: string;
      cdkPath: string;
      properties: Record<string, unknown>;
    }> = {}
  ) {
    return {
      logicalId: 'MyRepo',
      resourceType: 'AWS::ECR::Repository',
      cdkPath: 'MyStack/MyRepo/Resource',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    };
  }

  it('explicit override: verifies via DescribeRepositories and returns the physicalId', async () => {
    mockSend.mockResolvedValueOnce({
      repositories: [
        {
          repositoryName: 'my-repo',
          repositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/my-repo',
        },
      ],
    });

    const result = await provider.import(makeInput({ knownPhysicalId: 'my-repo' }));

    expect(result).toEqual({ physicalId: 'my-repo', attributes: {} });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(DescribeRepositoriesCommand);
    expect(mockSend.mock.calls[0][0].input).toEqual({ repositoryNames: ['my-repo'] });
  });

  it('tag-based lookup: DescribeRepositories + ListTagsForResource matches aws:cdk:path', async () => {
    mockSend
      // DescribeRepositories
      .mockResolvedValueOnce({
        repositories: [
          {
            repositoryName: 'other-repo',
            repositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/other-repo',
          },
          {
            repositoryName: 'my-repo',
            repositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/my-repo',
          },
        ],
      })
      // ListTagsForResource(other-repo)
      .mockResolvedValueOnce({
        tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Repo/Resource' }],
      })
      // ListTagsForResource(my-repo)
      .mockResolvedValueOnce({
        tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyRepo/Resource' }],
      });

    const result = await provider.import(makeInput());

    expect(result).toEqual({ physicalId: 'my-repo', attributes: {} });
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(DescribeRepositoriesCommand);
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(mockSend.mock.calls[2][0]).toBeInstanceOf(ListTagsForResourceCommand);
  });

  it('returns null when no repository matches the cdkPath', async () => {
    mockSend
      .mockResolvedValueOnce({
        repositories: [
          {
            repositoryName: 'unrelated',
            repositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/unrelated',
          },
        ],
      })
      .mockResolvedValueOnce({
        tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Repo/Resource' }],
      });

    const result = await provider.import(makeInput());

    expect(result).toBeNull();
  });

  it('DescribeRepositories RepositoryNotFoundException on explicit override returns null', async () => {
    mockSend.mockRejectedValueOnce(
      new RepositoryNotFoundException({ $metadata: {}, message: 'not found' })
    );

    const result = await provider.import(makeInput({ knownPhysicalId: 'missing' }));

    expect(result).toBeNull();
  });
});
