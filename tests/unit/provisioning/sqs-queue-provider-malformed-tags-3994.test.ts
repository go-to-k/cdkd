import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  TagQueueCommand,
  UntagQueueCommand,
} from '@aws-sdk/client-sqs';

// go-to-k/cdkd#3994: the SQS Tags diff read a malformed side as empty, so a
// malformed DESIRED Tags (a rollback / drift --revert desired bag) untagged
// every recorded key.

const mockSend = vi.fn();
const mockStsSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sqs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: mockStsSend },
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

import { SQSQueueProvider } from '../../../src/provisioning/providers/sqs-queue-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::SQS::Queue';
const URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/q';
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

describe('SQSQueueProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: SQSQueueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof GetQueueAttributesCommand
        ? { Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:123456789012:q' } }
        : cmd instanceof CreateQueueCommand
          ? { QueueUrl: URL }
          : {}
    );
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    provider = new SQSQueueProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('Q', URL, TYPE, { Tags: tags }, { Tags: RECORDED })
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} Q`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('Q', TYPE, { Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} Q`);
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockStsSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('Q', URL, TYPE, { Tags: DESIRED }, { Tags: recorded });
      expect(commands().some((c) => c instanceof UntagQueueCommand)).toBe(false);
      const tag = commands().filter((c) => c instanceof TagQueueCommand) as TagQueueCommand[];
      expect(tag.map((c) => c.input)).toEqual([{ QueueUrl: URL, Tags: { keep: 'same', add: '' } }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
      // The warning names the LOGICAL id, never the ARN / URL / physical name.
      expect(String(warn.mock.calls[0]?.[0])).toContain(`${TYPE} Q is not`);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('Q', URL, TYPE, { Tags: DESIRED }, { Tags: RECORDED });
    const tagCalls = commands().filter(
      (c) => c instanceof TagQueueCommand || c instanceof UntagQueueCommand
    ) as Array<TagQueueCommand | UntagQueueCommand>;
    expect(tagCalls.map((c) => [c.constructor.name, c.input])).toEqual([
      ['UntagQueueCommand', { QueueUrl: URL, TagKeys: ['drop'] }],
      ['TagQueueCommand', { QueueUrl: URL, Tags: { add: '' } }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'Q',
      URL,
      TYPE,
      { Tags: [] },
      { Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const untag = commands().filter((c) => c instanceof UntagQueueCommand) as UntagQueueCommand[];
    expect(untag.map((c) => c.input.TagKeys)).toEqual([['keep', 'drop']]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'Q',
      URL,
      TYPE,
      { Tags: [{ Key: 'keep', Value: 'same' }] },
      { Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} Q holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend, mockStsSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags', async () => {
    await provider.create('Q', TYPE, { QueueName: 'q', Tags: DESIRED });
    const create = commands().find((c) => c instanceof CreateQueueCommand) as CreateQueueCommand;
    expect(create.input.tags).toEqual({ keep: 'same', add: '' });
  });
});
