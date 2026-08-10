import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateTopicCommand, SetTopicAttributesCommand } from '@aws-sdk/client-sns';

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
  buildDeliveryStatusAttributeMap,
} from '../../../src/provisioning/providers/sns-topic-provider.js';

const TOPIC_ARN = 'arn:aws:sns:us-east-1:0:topic';
const ROLE_A = 'arn:aws:iam::0:role/feedback-a';
const ROLE_B = 'arn:aws:iam::0:role/feedback-b';

/** Collect the {AttributeName, AttributeValue} pairs of every SetTopicAttributes call. */
function setAttributeCalls(): Array<{ AttributeName: string; AttributeValue: string }> {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof SetTopicAttributesCommand)
    .map((c) => c[0].input as { AttributeName: string; AttributeValue: string });
}

describe('SNSTopicProvider DeliveryStatusLogging removal resets (issue #1160)', () => {
  let provider: SNSTopicProvider;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSend.mockResolvedValue({});
    provider = new SNSTopicProvider();
  });

  // ─── The #1157-pattern trio ──────────────────────────────────────────

  it('removed: whole DeliveryStatusLogging removal resets every previously-set attribute (RoleArns -> "", SampleRate -> "0")', async () => {
    const previous = {
      TopicName: 'topic',
      DeliveryStatusLogging: [
        {
          Protocol: 'lambda',
          SuccessFeedbackRoleArn: ROLE_A,
          SuccessFeedbackSampleRate: 25,
          FailureFeedbackRoleArn: ROLE_A,
        },
      ],
    };
    const desired = { TopicName: 'topic' };

    await provider.update('L', TOPIC_ARN, 'AWS::SNS::Topic', desired, previous);

    const calls = setAttributeCalls();
    expect(calls).toContainEqual({
      TopicArn: TOPIC_ARN,
      AttributeName: 'LambdaSuccessFeedbackRoleArn',
      AttributeValue: '',
    });
    // CFn A/B (2026-08-10): CloudFormation resets the sample rate to 0 on
    // removal; '' is rejected by AWS for this attribute.
    expect(calls).toContainEqual({
      TopicArn: TOPIC_ARN,
      AttributeName: 'LambdaSuccessFeedbackSampleRate',
      AttributeValue: '0',
    });
    expect(calls).toContainEqual({
      TopicArn: TOPIC_ARN,
      AttributeName: 'LambdaFailureFeedbackRoleArn',
      AttributeValue: '',
    });
    expect(calls).toHaveLength(3);
  });

  it('never-present: no DeliveryStatusLogging on either side sends no delivery status attributes', async () => {
    const props = { TopicName: 'topic', DisplayName: 'd' };

    await provider.update('L', TOPIC_ARN, 'AWS::SNS::Topic', props, props);

    expect(setAttributeCalls()).toHaveLength(0);
  });

  it('mixed: kept/changed fields are sent, dropped sub-fields of a KEPT entry are reset', async () => {
    const previous = {
      TopicName: 'topic',
      DeliveryStatusLogging: [
        {
          Protocol: 'lambda',
          SuccessFeedbackRoleArn: ROLE_A,
          SuccessFeedbackSampleRate: 25,
          FailureFeedbackRoleArn: ROLE_A,
        },
      ],
    };
    const desired = {
      TopicName: 'topic',
      DeliveryStatusLogging: [{ Protocol: 'lambda', SuccessFeedbackRoleArn: ROLE_B }],
    };

    await provider.update('L', TOPIC_ARN, 'AWS::SNS::Topic', desired, previous);

    const calls = setAttributeCalls();
    expect(calls).toContainEqual({
      TopicArn: TOPIC_ARN,
      AttributeName: 'LambdaSuccessFeedbackRoleArn',
      AttributeValue: ROLE_B,
    });
    expect(calls).toContainEqual({
      TopicArn: TOPIC_ARN,
      AttributeName: 'LambdaSuccessFeedbackSampleRate',
      AttributeValue: '0',
    });
    expect(calls).toContainEqual({
      TopicArn: TOPIC_ARN,
      AttributeName: 'LambdaFailureFeedbackRoleArn',
      AttributeValue: '',
    });
    expect(calls).toHaveLength(3);
  });

  // ─── Additional removal shapes ───────────────────────────────────────

  it('dropped protocol entry: removing one protocol resets only its attributes, the kept protocol is untouched when unchanged', async () => {
    const previous = {
      TopicName: 'topic',
      DeliveryStatusLogging: [
        { Protocol: 'lambda', SuccessFeedbackRoleArn: ROLE_A },
        { Protocol: 'sqs', FailureFeedbackRoleArn: ROLE_A },
      ],
    };
    const desired = {
      TopicName: 'topic',
      DeliveryStatusLogging: [{ Protocol: 'lambda', SuccessFeedbackRoleArn: ROLE_A }],
    };

    await provider.update('L', TOPIC_ARN, 'AWS::SNS::Topic', desired, previous);

    expect(setAttributeCalls()).toEqual([
      {
        TopicArn: TOPIC_ARN,
        AttributeName: 'SQSFailureFeedbackRoleArn',
        AttributeValue: '',
      },
    ]);
  });

  it('case-only Protocol respelling produces zero calls (attribute maps are identical)', async () => {
    const previous = {
      TopicName: 'topic',
      DeliveryStatusLogging: [{ Protocol: 'lambda', SuccessFeedbackRoleArn: ROLE_A }],
    };
    const desired = {
      TopicName: 'topic',
      DeliveryStatusLogging: [{ Protocol: 'Lambda', SuccessFeedbackRoleArn: ROLE_A }],
    };

    await provider.update('L', TOPIC_ARN, 'AWS::SNS::Topic', desired, previous);

    expect(setAttributeCalls()).toHaveLength(0);
  });

  it('malformed DESIRED container (string) throws a clear error instead of silently resetting', async () => {
    const previous = {
      TopicName: 'topic',
      DeliveryStatusLogging: [{ Protocol: 'lambda', SuccessFeedbackRoleArn: ROLE_A }],
    };
    const desired = { TopicName: 'topic', DeliveryStatusLogging: 'enabled' };

    await expect(
      provider.update('L', TOPIC_ARN, 'AWS::SNS::Topic', desired, previous)
    ).rejects.toThrow(/DeliveryStatusLogging must be an array/);
    expect(setAttributeCalls()).toHaveLength(0);
  });

  it('malformed PREVIOUS side (state record) is tolerated: treated as no previous attributes', async () => {
    const previous = { TopicName: 'topic', DeliveryStatusLogging: 'corrupt-state-value' };
    const desired = { TopicName: 'topic' };

    await provider.update('L', TOPIC_ARN, 'AWS::SNS::Topic', desired, previous);

    expect(setAttributeCalls()).toHaveLength(0);
  });

  it('update() sends a desired SuccessFeedbackSampleRate of 0 as "0" (not truthiness-skipped)', async () => {
    const previous = {
      TopicName: 'topic',
      DeliveryStatusLogging: [{ Protocol: 'lambda', SuccessFeedbackSampleRate: 25 }],
    };
    const desired = {
      TopicName: 'topic',
      DeliveryStatusLogging: [{ Protocol: 'lambda', SuccessFeedbackSampleRate: 0 }],
    };

    await provider.update('L', TOPIC_ARN, 'AWS::SNS::Topic', desired, previous);

    expect(setAttributeCalls()).toEqual([
      {
        TopicArn: TOPIC_ARN,
        AttributeName: 'LambdaSuccessFeedbackSampleRate',
        AttributeValue: '0',
      },
    ]);
  });

  // ─── Create-path regression: SampleRate 0 was truthiness-skipped ─────

  it('create() sends SuccessFeedbackSampleRate 0 as "0" (pre-#1160 truthiness gate dropped it)', async () => {
    // Scoped per-call so a test appended after this one cannot inherit the
    // implementation through vi.clearAllMocks() (which clears calls only).
    mockSend.mockImplementation((cmd) =>
      cmd instanceof CreateTopicCommand
        ? Promise.resolve({ TopicArn: TOPIC_ARN })
        : Promise.resolve({})
    );

    await provider.create('L', 'AWS::SNS::Topic', {
      TopicName: 'topic',
      DeliveryStatusLogging: [
        { Protocol: 'lambda', SuccessFeedbackRoleArn: ROLE_A, SuccessFeedbackSampleRate: 0 },
      ],
    });

    const calls = setAttributeCalls();
    expect(calls).toContainEqual({
      TopicArn: TOPIC_ARN,
      AttributeName: 'LambdaSuccessFeedbackSampleRate',
      AttributeValue: '0',
    });
  });
});

describe('buildDeliveryStatusAttributeMap', () => {
  it('flattens entries into <Protocol><Suffix> attribute names with PascalCase prefixes', () => {
    const map = buildDeliveryStatusAttributeMap(
      [
        {
          Protocol: 'https',
          SuccessFeedbackRoleArn: ROLE_A,
          SuccessFeedbackSampleRate: 50,
          FailureFeedbackRoleArn: ROLE_B,
        },
      ],
      'L',
      'throw'
    );
    expect([...map.entries()]).toEqual([
      ['HTTPSSuccessFeedbackRoleArn', ROLE_A],
      ['HTTPSSuccessFeedbackSampleRate', '50'],
      ['HTTPSFailureFeedbackRoleArn', ROLE_B],
    ]);
  });

  it('skip mode drops unknown-protocol and non-object entries instead of throwing', () => {
    const map = buildDeliveryStatusAttributeMap(
      [
        { Protocol: 'smtp', SuccessFeedbackRoleArn: ROLE_A },
        'garbage',
        { Protocol: 'sqs', SuccessFeedbackRoleArn: ROLE_B },
      ],
      'L',
      'skip'
    );
    expect([...map.entries()]).toEqual([['SQSSuccessFeedbackRoleArn', ROLE_B]]);
  });

  it('throw mode rejects an unknown protocol naming the offending value', () => {
    expect(() =>
      buildDeliveryStatusAttributeMap([{ Protocol: 'smtp' }], 'L', 'throw')
    ).toThrow(/unsupported DeliveryStatusLogging protocol "smtp"/);
  });

  it('absent container (undefined / null) maps to an empty attribute map in both modes', () => {
    expect(buildDeliveryStatusAttributeMap(undefined, 'L', 'throw').size).toBe(0);
    expect(buildDeliveryStatusAttributeMap(null, 'L', 'skip').size).toBe(0);
  });
});
