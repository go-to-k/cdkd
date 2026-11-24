import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeRepositoriesCommand,
  GetLifecyclePolicyCommand,
  GetRepositoryPolicyCommand,
  LifecyclePolicyNotFoundException,
  ListTagsForResourceCommand,
  RepositoryNotFoundException,
  RepositoryPolicyNotFoundException,
} from '@aws-sdk/client-ecr';

const mockSend = vi.fn();
const warn = vi.fn();

vi.mock('@aws-sdk/client-ecr', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    ECRClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warn(...args),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
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
import { RESOURCE_NOT_FOUND, type ResourceNotFound } from '../../../src/types/resource.js';

const TYPE = 'AWS::ECR::Repository';
const ARN = 'arn:aws:ecr:us-east-1:123456789012:repository/my-repo';
const POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: 'arn:aws:iam::123456789012:root' },
      Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
    },
  ],
};

/** Narrow a `readCurrentState` result to its property bag; fails on `RESOURCE_NOT_FOUND`. */
function bagOf(
  r: Record<string, unknown> | ResourceNotFound | undefined
): Record<string, unknown> | undefined {
  expect(r).not.toBe(RESOURCE_NOT_FOUND);
  return r as Record<string, unknown> | undefined;
}

type Answer = unknown | Error | (() => unknown);

/**
 * Answer each command by its class, so the concurrent sub-reads need no call
 * order. An `Error` answer rejects; a function is called per send.
 */
function route(answers: {
  describe?: Answer;
  lifecycle?: Answer;
  policy?: Answer;
  tags?: Answer;
}): void {
  mockSend.mockImplementation((command: unknown) => {
    const pick =
      command instanceof DescribeRepositoriesCommand
        ? answers.describe
        : command instanceof GetLifecyclePolicyCommand
          ? answers.lifecycle
          : command instanceof GetRepositoryPolicyCommand
            ? answers.policy
            : command instanceof ListTagsForResourceCommand
              ? answers.tags
              : new Error('unexpected command');
    const answer = typeof pick === 'function' ? (pick as () => unknown)() : pick;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
}

const repoWithArn = { repositories: [{ repositoryName: 'my-repo', repositoryArn: ARN }] };
const noLifecycle = new LifecyclePolicyNotFoundException({ message: 'not found', $metadata: {} });
const noPolicy = (): Error =>
  new RepositoryPolicyNotFoundException({ message: 'no policy', $metadata: {} });
const repoGone = (): Error =>
  new RepositoryNotFoundException({ message: 'not found', $metadata: {} });
const accessDenied = (): Error =>
  Object.assign(new Error('not authorized to perform: ecr:GetRepositoryPolicy'), {
    name: 'AccessDeniedException',
  });
const throttled = (): Error =>
  Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });

const DECLARED = { RepositoryPolicyText: POLICY };

function policyCalls(): number {
  return mockSend.mock.calls.filter((c) => c[0] instanceof GetRepositoryPolicyCommand).length;
}

describe('ECRProvider.readCurrentState', () => {
  let provider: ECRProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new ECRProvider();
    provider.ownWriteRereadDelaysMs = [0, 0, 0];
  });

  it('returns CFn-shaped repository config + lifecycle policy (happy path)', async () => {
    route({
      describe: {
        repositories: [
          {
            repositoryName: 'my-repo',
            repositoryArn: ARN,
            repositoryUri: '123.dkr.ecr.us-east-1.amazonaws.com/my-repo',
            imageTagMutability: 'IMMUTABLE',
            imageScanningConfiguration: { scanOnPush: true },
            encryptionConfiguration: {
              encryptionType: 'KMS',
              kmsKey: 'arn:aws:kms:us-east-1:123:key/abcd',
            },
          },
        ],
      },
      lifecycle: { lifecyclePolicyText: '{"rules":[]}' },
      policy: noPolicy(),
      tags: { tags: [] },
    });

    const result = await provider.readCurrentState('my-repo', 'RepoLogical', TYPE);

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeRepositoriesCommand);
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

  it('omits LifecyclePolicy when not configured (LifecyclePolicyNotFoundException) and emits ImageScanning/Encryption placeholders', async () => {
    route({
      // No repositoryArn -> Tag fetch is skipped silently.
      describe: { repositories: [{ repositoryName: 'my-repo', imageTagMutability: 'MUTABLE' }] },
      lifecycle: noLifecycle,
      policy: noPolicy(),
    });

    const result = await provider.readCurrentState('my-repo', 'RepoLogical', TYPE);

    expect(mockSend.mock.calls.some((c) => c[0] instanceof ListTagsForResourceCommand)).toBe(
      false
    );
    expect(result).toEqual({
      RepositoryName: 'my-repo',
      ImageTagMutability: 'MUTABLE',
      ImageScanningConfiguration: { ScanOnPush: false },
      EncryptionConfiguration: { EncryptionType: 'AES256' },
    });
  });

  it('returns RESOURCE_NOT_FOUND when repository is gone', async () => {
    route({ describe: repoGone() });
    expect(await provider.readCurrentState('gone', 'RepoLogical', TYPE)).toBe(RESOURCE_NOT_FOUND);
  });

  it('returns RESOURCE_NOT_FOUND when DescribeRepositories returns an empty list', async () => {
    route({ describe: { repositories: [] } });
    expect(await provider.readCurrentState('gone', 'RepoLogical', TYPE)).toBe(RESOURCE_NOT_FOUND);
  });

  it('returns RESOURCE_NOT_FOUND when the repository vanishes before GetLifecyclePolicy', async () => {
    route({ describe: repoWithArn, lifecycle: repoGone(), policy: noPolicy(), tags: { tags: [] } });
    expect(await provider.readCurrentState('my-repo', 'RepoLogical', TYPE)).toBe(
      RESOURCE_NOT_FOUND
    );
  });

  it('returns RESOURCE_NOT_FOUND when the repository vanishes before ListTagsForResource', async () => {
    route({ describe: repoWithArn, lifecycle: noLifecycle, policy: noPolicy(), tags: repoGone() });
    expect(await provider.readCurrentState('my-repo', 'RepoLogical', TYPE)).toBe(
      RESOURCE_NOT_FOUND
    );
  });

  it('returns RESOURCE_NOT_FOUND when the repository vanishes before GetRepositoryPolicy, even beside another failure', async () => {
    route({
      describe: repoWithArn,
      lifecycle: accessDenied(),
      policy: repoGone(),
      tags: { tags: [] },
    });
    expect(await provider.readCurrentState('my-repo', 'RepoLogical', TYPE, DECLARED)).toBe(
      RESOURCE_NOT_FOUND
    );
  });

  it('surfaces Tags from ListTagsForResource with aws:* filtered out', async () => {
    route({
      describe: repoWithArn,
      lifecycle: noLifecycle,
      policy: noPolicy(),
      tags: {
        tags: [
          { Key: 'Foo', Value: 'Bar' },
          { Key: 'aws:cdk:path', Value: 'MyStack/MyRepo/Resource' },
        ],
      },
    });
    const result = bagOf(await provider.readCurrentState('my-repo', 'RepoLogical', TYPE));
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when ListTagsForResource returns no user tags', async () => {
    route({
      describe: repoWithArn,
      lifecycle: noLifecycle,
      policy: noPolicy(),
      tags: { tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyRepo/Resource' }] },
    });
    const result = bagOf(await provider.readCurrentState('my-repo', 'RepoLogical', TYPE));
    expect(result?.Tags).toEqual([]);
  });

  it('throws the lifecycle read\'s failure first when two sub-reads fail', async () => {
    route({
      describe: repoWithArn,
      lifecycle: Object.assign(new Error('lifecycle failed'), { name: 'AccessDeniedException' }),
      policy: noPolicy(),
      tags: Object.assign(new Error('tags failed'), { name: 'AccessDeniedException' }),
    });
    await expect(provider.readCurrentState('my-repo', 'RepoLogical', TYPE)).rejects.toThrow(
      'lifecycle failed'
    );
  });

  it('throws the policy read\'s failure ahead of the tags read\'s', async () => {
    route({
      describe: repoWithArn,
      lifecycle: noLifecycle,
      policy: Object.assign(new Error('policy failed'), { name: 'AccessDeniedException' }),
      tags: Object.assign(new Error('tags failed'), { name: 'AccessDeniedException' }),
    });
    await expect(
      provider.readCurrentState('my-repo', 'RepoLogical', TYPE, DECLARED)
    ).rejects.toThrow('policy failed');
  });

  describe('RepositoryPolicyText (go-to-k/cdkd#6631)', () => {
    it('surfaces the policy GetRepositoryPolicy returns, JSON-parsed', async () => {
      route({
        describe: repoWithArn,
        lifecycle: noLifecycle,
        policy: { repositoryName: 'my-repo', policyText: JSON.stringify(POLICY, null, 2) },
        tags: { tags: [] },
      });
      const result = bagOf(await provider.readCurrentState('my-repo', 'RepoLogical', TYPE, DECLARED));
      expect(policyCalls()).toBe(1);
      const call = mockSend.mock.calls.find((c) => c[0] instanceof GetRepositoryPolicyCommand);
      expect((call?.[0] as GetRepositoryPolicyCommand).input).toEqual({
        repositoryName: 'my-repo',
      });
      expect(result?.['RepositoryPolicyText']).toEqual(POLICY);
    });

    it('keeps a policy text that does not parse as the string AWS returned', async () => {
      route({
        describe: repoWithArn,
        lifecycle: noLifecycle,
        policy: { policyText: 'not-json' },
        tags: { tags: [] },
      });
      const result = bagOf(await provider.readCurrentState('my-repo', 'RepoLogical', TYPE, DECLARED));
      expect(result?.['RepositoryPolicyText']).toBe('not-json');
    });

    it('omits the key when the repository has no policy (RepositoryPolicyNotFoundException)', async () => {
      route({ describe: repoWithArn, lifecycle: noLifecycle, policy: noPolicy(), tags: { tags: [] } });
      const result = bagOf(await provider.readCurrentState('my-repo', 'RepoLogical', TYPE, DECLARED));
      expect(result).toBeDefined();
      expect(Object.hasOwn(result!, 'RepositoryPolicyText')).toBe(false);
    });

    it('omits the key when GetRepositoryPolicy answers an empty policy text', async () => {
      route({ describe: repoWithArn, lifecycle: noLifecycle, policy: {}, tags: { tags: [] } });
      const result = bagOf(await provider.readCurrentState('my-repo', 'RepoLogical', TYPE, DECLARED));
      expect(Object.hasOwn(result!, 'RepositoryPolicyText')).toBe(false);
    });

    it('fails the read on an access denied, never reading it as "no policy"', async () => {
      route({
        describe: repoWithArn,
        lifecycle: noLifecycle,
        policy: accessDenied(),
        tags: { tags: [] },
      });
      await expect(provider.readCurrentState('my-repo', 'RepoLogical', TYPE, DECLARED)).rejects.toThrow(
        'ecr:GetRepositoryPolicy'
      );
    });

    it('makes no GetRepositoryPolicy call on a drift read when the template declares no policy', async () => {
      route({
        describe: repoWithArn,
        lifecycle: noLifecycle,
        // A policy the template does not declare (one Lambda wrote, say), and a
        // caller that may not read it: neither is asked.
        policy: accessDenied,
        tags: { tags: [] },
      });
      const bags = [undefined, {}, { RepositoryName: 'my-repo' }, { RepositoryPolicyText: '' }];
      for (const properties of bags) {
        const result = bagOf(
          await provider.readCurrentState('my-repo', 'RepoLogical', TYPE, properties)
        );
        expect(Object.hasOwn(result!, 'RepositoryPolicyText')).toBe(false);
      }
      expect(policyCalls()).toBe(0);
    });

    it('a drift read believes the first answer: no re-read when the template declares a policy', async () => {
      route({ describe: repoWithArn, lifecycle: noLifecycle, policy: noPolicy(), tags: { tags: [] } });
      const result = bagOf(
        await provider.readCurrentState('my-repo', 'RepoLogical', TYPE, {
          RepositoryPolicyText: POLICY,
        })
      );
      expect(policyCalls()).toBe(1);
      expect(Object.hasOwn(result!, 'RepositoryPolicyText')).toBe(false);
    });
  });

  describe('post-write capture (afterOwnWrite)', () => {
    it('makes no GetRepositoryPolicy call when the template declares no policy', async () => {
      route({
        describe: repoWithArn,
        lifecycle: noLifecycle,
        // A lagging read still showing a policy the write just removed.
        policy: { policyText: JSON.stringify(POLICY) },
        tags: { tags: [] },
      });
      const result = bagOf(
        await provider.readCurrentState(
          'my-repo',
          'RepoLogical',
          TYPE,
          { RepositoryName: 'my-repo' },
          { afterOwnWrite: true }
        )
      );
      expect(policyCalls()).toBe(0);
      expect(Object.hasOwn(result!, 'RepositoryPolicyText')).toBe(false);
    });

    it('records the declared policy on the first read that shows it, with no extra call', async () => {
      route({
        describe: repoWithArn,
        lifecycle: noLifecycle,
        policy: { policyText: JSON.stringify(POLICY) },
        tags: { tags: [] },
      });
      const result = bagOf(
        await provider.readCurrentState(
          'my-repo',
          'RepoLogical',
          TYPE,
          { RepositoryPolicyText: POLICY },
          { afterOwnWrite: true }
        )
      );
      expect(policyCalls()).toBe(1);
      expect(result?.['RepositoryPolicyText']).toEqual(POLICY);
      expect(warn).not.toHaveBeenCalled();
    });

    it('re-reads a lagging answer until it shows the declared policy', async () => {
      const stale = { ...POLICY, Statement: [{ ...POLICY.Statement[0], Action: 'ecr:*' }] };
      const answers = [{ policyText: JSON.stringify(stale) }, { policyText: JSON.stringify(POLICY) }];
      route({
        describe: repoWithArn,
        lifecycle: noLifecycle,
        policy: () => answers.shift() ?? { policyText: JSON.stringify(POLICY) },
        tags: { tags: [] },
      });
      const result = bagOf(
        await provider.readCurrentState(
          'my-repo',
          'RepoLogical',
          TYPE,
          { RepositoryPolicyText: POLICY },
          { afterOwnWrite: true }
        )
      );
      expect(policyCalls()).toBe(2);
      expect(result?.['RepositoryPolicyText']).toEqual(POLICY);
    });

    it('records the declared policy when every read still shows none, and warns', async () => {
      route({ describe: repoWithArn, lifecycle: noLifecycle, policy: noPolicy, tags: { tags: [] } });
      const result = bagOf(
        await provider.readCurrentState(
          'my-repo',
          'RepoLogical',
          TYPE,
          { RepositoryPolicyText: JSON.stringify(POLICY) },
          { afterOwnWrite: true }
        )
      );
      expect(policyCalls()).toBe(4);
      expect(result?.['RepositoryPolicyText']).toEqual(POLICY);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('RepositoryPolicyText');
      expect(String(warn.mock.calls[0]?.[0])).not.toContain('ecr:BatchGetImage');
    });

    it('records another policy as read, and warns, when no read shows the declared one', async () => {
      const other = { ...POLICY, Statement: [{ ...POLICY.Statement[0], Action: 'ecr:*' }] };
      route({
        describe: repoWithArn,
        lifecycle: noLifecycle,
        policy: () => ({ policyText: JSON.stringify(other) }),
        tags: { tags: [] },
      });
      const result = bagOf(
        await provider.readCurrentState(
          'my-repo',
          'RepoLogical',
          TYPE,
          { RepositoryPolicyText: POLICY },
          { afterOwnWrite: true }
        )
      );
      expect(policyCalls()).toBe(4);
      expect(result?.['RepositoryPolicyText']).toEqual(other);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('re-reads a throttled first answer', async () => {
      const answers: Answer[] = [throttled(), { policyText: JSON.stringify(POLICY) }];
      route({
        describe: repoWithArn,
        lifecycle: noLifecycle,
        policy: () => answers.shift(),
        tags: { tags: [] },
      });
      const result = bagOf(
        await provider.readCurrentState(
          'my-repo',
          'RepoLogical',
          TYPE,
          { RepositoryPolicyText: POLICY },
          { afterOwnWrite: true }
        )
      );
      expect(result?.['RepositoryPolicyText']).toEqual(POLICY);
    });

    it('fails the capture on an access denied, with no re-read', async () => {
      route({
        describe: repoWithArn,
        lifecycle: noLifecycle,
        policy: accessDenied,
        tags: { tags: [] },
      });
      await expect(
        provider.readCurrentState(
          'my-repo',
          'RepoLogical',
          TYPE,
          { RepositoryPolicyText: POLICY },
          { afterOwnWrite: true }
        )
      ).rejects.toThrow('ecr:GetRepositoryPolicy');
      expect(policyCalls()).toBe(1);
    });

    it('returns RESOURCE_NOT_FOUND when the repository is gone at the policy read', async () => {
      route({ describe: repoWithArn, lifecycle: noLifecycle, policy: repoGone, tags: { tags: [] } });
      expect(
        await provider.readCurrentState(
          'my-repo',
          'RepoLogical',
          TYPE,
          { RepositoryPolicyText: POLICY },
          { afterOwnWrite: true }
        )
      ).toBe(RESOURCE_NOT_FOUND);
    });
  });
});

describe('ECRProvider drift hooks (go-to-k/cdkd#6631)', () => {
  const provider = new ECRProvider();

  it('declares EmptyOnDelete unknown to drift, for the repository type only', () => {
    expect(provider.getDriftUnknownPaths(TYPE)).toEqual(['EmptyOnDelete']);
    expect(provider.getDriftUnknownPaths('AWS::ECR::PublicRepository')).toEqual([]);
  });

  it('canonicalizes a string RepositoryPolicyText to its parsed document', () => {
    const bag = { RepositoryName: 'r', RepositoryPolicyText: JSON.stringify(POLICY) };
    expect(provider.canonicalizeDriftProperties(TYPE, bag)).toEqual({
      RepositoryName: 'r',
      RepositoryPolicyText: POLICY,
    });
    expect(bag.RepositoryPolicyText).toBe(JSON.stringify(POLICY));
  });

  it('returns every other bag by identity', () => {
    const objectForm = { RepositoryPolicyText: POLICY };
    const unparsable = { RepositoryPolicyText: 'not-json' };
    const none = { RepositoryName: 'r' };
    const otherType = { RepositoryPolicyText: JSON.stringify(POLICY) };
    expect(provider.canonicalizeDriftProperties(TYPE, objectForm)).toBe(objectForm);
    expect(provider.canonicalizeDriftProperties(TYPE, unparsable)).toBe(unparsable);
    expect(provider.canonicalizeDriftProperties(TYPE, none)).toBe(none);
    expect(provider.canonicalizeDriftProperties('AWS::S3::Bucket', otherType)).toBe(otherType);
  });
});
