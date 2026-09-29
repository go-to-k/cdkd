import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AddTagsToStreamCommand,
  CreateStreamCommand,
  DescribeStreamCommand,
  RemoveTagsFromStreamCommand,
} from '@aws-sdk/client-kinesis';

// go-to-k/cdkd#3994: the Kinesis stream Tags diff read a malformed side as
// empty, so a malformed DESIRED Tags (a rollback / drift --revert desired bag)
// untagged every recorded key.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-kinesis', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-kinesis')>('@aws-sdk/client-kinesis');
  return {
    ...actual,
    KinesisClient: vi.fn().mockImplementation(() => ({
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

import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::Kinesis::Stream';
const STREAM = 'mystream';
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

describe('KinesisStreamProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: KinesisStreamProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof DescribeStreamCommand
        ? {
            StreamDescription: {
              StreamName: STREAM,
              StreamStatus: 'ACTIVE',
              StreamARN: `arn:aws:kinesis:us-east-1:123456789012:stream/${STREAM}`,
            },
          }
        : {}
    );
    provider = new KinesisStreamProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update(
          'S',
          STREAM,
          TYPE,
          { RetentionPeriodHours: 48, Tags: tags },
          { Tags: RECORDED }
        )
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} S`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('S', TYPE, { Name: STREAM, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} S`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('S', STREAM, TYPE, { Tags: DESIRED }, { Tags: recorded });
      expect(commands().some((c) => c instanceof RemoveTagsFromStreamCommand)).toBe(false);
      const tag = commands().filter(
        (c) => c instanceof AddTagsToStreamCommand
      ) as AddTagsToStreamCommand[];
      expect(tag.map((c) => c.input)).toEqual([
        { StreamName: STREAM, Tags: { keep: 'same', add: '' } },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
      // The warning names the LOGICAL id, never the ARN / URL / physical name.
      expect(String(warn.mock.calls[0]?.[0])).toContain(`${TYPE} S is not`);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('S', STREAM, TYPE, { Tags: DESIRED }, { Tags: RECORDED });
    const tagCalls = commands().filter(
      (c) => c instanceof AddTagsToStreamCommand || c instanceof RemoveTagsFromStreamCommand
    ) as Array<AddTagsToStreamCommand | RemoveTagsFromStreamCommand>;
    expect(tagCalls.map((c) => [c.constructor.name, c.input])).toEqual([
      ['RemoveTagsFromStreamCommand', { StreamName: STREAM, TagKeys: ['drop'] }],
      ['AddTagsToStreamCommand', { StreamName: STREAM, Tags: { add: '' } }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'S',
      STREAM,
      TYPE,
      { Tags: [] },
      { Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const untag = commands().filter(
      (c) => c instanceof RemoveTagsFromStreamCommand
    ) as RemoveTagsFromStreamCommand[];
    expect(untag.map((c) => c.input.TagKeys)).toEqual([['keep', 'drop']]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'S',
      STREAM,
      TYPE,
      { Tags: [{ Key: 'keep', Value: 'same' }] },
      { Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} S holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags', async () => {
    await provider.create('S', TYPE, { Name: STREAM, Tags: DESIRED });
    expect(commands().some((c) => c instanceof CreateStreamCommand)).toBe(true);
    const tag = commands().filter(
      (c) => c instanceof AddTagsToStreamCommand
    ) as AddTagsToStreamCommand[];
    expect(tag.map((c) => c.input)).toEqual([
      { StreamName: STREAM, Tags: { keep: 'same', add: '' } },
    ]);
  });
});
