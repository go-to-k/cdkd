import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeStreamConsumerCommand,
  RegisterStreamConsumerCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-kinesis';

// go-to-k/cdkd#3994: the Kinesis StreamConsumer Tags diff read a malformed
// side as empty, so a malformed DESIRED Tags (a rollback / drift --revert
// desired bag) untagged every recorded key.

const mockSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-kinesis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-kinesis')>();
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

import { KinesisStreamConsumerProvider } from '../../../src/provisioning/providers/kinesis-streamconsumer-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::Kinesis::StreamConsumer';
const STREAM_ARN = 'arn:aws:kinesis:us-east-1:123456789012:stream/mystream';
const CONSUMER_NAME = 'myconsumer';
const CONSUMER_ARN = `${STREAM_ARN}/consumer/${CONSUMER_NAME}:1700000000`;
const BASE = { ConsumerName: CONSUMER_NAME, StreamARN: STREAM_ARN };
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

describe('KinesisStreamConsumerProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: KinesisStreamConsumerProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof RegisterStreamConsumerCommand) {
        return {
          Consumer: {
            ConsumerName: CONSUMER_NAME,
            ConsumerARN: CONSUMER_ARN,
            ConsumerStatus: 'CREATING',
          },
        };
      }
      if (cmd instanceof DescribeStreamConsumerCommand) {
        return {
          ConsumerDescription: {
            ConsumerName: CONSUMER_NAME,
            ConsumerARN: CONSUMER_ARN,
            ConsumerStatus: 'ACTIVE',
            StreamARN: STREAM_ARN,
          },
        };
      }
      return {};
    });
    provider = new KinesisStreamConsumerProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('C', CONSUMER_ARN, TYPE, { ...BASE, Tags: tags }, { ...BASE, Tags: RECORDED })
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} C`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('C', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} C`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('C', CONSUMER_ARN, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: recorded });
      expect(commands().some((c) => c instanceof UntagResourceCommand)).toBe(false);
      const tag = commands().filter((c) => c instanceof TagResourceCommand) as TagResourceCommand[];
      expect(tag.map((c) => c.input)).toEqual([
        { ResourceARN: CONSUMER_ARN, Tags: { keep: 'same', add: '' } },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
      // The warning names the LOGICAL id, never the ARN / URL / physical name.
      expect(String(warn.mock.calls[0]?.[0])).toContain(`${TYPE} C is not`);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('C', CONSUMER_ARN, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    const tagCalls = commands().filter(
      (c) => c instanceof TagResourceCommand || c instanceof UntagResourceCommand
    ) as Array<TagResourceCommand | UntagResourceCommand>;
    expect(tagCalls.map((c) => [c.constructor.name, c.input])).toEqual([
      ['UntagResourceCommand', { ResourceARN: CONSUMER_ARN, TagKeys: ['drop'] }],
      ['TagResourceCommand', { ResourceARN: CONSUMER_ARN, Tags: { add: '' } }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'C',
      CONSUMER_ARN,
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
    await provider.update(
      'C',
      CONSUMER_ARN,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} C holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags', async () => {
    await provider.create('C', TYPE, { ...BASE, Tags: DESIRED });
    const create = commands().find(
      (c) => c instanceof RegisterStreamConsumerCommand
    ) as RegisterStreamConsumerCommand;
    expect(create.input.Tags).toEqual({ keep: 'same', add: '' });
  });

  it('creates with no Tags field when Tags is absent', async () => {
    await provider.create('C', TYPE, { ...BASE });
    const create = commands().find(
      (c) => c instanceof RegisterStreamConsumerCommand
    ) as RegisterStreamConsumerCommand;
    expect(create.input.Tags).toBeUndefined();
  });
});
