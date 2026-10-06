import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateRepositoryCommand,
  PutLifecyclePolicyCommand,
  SetRepositoryPolicyCommand,
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
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

// go-to-k/cdkd#4583: a failure after CreateRepository returned names the
// repository for the failed-CREATE journal; CreateRepository's own failure
// and a pre-flight refusal do not.
const TYPE = 'AWS::ECR::Repository';
const REPO = 'my-repo';

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected create() to throw');
}

describe('ECRProvider.create created-before-failure mark (#4583)', () => {
  let provider: ECRProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new ECRProvider();
  });

  it('marks the repository name when a follow-up call fails after CreateRepository returned', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateRepositoryCommand) {
        return { repository: { repositoryName: REPO, repositoryArn: 'arn', repositoryUri: 'uri' } };
      }
      if (cmd instanceof PutLifecyclePolicyCommand) throw new Error('AccessDenied');
      return {};
    });
    const err = await caught(
      provider.create('Repo', TYPE, {
        RepositoryName: REPO,
        LifecyclePolicy: { LifecyclePolicyText: '{}' },
      })
    );
    expect(createdBeforeFailure(err, 'Repo', TYPE)).toBe(REPO);
  });

  it('marks when SetRepositoryPolicy fails', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateRepositoryCommand) return { repository: { repositoryName: REPO } };
      if (cmd instanceof SetRepositoryPolicyCommand) throw new Error('InvalidParameter');
      return {};
    });
    const err = await caught(
      provider.create('Repo', TYPE, { RepositoryName: REPO, RepositoryPolicyText: { a: 1 } })
    );
    expect(createdBeforeFailure(err, 'Repo', TYPE)).toBe(REPO);
  });

  it('does not mark when CreateRepository itself fails', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('exists'), { name: 'RepositoryAlreadyExistsException' })
    );
    const err = await caught(provider.create('Repo', TYPE, { RepositoryName: REPO }));
    expect(createdBeforeFailure(err, 'Repo', TYPE)).toBeUndefined();
  });

  it('does not mark a pre-flight refusal of malformed Tags', async () => {
    const err = await caught(provider.create('Repo', TYPE, { RepositoryName: REPO, Tags: 'x' }));
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(err, 'Repo', TYPE)).toBeUndefined();
  });
});
