import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
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

  it('create() normalizes lowercase Protocol (CDK template emits "lambda") to PascalCase attribute prefix', async () => {
    // Regression guard for the lowercase-Protocol bug. CDK templates
    // emit `Protocol: 'lambda'` (and `'sqs'` / `'http'` / ...). The
    // pre-fix code did naive `${protocol}SuccessFeedbackRoleArn`
    // concatenation and produced `lambdaSuccessFeedbackRoleArn` which
    // AWS rejects. After the fix every per-protocol attribute name
    // must be PascalCase-prefixed (`LambdaSuccessFeedbackRoleArn`).
    mockSend
      // CreateTopic
      .mockResolvedValueOnce({ TopicArn: STANDARD_TOPIC_ARN })
      // The three SetTopicAttributes calls for Lambda success/sample/failure
      .mockResolvedValue({});

    const provider = new SNSTopicProvider();
    await provider.create('L', 'AWS::SNS::Topic', {
      TopicName: 'standard-topic',
      DeliveryStatusLogging: [
        {
          Protocol: 'lambda',
          SuccessFeedbackRoleArn: 'arn:aws:iam::1:role/lambda-success',
          SuccessFeedbackSampleRate: '100',
          FailureFeedbackRoleArn: 'arn:aws:iam::1:role/lambda-failure',
        },
      ],
    });

    const setAttrCalls = mockSend.mock.calls
      .filter((c) => c[0] instanceof SetTopicAttributesCommand)
      .map((c) => (c[0] as SetTopicAttributesCommand).input.AttributeName);

    // Critical: every attribute name MUST be PascalCase-prefixed.
    expect(setAttrCalls).toEqual([
      'LambdaSuccessFeedbackRoleArn',
      'LambdaSuccessFeedbackSampleRate',
      'LambdaFailureFeedbackRoleArn',
    ]);
    // None of the lowercase forms are sent.
    expect(setAttrCalls).not.toContain('lambdaSuccessFeedbackRoleArn');
  });

  it('create() normalizes mixed-case protocols (sqs / https / http) to canonical PascalCase prefixes', async () => {
    mockSend.mockResolvedValueOnce({ TopicArn: STANDARD_TOPIC_ARN }).mockResolvedValue({});

    const provider = new SNSTopicProvider();
    await provider.create('L', 'AWS::SNS::Topic', {
      TopicName: 'standard-topic',
      DeliveryStatusLogging: [
        // SQS / HTTP / HTTPS are full uppercase; firehose / application are PascalCase.
        { Protocol: 'sqs', SuccessFeedbackRoleArn: 'arn:aws:iam::1:role/sqs' },
        { Protocol: 'https', FailureFeedbackRoleArn: 'arn:aws:iam::1:role/https' },
        { Protocol: 'http', SuccessFeedbackSampleRate: '50' },
        { Protocol: 'firehose', SuccessFeedbackRoleArn: 'arn:aws:iam::1:role/firehose' },
        { Protocol: 'application', FailureFeedbackRoleArn: 'arn:aws:iam::1:role/app' },
      ],
    });

    const setAttrCalls = mockSend.mock.calls
      .filter((c) => c[0] instanceof SetTopicAttributesCommand)
      .map((c) => (c[0] as SetTopicAttributesCommand).input.AttributeName);

    expect(setAttrCalls).toEqual([
      'SQSSuccessFeedbackRoleArn',
      'HTTPSFailureFeedbackRoleArn',
      'HTTPSuccessFeedbackSampleRate',
      'FirehoseSuccessFeedbackRoleArn',
      'ApplicationFailureFeedbackRoleArn',
    ]);
  });

  it('create() rejects unknown DeliveryStatusLogging Protocol with a clear error', async () => {
    // CreateTopic must succeed for both invocations so the rejection
    // surfaces from the per-protocol normalization, not from a missing
    // ARN. mockResolvedValue (not Once) keeps every CreateTopic call
    // returning the ARN.
    mockSend.mockResolvedValue({ TopicArn: STANDARD_TOPIC_ARN });

    const provider = new SNSTopicProvider();
    await expect(
      provider.create('MyTopic', 'AWS::SNS::Topic', {
        TopicName: 'standard-topic',
        DeliveryStatusLogging: [
          {
            Protocol: 'kinesis', // not a supported SNS DSL protocol
            SuccessFeedbackRoleArn: 'arn:aws:iam::1:role/x',
          },
        ],
      })
    ).rejects.toThrow(/MyTopic/);
    await expect(
      provider.create('MyTopic', 'AWS::SNS::Topic', {
        TopicName: 'standard-topic',
        DeliveryStatusLogging: [
          { Protocol: 'kinesis', SuccessFeedbackRoleArn: 'arn:aws:iam::1:role/x' },
        ],
      })
    ).rejects.toThrow(/kinesis/);

    // Sanity: CreateTopic was attempted but no per-protocol Set call ever fired.
    const createCalls = mockSend.mock.calls.filter((c) => c[0] instanceof CreateTopicCommand);
    expect(createCalls.length).toBeGreaterThan(0);
    const setAttrCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof SetTopicAttributesCommand
    );
    expect(setAttrCalls).toHaveLength(0);
  });

  it('update() normalizes lowercase Protocol on a DeliveryStatusLogging diff', async () => {
    // Regression guard for the same bug on the update path. update()
    // is reached on a DSL diff; the diff fires when the new value
    // differs from the previous, so we deliberately differ them.
    mockSend.mockResolvedValue({});

    const provider = new SNSTopicProvider();
    await provider.update(
      'L',
      STANDARD_TOPIC_ARN,
      'AWS::SNS::Topic',
      {
        TopicName: 'standard-topic',
        DeliveryStatusLogging: [
          {
            Protocol: 'lambda',
            SuccessFeedbackRoleArn: 'arn:aws:iam::1:role/new',
          },
        ],
      },
      // Previous state with a different DSL — forces the diff branch.
      { TopicName: 'standard-topic' }
    );

    const setAttrCalls = mockSend.mock.calls
      .filter((c) => c[0] instanceof SetTopicAttributesCommand)
      .map((c) => (c[0] as SetTopicAttributesCommand).input.AttributeName);

    expect(setAttrCalls).toContain('LambdaSuccessFeedbackRoleArn');
    expect(setAttrCalls).not.toContain('lambdaSuccessFeedbackRoleArn');
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

// Auto-mode import resolves a topic from an explicit `--resource` override
// (an ARN, verified via GetTopicAttributes) or from the template's
// `Properties.TopicName`, matched against each topic's ARN tail via a
// paginated ListTopics walk. The `aws:cdk:path` tag match that used to ride
// the same walk is gone (issue #1134): AWS rejects `aws:`-prefixed tag writes,
// so that tag never exists on a real resource and the walk could not match.
describe('SNSTopicProvider import (name-based lookup)', () => {
  const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:my-topic';

  beforeEach(() => {
    vi.clearAllMocks();
    // Drop once-queued responses leaked by earlier tests - clearAllMocks()
    // clears calls but NOT unconsumed mockResolvedValueOnce entries.
    mockSend.mockReset();
  });

  const importInput = (
    overrides: Partial<{
      cdkPath: string;
      knownPhysicalId: string;
      properties: Record<string, unknown>;
    }> = {}
  ) => ({
    logicalId: 'MyTopic',
    resourceType: 'AWS::SNS::Topic',
    cdkPath: 'MyStack/MyTopic/Resource',
    stackName: 'MyStack',
    region: 'us-east-1',
    properties: {},
    ...overrides,
  });

  it('resolves an explicit --resource override via GetTopicAttributes', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { TopicArn: TOPIC_ARN } });

    const provider = new SNSTopicProvider();
    const result = await provider.import(importInput({ knownPhysicalId: TOPIC_ARN }));

    expect(result).toEqual({ physicalId: TOPIC_ARN, attributes: {} });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('GetTopicAttributesCommand');
  });

  it('matches Properties.TopicName by ARN tail via ListTopics', async () => {
    mockSend.mockResolvedValueOnce({
      Topics: [
        { TopicArn: 'arn:aws:sns:us-east-1:123456789012:other-topic' },
        { TopicArn: TOPIC_ARN },
      ],
    });

    const provider = new SNSTopicProvider();
    const result = await provider.import(
      importInput({ properties: { TopicName: 'my-topic' } })
    );

    expect(result).toEqual({ physicalId: TOPIC_ARN, attributes: {} });
    // ListTopics only — no per-candidate tag read.
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('ListTopicsCommand');
  });

  it('folds the NextToken across pages until the ARN tail matches', async () => {
    mockSend
      .mockResolvedValueOnce({
        Topics: [{ TopicArn: 'arn:aws:sns:us-east-1:123456789012:other-topic' }],
        NextToken: 'page-2',
      })
      .mockResolvedValueOnce({ Topics: [{ TopicArn: TOPIC_ARN }] });

    const provider = new SNSTopicProvider();
    const result = await provider.import(
      importInput({ properties: { TopicName: 'my-topic' } })
    );

    expect(result).toEqual({ physicalId: TOPIC_ARN, attributes: {} });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0][0].input.NextToken).toBeUndefined();
    expect(mockSend.mock.calls[1][0].input.NextToken).toBe('page-2');
  });

  it('returns null when no topic name matches', async () => {
    mockSend.mockResolvedValueOnce({
      Topics: [{ TopicArn: 'arn:aws:sns:us-east-1:123456789012:other-topic' }],
    });

    const provider = new SNSTopicProvider();
    const result = await provider.import(importInput({ properties: { TopicName: 'my-topic' } }));

    expect(result).toBeNull();
  });

  it('returns null without any AWS call when no override and no TopicName', async () => {
    const provider = new SNSTopicProvider();
    const result = await provider.import(importInput({ cdkPath: '' }));

    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
