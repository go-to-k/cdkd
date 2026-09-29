import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateFileSystemCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateFileSystemCommand,
} from '@aws-sdk/client-fsx';

// go-to-k/cdkd#3994: the FSx FileSystem Tags diff read a malformed side as
// empty, so a malformed DESIRED Tags (a rollback / drift --revert desired bag)
// untagged every recorded key.

const mockSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

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
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { FSxFileSystemProvider } from '../../../src/provisioning/providers/fsx-filesystem-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::FSx::FileSystem';
const FS_ID = 'fs-0123456789abcdef0';
const FS_ARN = `arn:aws:fsx:us-east-1:123456789012:file-system/${FS_ID}`;
const BASE = {
  FileSystemType: 'LUSTRE',
  StorageCapacity: 1200,
  SubnetIds: ['subnet-111'],
  LustreConfiguration: { DeploymentType: 'SCRATCH_2' },
};
const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];

function commands(): unknown[] {
  return mockSend.mock.calls.map((c) => c[0]);
}

async function refusal(run: () => Promise<unknown>): Promise<Error> {
  const err = await run().then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  expect(isMarkedNonRetryable(err)).toBe(true);
  const msg = (err as Error).message;
  expect(msg).not.toContain(TAG_FIXTURE.NEEDLE);
  expect(msg).not.toContain('issue3994/tags');
  return err as Error;
}

function newProvider(): FSxFileSystemProvider {
  return new FSxFileSystemProvider({ pollIntervalMs: 0, maxWaitMs: 5000 });
}

describe('FSxFileSystemProvider Tags (go-to-k/cdkd#3994)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof CreateFileSystemCommand
        ? { FileSystem: { FileSystemId: FS_ID, Lifecycle: 'CREATING' } }
        : {
            FileSystems: [
              {
                FileSystemId: FS_ID,
                Lifecycle: 'AVAILABLE',
                ResourceARN: FS_ARN,
                LustreConfiguration: { DeploymentType: 'SCRATCH_2' },
              },
            ],
          }
    );
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        newProvider().update(
          'F',
          FS_ID,
          TYPE,
          { ...BASE, StorageCapacity: 2400, Tags: tags },
          { ...BASE, Tags: RECORDED }
        )
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} F`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => newProvider().create('F', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} F`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await newProvider().update(
        'F',
        FS_ID,
        TYPE,
        { ...BASE, Tags: DESIRED },
        { ...BASE, Tags: recorded }
      );
      expect(commands().some((c) => c instanceof UntagResourceCommand)).toBe(false);
      const tag = commands().filter((c) => c instanceof TagResourceCommand) as TagResourceCommand[];
      expect(tag.map((c) => c.input)).toEqual([
        {
          ResourceARN: FS_ARN,
          Tags: [
            { Key: 'keep', Value: 'same' },
            { Key: 'add', Value: '' },
          ],
        },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
      // The warning names the LOGICAL id, never the ARN / URL / physical name.
      expect(String(warn.mock.calls[0]?.[0])).toContain(`${TYPE} F is not`);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await newProvider().update(
      'F',
      FS_ID,
      TYPE,
      { ...BASE, Tags: DESIRED },
      { ...BASE, Tags: RECORDED }
    );
    expect(commands().some((c) => c instanceof UpdateFileSystemCommand)).toBe(false);
    const tagCalls = commands().filter(
      (c) => c instanceof TagResourceCommand || c instanceof UntagResourceCommand
    ) as Array<TagResourceCommand | UntagResourceCommand>;
    expect(tagCalls.map((c) => [c.constructor.name, c.input])).toEqual([
      ['TagResourceCommand', { ResourceARN: FS_ARN, Tags: [{ Key: 'add', Value: '' }] }],
      ['UntagResourceCommand', { ResourceARN: FS_ARN, TagKeys: ['drop'] }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await newProvider().update(
      'F',
      FS_ID,
      TYPE,
      { ...BASE, Tags: [] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const untag = commands().filter(
      (c) => c instanceof UntagResourceCommand
    ) as UntagResourceCommand[];
    expect(untag.map((c) => c.input.TagKeys)).toEqual([['keep', 'drop']]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await newProvider().update(
      'F',
      FS_ID,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} F holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags', async () => {
    await newProvider().create('F', TYPE, { ...BASE, Tags: DESIRED });
    const create = commands().find(
      (c) => c instanceof CreateFileSystemCommand
    ) as CreateFileSystemCommand;
    expect(create.input.Tags).toEqual(DESIRED);
  });

  it('creates with no Tags field when Tags is absent', async () => {
    await newProvider().create('F', TYPE, { ...BASE });
    const create = commands().find(
      (c) => c instanceof CreateFileSystemCommand
    ) as CreateFileSystemCommand;
    expect(create.input.Tags).toBeUndefined();
  });
});
