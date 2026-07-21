import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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
  RepositoryNotFoundException,
  TagResourceCommand,
  UntagResourceCommand,
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

  it('DescribeRepositories RepositoryNotFoundException on explicit override returns null', async () => {
    mockSend.mockRejectedValueOnce(
      new RepositoryNotFoundException({ $metadata: {}, message: 'not found' })
    );

    const result = await provider.import(makeInput({ knownPhysicalId: 'missing' }));

    expect(result).toBeNull();
  });

  // The `aws:cdk:path` tag walk was removed (issue #1134): AWS rejects
  // `aws:`-prefixed tag writes, so the tag never exists on a real resource.
  // With no explicit id, import returns null without issuing any AWS call.
  it('returns null without any AWS call when only cdkPath is given', async () => {
    const result = await provider.import(makeInput());

    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('ECRProvider update Tags', () => {
  let provider: ECRProvider;
  const repoArn = 'arn:aws:ecr:us-east-1:123456789012:repository/my-repo';

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ECRProvider();
  });

  // The update() Tags block issues, in order:
  //   1. DescribeRepositories (to resolve the ARN for tag ops)
  //   2. UntagResource (removed keys) — only when there are removed keys
  //   3. TagResource (new set) — only when the new set is non-empty
  //   4. DescribeRepositories (final attribute read)
  function mockDescribeResponses() {
    const describeResponse = {
      repositories: [
        {
          repositoryName: 'my-repo',
          repositoryArn: repoArn,
          repositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo',
        },
      ],
    };
    mockSend.mockResolvedValue(describeResponse);
  }

  it('partial removal: untags removed keys and tags the changed/new ones', async () => {
    mockDescribeResponses();

    await provider.update(
      'MyRepo',
      'my-repo',
      'AWS::ECR::Repository',
      {
        Tags: [
          { Key: 'env', Value: 'prod' }, // changed value
          { Key: 'owner', Value: 'team-a' }, // new key
        ],
      },
      {
        Tags: [
          { Key: 'env', Value: 'dev' }, // changed
          { Key: 'costcenter', Value: 'cc-1' }, // removed
        ],
      }
    );

    const untagCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof UntagResourceCommand
    );
    const tagCall = mockSend.mock.calls.find((c) => c[0] instanceof TagResourceCommand);

    expect(untagCall).toBeDefined();
    expect(untagCall![0].input).toEqual({
      resourceArn: repoArn,
      tagKeys: ['costcenter'],
    });

    expect(tagCall).toBeDefined();
    expect(tagCall![0].input).toEqual({
      resourceArn: repoArn,
      tags: [
        { Key: 'env', Value: 'prod' },
        { Key: 'owner', Value: 'team-a' },
      ],
    });
  });

  it('full removal: untags all old keys and does NOT call TagResource', async () => {
    mockDescribeResponses();

    await provider.update(
      'MyRepo',
      'my-repo',
      'AWS::ECR::Repository',
      {}, // Tags property removed entirely
      {
        Tags: [
          { Key: 'env', Value: 'dev' },
          { Key: 'costcenter', Value: 'cc-1' },
        ],
      }
    );

    const untagCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof UntagResourceCommand
    );
    const tagCall = mockSend.mock.calls.find((c) => c[0] instanceof TagResourceCommand);

    expect(untagCall).toBeDefined();
    expect(untagCall![0].input).toEqual({
      resourceArn: repoArn,
      tagKeys: ['env', 'costcenter'],
    });

    // A pure removal has nothing left to add — TagResource must NOT fire.
    expect(tagCall).toBeUndefined();
  });
});
