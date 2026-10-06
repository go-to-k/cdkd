/**
 * go-to-k/cdkd#4583: a file system CreateFileSystem returned, left behind
 * because the failed create's own rollback delete FAILED, is named on the
 * thrown error for the failed-CREATE journal -- and only then.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-fsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-fsx')>();
  return {
    ...actual,
    FSxClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const child = { ...l, child: vi.fn().mockReturnThis() };
  return { getLogger: () => ({ ...l, child: () => child }) };
});

import { FSxFileSystemProvider } from '../../../src/provisioning/providers/fsx-filesystem-provider.js';
import { DeleteFileSystemCommand } from '@aws-sdk/client-fsx';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { allowUnscopedCreateTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';

beforeAll(() => allowUnscopedCreateTokensForTests(true));
afterAll(() => allowUnscopedCreateTokensForTests(false));

const TYPE = 'AWS::FSx::FileSystem';
const FS_ID = 'fs-0123456789abcdef0';
const PROPS = {
  FileSystemType: 'LUSTRE',
  StorageCapacity: 1200,
  SubnetIds: ['subnet-111'],
  LustreConfiguration: { DeploymentType: 'SCRATCH_2' },
};

/** Route by command class name; an Error value rejects. */
function routeSend(routes: Record<string, unknown>): void {
  mockSend.mockImplementation((command: object) => {
    const name = command.constructor.name;
    if (!(name in routes)) return Promise.reject(new Error(`Unexpected command: ${name}`));
    const value = routes[name];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  });
}

function deleteCalls(): unknown[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof DeleteFileSystemCommand);
}

async function failedCreate(props: Record<string, unknown> = PROPS): Promise<unknown> {
  return new FSxFileSystemProvider({ pollIntervalMs: 0, maxWaitMs: 5000 })
    .create('MyFs', TYPE, { ...props })
    .then(
      () => {
        throw new Error('create unexpectedly succeeded');
      },
      (e: unknown) => e
    );
}

const CREATED = { FileSystem: { FileSystemId: FS_ID, CreationTime: new Date() } };
const WENT_FAILED = {
  FileSystems: [{ FileSystemId: FS_ID, Lifecycle: 'FAILED', FailureDetails: { Message: 'boom' } }],
};

describe('FSxFileSystemProvider.create — created-before-failure mark (#4583)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('marks the file system id when it went FAILED and the rollback delete FAILS (pass-through arm)', async () => {
    routeSend({
      CreateFileSystemCommand: CREATED,
      DescribeFileSystemsCommand: WENT_FAILED,
      DeleteFileSystemCommand: new Error('AccessDenied'),
    });

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/FAILED: boom/);
    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'MyFs', TYPE)).toBe(FS_ID);
  });

  it('marks the file system id when a raw failure follows the create and the rollback FAILS (wrap arm)', async () => {
    routeSend({
      CreateFileSystemCommand: CREATED,
      DescribeFileSystemsCommand: new Error('AccessDeniedException: no describe'),
      DeleteFileSystemCommand: new Error('AccessDenied'),
    });

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/^Failed to create FSx FileSystem MyFs/);
    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'MyFs', TYPE)).toBe(FS_ID);
  });

  it('does not mark when the rollback delete succeeded (pass-through arm)', async () => {
    routeSend({
      CreateFileSystemCommand: CREATED,
      DescribeFileSystemsCommand: WENT_FAILED,
      DeleteFileSystemCommand: {},
    });

    const error = await failedCreate();

    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'MyFs', TYPE)).toBeUndefined();
  });

  it('does not mark when the rollback delete succeeded (wrap arm)', async () => {
    routeSend({
      CreateFileSystemCommand: CREATED,
      DescribeFileSystemsCommand: new Error('AccessDeniedException: no describe'),
      DeleteFileSystemCommand: {},
    });

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/^Failed to create FSx FileSystem MyFs/);
    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'MyFs', TYPE)).toBeUndefined();
  });

  it("does not mark CreateFileSystem's own failure", async () => {
    routeSend({ CreateFileSystemCommand: new Error('ServiceLimitExceeded') });

    const error = await failedCreate();

    expect(deleteCalls()).toHaveLength(0);
    expect(createdBeforeFailure(error, 'MyFs', TYPE)).toBeUndefined();
  });

  it('does not mark a file system refused as not this create\'s (no CreationTime)', async () => {
    routeSend({ CreateFileSystemCommand: { FileSystem: { FileSystemId: FS_ID } } });

    const error = await failedCreate();

    expect((error as Error).message).toContain('carries no creation time');
    expect(deleteCalls()).toHaveLength(0);
    expect(createdBeforeFailure(error, 'MyFs', TYPE)).toBeUndefined();
  });

  it('does not mark the pre-flight refusal of an unknown FileSystemType', async () => {
    const error = await failedCreate({ ...PROPS, FileSystemType: 'NOPE' });

    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'MyFs', TYPE)).toBeUndefined();
  });
});
