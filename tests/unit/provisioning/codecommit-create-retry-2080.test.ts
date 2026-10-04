import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, mockS3Send, sentVia, baseStrategy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockS3Send: vi.fn(),
  /** `[command name, client config]` per send, so a test can see WHICH client sent it. */
  sentVia: [] as Array<[string, { retryStrategy: () => Promise<unknown> }]>,
  /** A stand-in for the SDK's resolved V2 retry strategy. */
  baseStrategy: {
    acquireInitialRetryToken: async (_scope: string) => 'token',
    refreshRetryTokenForRetry: async (_token: unknown, _info: { error?: unknown }) =>
      'retry-token',
    recordSuccess: (_token: unknown) => undefined,
  },
}));

vi.mock('@aws-sdk/client-codecommit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-codecommit')>();
  return {
    ...actual,
    CodeCommitClient: vi.fn().mockImplementation(() => {
      const config = {
        region: () => Promise.resolve('us-east-1'),
        retryStrategy: async (): Promise<unknown> => baseStrategy,
      };
      return {
        config,
        send: (command: { constructor: { name: string } }) => {
          sentVia.push([command.constructor.name, config]);
          return mockSend(command);
        },
      };
    }),
  };
});

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send })),
  };
});

vi.mock('adm-zip', () => ({
  default: vi.fn().mockImplementation(() => ({
    getEntries: () => [
      { entryName: 'README.md', isDirectory: false, getData: () => Buffer.from('hi') },
    ],
  })),
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

import {
  ParentCommitIdRequiredException,
  RepositoryNameExistsException,
} from '@aws-sdk/client-codecommit';
import { CodeCommitRepositoryProvider } from '../../../src/provisioning/providers/codecommit-repository-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  isNameCollisionErrorFrom,
  isReplayedNameCollisionFrom,
} from '../../../src/deployment/retryable-errors.js';
import {
  isAuxiliaryMarkOf,
  RETRY_AUXILIARY_OWNER,
} from '../../../src/provisioning/auxiliary-failure.js';

/** The shape `isTransientServerError` / `isAmbiguousOutcomeError` classify (issue #2026). */
const transient500 = (): Error =>
  Object.assign(new Error('Internal failure'), {
    name: 'InternalFailure',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

const throttled = (): Error =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $fault: 'server',
    $metadata: { httpStatusCode: 503 },
  });

/** Advance the fake clock on every backoff (issue #2080 acceptance item 3). */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

/** A fake CodeCommit. `repositories` counts RESOURCES, not calls (issue #2080 acceptance item 2). */
class FakeCodeCommit {
  /** Repository name -> its branches. */
  readonly repositories = new Map<string, Set<string>>();
  readonly calls: string[] = [];
  /** The named call does its work, THEN throws this (a lost response). */
  readonly loseNextResponse = new Map<string, Error>();

  send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    this.calls.push(name);
    const input = command.input;
    const lose = (): void => {
      const error = this.loseNextResponse.get(name);
      if (error) {
        this.loseNextResponse.delete(name);
        throw error;
      }
    };
    switch (name) {
      case 'CreateRepositoryCommand': {
        const repositoryName = input['repositoryName'] as string;
        if (this.repositories.has(repositoryName)) {
          throw new RepositoryNameExistsException({
            message: `Repository named ${repositoryName} already exists`,
            $metadata: { httpStatusCode: 400 },
          });
        }
        this.repositories.set(repositoryName, new Set());
        lose();
        return {
          repositoryMetadata: {
            repositoryName,
            repositoryId: `id-${repositoryName}`,
            Arn: `arn:aws:codecommit:us-east-1:123456789012:${repositoryName}`,
          },
        };
      }
      case 'CreateCommitCommand': {
        const branches = this.repositories.get(input['repositoryName'] as string)!;
        const branch = input['branchName'] as string;
        // A commit with no parent onto a branch that exists is refused.
        if (branches.has(branch) && input['parentCommitId'] === undefined) {
          throw new ParentCommitIdRequiredException({
            message: 'A parent commit ID is required.',
            $metadata: { httpStatusCode: 400 },
          });
        }
        branches.add(branch);
        lose();
        return { commitId: 'c1' };
      }
      case 'DeleteRepositoryCommand':
        this.repositories.delete(input['repositoryName'] as string);
        return {};
      default:
        return {};
    }
  };
}

const PROPS = { RepositoryName: 'orders' };
const SEEDED = {
  RepositoryName: 'orders',
  Code: { S3: { Bucket: 'b', Key: 'k.zip' }, BranchName: 'main' },
};

/**
 * The first two cases pin what a create 5xx reaches once it is no longer
 * replayed inside the SDK -- the outcome the create client's comment argues
 * for; the fake never replays, so they hold either way. The third case is the
 * one the client change itself turns red.
 */
describe('CodeCommitRepositoryProvider create retry safety (issue #2080)', () => {
  let provider: CodeCommitRepositoryProvider;
  let aws: FakeCodeCommit;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    aws = new FakeCodeCommit();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    mockS3Send.mockReset();
    mockS3Send.mockResolvedValue({
      Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([1])) },
    });
    sentVia.length = 0;
    provider = new CodeCommitRepositoryProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createWithRetry = (props: Record<string, unknown>) =>
    withRetry(() => provider.create('Repo', 'AWS::CodeCommit::Repository', props), 'Repo', {
      sleep: advancingSleep,
    });

  it('a lost CreateRepository response surfaces the replay collision as one THIS create may have made', async () => {
    aws.loseNextResponse.set('CreateRepositoryCommand', transient500());

    const error = await createWithRetry(PROPS).catch((e: unknown) => e);

    // One repository, never two: the name collides rather than duplicating.
    expect([...aws.repositories.keys()]).toEqual(['orders']);
    // Read as a REPLAYED collision, never as a name somebody else holds --
    // the verdict a delete-first path would act on.
    expect(isNameCollisionErrorFrom(error, 'Repo')).toBe(false);
    expect(
      isReplayedNameCollisionFrom(error, 'Repo', (link) =>
        isAuxiliaryMarkOf(link, RETRY_AUXILIARY_OWNER)
      )
    ).toBe(true);
  });

  it('a lost seed CreateCommit response deletes the repository and creates it again cleanly', async () => {
    aws.loseNextResponse.set('CreateCommitCommand', transient500());

    const result = await createWithRetry(SEEDED);

    expect(result.physicalId).toBe('orders');
    expect([...aws.repositories.keys()]).toEqual(['orders']);
    expect(aws.calls.filter((c) => c === 'CreateRepositoryCommand')).toHaveLength(2);
    expect(aws.calls).toContain('DeleteRepositoryCommand');
    // The re-created repository carries its seed.
    expect(aws.calls.filter((c) => c === 'CreateCommitCommand')).toHaveLength(2);
    expect([...aws.repositories.get('orders')!]).toEqual(['main']);
  });

  it('sends CreateRepository and CreateCommit through a client that refuses the SDK retry of a 5xx, and nothing else', async () => {
    await provider.create('Repo', 'AWS::CodeCommit::Repository', SEEDED);
    await provider.delete('Repo', 'orders', 'AWS::CodeCommit::Repository', {}).catch(() => {});

    for (const name of ['CreateRepositoryCommand', 'CreateCommitCommand']) {
      const config = sentVia.find(([n]) => n === name)![1];
      const strategy = (await config.retryStrategy()) as typeof baseStrategy;
      await expect(
        strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
      ).rejects.toThrow();
      await expect(
        strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)
      ).resolves.toBe('retry-token');
    }
    const deleteConfig = sentVia.find(([n]) => n === 'DeleteRepositoryCommand')![1];
    expect(await deleteConfig.retryStrategy()).toBe(baseStrategy);
  });
});
