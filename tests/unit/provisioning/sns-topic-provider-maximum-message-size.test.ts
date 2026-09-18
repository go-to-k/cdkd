import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTopicCommand,
  GetTopicAttributesCommand,
  ListTagsForResourceCommand,
  SetTopicAttributesCommand,
} from '@aws-sdk/client-sns';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import {
  SNSTopicProvider,
  SNS_MAXIMUM_MESSAGE_SIZE_DEFAULT,
} from '../../../src/provisioning/providers/sns-topic-provider.js';

const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:my-topic';

/**
 * Issue #3413 — `MaximumMessageSize`, published by AWS in the 2026-09-18
 * schema refresh (PR #3402), was a silent drop on the type that carries the
 * only `'sdk-coverage'` sticky exemption, which is admitted on the premise
 * that its silentDrop map is EMPTY. Wiring the member restores the premise.
 *
 * Every wire fact below is measured (us-east-1, 2026-09-18): `CreateTopic`
 * accepts the attribute inline; `SetTopicAttributes` accepts 1024..1048576 and
 * REFUSES `''`; a fresh topic reports no value; once set the value persists.
 */
describe('SNSTopicProvider MaximumMessageSize (issue #3413)', () => {
  let provider: SNSTopicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SNSTopicProvider();
  });

  const setAttrCalls = () =>
    mockSend.mock.calls
      .filter((c) => c[0] instanceof SetTopicAttributesCommand)
      .map((c) => c[0].input as { AttributeName: string; AttributeValue: string });

  it('create() sends MaximumMessageSize inline on CreateTopic, stringified', async () => {
    mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN }); // CreateTopic

    await provider.create('L', 'AWS::SNS::Topic', {
      TopicName: 'my-topic',
      MaximumMessageSize: 1048576,
    });

    const create = mockSend.mock.calls[0]?.[0];
    expect(create).toBeInstanceOf(CreateTopicCommand);
    expect((create.input as { Attributes?: Record<string, string> }).Attributes).toEqual({
      MaximumMessageSize: '1048576',
    });
    expect(setAttrCalls()).toEqual([]);
  });

  it('create() omits the attribute when the template does not declare it (AWS default applies)', async () => {
    mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN }); // CreateTopic

    await provider.create('L', 'AWS::SNS::Topic', { TopicName: 'my-topic' });

    const create = mockSend.mock.calls[0]?.[0];
    expect((create.input as { Attributes?: Record<string, string> }).Attributes).toBeUndefined();
  });

  it('update() sends the changed value through SetTopicAttributes', async () => {
    await provider.update(
      'L',
      TOPIC_ARN,
      'AWS::SNS::Topic',
      { TopicName: 'my-topic', MaximumMessageSize: 524288 },
      { TopicName: 'my-topic', MaximumMessageSize: 1048576 }
    );

    expect(setAttrCalls()).toEqual([
      { TopicArn: TOPIC_ARN, AttributeName: 'MaximumMessageSize', AttributeValue: '524288' },
    ]);
  });

  it('update() resets a REMOVED member to the service default, never to the empty string SNS refuses', async () => {
    await provider.update(
      'L',
      TOPIC_ARN,
      'AWS::SNS::Topic',
      { TopicName: 'my-topic' },
      { TopicName: 'my-topic', MaximumMessageSize: 1048576 }
    );

    const calls = setAttrCalls();
    expect(calls).toEqual([
      {
        TopicArn: TOPIC_ARN,
        AttributeName: 'MaximumMessageSize',
        AttributeValue: SNS_MAXIMUM_MESSAGE_SIZE_DEFAULT,
      },
    ]);
    expect(SNS_MAXIMUM_MESSAGE_SIZE_DEFAULT).toBe('262144');
    // The other members keep their `''` reset — the default arm is unchanged.
    for (const c of calls) expect(c.AttributeValue).not.toBe('');
  });

  it('update() still clears a removed STRING member with the empty string (the default arm is untouched)', async () => {
    await provider.update(
      'L',
      TOPIC_ARN,
      'AWS::SNS::Topic',
      { TopicName: 'my-topic' },
      { TopicName: 'my-topic', DisplayName: 'gone' }
    );

    expect(setAttrCalls()).toEqual([
      { TopicArn: TOPIC_ARN, AttributeName: 'DisplayName', AttributeValue: '' },
    ]);
  });

  it('update() issues no call when the member is unchanged', async () => {
    const same = { TopicName: 'my-topic', MaximumMessageSize: 1048576 };
    await provider.update('L', TOPIC_ARN, 'AWS::SNS::Topic', same, same);
    expect(setAttrCalls()).toEqual([]);
  });

  const readWith = async (
    attrs: Record<string, string>,
    recorded?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetTopicAttributesCommand) {
        return { Attributes: { TopicArn: TOPIC_ARN, ...attrs } };
      }
      if (cmd instanceof ListTagsForResourceCommand) {
        return { Tags: [] };
      }
      throw new Error(`unexpected ${String((cmd as { constructor: { name: string } }).constructor.name)}`);
    });
    return provider.readCurrentState(TOPIC_ARN, 'L', 'AWS::SNS::Topic', recorded);
  };

  it('readCurrentState() surfaces the live value as a NUMBER when the record declares the member', async () => {
    const state = await readWith({ MaximumMessageSize: '1048576' }, { MaximumMessageSize: 1048576 });
    expect(state?.['MaximumMessageSize']).toBe(1048576);
  });

  it('readCurrentState() surfaces a console-side change even to the DEFAULT when the record declares the member', async () => {
    // A drift --revert must be able to push the declared 1048576 back, so the
    // live 262144 has to be visible against a record that says otherwise.
    const state = await readWith(
      { MaximumMessageSize: SNS_MAXIMUM_MESSAGE_SIZE_DEFAULT },
      { MaximumMessageSize: 1048576 }
    );
    expect(state?.['MaximumMessageSize']).toBe(262144);
  });

  it('readCurrentState() omits the key when the record has none and the live value is the default (a reset, not drift)', async () => {
    // The shape a template removal leaves behind: the reset made the attribute
    // APPEAR at 262144 on a topic whose record no longer carries the member.
    // Emitting it would be permanent phantom drift against every such topic.
    const state = await readWith({ MaximumMessageSize: SNS_MAXIMUM_MESSAGE_SIZE_DEFAULT }, {});
    expect(state).not.toHaveProperty('MaximumMessageSize');
  });

  it('readCurrentState() omits the key when AWS reports no value (a fresh topic)', async () => {
    const state = await readWith({}, { MaximumMessageSize: 1048576 });
    expect(state).not.toHaveProperty('MaximumMessageSize');
  });

  it('readCurrentState() surfaces a console-side ADD of a non-default value against a record with no key', async () => {
    const state = await readWith({ MaximumMessageSize: '524288' }, {});
    expect(state?.['MaximumMessageSize']).toBe(524288);
  });
});
