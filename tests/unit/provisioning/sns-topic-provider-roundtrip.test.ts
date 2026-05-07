import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const STANDARD_TOPIC_ARN = 'arn:aws:sns:us-east-1:0:standard-topic';
const FIFO_TOPIC_ARN = 'arn:aws:sns:us-east-1:0:fifo-topic.fifo';

describe('SNSTopicProvider read-update round-trip', () => {
  let provider: SNSTopicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SNSTopicProvider();
  });

  it('Class 1 — standard topic (FifoTopic=false) does not send FIFO-only attrs to AWS on round-trip', async () => {
    // Mechanical guard for Class 1 placeholder regression on type-
    // discriminator-dependent fields. See docs/provider-development.md
    // § 3b "Read-update round-trip test".
    //
    // SNS FifoThroughputScope is FIFO-only. On a STANDARD topic
    // readCurrentState must NOT emit it as a placeholder (or, if it
    // does, the round-trip update() must not push it). Either way the
    // SetTopicAttributes call for FifoThroughputScope must NEVER
    // happen on a standard topic — AWS rejects with
    // "FifoThroughputScope is only valid on FIFO topics".

    // Build observed snapshot directly (matches what readCurrentState
    // would produce for a standard topic — readCurrentState is
    // exercised by its own dedicated test file).
    const observed = {
      TopicName: 'standard-topic',
      DisplayName: '',
      KmsMasterKeyId: '',
      ContentBasedDeduplication: false,
      TracingConfig: '',
      SignatureVersion: '',
      Tags: [] as Array<{ Key: string; Value: string }>,
      // FifoTopic absent on standard topic. FifoThroughputScope
      // intentionally NOT in the snapshot — the Class 1 guard kicks in
      // at readCurrentState (not emitted on standard topic).
    };

    // Round-trip
    await provider.update('L', STANDARD_TOPIC_ARN, 'AWS::SNS::Topic', observed, observed);

    // Assert: no SetTopicAttributes call ever set FifoThroughputScope
    // (or any other FIFO-only attribute). All attrs in the snapshot
    // are equal between new and old, so the diff-based update should
    // produce zero SetTopicAttributes calls.
    const setAttrCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof SetTopicAttributesCommand
    );
    for (const call of setAttrCalls) {
      const input = call[0].input as { AttributeName: string };
      expect(input.AttributeName).not.toBe('FifoThroughputScope');
    }
  });

  it('round-trip on no-drift snapshot is a logical no-op (zero SetTopicAttributes calls)', async () => {
    // Stronger assertion for diff-based providers: state == AWS
    // implies update() must make no AWS-side mutations. PR #161
    // verified this by switching drift --revert to "AWS-current base
    // + drifted overlay" — but the round-trip test is the structural
    // guard for the next time someone changes update()'s diff logic.
    const observed = {
      TopicName: 'standard-topic',
      DisplayName: 'my-display',
      KmsMasterKeyId: 'alias/aws/sns',
      ContentBasedDeduplication: false,
      TracingConfig: 'PassThrough',
      SignatureVersion: '1',
      Tags: [{ Key: 'k', Value: 'v' }],
    };

    await provider.update('L', STANDARD_TOPIC_ARN, 'AWS::SNS::Topic', observed, observed);

    const setAttrCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof SetTopicAttributesCommand
    );
    expect(setAttrCalls).toHaveLength(0);
  });

  it('FIFO topic round-trip emits FIFO-only attrs without AWS rejection', async () => {
    // The complement of the standard-topic test: a FIFO topic
    // legitimately has FifoThroughputScope, and round-tripping should
    // NOT produce a rejection-shape input.
    const observed = {
      TopicName: 'fifo-topic.fifo',
      FifoTopic: true,
      DisplayName: '',
      KmsMasterKeyId: '',
      ContentBasedDeduplication: true,
      TracingConfig: '',
      SignatureVersion: '',
      FifoThroughputScope: 'Topic',
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    await provider.update('L', FIFO_TOPIC_ARN, 'AWS::SNS::Topic', observed, observed);

    // No drift → no SetTopicAttributes calls.
    const setAttrCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof SetTopicAttributesCommand
    );
    expect(setAttrCalls).toHaveLength(0);
  });
});
