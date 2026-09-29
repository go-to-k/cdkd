import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateTopicCommand, TagResourceCommand, UntagResourceCommand } from '@aws-sdk/client-sns';

// go-to-k/cdkd#3994: the SNS Topic Tags update untagged EVERY recorded key and
// then re-tagged the desired list, so a malformed DESIRED Tags (a rollback /
// drift --revert desired bag) stripped every tag before the re-tag was
// rejected.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::SNS::Topic';
const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:my-topic';
const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];

function tagCalls(): Array<TagResourceCommand | UntagResourceCommand> {
  return mockSend.mock.calls
    .map((c) => c[0] as unknown)
    .filter(
      (c): c is TagResourceCommand | UntagResourceCommand =>
        c instanceof TagResourceCommand || c instanceof UntagResourceCommand
    );
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

describe('SNSTopicProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: SNSTopicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof CreateTopicCommand ? { TopicArn: TOPIC_ARN } : {}
    );
    provider = new SNSTopicProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update(
          'T',
          TOPIC_ARN,
          TYPE,
          { DisplayName: 'new', Tags: tags },
          { Tags: RECORDED }
        )
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} T`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.create('T', TYPE, { TopicName: 'my-topic', Tags: tags })
      );
      expect(err.message).toContain(`Tags of ${TYPE} T`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('T', TOPIC_ARN, TYPE, { Tags: DESIRED }, { Tags: recorded });
      expect(tagCalls().map((c) => [c.constructor.name, c.input])).toEqual([
        [
          'TagResourceCommand',
          {
            ResourceArn: TOPIC_ARN,
            Tags: [
              { Key: 'keep', Value: 'same' },
              { Key: 'add', Value: '' },
            ],
          },
        ],
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} T is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('T', TOPIC_ARN, TYPE, { Tags: DESIRED }, { Tags: RECORDED });
    expect(tagCalls().map((c) => [c.constructor.name, c.input])).toEqual([
      ['UntagResourceCommand', { ResourceArn: TOPIC_ARN, TagKeys: ['drop'] }],
      ['TagResourceCommand', { ResourceArn: TOPIC_ARN, Tags: [{ Key: 'add', Value: '' }] }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'T',
      TOPIC_ARN,
      TYPE,
      { Tags: [] },
      { Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const untag = tagCalls().filter((c) => c instanceof UntagResourceCommand);
    expect(untag.map((c) => c.input.TagKeys)).toEqual([['keep', 'drop']]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'T',
      TOPIC_ARN,
      TYPE,
      { Tags: [{ Key: 'keep', Value: 'same' }] },
      { Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} T holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags', async () => {
    await provider.create('T', TYPE, { TopicName: 'my-topic', Tags: DESIRED });
    const create = mockSend.mock.calls
      .map((c) => c[0] as unknown)
      .find((c): c is CreateTopicCommand => c instanceof CreateTopicCommand);
    expect(create?.input.Tags).toEqual(DESIRED);
  });
});
