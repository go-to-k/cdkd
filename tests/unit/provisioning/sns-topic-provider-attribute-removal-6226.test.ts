import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { SetTopicAttributesCommand } from '@aws-sdk/client-sns';

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

import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:my-topic';

/**
 * Issue #6226 — `SetTopicAttributes` refuses `''` for `TracingConfig` and
 * `ContentBasedDeduplication` (measured us-east-1 2026-11-13), so a template
 * REMOVAL must send the value CloudFormation resets them to on the same
 * removal (live A/B): `PassThrough` and `false`.
 */
describe('SNSTopicProvider enum / boolean attribute removal (issue #6226)', () => {
  let provider: SNSTopicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new SNSTopicProvider();
  });

  const setAttrCalls = () =>
    mockSend.mock.calls
      .filter((c) => c[0] instanceof SetTopicAttributesCommand)
      .map((c) => {
        const input = c[0].input as { AttributeName: string; AttributeValue: string };
        return { AttributeName: input.AttributeName, AttributeValue: input.AttributeValue };
      });

  it('a removed TracingConfig is reset to PassThrough, never to the empty string SNS refuses', async () => {
    await provider.update(
      'L',
      TOPIC_ARN,
      'AWS::SNS::Topic',
      { TopicName: 'my-topic' },
      { TopicName: 'my-topic', TracingConfig: 'Active' }
    );

    expect(setAttrCalls()).toEqual([
      { AttributeName: 'TracingConfig', AttributeValue: 'PassThrough' },
    ]);
  });

  it('a removed ContentBasedDeduplication is reset to false, never to the empty string SNS refuses', async () => {
    await provider.update(
      'L',
      TOPIC_ARN,
      'AWS::SNS::Topic',
      { TopicName: 'my-topic.fifo', FifoTopic: true },
      { TopicName: 'my-topic.fifo', FifoTopic: true, ContentBasedDeduplication: true }
    );

    expect(setAttrCalls()).toEqual([
      { AttributeName: 'ContentBasedDeduplication', AttributeValue: 'false' },
    ]);
  });

  it('a removed ArchivePolicy is reset to {}, never to the empty string SNS refuses', async () => {
    await provider.update(
      'L',
      TOPIC_ARN,
      'AWS::SNS::Topic',
      { TopicName: 'my-topic.fifo', FifoTopic: true },
      { TopicName: 'my-topic.fifo', FifoTopic: true, ArchivePolicy: { MessageRetentionPeriod: 7 } }
    );

    expect(setAttrCalls()).toEqual([{ AttributeName: 'ArchivePolicy', AttributeValue: '{}' }]);
  });

  it('a desired empty TracingConfig (a drift --revert readback of an unset topic) is sent as PassThrough', async () => {
    await provider.update(
      'L',
      TOPIC_ARN,
      'AWS::SNS::Topic',
      { TopicName: 'my-topic', TracingConfig: '' },
      { TopicName: 'my-topic', TracingConfig: 'Active' }
    );

    expect(setAttrCalls()).toEqual([
      { AttributeName: 'TracingConfig', AttributeValue: 'PassThrough' },
    ]);
  });

  it('a removed string member without a reset value still clears with the empty string', async () => {
    await provider.update(
      'L',
      TOPIC_ARN,
      'AWS::SNS::Topic',
      { TopicName: 'my-topic', DisplayName: '' },
      { TopicName: 'my-topic', DisplayName: 'shown' }
    );

    expect(setAttrCalls()).toEqual([{ AttributeName: 'DisplayName', AttributeValue: '' }]);
  });

  it('declared values are still sent verbatim', async () => {
    await provider.update(
      'L',
      TOPIC_ARN,
      'AWS::SNS::Topic',
      { TopicName: 'my-topic.fifo', TracingConfig: 'Active', ContentBasedDeduplication: true },
      { TopicName: 'my-topic.fifo', TracingConfig: 'PassThrough', ContentBasedDeduplication: false }
    );

    expect(setAttrCalls()).toEqual([
      { AttributeName: 'ContentBasedDeduplication', AttributeValue: 'true' },
      { AttributeName: 'TracingConfig', AttributeValue: 'Active' },
    ]);
  });

  // A topic that never set TracingConfig reads back as '' (readCurrentState),
  // while a removal or a `drift --revert` leaves it at PassThrough. The drift
  // fold must make the two equal in BOTH orders, and keep a real change.
  const tracingDrift = (baseline: string, live: string) =>
    calculateResourceDrift(
      provider.canonicalizeDriftProperties('AWS::SNS::Topic', { TracingConfig: baseline }),
      provider.canonicalizeDriftProperties('AWS::SNS::Topic', { TracingConfig: live })
    );

  it('drift: an unset baseline against a PassThrough reset is NOT drift, in either order', () => {
    expect(tracingDrift('', 'PassThrough')).toEqual([]);
    expect(tracingDrift('PassThrough', '')).toEqual([]);
  });

  it('drift: Active against an unset or PassThrough side IS drift', () => {
    expect(tracingDrift('', 'Active')).not.toEqual([]);
    expect(tracingDrift('PassThrough', 'Active')).not.toEqual([]);
  });

  it('drift fold returns the bag by identity when TracingConfig is not PassThrough', () => {
    const bag = { TracingConfig: 'Active', DisplayName: 'd' };
    expect(provider.canonicalizeDriftProperties('AWS::SNS::Topic', bag)).toBe(bag);
  });
});
