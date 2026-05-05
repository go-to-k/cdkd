import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetTopicAttributesCommand } from '@aws-sdk/client-sns';

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

describe('SNSTopicPolicyProvider.readCurrentState', () => {
  let provider: SNSTopicPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SNSTopicPolicyProvider();
  });

  it('returns Topics + JSON-parsed PolicyDocument (happy path)', async () => {
    const policy = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: '*', Action: 'sns:Publish' }],
    };
    mockSend.mockResolvedValueOnce({ Attributes: { Policy: JSON.stringify(policy) } });

    const arn1 = 'arn:aws:sns:us-east-1:123:topic-a';
    const arn2 = 'arn:aws:sns:us-east-1:123:topic-b';
    const physicalId = `${arn1},${arn2}`;
    const result = await provider.readCurrentState(
      physicalId,
      'Logical',
      'AWS::SNS::TopicPolicy'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetTopicAttributesCommand);
    expect(result).toEqual({
      Topics: [arn1, arn2],
      PolicyDocument: policy,
    });
  });

  it('returns undefined when first topic does not exist', async () => {
    const err = new Error('not found');
    (err as { name?: string }).name = 'NotFoundException';
    mockSend.mockRejectedValueOnce(err);

    const result = await provider.readCurrentState(
      'arn:aws:sns:us-east-1:123:topic-a',
      'Logical',
      'AWS::SNS::TopicPolicy'
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty physical id', async () => {
    const result = await provider.readCurrentState('', 'Logical', 'AWS::SNS::TopicPolicy');
    expect(result).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
