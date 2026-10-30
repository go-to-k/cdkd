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
import { ProvisioningError } from '../../../../src/utils/error-handler.js';
import { DeleteRepositoryCommand, RepositoryNotEmptyException } from '@aws-sdk/client-ecr';

const RESOURCE_TYPE = 'AWS::ECR::Repository';
const REPO = 'my-images-repo';

function deleteForceArg(): boolean | undefined {
  const call = mockSend.mock.calls.find((c) => c[0] instanceof DeleteRepositoryCommand);
  return call ? (call[0] as DeleteRepositoryCommand).input.force : undefined;
}

describe('ECRProvider delete data guard (issue #1340)', () => {
  let provider: ECRProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ECRProvider();
  });

  it('deletes WITHOUT force when there is no opt-in', async () => {
    mockSend.mockResolvedValue({});

    await provider.delete('Repo', REPO, RESOURCE_TYPE, { RepositoryName: REPO }, undefined);

    expect(deleteForceArg()).toBe(false);
  });

  it('surfaces an actionable CFn-parity error when the repo still contains images', async () => {
    mockSend.mockRejectedValue(
      new RepositoryNotEmptyException({
        message: `The repository with name '${REPO}' cannot be deleted because it still contains images`,
        $metadata: {},
      })
    );

    await expect(
      provider.delete('Repo', REPO, RESOURCE_TYPE, { RepositoryName: REPO }, undefined)
    ).rejects.toThrow(ProvisioningError);

    await expect(
      provider.delete('Repo', REPO, RESOURCE_TYPE, { RepositoryName: REPO }, undefined)
    ).rejects.toThrow(/still contains images.*EmptyOnDelete/s);
  });

  it('force-deletes when EmptyOnDelete: true is in the properties', async () => {
    mockSend.mockResolvedValue({});

    await provider.delete(
      'Repo',
      REPO,
      RESOURCE_TYPE,
      { RepositoryName: REPO, EmptyOnDelete: true },
      undefined
    );

    expect(deleteForceArg()).toBe(true);
  });

  it('force-deletes when EmptyOnDelete is the CFn string "true"', async () => {
    mockSend.mockResolvedValue({});

    await provider.delete(
      'Repo',
      REPO,
      RESOURCE_TYPE,
      { RepositoryName: REPO, EmptyOnDelete: 'true' },
      undefined
    );

    expect(deleteForceArg()).toBe(true);
  });

  // The declared-false arm: a check on the key's PRESENCE rather than its value
  // passes every case above and force-deletes this one (go-to-k/cdkd#3723: the
  // wire suite exempts EmptyOnDelete, since no create or update carries it).
  it.each([false, 'false'])('deletes WITHOUT force when EmptyOnDelete is %j', async (value) => {
    mockSend.mockResolvedValue({});

    await provider.delete(
      'Repo',
      REPO,
      RESOURCE_TYPE,
      { RepositoryName: REPO, EmptyOnDelete: value },
      undefined
    );

    expect(deleteForceArg()).toBe(false);
  });

  it('force-deletes when the CDK auto-delete-images tag is present', async () => {
    mockSend.mockResolvedValue({});

    await provider.delete(
      'Repo',
      REPO,
      RESOURCE_TYPE,
      { Tags: [{ Key: 'aws-cdk:auto-delete-images', Value: 'true' }] },
      undefined
    );

    expect(deleteForceArg()).toBe(true);
  });

  it('force-deletes when the caller passes forceDataDelete (replacement consent)', async () => {
    mockSend.mockResolvedValue({});

    await provider.delete(
      'Repo',
      REPO,
      RESOURCE_TYPE,
      { RepositoryName: REPO },
      { forceDataDelete: true }
    );

    expect(deleteForceArg()).toBe(true);
  });
});
