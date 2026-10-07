import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vite-plus/test';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier FSx file system. Only `'different'` lets
// it delete.

const { mockSend, clientRegion, providerLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'us-east-1' },
  providerLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('@aws-sdk/client-fsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-fsx')>();
  return {
    ...actual,
    FSxClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve(clientRegion.value) },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...providerLogger, child: () => providerLogger }),
}));

import {
  CreateFileSystemCommand,
  DeleteFileSystemCommand,
  DescribeFileSystemsCommand,
  FileSystemNotFound,
} from '@aws-sdk/client-fsx';
import { FSxFileSystemProvider } from '../../../src/provisioning/providers/fsx-filesystem-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { allowUnscopedCreateTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';

beforeAll(() => allowUnscopedCreateTokensForTests(true));
afterAll(() => allowUnscopedCreateTokensForTests(false));

const TYPE = 'AWS::FSx::FileSystem';
const CTX = { expectedRegion: 'us-east-1' };
const FS_A = 'fs-0aaaaaaaaaaaaaaa1';
const FS_B = 'fs-0bbbbbbbbbbbbbbb2';

const notFound = (): Error =>
  new FileSystemNotFound({ message: 'File system not found', $metadata: {} });
const awsError = (name: string, message = name): Error =>
  Object.assign(new Error(message), { name });

/** `DescribeFileSystems` answers per id: its lifecycle, gone, or an error. */
function fileSystems(live: Record<string, string | 'gone' | Error>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (!(cmd instanceof DescribeFileSystemsCommand)) throw new Error('unexpected command');
    const id = cmd.input.FileSystemIds![0]!;
    const entry = live[id];
    if (entry === undefined || entry === 'gone') throw notFound();
    if (entry instanceof Error) throw entry;
    return { FileSystems: [{ FileSystemId: id, Lifecycle: entry }] };
  });
}

const readIds = (): unknown[] =>
  mockSend.mock.calls.map(([c]) => (c as DescribeFileSystemsCommand).input.FileSystemIds);

let provider: FSxFileSystemProvider;

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  clientRegion.value = 'us-east-1';
  provider = new FSxFileSystemProvider({ pollIntervalMs: 0, maxWaitMs: 5000 });
});

describe('FSxFileSystemProvider.isSameResource (go-to-k/cdkd#4606)', () => {
  it('another live file system is different, after reading the record first, then the journaled one', async () => {
    fileSystems({ [FS_A]: 'AVAILABLE', [FS_B]: 'AVAILABLE' });
    expect(await provider.isSameResource(FS_A, { physicalId: FS_B }, TYPE, CTX)).toBe('different');
    expect(readIds()).toEqual([[FS_B], [FS_A]]);
  });

  it.each(['CREATING', 'AVAILABLE', 'FAILED', 'MISCONFIGURED', 'DELETING', 'gone'])(
    'a journaled file system %s is different once the record reads back live',
    async (journaled) => {
      fileSystems({ [FS_A]: journaled, [FS_B]: 'AVAILABLE' });
      expect(await provider.isSameResource(FS_A, { physicalId: FS_B }, TYPE, CTX)).toBe(
        'different'
      );
    }
  );

  it.each(['CREATING', 'UPDATING', 'MISCONFIGURED', 'MISCONFIGURED_UNAVAILABLE'])(
    'a record file system %s counts as live',
    async (recorded) => {
      fileSystems({ [FS_A]: 'AVAILABLE', [FS_B]: recorded });
      expect(await provider.isSameResource(FS_A, { physicalId: FS_B }, TYPE, CTX)).toBe(
        'different'
      );
    }
  );

  it.each(['DELETING', 'FAILED', 'gone'])(
    'the record file system %s is unknown, not different, and the journaled one is not read',
    async (recorded) => {
      fileSystems({ [FS_A]: 'AVAILABLE', [FS_B]: recorded });
      expect(await provider.isSameResource(FS_A, { physicalId: FS_B }, TYPE, CTX)).toBe('unknown');
      expect(readIds()).toEqual([[FS_B]]);
    }
  );

  it('a record read without a lifecycle is live (only DELETING / FAILED are not)', async () => {
    mockSend.mockImplementation(async (cmd: DescribeFileSystemsCommand) => ({
      FileSystems: [{ FileSystemId: cmd.input.FileSystemIds![0] }],
    }));
    expect(await provider.isSameResource(FS_A, { physicalId: FS_B }, TYPE, CTX)).toBe('different');
  });

  it('equal ids are the same without a read', async () => {
    fileSystems({});
    expect(await provider.isSameResource(FS_A, { physicalId: FS_A }, TYPE, CTX)).toBe('same');
    expect(mockSend).not.toHaveBeenCalled();
  });

  // Defensive: FSx cannot answer one id with another; the branch exists so a
  // read naming the record's file system never reads as 'different'.
  it('a journaled id reading back as the record file system is the same', async () => {
    mockSend.mockResolvedValue({ FileSystems: [{ FileSystemId: FS_B, Lifecycle: 'AVAILABLE' }] });
    expect(await provider.isSameResource(FS_A, { physicalId: FS_B }, TYPE, CTX)).toBe('same');
  });

  it('a record read answering another id is unknown, and the journaled one is not read', async () => {
    mockSend.mockResolvedValue({ FileSystems: [{ FileSystemId: FS_A, Lifecycle: 'AVAILABLE' }] });
    expect(await provider.isSameResource(FS_A, { physicalId: FS_B }, TYPE, CTX)).toBe('unknown');
    expect(readIds()).toEqual([[FS_B]]);
  });

  it('a read that fails other than not-found throws (the caller reads it as unknown)', async () => {
    fileSystems({
      [FS_A]: awsError('AccessDeniedException', 'denied'),
      [FS_B]: 'AVAILABLE',
    });
    await expect(provider.isSameResource(FS_A, { physicalId: FS_B }, TYPE, CTX)).rejects.toThrow(
      'denied'
    );
  });

  it('an error merely NAMED like not-found, but not FSx’s FileSystemNotFound, is not read as gone', async () => {
    fileSystems({ [FS_A]: awsError('FileSystemNotFound', 'lookalike'), [FS_B]: 'AVAILABLE' });
    await expect(provider.isSameResource(FS_A, { physicalId: FS_B }, TYPE, CTX)).rejects.toThrow(
      'lookalike'
    );
    fileSystems({ [FS_A]: awsError('VolumeNotFound'), [FS_B]: 'AVAILABLE' });
    await expect(provider.isSameResource(FS_A, { physicalId: FS_B }, TYPE, CTX)).rejects.toThrow(
      'VolumeNotFound'
    );
  });

  it.each([
    ['no file system', { FileSystems: [] }],
    ['no list', {}],
    ['two file systems', { FileSystems: [{ FileSystemId: FS_B }, { FileSystemId: FS_A }] }],
    ['a file system without an id', { FileSystems: [{ Lifecycle: 'AVAILABLE' }] }],
  ])('a response naming %s throws rather than reading as gone', async (_label, response) => {
    mockSend.mockResolvedValue(response);
    await expect(provider.isSameResource(FS_A, { physicalId: FS_B }, TYPE, CTX)).rejects.toThrow(
      'did not return exactly the file system asked for'
    );
  });

  it('a client in another region is unknown, with no read', async () => {
    clientRegion.value = 'eu-west-1';
    fileSystems({ [FS_A]: 'gone', [FS_B]: 'AVAILABLE' });
    expect(await provider.isSameResource(FS_A, { physicalId: FS_B }, TYPE, CTX)).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('an id that is not a file system id is unknown, with no read', async () => {
    fileSystems({ [FS_A]: 'gone', [FS_B]: 'AVAILABLE' });
    for (const [journaled, recorded] of [
      ['', FS_B],
      [FS_A, ''],
      [`arn:aws:fsx:us-east-1:123456789012:file-system/${FS_A}`, FS_B],
      [FS_A, `arn:aws:fsx:us-east-1:123456789012:file-system/${FS_B}`],
      [FS_A, FS_B.toUpperCase()],
      [`${FS_A}|x`, FS_B],
      ['fsvol-0aaaaaaaaaaaaaaa1', FS_B],
      ['svm-0aaaaaaaaaaaaaaa1', FS_B],
      ['fs-', FS_B],
    ] as const) {
      expect(await provider.isSameResource(journaled, { physicalId: recorded }, TYPE, CTX)).toBe(
        'unknown'
      );
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('another resource type is unknown, with no read, even for file-system-shaped ids', async () => {
    fileSystems({ [FS_A]: 'gone', [FS_B]: 'AVAILABLE' });
    for (const type of ['AWS::FSx::Volume', 'AWS::FSx::StorageVirtualMachine', 'AWS::EFS::FileSystem']) {
      expect(await provider.isSameResource(FS_A, { physicalId: FS_B }, type, CTX)).toBe('unknown');
      expect(await provider.isSameResource(FS_A, { physicalId: FS_A }, type, CTX)).toBe('unknown');
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  // The id form the failed create journals is the one this method reads: the
  // journaled id of a create whose wait and cleanup delete both failed (the
  // real-AWS arm's mechanism) is answered 'different' against a new record.
  it("answers 'different' for the id a failed create journals (the create path's own form)", async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateFileSystemCommand) {
        return { FileSystem: { FileSystemId: FS_A, CreationTime: new Date() } };
      }
      if (cmd instanceof DescribeFileSystemsCommand || cmd instanceof DeleteFileSystemCommand) {
        throw awsError('AccessDeniedException', 'explicit deny');
      }
      throw new Error('unexpected command');
    });
    const error = await provider
      .create('Orphan', TYPE, {
        FileSystemType: 'LUSTRE',
        StorageCapacity: 1200,
        SubnetIds: ['subnet-111'],
        LustreConfiguration: { DeploymentType: 'SCRATCH_2' },
      })
      .then(
        () => {
          throw new Error('create unexpectedly succeeded');
        },
        (e: unknown) => e
      );
    const journaled = createdBeforeFailure(error, 'Orphan', TYPE);
    expect(journaled).toBe(FS_A);

    mockSend.mockReset();
    fileSystems({ [FS_A]: 'AVAILABLE', [FS_B]: 'AVAILABLE' });
    expect(await provider.isSameResource(journaled!, { physicalId: FS_B }, TYPE, CTX)).toBe(
      'different'
    );
  });
});

describe('FSxFileSystemProvider.delete of a journaled file system already gone (go-to-k/cdkd#4606)', () => {
  it('names it once at info, since the settle then exits 0', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DeleteFileSystemCommand) throw notFound();
      throw new Error('unexpected command');
    });
    await provider.delete('Orphan', FS_A, TYPE, {}, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    const infos = providerLogger.info.mock.calls.map(([m]) => String(m));
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain(FS_A);
    expect(infos[0]).toContain('already gone');

    // A record's own delete keeps the quiet debug line.
    providerLogger.info.mockClear();
    await provider.delete('Orphan', FS_A, TYPE, {}, { expectedRegion: 'us-east-1' });
    expect(providerLogger.info).not.toHaveBeenCalled();
  });
});
