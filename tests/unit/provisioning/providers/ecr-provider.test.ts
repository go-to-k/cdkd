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
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  LifecyclePolicyNotFoundException,
  PutImageTagMutabilityCommand,
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
      properties: Record<string, unknown>;
    }> = {}
  ) {
    return {
      logicalId: 'MyRepo',
      resourceType: 'AWS::ECR::Repository',
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

// Issue #1392: `ImageTagMutabilityExclusionFilters` was declared in
// `handledProperties` but never sent on any API call, so an
// `IMMUTABLE_WITH_EXCLUSION` repository silently lost its exclusions while the
// property-coverage pre-flight passed. The CFn member names
// (`ImageTagMutabilityExclusionFilterType` / `...Value`) diverge from the SDK's
// (`filterType` / `filter`), so the mapping has to be explicit.
describe('ECRProvider ImageTagMutabilityExclusionFilters', () => {
  let provider: ECRProvider;
  const repoArn = 'arn:aws:ecr:us-east-1:123456789012:repository/my-repo';

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ECRProvider();
  });

  // CreateRepository answers with `repository` (singular); DescribeRepositories
  // with `repositories`. Both shapes are returned so one default mock serves
  // the create and the update paths.
  function mockRepoResponses() {
    const repo = {
      repositoryName: 'my-repo',
      repositoryArn: repoArn,
      repositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo',
    };
    mockSend.mockResolvedValue({ repository: repo, repositories: [repo] });
  }

  it('create maps the CFn filters to the SDK member names', async () => {
    mockRepoResponses();

    await provider.create('MyRepo', 'AWS::ECR::Repository', {
      RepositoryName: 'my-repo',
      ImageTagMutability: 'IMMUTABLE_WITH_EXCLUSION',
      ImageTagMutabilityExclusionFilters: [
        {
          ImageTagMutabilityExclusionFilterType: 'WILDCARD',
          ImageTagMutabilityExclusionFilterValue: 'dev-*',
        },
      ],
    });

    const createCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof CreateRepositoryCommand
    );
    expect(createCall).toBeDefined();
    expect(createCall![0].input.imageTagMutability).toBe('IMMUTABLE_WITH_EXCLUSION');
    expect(createCall![0].input.imageTagMutabilityExclusionFilters).toEqual([
      { filterType: 'WILDCARD', filter: 'dev-*' },
    ]);
  });

  it('create omits the key entirely when the property is absent', async () => {
    mockRepoResponses();

    await provider.create('MyRepo', 'AWS::ECR::Repository', {
      RepositoryName: 'my-repo',
      ImageTagMutability: 'IMMUTABLE',
    });

    const createCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof CreateRepositoryCommand
    );
    expect(createCall).toBeDefined();
    expect(createCall![0].input).not.toHaveProperty('imageTagMutabilityExclusionFilters');
  });

  it('create omits the key when the property is an empty array', async () => {
    mockRepoResponses();

    await provider.create('MyRepo', 'AWS::ECR::Repository', {
      RepositoryName: 'my-repo',
      ImageTagMutabilityExclusionFilters: [],
    });

    const createCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof CreateRepositoryCommand
    );
    expect(createCall).toBeDefined();
    expect(createCall![0].input).not.toHaveProperty('imageTagMutabilityExclusionFilters');
  });

  it('update sends the mapped filters alongside a changed mutability value', async () => {
    mockRepoResponses();

    await provider.update(
      'MyRepo',
      'my-repo',
      'AWS::ECR::Repository',
      {
        ImageTagMutability: 'IMMUTABLE_WITH_EXCLUSION',
        ImageTagMutabilityExclusionFilters: [
          {
            ImageTagMutabilityExclusionFilterType: 'WILDCARD',
            ImageTagMutabilityExclusionFilterValue: 'dev-*',
          },
        ],
      },
      { ImageTagMutability: 'IMMUTABLE' }
    );

    const putCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutImageTagMutabilityCommand
    );
    expect(putCall).toBeDefined();
    expect(putCall![0].input).toEqual({
      repositoryName: 'my-repo',
      imageTagMutability: 'IMMUTABLE_WITH_EXCLUSION',
      imageTagMutabilityExclusionFilters: [{ filterType: 'WILDCARD', filter: 'dev-*' }],
    });
  });

  // The filters ride the same PutImageTagMutability call as the mutability
  // value, so a filters-only edit must still fire it — and re-send the
  // unchanged (required) mutability value.
  it('update fires on a filters-only change with the mutability value unchanged', async () => {
    mockRepoResponses();

    await provider.update(
      'MyRepo',
      'my-repo',
      'AWS::ECR::Repository',
      {
        ImageTagMutability: 'IMMUTABLE_WITH_EXCLUSION',
        ImageTagMutabilityExclusionFilters: [
          {
            ImageTagMutabilityExclusionFilterType: 'WILDCARD',
            ImageTagMutabilityExclusionFilterValue: 'staging-*',
          },
        ],
      },
      {
        ImageTagMutability: 'IMMUTABLE_WITH_EXCLUSION',
        ImageTagMutabilityExclusionFilters: [
          {
            ImageTagMutabilityExclusionFilterType: 'WILDCARD',
            ImageTagMutabilityExclusionFilterValue: 'dev-*',
          },
        ],
      }
    );

    const putCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutImageTagMutabilityCommand
    );
    expect(putCall).toBeDefined();
    expect(putCall![0].input).toEqual({
      repositoryName: 'my-repo',
      imageTagMutability: 'IMMUTABLE_WITH_EXCLUSION',
      imageTagMutabilityExclusionFilters: [{ filterType: 'WILDCARD', filter: 'staging-*' }],
    });
  });

  // A removal drops the key: PutImageTagMutability is a full-replace setter,
  // so an omitted list clears the repository's exclusions.
  it('update omits the key when the filters are removed from the template', async () => {
    mockRepoResponses();

    await provider.update(
      'MyRepo',
      'my-repo',
      'AWS::ECR::Repository',
      { ImageTagMutability: 'IMMUTABLE' },
      {
        ImageTagMutability: 'IMMUTABLE_WITH_EXCLUSION',
        ImageTagMutabilityExclusionFilters: [
          {
            ImageTagMutabilityExclusionFilterType: 'WILDCARD',
            ImageTagMutabilityExclusionFilterValue: 'dev-*',
          },
        ],
      }
    );

    const putCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutImageTagMutabilityCommand
    );
    expect(putCall).toBeDefined();
    expect(putCall![0].input).not.toHaveProperty('imageTagMutabilityExclusionFilters');
  });

  // The two cases above always co-change ImageTagMutability, so the mutability
  // half of the gate would fire the call on its own. These two isolate the
  // filters half: the mode is identical across both sides, so ONLY the filter
  // diff can trigger PutImageTagMutability.
  it('update fires and omits the key when the filters are removed with the mode unchanged', async () => {
    mockRepoResponses();

    await provider.update(
      'MyRepo',
      'my-repo',
      'AWS::ECR::Repository',
      { ImageTagMutability: 'MUTABLE_WITH_EXCLUSION' },
      {
        ImageTagMutability: 'MUTABLE_WITH_EXCLUSION',
        ImageTagMutabilityExclusionFilters: [
          {
            ImageTagMutabilityExclusionFilterType: 'WILDCARD',
            ImageTagMutabilityExclusionFilterValue: 'dev-*',
          },
        ],
      }
    );

    const putCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutImageTagMutabilityCommand
    );
    expect(putCall).toBeDefined();
    expect(putCall![0].input.imageTagMutability).toBe('MUTABLE_WITH_EXCLUSION');
    expect(putCall![0].input).not.toHaveProperty('imageTagMutabilityExclusionFilters');
  });

  it('update fires when filters are added with the mode unchanged', async () => {
    mockRepoResponses();

    await provider.update(
      'MyRepo',
      'my-repo',
      'AWS::ECR::Repository',
      {
        ImageTagMutability: 'MUTABLE_WITH_EXCLUSION',
        ImageTagMutabilityExclusionFilters: [
          {
            ImageTagMutabilityExclusionFilterType: 'WILDCARD',
            ImageTagMutabilityExclusionFilterValue: 'dev-*',
          },
        ],
      },
      { ImageTagMutability: 'MUTABLE_WITH_EXCLUSION' }
    );

    const putCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutImageTagMutabilityCommand
    );
    expect(putCall).toBeDefined();
    expect(putCall![0].input.imageTagMutabilityExclusionFilters).toEqual([
      { filterType: 'WILDCARD', filter: 'dev-*' },
    ]);
  });

  it('update does NOT fire PutImageTagMutability when neither member changed', async () => {
    mockRepoResponses();

    const unchanged = {
      ImageTagMutability: 'IMMUTABLE_WITH_EXCLUSION',
      ImageTagMutabilityExclusionFilters: [
        {
          ImageTagMutabilityExclusionFilterType: 'WILDCARD',
          ImageTagMutabilityExclusionFilterValue: 'dev-*',
        },
      ],
    };

    // structuredClone, NOT a shallow spread: a spread shares the filters array
    // reference, so a broken reference-equality implementation would pass. In
    // production previousProperties comes from deserialized state JSON and is
    // never identity-equal to the template's array.
    await provider.update(
      'MyRepo',
      'my-repo',
      'AWS::ECR::Repository',
      unchanged,
      structuredClone(unchanged)
    );

    expect(
      mockSend.mock.calls.find((c) => c[0] instanceof PutImageTagMutabilityCommand)
    ).toBeUndefined();
  });

  it('readCurrentState maps the AWS-current filters back to the CFn shape', async () => {
    // DescribeRepositories -> GetLifecyclePolicy -> ListTagsForResource
    mockSend.mockResolvedValueOnce({
      repositories: [
        {
          repositoryName: 'my-repo',
          repositoryArn: repoArn,
          imageTagMutability: 'IMMUTABLE_WITH_EXCLUSION',
          imageTagMutabilityExclusionFilters: [{ filterType: 'WILDCARD', filter: 'dev-*' }],
        },
      ],
    });
    mockSend.mockRejectedValueOnce(
      new LifecyclePolicyNotFoundException({ $metadata: {}, message: 'none' })
    );
    mockSend.mockResolvedValueOnce({ tags: [] });

    const state = await provider.readCurrentState('my-repo', 'MyRepo', 'AWS::ECR::Repository');

    expect(state?.['ImageTagMutabilityExclusionFilters']).toEqual([
      {
        ImageTagMutabilityExclusionFilterType: 'WILDCARD',
        ImageTagMutabilityExclusionFilterValue: 'dev-*',
      },
    ]);
  });

  it('readCurrentState omits the key when the repository has no exclusions', async () => {
    mockSend.mockResolvedValueOnce({
      repositories: [
        {
          repositoryName: 'my-repo',
          repositoryArn: repoArn,
          imageTagMutability: 'IMMUTABLE',
          imageTagMutabilityExclusionFilters: [],
        },
      ],
    });
    mockSend.mockRejectedValueOnce(
      new LifecyclePolicyNotFoundException({ $metadata: {}, message: 'none' })
    );
    mockSend.mockResolvedValueOnce({ tags: [] });

    const state = await provider.readCurrentState('my-repo', 'MyRepo', 'AWS::ECR::Repository');

    expect(state).not.toHaveProperty('ImageTagMutabilityExclusionFilters');
  });

  // The likelier real-world shape: DescribeRepositories OMITS the member for a
  // repository with no exclusions rather than returning an empty array.
  it('readCurrentState omits the key when AWS does not return the member at all', async () => {
    mockSend.mockResolvedValueOnce({
      repositories: [
        {
          repositoryName: 'my-repo',
          repositoryArn: repoArn,
          imageTagMutability: 'IMMUTABLE',
        },
      ],
    });
    mockSend.mockRejectedValueOnce(
      new LifecyclePolicyNotFoundException({ $metadata: {}, message: 'none' })
    );
    mockSend.mockResolvedValueOnce({ tags: [] });

    const state = await provider.readCurrentState('my-repo', 'MyRepo', 'AWS::ECR::Repository');

    expect(state).not.toHaveProperty('ImageTagMutabilityExclusionFilters');
  });
});
