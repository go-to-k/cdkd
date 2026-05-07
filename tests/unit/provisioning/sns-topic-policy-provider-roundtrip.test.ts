import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SetTopicAttributesCommand,
  GetTopicAttributesCommand,
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

import { SNSTopicPolicyProvider } from '../../../src/provisioning/providers/sns-topic-policy-provider.js';

const TOPIC_ARN_1 = 'arn:aws:sns:us-east-1:123456789012:topic-a';
const TOPIC_ARN_2 = 'arn:aws:sns:us-east-1:123456789012:topic-b';
const PHYSICAL_ID = `${TOPIC_ARN_1},${TOPIC_ARN_2}`;
const RESOURCE_TYPE = 'AWS::SNS::TopicPolicy';

const SAMPLE_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'AllowPublish',
      Effect: 'Allow',
      Principal: { Service: 'events.amazonaws.com' },
      Action: 'sns:Publish',
      Resource: TOPIC_ARN_1,
    },
  ],
};

describe('SNSTopicPolicyProvider read-update round-trip', () => {
  let provider: SNSTopicPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SNSTopicPolicyProvider();
  });

  it('readCurrentState surfaces Topics + JSON-parsed PolicyDocument', async () => {
    // GetTopicAttributes for first topic in the comma-joined physicalId.
    mockSend.mockResolvedValueOnce({
      Attributes: {
        Policy: JSON.stringify(SAMPLE_POLICY),
        TopicArn: TOPIC_ARN_1,
      },
    });

    const observed = await provider.readCurrentState(PHYSICAL_ID, 'L', RESOURCE_TYPE);

    expect(observed).toBeDefined();
    expect(observed?.Topics).toEqual([TOPIC_ARN_1, TOPIC_ARN_2]);
    expect(observed?.PolicyDocument).toEqual(SAMPLE_POLICY);

    // Verify GetTopicAttributes was called against the FIRST topic only
    // (provider's documented single-topic-fetch optimisation).
    const getCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof GetTopicAttributesCommand
    );
    expect(getCall).toBeDefined();
    expect((getCall![0] as GetTopicAttributesCommand).input.TopicArn).toBe(TOPIC_ARN_1);
  });

  it('round-trip: readCurrentState output survives update() without AWS-invalid inputs', async () => {
    // Mechanical guard for Class 1 / Class 2 / truthy-gate regressions
    // on the read-then-update round-trip path (cdkd drift --revert).
    // See docs/provider-development.md § 3b.

    // 1. readCurrentState
    mockSend.mockResolvedValueOnce({
      Attributes: {
        Policy: JSON.stringify(SAMPLE_POLICY),
        TopicArn: TOPIC_ARN_1,
      },
    });
    const observed = await provider.readCurrentState(PHYSICAL_ID, 'L', RESOURCE_TYPE);
    expect(observed).toBeDefined();

    // 2. Reset and prep update mocks (one SetTopicAttributes per topic).
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});

    // 3. Round-trip: pass observed snapshot back through update().
    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed!, observed!);

    // 4. Assertions on every SetTopicAttributes call.
    const setCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof SetTopicAttributesCommand
    );
    expect(setCalls.length).toBeGreaterThan(0);

    for (const call of setCalls) {
      const input = (call[0] as SetTopicAttributesCommand).input;
      expect(input.AttributeName).toBe('Policy');
      // Class 2 guard: never ship the empty-object placeholder shape
      // back to AWS — SetTopicAttributes(Policy='{}') is rejected as
      // "Policy statement must contain Resources" by SNS.
      expect(input.AttributeValue).not.toBe('{}');
      expect(input.AttributeValue).not.toBe('');

      // The serialised body must round-trip JSON-equal to the snapshot.
      // (cdkd's update() always JSON.stringify's an object PolicyDocument.)
      expect(JSON.parse(input.AttributeValue!)).toEqual(SAMPLE_POLICY);
    }

    // Both topics in physicalId received SetTopicAttributes — provider
    // mirrors the policy onto every listed topic.
    const targetedArns = setCalls.map(
      (c) => (c[0] as SetTopicAttributesCommand).input.TopicArn
    );
    expect(targetedArns.sort()).toEqual([TOPIC_ARN_1, TOPIC_ARN_2].sort());
  });

  it('update() accepts a string PolicyDocument (already-serialised) without re-stringifying', async () => {
    // Truthy-gate-adjacent guard: the provider passes the value to
    // setTopicPolicy verbatim when it's already a string. A regression
    // that double-stringified ('"{...}"') would silently push a
    // string-literal-shaped policy AWS treats as "invalid policy".
    mockSend.mockResolvedValue({});

    const policyAsString = JSON.stringify(SAMPLE_POLICY);
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { Topics: [TOPIC_ARN_1], PolicyDocument: policyAsString },
      { Topics: [TOPIC_ARN_1], PolicyDocument: '{}' }
    );

    const setCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetTopicAttributesCommand
    );
    expect(setCall).toBeDefined();
    const input = (setCall![0] as SetTopicAttributesCommand).input;
    expect(input.AttributeValue).toBe(policyAsString);
    // Not double-stringified.
    expect(input.AttributeValue).not.toBe(JSON.stringify(policyAsString));
  });
});
