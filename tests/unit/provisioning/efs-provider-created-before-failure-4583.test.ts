import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vite-plus/test';
import {
  CreateFileSystemCommand,
  CreateMountTargetCommand,
  DeleteFileSystemCommand,
  DescribeFileSystemsCommand,
  DescribeMountTargetsCommand,
  PutLifecycleConfigurationCommand,
} from '@aws-sdk/client-efs';

// go-to-k/cdkd#4583: a file system or mount target this create made and left
// behind is named for `cdkd rollback --revert-failed`; one the rollback delete
// removed, a refusal, and a create call's own failure are not.

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-efs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-efs')>();
  return {
    ...actual,
    EFSClient: vi.fn().mockImplementation(() => ({
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

import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';
import { allowUnscopedCreateTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const FS = 'AWS::EFS::FileSystem';

/**
 * Makes every `Date.now()` read a full day later than the last, so a poll loop
 * exits on its first deadline check and the waiter throws its own timeout
 * `ProvisioningError` -- the realistic post-create failure, which reaches the
 * mark through the `error instanceof ProvisioningError ? error : wrap` arm.
 */
function expireEveryDeadline(): void {
  let now = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 86_400_000));
}

const MT = 'AWS::EFS::MountTarget';

beforeAll(() => {
  allowUnscopedCreateTokensForTests(true);
});
afterAll(() => {
  allowUnscopedCreateTokensForTests(false);
});

async function failure(
  provider: EFSProvider,
  type: string,
  properties: Record<string, unknown>
): Promise<unknown> {
  return provider.create('Res', type, properties).then(
    () => expect.fail('create resolved'),
    (e: unknown) => e
  );
}

describe('EFSProvider createdBeforeFailure mark (go-to-k/cdkd#4583)', () => {
  let provider: EFSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new EFSProvider();
  });

  describe('file system', () => {
    const props = { LifecyclePolicies: [{ TransitionToIA: 'AFTER_7_DAYS' }] };

    function prime(rollback: 'ok' | 'fail'): void {
      mockSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof CreateFileSystemCommand) {
          return {
            FileSystemId: 'fs-1',
            CreationTime: new Date(),
            FileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-1',
          };
        }
        if (cmd instanceof DescribeFileSystemsCommand) {
          return { FileSystems: [{ LifeCycleState: 'available' }] };
        }
        if (cmd instanceof PutLifecycleConfigurationCommand) {
          throw new Error('AccessDenied: not authorized');
        }
        if (cmd instanceof DeleteFileSystemCommand) {
          if (rollback === 'fail') throw new Error('DeleteFileSystem boom');
          return {};
        }
        return {};
      });
    }

    it('marks the file system id when a post-ACTIVE step fails and the rollback delete fails', async () => {
      prime('fail');
      expect(createdBeforeFailure(await failure(provider, FS, props), 'Res', FS)).toBe('fs-1');
    });

    it('does not mark when the rollback delete succeeded', async () => {
      prime('ok');
      const error = await failure(provider, FS, props);
      expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteFileSystemCommand)).toBe(true);
      expect(createdBeforeFailure(error, 'Res', FS)).toBeUndefined();
    });

    it('marks the file system id when the available-wait times out and the rollback delete fails', async () => {
      prime('fail');
      expireEveryDeadline();
      try {
        const error = await failure(provider, FS, props);
        expect(error).toBeInstanceOf(ProvisioningError);
        expect((error as Error).message).toContain('Timed out waiting for EFS FileSystem fs-1');
        expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteFileSystemCommand)).toBe(true);
        expect(createdBeforeFailure(error, 'Res', FS)).toBe('fs-1');
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('does not mark when CreateFileSystem itself fails', async () => {
      mockSend.mockRejectedValue(new Error('AccessDenied: CreateFileSystem'));
      expect(createdBeforeFailure(await failure(provider, FS, props), 'Res', FS)).toBeUndefined();
    });
  });

  describe('mount target', () => {
    const props = { FileSystemId: 'fs-1', SubnetId: 'subnet-1' };

    it('marks the mount target id when the wait after CreateMountTarget fails', async () => {
      mockSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof CreateMountTargetCommand) return { MountTargetId: 'fsmt-1' };
        if (cmd instanceof DescribeMountTargetsCommand) throw new Error('AccessDenied: describe');
        return {};
      });
      expect(createdBeforeFailure(await failure(provider, MT, props), 'Res', MT)).toBe('fsmt-1');
    });

    it('marks the mount target id when the available-wait times out (ProvisioningError)', async () => {
      mockSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof CreateMountTargetCommand) return { MountTargetId: 'fsmt-1' };
        if (cmd instanceof DescribeMountTargetsCommand) {
          return { MountTargets: [{ LifeCycleState: 'creating' }] };
        }
        return {};
      });
      expireEveryDeadline();
      try {
        const error = await failure(provider, MT, props);
        expect(error).toBeInstanceOf(ProvisioningError);
        expect((error as Error).message).toContain('Timed out waiting for EFS MountTarget fsmt-1');
        expect(createdBeforeFailure(error, 'Res', MT)).toBe('fsmt-1');
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('does not mark when CreateMountTarget itself fails', async () => {
      mockSend.mockRejectedValue(new Error('MountTargetConflict'));
      expect(createdBeforeFailure(await failure(provider, MT, props), 'Res', MT)).toBeUndefined();
    });

    it('does not mark a pre-flight refusal', async () => {
      const error = await failure(provider, MT, { FileSystemId: 'fs-1' });
      expect(mockSend).not.toHaveBeenCalled();
      expect(createdBeforeFailure(error, 'Res', MT)).toBeUndefined();
    });
  });
});
