import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  TagResourceCommand,
  UntagResourceCommand,
  UpdateFileSystemCommand,
} from '@aws-sdk/client-efs';

const mockSend = vi.fn();
const warn = vi.fn();

vi.mock('@aws-sdk/client-efs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-efs')>(
    '@aws-sdk/client-efs'
  );
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
    warn: (m: string) => warn(m),
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
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

/**
 * go-to-k/cdkd#5464: `FileSystemTags` and `AccessPointTags` are tag-updatable
 * in the CloudFormation schema (`tagging.tagUpdatable: true`, neither
 * create-only), so CloudFormation retags both in place. Before the fix a
 * FileSystem tag-only change returned "No mutable diff" (AWS kept the old
 * tags while state recorded the new ones) and an AccessPoint tag change was
 * refused with ResourceUpdateNotSupportedError.
 */
const sent = (ctor: unknown) =>
  mockSend.mock.calls.map((c) => c[0]).filter((cmd) => cmd instanceof (ctor as never));

const T = (Key: string, Value: string) => ({ Key, Value });

describe('EFS tag updates (#5464)', () => {
  let provider: EFSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    warn.mockReset();
    provider = new EFSProvider();
  });

  describe.each([
    ['AWS::EFS::FileSystem', 'FileSystemTags', 'fs-123', { Encrypted: true }],
    [
      'AWS::EFS::AccessPoint',
      'AccessPointTags',
      'fsap-123',
      { FileSystemId: 'fs-123', PosixUser: { Uid: '1000', Gid: '1000' } },
    ],
  ] as const)('%s', (type, prop, id, base) => {
    const update = (prev: unknown, next: unknown) =>
      provider.update(
        'Res',
        id,
        type,
        { ...base, ...(next === undefined ? {} : { [prop]: next }) },
        { ...base, ...(prev === undefined ? {} : { [prop]: prev }) }
      );

    it('tags an added key and retags a changed value, untagging nothing', async () => {
      const result = await update([T('a', '1'), T('b', '2')], [T('a', '9'), T('b', '2'), T('c', '3')]);
      expect(result).toEqual({ physicalId: id, wasReplaced: false });
      expect(sent(TagResourceCommand).map((c) => c.input)).toEqual([
        { ResourceId: id, Tags: [T('a', '9'), T('c', '3')] },
      ]);
      expect(sent(UntagResourceCommand)).toHaveLength(0);
      expect(sent(UpdateFileSystemCommand)).toHaveLength(0);
    });

    it('untags a key the template dropped', async () => {
      await update([T('a', '1'), T('b', '2')], [T('a', '1')]);
      expect(sent(UntagResourceCommand).map((c) => c.input)).toEqual([
        { ResourceId: id, TagKeys: ['b'] },
      ]);
      expect(sent(TagResourceCommand)).toHaveLength(0);
    });

    it('untags every recorded key when the whole property is removed', async () => {
      await update([T('a', '1'), T('b', '2')], undefined);
      expect(sent(UntagResourceCommand).map((c) => c.input)).toEqual([
        { ResourceId: id, TagKeys: ['a', 'b'] },
      ]);
      expect(sent(TagResourceCommand)).toHaveLength(0);
    });

    it('tags every key when the property is added', async () => {
      await update(undefined, [T('a', '1')]);
      expect(sent(TagResourceCommand).map((c) => c.input)).toEqual([
        { ResourceId: id, Tags: [T('a', '1')] },
      ]);
      expect(sent(UntagResourceCommand)).toHaveLength(0);
    });

    it('sends nothing for an unchanged or merely reordered tag list', async () => {
      await update([T('a', '1'), T('b', '2')], [T('a', '1'), T('b', '2')]);
      await update([T('a', '1'), T('b', '2')], [T('b', '2'), T('a', '1')]);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a malformed desired tag list before any call', async () => {
      await expect(update([T('a', '1')], 'not-a-list')).rejects.toThrow(
        new RegExp(`desired ${prop} of ${type} Res is not a list of tags`)
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('untags nothing when the recorded side is unreadable, and warns', async () => {
      await update('garbage', [T('a', '1')]);
      expect(sent(UntagResourceCommand)).toHaveLength(0);
      expect(sent(TagResourceCommand).map((c) => c.input)).toEqual([
        { ResourceId: id, Tags: [T('a', '1')] },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cdkd removed no tag'));
    });
  });

  it('FileSystem: a tag change beside a throughput change sends both', async () => {
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd instanceof UpdateFileSystemCommand
          ? {}
          : { FileSystems: [{ FileSystemId: 'fs-123', LifeCycleState: 'available' }] }
      )
    );
    await provider.update(
      'Res',
      'fs-123',
      'AWS::EFS::FileSystem',
      { ThroughputMode: 'elastic', FileSystemTags: [T('a', '2')] },
      { ThroughputMode: 'bursting', FileSystemTags: [T('a', '1')] }
    );
    expect(sent(UpdateFileSystemCommand).map((c) => c.input)).toEqual([
      { FileSystemId: 'fs-123', ThroughputMode: 'elastic' },
    ]);
    expect(sent(TagResourceCommand).map((c) => c.input)).toEqual([
      { ResourceId: 'fs-123', Tags: [T('a', '2')] },
    ]);
  });

  // The issue's second, unmeasured shape: a live CFn A/B kept a provisioned
  // file system provisioned@1MiBps when the template removed ThroughputMode
  // alone, so sending nothing is CloudFormation parity. Negative pin.
  it('FileSystem: removing ThroughputMode alone from a provisioned file system sends nothing', async () => {
    await provider.update(
      'Res',
      'fs-123',
      'AWS::EFS::FileSystem',
      { ProvisionedThroughputInMibps: 1 },
      { ThroughputMode: 'provisioned', ProvisionedThroughputInMibps: 1 }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('AccessPoint: a non-tag change is still refused, before any call', async () => {
    await expect(
      provider.update(
        'Res',
        'fsap-123',
        'AWS::EFS::AccessPoint',
        { FileSystemId: 'fs-1', RootDirectory: { Path: '/b' }, AccessPointTags: [T('a', '2')] },
        { FileSystemId: 'fs-1', RootDirectory: { Path: '/a' }, AccessPointTags: [T('a', '1')] }
      )
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('AccessPoint: a reordered non-tag object beside a tag change is not refused', async () => {
    await provider.update(
      'Res',
      'fsap-123',
      'AWS::EFS::AccessPoint',
      { PosixUser: { Gid: 1, Uid: 1 }, AccessPointTags: [T('a', '2')] },
      { PosixUser: { Uid: 1, Gid: 1 }, AccessPointTags: [T('a', '1')] }
    );
    expect(sent(TagResourceCommand).map((c) => c.input)).toEqual([
      { ResourceId: 'fsap-123', Tags: [T('a', '2')] },
    ]);
  });

  it('AccessPoint: a recorded dynamic reference in a non-tag property is left to the diff layer', async () => {
    await provider.update(
      'Res',
      'fsap-123',
      'AWS::EFS::AccessPoint',
      { RootDirectory: { Path: '/resolved' }, AccessPointTags: [T('a', '2')] },
      {
        RootDirectory: { Path: '{{resolve:secretsmanager:s:SecretString:p}}' },
        AccessPointTags: [T('a', '1')],
      }
    );
    expect(sent(TagResourceCommand)).toHaveLength(1);
  });

  it('AccessPoint: removing a nested leaf recorded as a dynamic reference is refused', async () => {
    await expect(
      provider.update(
        'Res',
        'fsap-123',
        'AWS::EFS::AccessPoint',
        { PosixUser: { Gid: '1' }, AccessPointTags: [T('a', '2')] },
        {
          PosixUser: { Uid: '{{resolve:secretsmanager:s:SecretString:u}}', Gid: '1' },
          AccessPointTags: [T('a', '1')],
        }
      )
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('AccessPoint: a sibling of a recorded dynamic reference is still compared, and refused', async () => {
    await expect(
      provider.update(
        'Res',
        'fsap-123',
        'AWS::EFS::AccessPoint',
        {
          RootDirectory: { Path: '/resolved', CreationInfo: { Permissions: '700' } },
          AccessPointTags: [T('a', '2')],
        },
        {
          RootDirectory: {
            Path: '{{resolve:secretsmanager:s:SecretString:p}}',
            CreationInfo: { Permissions: '755' },
          },
          AccessPointTags: [T('a', '1')],
        }
      )
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('AccessPoint: a wrapped AWS failure names the access point', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await expect(
      provider.update(
        'Res',
        'fsap-123',
        'AWS::EFS::AccessPoint',
        { FileSystemId: 'fs-1', AccessPointTags: [T('a', '2')] },
        { FileSystemId: 'fs-1', AccessPointTags: [T('a', '1')] }
      )
    ).rejects.toThrow(/Failed to update EFS AccessPoint Res/);
  });
});
