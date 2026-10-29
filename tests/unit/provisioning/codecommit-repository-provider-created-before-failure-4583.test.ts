import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-codecommit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-codecommit')>();
  return {
    ...actual,
    CodeCommitClient: vi.fn().mockImplementation(() => ({
      config: {
        region: () => Promise.resolve('us-east-1'),
        retryStrategy: async (): Promise<unknown> => ({
          acquireInitialRetryToken: async () => 'token',
          refreshRetryTokenForRetry: async () => 'retry-token',
          recordSuccess: () => undefined,
        }),
      },
      send: (command: unknown) => mockSend(command),
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

import {
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  PutRepositoryTriggersCommand,
  RepositoryNameExistsException,
} from '@aws-sdk/client-codecommit';
import { CodeCommitRepositoryProvider } from '../../../src/provisioning/providers/codecommit-repository-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../src/provisioning/created-resource-sink.js';

// go-to-k/cdkd#4583: create() self-cleans a post-create failure; only a
// repository that cleanup failed to delete is named for the failed-CREATE
// journal.
const TYPE = 'AWS::CodeCommit::Repository';
const REPO = 'my-repo';
const PROPS = {
  RepositoryName: REPO,
  Triggers: [
    {
      Name: 't',
      DestinationArn: 'arn:aws:sns:us-east-1:123456789012:topic',
      Events: ['all'],
    },
  ],
};

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected create() to throw');
}

function fakeAws(deleteFails: boolean): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof CreateRepositoryCommand) {
      return { repositoryMetadata: { repositoryName: REPO, repositoryId: 'id-1' } };
    }
    if (cmd instanceof PutRepositoryTriggersCommand) throw new Error('InvalidTriggerDestination');
    if (cmd instanceof DeleteRepositoryCommand && deleteFails) throw new Error('AccessDenied');
    return {};
  });
}

describe('CodeCommitRepositoryProvider.create created-before-failure mark (#4583)', () => {
  let provider: CodeCommitRepositoryProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new CodeCommitRepositoryProvider();
  });

  it('marks the repository name when the post-create self-clean delete failed', async () => {
    fakeAws(true);
    const err = await caught(provider.create('Repo', TYPE, PROPS));
    expect(createdBeforeFailure(err, 'Repo', TYPE)).toBe(REPO);
  });

  it('does not mark when the post-create self-clean deleted the repository', async () => {
    fakeAws(false);
    const err = await caught(provider.create('Repo', TYPE, PROPS));
    expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteRepositoryCommand)).toBe(true);
    expect(createdBeforeFailure(err, 'Repo', TYPE)).toBeUndefined();
  });

  it('does not mark when CreateRepository itself fails', async () => {
    mockSend.mockRejectedValue(
      new RepositoryNameExistsException({ message: 'exists', $metadata: {} })
    );
    const err = await caught(provider.create('Repo', TYPE, PROPS));
    expect(createdBeforeFailure(err, 'Repo', TYPE)).toBeUndefined();
  });

  it('does not mark the pre-flight refusal of a malformed Triggers list', async () => {
    const err = await caught(provider.create('Repo', TYPE, { RepositoryName: REPO, Triggers: 'x' }));
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(err, 'Repo', TYPE)).toBeUndefined();
  });

  // go-to-k/cdkd#5511: the sink holds the repository name once CreateRepository
  // returned, before the Code seed and triggers.
  it('reports the repository name before the post-create steps', async () => {
    const sink = new CreatedResourceSink('Repo', TYPE);
    let atTriggers: unknown = 'unset';
    fakeAws(true);
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof PutRepositoryTriggersCommand) atTriggers = sink.report;
      return base(cmd);
    });
    await collectCreatedResources(sink, () => caught(provider.create('Repo', TYPE, PROPS)));
    expect(atTriggers).toEqual({ physicalId: REPO });
    expect(sink.report).toEqual({ physicalId: REPO });
  });

  it('leaves nothing reported when the self-clean deleted the repository', async () => {
    const sink = new CreatedResourceSink('Repo', TYPE);
    fakeAws(false);
    await collectCreatedResources(sink, () => caught(provider.create('Repo', TYPE, PROPS)));
    expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteRepositoryCommand)).toBe(true);
    expect(sink.report).toBeUndefined();
  });

  it('reports nothing when CreateRepository itself fails', async () => {
    const sink = new CreatedResourceSink('Repo', TYPE);
    mockSend.mockRejectedValue(
      new RepositoryNameExistsException({ message: 'exists', $metadata: {} })
    );
    await collectCreatedResources(sink, () => caught(provider.create('Repo', TYPE, PROPS)));
    expect(sink.report).toBeUndefined();
  });
});
