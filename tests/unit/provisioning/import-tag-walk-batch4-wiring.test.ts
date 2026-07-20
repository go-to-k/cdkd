import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue #1091 batch 4: wiring tests for the seven providers migrated onto the
 * shared `importTagWalk` helper.
 *
 * The helper's own semantics (pagination, backoff schedule, walk limits) are
 * covered by `import-tag-walk.test.ts`. What these tests pin down is the part
 * that is per-provider and easy to get wrong in a migration:
 *
 *  - the `tagsOf` adapter, since the seven providers span FOUR different tag
 *    wire shapes (`{Key,Value}` list, `Record<string,string>` map, the v2
 *    `{TagKey,TagValue}` list, and — for SecretsManager only — tags carried
 *    inline on the list summary). Getting one wrong does not error: the walk
 *    simply never matches and `cdkd import` reports the resource as not-found,
 *    which is why each adapter is pinned here;
 *  - that a THROTTLED per-candidate read is retried and the walk still finds
 *    the match, which is the whole point of the migration;
 *  - that pagination is threaded through (`nextMarker` wired to the right
 *    per-service token field, which differs on every one of them).
 */

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-kms', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-kms')>('@aws-sdk/client-kms');
    class C {
      config = { region: () => Promise.resolve('us-east-1') };
      send = mockSend;
    }
    return { ...actual, KMSClient: C };
});
vi.mock('@aws-sdk/client-s3vectors', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-s3vectors')>('@aws-sdk/client-s3vectors');
    class C {
      config = { region: () => Promise.resolve('us-east-1') };
      send = mockSend;
    }
    return { ...actual, S3VectorsClient: C };
});
vi.mock('@aws-sdk/client-dlm', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-dlm')>('@aws-sdk/client-dlm');
    class C {
      config = { region: () => Promise.resolve('us-east-1') };
      send = mockSend;
    }
    return { ...actual, DLMClient: C };
});
vi.mock('@aws-sdk/client-codecommit', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-codecommit')>('@aws-sdk/client-codecommit');
    class C {
      config = { region: () => Promise.resolve('us-east-1') };
      send = mockSend;
    }
    return { ...actual, CodeCommitClient: C };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { importTagWalkTestHooks } from '../../../src/provisioning/import-tag-walk.js';
import { LambdaLayerVersionProvider } from '../../../src/provisioning/providers/lambda-layer-provider.js';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { SecretsManagerSecretProvider } from '../../../src/provisioning/providers/secretsmanager-secret-provider.js';
import { DLMLifecyclePolicyProvider } from '../../../src/provisioning/providers/dlm-lifecycle-policy-provider.js';
import { KMSProvider } from '../../../src/provisioning/providers/kms-provider.js';
import { S3VectorsProvider } from '../../../src/provisioning/providers/s3-vectors-provider.js';
import { CodeCommitRepositoryProvider } from '../../../src/provisioning/providers/codecommit-repository-provider.js';

const CDK_PATH = 'MyStack/MyResource/Resource';

/** A throttling error shaped the way the shared classifier recognizes it. */
function throttled(): Error {
  const err = new Error('Rate exceeded') as Error & { name: string };
  err.name = 'ThrottlingException';
  return err;
}

beforeEach(() => {
  mockSend.mockReset();
  // Skip the walk's real backoff waits so the retry tests stay fast.
  importTagWalkTestHooks.sleep = async () => {};
});
afterEach(() => {
  importTagWalkTestHooks.sleep = undefined;
});

const input = (overrides: Record<string, unknown> = {}) =>
  ({
    logicalId: 'MyResource',
    resourceType: 'AWS::Test::Type',
    cdkPath: CDK_PATH,
    properties: {},
    region: 'us-east-1',
    ...overrides,
  }) as never;

describe('lambda-layer: map-shaped tags via ListTags', () => {
  const provider = () => new LambdaLayerVersionProvider();

  it('matches on the cdk path and returns the version ARN', async () => {
    mockSend
      .mockResolvedValueOnce({
        Layers: [
          {
            LayerArn: 'arn:aws:lambda:us-east-1:1:layer:L',
            LatestMatchingVersion: { LayerVersionArn: 'arn:aws:lambda:us-east-1:1:layer:L:3' },
          },
        ],
      })
      .mockResolvedValueOnce({ Tags: { 'aws:cdk:path': CDK_PATH } });

    const result = await provider().import!(input());
    expect(result).toEqual({ physicalId: 'arn:aws:lambda:us-east-1:1:layer:L:3', attributes: {} });
  });

  it('retries a throttled tag read and still finds the match', async () => {
    mockSend
      .mockResolvedValueOnce({
        Layers: [
          {
            LayerArn: 'arn:aws:lambda:us-east-1:1:layer:L',
            LatestMatchingVersion: { LayerVersionArn: 'arn:aws:lambda:us-east-1:1:layer:L:3' },
          },
        ],
      })
      .mockRejectedValueOnce(throttled())
      .mockResolvedValueOnce({ Tags: { 'aws:cdk:path': CDK_PATH } });

    const result = await provider().import!(input());
    expect(result?.physicalId).toBe('arn:aws:lambda:us-east-1:1:layer:L:3');
  });

  it('follows NextMarker pagination', async () => {
    mockSend
      .mockResolvedValueOnce({ Layers: [], NextMarker: 'page2' })
      .mockResolvedValueOnce({
        Layers: [
          {
            LayerArn: 'arn:aws:lambda:us-east-1:1:layer:L',
            LatestMatchingVersion: { LayerVersionArn: 'arn:aws:lambda:us-east-1:1:layer:L:9' },
          },
        ],
      })
      .mockResolvedValueOnce({ Tags: { 'aws:cdk:path': CDK_PATH } });

    const result = await provider().import!(input());
    expect(result?.physicalId).toBe('arn:aws:lambda:us-east-1:1:layer:L:9');
  });

  it('returns null when no candidate carries the path', async () => {
    mockSend
      .mockResolvedValueOnce({
        Layers: [
          {
            LayerArn: 'arn:aws:lambda:us-east-1:1:layer:L',
            LatestMatchingVersion: { LayerVersionArn: 'arn:aws:lambda:us-east-1:1:layer:L:3' },
          },
        ],
      })
      .mockResolvedValueOnce({ Tags: { 'aws:cdk:path': 'Other/Path' } });

    expect(await provider().import!(input())).toBeNull();
  });
});

describe('iam-instance-profile: tags come from a per-candidate GetInstanceProfile', () => {
  // ListInstanceProfiles does NOT return tags (AWS documents this on the
  // command itself) even though the InstanceProfile TYPE carries `Tags?`.
  // Reading them off the list summary typechecks and always sees `undefined`,
  // so the walk would never match and import would report "not found". These
  // cases pin the per-candidate read that avoids that.
  it('reads tags via GetInstanceProfile and matches', async () => {
    mockSend
      .mockResolvedValueOnce({ InstanceProfiles: [{ InstanceProfileName: 'prof-1' }] })
      .mockResolvedValueOnce({
        InstanceProfile: {
          InstanceProfileName: 'prof-1',
          Tags: [{ Key: 'aws:cdk:path', Value: CDK_PATH }],
        },
      });

    const result = await new IAMInstanceProfileProvider().import!(input());
    expect(result).toEqual({ physicalId: 'prof-1', attributes: {} });
    // List + one GetInstanceProfile: the per-candidate read must happen.
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1]![0].constructor.name).toBe('GetInstanceProfileCommand');
  });

  it('does NOT match on tags that only appear on the list summary', async () => {
    // Regression guard: a summary-only adapter would match here. The real API
    // never populates this field, so matching it is the bug.
    mockSend
      .mockResolvedValueOnce({
        InstanceProfiles: [
          { InstanceProfileName: 'prof-1', Tags: [{ Key: 'aws:cdk:path', Value: CDK_PATH }] },
        ],
      })
      .mockResolvedValueOnce({ InstanceProfile: { InstanceProfileName: 'prof-1' } });

    expect(await new IAMInstanceProfileProvider().import!(input())).toBeNull();
  });

  it('retries a throttled GetInstanceProfile and still finds the match', async () => {
    mockSend
      .mockResolvedValueOnce({ InstanceProfiles: [{ InstanceProfileName: 'prof-1' }] })
      .mockRejectedValueOnce(throttled())
      .mockResolvedValueOnce({
        InstanceProfile: {
          InstanceProfileName: 'prof-1',
          Tags: [{ Key: 'aws:cdk:path', Value: CDK_PATH }],
        },
      });

    const result = await new IAMInstanceProfileProvider().import!(input());
    expect(result?.physicalId).toBe('prof-1');
  });

  it('follows IsTruncated/Marker pagination', async () => {
    mockSend
      .mockResolvedValueOnce({ InstanceProfiles: [], IsTruncated: true, Marker: 'p2' })
      .mockResolvedValueOnce({ InstanceProfiles: [{ InstanceProfileName: 'prof-2' }] })
      .mockResolvedValueOnce({
        InstanceProfile: {
          InstanceProfileName: 'prof-2',
          Tags: [{ Key: 'aws:cdk:path', Value: CDK_PATH }],
        },
      });

    const result = await new IAMInstanceProfileProvider().import!(input());
    expect(result?.physicalId).toBe('prof-2');
  });

  it('stops when IsTruncated is false even if a Marker is echoed back', async () => {
    mockSend
      .mockResolvedValueOnce({
        InstanceProfiles: [{ InstanceProfileName: 'other' }],
        IsTruncated: false,
        Marker: 'ignored',
      })
      .mockResolvedValueOnce({ InstanceProfile: { InstanceProfileName: 'other' } });

    expect(await new IAMInstanceProfileProvider().import!(input())).toBeNull();
    // List + describe for the one candidate, then the walk ends — no page 2.
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe('secretsmanager: tags inline on the list summary', () => {
  it('matches and returns the ARN', async () => {
    mockSend.mockResolvedValueOnce({
      SecretList: [{ ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:S' }].map((s) => ({
        ...s,
        Tags: [{ Key: 'aws:cdk:path', Value: CDK_PATH }],
      })),
    });

    const result = await new SecretsManagerSecretProvider().import!(input());
    expect(result?.physicalId).toBe('arn:aws:secretsmanager:us-east-1:1:secret:S');
  });

  it('retries a throttled list page', async () => {
    mockSend.mockRejectedValueOnce(throttled()).mockResolvedValueOnce({
      SecretList: [
        {
          ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:S',
          Tags: [{ Key: 'aws:cdk:path', Value: CDK_PATH }],
        },
      ],
    });

    const result = await new SecretsManagerSecretProvider().import!(input());
    expect(result?.physicalId).toBe('arn:aws:secretsmanager:us-east-1:1:secret:S');
  });

  it('follows NextToken pagination', async () => {
    mockSend
      .mockResolvedValueOnce({ SecretList: [], NextToken: 'p2' })
      .mockResolvedValueOnce({
        SecretList: [
          {
            ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:S2',
            Tags: [{ Key: 'aws:cdk:path', Value: CDK_PATH }],
          },
        ],
      });

    const result = await new SecretsManagerSecretProvider().import!(input());
    expect(result?.physicalId).toBe('arn:aws:secretsmanager:us-east-1:1:secret:S2');
  });

  it('returns null when no secret carries the path', async () => {
    mockSend.mockResolvedValueOnce({
      SecretList: [
        {
          ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:S',
          Tags: [{ Key: 'aws:cdk:path', Value: 'Other/Path' }],
        },
      ],
    });

    expect(await new SecretsManagerSecretProvider().import!(input())).toBeNull();
  });
});

describe('dlm: map-shaped tags, unpaginated list', () => {
  it('matches on the cdk path', async () => {
    mockSend.mockResolvedValueOnce({
      Policies: [{ PolicyId: 'policy-abc', Tags: { 'aws:cdk:path': CDK_PATH } }],
    });

    const result = await new DLMLifecyclePolicyProvider().import!(input());
    expect(result).toEqual({ physicalId: 'policy-abc', attributes: {} });
  });

  it('retries a throttled list call', async () => {
    mockSend.mockRejectedValueOnce(throttled()).mockResolvedValueOnce({
      Policies: [{ PolicyId: 'policy-abc', Tags: { 'aws:cdk:path': CDK_PATH } }],
    });

    const result = await new DLMLifecyclePolicyProvider().import!(input());
    expect(result?.physicalId).toBe('policy-abc');
  });

  it('returns null when no policy carries the path', async () => {
    mockSend.mockResolvedValueOnce({
      Policies: [{ PolicyId: 'policy-abc', Tags: { 'aws:cdk:path': 'Other/Path' } }],
    });

    expect(await new DLMLifecyclePolicyProvider().import!(input())).toBeNull();
  });
});

describe('kms: v2-style {TagKey,TagValue} tags', () => {
  const kmsInput = () => input({ resourceType: 'AWS::KMS::Key' });

  it('adapts the v2 tag shape and matches', async () => {
    mockSend
      .mockResolvedValueOnce({ Keys: [{ KeyId: 'key-1' }] })
      .mockResolvedValueOnce({ Tags: [{ TagKey: 'aws:cdk:path', TagValue: CDK_PATH }] });

    const result = await new KMSProvider().import!(kmsInput());
    expect(result).toEqual({ physicalId: 'key-1', attributes: {} });
  });

  it('skips an AWS-managed key whose tag read is AccessDenied, then matches the next', async () => {
    const denied = new Error('denied') as Error & { name: string };
    denied.name = 'AccessDeniedException';
    mockSend
      .mockResolvedValueOnce({ Keys: [{ KeyId: 'aws-managed' }, { KeyId: 'key-2' }] })
      .mockRejectedValueOnce(denied)
      .mockResolvedValueOnce({ Tags: [{ TagKey: 'aws:cdk:path', TagValue: CDK_PATH }] });

    const result = await new KMSProvider().import!(kmsInput());
    expect(result?.physicalId).toBe('key-2');
  });

  it('retries a throttled tag read', async () => {
    mockSend
      .mockResolvedValueOnce({ Keys: [{ KeyId: 'key-1' }] })
      .mockRejectedValueOnce(throttled())
      .mockResolvedValueOnce({ Tags: [{ TagKey: 'aws:cdk:path', TagValue: CDK_PATH }] });

    const result = await new KMSProvider().import!(kmsInput());
    expect(result?.physicalId).toBe('key-1');
  });

  it('follows NextMarker pagination', async () => {
    mockSend
      .mockResolvedValueOnce({ Keys: [], NextMarker: 'p2' })
      .mockResolvedValueOnce({ Keys: [{ KeyId: 'key-3' }] })
      .mockResolvedValueOnce({ Tags: [{ TagKey: 'aws:cdk:path', TagValue: CDK_PATH }] });

    const result = await new KMSProvider().import!(kmsInput());
    expect(result?.physicalId).toBe('key-3');
  });

  it('returns null when no key carries the path', async () => {
    mockSend
      .mockResolvedValueOnce({ Keys: [{ KeyId: 'key-1' }] })
      .mockResolvedValueOnce({ Tags: [{ TagKey: 'aws:cdk:path', TagValue: 'Other/Path' }] });

    expect(await new KMSProvider().import!(kmsInput())).toBeNull();
  });
});

describe('s3-vectors: map-shaped tags', () => {
  it('matches and returns the bucket name', async () => {
    mockSend
      .mockResolvedValueOnce({
        vectorBuckets: [
          { vectorBucketName: 'vb-1', vectorBucketArn: 'arn:aws:s3vectors:::bucket/vb-1' },
        ],
      })
      .mockResolvedValueOnce({ tags: { 'aws:cdk:path': CDK_PATH } });

    const result = await new S3VectorsProvider().import!(
      input({ resourceType: 'AWS::S3Vectors::VectorBucket' })
    );
    expect(result).toEqual({ physicalId: 'vb-1', attributes: {} });
  });

  it('follows nextToken pagination and retries a throttled tag read', async () => {
    mockSend
      .mockResolvedValueOnce({ vectorBuckets: [], nextToken: 'p2' })
      .mockResolvedValueOnce({
        vectorBuckets: [
          { vectorBucketName: 'vb-2', vectorBucketArn: 'arn:aws:s3vectors:::bucket/vb-2' },
        ],
      })
      .mockRejectedValueOnce(throttled())
      .mockResolvedValueOnce({ tags: { 'aws:cdk:path': CDK_PATH } });

    const result = await new S3VectorsProvider().import!(
      input({ resourceType: 'AWS::S3Vectors::VectorBucket' })
    );
    expect(result?.physicalId).toBe('vb-2');
  });
});

describe('codecommit: two reads per candidate, attributes from the metadata read', () => {
  it('matches and carries the metadata through to attributes', async () => {
    mockSend
      .mockResolvedValueOnce({ repositories: [{ repositoryName: 'repo-1' }] })
      .mockResolvedValueOnce({
        repositoryMetadata: {
          Arn: 'arn:aws:codecommit:us-east-1:1:repo-1',
          repositoryName: 'repo-1',
          repositoryId: 'id-1',
        },
      })
      .mockResolvedValueOnce({ tags: { 'aws:cdk:path': CDK_PATH } });

    const result = await new CodeCommitRepositoryProvider().import!(
      input({ resourceType: 'AWS::CodeCommit::Repository' })
    );
    expect(result?.physicalId).toBe('repo-1');
    // `toAttributes` fills every key with a `?? ''` fallback, so a
    // `toBeDefined()` check would pass even if `match.detail` were dropped.
    // Assert the actual metadata values came through.
    expect(result?.attributes).toMatchObject({
      Arn: 'arn:aws:codecommit:us-east-1:1:repo-1',
      Name: 'repo-1',
    });
  });

  it('follows nextToken pagination', async () => {
    mockSend
      .mockResolvedValueOnce({ repositories: [], nextToken: 'p2' })
      .mockResolvedValueOnce({ repositories: [{ repositoryName: 'repo-2' }] })
      .mockResolvedValueOnce({
        repositoryMetadata: {
          Arn: 'arn:aws:codecommit:us-east-1:1:repo-2',
          repositoryName: 'repo-2',
        },
      })
      .mockResolvedValueOnce({ tags: { 'aws:cdk:path': CDK_PATH } });

    const result = await new CodeCommitRepositoryProvider().import!(
      input({ resourceType: 'AWS::CodeCommit::Repository' })
    );
    expect(result?.physicalId).toBe('repo-2');
  });

  it('returns null when no repository carries the path', async () => {
    mockSend
      .mockResolvedValueOnce({ repositories: [{ repositoryName: 'repo-1' }] })
      .mockResolvedValueOnce({
        repositoryMetadata: { Arn: 'arn:aws:codecommit:us-east-1:1:repo-1' },
      })
      .mockResolvedValueOnce({ tags: { 'aws:cdk:path': 'Other/Path' } });

    expect(
      await new CodeCommitRepositoryProvider().import!(
        input({ resourceType: 'AWS::CodeCommit::Repository' })
      )
    ).toBeNull();
  });

  it('retries a throttled metadata read mid-walk', async () => {
    mockSend
      .mockResolvedValueOnce({ repositories: [{ repositoryName: 'repo-1' }] })
      .mockRejectedValueOnce(throttled())
      .mockResolvedValueOnce({
        repositoryMetadata: {
          Arn: 'arn:aws:codecommit:us-east-1:1:repo-1',
          repositoryName: 'repo-1',
        },
      })
      .mockResolvedValueOnce({ tags: { 'aws:cdk:path': CDK_PATH } });

    const result = await new CodeCommitRepositoryProvider().import!(
      input({ resourceType: 'AWS::CodeCommit::Repository' })
    );
    expect(result?.physicalId).toBe('repo-1');
  });
});
